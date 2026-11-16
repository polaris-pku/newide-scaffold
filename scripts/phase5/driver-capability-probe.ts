/**
 * 阶段 5：真实 Driver 能力探针（只声明实际验证过的能力）。
 *
 * 职责与核心逻辑：
 * - 三个独立探针，各自用真实外部 ACP Driver + 真实 provider 跑一次受控 Run：
 *   1) `cancel`   —— 派工在飞时 `run.cancel`，验证取消语义与终态；
 *   2) `timeout`  —— 收紧宿主派工超时（NEWIDE_ROLE_DISPATCH_TIMEOUT_MS），验证超时终止码；
 *   3) `session-reuse` —— 旧路径两次 Run 复用同一 driver session（显式 session_id），验证
 *      Session 复用/原生续做是否真的成立。
 * - 结果写 `.newide/phase5/fixed-tasks/capability/<probe>/result.json`，原始证据留在
 *   `<probe>/state/runs/<run_id>/`。失败照实记录（含 stderr 片段），不宣称未验证的能力。
 *
 * 与 fixed-tasks.ts 共用同一套后端 stdio 启动/等待模式（不另起框架）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type ProbeName = 'cancel' | 'timeout' | 'session-reuse';

interface ProbeOptions {
  probe: ProbeName;
  repoRoot: string;
  outRoot: string;
  runnerDir: string;
  timeoutMs: number;
}

interface BackendClient {
  request<T>(method: string, params: unknown): Promise<T>;
  waitForTerminal(runId: string, timeoutMs: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

const LONG_TASK_PROMPT =
  '请在工作区依次创建 40 个文件 step01.txt 到 step40.txt，每个文件写 50 行编号文本，' +
  '逐文件创建，不要一次性完成，也不要提前结束。';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const probeRoot = path.join(options.outRoot, 'capability', options.probe);
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(path.join(probeRoot, 'workspace'), { recursive: true });
  const result =
    options.probe === 'session-reuse'
      ? await runSessionReuseProbe(options, probeRoot)
      : await runSingleRunProbe(options, probeRoot);
  await fs.writeFile(
    path.join(probeRoot, 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(
    `[capability] ${options.probe}: ${JSON.stringify(result.summary)}\n` +
      `[capability] result: ${path.join(probeRoot, 'result.json')}\n`,
  );
}

function parseArgs(args: string[]): ProbeOptions {
  const repoRoot = process.cwd();
  const options: ProbeOptions = {
    probe: 'cancel',
    repoRoot,
    outRoot: path.join(repoRoot, '.newide', 'phase5', 'fixed-tasks'),
    runnerDir:
      process.env.ACP_DRIVER_RUNNER_DIR?.trim() ||
      path.join(repoRoot, '.newide', 'phase5', 'driver-runner'),
    timeoutMs: 300_000,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    switch (arg) {
      case '--probe':
        if (next !== 'cancel' && next !== 'timeout' && next !== 'session-reuse') {
          throw new Error(`Invalid --probe: ${String(next)}`);
        }
        options.probe = next;
        index += 1;
        break;
      case '--runner-dir':
        options.runnerDir = path.resolve(String(next));
        index += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = Number(next);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function probeEnv(
  options: ProbeOptions,
  probeRoot: string,
  extra: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const stateRoot = path.join(probeRoot, 'state');
  return {
    ...process.env,
    NEWIDE_ROLE_AUTONOMY: '1',
    NEWIDE_DRIVER_EVIDENCE_ONLY: '1',
    NEWIDE_BUFFER_V2: '1',
    NEWIDE_STATE_ROOT: stateRoot,
    NEWIDE_B_APP_STATE_ROOT: path.join(probeRoot, 'b'),
    NEWIDE_B_PGLITE_DATA_DIR: path.join(probeRoot, 'b', 'pglite'),
    CLAUDE_CONFIG_DIR: path.join(probeRoot, 'claude-config'),
    ACP_DRIVER_RUNNER_DIR: options.runnerDir,
    ACP_DRIVER_ENV_FILE: path.join(options.runnerDir, '.env'),
    ACP_DRIVER_INACTIVITY_TIMEOUT_MS: '600000',
    ACP_DRIVER_TIMEOUT_MS: '600000',
    NEWIDE_GATE_COMMAND: '',
    NEWIDE_DEFAULT_RUN_MODE: 'single_agent',
    NEWIDE_TELEMETRY_JSONL: '1',
    NEWIDE_DRIVER_USAGE_JSONL: '1',
    ...extra,
  };
}

interface ProbeResult {
  schema_version: 'newide.phase5.driver_capability_probe.v1';
  probe: ProbeName;
  generated_at: string;
  config: Record<string, unknown>;
  summary: Record<string, unknown>;
  runs: Array<Record<string, unknown>>;
  capability: Record<string, unknown>;
  notes: string[];
}

async function runSingleRunProbe(
  options: ProbeOptions,
  probeRoot: string,
): Promise<ProbeResult> {
  const workspace = path.join(probeRoot, 'workspace');
  await fs.writeFile(path.join(workspace, 'note.txt'), 'capability probe workspace\n', 'utf8');
  const extra: NodeJS.ProcessEnv =
    options.probe === 'timeout' ? { NEWIDE_ROLE_DISPATCH_TIMEOUT_MS: '15000' } : {};
  const backend = await startBackend(options, probeEnv(options, probeRoot, extra), probeRoot);
  const notes: string[] = [];
  const runRecord: Record<string, unknown> = {};
  try {
    const created = await backend.request<{ run_id: string; task_id: string }>('run.create', {
      prompt: LONG_TASK_PROMPT,
      mode: 'single_agent',
      workspace_path: workspace,
    });
    runRecord.started_at = new Date().toISOString();
    runRecord.run_id = created.run_id;
    runRecord.task_id = created.task_id;
    const runDir = path.join(probeRoot, 'state', 'runs', created.run_id);
    runRecord.run_dir = runDir;
    const journalPath = path.join(runDir, 'journal', 'dispatches.jsonl');
    let cancelledAt: string | undefined;
    if (options.probe === 'cancel') {
      // 等派工真的在飞（Journal 有 dispatched 行）再取消；最多等 90s。
      const deadline = Date.now() + 90_000;
      for (;;) {
        const dispatched = await journalHasDispatched(journalPath);
        if (dispatched) break;
        if (Date.now() > deadline) {
          notes.push('cancel probe: no dispatched entry observed before cancel');
          break;
        }
        await sleep(1_000);
      }
      cancelledAt = new Date().toISOString();
      await backend.request('run.cancel', { run_id: created.run_id });
      runRecord.cancelled_at = cancelledAt;
    }
    const terminal = await backend.waitForTerminal(created.run_id, options.timeoutMs);
    runRecord.status = terminal.status;
    runRecord.errors = terminal.errors ?? [];
    runRecord.duration_ms = durationBetween(runRecord.started_at, new Date().toISOString());
    const facts = await collectRunFacts(runDir);
    Object.assign(runRecord, facts);
    runRecord.driver_events_after_cancel = facts.driver_stream_lines;
    if (options.probe === 'cancel') {
      notes.push(`cancel_after_dispatched=${String(facts.dispatched_count > 0)}`);
    }
    if (options.probe === 'timeout') {
      notes.push(`timeout_config=NEWIDE_ROLE_DISPATCH_TIMEOUT_MS=15000`);
    }
  } catch (error) {
    runRecord.harness_error = error instanceof Error ? error.message : String(error);
  } finally {
    await backend.close();
  }
  const capability: Record<string, unknown> = {};
  if (options.probe === 'cancel') {
    capability.cancel = {
      verified: runRecord.status === 'cancelled',
      observed_status: runRecord.status,
      termination_code: (runRecord.termination as Record<string, unknown> | undefined)?.code,
      driver_events_after_cancel: runRecord.driver_events_after_cancel,
    };
  } else {
    capability.timeout = {
      verified:
        runRecord.status === 'failed' &&
        typeof (runRecord.termination as Record<string, unknown> | undefined)?.code === 'string',
      observed_status: runRecord.status,
      termination_code: (runRecord.termination as Record<string, unknown> | undefined)?.code,
      dispatch_status: runRecord.dispatch_status,
    };
  }
  return {
    schema_version: 'newide.phase5.driver_capability_probe.v1',
    probe: options.probe,
    generated_at: new Date().toISOString(),
    config: {
      runner_dir: options.runnerDir,
      switches: { NEWIDE_ROLE_AUTONOMY: '1', NEWIDE_DRIVER_EVIDENCE_ONLY: '1', NEWIDE_BUFFER_V2: '1' },
      extra_env: extra,
      provider:
        '真实 provider 经本地 CC Switch 代理 (127.0.0.1:15721)，实际映射 deepseek-v4.1-flash',
    },
    summary: {
      probe: options.probe,
      status: runRecord.status,
      termination_code: (runRecord.termination as Record<string, unknown> | undefined)?.code,
      dispatch_total: runRecord.dispatch_total,
      role_rounds: runRecord.role_rounds,
    },
    runs: [runRecord],
    capability,
    notes,
  };
}

/**
 * Session 复用探针：旧路径（legacy）两次 Run 复用同一 driver session。
 * 旧路径没有 Journal，但 `summary.json.session_id` 是 driver 真实 session id；
 * 第二个 Run 显式带 `session_id`，宿主会走 native session load 而不是新建会话。
 */
