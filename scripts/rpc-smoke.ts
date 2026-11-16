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
  type ProductionBackendServiceDependencies,
} from '../src/app/backend-rpc-stdio';
import {
  InMemoryBufferRepository,
  InMemoryRepository,
  type LlmClient,
  type ToolCallingClient,
} from '../src/memory';
import type { RunSnapshot } from '../src/protocol/run-snapshot';
import type { RunEvent } from '../src/protocol/run-event';
import { writeFakeAcpRunnerBuild } from '../test/fixtures/fake-acp-runner-build';
import {
  assertRoleSmokeDispatchTermination,
  assertRoleSmokeSummaryFile,
  buildRoleSmokeEnv,
  buildRoleSmokeSample,
  createRoleSmokeLlm,
  ROLE_SMOKE_DISPATCH_BUDGET,
  ROLE_SMOKE_RUN_FILES,
  ROLE_SMOKE_SAMPLE_KEY,
} from '../test/fixtures/role-autonomy-smoke';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** `run.getEvents` 的响应形状（与 src/app 的 RunEventsResult 对齐，脚本内不引内部类型）。 */
interface RunEventsPage {
  events: RunEvent[];
  after_sequence: number;
  latest_sequence: number;
  has_more: boolean;
}

type SmokeMode = 'single_agent' | 'council' | 'all';

const smokeMode = readSmokeMode(process.argv.slice(2));
const workspacePath = path.resolve(process.env.RPC_SMOKE_WORKSPACE ?? process.cwd());

const configuredRunnerDir = process.env.RPC_SMOKE_ACP_RUNNER_DIR;
const usesTemporaryRunner = configuredRunnerDir === undefined;
const runnerDir = configuredRunnerDir
  ? path.resolve(configuredRunnerDir)
  : await createFakeAcpRunner();
const stateRoot = usesTemporaryRunner
  ? path.join(runnerDir, 'state')
  : path.resolve(process.env.NEWIDE_STATE_ROOT?.trim() || path.join(process.cwd(), '.newide'));
