import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import {
  createProductionBackendService,
  startBackendRpcServer,
  type BackendRpcServer,
} from '../src/app/backend-rpc-stdio';
import {
  InMemoryBufferRepository,
  InMemoryRepository,
  type LlmClient,
  type ToolCallingClient,
} from '../src/memory';
import type { RunSnapshot } from '../src/protocol/run-snapshot';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type SmokeMode = 'single_agent' | 'council' | 'all';

const smokeMode = readSmokeMode(process.argv.slice(2));
const workspacePath = path.resolve(process.env.RPC_SMOKE_WORKSPACE ?? process.cwd());

const configuredRunnerDir = process.env.RPC_SMOKE_ACP_RUNNER_DIR;
const usesTemporaryRunner = configuredRunnerDir === undefined;
const runnerDir = configuredRunnerDir
  ? path.resolve(configuredRunnerDir)
  : await createFakeAcpRunner();
const invocationLog = path.join(runnerDir, 'invocations.log');
const runtime = usesTemporaryRunner
  ? 'production-composition-deterministic-b-llm-fake-acp'
  : 'production-composition-external-acp';
const stderr: string[] = [];
let spawnError: Error | undefined;
let localServer: BackendRpcServer | undefined;
let localOutput: PassThrough | undefined;
let child: ReturnType<typeof spawn> | undefined;
let childClosed: Promise<number | null> | undefined;
let backendInput: Writable;
let backendOutput: Readable;

