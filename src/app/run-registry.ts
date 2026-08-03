/**
 * RPC 进程内运行注册表。
 *
 * 这个文件负责 run 查询、事件顺序和订阅，不启动 Coordinator，也不做跨进程持久化。
 */
import type { FrontendRunSnapshot } from '../coordinator/frontend-run-snapshot';
import { SCHEMA_VERSION, createId } from '../core';
import { projectRunEventSource, type RunEvent } from '../protocol/run-event';
import type { RunSnapshot } from '../protocol/run-snapshot';

export type AppRunMode = 'single_agent' | 'council';
export type AppRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type AppRunStage = 'executing' | 'council' | 'delivery' | 'intervention';

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
        stage: input.mode === 'council' ? 'council' : 'executing',
        active_node_code: 'N3',
      },
      events: [],
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
      sequence: record.events.length + 1,
      run_id: runId,
      task_id: record.task_id,
      type,
      source: projectRunEventSource(type),
      created_at: identity?.created_at ?? this.now(),
      payload,
      schema_version: SCHEMA_VERSION,
    };
    record.events.push(event);
    record.revision += 1;
    record.current.active_node_code = EVENT_NODE_CODES[type] ?? record.current.active_node_code;
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
    record.events.push(staged.event);
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

  subscribe(runId: string, listener: RunEventListener): () => void {
    const record = this.require(runId);
    record.listeners.add(listener);
    for (const event of record.events) listener(event);
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
      sequence: record.events.length + 1,
      run_id: record.run_id,
      task_id: record.task_id,
      type,
      source: projectRunEventSource(type),
      created_at: this.now(),
      payload,
      schema_version: SCHEMA_VERSION,
    };
  }

  private clone(record: MutableRunRecord): AppRunSnapshot {
    const {
      listeners: _listeners,
      controller: _controller,
      terminalReservation: _terminalReservation,
      ...snapshot
    } = record;
    return {
      ...snapshot,
      current: { ...snapshot.current },
      events: [...snapshot.events],
      ...(snapshot.projected_snapshot
        ? { projected_snapshot: structuredClone(snapshot.projected_snapshot) }
        : {}),
    };
  }
}