const backendEnv = usesTemporaryRunner
  ? {
      ...process.env,
      ACP_DRIVER_RUNNER_DIR: runnerDir,
      NEWIDE_STATE_ROOT: stateRoot,
    }
  : { ...process.env, ACP_DRIVER_RUNNER_DIR: runnerDir };
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
      backendEnv,
      {
        agentLlm: invokeDriverLlm(),
        memoryLlm: deterministicMaintenanceLlm(),
        bRuntime: inMemoryBRuntime(
          process.env.NEWIDE_B_APP_STATE_ROOT ?? path.join(stateRoot, 'b'),
        ),
      },
    ),
  });
  backendInput = input;
  backendOutput = localOutput;
} else {
  // 直接起 node，不走 `pnpm backend:rpc`：Windows 上 `spawn('pnpm')` 是 **ENOENT**
  // （`pnpm` 是 .cmd 垫片，不经 shell 起不来）——指定 `RPC_SMOKE_ACP_RUNNER_DIR` 走外部
  // runner 的那条路因此在 Windows 上根本起不了后端。与 `src/app/backend-rpc-stdio.ts`
  // 起 driver 时同一条约定：调 node，别调包管理器。
  child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join('src', 'app', 'backend-rpc-entry.ts')],
    {
      cwd: process.cwd(),
      env: backendEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
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
const generatedFiles: string[] = [];
// 联调用样例报文：一次 smoke 里抓真实 JSON，前端照着比对，比口头描述省事。
const samples: Record<string, unknown> = {};
let backendExitError: Error | undefined;

try {
  const single = smokeMode === 'council' ? undefined : await runAndVerify('single_agent');
  const council = smokeMode === 'single_agent' ? undefined : await runAndVerify('council');
  const cancelled = smokeMode === 'all' ? await createAndCancel() : undefined;
  if (cancelled) await waitForCancellationEffects();
  const driverInvocations = usesTemporaryRunner ? await countDriverInvocations() : undefined;
  if (driverInvocations !== undefined) {
    // Plan-first reuses Primary's initial plan as proposer 0 and each Council
    // role creates its ACP Session on the real task turn instead of a warm-up.
    const expectedInvocations = smokeMode === 'all' ? 7 : smokeMode === 'single_agent' ? 2 : 5;
    assert(
      driverInvocations === expectedInvocations,
      `Expected ${expectedInvocations} driver invocations, received ${driverInvocations}`,
    );
  }
  // 阶段 4：独立场景——**第二个后端实例**（role autonomy，dispatch 预算收紧到 2）跑一次
  // 全新 single_agent Run，检查「派工进度 + 终止原因」能从 run.getSnapshot / run.getEvents
  // 读到、且落盘 summary.json 同源。
  // 只在默认 all 模式跑一次：`--mode single_agent/council` 是各自模式的独立快跑用例，
  // 不该为这个场景多付一个后端实例的启动成本。
  // 外部 runner 模式不跑：该场景的「恰好 2 次 driver 调用」依赖确定性临时 fake runner，
  // 外部真 driver 的调用次数没有这个语义，如实标记 skipped 而不是假装通过。
  const roleAutonomy =
    smokeMode !== 'all'
      ? {
          skipped: true,
          reason: `--mode ${smokeMode}: the role-autonomy scenario runs once in the default all mode`,
        }
      : usesTemporaryRunner
        ? await runRoleAutonomyTerminationScenario()
        : {
            skipped: true,
            reason:
              'external ACP runner mode (RPC_SMOKE_ACP_RUNNER_DIR set): the scenario needs the deterministic temporary fake runner to assert the exact driver invocation count',
          };
  const parseError =
    smokeMode === 'all' ? await sendRaw('not-json\n', (message) => message.id === null) : undefined;
  if (parseError) {
    assert(parseError.error?.code === -32700, 'Malformed JSON did not return parse error');
  }
  const unknown = smokeMode === 'all' ? await requestRaw('unknown.method', {}) : undefined;
  if (unknown) assert(unknown.error?.code === -32601, 'Unknown method did not return -32601');

  // driver.* 注册面：`driver.getConfig` 是只读的，直接调用验证返回形状；
  // update/reset 用**空参数**探测——参数非法返回 -32602 就证明方法已注册，且不会写任何文件
  // （冒烟脚本跑在真实仓库上，绝不能在这里改 routing）。
  const driverConfig = smokeMode === 'all' ? await requestRaw('driver.getConfig', {}) : undefined;
  if (driverConfig) {
    assert(driverConfig.error === undefined, `driver.getConfig failed: ${JSON.stringify(driverConfig.error)}`);
  }
  const driverUpdateProbe =
    smokeMode === 'all' ? await requestRaw('driver.updateRouting', {}) : undefined;
  if (driverUpdateProbe) {
    assert(
      driverUpdateProbe.error?.code === -32602,
      'driver.updateRouting is not registered or did not reject empty params',
    );
  }
  const driverResetProbe =
    smokeMode === 'all' ? await requestRaw('driver.resetRouting', {}) : undefined;
  if (driverResetProbe) {
    assert(
      driverResetProbe.error?.code === -32602,
      'driver.resetRouting is not registered or did not reject empty params',
    );
  }
  if (driverConfig?.result !== undefined) {
    samples.driver_get_config = {
      request: { method: 'driver.getConfig', params: {} },
      result: driverConfig.result,
    };
  }

  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      runtime,
      mode: smokeMode,
      ...(single ? { single_agent: single } : {}),
      ...(council ? { council } : {}),
      ...(driverInvocations === undefined ? {} : { driver_invocations: driverInvocations }),
      ...(cancelled ? { cancelled } : {}),
      role_autonomy: roleAutonomy,
      ...(parseError ? { malformed_json_error: parseError.error?.code } : {}),
      ...(unknown ? { unknown_method_error: unknown.error?.code } : {}),
      ...(driverConfig?.result === undefined ? {} : { driver_config: driverConfig.result }),
      ...(driverUpdateProbe ? { driver_update_invalid_params: driverUpdateProbe.error?.code } : {}),
      ...(driverResetProbe ? { driver_reset_invalid_params: driverResetProbe.error?.code } : {}),
    })}\n`,
  );
  const samplesPath = process.env.RPC_SMOKE_SAMPLES_PATH?.trim();
  if (samplesPath) {
    await fs.writeFile(samplesPath, `${JSON.stringify(samples, null, 2)}\n`, 'utf8');
  }
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
      ...runIds.map((runId) =>
        fs.rm(path.join(stateRoot, 'runs', runId), { recursive: true, force: true }),
      ),
      ...taskIds.map((taskId) =>
        fs.rm(path.join(stateRoot, 'worktrees', taskId), { recursive: true, force: true }),
      ),
      ...(usesTemporaryRunner
        ? generatedFiles.map((file) => fs.rm(file, { force: true }))
        : []),
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
  assert(snapshot.gates.length === 0, `${mode} fabricated Gate evidence`);
  assert(snapshot.quality?.status === 'completed', `${mode} output was not finalized`);
  assert(snapshot.final_output?.status === 'completed', `${mode} final output is incomplete`);
  if (usesTemporaryRunner) {
    generatedFiles.push(...snapshot.final_output.files_written);
  }
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
    const eventTypes = snapshot.timeline.map((event) => event.type);
    const councilCompleted = eventTypes.indexOf('council.completed');
    const artifactSelected = eventTypes.indexOf('artifact.selected');
    const materializedEvent = eventTypes.indexOf('worktree.materialized');
    assert(
      [councilCompleted, artifactSelected, materializedEvent].every((index) => index >= 0),
      'Council finalization events are incomplete',
    );
    assert(
      councilCompleted < artifactSelected &&
        artifactSelected < materializedEvent,
      'Council finalization event order is invalid',
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
  // run.getEvents —— 订阅的拉取孪生口：整份拉取必须与快照 timeline **同源**，增量拉取必须
  // 严格按 `after_sequence` 水位切开。只读终态 run，两条通道的号在这条路上同源。
  const events = await request<RunEventsPage>('run.getEvents', { run_id: created.run_id });
  assert(
    events.events.length === snapshot.timeline.length,
    `${mode} getEvents full pull lost events (${events.events.length} vs ${snapshot.timeline.length})`,
  );
  assert(
    events.events.every(
      (event, index) => snapshot.timeline[index]?.event_id === event.event_id,
    ),
    `${mode} getEvents full pull diverged from the snapshot timeline`,
  );
  assert(
    events.latest_sequence === events.events.at(-1)?.sequence,
    `${mode} getEvents latest_sequence does not match the last event`,
  );
  const midWatermark = events.events.at(-1)?.sequence ?? 0;
  const tail = await request<RunEventsPage>('run.getEvents', {
    run_id: created.run_id,
    after_sequence: midWatermark,
  });
  assert(
    tail.events.length === 0 && tail.has_more === false,
    `${mode} getEvents past the latest watermark must be empty`,
  );
  if (events.events.length > 2) {
    const splitWatermark = events.events[Math.floor(events.events.length / 2)]?.sequence ?? 0;
    const incremental = await request<RunEventsPage>('run.getEvents', {
      run_id: created.run_id,
      after_sequence: splitWatermark,
    });
    assert(
      incremental.events.every((event) => event.sequence > splitWatermark) &&
        incremental.events.length < events.events.length,
      `${mode} getEvents incremental pull ignored the after_sequence watermark`,
    );
  }
  const usage = await request<{ usage?: unknown; history: unknown }>('run.getUsage', {
    scope: 'task',
    scope_id: created.task_id,
    run_id: created.run_id,
  });
  assert(usage.history !== undefined, `${mode} run.getUsage returned no history`);
  if (Object.keys(samples).length === 0) {
    const firstDriverEvent = events.events.find((event) => event.type.startsWith('driver.'));
    samples.get_events = {
      request: { method: 'run.getEvents', params: { run_id: created.run_id, after_sequence: 0 } },
      result: {
        events: (
          firstDriverEvent ? [firstDriverEvent, ...events.events.slice(1, 3)] : events.events.slice(0, 3)
        ).map((event) => ({
          event_id: event.event_id,
          sequence: event.sequence,
          type: event.type,
          source: event.source,
          payload_keys: Object.keys(event.payload),
          ...(event.payload.payload_ref ? { payload_ref: event.payload.payload_ref } : {}),
        })),
        after_sequence: events.after_sequence,
        latest_sequence: events.latest_sequence,
        has_more: events.has_more,
      },
    };
    samples.get_usage = {
      request: {
        method: 'run.getUsage',
        params: { scope: 'task', scope_id: created.task_id, run_id: created.run_id },
      },
      result: usage,
    };
    const completion = messages.find(
      (message) =>
        message.method === 'run.event' &&
        (message.params as { run_id?: string }).run_id === created.run_id &&
        (message.params as { event?: { type?: string } }).event?.type === 'run.completed',
    );
    if (completion) samples.run_event = completion;
  }
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

/**
 * 阶段 4 场景：在新的（第二个）生产后端实例里跑一次 role 自主循环 Run，验证
 * 「派工进度（dispatch_summary / dispatch_progress）+ 终止原因（typed termination）」
 * 既能在存活期快照/事件里读到，也落进了终态落盘文件。
 *
 * 为什么必须第二个实例：主实例的 env 没有 `NEWIDE_ROLE_AUTONOMY=1`/收紧的 dispatch 预算，
 * 而且它的 fake LLM 只会调 `invoke_driver`（legacy 路径）。两个实例各自独立 stateRoot，
 * 互不影响；本场景结束时关闭第二个服务，把状态目录留给脚本统一的清理逻辑。
 *
 * 确定性：role LLM 在工具表里出现 `dispatch_execution` 时连续返回派工；第 3 次在
 * `assertDispatchAllowed` 抛 `budget_dispatches`，**不会**产生第 3 次 driver 调用。
 */
async function runRoleAutonomyTerminationScenario(): Promise<Record<string, unknown>> {
  const roleStateRoot = path.join(stateRoot, 'role-autonomy-smoke');
  const roleEnv = buildRoleSmokeEnv({
    base: backendEnv,
    state_root: roleStateRoot,
    runner_dir: runnerDir,
  });
  const channel = createInProcessChannel();
  const server = startBackendRpcServer({
    input: channel.input,
    writeLine: (line) => channel.output.write(`${line}\n`),
    service: await createProductionBackendService(roleEnv, {
      // 同一份客户端被 role 引擎与 legacy 路径共用：role 工具表出现时走确定性派工，
      // 否则原样回退 invokeDriverLlm（本场景不会走，但避免两个客户端各说一套）。
      agentLlm: createRoleSmokeLlm(invokeDriverLlm()),
      memoryLlm: deterministicMaintenanceLlm(),
      bRuntime: inMemoryBRuntime(path.join(roleStateRoot, 'b')),
    }),
  });
  const prompt = 'RPC smoke role autonomy dispatch budget';
  const invocationsBefore = await countDriverInvocations();
  try {
    const created = await requestOnChannel<{
      run_id: string;
      task_id: string;
      status: 'running';
    }>(channel, 'run.create', { prompt, mode: 'single_agent', workspace_path: workspacePath });
    await requestOnChannel(channel, 'run.subscribe', { run_id: created.run_id });
    const snapshot = await waitForTerminalOnChannel(channel, created.run_id);
    // 全量拉取：事件计数的断言读的是持久事件，不是内存通知。
    const events = await requestOnChannel<RunEventsPage>(channel, 'run.getEvents', {
      run_id: created.run_id,
    });
    const facts = assertRoleSmokeDispatchTermination({ snapshot, events: events.events });
    const invocationsAfter = await countDriverInvocations();
    assert(
      invocationsAfter - invocationsBefore === ROLE_SMOKE_DISPATCH_BUDGET,
      `Role autonomy smoke: expected exactly ${String(ROLE_SMOKE_DISPATCH_BUDGET)} driver invocations, received ${String(
        invocationsAfter - invocationsBefore,
      )} (no automatic replay/retry is allowed)`,
    );
    await assertRunFilesIn(roleStateRoot, created.run_id, ROLE_SMOKE_RUN_FILES);
    const summaryPath = path.join(roleStateRoot, 'runs', created.run_id, 'summary.json');
    assertRoleSmokeSummaryFile(await waitForRunJson(summaryPath));
    samples[ROLE_SMOKE_SAMPLE_KEY] = buildRoleSmokeSample({
      run_id: created.run_id,
      prompt,
      snapshot,
      events: events.events,
      facts,
    });
    return {
      run_id: created.run_id,
      status: snapshot.status,
      error_code: facts.termination_code,
      termination_actor: facts.termination_actor,
      dispatch_total: facts.summary.total,
      dispatch_by_status: facts.summary.by_status,
      dispatch_ids: facts.dispatch_ids,
      last_dispatch_id: facts.summary.last_dispatch_id,
      event_counts: facts.event_counts,
      driver_invocations: invocationsAfter - invocationsBefore,
      summary_path: summaryPath,
    };
  } finally {
    // 关闭第二个后端（含它自己的服务与资源）；失败不掩盖场景本身的断言错误。
    await server.close().catch(() => undefined);
  }
}

/** 独立后端实例的 RPC 通道：与主后端完全隔离的消息/请求 id/等待者。 */
interface InProcessRpcChannel {
  input: PassThrough;
  output: PassThrough;
  messages: JsonRpcMessage[];
  waiters: Set<{
    predicate: (message: JsonRpcMessage) => boolean;
    resolve: (message: JsonRpcMessage) => void;
  }>;
  nextId: number;
}

function createInProcessChannel(): InProcessRpcChannel {
  const channel: InProcessRpcChannel = {
    input: new PassThrough(),
    output: new PassThrough(),
    messages: [],
    waiters: new Set(),
    nextId: 1,
  };
  createInterface({ input: channel.output }).on('line', (line) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    channel.messages.push(message);
    for (const waiter of channel.waiters) {
      if (!waiter.predicate(message)) continue;
      channel.waiters.delete(waiter);
      waiter.resolve(message);
    }
  });
  return channel;
}

async function requestOnChannel<T = unknown>(
  channel: InProcessRpcChannel,
  method: string,
  params: unknown,
): Promise<T> {
  const id = channel.nextId++;
  const waiting = waitForChannelMessage(channel, (message) => message.id === id);
  channel.input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const response = await waiting;
  if (response.error)
    throw new Error(`${method}: ${response.error.code} ${response.error.message}`);
  return response.result as T;
}

function waitForChannelMessage(
  channel: InProcessRpcChannel,
  predicate: (message: JsonRpcMessage) => boolean,
): Promise<JsonRpcMessage> {
  const existing = channel.messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve };
    channel.waiters.add(waiter);
    setTimeout(() => {
      if (!channel.waiters.delete(waiter)) return;
      reject(new Error('Timed out waiting for the role-autonomy backend message'));
    }, 15_000).unref();
  });
}

async function waitForTerminalOnChannel(
  channel: InProcessRpcChannel,
  runId: string,
): Promise<RunSnapshot> {
  const deadline = Date.now() + readTimeoutMs();
  while (Date.now() < deadline) {
    const snapshot = await requestOnChannel<RunSnapshot>(channel, 'run.getSnapshot', {
      run_id: runId,
    });
    if (snapshot.status !== 'running') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Role autonomy run ${runId} did not reach a terminal state`);
}

