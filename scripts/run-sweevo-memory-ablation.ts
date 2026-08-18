/**
 * §1 SWE-EVO memory ablation batch: subset × B0/B1/B2.
 *
 * Agent writes directly into an ephemeral git worktree @ base_commit.
 * After the run, eval collects the patch via git diff (collectWorktreePatch).
 * Repo mirrors are lazy-cloned under .newide/eval-mirrors (NEWIDE_SWE_MIRRORS_ROOT).
 *
 * Usage:
 *   pnpm eval:sweevo-ablation -- --subset v0-requests-3-prctx --mode council --ablations B0,B1,B2 --run-harness
 *   pnpm eval:sweevo-ablation -- --subset v0-smoke --instance-id conan-io__conan_2.0.14_2.0.15 --ablations B2 --harness-dry-run
 *   pnpm eval:sweevo-ablation -- --subset v0-smoke --instance-id conan-io__conan_2.0.14_2.0.15 --ablations B0 --mode council --run-harness
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { ensureRepoMirror, resolveMirrorsRoot } from '../eval/ensure-repo-mirror';
import { getInstanceOrThrow, indexDatasetById, loadDataset } from '../eval/load-dataset';
import { loadDatasetSubset, loadManifest, resolveDatasetJsonl } from '../eval/paths';
import {
  prepareEphemeralWorktree,
  removeEphemeralWorktree,
} from '../eval/prepare-worktree';
import { runEvalInstance } from '../eval/run-instance-core';
import type { MemoryAblation, SweEvoInstance } from '../eval/types';
import {
  collectClaudeSessionUsage,
  type RunTokenUsageSummary,
} from '../src/telemetry';
import {
  prepareAblationArmIsolation,
  waitForRunMaintenance,
} from './ablation-arm-isolation';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type EvaluationRunMode = 'single_agent' | 'council';

interface BackendClient {
  request<T>(method: string, params: unknown): Promise<T>;
  waitForTerminal(runId: string, timeoutMs: number): Promise<Record<string, unknown>>;
  waitForTaskTerminal(taskId: string, timeoutMs: number): Promise<TaskTerminalSnapshot>;
  close(): Promise<void>;
}

interface TaskTerminalSnapshot {
  task: { task_id: string; status: string };
  run_history: Array<{ run_id: string; status: string }>;
}

interface TokenUsage extends RunTokenUsageSummary {
  /** Backward-compatible alias of call_count for Claude assistant turns. */
  assistant_messages: number;
}

interface InstanceRow {
  ablation: MemoryAblation;
  run_mode: EvaluationRunMode;
  instance_id: string;
  /** 1-based position within the arm; memory accumulates across the sequence. */
  instance_seq: number;
  repo: string;
  base_commit: string;
  mirror_path?: string;
  worktree_path?: string;
  backend_run_id?: string;
  final_backend_run_id?: string;
  backend_task_id?: string;
  snapshot_status?: string;
  summary_path?: string;
  summary_worktree_path?: string;
  session_id?: string;
  wall_started_at?: string;
  wall_finished_at?: string;
  wall_ms?: number;
  driver_duration_ms?: number;
  maintenance_wait_ms?: number;
  maintenance_ref?: string;
  maintenance_status?: string;
  token_usage?: TokenUsage;
  eval_run_dir?: string;
  eval_predictions_path?: string;
  eval_error?: string;
  /** True when a real harness report scored this instance. */
  harness_scored?: boolean;
  resolved?: boolean;
  applied?: boolean;
  p2p_regression?: boolean;
  status: 'ok' | 'failed' | 'skipped_eval';
}

const repoRoot = process.cwd();
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
// Load dotenv before reading timeout knobs so .env.local actually applies.
const fileEnv = {
  ...loadEnvFile(path.join(repoRoot, '.env')),
  ...loadEnvFile(path.join(repoRoot, '.env.local')),
};
// Harness adapter and path helpers read process.env, not baseEnv.
for (const [key, value] of Object.entries(fileEnv)) {
  if (value !== undefined) process.env[key] ??= value;
}
// Agent budget: 45 minutes (paper-aligned). ACCEPTANCE_RUN_TIMEOUT_MS overrides.
// Set ACCEPTANCE_RUN_TIMEOUT_MS=0 for no wall-clock cancel (wait until terminal).
const runTimeoutRaw = process.env.ACCEPTANCE_RUN_TIMEOUT_MS ?? fileEnv.ACCEPTANCE_RUN_TIMEOUT_MS;
const unlimitedRunTimeout = runTimeoutRaw === '0';
const runTimeoutMs = unlimitedRunTimeout
  ? 0
  : readPositiveInt(runTimeoutRaw, 2_700_000);
// Wait slightly longer than the driver budget so the driver timeout (clean
// terminal state) fires before this script force-cancels the run.
// Unlimited: never force-cancel; driver still needs a finite ACP_DRIVER_TIMEOUT_MS.
const runWaitMs = unlimitedRunTimeout ? Number.POSITIVE_INFINITY : runTimeoutMs + 300_000;
/** Driver timeout when run budget is unlimited (7d). Backend requires a positive int. */
const unlimitedDriverTimeoutMs = 7 * 24 * 60 * 60 * 1000;
const maintenanceWaitMs = readPositiveInt(
  process.env.ABLATION_MAINTENANCE_WAIT_MS ?? fileEnv.ABLATION_MAINTENANCE_WAIT_MS,
  45_000,
);
const mirrorsRoot = resolveMirrorsRoot(readFlag('--mirrors-root'));

