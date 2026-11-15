/**
 * 阶段 4：落盘回读投影（`projectPersistedRunSnapshot`）的派工进度口径。
 *
 * 断言与存活期投影器**同一份折叠结果**：同一批事件在「live 快照」与「重启后从 SQLite 事件
 * 回读」两条路径上给出相同的 dispatch_summary / dispatch_progress；旧快照（没有新字段）
 * 仍可被 schema 读取；继承派工与当前派工分开计数。
 */
import { describe, expect, it } from 'vitest';
import { projectPersistedRunSnapshot } from '../../src/app/task-run-snapshot-projector';
import type { PersistedTaskAggregate } from '../../src/persistence';
import { projectRunSnapshot } from '../../src/app/run-snapshot-projector';
import type { AppRunSnapshot } from '../../src/app/run-registry';
import { runSnapshotSchema } from '../../src/protocol/run-snapshot';
import { ROLE_DISPATCH_EVENT } from '../../src/app/run-dispatch-events';
import {
  buildExecutionBrief,
  DispatchRecordSchema,
  DISPATCH_RECORD_SCHEMA_VERSION,
  hashExecutionBrief,
  type DispatchRecord,
} from '../../src/driver';

const NOW = '2026-11-15T00:00:00.000Z';

function persistedEvent(
  sequence: number,
  eventType: string,
  payload: Record<string, unknown>,
  runId = 'run_child',
) {
  return {
    event_id: `event_${String(sequence)}`,
    sequence,
    run_id: runId,
    task_id: 'task_1',
    event_type: eventType,
    subject_id: runId,
    payload,
    created_at: new Date(Date.parse(NOW) + sequence * 1_000).toISOString(),
    schema_version: 'v0',
  };
}

function baseAggregate(
  events: PersistedTaskAggregate['events'],
  runId = 'run_child',
): PersistedTaskAggregate {
  return {
    task: {
      task_id: 'task_1',
      status: 'completed',
      risk_level: 'low',
      spec: 'implement the task',
      completion_criteria: ['works'],
      affected_paths: [],
      workspace_path: '/workspace',
      warnings: [],
      revision: 1,
      created_at: NOW,
      updated_at: NOW,
      schema_version: 'v0',
    },
    runs: [
      {
        run_id: runId,
        task_id: 'task_1',
        status: 'completed',
        mode: 'single_agent',
        workspace_path: '/workspace',
        revision: 1,
        created_at: NOW,
        updated_at: NOW,
        schema_version: 'v0',
      },
    ],
    runtime_state: {
      task_id: 'task_1',
      resume_cursor: 'done',
      waiting_on: [],
      artifact_refs: [],
      diagnostics: {},
      updated_at: NOW,
      schema_version: 'v0',
    },
    events,
  };
}

const DISPATCH_EVENTS = [
  persistedEvent(1, 'handler.started', { cursor: 'execute_agent' }, 'run_child'),
  persistedEvent(2, ROLE_DISPATCH_EVENT.accepted, {
    dispatch_id: 'dsp_1',
    kind: 'execute',
    read_only: false,
    session_mode: 'fresh',
    sequence: 1,
  }),
  persistedEvent(3, ROLE_DISPATCH_EVENT.started, { dispatch_id: 'dsp_1', kind: 'execute' }),
  persistedEvent(4, ROLE_DISPATCH_EVENT.settled, {
    dispatch_id: 'dsp_1',
    kind: 'execute',
    status: 'succeeded',
    violations: [],
    evidence_ref: { path: 'journal/evidence/dsp_1.json', sha256: 'a'.repeat(64) },
  }),
  persistedEvent(5, ROLE_DISPATCH_EVENT.inherited, {
    source_run_id: 'run_parent',
    dispatch_count: 2,
    by_status: { succeeded: 1, unknown: 1 },
    unresolved_dispatch_ids: ['dsp_parent_unknown'],
    violations: { count: 0, kinds: [] },
  }),
  persistedEvent(6, 'run.completed', { status: 'completed' }),
];

