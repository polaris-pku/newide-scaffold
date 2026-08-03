/**
 * §1 SWE-EVO memory ablation batch: subset × B0/B1/B2.
 *
 * Agent writes directly into an ephemeral git worktree @ base_commit.
 * After the run, eval collects the patch via git diff (collectWorktreePatch).
 * Repo mirrors are lazy-cloned under D:\newide-sweevo-mirrors (NEWIDE_SWE_MIRRORS_ROOT).
 *
 * Usage:
 *   pnpm eval:sweevo-ablation -- --subset v0-smoke --instance-id conan-io__conan_2.0.14_2.0.15 --ablations B2 --harness-dry-run
 *   pnpm eval:sweevo-ablation -- --subset v0-smoke
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

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface BackendClient {
  request<T>(method: string, params: unknown): Promise<T>;
  waitForTerminal(runId: string, timeoutMs: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** input + cache_creation + cache_read (Claude billed input-ish total). */
  total_input_tokens: number;
  total_tokens: number;
  assistant_messages: number;
  source: 'claude_session_jsonl' | 'unavailable';
  session_path?: string;
  session_id?: string;
}

interface InstanceRow {
  ablation: MemoryAblation;
  instance_id: string;
  repo: string;
  base_commit: string;
  mirror_path?: string;
  worktree_path?: string;
  backend_run_id?: string;
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
  token_usage?: TokenUsage;
  eval_run_dir?: string;
  eval_predictions_path?: string;
  eval_error?: string;
  status: 'ok' | 'failed' | 'skipped_eval';
}

const repoRoot = process.cwd();
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const experimentRoot = path.resolve(
  process.env.NEWIDE_SWEEVO_ABLATION_ROOT ??
    'D:\\Code\\NewIDE\\.newide-experiments\\sweevo-ablation',
  stamp,
);
const runTimeoutMs = readPositiveInt(process.env.ACCEPTANCE_RUN_TIMEOUT_MS, 900_000);
const maintenanceWaitMs = readPositiveInt(process.env.ABLATION_MAINTENANCE_WAIT_MS, 45_000);
const mirrorsRoot = resolveMirrorsRoot(readFlag('--mirrors-root'));

const subsetId = readFlag('--subset') ?? 'v0-smoke';
const instanceIdFilter = readFlag('--instance-id');
const ablations = parseAblations(readFlag('--ablations') ?? 'B0,B1,B2');
const modelName = readFlag('--model') ?? 'claude-acp-real';
const runHarness = hasFlag('--run-harness');
const harnessDryRun = hasFlag('--harness-dry-run');
const skipEval = hasFlag('--skip-eval');
const keepWorktree = hasFlag('--keep-worktree');

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

const baseEnv = {
  ...process.env,
  ...loadEnvFile(path.join(repoRoot, '.env')),
  ...loadEnvFile(path.join(repoRoot, '.env.local')),
  ACP_DRIVER_RUNNER_DIR:
    process.env.ACP_DRIVER_RUNNER_DIR ?? path.resolve(repoRoot, '..', 'acp-client-prototype'),
  ACP_DRIVER_TIMEOUT_MS: process.env.ACP_DRIVER_TIMEOUT_MS ?? '600000',
};
// SWE-EVO paper alignment: deny WebFetch/WebSearch and network Bash at ACP permission gate.
// Override with NEWIDE_SWE_EVO_BLOCK_INTERNET=0 only for debugging.
baseEnv.NEWIDE_SWE_EVO_BLOCK_INTERNET ??= '1';

log(`experiment root: ${experimentRoot}`);
log(`mirrors root: ${mirrorsRoot}`);
log(`subset=${subsetId} instances=${instanceIds.length} ablations=${ablations.join(',')}`);
log(`ACP_DRIVER_RUNNER_DIR: ${baseEnv.ACP_DRIVER_RUNNER_DIR}`);
log(`NEWIDE_SWE_EVO_BLOCK_INTERNET: ${baseEnv.NEWIDE_SWE_EVO_BLOCK_INTERNET}`);

const armReports: Array<{ ablation: MemoryAblation; instances: InstanceRow[] }> = [];

