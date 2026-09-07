import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createWriteStream, existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureRepoMirror, resolveMirrorsRoot } from '../ensure-repo-mirror';
import { getInstanceOrThrow, indexDatasetById, loadDataset } from '../load-dataset';
import { loadDatasetSubset, loadManifest, resolveDatasetJsonl } from '../paths';
import {
  prepareEphemeralWorktree,
  removeEphemeralWorktree,
} from '../prepare-worktree';
import { collectWorktreePatch } from '../worktree-patch';
import type { SweEvoInstance } from '../types';
import { prepareAblationArmIsolation } from '../../scripts/ablation-arm-isolation';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const localRoot = path.join(repoRoot, '.newide', 'experiments', 'role-diversity');
const configPath = path.resolve(
  process.env.ROLE_DIVERSITY_CONFIG ??
    path.join(repoRoot, 'eval', 'role-diversity', 'experiment.example.json'),
);
const config = JSON.parse(readFileSync(configPath, 'utf8')) as ExperimentConfig;
const full = process.argv.includes('--full');
const pilot = process.argv.includes('--pilot');
if (full === pilot) throw new Error('Choose exactly one of --pilot or --full.');

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const resultRoot = path.resolve(
  process.env.ROLE_DIVERSITY_RESULT_ROOT ?? path.join(localRoot, 'results', stamp),
);
const worktreeScratchRoot = path.join(
  localRoot,
  'worktrees',
  path.basename(resultRoot),
);
const runTimeoutMs = positiveInt(process.env.ROLE_DIVERSITY_RUN_TIMEOUT_MS, 2_700_000);
const mirrorsRoot = resolveMirrorsRoot(process.env.NEWIDE_SWE_MIRRORS_ROOT);
const driverRoot = path.resolve(
  process.env.ACP_DRIVER_RUNNER_DIR ?? path.join(repoRoot, '..', 'acp-client-prototype'),
);
const driverEnvPath = path.resolve(
  process.env.ACP_DRIVER_ENV_FILE ?? path.join(driverRoot, '.env'),
);
const driverRunner = path.join(driverRoot, 'dist', 'src', 'driver', 'contract-runner.js');
const fileEnv: NodeJS.ProcessEnv = {
  ...loadEnv(path.join(repoRoot, '.env')),
  ...loadEnv(path.join(repoRoot, '.env.local')),
};
const acpEnv: NodeJS.ProcessEnv = {
  ...loadEnv(driverEnvPath),
  ...process.env,
};

if (!existsSync(driverRunner)) {
  throw new Error(`ACP Driver build is missing: ${driverRunner}`);
}

const manifest = loadManifest();
const subset = loadDatasetSubset(manifest, config.dataset_subset);
const datasetPath = resolveDatasetJsonl(manifest, subset.source_jsonl);
const instancesById = indexDatasetById(await loadDataset(datasetPath));
const selectedInstanceIds = full ? config.instances : [config.instances[0]!];
const selectedRoles = full ? config.roles : config.roles.slice(0, 2);
const selectedInstances = selectedInstanceIds.map((id) => getInstanceOrThrow(instancesById, id));

await fs.mkdir(resultRoot, { recursive: true });
await writeJson(path.join(resultRoot, 'experiment.json'), {
  ...config,
  run_scope: full ? 'full' : 'pilot',
  result_root: resultRoot,
  dataset_path: datasetPath,
  started_at: startedAt.toISOString(),
});
await fs.mkdir(path.join(resultRoot, 'inputs'), { recursive: true });
for (const instance of selectedInstances) {
  await writeJson(path.join(resultRoot, 'inputs', `${safe(instance.instance_id)}.json`), instance);
}

const databaseUrl =
  process.env.NEWIDE_B_DATABASE_URL ??
  fileEnv.NEWIDE_B_DATABASE_URL ??
  (await runText(path.join(repoRoot, 'scripts', 'ensure-b-memory-postgres.sh'), [], repoRoot));
process.env.NEWIDE_ABLATION_ALLOW_EXISTING_SCHEMA = existsSync(
  path.join(resultRoot, 'database.json'),
)
  ? '1'
  : '0';
const isolation = await prepareAblationArmIsolation({
  experiment_root: resultRoot,
  arm: 'role_diversity',
  database_url: databaseUrl.trim(),
});
await writeJson(path.join(resultRoot, 'database.json'), {
  schema: isolation.database_schema,
  state_root: isolation.state_root,
});