const subsetId = readFlag('--subset') ?? 'v0-smoke';
const instanceIdFilter = readFlag('--instance-id');
const ablations = parseAblations(readFlag('--ablations') ?? 'B0,B1,B2');
const modelName = readFlag('--model') ?? 'claude-acp-real';
const runMode = parseRunMode(readFlag('--mode') ?? 'single_agent');
const runHarness = hasFlag('--run-harness');
const harnessDryRun = hasFlag('--harness-dry-run');
const skipEval = hasFlag('--skip-eval');
const keepWorktree = hasFlag('--keep-worktree');
const experimentDirOverride = readFlag('--experiment-dir');
const experimentRoot = experimentDirOverride
  ? path.resolve(repoRoot, experimentDirOverride)
  : path.resolve(
      process.env.NEWIDE_SWEEVO_ABLATION_ROOT ??
        fileEnv.NEWIDE_SWEEVO_ABLATION_ROOT ??
        path.join(repoRoot, '.newide', 'eval-runs', 'sweevo-ablation'),
      stamp,
    );

await fs.mkdir(experimentRoot, { recursive: true });

const manifest = loadManifest();
const subset = loadDatasetSubset(manifest, subsetId);
const datasetPath = resolveDatasetJsonl(manifest, subset.source_jsonl);
const instancesById = indexDatasetById(await loadDataset(datasetPath));
const instanceIds = instanceIdFilter
  ? [instanceIdFilter]
  : subset.instance_ids.filter((id) => instancesById.has(id));

if (instanceIds.length === 0) {
  throw new Error(`No instances selected for subset "${subsetId}"`);
}
for (const id of instanceIds) {
  getInstanceOrThrow(instancesById, id);
}

const databaseUrlTemplate =
  process.env.NEWIDE_ABLATION_DATABASE_URL_TEMPLATE ??
  fileEnv.NEWIDE_ABLATION_DATABASE_URL_TEMPLATE ??
  'postgresql://newide:newide_local@127.0.0.1:55432/newide_{ablation}';

const driverRunnerRaw =
  process.env.ACP_DRIVER_RUNNER_DIR ?? fileEnv.ACP_DRIVER_RUNNER_DIR;
const driverEnvFileRaw = process.env.ACP_DRIVER_ENV_FILE ?? fileEnv.ACP_DRIVER_ENV_FILE;
const sweEvoRootRaw = process.env.NEWIDE_SWE_EVO_ROOT ?? fileEnv.NEWIDE_SWE_EVO_ROOT;
const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ...fileEnv,
  ACP_DRIVER_RUNNER_DIR: path.resolve(
    repoRoot,
    driverRunnerRaw ?? path.join('..', 'acp-client-prototype'),
  ),
  ...(driverEnvFileRaw
    ? { ACP_DRIVER_ENV_FILE: path.resolve(repoRoot, driverEnvFileRaw) }
    : {}),
  ...(sweEvoRootRaw ? { NEWIDE_SWE_EVO_ROOT: path.resolve(repoRoot, sweEvoRootRaw) } : {}),
};
// Driver timeout must not undercut the run budget, or the agent is silently
// killed early and the arm comparison becomes a timeout comparison.
if (unlimitedRunTimeout) {
  baseEnv.ACP_DRIVER_TIMEOUT_MS ??= String(unlimitedDriverTimeoutMs);
  if (readPositiveInt(baseEnv.ACP_DRIVER_TIMEOUT_MS, unlimitedDriverTimeoutMs) < unlimitedDriverTimeoutMs) {
    log(
      `warn: ACP_DRIVER_TIMEOUT_MS=${String(baseEnv.ACP_DRIVER_TIMEOUT_MS)} too low for unlimited run; raising to ${String(unlimitedDriverTimeoutMs)}ms`,
    );
    baseEnv.ACP_DRIVER_TIMEOUT_MS = String(unlimitedDriverTimeoutMs);
  }
} else {
  baseEnv.ACP_DRIVER_TIMEOUT_MS ??= String(runTimeoutMs);
  if (readPositiveInt(baseEnv.ACP_DRIVER_TIMEOUT_MS, runTimeoutMs) < runTimeoutMs) {
    log(
      `warn: ACP_DRIVER_TIMEOUT_MS=${String(baseEnv.ACP_DRIVER_TIMEOUT_MS)} < run budget ${String(runTimeoutMs)}ms; raising to match`,
    );
    baseEnv.ACP_DRIVER_TIMEOUT_MS = String(runTimeoutMs);
  }
}
// SWE-EVO paper alignment: deny WebFetch/WebSearch and network Bash at ACP permission gate.
// Override with NEWIDE_SWE_EVO_BLOCK_INTERNET=0 only for debugging.
baseEnv.NEWIDE_SWE_EVO_BLOCK_INTERNET ??= '1';
// Anti-hacking: jail the agent process to the current workspace only (bubblewrap).
// Override with NEWIDE_EVAL_FS_JAIL=0 only for debugging.
baseEnv.NEWIDE_EVAL_FS_JAIL ??= '1';
// Translate benchmark policy into ACP's generic process-sandbox contract.
baseEnv.ACP_DENY_NETWORK_TOOLS ??= baseEnv.NEWIDE_SWE_EVO_BLOCK_INTERNET;
baseEnv.ACP_DENY_PATH_SUBSTRINGS_JSON ??= JSON.stringify([
  'eval-mirrors',
  '/eval/data',
  'test_patch',
  'patch_without_test',
  'site-packages',
  'dist-packages',
  'miniconda',
  'anaconda',
]);
baseEnv.ACP_PROCESS_SANDBOX ??= baseEnv.NEWIDE_EVAL_FS_JAIL;
baseEnv.ACP_PROCESS_SANDBOX_HIDE_PYTHON_PACKAGES ??= '1';
baseEnv.ACP_PROCESS_SANDBOX_RO_PATHS_JSON ??= JSON.stringify([
  '.claude/settings.json',
  '.git/config',
]);
if (baseEnv.NEWIDE_EVAL_FS_JAIL_BWRAP) {
  baseEnv.ACP_PROCESS_SANDBOX_BWRAP ??= baseEnv.NEWIDE_EVAL_FS_JAIL_BWRAP;
}
if (baseEnv.NEWIDE_EVAL_FS_JAIL_NPM_CACHE) {
  baseEnv.ACP_PROCESS_SANDBOX_NPM_CACHE ??= baseEnv.NEWIDE_EVAL_FS_JAIL_NPM_CACHE;
}
if (baseEnv.NEWIDE_EVAL_FS_JAIL_EXTRA_RO_BINDS) {
  baseEnv.ACP_PROCESS_SANDBOX_EXTRA_RO_BINDS_JSON ??= JSON.stringify(
    baseEnv.NEWIDE_EVAL_FS_JAIL_EXTRA_RO_BINDS.split(path.delimiter).filter(Boolean),
  );
}

