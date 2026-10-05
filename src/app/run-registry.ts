/**
 * RPC 进程内运行注册表。
 *
 * 这个文件负责 run 查询、事件顺序和订阅，不启动 Coordinator，也不做跨进程持久化。
 */
import type { FrontendRunSnapshot } from '../coordinator/frontend-run-snapshot';
import { SCHEMA_VERSION, createId } from '../core';
import type { TaskResumeCursor } from '../persistence';
import { projectRunEventSource, type RunEvent } from '../protocol/run-event';
import type { RunSnapshot } from '../protocol/run-snapshot';
import { isStreamFragment } from './driver-stream-projection';
import {
  nodeCodeForCursor,
  readCursorFromPayload,
  stageForCursor,
  type AppRunStage,
} from './run-stage-mapping';

export type AppRunMode = 'single_agent' | 'council';
export type AppRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type { AppRunStage };

export type AppRunEvent = RunEvent;

export interface AppRunSnapshot {
  schema_version: 'v0';
  revision: number;
  run_id: string;
  task_id: string;
  status: AppRunStatus;
  mode: AppRunMode;
  current: {
    stage: AppRunStage;
    active_node_code: string;
    /** 真实持久游标；`stage` 是它的粗粒度映射。存活期由 `handler.*` 事件推进。 */
    cursor?: TaskResumeCursor;
    /** 正在执行的 stage 调用；缺席表示此刻没有调用在跑（不编空串）。 */
    invocation_id?: string;
    /** 该 stage 调用的开始时间，与 `invocation_id` 同生共死。 */
    stage_started_at?: string;
  };
  events: AppRunEvent[];
  snapshot?: FrontendRunSnapshot;
  projected_snapshot?: RunSnapshot;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} was not found`);
    this.name = 'RunNotFoundError';
  }
}

type RunEventListener = (event: AppRunEvent) => void;

interface MutableRunRecord extends AppRunSnapshot {
  listeners: Set<RunEventListener>;
  controller?: AbortController;
  terminalReservation?: string;
  /**
   * **片段**（`isStreamFragment`）的有界保留：按 `role_id` 分桶的环形缓冲。
   *
   * 为什么必须按 role 分而不是全局一个环形：council 一次并发多个席位，全局环会被**话多的
   * 席位**把**安静席位**的最后一条片段挤掉，于是安静席位的 `last_event_at` 回退到更早的
   * 协调事件上——一个 5 秒前还在流片段的席位会被报成「60 秒没动静」。按 role 分桶之后，
   * 安静席位没有新片段，就永远不会被挤掉。
   *
   * 留在里面的用途只有一个：存活期折叠（`listRetainedEvents`）要的活性与最后一次工具更新。
   * 片段不进 `events`，所以也不会进快照 timeline / `result.json` / `frontend-snapshot.json`
   * ——那几份曾经因为携带全量片段而各到 13–18 MB（实测）。完整记录在 `audit.jsonl`。
   */
  streamFragments: Map<string, AppRunEvent[]>;
  /** 已分配出去的序号数。见 `InMemoryRunRegistry.nextSequence`。 */
  nextSequence: number;
}

/**
 * 每个 role 保留多少条片段。
 *
 * 32 是「足够折叠、远小于会心疼」的量级：一次工具调用期间的片段密度约为每几十毫秒一条，
 * 32 条足以覆盖最近几秒的活性判断；而一个角色的 32 条片段即使按上限 8 KB 算也只有 256 KB。
 */
const RETAINED_FRAGMENTS_PER_ROLE = 32;

/** 按通道分流：片段进有界环，其余进 `events`。 */
function retainEvent(record: MutableRunRecord, event: AppRunEvent): void {
  if (!isStreamFragment(event.type)) {
    record.events.push(event);
    return;
  }
  const roleId = typeof event.payload.role_id === 'string' ? event.payload.role_id : '';
  const retained = record.streamFragments.get(roleId);
  if (!retained) {
    record.streamFragments.set(roleId, [event]);
    return;
  }
  retained.push(event);
  if (retained.length > RETAINED_FRAGMENTS_PER_ROLE) retained.shift();
}

function mergeRetained(record: MutableRunRecord): AppRunEvent[] {
  const fragments = [...record.streamFragments.values()].flat();
  if (fragments.length === 0) return [...record.events];
  // 两个来源各自有序，但片段的时间戳会跨过协调事件，所以拼接后必须按序号重排。
  return [...record.events, ...fragments].sort((left, right) => left.sequence - right.sequence);
}

export interface StagedTerminalTransition {
  token: string;
  event: AppRunEvent;
  snapshot: AppRunSnapshot;
}

export interface RunCancellationReason {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

const EVENT_NODE_CODES: Readonly<Record<string, string>> = {
  'task.created': 'N2',
  'run.started': 'N3',
  'memory.context_pack_built': 'N5',
  'driver.run_result': 'N8',
  'artifact.registered': 'N9',
  'task.completed': 'N10',
  'gate.result': 'N13',
  'council.started': 'N14',
  'council.decision': 'N14',
  'checkpoint.saved': 'N16',
  'run.completed': 'N18',
  'run.failed': 'N18',
};

/**
 * 用一条事件推进存活期 `current`。
 *
 * `handler.started` / `handler.completed` 的载荷里带着真实游标与 invocation id
 * （写入点：`TaskProcessor.startStage` / `advanceStageOnce`），而
 * `NewideBackendService.mirrorTaskAuthorityEvent` 会把载荷原样透传进来。所以存活中的 run
 * 也能给出与持久投影一致的真实游标，而不是停在创建时那个值——这正是两条投影路径过去
 * 对同一个 run 的 `stage` 说法不一致的根因。
 */
function applyEventToCurrent(record: MutableRunRecord, event: AppRunEvent): void {
  const startedCursor =
    event.type === 'handler.started' ? readCursorFromPayload(event.payload.cursor) : undefined;
  const advancedCursor =
    event.type === 'handler.completed'
      ? readCursorFromPayload(event.payload.next_cursor)
      : undefined;
  const cursor = startedCursor ?? advancedCursor;

  if (startedCursor) {
    const invocationId = nonEmptyString(event.payload.invocation_id);
    if (invocationId) {
      record.current.invocation_id = invocationId;
      record.current.stage_started_at = event.created_at;
    }
  }
  if (advancedCursor) {
    // 与 `advanceStageOnce` 摘掉 active_stage 同义：游标推进即表示没有调用在跑。
    delete record.current.invocation_id;
    delete record.current.stage_started_at;
  }
  if (cursor) {
    record.current.cursor = cursor;
    record.current.stage = stageForCursor(cursor, record.status);
  }
  record.current.active_node_code =
    EVENT_NODE_CODES[event.type] ??
    (cursor ? nodeCodeForCursor(cursor, record.status) : record.current.active_node_code);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class InMemoryRunRegistry {
  private readonly records = new Map<string, MutableRunRecord>();

  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createEventId: () => string = () => createId('run_event'),
  ) {}

  create(input: {
    run_id: string;
    task_id: string;
    mode: AppRunMode;
    controller?: AbortController;
  }): AppRunSnapshot {
    const record: MutableRunRecord = {
      schema_version: 'v0',
      revision: 0,
      ...input,
      status: 'running',
      current: {
        // 新建 run 的持久游标恒为 `select_agent`（`beginRun` 用 `cursor_input.cursor` 初始化），
        // 所以这里从游标推 stage，而不是按 mode 猜——council 模式也是先走 select_agent，
        // 过去按 mode 直接给 'council' 会让存活期与持久投影在 t=0 就不一致。
        // 续跑（resume/restart）的初始游标只有协调层知道，由随后的 `handler.started` 校正。
        stage: stageForCursor('select_agent', 'running'),
        active_node_code: 'N3',
        cursor: 'select_agent',
      },
      events: [],
      streamFragments: new Map(),
      nextSequence: 0,
      listeners: new Set(),
      ...(input.controller ? { controller: input.controller } : {}),
    };
    this.records.set(input.run_id, record);
    return this.clone(record);
  }

  appendEvent(
    runId: string,
    type: string,
    payload: Record<string, unknown>,
    identity?: { event_id?: string; created_at?: string },
  ): AppRunEvent {
    const record = this.require(runId);
    const event: AppRunEvent = {
      event_id: identity?.event_id ?? this.createEventId(),
      sequence: this.nextSequence(record),
      run_id: runId,
      task_id: record.task_id,
      type,
      source: projectRunEventSource(type),
      created_at: identity?.created_at ?? this.now(),
      payload,
      schema_version: SCHEMA_VERSION,
    };
    retainEvent(record, event);
    record.revision += 1;
    applyEventToCurrent(record, event);
    // **投递与保留是两件事**：片段照样投给订阅者（`audit.jsonl` 靠它拿到全量），
    // 只是不在内存里无限留（见 `retainEvent`）。
    for (const listener of record.listeners) listener(event);
    return event;
  }

  complete(runId: string, snapshot?: FrontendRunSnapshot): AppRunSnapshot {
    const record = this.require(runId);
    if (record.events.some((event) => event.type === 'run.completed')) {
      record.status = 'completed';
      record.current = { stage: 'delivery', active_node_code: 'N18' };
      if (snapshot) record.snapshot = snapshot;
      return this.clone(record);
    }
    if (!snapshot) {
      throw new Error(`Run ${runId} cannot complete without terminal event or snapshot`);
    }
    const staged = this.stageTerminal(runId, { status: 'completed', snapshot });
    return staged ? this.commitTerminal(runId, staged) : this.getSnapshot(runId);
  }

  setProjectedSnapshot(runId: string, snapshot: RunSnapshot): AppRunSnapshot {
    const record = this.require(runId);
    if (snapshot.run_id !== runId || snapshot.task_id !== record.task_id) {
      throw new Error(`Projected snapshot identity does not match Run ${runId}`);
    }
    record.projected_snapshot = snapshot;
    return this.clone(record);
  }

  stageTerminal(
    runId: string,
    input:
      | { status: 'completed'; snapshot: FrontendRunSnapshot }
      | {
          status: 'failed';
          code: string;
          message: string;
          details?: Record<string, unknown>;
          snapshot?: FrontendRunSnapshot;
        }
      | { status: 'cancelled'; reason?: RunCancellationReason },
  ): StagedTerminalTransition | undefined {
    const record = this.require(runId);
    if (record.status !== 'running' || record.terminalReservation) return undefined;
    const token = createId('terminal');
    record.terminalReservation = token;
    if (input.status === 'cancelled') record.controller?.abort(new Error('Run cancelled'));
    const type =
      input.status === 'completed'
        ? 'run.completed'
        : input.status === 'failed'
          ? 'run.failed'
          : 'run.cancelled';
    const payload =
      input.status === 'failed'
        ? {
            code: input.code,
            message: input.message,
            ...(input.details ? { details: input.details } : {}),
          }
        : input.status === 'cancelled' && input.reason
          ? {
              status: input.status,
              code: input.reason.code,
              message: input.reason.message,
              ...(input.reason.details ? { details: input.reason.details } : {}),
            }
          : { status: input.status };
    const event = this.buildEvent(record, type, payload);
    const snapshot: AppRunSnapshot = {
      ...this.clone(record),
      revision: record.revision + 1,
      status: input.status,
      current: {
        stage: input.status === 'completed' ? 'delivery' : 'intervention',
        active_node_code: 'N18',
        // 终态与 stage 机一致：所有终结路径都把游标推到 `done`（`finishRun` / `failStage`）。
        cursor: 'done',
      },
      events: [...record.events, event],
      ...((input.status === 'completed' || input.status === 'failed') && input.snapshot
        ? { snapshot: input.snapshot }
        : {}),
      ...(input.status === 'failed'
        ? {
            error: {
              code: input.code,
              message: input.message,
              ...(input.details ? { details: input.details } : {}),
            },
          }
        : {}),
      ...(input.status === 'cancelled' && input.reason
        ? { error: { ...input.reason } }
        : {}),
    };
    return { token, event, snapshot };
  }

  commitTerminal(runId: string, staged: StagedTerminalTransition): AppRunSnapshot {
    const record = this.require(runId);
    if (record.terminalReservation !== staged.token || record.status !== 'running') {
      return this.clone(record);
    }
    record.status = staged.snapshot.status;
    record.current = staged.snapshot.current;
    record.revision = staged.snapshot.revision;
    // 走同一个分流口而不是直接 push：终态事件今天一定不是片段，但「哪条进 events」的
    // 判据只该有一处，否则将来多一个终态事件类型就会绕过它。
    retainEvent(record, staged.event);
    if (staged.snapshot.snapshot) record.snapshot = staged.snapshot.snapshot;
    if (staged.snapshot.error) record.error = staged.snapshot.error;
    delete record.terminalReservation;
    for (const listener of record.listeners) listener(staged.event);
    return this.clone(record);
  }

  abortTerminal(runId: string, token: string): void {
    const record = this.require(runId);
    if (record.terminalReservation === token) delete record.terminalReservation;
  }

  fail(runId: string, code: string, message: string): AppRunSnapshot {
    const record = this.require(runId);
    if (record.status === 'cancelled') return this.clone(record);
    record.status = 'failed';
    record.current = { stage: 'intervention', active_node_code: 'N18' };
    record.error = { code, message };
    this.appendEventOnce(runId, 'run.failed', { code });
    return this.clone(record);
  }

  getSnapshot(runId: string): AppRunSnapshot {
    return this.clone(this.require(runId));
  }

  /**
   * 本进程是否持有该 run。
   *
   * 给需要「有就补挂观测、没有就保持缺席」的调用方用：它们不该靠捕获
   * `RunNotFoundError` 来判断，那会把「没有这个 run」和「别处的错」混成一种。
   */
  has(runId: string): boolean {
    return this.records.has(runId);
  }

  listSnapshots(): AppRunSnapshot[] {
    return [...this.records.values()].map((record) => this.clone(record));
  }

  cancel(runId: string, reason?: RunCancellationReason): AppRunSnapshot {
    const record = this.require(runId);
    if (record.status !== 'running') return this.clone(record);
    const staged = this.stageTerminal(runId, {
      status: 'cancelled',
      ...(reason ? { reason } : {}),
    });
    if (!staged) return this.clone(record);
    return this.commitTerminal(runId, staged);
  }

  /**
   * 订阅某 run 的事件。
   *
   * 注册后先**重放**已有事件再续流，让订阅者不必先拉快照。给了 `after_sequence` 时
   * 只补该序号之后的事件——这是断线重连的水位：缺省（undefined）仍然全量重放，保持
   * 既有行为不变。序号由本 registry 单调分配，所以水位就用在推流这一条通道上自洽。
   */
  subscribe(
    runId: string,
    listener: RunEventListener,
    options: { after_sequence?: number } = {},
  ): () => void {
    const record = this.require(runId);
    record.listeners.add(listener);
    const after = options.after_sequence;
    for (const event of record.events) {
      if (after !== undefined && event.sequence <= after) continue;
      listener(event);
    }
    return () => record.listeners.delete(listener);
  }

  private require(runId: string): MutableRunRecord {
    const record = this.records.get(runId);
    if (!record) throw new RunNotFoundError(runId);
    return record;
  }

  private appendEventOnce(
    runId: string,
    type: string,
    payload: Record<string, unknown>,
  ): AppRunEvent | undefined {
    const record = this.require(runId);
    if (record.events.some((event) => event.type === type)) return undefined;
    return this.appendEvent(runId, type, payload);
  }

  private buildEvent(
    record: MutableRunRecord,
    type: string,
    payload: Record<string, unknown>,
  ): AppRunEvent {
    return {
      event_id: this.createEventId(),
      sequence: this.nextSequence(record),
      run_id: record.run_id,
      task_id: record.task_id,
      type,
      source: projectRunEventSource(type),
      created_at: this.now(),
      payload,
      schema_version: SCHEMA_VERSION,
    };
  }

  /**
   * 取下一个序号。**显式计数器，不再用 `events.length + 1`**：片段不再进 `events`，
   * 数组长度就不再等于「已分配过几个号」——继续用长度会给两个不同事件同一个号，
   * 而 `run.subscribe` 的 `after_sequence` 水位正是建立在这个号上的。
   */
  private nextSequence(record: MutableRunRecord): number {
    record.nextSequence += 1;
    return record.nextSequence;
  }

  /**
   * 保留期内的**全部**事件（协调 + 有界片段），按序号升序。
   *
   * 存活期的状态折叠要用它：`activity.agents[].driver` 的陈旧判断靠片段的
   * `last_event_at`（片段一直在流 = driver 活着），而 `getSnapshot().events` 里只有
   * 协调事件，折叠看不到片段。
   *
   * 顺序在这里统一保证，调用方不必自己排——两个来源拼接后再按 `sequence` 排，是唯一
   * 能同时满足「片段时间更新」与「协调事件按序」的做法。
   */
  listRetainedEvents(runId: string): AppRunEvent[] {
    const record = this.require(runId);
    return mergeRetained(record);
  }

  private clone(record: MutableRunRecord): AppRunSnapshot {
    const {
      listeners: _listeners,
      controller: _controller,
      terminalReservation: _terminalReservation,
      streamFragments: _streamFragments,
      nextSequence: _nextSequence,
      events: _coordinated,
      ...snapshot
    } = record;
    return {
      ...snapshot,
      current: { ...snapshot.current },
      events: [..._coordinated],
      ...(snapshot.projected_snapshot
        ? { projected_snapshot: structuredClone(snapshot.projected_snapshot) }
        : {}),
    };
  }
}