if (usesTemporaryRunner) {
  const input = new PassThrough();
  localOutput = new PassThrough();
  localServer = startBackendRpcServer({
    input,
    writeLine: (line) => localOutput!.write(`${line}\n`),
    service: await createProductionBackendService(
      { ...process.env, ACP_DRIVER_RUNNER_DIR: runnerDir },
      {
        agentLlm: invokeDriverLlm(),
        memoryLlm: deterministicMaintenanceLlm(),
        bRuntime: {
          repository: new InMemoryRepository(),
          bufferRepository: new InMemoryBufferRepository(),
          app_state_root: process.env.NEWIDE_B_APP_STATE_ROOT ?? path.join(process.cwd(), '.newide'),
          market_agent_ids: ['role_fullstack_engineer', 'role_ts_engineer'],
          close: async () => undefined,
        },
      },
    ),
  });
  backendInput = input;
  backendOutput = localOutput;
} else {
  child = spawn('pnpm', ['backend:rpc'], {
    cwd: process.cwd(),
    env: { ...process.env, ACP_DRIVER_RUNNER_DIR: runnerDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  backendInput = child.stdin;
  backendOutput = child.stdout;
  childClosed = new Promise<number | null>((resolve) => {
    child!.once('error', (error) => {
      spawnError = error;
      resolve(null);
    });
    child!.once('close', resolve);
  });
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
}

const messages: JsonRpcMessage[] = [];
const waiters = new Set<{
  predicate: (message: JsonRpcMessage) => boolean;
  resolve: (message: JsonRpcMessage) => void;
}>();
createInterface({ input: backendOutput }).on('line', (line) => {
  const message = JSON.parse(line) as JsonRpcMessage;
  messages.push(message);
  for (const waiter of waiters) {
    if (!waiter.predicate(message)) continue;
    waiters.delete(waiter);
    waiter.resolve(message);
  }
});

let nextId = 1;
const runIds: string[] = [];
const taskIds: string[] = [];
let backendExitError: Error | undefined;

try {
  const single = smokeMode === 'council' ? undefined : await runAndVerify('single_agent');
  const council = smokeMode === 'single_agent' ? undefined : await runAndVerify('council');
  const cancelled = smokeMode === 'all' ? await createAndCancel() : undefined;
  if (cancelled) await waitForCancellationEffects();
  const driverInvocations = usesTemporaryRunner ? await countDriverInvocations() : undefined;
  if (driverInvocations !== undefined) {
    const expectedInvocations = smokeMode === 'all' ? 6 : smokeMode === 'single_agent' ? 1 : 5;
    assert(
      driverInvocations === expectedInvocations,
      `Expected ${expectedInvocations} driver invocations, received ${driverInvocations}`,
    );
  }
  const parseError =
    smokeMode === 'all' ? await sendRaw('not-json\n', (message) => message.id === null) : undefined;
  if (parseError) {
    assert(parseError.error?.code === -32700, 'Malformed JSON did not return parse error');
  }
  const unknown = smokeMode === 'all' ? await requestRaw('unknown.method', {}) : undefined;
  if (unknown) assert(unknown.error?.code === -32601, 'Unknown method did not return -32601');

  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      runtime,
      mode: smokeMode,
      ...(single ? { single_agent: single } : {}),
      ...(council ? { council } : {}),
      ...(driverInvocations === undefined ? {} : { driver_invocations: driverInvocations }),
      ...(cancelled ? { cancelled } : {}),
      ...(parseError ? { malformed_json_error: parseError.error?.code } : {}),
      ...(unknown ? { unknown_method_error: unknown.error?.code } : {}),
    })}\n`,
  );
} finally {
  backendInput.end();
  const exitCode = await waitForBackendClose();
  if (spawnError) {
    backendExitError = new Error(`backend:rpc failed to start: ${spawnError.message}`);
  } else if (exitCode !== 0) {
    backendExitError = new Error(`backend:rpc exited ${String(exitCode)}: ${stderr.join('')}`);
  }
  if (process.env.RPC_SMOKE_KEEP !== '1') {
    await Promise.all([
      ...runIds.map((runId) => fs.rm(`.newide/runs/${runId}`, { recursive: true, force: true })),
      ...taskIds.map((taskId) =>
        fs.rm(`.newide/worktrees/${taskId}`, { recursive: true, force: true }),
      ),
      ...(usesTemporaryRunner ? [fs.rm(runnerDir, { recursive: true, force: true })] : []),
    ]);
  }
}
if (backendExitError) throw backendExitError;

async function runAndVerify(mode: 'single_agent' | 'council'): Promise<Record<string, unknown>> {
  const prompt = usesTemporaryRunner
    ? `RPC smoke ${mode}`
    : mode === 'single_agent'
      ? '编写一个网页贪吃蛇游戏。请在工作区创建或覆盖 snake-single.html，要求可直接在浏览器打开运行，包含键盘控制、计分和重新开始功能。'
      : '编写一个网页贪吃蛇游戏。请以 snake-council.html 为最终候选文件，要求可直接在浏览器打开运行，包含键盘控制、计分和重新开始功能。';
  const created = await request<{ run_id: string; task_id: string; status: 'running' }>(
    'run.create',
    { prompt, mode, workspace_path: workspacePath },
  );
  runIds.push(created.run_id);
  taskIds.push(created.task_id);
  await request('run.subscribe', { run_id: created.run_id });
  const snapshot = await waitForTerminal(created.run_id);
  assert(snapshot.status === 'completed', `${mode} run ended as ${snapshot.status}`);
  assert(snapshot.timeline.length > 0, `${mode} snapshot has no timeline`);
  assert(
    snapshot.contract_version === 'frontend-workflow.v0.1',
    `${mode} snapshot has no frontend workflow contract version`,
  );
  assert(snapshot.task?.task_id === created.task_id, `${mode} task view is inconsistent`);
  assert(snapshot.task?.spec === prompt, `${mode} task view lost the submitted prompt`);
  assert(snapshot.run?.run_id === created.run_id, `${mode} run view is inconsistent`);
  assert(snapshot.run?.event_ids.length === snapshot.timeline.length, `${mode} event_ids drifted`);
  assert(snapshot.flow?.node_statuses.length === 19, `${mode} flow has no N0-N18 projection`);
  assert(snapshot.delivery_report?.worktree_path, `${mode} delivery has no worktree path`);
  assert(snapshot.links?.result_path, `${mode} snapshot has no result link`);
  assert(snapshot.artifacts.length > 0, `${mode} snapshot has no artifacts`);
  assert(snapshot.gates.length > 0, `${mode} snapshot has no gates`);
  assert(snapshot.final_output?.status === 'completed', `${mode} final output is incomplete`);
  const sourceFile = usesTemporaryRunner
    ? undefined
    : await validateSnakeArtifact(
        snapshot,
        mode === 'single_agent' ? 'snake-single.html' : 'snake-council.html',
      );
  if (mode === 'council') {
    assert(snapshot.council?.verdict === 'select', 'Council snapshot has no selected decision');
    assert(
      snapshot.council.can_create_merge_authorization === false,
      'Council unexpectedly authorizes merge',
    );
    assert(snapshot.gates.length === 2, 'Council did not execute pre and post gates');
    const eventTypes = snapshot.timeline.map((event) => event.type);
    const councilCompleted = eventTypes.indexOf('council.completed');
    const artifactSelected = eventTypes.indexOf('artifact.selected');
    const postGate = eventTypes.lastIndexOf('gate.result');
    const materializedEvent = eventTypes.indexOf('worktree.materialized');
    assert(
      [councilCompleted, artifactSelected, postGate, materializedEvent].every(
        (index) => index >= 0,
      ),
      'Council post-gate events are incomplete',
    );
    assert(
      councilCompleted < artifactSelected &&
        artifactSelected < postGate &&
        postGate < materializedEvent,
      'Council post-gate event order is invalid',
    );
    assert(
      snapshot.final_output.files_written.length > 0,
      'Council candidate content was not materialized',
    );
    const materialized = snapshot.final_output.files_written[0];
    const materializedContent = await fs.readFile(materialized, 'utf8');
    assert(materializedContent.length > 0, 'Council materialized file is empty');
    if (usesTemporaryRunner) {
      assert(
        materializedContent.startsWith('production composition smoke '),
        'Council materialized file does not contain fake driver output',
      );
    }
  }
  await assertRunFiles(created.run_id);
  const notificationTypes = messages
    .filter(
      (message) =>
        message.method === 'run.event' &&
        (message.params as { run_id?: string }).run_id === created.run_id,
    )
    .map((message) => (message.params as { event?: { type?: string } }).event?.type)
    .filter((type): type is string => Boolean(type));
  assert(notificationTypes.includes('run.completed'), `${mode} emitted no completion notification`);
  return {
    run_id: created.run_id,
    events: snapshot.timeline.length,
    artifacts: snapshot.artifacts.length,
    files_written: snapshot.final_output.files_written,
    ...(sourceFile ? { source_file: sourceFile } : {}),
  };
}

async function createAndCancel(): Promise<Record<string, unknown>> {
  const created = await request<{ run_id: string; task_id: string; status: 'running' }>(
    'run.create',
    { prompt: 'RPC smoke cancellation', mode: 'single_agent', workspace_path: workspacePath },
  );
  runIds.push(created.run_id);
  taskIds.push(created.task_id);
  await request('run.cancel', { run_id: created.run_id });
  const snapshot = await request<RunSnapshot>('run.getSnapshot', { run_id: created.run_id });
  assert(snapshot.status === 'cancelled', `Cancelled run ended as ${snapshot.status}`);
  await assertRunFiles(created.run_id);
  return { run_id: created.run_id, status: snapshot.status };
}

async function waitForTerminal(runId: string): Promise<RunSnapshot> {
  const timeoutMs = readTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await request<RunSnapshot>('run.getSnapshot', { run_id: runId });
    if (snapshot.status !== 'running') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${runId} did not reach a terminal state`);
}