describe('projectPersistedRunSnapshot dispatch projection', () => {
  it('projects dispatch summary/progress from persisted events and parses as a valid snapshot', () => {
    const projected = projectPersistedRunSnapshot(baseAggregate(DISPATCH_EVENTS), 'run_child', '/runs');

    expect(projected.dispatch_summary).toMatchObject({
      total: 1,
      by_status: { succeeded: 1 },
      unknown: { count: 0 },
      violations: { count: 0 },
      last_dispatch: { dispatch_id: 'dsp_1', kind: 'execute', status: 'succeeded' },
      inherited: {
        total: 2,
        by_status: { succeeded: 1, unknown: 1 },
        source_run_ids: ['run_parent'],
        unresolved_dispatch_ids: ['dsp_parent_unknown'],
      },
    });
    // 当前 Run 的 total 不含继承：继承单独成块，长恢复链不会把数字越滚越大。
    expect(projected.dispatch_summary?.total).toBe(1);
    // 终态 Run 不报在飞派工。
    expect(projected.dispatch_progress?.current).toBeUndefined();
    expect(() => runSnapshotSchema.parse(projected)).not.toThrow();
  });

  it('gives the live projector the same dispatch口径 for the same events', () => {
    const persisted = projectPersistedRunSnapshot(
      baseAggregate(DISPATCH_EVENTS),
      'run_child',
      '/runs',
    );
    const live: AppRunSnapshot = {
      schema_version: 'v0',
      revision: 1,
      run_id: 'run_child',
      task_id: 'task_1',
      status: 'completed',
      mode: 'single_agent',
      current: { stage: 'delivery', active_node_code: 'N18' },
      events: DISPATCH_EVENTS.map((event) => ({
        event_id: event.event_id,
        sequence: event.sequence,
        run_id: event.run_id,
        task_id: event.task_id,
        type: event.event_type,
        source: 'agent' as const,
        created_at: event.created_at,
        payload: event.payload,
        schema_version: event.schema_version,
      })),
    };
    const liveProjection = projectRunSnapshot(live);

    expect(liveProjection.dispatch_summary).toEqual(persisted.dispatch_summary);
    expect(liveProjection.dispatch_progress).toEqual(persisted.dispatch_progress);
  });

  it('keeps a legacy run readable: no dispatch facts means the fields stay absent', () => {
    const projected = projectPersistedRunSnapshot(
      baseAggregate([
        persistedEvent(1, 'handler.started', { cursor: 'execute_agent' }),
        persistedEvent(2, 'agent.execution_completed', { role_id: 'role_ts_engineer' }),
        persistedEvent(3, 'run.completed', { status: 'completed' }),
      ]),
      'run_child',
      '/runs',
    );

    expect(projected.dispatch_summary).toBeUndefined();
    expect(projected.dispatch_progress).toBeUndefined();
    expect(() => runSnapshotSchema.parse(projected)).not.toThrow();
  });

  it('does not double count a replayed dispatch event set', () => {
    const projected = projectPersistedRunSnapshot(
      baseAggregate([...DISPATCH_EVENTS, ...DISPATCH_EVENTS]),
      'run_child',
      '/runs',
    );
    expect(projected.dispatch_summary?.total).toBe(1);
    expect(projected.dispatch_summary?.by_status).toEqual({ succeeded: 1 });
  });

  it('R4-01: merges Journal records so persisted readback recovers a missing settled event', () => {
    const journalRecord = settledRecord('dsp_1', 'succeeded');
    // 事件里只有 accepted/started（settled 事件出口失败）；纯事件投影停在 unknown。
    const eventsWithoutSettled = DISPATCH_EVENTS.filter(
      (event) => event.event_type !== ROLE_DISPATCH_EVENT.settled,
    );

    const withoutJournal = projectPersistedRunSnapshot(
      baseAggregate(eventsWithoutSettled),
      'run_child',
      '/runs',
    );
    expect(withoutJournal.dispatch_summary?.by_status).toEqual({ unknown: 1 });

    const persisted = projectPersistedRunSnapshot(
      baseAggregate(eventsWithoutSettled),
      'run_child',
      '/runs',
      [journalRecord],
    );
    expect(persisted.dispatch_summary).toMatchObject({
      total: 1,
      by_status: { succeeded: 1 },
      unknown: { count: 0 },
      last_dispatch: { dispatch_id: 'dsp_1', status: 'succeeded' },
    });
    expect(() => runSnapshotSchema.parse(persisted)).not.toThrow();

    // 同一个事实解释：存活期投影器传入同一批 Journal 记录后与本投影器一致。
    const live: AppRunSnapshot = {
      schema_version: 'v0',
      revision: 1,
      run_id: 'run_child',
      task_id: 'task_1',
      status: 'completed',
      mode: 'single_agent',
      current: { stage: 'delivery', active_node_code: 'N18' },
      events: eventsWithoutSettled.map((event) => ({
        event_id: event.event_id,
        sequence: event.sequence,
        run_id: event.run_id,
        task_id: event.task_id,
        type: event.event_type,
        source: 'agent' as const,
        created_at: event.created_at,
        payload: event.payload,
        schema_version: event.schema_version,
      })),
    };
    const liveProjection = projectRunSnapshot(live, [journalRecord]);
    expect(liveProjection.dispatch_summary).toEqual(persisted.dispatch_summary);
    expect(liveProjection.dispatch_progress).toEqual(persisted.dispatch_progress);

    // 全部派工事件缺失：持久化回读只凭 Journal 事实也能重建摘要（不补执行、不虚构）。
    const allEventsMissing = projectPersistedRunSnapshot(
      baseAggregate([
        persistedEvent(1, 'handler.started', { cursor: 'execute_agent' }),
        persistedEvent(2, 'run.completed', { status: 'completed' }),
      ]),
      'run_child',
      '/runs',
      [journalRecord],
    );
    expect(allEventsMissing.dispatch_summary).toMatchObject({
      total: 1,
      by_status: { succeeded: 1 },
      unknown: { count: 0, dispatch_ids: [] },
    });
    expect(allEventsMissing.dispatch_progress?.evidence_refs).toEqual([
      {
        dispatch_id: 'dsp_1',
        path: 'journal/evidence/dsp_1.json',
        sha256: 'c'.repeat(64),
      },
    ]);
  });
});

/** 构造一条已 settled 的 Journal 折叠记录（真实 schema 校验）。 */
function settledRecord(dispatchId: string, status: 'succeeded' | 'failed'): DispatchRecord {
  const acceptedAt = NOW;
  const brief = buildExecutionBrief({
    identity: {
      dispatch_id: dispatchId,
      run_id: 'run_child',
      task_id: 'task_1',
      role_id: 'role_1',
      sequence: 1,
      accepted_at: acceptedAt,
    },
    request: { kind: 'execute', instruction: 'implement the task' },
  }).brief;
  return DispatchRecordSchema.parse({
    schema_version: DISPATCH_RECORD_SCHEMA_VERSION,
    dispatch_id: dispatchId,
    run_id: 'run_child',
    task_id: 'task_1',
    role_id: 'role_1',
    sequence: 1,
    phase: 'settled',
    status,
    brief,
    brief_sha256: hashExecutionBrief(brief),
    violations: [],
    accepted_at: acceptedAt,
    dispatched_at: '2026-11-15T00:00:01.000Z',
    settled_at: '2026-11-15T00:00:05.000Z',
    evidence_sha256: 'c'.repeat(64),
  });
}