log(`experiment root: ${experimentRoot}`);
log(`mirrors root: ${mirrorsRoot}`);
log(`subset=${subsetId} instances=${instanceIds.length} ablations=${ablations.join(',')} mode=${runMode}`);
log(`ACP_DRIVER_RUNNER_DIR: ${baseEnv.ACP_DRIVER_RUNNER_DIR}`);
log(
  `ACCEPTANCE_RUN_TIMEOUT_MS: ${unlimitedRunTimeout ? '0 (unlimited)' : String(runTimeoutMs)}`,
);
log(`ACP_DRIVER_TIMEOUT_MS: ${baseEnv.ACP_DRIVER_TIMEOUT_MS}`);
log(`NEWIDE_SWE_EVO_BLOCK_INTERNET: ${baseEnv.NEWIDE_SWE_EVO_BLOCK_INTERNET}`);
log(`NEWIDE_SWE_EVO_PYTHON: ${process.env.NEWIDE_SWE_EVO_PYTHON?.trim() || 'python (default)'}`);
log(`NEWIDE_EVAL_FS_JAIL: ${baseEnv.NEWIDE_EVAL_FS_JAIL}`);
const permissionBuildPath = path.join(
  String(baseEnv.ACP_DRIVER_RUNNER_DIR),
  'dist',
  'src',
  'client-methods',
  'permission-handler.js',
);
const permissionBuildSupportsOfflineBlock =
  existsSync(permissionBuildPath) &&
  readFileSync(permissionBuildPath, 'utf-8').includes('ACP_DENY_NETWORK_TOOLS');
if (baseEnv.NEWIDE_SWE_EVO_BLOCK_INTERNET === '1' && !permissionBuildSupportsOfflineBlock) {
  throw new Error(
    [
      'Offline evaluation requested (NEWIDE_SWE_EVO_BLOCK_INTERNET=1) but the ACP driver build',
      `at ${permissionBuildPath} does not enforce the internet block.`,
      'Rebuild acp-client-prototype (pnpm build) or set NEWIDE_SWE_EVO_BLOCK_INTERNET=0 (debug only).',
    ].join(' '),
  );
}
const jailBuildPath = path.join(
  String(baseEnv.ACP_DRIVER_RUNNER_DIR),
  'dist',
  'src',
  'security',
  'eval-fs-jail.js',
);
if (baseEnv.NEWIDE_EVAL_FS_JAIL === '1' && !baseEnv.ACP_PROCESS_SANDBOX_HOME) {
  const evalClaudeHome = path.join(experimentRoot, 'claude-home');
  await fs.mkdir(path.join(evalClaudeHome, '.claude'), { recursive: true });
  const settings = buildEvalClaudeSettings();
  if (Object.keys(settings).length > 0) {
    await fs.writeFile(
      path.join(evalClaudeHome, '.claude', 'settings.json'),
      `${JSON.stringify(settings, null, 2)}\n`,
      'utf-8',
    );
  }
  baseEnv.ACP_PROCESS_SANDBOX_HOME = evalClaudeHome;
  log(`eval Claude home: ${evalClaudeHome}`);
}
if (baseEnv.NEWIDE_EVAL_FS_JAIL === '1') {
  if (!existsSync(jailBuildPath)) {
    throw new Error(
      [
        'Eval FS jail requested (NEWIDE_EVAL_FS_JAIL=1) but the ACP driver build is missing',
        `${jailBuildPath}.`,
        'Rebuild acp-client-prototype (pnpm build) or set NEWIDE_EVAL_FS_JAIL=0 (debug only).',
      ].join(' '),
    );
  }
  const bwrapPath = baseEnv.ACP_PROCESS_SANDBOX_BWRAP?.trim() || '/usr/bin/bwrap';
  if (!existsSync(bwrapPath)) {
    throw new Error(
      [
        'Eval FS jail requested (NEWIDE_EVAL_FS_JAIL=1) but bubblewrap was not found',
        `at ${bwrapPath}.`,
        'Install bubblewrap or set NEWIDE_EVAL_FS_JAIL_BWRAP to the bwrap binary.',
      ].join(' '),
    );
  }
  log(`eval FS jail bwrap: ${bwrapPath}`);
}
const armReports: Array<{
  ablation: MemoryAblation;
  state_root: string;
  database_schema: string;
  total_count: number;
  scored_count: number;
  resolved_count: number;
  intent_to_treat_resolved_rate: number;
  applied_count: number;
  p2p_regression_count: number;
  instances: InstanceRow[];
}> = [];

