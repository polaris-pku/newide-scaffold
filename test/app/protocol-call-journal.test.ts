import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { protocolFrameSchema } from '../../src/core/protocol-frame';
import { ProtocolCallJournal } from '../../src/app/protocol-call-journal';
import { InMemoryParticipantSessionRegistry } from '../../src/coordination/participant-session-registry';
import type { CoordinationStateCommit } from '../../src/persistence/coordination-state-store';
import { SqliteCoordinationStore } from '../../src/persistence/sqlite-coordination-store';
import type { CallJournalEvent } from '../../src/memory';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createDatabase(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-call-journal-'));
  directories.push(directory);
  return path.join(directory, 'coordination.sqlite');
}

function seedCommit(overrides: { task_id: string; run_id: string; workspace_path?: string }):
  CoordinationStateCommit {
  const at = '2026-09-25T09:00:00.000Z';
  return {
    task: {
      task_id: overrides.task_id, status: 'created', risk_level: 'medium',
      spec: 'Journal test', completion_criteria: ['done'], affected_paths: [],
      workspace_path: overrides.workspace_path ?? '/workspace', warnings: [], revision: 1,
      created_at: at, updated_at: at, schema_version: 'v0',
    },
    run: {
      run_id: overrides.run_id, task_id: overrides.task_id, status: 'created',
      mode: 'single_agent', workspace_path: overrides.workspace_path ?? '/workspace',
      revision: 1, created_at: at, updated_at: at, schema_version: 'v0',
    },
    runtime_state: {
      task_id: overrides.task_id, current_run_id: overrides.run_id,
      resume_cursor: 'execute_agent', waiting_on: [], artifact_refs: [], diagnostics: {},
      updated_at: at, schema_version: 'v0',
    },
    events: [{
      event_id: `event-${overrides.run_id}`, event_type: 'task.created',
      subject_id: overrides.task_id, task_id: overrides.task_id, run_id: overrides.run_id,
      payload: {}, created_at: at, schema_version: 'v0',
    }],
  };
}

function askFrame() {
  const fixture = new URL('../../fixtures/protocol/v1-aap-ask.json', import.meta.url);
  return protocolFrameSchema.parse(JSON.parse(readFileSync(fixture, 'utf8')));
}

function makeEvent(overrides: Partial<CallJournalEvent> = {}): CallJournalEvent {
  return {
    call_id: 'call-j1',
    event: 'memory_query',
    task_id: 'task-j1',
    run_id: 'run-j1',
    role_id: 'implementer',
    workspace_path: '/workspace',
    status: 'ok',
    summary: 'skills=1 experiences=2',
    duration_ms: 42,
    completed_at: '2026-09-25T09:01:00.000Z',
    ...overrides,
  };
}