for (const ablation of ablations) {
  const armDir = path.join(experimentRoot, ablation);
  await fs.mkdir(armDir, { recursive: true });
  const dbUrl = `postgresql://newide:newide_local@127.0.0.1:55432/newide_${ablation.toLowerCase()}`;
  log('');
  log(`=== arm ${ablation} ===`);

  const backend = await startBackend(ablation, {
    ...baseEnv,
    NEWIDE_B_DATABASE_URL: dbUrl,
  });

  const rows: InstanceRow[] = [];
  try {
    for (const instanceId of instanceIds) {
      const instance = getInstanceOrThrow(instancesById, instanceId);
      const row = await runOneInstance({
        ablation,
        armDir,
        backend,
        instance,
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

  const armSummary = { ablation, instances: rows };
  armReports.push(armSummary);
  await fs.writeFile(path.join(armDir, 'arm-summary.json'), JSON.stringify(armSummary, null, 2));
}

const finishedAt = new Date();
const metricsRows = armReports.flatMap((arm) => arm.instances);
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
  ablations,
  model_name: modelName,
  run_harness: runHarness,
  harness_dry_run: harnessDryRun,
  skip_eval: skipEval,
  metrics_path: metricsPath,
  timing_totals: timingTotals,
  token_totals: tokenTotals,
  arms: armReports,
};
const summaryPath = path.join(experimentRoot, 'summary.json');
await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
log('');
log(`summary: ${summaryPath}`);
log(`metrics: ${metricsPath}`);
log(
  `totals wall_ms=${String(timingTotals.wall_ms)} driver_ms=${String(timingTotals.driver_duration_ms)} tokens=${String(tokenTotals.total_tokens)} (in=${String(tokenTotals.total_input_tokens)} out=${String(tokenTotals.output_tokens)})`,
);

const failed = armReports.some((arm) => arm.instances.some((row) => row.status === 'failed'));
if (failed) process.exitCode = 1;

// ---------------------------------------------------------------------------

async function runOneInstance(input: {
  ablation: MemoryAblation;
  armDir: string;
  backend: BackendClient;
  instance: SweEvoInstance;
}): Promise<InstanceRow> {
  const { ablation, armDir, backend, instance } = input;
  const row: InstanceRow = {
    ablation,
    instance_id: instance.instance_id,
    repo: instance.repo,
    base_commit: instance.base_commit,
    status: 'failed',
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
      mode: 'single_agent',
      workspace_path: prepared.worktreePath,
      memory_ablation: ablation,
      title: `${ablation}-${instance.instance_id}`,
    });
    row.backend_run_id = created.run_id;
    row.backend_task_id = created.task_id;

    await backend.request('run.subscribe', { run_id: created.run_id });
    const snapshot = await backend.waitForTerminal(created.run_id, runTimeoutMs);
    row.snapshot_status = String(snapshot.status ?? '');

    if (ablation !== 'B0') {
      row.maintenance_wait_ms = maintenanceWaitMs;
      await sleep(maintenanceWaitMs);
    }

    const summaryPath = path.join(repoRoot, '.newide', 'runs', created.run_id, 'summary.json');
    row.summary_path = summaryPath;
    const summary = await readJsonIfExists(summaryPath);
    if (summary && typeof summary === 'object') {
      const summaryObj = summary as {
        worktree_path?: unknown;
        session_id?: unknown;
        driver_diagnostics?: { duration_ms?: unknown };
      };
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

    row.token_usage = await collectClaudeTokenUsage({
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
        backendSummaryPath: summaryPath,
        worktreePath: prepared.worktreePath,
        allowDirtyWorktree: true,
        keepWorktree: true,
        runSweEvoHarness: runHarness || harnessDryRun,
        harnessDryRun,
      });
      row.eval_run_dir = evalResult.runDir;
      row.eval_predictions_path = evalResult.summary.predictions_path;
      row.status =
        row.snapshot_status === 'succeeded' || row.snapshot_status === 'completed'
          ? 'ok'
          : 'failed';
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

/** Defense-in-depth Claude Code deny list for SWE-EVO offline eval. */
async function writeEvalOfflineClaudeSettings(worktreePath: string): Promise<void> {
  if (baseEnv.NEWIDE_SWE_EVO_BLOCK_INTERNET !== '1') return;
  const claudeDir = path.join(worktreePath, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  const settings = {
    permissions: {
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
    },
  };
  await fs.writeFile(
    path.join(claudeDir, 'settings.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf-8',
  );
}

function emptyTokenUsage(
  source: TokenUsage['source'] = 'unavailable',
  extras: Partial<TokenUsage> = {},
): TokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_input_tokens: 0,
    total_tokens: 0,
    assistant_messages: 0,
    source,
    ...extras,
  };
}

function encodeClaudeProjectDir(worktreePath: string): string {
  return path
    .resolve(worktreePath)
    .replaceAll(':', '')
    .replaceAll('\\', '-')
    .replaceAll('/', '-');
}

async function collectClaudeTokenUsage(input: {
  sessionId?: string;
  worktreePath: string;
}): Promise<TokenUsage> {
  const claudeRoot = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude');
  if (!claudeRoot || !existsSync(claudeRoot)) return emptyTokenUsage();

  const candidates: string[] = [];
  if (input.sessionId) {
    const projectDir = path.join(
      claudeRoot,
      'projects',
      encodeClaudeProjectDir(input.worktreePath),
    );
    candidates.push(path.join(projectDir, `${input.sessionId}.jsonl`));
    candidates.push(path.join(claudeRoot, 'sessions', `${input.sessionId}.json`));
  }

  // Fallback: newest jsonl under the encoded project dir (useful if session_id mapping drifts).
  const projectDir = path.join(claudeRoot, 'projects', encodeClaudeProjectDir(input.worktreePath));
  if (existsSync(projectDir)) {
    try {
      const files = (await fs.readdir(projectDir))
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => path.join(projectDir, name));
      const ranked = await Promise.all(
        files.map(async (filePath) => ({
          filePath,
          mtimeMs: (await fs.stat(filePath)).mtimeMs,
        })),
      );
      ranked.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const entry of ranked.slice(0, 3)) {
        if (!candidates.includes(entry.filePath)) candidates.push(entry.filePath);
      }
    } catch {
      // ignore listing failures
    }
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate) || !candidate.endsWith('.jsonl')) continue;
    try {
      const usage = await sumUsageFromClaudeJsonl(candidate, input.sessionId);
      if (usage.assistant_messages > 0) return usage;
    } catch {
      // try next candidate
    }
  }
  return emptyTokenUsage('unavailable', {
    session_id: input.sessionId,
  });
}