for (const ablation of ablations) {
  const armDir = path.join(experimentRoot, ablation);
  await fs.mkdir(armDir, { recursive: true });
  const dbUrl = resolveAblationDatabaseUrl(databaseUrlTemplate, ablation);
  const isolation = await prepareAblationArmIsolation({
    experiment_root: experimentRoot,
    arm: ablation,
    database_url: dbUrl,
  });
  await fs.mkdir(isolation.state_root, { recursive: true });
  log('');
  log(`=== arm ${ablation} ===`);
  log(`state root: ${isolation.state_root}`);
  log(`database schema: ${isolation.database_schema}`);

  const backend = await startBackend(ablation, {
    ...baseEnv,
    NEWIDE_B_DATABASE_URL: isolation.database_url,
    NEWIDE_B_EMBEDDING_PROVIDER: baseEnv.NEWIDE_B_EMBEDDING_PROVIDER ?? 'hash',
    NEWIDE_B_EMBEDDING_DIMENSIONS: baseEnv.NEWIDE_B_EMBEDDING_DIMENSIONS ?? '32',
    NEWIDE_STATE_ROOT: isolation.state_root,
    ...(runMode === 'council'
      ? {
          NEWIDE_COUNCIL_STRATEGY: baseEnv.NEWIDE_COUNCIL_STRATEGY ?? 'plan_first',
          NEWIDE_COUNCIL_SEATS:
            baseEnv.NEWIDE_COUNCIL_SEATS ??
            'role_fullstack_engineer,role_ts_engineer,role_code_reviewer,role_synthesis_engineer',
          NEWIDE_AUCTION_ENABLED: baseEnv.NEWIDE_AUCTION_ENABLED ?? '0',
          NEWIDE_PRIMARY_AGENT_ID:
            baseEnv.NEWIDE_PRIMARY_AGENT_ID ?? 'role_fullstack_engineer',
        }
      : {}),
  });

  const rows: InstanceRow[] = [];
  try {
    for (const [instanceIndex, instanceId] of instanceIds.entries()) {
      const instance = getInstanceOrThrow(instancesById, instanceId);
      const row = await runOneInstance({
        ablation,
        armDir,
        backend,
        instance,
        instanceSeq: instanceIndex + 1,
        stateRoot: isolation.state_root,
      });
      rows.push(row);
      await fs.writeFile(
        path.join(armDir, `${sanitizeFileName(instanceId)}.json`),
        JSON.stringify(row, null, 2),
        'utf-8',
      );
      log(
        `  ${instanceId} status=${row.status} snapshot=${row.snapshot_status ?? '-'} eval=${row.eval_run_dir ?? row.eval_error ?? '-'}`,
      );
    }
  } finally {
    await backend.close();
  }

  const armSummary = {
    ablation,
    state_root: isolation.state_root,
    database_schema: isolation.database_schema,
    total_count: rows.length,
    scored_count: rows.filter((row) => row.harness_scored === true).length,
    resolved_count: rows.filter((row) => row.resolved === true).length,
    intent_to_treat_resolved_rate:
      rows.length > 0 ? rows.filter((row) => row.resolved === true).length / rows.length : 0,
    applied_count: rows.filter((row) => row.applied === true).length,
    p2p_regression_count: rows.filter((row) => row.p2p_regression === true).length,
    instances: rows,
  };
  armReports.push(armSummary);
  await fs.writeFile(path.join(armDir, 'arm-summary.json'), JSON.stringify(armSummary, null, 2));
}

const finishedAt = new Date();
// Merge sibling arm-summary.json files so parallel --ablations B0|B1|B2
// processes writing into the same --experiment-dir still produce one summary.
const mergedArms = await loadMergedArmReports(experimentRoot, armReports);
const metricsRows = mergedArms.flatMap((arm) => arm.instances);
const metricsPath = path.join(experimentRoot, 'metrics.jsonl');
await fs.writeFile(
  metricsPath,
  `${metricsRows.map((row) => JSON.stringify(row)).join('\n')}${metricsRows.length > 0 ? '\n' : ''}`,
  'utf-8',
);
const timingTotals = summarizeTiming(metricsRows);
const tokenTotals = summarizeTokens(metricsRows);
const summary = {
  schema_version: 'sweevo-memory-ablation.v0',
  started_at: startedAt.toISOString(),
  finished_at: finishedAt.toISOString(),
  wall_ms: finishedAt.getTime() - startedAt.getTime(),
  experiment_root: experimentRoot,
  mirrors_root: mirrorsRoot,
  subset_id: subsetId,
  instance_ids: instanceIds,
  ablations: [...new Set([...ablations, ...mergedArms.map((arm) => arm.ablation)])],
  run_mode: runMode,
  model_name: modelName,
  run_harness: runHarness,
  harness_dry_run: harnessDryRun,
  skip_eval: skipEval,
  metrics_path: metricsPath,
  timing_totals: timingTotals,
  token_totals: tokenTotals,
  arms: mergedArms,
};
const summaryPath = path.join(experimentRoot, 'summary.json');
await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
log('');
log(`summary: ${summaryPath}`);
log(`metrics: ${metricsPath}`);
log(
  `totals wall_ms=${String(timingTotals.wall_ms)} driver_ms=${String(timingTotals.driver_duration_ms)} tokens=${String(tokenTotals.total_tokens)} (in=${String(tokenTotals.total_input_tokens)} out=${String(tokenTotals.output_tokens)})`,
);