describe('ProtocolCallJournal', () => {
  it('已注册 session → 行落库且 session_id/duration_ms 命中、call 行不进因果图', () => {
    const store = new SqliteCoordinationStore(createDatabase());
    store.commitState(seedCommit({ task_id: 'task-j1', run_id: 'run-j1' }));
    const registry = new InMemoryParticipantSessionRegistry();
    registry.register({
      task_id: 'task-j1', workspace_path: '/workspace',
      role_id: 'implementer', session_id: 'sess-abc',
    });
    const journal = new ProtocolCallJournal({ store, sessionRegistry: registry });

    journal.record(makeEvent());

    const rows = store.listJournal('task-j1', 'run-j1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'call', id: 'call-j1', causation_id: null, frame: null,
      role_id: 'implementer', event: 'memory_query', status: 'ok',
      summary: 'skills=1 experiences=2', session_id: 'sess-abc', duration_ms: 42,
    });
    store.close();
  });

  it('有 workspace 未注册 / 无 workspace → session_id 记 null', () => {
    const store = new SqliteCoordinationStore(createDatabase());
    store.commitState(seedCommit({ task_id: 'task-j1', run_id: 'run-j1' }));
    const journal = new ProtocolCallJournal({
      store,
      sessionRegistry: new InMemoryParticipantSessionRegistry(),
    });

    journal.record(makeEvent({ call_id: 'call-unbound' }));
    journal.record(makeEvent({ call_id: 'call-noworkspace', workspace_path: undefined }));

    const rows = store.listJournal('task-j1', 'run-j1');
    expect(rows.map((row) => [row.id, row.session_id])).toEqual([
      ['call-unbound', null],
      ['call-noworkspace', null],
    ]);
    store.close();
  });

  it('同 call_id 两次 → 幂等仍 1 行', () => {
    const store = new SqliteCoordinationStore(createDatabase());
    store.commitState(seedCommit({ task_id: 'task-j1', run_id: 'run-j1' }));
    const journal = new ProtocolCallJournal({ store });

    journal.record(makeEvent());
    journal.record(makeEvent({ summary: 'duplicate' }));

    expect(store.listJournal('task-j1', 'run-j1')).toHaveLength(1);
    store.close();
  });

  it('缺 run_id / task 未种（FK 缺行）→ 不抛、无行（best-effort 吞掉）', () => {
    const store = new SqliteCoordinationStore(createDatabase());
    store.commitState(seedCommit({ task_id: 'task-j1', run_id: 'run-j1' }));
    const journal = new ProtocolCallJournal({ store });

    expect(() => journal.record(makeEvent({ call_id: 'call-norun', run_id: undefined }))).not
      .toThrow();
    expect(() =>
      journal.record(makeEvent({ call_id: 'call-ghost', task_id: 'task-ghost' })),
    ).not.toThrow();

    expect(store.listJournal('task-j1', 'run-j1')).toHaveLength(0);
    expect(store.listJournal('task-ghost', 'run-j1')).toHaveLength(0);
    store.close();
  });

  it('不同 (task, run) 的记录互不串，seq 全局递增', () => {
    const store = new SqliteCoordinationStore(createDatabase());
    store.commitState(seedCommit({ task_id: 'task-a', run_id: 'run-a' }));
    store.commitState(seedCommit({ task_id: 'task-b', run_id: 'run-b' }));
    const journal = new ProtocolCallJournal({ store });

    journal.record(makeEvent({ call_id: 'call-a', task_id: 'task-a', run_id: 'run-a' }));
    journal.record(makeEvent({ call_id: 'call-b', task_id: 'task-b', run_id: 'run-b' }));

    const rowsA = store.listJournal('task-a', 'run-a');
    const rowsB = store.listJournal('task-b', 'run-b');
    expect(rowsA.map((row) => row.id)).toEqual(['call-a']);
    expect(rowsB.map((row) => row.id)).toEqual(['call-b']);
    expect(rowsA[0].seq).toBeLessThan(rowsB[0].seq);
    store.close();
  });

  it('call 行排在帧行之后，且全表 call 行 causation 恒空、无人以 call 为父', () => {
    const store = new SqliteCoordinationStore(createDatabase());
    // 帧 fixture（v1-aap-ask）绑定 task-0088/run-20260921-001，seed 必须同键
    store.commitState(seedCommit({ task_id: 'task-0088', run_id: 'run-20260921-001' }));
    const journal = new ProtocolCallJournal({ store });
    const ask = askFrame();

    store.withProtocolTransaction((tx) => {
      tx.enqueueOutbox({ id: 'out-frame', destination: 'reviewer', frame: ask });
    });
    journal.record(
      makeEvent({
        call_id: 'call-after-frame',
        task_id: 'task-0088',
        run_id: 'run-20260921-001',
      }),
    );

    const rows = store.listJournal('task-0088', 'run-20260921-001');
    const frameRows = rows.filter((row) => row.kind !== 'call');
    const callRows = rows.filter((row) => row.kind === 'call');
    expect(frameRows).toHaveLength(1);
    expect(callRows).toHaveLength(1);
    expect(callRows[0].seq).toBeGreaterThan(frameRows[0].seq);
    expect(callRows.every((row) => row.causation_id === null)).toBe(true);
    // 没有任何行的 causation 指向 call 行的 id
    const callIds = new Set(callRows.map((row) => row.id));
    expect(rows.some((row) => row.causation_id && callIds.has(row.causation_id))).toBe(false);
    store.close();
  });

  it('旧结构 journal 打开后自动补 session_id/duration_ms 两列并可写入', () => {
    const databasePath = createDatabase();
    // 预建旧结构（无两新列）的 journal 表
    const bare = new DatabaseSync(databasePath);
    bare.exec(`
      CREATE TABLE journal (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('sap', 'aap', 'adp', 'call')),
        id TEXT NOT NULL,
        causation_id TEXT,
        role_id TEXT,
        event TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT,
        CHECK (kind != 'call' OR (causation_id IS NULL AND payload_json IS NULL)),
        CHECK (kind = 'call' OR payload_json IS NOT NULL)
      );
    `);
    bare.close();

    const store = new SqliteCoordinationStore(databasePath);
    store.commitState(seedCommit({ task_id: 'task-j1', run_id: 'run-j1' }));
    const journal = new ProtocolCallJournal({ store });
    journal.record(makeEvent());

    const rows = store.listJournal('task-j1', 'run-j1');
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBeNull();
    expect(rows[0].duration_ms).toBe(42);
    store.close();
  });
});