/** 轮询读取 run 目录里的 JSON（终态落盘与状态提交之间存在毫秒级窗口）。 */
async function waitForRunJson(filePath: string): Promise<unknown> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Role autonomy smoke: ${filePath} is not readable: ${String(lastError)}`);
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

/**
 * 校验真实外部 runner 模式产出的贪吃蛇文件。
 *
 * 阶段 5 修复：`RunSnapshot.artifacts` 的协议是 `z.array(recordSchema)`，快照投影只保证
 * `{artifact_id}`（交付文件的路径不在里面），旧断言从 `artifacts[].source_path/metadata.path`
 * 取路径，在外部 runner 模式下**永远**找不到文件——之前的情况不是 driver 没交付，而是断言读错
 * 了字段。这里按交付事实的来源取路径：`delivery_report.files_written`（materialization 写入的
 * 绝对路径）→ `final_output.files_written`（旧字段回退）→ `artifacts` 里若真带路径再用。
 */
async function validateSnakeArtifact(
  snapshot: RunSnapshot,
  expectedFilename: string,
): Promise<string> {
  const candidates = [
    ...snapshot.delivery_report.files_written,
    ...snapshot.final_output.files_written,
    ...snapshot.artifacts.map((artifact) => artifact.source_path ?? artifact.metadata?.path),
  ];
  const sourceFile = candidates.find(
    (artifactPath): artifactPath is string =>
      typeof artifactPath === 'string' && path.basename(artifactPath) === expectedFilename,
  );
  assert(sourceFile, `No delivered file points to ${expectedFilename}`);
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
  await assertRunFilesIn(
    stateRoot,
    runId,
    ['audit.jsonl', 'result.json', 'frontend-snapshot.json'],
    5_000,
  );
}

/** 轮询等待指定 stateRoot 下该 run 的落盘文件全部出现；超时后逐个 access 让错误指到缺的那个。 */
async function assertRunFilesIn(
  root: string,
  runId: string,
  fileNames: readonly string[],
  timeoutMs = 5_000,
): Promise<void> {
  const files = fileNames.map((name) => path.join(root, 'runs', runId, name));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = await Promise.all(
      files.map((file) =>
        fs.access(file).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (visible.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await Promise.all(files.map((file) => fs.access(file)));
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

/**
 * 冒烟脚本注入的内存 B runtime（两个 backend 实例共用同一形状）。
 *
 * 生产组合根的类型要求 `deliveryRepository` / `embedding_info`，但冒烟路径只消费
 * `repository` / `bufferRepository` / `app_state_root`（delivery 只在 mailbox 流里用，
 * 脚本不走；embedding 缺省即降级检索）。既有装配就是这么传这份子集，这里集中成一个
 * helper 并把「类型上更宽、运行时只用子集」这件事写在注释里，避免第二份同样的形状手抄。
 */
function inMemoryBRuntime(
  appStateRoot: string,
): NonNullable<ProductionBackendServiceDependencies['bRuntime']> {
  return {
    repository: new InMemoryRepository(),
    bufferRepository: new InMemoryBufferRepository(),
    app_state_root: appStateRoot,
    market_agent_ids: ['role_fullstack_engineer', 'role_ts_engineer'],
    close: async () => undefined,
  } as unknown as NonNullable<ProductionBackendServiceDependencies['bRuntime']>;
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
      `import { appendFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
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
  // 评审的契约产物是角色工作区根目录里的 reviews.json：只出现在回复里不算交付
  // （议会取不到评审会让这次 run 失败）。
  if (input.prompt.includes('Review the isolated proposal inputs') && input.workspace_path) {
    writeFileSync(join(input.workspace_path, 'reviews.json'), JSON.stringify({ reviews: [...new Set(input.prompt.match(/proposal_[a-z0-9-]+/g) || [])].map(id => ({ proposal_id: id, verdict: 'approve', reason: 'Reviewed staged evidence.', unmet_criteria: [], evidence_refs: [] })) }));
  }
  const writeResult = () => process.stdout.write(JSON.stringify({
    driver_run_result_id: 'driver_result_' + suffix,
    response: 'Done.',
    session_id: input.session_id || 'session_' + suffix,
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
    writeFakeAcpRunnerBuild(directory, { importFromRunnerRoot: 'fake-driver.mjs' });
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