const failed = mergedArms.some((arm) => arm.instances.some((row) => row.status === 'failed'));
if (failed) process.exitCode = 1;

// ---------------------------------------------------------------------------

async function runOneInstance(input: {
  ablation: MemoryAblation;
  armDir: string;
  backend: BackendClient;
  instance: SweEvoInstance;
  instanceSeq: number;
  stateRoot: string;
}): Promise<InstanceRow> {
  const { ablation, armDir, backend, instance, instanceSeq, stateRoot } = input;
  const row: InstanceRow = {
    ablation,
    run_mode: runMode,
    instance_id: instance.instance_id,
    instance_seq: instanceSeq,
    repo: instance.repo,
    base_commit: instance.base_commit,
    status: 'failed',
    harness_scored: false,
    resolved: false,
    applied: false,
    p2p_regression: false,
  };

  let prepared:
    | Awaited<ReturnType<typeof prepareEphemeralWorktree>>
    | undefined;
  const wallStartedAt = Date.now();
  row.wall_started_at = new Date(wallStartedAt).toISOString();

  try {
    const mirror = await ensureRepoMirror({
      repo: instance.repo,
      baseCommit: instance.base_commit,
      mirrorsRoot,
    });
    row.mirror_path = mirror.mirrorPath;
    log(
      `-- ${ablation}/${instance.instance_id} mirror=${mirror.mirrorPath} cloned=${String(mirror.cloned)}`,
    );

    const runKey = `${ablation}__${sanitizeFileName(instance.instance_id)}`;
    prepared = await prepareEphemeralWorktree({
      sourceRepo: mirror.mirrorPath,
      baseCommit: instance.base_commit,
      runId: runKey,
      outRoot: path.join(armDir, 'worktrees', runKey),
    });
    row.worktree_path = prepared.worktreePath;
    await writeEvalOfflineClaudeSettings(prepared.worktreePath);

    const created = await backend.request<{ run_id: string; task_id: string }>('run.create', {
      prompt: buildPrompt(instance),
      mode: runMode,
      workspace_path: prepared.worktreePath,
      memory_ablation: ablation,
      title: `${ablation}-${instance.instance_id}`,
    });
    row.backend_run_id = created.run_id;
    row.backend_task_id = created.task_id;

    await backend.request('run.subscribe', { run_id: created.run_id });
    const taskSnapshot = await backend.waitForTaskTerminal(created.task_id, runWaitMs);
    const finalRunId = latestTerminalRunId(taskSnapshot);
    row.final_backend_run_id = finalRunId;
    const snapshot = await backend.waitForTerminal(finalRunId, runWaitMs);
    row.snapshot_status = String(snapshot.status ?? '');

    if (ablation !== 'B0') {
      row.maintenance_wait_ms = maintenanceWaitMs;
      const maintenance = await waitForRunMaintenance(
        backend.request,
        finalRunId,
        maintenanceWaitMs,
      );
      row.maintenance_ref = maintenance.maintenance_ref;
      row.maintenance_status = maintenance.status;
      // 'skipped' (no durable buffer to extract) is a legitimate data point for
      // the memory arms, not an infra failure; only 'failed' aborts the row.
      if (maintenance.status !== 'completed' && maintenance.status !== 'skipped') {
        throw new Error(
          `Memory maintenance ${maintenance.maintenance_ref} ended as ${maintenance.status}`,
        );
      }
    }

    const summaryPath = path.join(stateRoot, 'runs', finalRunId, 'summary.json');
    row.summary_path = summaryPath;
    const summary = await readJsonIfExists(summaryPath);
    if (summary && typeof summary === 'object') {
      const summaryObj = summary as {
        memory_ablation?: unknown;
        worktree_path?: unknown;
        session_id?: unknown;
        driver_diagnostics?: { duration_ms?: unknown };
      };
      if (summaryObj.memory_ablation !== ablation) {
        throw new Error(
          `Backend summary ablation mismatch: expected ${ablation}, got ${String(summaryObj.memory_ablation)}`,
        );
      }
      if ('worktree_path' in summaryObj) {
        row.summary_worktree_path = String(summaryObj.worktree_path ?? '');
      }
      if (typeof summaryObj.session_id === 'string' && summaryObj.session_id.length > 0) {
        row.session_id = summaryObj.session_id;
      }
      const driverMs = summaryObj.driver_diagnostics?.duration_ms;
      if (typeof driverMs === 'number' && Number.isFinite(driverMs)) {
        row.driver_duration_ms = Math.max(0, Math.floor(driverMs));
      }
    }

    row.token_usage = await resolveInstanceTokenUsage({
      summary,
      sessionId: row.session_id,
      worktreePath: prepared.worktreePath,
    });

    if (skipEval) {
      row.status = 'skipped_eval';
      return row;
    }

    try {
      const evalResult = await runEvalInstance({
        instanceId: instance.instance_id,
        predictionMode: 'real',
        memoryAblation: ablation,
        modelName,
        datasetSubset: subsetId,
        outRoot: path.join(armDir, 'eval'),
        runId: `${runKey}_${stamp}`,
        instanceSeq,
        backendSummaryPath: summaryPath,
        worktreePath: prepared.worktreePath,
        allowDirtyWorktree: true,
        keepWorktree: true,
        runSweEvoHarness: runHarness || harnessDryRun,
        harnessDryRun,
        ...(baseEnv.NEWIDE_SWE_EVO_ROOT ? { sweEvoRoot: baseEnv.NEWIDE_SWE_EVO_ROOT } : {}),
      });
      row.eval_run_dir = evalResult.runDir;
      row.eval_predictions_path = evalResult.summary.predictions_path;
      const scored =
        Boolean(evalResult.summary.harness_report_path) &&
        evalResult.summary.resolved_count + evalResult.summary.unresolved_count > 0;
      row.harness_scored = scored;
      if (scored) {
        row.resolved = evalResult.summary.resolved_count > 0;
        row.applied = evalResult.summary.applied_count > 0;
        row.p2p_regression = evalResult.summary.p2p_regression_count > 0;
      }
      const snapshotOk =
        row.snapshot_status === 'succeeded' || row.snapshot_status === 'completed';
      // With --run-harness, a run only counts as ok when it was actually scored;
      // snapshot success alone must not masquerade as an evaluated result.
      row.status = snapshotOk && (!runHarness || scored) ? 'ok' : 'failed';
    } catch (error) {
      row.eval_error = error instanceof Error ? error.message : String(error);
      row.status = 'failed';
    }

    return row;
  } catch (error) {
    row.eval_error = error instanceof Error ? error.message : String(error);
    row.status = 'failed';
    return row;
  } finally {
    const wallFinishedAt = Date.now();
    row.wall_finished_at = new Date(wallFinishedAt).toISOString();
    row.wall_ms = Math.max(0, wallFinishedAt - wallStartedAt);
    log(
      `  metrics wall_ms=${String(row.wall_ms)} driver_ms=${String(row.driver_duration_ms ?? '-')} tokens=${String(row.token_usage?.total_tokens ?? '-')} source=${row.token_usage?.source ?? 'unavailable'}`,
    );
    if (prepared && !keepWorktree) {
      try {
        await removeEphemeralWorktree(prepared.sourceRepo, prepared.worktreePath);
      } catch (error) {
        log(
          `  warn: failed to remove worktree ${prepared.worktreePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

function buildPrompt(instance: SweEvoInstance): string {
  return [
    'You are fixing a real GitHub issue in an already-checked-out repository worktree.',
    'Edit files directly in the workspace. Do not only describe a plan.',
    'Produce a minimal correct patch that addresses the problem statement.',
    'Do not add, edit, delete, rename, or generate tests or test-runner configuration.',
    'Changes to tests, conftest.py, pytest/tox/nox/Jest/Vitest configuration are rejected.',
    '',
    'Offline evaluation constraints (SWE-EVO paper alignment):',
    '- You have NO internet access. Do not use WebFetch, WebSearch, or any browser tool.',
    '- Do not use shell/network commands (curl, wget, gh, Invoke-WebRequest, etc.) to reach GitHub or any remote host.',
    '- URLs in the problem statement are citations only; reason from the provided text and the local workspace at base_commit.',
    '- Do not fetch or apply remote PR patches; solve from the local tree + problem statement alone.',
    '',
    `Repository: ${instance.repo}`,
    `Instance: ${instance.instance_id}`,
    `Base commit: ${instance.base_commit}`,
    '',
    'Problem statement:',
    instance.problem_statement,
  ].join('\n');
}

function buildEvalClaudeSettings(): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  if (baseEnv.NEWIDE_SWE_EVO_BLOCK_INTERNET === '1') {
    settings.permissions = {
      deny: [
        'WebFetch',
        'WebSearch',
        'WebFetch(*)',
        'Bash(curl *)',
        'Bash(wget *)',
        'Bash(gh *)',
        'Bash(Invoke-WebRequest *)',
        'Bash(iwr *)',
      ],
    };
  }
  const model = baseEnv.ANTHROPIC_MODEL?.trim();
  if (model) {
    settings.model = model;
  }
  const env: Record<string, string> = {};
  for (const key of [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_EFFORT_LEVEL',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CONFIG_DIR',
  ] as const) {
    const value = baseEnv[key]?.trim();
    if (value) env[key] = value;
  }
  if (!env.CLAUDE_CODE_EFFORT_LEVEL) env.CLAUDE_CODE_EFFORT_LEVEL = 'max';
  if (!env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) {
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  }
  if (Object.keys(env).length > 0) settings.env = env;
  return settings;
}

/** Defense-in-depth Claude Code deny list for SWE-EVO offline eval. */
async function writeEvalOfflineClaudeSettings(worktreePath: string): Promise<void> {
  const settings = buildEvalClaudeSettings();
  if (Object.keys(settings).length === 0) return;
  const claudeDir = path.join(worktreePath, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeDir, 'settings.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf-8',
  );
}

function toAblationTokenUsage(summary: RunTokenUsageSummary): TokenUsage {
  return {
    ...summary,
    assistant_messages: summary.call_count,
  };
}

function readSummaryTokenUsage(summary: unknown): TokenUsage | undefined {
  if (!summary || typeof summary !== 'object') return undefined;
  const tokenUsage = (summary as { token_usage?: unknown }).token_usage;
  if (!tokenUsage || typeof tokenUsage !== 'object') return undefined;
  const obj = tokenUsage as Partial<RunTokenUsageSummary>;
  const totalTokens = Number(obj.total_tokens ?? 0);
  const callCount = Number(obj.call_count ?? 0);
  if (!Number.isFinite(totalTokens) || !Number.isFinite(callCount)) return undefined;
  if (totalTokens <= 0 && callCount <= 0) return undefined;
  return toAblationTokenUsage({
    schema_version: 'newide.token_usage.v1',
    source: (obj.source as RunTokenUsageSummary['source']) ?? 'mixed',
    input_tokens: Number(obj.input_tokens ?? 0),
    output_tokens: Number(obj.output_tokens ?? 0),
    cache_creation_input_tokens: Number(obj.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: Number(obj.cache_read_input_tokens ?? 0),
    total_input_tokens: Number(obj.total_input_tokens ?? 0),
    total_tokens: totalTokens,
    call_count: callCount,
    sources: Array.isArray(obj.sources)
      ? (obj.sources as RunTokenUsageSummary['sources'])
      : [],
    by_source:
      obj.by_source && typeof obj.by_source === 'object'
        ? (obj.by_source as RunTokenUsageSummary['by_source'])
        : {},
    ...(typeof obj.session_id === 'string' ? { session_id: obj.session_id } : {}),
    ...(typeof obj.session_path === 'string' ? { session_path: obj.session_path } : {}),
  });
}

async function resolveInstanceTokenUsage(input: {
  summary: unknown;
  sessionId?: string;
  worktreePath: string;
}): Promise<TokenUsage> {
  const fromSummary = readSummaryTokenUsage(input.summary);
  if (fromSummary) return fromSummary;
  const scraped = await collectClaudeSessionUsage({
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    worktreePath: input.worktreePath,
  });
  return toAblationTokenUsage(scraped);
}

function summarizeTiming(rows: InstanceRow[]): {
  wall_ms: number;
  driver_duration_ms: number;
  maintenance_wait_ms: number;
  instances: number;
} {
  return {
    wall_ms: rows.reduce((sum, row) => sum + (row.wall_ms ?? 0), 0),
    driver_duration_ms: rows.reduce((sum, row) => sum + (row.driver_duration_ms ?? 0), 0),
    maintenance_wait_ms: rows.reduce((sum, row) => sum + (row.maintenance_wait_ms ?? 0), 0),
    instances: rows.length,
  };
}

function summarizeTokens(rows: InstanceRow[]): {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_input_tokens: number;
  total_tokens: number;
  instances_with_tokens: number;
  instances: number;
} {
  const withTokens = rows.filter(
    (row) =>
      row.token_usage &&
      row.token_usage.source !== 'unavailable' &&
      (row.token_usage.total_tokens > 0 || row.token_usage.call_count > 0),
  );
  return {
    input_tokens: withTokens.reduce((sum, row) => sum + (row.token_usage?.input_tokens ?? 0), 0),
    output_tokens: withTokens.reduce((sum, row) => sum + (row.token_usage?.output_tokens ?? 0), 0),
    cache_creation_input_tokens: withTokens.reduce(
      (sum, row) => sum + (row.token_usage?.cache_creation_input_tokens ?? 0),
      0,
    ),
    cache_read_input_tokens: withTokens.reduce(
      (sum, row) => sum + (row.token_usage?.cache_read_input_tokens ?? 0),
      0,
    ),
    total_input_tokens: withTokens.reduce(
      (sum, row) => sum + (row.token_usage?.total_input_tokens ?? 0),
      0,
    ),
    total_tokens: withTokens.reduce((sum, row) => sum + (row.token_usage?.total_tokens ?? 0), 0),
    instances_with_tokens: withTokens.length,
    instances: rows.length,
  };
}

async function startBackend(label: string, env: NodeJS.ProcessEnv): Promise<BackendClient> {
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/app/backend-rpc-entry.ts'],
    {
      cwd: repoRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(String(chunk)));
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code));
  });

  const waiters = new Set<{
    predicate: (message: JsonRpcMessage) => boolean;
    resolve: (message: JsonRpcMessage) => void;
  }>();
  createInterface({ input: child.stdout! }).on('line', (line) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  });

  let nextId = 1;
  const request = async <T>(method: string, params: unknown): Promise<T> => {
    const id = nextId++;
    const waiting = new Promise<JsonRpcMessage>((resolve, reject) => {
      const waiter = { predicate: (message: JsonRpcMessage) => message.id === id, resolve };
      waiters.add(waiter);
      setTimeout(() => {
        if (!waiters.delete(waiter)) return;
        reject(new Error(`[${label}] timed out on ${method}. stderr=${stderr.join('')}`));
      }, 60_000).unref();
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const response = await waiting;
    if (response.error) {
      throw new Error(
        `[${label}] ${method}: ${String(response.error.code)} ${response.error.message} stderr=${stderr.join('')}`,
      );
    }
    return response.result as T;
  };

  await request('system.ping', {});
  log(`backend started (${label})`);

  return {
    request,
    waitForTerminal: async (runId, timeoutMs) => {
      const unlimited = !Number.isFinite(timeoutMs) || timeoutMs <= 0;
      const deadline = unlimited ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await request<Record<string, unknown>>('run.getSnapshot', {
          run_id: runId,
        });
        if (snapshot.status !== 'running') return snapshot;
        await sleep(1_000);
      }

      // Timeout must cancel the live run; otherwise the shared backend keeps the
      // ACP driver busy and the next instance starves with zero tool events.
      log(`[${label}] run ${runId} timed out after ${String(timeoutMs)}ms; cancelling`);
      try {
        await request('run.cancel', { run_id: runId });
      } catch (error) {
        log(
          `[${label}] warn: run.cancel failed for ${runId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const cancelDeadline = Date.now() + 60_000;
      while (Date.now() < cancelDeadline) {
        const snapshot = await request<Record<string, unknown>>('run.getSnapshot', {
          run_id: runId,
        });
        if (snapshot.status !== 'running') break;
        await sleep(500);
      }

      throw new Error(`[${label}] run ${runId} did not finish within ${String(timeoutMs)}ms`);
    },
    waitForTaskTerminal: async (taskId, timeoutMs) => {
      const unlimited = !Number.isFinite(timeoutMs) || timeoutMs <= 0;
      const deadline = unlimited ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await request<TaskTerminalSnapshot>('task.get', { task_id: taskId });
        if (['completed', 'failed', 'cancelled', 'blocked'].includes(snapshot.task.status)) {
          return snapshot;
        }
        await sleep(1_000);
      }
      throw new Error(`[${label}] task ${taskId} did not finish within ${String(timeoutMs)}ms`);
    },
    close: async () => {
      child.stdin?.end();
      const result = await Promise.race([closed, sleep(5_000).then(() => 'timeout' as const)]);
      if (result === 'timeout') {
        child.kill('SIGTERM');
        const terminated = await Promise.race([
          closed,
          sleep(2_000).then(() => 'timeout' as const),
        ]);
        if (terminated === 'timeout') child.kill('SIGKILL');
      }
    },
  };
}

function latestTerminalRunId(snapshot: TaskTerminalSnapshot): string {
  const latest = snapshot.run_history[0];
  if (!latest) throw new Error(`Task ${snapshot.task.task_id} has no terminal Run`);
  return latest.run_id;
}

function parseAblations(raw: string): MemoryAblation[] {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const allowed: MemoryAblation[] = ['B0', 'B1', 'B2', 'B3'];
  const out: MemoryAblation[] = [];
  for (const part of parts) {
    if (!allowed.includes(part as MemoryAblation)) {
      throw new Error(`Invalid ablation "${part}". Expected comma-separated B0|B1|B2|B3.`);
    }
    if (!out.includes(part as MemoryAblation)) out.push(part as MemoryAblation);
  }
  if (out.length === 0) throw new Error('At least one ablation is required.');
  return out;
}

function parseRunMode(raw: string): EvaluationRunMode {
  if (raw === 'single_agent' || raw === 'council') return raw;
  throw new Error(`Invalid --mode "${raw}". Expected single_agent|council.`);
}

async function loadMergedArmReports(
  root: string,
  localArms: Array<{
    ablation: MemoryAblation;
    state_root: string;
    database_schema: string;
    scored_count: number;
    resolved_count: number;
    applied_count: number;
    p2p_regression_count: number;
    instances: InstanceRow[];
  }>,
): Promise<typeof localArms> {
  const byAblation = new Map(localArms.map((arm) => [arm.ablation, arm]));
  for (const ablation of ['B0', 'B1', 'B2', 'B3'] as MemoryAblation[]) {
    if (byAblation.has(ablation)) continue;
    const candidate = path.join(root, ablation, 'arm-summary.json');
    const parsed = await readJsonIfExists(candidate);
    if (!parsed || typeof parsed !== 'object') continue;
    const arm = parsed as (typeof localArms)[number];
    if (arm.ablation === ablation && Array.isArray(arm.instances)) {
      byAblation.set(ablation, arm);
    }
  }
  return [...byAblation.values()].sort((left, right) =>
    left.ablation.localeCompare(right.ablation),
  );
}

function sanitizeFileName(value: string): string {
  return value.replaceAll(/[<>:"/\\|?*]/g, '_');
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function loadEnvFile(filePath: string): NodeJS.ProcessEnv {
  if (!existsSync(filePath)) return {};
  return Object.fromEntries(
    readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .flatMap((line) => {
        if (!line || line.startsWith('#')) return [];
        const separator = line.indexOf('=');
        if (separator <= 0) return [];
        const key = line.slice(0, separator).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return [];
        const value = line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
        return [[key, value]];
      }),
  );
}

async function readJsonIfExists(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return undefined;
  }
}

function resolveAblationDatabaseUrl(template: string, ablation: MemoryAblation): string {
  if (!template.includes('{ablation}')) {
    throw new Error('NEWIDE_ABLATION_DATABASE_URL_TEMPLATE must contain {ablation}');
  }
  return template.replaceAll('{ablation}', ablation.toLowerCase());
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function log(message: string): void {
  process.stderr.write(`${message}\n`);
}
