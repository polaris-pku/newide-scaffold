/**
 * §1 memory ablation smoke: B0 / B1 / B2 × 3 sequential related tasks.
 *
 * Uses production backend (real ACP driver + Postgres B memory).
 * Artifacts default to .newide/eval-runs/memory-ablation/<ts>/.
 *
 * Usage:
 *   pnpm exec tsx scripts/run-memory-ablation-smoke.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

type MemoryAblation = 'B0' | 'B1' | 'B2';

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
  waitForTaskTerminal(taskId: string, timeoutMs: number): Promise<TaskTerminalSnapshot>;
  close(): Promise<void>;
}

interface TaskTerminalSnapshot {
  task: { task_id: string; status: string };
  run_history: Array<{ run_id: string; status: string }>;
}

const repoRoot = process.cwd();
const configuredEnv = {
  ...loadEnvFile(path.join(repoRoot, '.env')),
  ...loadEnvFile(path.join(repoRoot, '.env.local')),
};
const baseEnv = {
  ...configuredEnv,
  ...process.env,
  ACP_DRIVER_RUNNER_DIR:
    process.env.ACP_DRIVER_RUNNER_DIR ??
    configuredEnv.ACP_DRIVER_RUNNER_DIR ??
    path.resolve(repoRoot, '..', 'acp-client-prototype'),
  ACP_DRIVER_TIMEOUT_MS:
    process.env.ACP_DRIVER_TIMEOUT_MS ?? configuredEnv.ACP_DRIVER_TIMEOUT_MS ?? '300000',
};
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const experimentRoot = path.resolve(
  baseEnv.NEWIDE_ABLATION_ROOT ??
    path.join(repoRoot, '.newide', 'eval-runs', 'memory-ablation'),
  stamp,
);
const runTimeoutMs = readPositiveInt(baseEnv.ACCEPTANCE_RUN_TIMEOUT_MS, 600_000);
const maintenanceWaitMs = readPositiveInt(baseEnv.ABLATION_MAINTENANCE_WAIT_MS, 45_000);

const TASKS = [
  {
    id: 't1_add',
    prompt: [
      '在工作区创建文件 ablation_math.ts。',
      '导出函数 add(a: number, b: number): number，返回 a + b。',
      '必须真实写入该文件，不要只打印计划。',
    ].join(''),
  },
  {
    id: 't2_mul',
    prompt: [
      '扩展已有 ablation_math.ts：新增导出函数 multiply(a: number, b: number): number，返回 a * b。',
      '保留原有 add。必须真实改文件。',
    ].join(''),
  },
  {
    id: 't3_sum_product',
    prompt: [
      '在 ablation_math.ts 新增导出函数 sumThenProduct(a: number, b: number, c: number): number，',
      '实现为 multiply(add(a, b), c)。复用已有函数。必须真实改文件。',
    ].join(''),
  },
] as const;

const ABLATIONS: MemoryAblation[] = ['B0', 'B1', 'B2'];

await fs.mkdir(experimentRoot, { recursive: true });
const databaseUrlTemplate =
  baseEnv.NEWIDE_ABLATION_DATABASE_URL_TEMPLATE ??
  'postgresql://newide:newide_local@127.0.0.1:55432/newide_{ablation}';

log(`experiment root: ${experimentRoot}`);
log(`ACP_DRIVER_RUNNER_DIR: ${baseEnv.ACP_DRIVER_RUNNER_DIR}`);

const armReports: unknown[] = [];
for (const ablation of ABLATIONS) {
  const armDir = path.join(experimentRoot, ablation);
  const workspace = path.join(armDir, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  const dbUrl = resolveAblationDatabaseUrl(databaseUrlTemplate, ablation);
  log('');
  log(`=== arm ${ablation} db=${dbUrl.replace(/:[^:@]+@/, ':***@')} ===`);

  const backend = await startBackend(ablation, {
    ...baseEnv,
    NEWIDE_B_DATABASE_URL: dbUrl,
    // Keep runs under the arm directory when possible.
    NEWIDE_RUNS_ROOT: path.join(armDir, 'runs'),
  });

  const taskResults: unknown[] = [];
  try {
    for (const task of TASKS) {
      log(`-- ${ablation}/${task.id} --`);
      const beforeFiles = await listWorkspaceFiles(workspace);
      const created = await backend.request<{ run_id: string; task_id: string }>('run.create', {
        prompt: task.prompt,
        mode: 'single_agent',
        workspace_path: workspace,
        memory_ablation: ablation,
        title: `${ablation}-${task.id}`,
      });
      await backend.request('run.subscribe', { run_id: created.run_id });
      const taskSnapshot = await backend.waitForTaskTerminal(created.task_id, runTimeoutMs);
      const finalRunId = latestTerminalRunId(taskSnapshot);
      const snapshot = await backend.waitForTerminal(finalRunId, runTimeoutMs);
      if (ablation !== 'B0') {
        await sleep(maintenanceWaitMs);
      }
      const afterFiles = await listWorkspaceFiles(workspace);
      const memory = await captureMemory(backend);
      const summaryPath = path.join(armDir, 'runs', finalRunId, 'summary.json');
      const summary = await readJsonIfExists(summaryPath);
      const row = {
        ablation,
        task_id: task.id,
        run_id: created.run_id,
        final_run_id: finalRunId,
        backend_task_id: created.task_id,
        snapshot_status: snapshot.status,
        memory_ablation_in_summary:
          summary && typeof summary === 'object'
            ? (summary as { memory_ablation?: string }).memory_ablation
            : undefined,
        files_changed: diffFiles(beforeFiles, afterFiles),
        memory,
        snapshot_diagnostics: extractDiagnostics(snapshot),
      };
      taskResults.push(row);
      await fs.writeFile(
        path.join(armDir, `${task.id}.json`),
        JSON.stringify(row, null, 2),
        'utf-8',
      );
      log(
        `  status=${String(snapshot.status)} files=${row.files_changed.length} exp=${String(memory.experience_count)} skills=${String(memory.skill_count)}`,
      );
    }
  } finally {
    await backend.close();
  }

  const armSummary = { ablation, tasks: taskResults };
  armReports.push(armSummary);
  await fs.writeFile(path.join(armDir, 'arm-summary.json'), JSON.stringify(armSummary, null, 2));
}

const summary = {
  schema_version: 'memory-ablation-smoke.v0',
  started_at: startedAt.toISOString(),
  finished_at: new Date().toISOString(),
  experiment_root: experimentRoot,
  arms: armReports,
};
const summaryPath = path.join(experimentRoot, 'summary.json');
await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
log('');
log(`summary: ${summaryPath}`);

const failed = armReports.some((arm) =>
  (arm as { tasks: Array<{ snapshot_status?: string }> }).tasks.some(
    (task) => task.snapshot_status !== 'succeeded' && task.snapshot_status !== 'completed',
  ),
);
if (failed) process.exitCode = 1;

// ---------------------------------------------------------------------------

async function startBackend(
  label: string,
  env: NodeJS.ProcessEnv,
): Promise<BackendClient> {
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
    waitForTaskTerminal: async (taskId, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
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

async function captureMemory(backend: BackendClient): Promise<{
  agents: unknown;
  experience_count: number;
  skill_count: number;
  experiences: unknown;
  skills: unknown;
}> {
  try {
    const listed = await backend.request<{ agents: Array<{ role_id: string }> }>(
      'memory.listAgents',
      {},
    );
    const roleId = listed.agents[0]?.role_id;
    if (!roleId) {
      return { agents: listed.agents, experience_count: 0, skill_count: 0, experiences: [], skills: [] };
    }
    const experiences = await backend.request<{ experiences: unknown[] }>(
      'memory.listExperiences',
      { role_id: roleId },
    );
    const skills = await backend.request<{ skills: unknown[] }>('memory.listSkills', {
      role_id: roleId,
    });
    return {
      agents: listed.agents,
      experience_count: experiences.experiences.length,
      skill_count: skills.skills.length,
      experiences: experiences.experiences,
      skills: skills.skills,
    };
  } catch (error) {
    return {
      agents: [],
      experience_count: 0,
      skill_count: 0,
      experiences: [],
      skills: [{ error: error instanceof Error ? error.message : String(error) }],
    };
  }
}

function extractDiagnostics(snapshot: Record<string, unknown>): unknown {
  const task = snapshot.task;
  if (!task || typeof task !== 'object') return undefined;
  return (task as { diagnostics?: unknown }).diagnostics;
}

async function listWorkspaceFiles(root: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  const walk = async (dir: string): Promise<void> => {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (dirent.name === '.newide' || dirent.name === 'node_modules' || dirent.name === '.git') {
        continue;
      }
      const fullPath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) await walk(fullPath);
      else if (dirent.isFile()) {
        const stat = await fs.stat(fullPath).catch(() => undefined);
        if (stat) files.set(path.relative(root, fullPath), stat.mtimeMs);
      }
    }
  };
  await walk(root);
  return files;
}

function diffFiles(before: Map<string, number>, after: Map<string, number>): string[] {
  const changed: string[] = [];
  for (const [file, mtime] of after) {
    const previous = before.get(file);
    if (previous === undefined || previous !== mtime) changed.push(file);
  }
  return changed.sort();
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