async function runSessionReuseProbe(
  options: ProbeOptions,
  probeRoot: string,
): Promise<ProbeResult> {
  const workspace = path.join(probeRoot, 'workspace');
  const backend = await startBackend(
    options,
    probeEnv(options, probeRoot, {
      NEWIDE_ROLE_AUTONOMY: '0',
      NEWIDE_DRIVER_EVIDENCE_ONLY: '0',
      NEWIDE_BUFFER_V2: '0',
    }),
    probeRoot,
  );
  const notes: string[] = [];
  const runs: Array<Record<string, unknown>> = [];
  try {
    const first = await backend.request<{ run_id: string }>('run.create', {
      prompt: '在工作区创建 base.txt，内容为一行 SESSION_BASE。完成后结束任务。',
      mode: 'single_agent',
      workspace_path: workspace,
    });
    const firstTerminal = await backend.waitForTerminal(first.run_id, options.timeoutMs);
    const firstRunDir = path.join(probeRoot, 'state', 'runs', first.run_id);
    const firstSummary = await readJson(path.join(firstRunDir, 'summary.json'));
    const sessionId = optionalString(asRecord(firstSummary)?.session_id);
    runs.push({
      run_id: first.run_id,
      phase: 'create-session',
      status: firstTerminal.status,
      session_id: sessionId,
      run_dir: firstRunDir,
      base_file: await fileExists(path.join(workspace, 'base.txt')),
    });
    if (sessionId === undefined) {
      notes.push('first run produced no session_id; cannot test session reuse');
    } else {
      const second = await backend.request<{ run_id: string }>('run.create', {
        prompt:
          '这是同一个会话的续做：先读取工作区里的 base.txt，然后创建 derived.txt，' +
          '内容为 base.txt 的内容加上后缀 _DERIVED。完成后结束任务。',
        mode: 'single_agent',
        workspace_path: workspace,
        session_id: sessionId,
      });
      const secondTerminal = await backend.waitForTerminal(second.run_id, options.timeoutMs);
      const secondRunDir = path.join(probeRoot, 'state', 'runs', second.run_id);
      const secondSummary = await readJson(path.join(secondRunDir, 'summary.json'));
      const secondSessionId = optionalString(asRecord(secondSummary)?.session_id);
      const derived = await readFileIfExists(path.join(workspace, 'derived.txt'));
      runs.push({
        run_id: second.run_id,
        phase: 'reuse-session',
        requested_session_id: sessionId,
        status: secondTerminal.status,
        session_id: secondSessionId,
        run_dir: secondRunDir,
        derived_file: derived !== undefined,
        derived_content: derived,
      });
      const reuseObserved = secondSessionId === sessionId;
      notes.push(`session_id_equal=${String(reuseObserved)}`);
    }
  } catch (error) {
    notes.push(`harness_error=${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await backend.close();
  }
  const reuse = runs.find((run) => run.phase === 'reuse-session');
  return {
    schema_version: 'newide.phase5.driver_capability_probe.v1',
    probe: 'session-reuse',
    generated_at: new Date().toISOString(),
    config: {
      runner_dir: options.runnerDir,
      switches: { NEWIDE_ROLE_AUTONOMY: '0', NEWIDE_DRIVER_EVIDENCE_ONLY: '0', NEWIDE_BUFFER_V2: '0' },
      path: 'legacy（原生 session load 只在旧路径显式 session_id 时触发）',
    },
    summary: {
      probe: 'session-reuse',
      first_status: runs[0]?.status,
      second_status: reuse?.status,
      session_id_reused: reuse !== undefined && reuse.session_id === reuse.requested_session_id,
    },
    runs,
    capability: {
      session_reuse: {
        verified:
          reuse !== undefined &&
          reuse.status === 'completed' &&
          reuse.session_id === reuse.requested_session_id,
        requested_session_id: reuse?.requested_session_id,
        observed_session_id: reuse?.session_id,
        second_run_status: reuse?.status,
      },
    },
    notes,
  };
}

// ── 证据读取 ──────────────────────────────────────────────────────

async function collectRunFacts(runDir: string): Promise<Record<string, unknown>> {
  const journal = await readLines(path.join(runDir, 'journal', 'dispatches.jsonl'));
  let dispatchTotal = 0;
  let dispatchedCount = 0;
  let roleRounds = 0;
  const settledStatus: Record<string, number> = {};
  const violations = new Set<string>();
  for (const line of journal) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.event === 'accepted') dispatchTotal += 1;
      if (entry.event === 'dispatched') dispatchedCount += 1;
      if (entry.event === 'role_round') roleRounds += 1;
      if (entry.event === 'settled') {
        const status = optionalString(entry.status) ?? 'unknown';
        settledStatus[status] = (settledStatus[status] ?? 0) + 1;
        if (Array.isArray(entry.violations)) {
          for (const violation of entry.violations) violations.add(String(violation));
        }
      }
    } catch {
      // ignore bad line
    }
  }
  const timeline = await readJson(path.join(runDir, 'timeline.json'));
  const events = Array.isArray(timeline) ? timeline : [];
  let termination: Record<string, unknown> | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = asRecord(events[index]);
    const type = optionalString(event?.type);
    if (type !== 'run.failed' && type !== 'run.cancelled' && type !== 'run.interrupted') continue;
    const payload = asRecord(event?.payload);
    termination = {
      code: optionalString(payload?.code),
      message: optionalString(payload?.message),
      source: type,
    };
    break;
  }
  const stream = await readLines(path.join(runDir, 'driver-stream.jsonl'));
  const commandObserved = stream.filter((line) =>
    line.includes('"event_type":"driver.command_observed"'),
  ).length;
  const eventTypes: Record<string, number> = {};
  for (const line of stream) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = optionalString(event.event_type);
      if (type !== undefined) eventTypes[type] = (eventTypes[type] ?? 0) + 1;
    } catch {
      // ignore
    }
  }
  return {
    dispatch_total: dispatchTotal,
    dispatched_count: dispatchedCount,
    role_rounds: roleRounds,
    dispatch_status: settledStatus,
    violation_kinds: [...violations],
    termination,
    driver_stream_lines: stream.length,
    driver_command_observed_events: commandObserved,
    driver_event_types: eventTypes,
    run_files: await listFiles(runDir),
  };
}

async function journalHasDispatched(journalPath: string): Promise<boolean> {
  const lines = await readLines(journalPath);
  return lines.some((line) => line.includes('"event":"dispatched"'));
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      files.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  };
  await walk(root);
  return files.sort();
}

async function readLines(filePath: string): Promise<string[]> {
  try {
    return (await fs.readFile(filePath, 'utf8')).split(/\r?\n/).filter((line) => line.trim());
  } catch {
    return [];
  }
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function durationBetween(startIso: unknown, endIso: string): number | undefined {
  if (typeof startIso !== 'string') return undefined;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 后端 stdio 客户端 ─────────────────────────────────────────────

async function startBackend(
  options: ProbeOptions,
  env: NodeJS.ProcessEnv,
  probeRoot: string,
): Promise<BackendClient> {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['--import', 'tsx', path.join('src', 'app', 'backend-rpc-entry.ts')],
    { cwd: options.repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const stderrChunks: string[] = [];
  const stderrHandle = await fs.open(path.join(probeRoot, 'backend.stderr.log'), 'w');
  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(String(chunk));
    void stderrHandle.write(String(chunk)).catch(() => undefined);
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code));
  });
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  const waiters = new Set<{
    predicate: (message: JsonRpcMessage) => boolean;
    resolve: (message: JsonRpcMessage) => void;
  }>();
  createInterface({ input: child.stdout }).on('line', (line) => {
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
    if (spawnError) throw spawnError;
    const id = nextId++;
    const response = await new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(
          new Error(`${method} timed out (120s). stderr=${stderrChunks.join('').slice(-2_000)}`),
        );
      }, 120_000);
      const waiter = {
        predicate: (message: JsonRpcMessage) => message.id === id,
        resolve: (message: JsonRpcMessage) => {
          clearTimeout(timer);
          resolve(message);
        },
      };
      waiters.add(waiter);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    if (response.error) {
      throw new Error(`${method}: ${String(response.error.code)} ${response.error.message}`);
    }
    return response.result as T;
  };
  const pingDeadline = Date.now() + 180_000;
  for (;;) {
    try {
      await request('system.ping', {});
      break;
    } catch (error) {
      if (Date.now() > pingDeadline) throw error;
      if (spawnError) throw spawnError;
      await sleep(1_000);
    }
  }
  return {
    request,
    waitForTerminal: async (runId: string, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await request<Record<string, unknown>>('run.getSnapshot', {
          run_id: runId,
        });
        const status = optionalString(snapshot.status);
        if (status !== undefined && status !== 'running') return snapshot;
        const exited = await Promise.race([
          closed.then((code) => ({ exited: true as const, code })),
          sleep(250).then(() => ({ exited: false as const, code: null })),
        ]);
        if (exited.exited) {
          throw new Error(
            `backend exited with code ${String(exited.code)} while run ${runId} was running. ` +
              `stderr=${stderrChunks.join('').slice(-4_000)}`,
          );
        }
      }
      throw new Error(`run ${runId} did not reach a terminal state in ${timeoutMs}ms`);
    },
    close: async () => {
      child.stdin.end();
      const result = await Promise.race([closed, sleep(15_000).then(() => 'timeout' as const)]);
      if (result === 'timeout') {
        child.kill('SIGTERM');
        const terminated = await Promise.race([closed, sleep(3_000).then(() => 'timeout' as const)]);
        if (terminated === 'timeout') child.kill('SIGKILL');
        await Promise.race([closed, sleep(3_000)]);
      }
      await stderrHandle.close().catch(() => undefined);
    },
  };
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `[capability] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