log(`result root: ${resultRoot}`);
log(`dataset: ${datasetPath}`);
log(`scope: ${full ? 'full' : 'pilot'}; roles=${selectedRoles.length}; instances=${selectedInstances.length}`);
log(`model: ${acpEnv.ANTHROPIC_MODEL ?? config.model_label}`);

const neutralPlans = new Map<string, NeutralPlanEvidence>();
for (const instance of selectedInstances) {
  neutralPlans.set(instance.instance_id, await ensureNeutralPlan(instance));
}

const cells: CellEvidence[] = [];
for (const role of selectedRoles) {
  const roleStateRoot = path.join(resultRoot, 'backend', role.key);
  const backend = await startBackend(role, roleStateRoot, isolation.database_url);
  try {
    await provisionRole(backend, role);
    for (const condition of config.conditions) {
      for (const instance of selectedInstances) {
        const neutral = neutralPlans.get(instance.instance_id)!;
        const cell = await runCell({ backend, role, condition, instance, neutral });
        cells.push(cell);
        await appendJsonl(path.join(resultRoot, 'cells.jsonl'), cell);
      }
    }
  } finally {
    await backend.close();
  }
}

const completed = cells.filter((cell) => cell.status === 'completed').length;
const summary = {
  experiment_id: config.experiment_id,
  scope: full ? 'full' : 'pilot',
  started_at: startedAt.toISOString(),
  completed_at: new Date().toISOString(),
  intended_role_cells: selectedRoles.length * selectedInstances.length * config.conditions.length,
  completed_role_cells: completed,
  failed_role_cells: cells.length - completed,
  neutral_plan_cells: neutralPlans.size,
  result_root: resultRoot,
  cells,
};
await writeJson(path.join(resultRoot, 'experiment-summary.json'), summary);
log(`summary: ${path.join(resultRoot, 'experiment-summary.json')}`);
if (completed !== cells.length) process.exitCode = 1;

async function ensureNeutralPlan(instance: SweEvoInstance): Promise<NeutralPlanEvidence> {
  const root = path.join(resultRoot, 'neutral-plans', safe(instance.instance_id));
  const evidencePath = path.join(root, 'neutral-plan.json');
  const existing = await readJson<NeutralPlanEvidence>(evidencePath);
  if (existing?.status === 'completed' && existsSync(path.join(root, 'shared-plan.md'))) {
    return existing;
  }
  await fs.mkdir(root, { recursive: true });
  const mirror = await ensureRepoMirror({
    repo: instance.repo,
    baseCommit: instance.base_commit,
    mirrorsRoot,
  });
  const prepared = await prepareEphemeralWorktree({
    sourceRepo: mirror.mirrorPath,
    baseCommit: instance.base_commit,
    runId: `neutral__${safe(instance.instance_id)}`,
    outRoot: path.join(worktreeScratchRoot, 'neutral', safe(instance.instance_id)),
  });
  const prompt = neutralPlanPrompt(instance);
  await fs.writeFile(path.join(root, 'prompt.txt'), prompt, 'utf8');
  await excludeExperimentFiles(prepared.worktreePath, ['shared-plan.md']);
  const started = Date.now();
  try {
    const runId = `neutral_${safe(instance.instance_id)}_${Date.now()}`;
    const driver = await runDirectDriver({
      taskId: `neutral_plan_${safe(instance.instance_id)}`,
      runId,
      prompt,
      workspace: prepared.worktreePath,
      outputRoot: root,
    });
    const planPath = path.join(prepared.worktreePath, 'shared-plan.md');
    if (!existsSync(planPath)) throw new Error('Neutral Agent did not create shared-plan.md');
    const plan = await fs.readFile(planPath, 'utf8');
    await fs.writeFile(path.join(root, 'shared-plan.md'), plan, 'utf8');
    const evidence: NeutralPlanEvidence = {
      status: 'completed',
      instance_id: instance.instance_id,
      run_id: runId,
      ...(driver.session_id ? { session_id: driver.session_id } : {}),
      model: acpEnv.ANTHROPIC_MODEL ?? config.model_label,
      plan_sha256: sha256(plan),
      wall_ms: Date.now() - started,
      trajectory_path: path.join(root, 'trajectory.jsonl'),
      plan_path: path.join(root, 'shared-plan.md'),
    };
    await writeJson(evidencePath, evidence);
    return evidence;
  } catch (error) {
    const evidence: NeutralPlanEvidence = {
      status: 'failed',
      instance_id: instance.instance_id,
      model: acpEnv.ANTHROPIC_MODEL ?? config.model_label,
      wall_ms: Date.now() - started,
      error: message(error),
      trajectory_path: path.join(root, 'trajectory.jsonl'),
      plan_path: path.join(root, 'shared-plan.md'),
    };
    await writeJson(evidencePath, evidence);
    throw error;
  } finally {
    await removeEphemeralWorktree(prepared.sourceRepo, prepared.worktreePath).catch(() => undefined);
  }
}