async function sumUsageFromClaudeJsonl(
  filePath: string,
  expectedSessionId?: string,
): Promise<TokenUsage> {
  const text = await fs.readFile(filePath, 'utf-8');
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  let assistantMessages = 0;
  let matchedSessionId = expectedSessionId;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj: {
      type?: string;
      sessionId?: string;
      message?: { usage?: Record<string, unknown> };
      usage?: Record<string, unknown>;
    };
    try {
      obj = JSON.parse(line) as typeof obj;
    } catch {
      continue;
    }
    if (expectedSessionId && obj.sessionId && obj.sessionId !== expectedSessionId) continue;
    if (obj.sessionId) matchedSessionId = obj.sessionId;
    const usage = obj.message?.usage ?? obj.usage;
    if (!usage || typeof usage !== 'object') continue;
    if (obj.type !== 'assistant' && !obj.message?.usage) continue;

    const nextInput = Number(usage.input_tokens ?? 0);
    const nextOutput = Number(usage.output_tokens ?? 0);
    const nextCacheCreation = Number(usage.cache_creation_input_tokens ?? 0);
    const nextCacheRead = Number(usage.cache_read_input_tokens ?? 0);
    if (![nextInput, nextOutput, nextCacheCreation, nextCacheRead].every(Number.isFinite)) {
      continue;
    }
    inputTokens += nextInput;
    outputTokens += nextOutput;
    cacheCreation += nextCacheCreation;
    cacheRead += nextCacheRead;
    assistantMessages += 1;
  }

  const totalInput = inputTokens + cacheCreation + cacheRead;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
    total_input_tokens: totalInput,
    total_tokens: totalInput + outputTokens,
    assistant_messages: assistantMessages,
    source: assistantMessages > 0 ? 'claude_session_jsonl' : 'unavailable',
    session_path: filePath,
    session_id: matchedSessionId,
  };
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
  const withTokens = rows.filter((row) => row.token_usage?.source === 'claude_session_jsonl');
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
    ['--import', 'tsx', 'src/app/backend-rpc-stdio.ts'],
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
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await request<Record<string, unknown>>('run.getSnapshot', {
          run_id: runId,
        });
        if (snapshot.status !== 'running') return snapshot;
        await sleep(1_000);
      }
      throw new Error(`[${label}] run ${runId} did not finish within ${String(timeoutMs)}ms`);
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