async function validateSnakeArtifact(
  snapshot: RunSnapshot,
  expectedFilename: string,
): Promise<string> {
  const sourceFile = snapshot.artifacts
    .map((artifact) => artifact.source_path ?? artifact.metadata?.path)
    .find(
      (artifactPath): artifactPath is string =>
        typeof artifactPath === 'string' && path.basename(artifactPath) === expectedFilename,
    );
  assert(sourceFile, `No selected artifact points to ${expectedFilename}`);
  const html = await fs.readFile(sourceFile, 'utf8');
  const normalized = html.toLowerCase();
  assert(normalized.includes('<html'), `${expectedFilename} is not an HTML document`);
  assert(normalized.includes('<script'), `${expectedFilename} has no game script`);
  assert(
    normalized.includes('<canvas') || normalized.includes('grid'),
    `${expectedFilename} has no game board`,
  );
  assert(/score|得分/.test(normalized), `${expectedFilename} has no score UI`);
  assert(/restart|重新开始/.test(normalized), `${expectedFilename} has no restart UI`);
  return sourceFile;
}

function readTimeoutMs(): number {
  const value = Number(
    process.env.RPC_SMOKE_TIMEOUT_MS ?? (usesTemporaryRunner ? 30_000 : 300_000),
  );
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`RPC_SMOKE_TIMEOUT_MS must be a positive finite number: ${String(value)}`);
  }
  return value;
}

async function assertRunFiles(runId: string): Promise<void> {
  await Promise.all([
    fs.access(`.newide/runs/${runId}/audit.jsonl`),
    fs.access(`.newide/runs/${runId}/result.json`),
    fs.access(`.newide/runs/${runId}/frontend-snapshot.json`),
  ]);
}

async function request<T = unknown>(method: string, params: unknown): Promise<T> {
  const response = await requestRaw(method, params);
  if (response.error)
    throw new Error(`${method}: ${response.error.code} ${response.error.message}`);
  return response.result as T;
}

async function requestRaw(method: string, params: unknown): Promise<JsonRpcMessage> {
  const id = nextId++;
  const waiting = waitForMessage((message) => message.id === id);
  backendInput.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return waiting;
}