async function runCell(input: {
  backend: BackendClient;
  role: RoleConfig;
  condition: Condition;
  instance: SweEvoInstance;
  neutral: NeutralPlanEvidence;
}): Promise<CellEvidence> {
  const { backend, role, condition, instance, neutral } = input;
  const cellRoot = path.join(resultRoot, condition, safe(instance.instance_id), role.key);
  const existing = await readJson<CellEvidence>(path.join(cellRoot, 'cell.json'));
  if (existing?.status === 'completed') {
    log(`skip completed ${condition}/${instance.instance_id}/${role.key}`);
    return existing;
  }
  await fs.mkdir(cellRoot, { recursive: true });
  await writeJson(path.join(cellRoot, 'input.json'), instance);
  await writeJson(path.join(cellRoot, 'persona.json'), role);
  const mirror = await ensureRepoMirror({
    repo: instance.repo,
    baseCommit: instance.base_commit,
    mirrorsRoot,
  });
  const runKey = `${condition}__${safe(instance.instance_id)}__${role.key}`;
  const prepared = await prepareEphemeralWorktree({
    sourceRepo: mirror.mirrorPath,
    baseCommit: instance.base_commit,
    runId: runKey,
    outRoot: path.join(worktreeScratchRoot, condition, safe(instance.instance_id), role.key),
  });
  const planName = condition === 'independent_plan' ? 'experiment-plan.md' : 'role-plan.md';
  await excludeExperimentFiles(prepared.worktreePath, [
    'experiment-plan.md',
    'shared-plan.md',
    'role-plan.md',
  ]);
  if (condition === 'shared_neutral_plan') {
    const shared = await fs.readFile(neutral.plan_path, 'utf8');
    await fs.writeFile(path.join(prepared.worktreePath, 'shared-plan.md'), shared, 'utf8');
    await fs.writeFile(path.join(cellRoot, 'shared-plan.md'), shared, 'utf8');
  }
  const prompt = roleTaskPrompt(instance, condition, role);
  await fs.writeFile(path.join(cellRoot, 'prompt.txt'), prompt, 'utf8');
  const started = Date.now();
  let runId: string | undefined;
  let taskId: string | undefined;
  let snapshot: Record<string, unknown> | undefined;
  let patch = '';
  let patchError: string | undefined;
  let plan = '';
  let error: string | undefined;
  try {
    const created = await backend.request<{ run_id: string; task_id: string }>('run.create', {
      prompt,
      mode: 'single_agent',
      workspace_path: prepared.worktreePath,
      memory_ablation: 'B0',
      title: `${condition}-${instance.instance_id}-${role.key}`,
    });
    runId = created.run_id;
    taskId = created.task_id;
    snapshot = await backend.waitForTerminal(runId, runTimeoutMs);
    const planPath = path.join(prepared.worktreePath, planName);
    if (existsSync(planPath)) {
      plan = await fs.readFile(planPath, 'utf8');
      await fs.writeFile(path.join(cellRoot, 'plan.md'), plan, 'utf8');
    }
    try {
      patch = await collectWorktreePatch(prepared.worktreePath);
      await fs.writeFile(path.join(cellRoot, 'patch.diff'), patch, 'utf8');
    } catch (patchFailure) {
      patchError = message(patchFailure);
      await fs.writeFile(path.join(cellRoot, 'patch.diff'), '', 'utf8');
    }
    await copyRunEvidence(role.key, runId, cellRoot);
  } catch (failure) {
    error = message(failure);
    if (runId) await copyRunEvidence(role.key, runId, cellRoot).catch(() => undefined);
  } finally {
    const status = await gitStatus(prepared.worktreePath);
    await fs.writeFile(path.join(cellRoot, 'git-status.txt'), status, 'utf8');
    await removeEphemeralWorktree(prepared.sourceRepo, prepared.worktreePath).catch(() => undefined);
  }
  const backendSummary = runId
    ? await readJson<Record<string, unknown>>(
        path.join(resultRoot, 'backend', role.key, 'runs', runId, 'summary.json'),
      )
    : undefined;
  const terminalStatus = String(snapshot?.status ?? backendSummary?.status ?? 'failed');
  const evidence: CellEvidence = {
    status:
      terminalStatus === 'completed' && plan.trim() && patch.trim() ? 'completed' : 'failed',
    condition,
    role_key: role.key,
    role_id: role.role_id,
    instance_id: instance.instance_id,
    base_commit: instance.base_commit,
    model: acpEnv.ANTHROPIC_MODEL ?? config.model_label,
    memory_ablation: 'B0',
    ...(runId ? { run_id: runId } : {}),
    ...(taskId ? { task_id: taskId } : {}),
    terminal_status: terminalStatus,
    wall_ms: Date.now() - started,
    plan_path: path.join(cellRoot, 'plan.md'),
    ...(plan ? { plan_sha256: sha256(plan) } : {}),
    patch_path: path.join(cellRoot, 'patch.diff'),
    ...(patch ? { patch_sha256: sha256(patch) } : {}),
    ...(condition === 'shared_neutral_plan' && neutral.plan_sha256
      ? { shared_plan_sha256: neutral.plan_sha256 }
      : {}),
    ...(backendSummary?.token_usage !== undefined
      ? { token_usage: backendSummary.token_usage }
      : {}),
    ...(backendSummary?.driver_usage !== undefined
      ? { driver_usage: backendSummary.driver_usage }
      : {}),
    ...(patchError ? { patch_error: patchError } : {}),
    ...(error ? { error } : {}),
  };
  await writeJson(path.join(cellRoot, 'cell.json'), evidence);
  log(`${evidence.status} ${condition}/${instance.instance_id}/${role.key}`);
  return evidence;
}

