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

log(`experiment root: ${experimentRoot}`);
log(`mirrors root: ${mirrorsRoot}`);
log(`subset=${subsetId} instances=${instanceIds.length} ablations=${ablations.join(',')}`);
log(`ACP_DRIVER_RUNNER_DIR: ${baseEnv.ACP_DRIVER_RUNNER_DIR}`);

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

const summary = {
  schema_version: 'sweevo-memory-ablation.v0',
  started_at: startedAt.toISOString(),
  finished_at: new Date().toISOString(),
  experiment_root: experimentRoot,
  mirrors_root: mirrorsRoot,
  subset_id: subsetId,
  instance_ids: instanceIds,
  ablations,
  model_name: modelName,
  run_harness: runHarness,
  harness_dry_run: harnessDryRun,
  skip_eval: skipEval,
  arms: armReports,
};
const summaryPath = path.join(experimentRoot, 'summary.json');
await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
log('');
log(`summary: ${summaryPath}`);

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
      await sleep(maintenanceWaitMs);
    }

    const summaryPath = path.join(repoRoot, '.newide', 'runs', created.run_id, 'summary.json');
    row.summary_path = summaryPath;
    const summary = await readJsonIfExists(summaryPath);
    if (summary && typeof summary === 'object' && 'worktree_path' in summary) {
      row.summary_worktree_path = String(
        (summary as { worktree_path?: unknown }).worktree_path ?? '',
      );
    }

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
    `Repository: ${instance.repo}`,
    `Instance: ${instance.instance_id}`,
    `Base commit: ${instance.base_commit}`,
    '',
    'Problem statement:',
    instance.problem_statement,
  ].join('\n');
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