async function sendRaw(
  line: string,
  predicate: (message: JsonRpcMessage) => boolean,
): Promise<JsonRpcMessage> {
  const waiting = waitForMessage(predicate);
  backendInput.write(line);
  return waiting;
}

function waitForMessage(predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve };
    waiters.add(waiter);
    setTimeout(() => {
      if (!waiters.delete(waiter)) return;
      reject(new Error(`Timed out waiting for backend message. stderr=${stderr.join('')}`));
    }, 15_000).unref();
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function countDriverInvocations(): Promise<number> {
  const contents = await fs.readFile(invocationLog, 'utf8');
  return contents.trim().split('\n').filter(Boolean).length;
}

async function waitForCancellationEffects(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function waitForBackendClose(): Promise<number | null> {
  if (!child || !childClosed) {
    await localServer?.close();
    localOutput?.end();
    return 0;
  }
  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), 5_000).unref(),
  );
  const result = await Promise.race([childClosed, timeout]);
  if (result !== 'timeout') return result;
  child.kill('SIGTERM');
  const terminated = await Promise.race([
    childClosed,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000).unref()),
  ]);
  if (terminated !== 'timeout') return terminated;
  child.kill('SIGKILL');
  return childClosed;
}

function invokeDriverLlm(): ToolCallingClient {
  let sequence = 0;
  return {
    async completeWithTools(input) {
      const lastMessage = input.messages.at(-1);
      if (lastMessage?.role === 'tool') {
        return { content: 'Task completed. [done]', tool_calls: undefined };
      }
      const userMessage = [...input.messages].reverse().find((message) => message.role === 'user');
      sequence += 1;
      return {
        content: null,
        tool_calls: [
          {
            id: `rpc_smoke_tool_call_${String(sequence)}`,
            type: 'function',
            function: {
              name: 'invoke_driver',
              arguments: JSON.stringify({
                instruction: userMessage?.content?.replace(/^Task:\s*/, '') ?? 'Execute task.',
              }),
            },
          },
        ],
      };
    },
  };
}

function deterministicMaintenanceLlm(): LlmClient {
  return {
    async complete() {
      return JSON.stringify({
        experiences: [
          {
            description: 'RPC smoke execution lesson',
            content: 'Keep production RPC composition behind explicit ports.',
            type: 'positive',
            confidence: 0.9,
            tags: ['rpc'],
          },
        ],
      });
    },
  };
}

async function createFakeAcpRunner(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-rpc-smoke-acp-'));
  try {
    await fs.writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ private: true, scripts: { 'driver:run': 'node fake-driver.mjs' } }),
    );
    await fs.writeFile(
      path.join(directory, 'fake-driver.mjs'),
      `import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
let body = '';
process.stdin.on('data', chunk => body += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(body);
  const suffix = randomUUID();
  const created_at = new Date().toISOString();
  const artifact = {
    artifact_id: 'artifact_' + suffix,
    type: 'driver_result',
    uri: 'artifact://fake-acp/' + suffix,
    producer_id: 'claude-fake',
    task_id: input.task_id,
    created_at,
    schema_version: input.schema_version,
    content: {
      kind: 'text',
      content_ref: 'data:text/plain,' + encodeURIComponent('production composition smoke ' + suffix),
      target_path: 'output/' + suffix + '.txt'
    }
  };
  appendFileSync(new URL('./invocations.log', import.meta.url), 'invoke\\n');
  const writeResult = () => process.stdout.write(JSON.stringify({
    driver_run_result_id: 'driver_result_' + suffix,
    session_id: 'session_' + suffix,
    status: 'succeeded',
    artifacts: [artifact],
    transcript_ref: { ...artifact, artifact_id: 'transcript_' + suffix, type: 'transcript', content: undefined },
    tool_events: [],
    diagnostics: { driver_id: 'claude-fake', duration_ms: 1, notes: ['fake ACP process'] },
    created_at,
    schema_version: input.schema_version
  }));
  if (input.prompt.includes('RPC smoke cancellation')) setTimeout(writeResult, 250);
  else writeResult();
});
`,
    );
    return directory;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function readSmokeMode(args: string[]): SmokeMode {
  const modeIndex = args.indexOf('--mode');
  const value = modeIndex >= 0 ? args[modeIndex + 1] : 'all';
  if (value === 'single_agent' || value === 'council' || value === 'all') return value;
  throw new Error(`Invalid --mode value: ${value ?? '(missing)'}`);
}