async function provisionRole(backend: BackendClient, role: RoleConfig): Promise<void> {
  let created = false;
  try {
    await backend.request('memory.getAgent', { role_id: role.role_id });
  } catch {
    await backend.request('memory.createAgent', {
      role_id: role.role_id,
      name: role.name,
      tags: role.tags,
      persona_seed: role.summary,
      constraints: [],
    });
    created = true;
  }
  if (created) {
    await backend.request('memory.updatePersona', {
      role_id: role.role_id,
      summary: role.summary,
      skills_overview: role.skills_overview,
      experience_coverage: 'Controlled B0 experiment: no prior Experience context is loaded.',
      recent_performance: 'Controlled experiment baseline; no performance history is supplied.',
      notes: role.notes,
    });
  }
  const agent = await backend.request<Record<string, unknown>>('memory.getAgent', {
    role_id: role.role_id,
  });
  await writeJson(path.join(resultRoot, 'personas', `${role.key}.json`), agent);
}

async function startBackend(
  role: RoleConfig,
  stateRoot: string,
  databaseUrl: string,
): Promise<BackendClient> {
  await fs.mkdir(stateRoot, { recursive: true });
  const backendLog = path.join(stateRoot, 'backend.stderr.log');
  const backendEnv: NodeJS.ProcessEnv = {
    ...fileEnv,
    ...process.env,
    ACP_DRIVER_RUNNER_DIR: driverRoot,
    ACP_DRIVER_ENV_FILE: driverEnvPath,
    ACP_DRIVER_TIMEOUT_MS: String(7 * 24 * 60 * 60 * 1000),
    NEWIDE_B_DATABASE_URL: databaseUrl,
    NEWIDE_B_EMBEDDING_PROVIDER: 'hash',
    NEWIDE_B_EMBEDDING_DIMENSIONS: '32',
    NEWIDE_STATE_ROOT: stateRoot,
    NEWIDE_COORDINATION_DB: path.join(stateRoot, 'coordination.sqlite'),
    NEWIDE_AUCTION_ENABLED: '0',
    NEWIDE_PRIMARY_AGENT_ID: role.role_id,
    AUTO_APPROVE: '1',
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/app/backend-rpc-entry.ts'], {
    cwd: repoRoot,
    env: backendEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr?.pipe(createWriteStream(backendLog, { flags: 'a' }));
  const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
  const waiters = new Map<number, (message: JsonRpcMessage) => void>();
  createInterface({ input: child.stdout! }).on('line', (line) => {
    try {
      const message = JSON.parse(line) as JsonRpcMessage;
      if (typeof message.id !== 'number') return;
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
    } catch {
      // stdout remains JSON-RPC-only; malformed lines are preserved by backend stderr.
    }
  });
  let nextId = 1;
  const request = async <T>(method: string, params: unknown): Promise<T> => {
    const id = nextId++;
    const response = new Promise<JsonRpcMessage>((resolve, reject) => {
      waiters.set(id, resolve);
      setTimeout(() => {
        if (!waiters.delete(id)) return;
        reject(new Error(`RPC ${method} timed out`));
      }, 60_000).unref();
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const message = await response;
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result as T;
  };
  await request('system.ping', {});
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
      await request('run.cancel', { run_id: runId }).catch(() => undefined);
      throw new Error(`Run ${runId} exceeded experiment budget ${String(timeoutMs)}ms`);
    },
    close: async () => {
      child.stdin?.end();
      const result = await Promise.race([closed, sleep(5_000).then(() => 'timeout' as const)]);
      if (result === 'timeout') child.kill('SIGTERM');
    },
  };
}

async function runDirectDriver(input: {
  taskId: string;
  runId: string;
  prompt: string;
  workspace: string;
  outputRoot: string;
}): Promise<{ session_id?: string }> {
  const trajectoryPath = path.join(input.outputRoot, 'trajectory.jsonl');
  const stderrPath = path.join(input.outputRoot, 'driver.stderr.log');
  await fs.writeFile(trajectoryPath, '', 'utf8');
  await fs.writeFile(stderrPath, '', 'utf8');
  const neutralHome = path.join(input.outputRoot, 'claude-home');
  await fs.mkdir(neutralHome, { recursive: true });
  const child = spawn(process.execPath, [driverRunner], {
    cwd: driverRoot,
    env: {
      ...process.env,
      ...acpEnv,
      ACP_AGENT_ID: acpEnv.ACP_AGENT_ID ?? 'claude',
      AUTO_APPROVE: '1',
      ACP_WORKSPACE: input.workspace,
      CLAUDE_CONFIG_DIR: neutralHome,
      ACP_DENY_NETWORK_TOOLS: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin?.end(
    `${JSON.stringify({
      task_id: input.taskId,
      run_id: input.runId,
      prompt: input.prompt,
      workspace_path: input.workspace,
      created_at: new Date().toISOString(),
      schema_version: 'v0',
    })}\n`,
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const stderrRaw = Buffer.concat(stderr).toString('utf8');
  await fs.writeFile(stderrPath, stderrRaw, 'utf8');
  const prefix = 'NEWIDE_DRIVER_EVENT ';
  const trajectory = stderrRaw
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
    .join('\n');
  await fs.writeFile(trajectoryPath, trajectory ? `${trajectory}\n` : '', 'utf8');
  const raw = Buffer.concat(stdout).toString('utf8').trim();
  await fs.writeFile(path.join(input.outputRoot, 'driver-result.json'), raw || '{}', 'utf8');
  if (code !== 0) throw new Error(`Neutral ACP Driver exited with code ${String(code)}`);
  return JSON.parse(raw) as { session_id?: string };
}

async function copyRunEvidence(roleKey: string, runId: string, cellRoot: string): Promise<void> {
  const source = path.join(resultRoot, 'backend', roleKey, 'runs', runId);
  for (const [from, to] of [
    ['driver-stream.jsonl', 'trajectory.jsonl'],
    ['audit.jsonl', 'audit.jsonl'],
    ['summary.json', 'summary.json'],
    ['frontend-snapshot.json', 'snapshot.json'],
    ['result.json', 'result.json'],
    ['timeline.json', 'timeline.json'],
  ] as const) {
    const input = path.join(source, from);
    if (existsSync(input)) await fs.copyFile(input, path.join(cellRoot, to));
  }
}

function roleTaskPrompt(
  instance: SweEvoInstance,
  condition: Condition,
  role: RoleConfig,
): string {
  const planning =
    condition === 'independent_plan'
      ? [
          'Before modifying product files, write your complete analysis and implementation Plan to experiment-plan.md.',
          'Then execute that Plan and finish the code change in the same task.',
        ]
      : [
          'Read shared-plan.md as the common initial Plan.',
          'Write role-plan.md explaining the decisions you keep, revise, or add, then implement the resulting Plan.',
        ];
  return [
    rolePrompt(role),
    '',
    'You are fixing a real GitHub issue in an already checked-out repository at the specified base commit.',
    ...planning,
    'The Plan file is experiment evidence; keep all product changes focused on the issue.',
    'Keep every read and write inside the current repository; do not inspect parent directories.',
    'Do not add, edit, delete, rename, or generate tests or test-runner configuration.',
    'Use only the provided problem statement and local repository. Internet access is unavailable.',
    '',
    `Repository: ${instance.repo}`,
    `Instance: ${instance.instance_id}`,
    `Base commit: ${instance.base_commit}`,
    '',
    'Problem statement:',
    instance.problem_statement,
  ].join('\n');
}

function rolePrompt(role: RoleConfig): string {
  return [
    '<<<ROLE_EXPERIMENT_CONTEXT>>>',
    `Role ID: ${role.role_id}`,
    `Role name: ${role.name}`,
    `Role priorities: ${role.summary}`,
    `Analysis focus: ${role.skills_overview}`,
    `Decision guidance: ${role.notes}`,
    ...(role.prompt_skills.length > 0
      ? [
          'Role skills:',
          ...role.prompt_skills.map(
            (skill, index) =>
              `${String(index + 1)}. ${skill.name}: ${skill.instruction}`,
          ),
        ]
      : []),
    'Apply this engineering role consistently when selecting scope, planning changes, implementing code, evaluating tradeoffs, and choosing verification.',
    '<<<END_ROLE_EXPERIMENT_CONTEXT>>>',
  ].join('\n');
}

function neutralPlanPrompt(instance: SweEvoInstance): string {
  return [
    'Analyze this software-engineering task without adopting a specialized correctness, performance, security, reliability, or maintainability role.',
    'Inspect the local repository and write a concrete implementation Plan to the relative path shared-plan.md in the current repository root.',
    'Keep every read and write inside the current repository; do not inspect parent directories.',
    'Include likely root cause, affected files, ordered edits, risks, and verification.',
    'Do not modify product files and do not implement the solution.',
    'Use only the provided problem statement and local repository. Internet access is unavailable.',
    '',
    `Repository: ${instance.repo}`,
    `Instance: ${instance.instance_id}`,
    `Base commit: ${instance.base_commit}`,
    '',
    'Problem statement:',
    instance.problem_statement,
  ].join('\n');
}

async function excludeExperimentFiles(worktree: string, names: string[]): Promise<void> {
  await fs.appendFile(path.join(worktree, '.git', 'info', 'exclude'), `${names.join('\n')}\n`);
}

async function gitStatus(worktree: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['status', '--short'], {
    cwd: worktree,
    encoding: 'utf8',
  });
  return stdout;
}

async function runText(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd, encoding: 'utf8' });
  return stdout;
}

function loadEnv(filePath: string): NodeJS.ProcessEnv {
  if (!existsSync(filePath)) return {};
  return Object.fromEntries(
    readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .flatMap((raw) => {
        const line = raw.trim();
        if (!line || line.startsWith('#')) return [];
        const index = line.indexOf('=');
        if (index < 1) return [];
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim().replace(/^(?:"(.*)"|'(.*)')$/, '$1$2');
        return [[key, value]];
      }),
  );
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safe(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_.-]/g, '_');
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(value: string): void {
  process.stderr.write(`[role-diversity] ${value}\n`);
}

type Condition = 'independent_plan' | 'shared_neutral_plan';

interface RoleConfig {
  key: string;
  role_id: string;
  name: string;
  tags: string[];
  prompt_skills: Array<{ name: string; instruction: string }>;
  summary: string;
  skills_overview: string;
  notes: string;
}

interface ExperimentConfig {
  experiment_id: string;
  model_label: string;
  dataset_subset: string;
  memory_ablation: 'B0';
  conditions: Condition[];
  instances: string[];
  roles: RoleConfig[];
}

interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

interface BackendClient {
  request<T>(method: string, params: unknown): Promise<T>;
  waitForTerminal(runId: string, timeoutMs: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

interface NeutralPlanEvidence {
  status: 'completed' | 'failed';
  instance_id: string;
  run_id?: string;
  session_id?: string;
  model: string;
  plan_sha256?: string;
  wall_ms: number;
  trajectory_path: string;
  plan_path: string;
  error?: string;
}

interface CellEvidence {
  status: 'completed' | 'failed';
  condition: Condition;
  role_key: string;
  role_id: string;
  instance_id: string;
  base_commit: string;
  model: string;
  memory_ablation: 'B0';
  run_id?: string;
  task_id?: string;
  terminal_status: string;
  wall_ms: number;
  plan_path: string;
  plan_sha256?: string;
  patch_path: string;
  patch_sha256?: string;
  shared_plan_sha256?: string;
  token_usage?: unknown;
  driver_usage?: unknown;
  patch_error?: string;
  error?: string;
}
