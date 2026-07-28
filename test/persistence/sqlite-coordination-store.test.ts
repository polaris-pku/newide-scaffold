import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteCoordinationStore,
  type CoordinationStateCommit,
} from '../../src/persistence/sqlite-coordination-store';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SqliteCoordinationStore', () => {
  it('creates the v2 coordination schema in WAL mode', () => {
    const { databasePath, store } = createStore();
    store.close();

    const database = new DatabaseSync(databasePath);
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    const journalMode = database.prepare('PRAGMA journal_mode').get();
    const migration = database
      .prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')
      .get();

    expect(tables).toEqual(
      expect.arrayContaining([
        'tasks',
        'runs',
        'task_runtime_states',
        'events',
        'checkpoints',
        'messages',
        'deliveries',
      ]),
    );
    expect(journalMode).toEqual({ journal_mode: 'wal' });
    expect(migration).toEqual({ version: 2 });

    const runtimeColumns = database
      .prepare('PRAGMA table_info(task_runtime_states)')
      .all()
      .map((row) => String(row.name));
    expect(runtimeColumns).toContain('cursor_input_json');
    database.close();
  });

  it('atomically persists task, run, runtime state, and ordered events', () => {
    const { store } = createStore();
    const commit = initialCommit();

    const [event] = store.commitState(commit);
    const aggregate = store.getTaskAggregate('task_sqlite');

    expect(event).toMatchObject({ sequence: 1, event_id: 'event_task_created' });
    expect(aggregate).toEqual({
      task: commit.task,
      runs: [commit.run],
      runtime_state: commit.runtime_state,
      events: [expect.objectContaining({ sequence: 1, event_id: 'event_task_created' })],
    });
    store.close();
  });

  it('round-trips typed cursor input through runtime state', () => {
    const { store } = createStore();
    const commit = initialCommit();
    const cursorInput = {
      cursor: 'select_agent' as const,
      seed: 'seed-42',
      candidate_ids: ['agent_a', 'agent_b'],
      market_evidence_ref: 'file:///tmp/market.json',
    };

    store.commitState({
      ...commit,
      runtime_state: { ...commit.runtime_state, cursor_input: cursorInput },
    });

    expect(store.getTaskAggregate('task_sqlite')?.runtime_state.cursor_input).toEqual(cursorInput);
    store.close();
  });

  it('rejects an invalid persisted Council cursor trigger on read', () => {
    const { databasePath, store } = createStore();
    const commit = initialCommit();
    store.commitState({
      ...commit,
      runtime_state: {
        ...commit.runtime_state,
        resume_cursor: 'council',
        cursor_input: { cursor: 'council', trigger: 'agent_request' },
      },
    });
    store.close();

    const database = new DatabaseSync(databasePath);
    database
      .prepare('UPDATE task_runtime_states SET cursor_input_json = ? WHERE task_id = ?')
      .run(JSON.stringify({ cursor: 'council', trigger: 'model_said_maybe' }), 'task_sqlite');
    database.close();

    const reopened = new SqliteCoordinationStore(databasePath);
    expect(() => reopened.getTaskAggregate('task_sqlite')).toThrow(/Council cursor trigger/i);
    reopened.close();
  });

  it('rejects a Gate cursor whose subject differs from its bound changeset', () => {
    const { store } = createStore();
    const commit = initialCommit();

    expect(() =>
      store.commitState({
        ...commit,
        runtime_state: {
          ...commit.runtime_state,
          resume_cursor: 'gate',
          cursor_input: {
            cursor: 'gate',
            subject_ref: 'artifact_subject',
            phase: 'post_primary',
            changeset_ref: 'artifact_changeset',
            expected_sha256: 'a'.repeat(64),
          },
        },
      }),
    ).toThrow(/subject_ref.*changeset_ref/i);
    expect(store.getTaskAggregate('task_sqlite')).toBeUndefined();
    store.close();
  });

  it('migrates a legacy runtime table and reads missing cursor input as undefined', () => {
    const { databasePath } = createLegacyV1Database();
    const store = new SqliteCoordinationStore(databasePath);

    expect(store.getTaskAggregate('task_legacy')?.runtime_state).not.toHaveProperty('cursor_input');
    store.close();

    const database = new DatabaseSync(databasePath);
    const runtimeColumns = database
      .prepare('PRAGMA table_info(task_runtime_states)')
      .all()
      .map((row) => String(row.name));
    database.close();
    expect(runtimeColumns).toContain('cursor_input_json');
  });

  it('rolls back state changes when the event write fails', () => {
    const { store } = createStore();
    const initial = initialCommit();
    store.commitState(initial);

    expect(() =>
      store.commitState({
        expected_task_revision: 1,
        task: {
          ...initial.task,
          status: 'running',
          revision: 2,
          updated_at: '2026-07-19T02:01:00.000Z',
        },
        run: {
          ...initial.run,
          status: 'running',
          revision: 2,
          updated_at: '2026-07-19T02:01:00.000Z',
        },
        runtime_state: {
          ...initial.runtime_state,
          resume_cursor: 'execute_agent',
          updated_at: '2026-07-19T02:01:00.000Z',
        },
        events: [initial.events[0]],
      }),
    ).toThrow();

    const aggregate = store.getTaskAggregate('task_sqlite');
    expect(aggregate?.task).toMatchObject({ status: 'created', revision: 1 });
    expect(aggregate?.runs[0]).toMatchObject({ status: 'created', revision: 1 });
    expect(aggregate?.runtime_state.resume_cursor).toBe('select_agent');
    expect(aggregate?.events).toHaveLength(1);
    store.close();
  });

  it('rejects a second active run for the same task', () => {
    const { store } = createStore();
    const initial = initialCommit();
    store.commitState(initial);

    expect(() =>
      store.commitState({
        expected_task_revision: 1,
        task: {
          ...initial.task,
          status: 'running',
          revision: 2,
          updated_at: '2026-07-19T02:01:00.000Z',
        },
        run: {
          ...initial.run,
          run_id: 'run_second',
          status: 'running',
          revision: 1,
          updated_at: '2026-07-19T02:01:00.000Z',
        },
        runtime_state: {
          ...initial.runtime_state,
          current_run_id: 'run_second',
          updated_at: '2026-07-19T02:01:00.000Z',
        },
        events: [
          {
            event_id: 'event_second_run',
            event_type: 'run.started',
            subject_id: 'run_second',
            run_id: 'run_second',
            task_id: 'task_sqlite',
            payload: {},
            created_at: '2026-07-19T02:01:00.000Z',
            schema_version: 'v0',
          },
        ],
      }),
    ).toThrow(/active run/i);

    expect(store.getTaskAggregate('task_sqlite')?.runs).toHaveLength(1);
    store.close();
  });

  it('requires verifiable final artifact evidence before completing a task', () => {
    const { store } = createStore();
    const initial = initialCommit();
    store.commitState(initial);

    const completed: CoordinationStateCommit = {
      expected_task_revision: 1,
      task: {
        ...initial.task,
        status: 'completed',
        revision: 2,
        updated_at: '2026-07-19T02:02:00.000Z',
      },
      run: {
        ...initial.run,
        status: 'completed',
        revision: 2,
        completed_at: '2026-07-19T02:02:00.000Z',
        updated_at: '2026-07-19T02:02:00.000Z',
      },
      runtime_state: {
        ...initial.runtime_state,
        current_run_id: undefined,
        resume_cursor: 'done',
        updated_at: '2026-07-19T02:02:00.000Z',
      },
      events: [
        {
          event_id: 'event_completed',
          event_type: 'task.completed',
          subject_id: 'task_sqlite',
          run_id: 'run_sqlite',
          task_id: 'task_sqlite',
          payload: {},
          created_at: '2026-07-19T02:02:00.000Z',
          schema_version: 'v0',
        },
      ],
    };

    expect(() => store.commitState(completed)).toThrow(/final artifact/i);

    store.commitState({
      ...completed,
      task: {
        ...completed.task,
        final_output: {
          artifact_ref: 'artifact_final',
          sha256: 'a'.repeat(64),
          workspace_path: '/workspace/result.ts',
        },
      },
    });
    expect(store.getTaskAggregate('task_sqlite')?.task).toMatchObject({
      status: 'completed',
      final_output: { artifact_ref: 'artifact_final', sha256: 'a'.repeat(64) },
    });
    store.close();
  });

  it('stores a full checkpoint in the same state and event transaction', () => {
    const { store } = createStore();
    const initial = initialCommit();
    store.commitState(initial);
    const checkpoint = {
      checkpoint_id: 'checkpoint_full',
      task_id: 'task_sqlite',
      run_id: 'run_sqlite',
      agent_id: 'role_ts_engineer@agent_1',
      session_id: 'session_1',
      trigger: 'blocked' as const,
      resume_cursor: 'execute_agent' as const,
      message_thread: [
        {
          message_id: 'event_task_created',
          role: 'coordinator',
          content: 'task.created',
          turn: 0,
          artifact_refs: [],
          created_at: '2026-07-19T02:00:00.000Z',
        },
      ],
      mechanical_snapshot: {
        base_commit: 'unknown',
        worktree_path: '/workspace',
        branch: 'runtime-recovery',
        modified_files: [],
      },
      semantic_handoff: {
        done: ['task.created'],
        in_progress: ['execute_agent'],
        blocked_on: ['backend process interrupted'],
        assumptions: [],
        next_steps: ['resume execute_agent'],
        known_risks: ['unfinished action will be re-executed'],
      },
      artifact_refs: ['artifact_context'],
      validity_status: 'valid' as const,
      created_at: '2026-07-19T02:01:00.000Z',
      schema_version: 'v0' as const,
    };

    store.commitState({
      expected_task_revision: 1,
      task: {
        ...initial.task,
        status: 'blocked',
        revision: 2,
        updated_at: '2026-07-19T02:01:00.000Z',
      },
      run: {
        ...initial.run,
        status: 'interrupted',
        revision: 2,
        completed_at: '2026-07-19T02:01:00.000Z',
        updated_at: '2026-07-19T02:01:00.000Z',
      },
      runtime_state: {
        ...initial.runtime_state,
        current_run_id: undefined,
        resume_cursor: 'execute_agent',
        interrupt_state: {
          type: 'process_interrupted',
          reason: 'backend process interrupted',
        },
        updated_at: '2026-07-19T02:01:00.000Z',
      },
      checkpoint,
      events: [
        {
          event_id: 'event_checkpoint_saved',
          event_type: 'checkpoint.saved',
          subject_id: 'checkpoint_full',
          run_id: 'run_sqlite',
          task_id: 'task_sqlite',
          payload: { checkpoint_type: 'full', trigger: 'blocked' },
          created_at: '2026-07-19T02:01:00.000Z',
          schema_version: 'v0',
        },
      ],
    });

    expect(store.getLatestCheckpoint('task_sqlite')).toEqual(checkpoint);
    store.close();
  });
});

function createStore(): { databasePath: string; store: SqliteCoordinationStore } {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-coordination-store-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'coordination.sqlite');
  return { databasePath, store: new SqliteCoordinationStore(databasePath) };
}

function createLegacyV1Database(): { databasePath: string } {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-coordination-legacy-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'coordination.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-07-19T02:00:00.000Z');
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      parent_id TEXT,
      status TEXT NOT NULL,
      owner_agent_id TEXT,
      role_id TEXT,
      risk_level TEXT NOT NULL,
      spec TEXT NOT NULL,
      completion_criteria_json TEXT NOT NULL,
      affected_paths_json TEXT NOT NULL,
      budget_json TEXT,
      workspace_path TEXT NOT NULL,
      warnings_json TEXT NOT NULL,
      final_output_json TEXT,
      error_json TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      schema_version TEXT NOT NULL
    );
    INSERT INTO tasks VALUES (
      'task_legacy', NULL, 'created', NULL, NULL, 'medium', 'legacy task',
      '["read legacy state"]', '["src/**"]', NULL, '/workspace', '[]', NULL, NULL,
      1, '2026-07-19T02:00:00.000Z', '2026-07-19T02:00:00.000Z', 'v0'
    );
    CREATE TABLE task_runtime_states (
      task_id TEXT PRIMARY KEY,
      current_run_id TEXT,
      resume_cursor TEXT NOT NULL,
      waiting_on_json TEXT NOT NULL,
      interrupt_state_json TEXT,
      artifact_refs_json TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      schema_version TEXT NOT NULL
    );
    INSERT INTO task_runtime_states VALUES (
      'task_legacy', NULL, 'select_agent', '[]', NULL, '[]', '{}',
      '2026-07-19T02:00:00.000Z', 'v0'
    );
  `);
  database.close();
  return { databasePath };
}

function initialCommit(): CoordinationStateCommit {
  return {
    task: {
      task_id: 'task_sqlite',
      status: 'created',
      risk_level: 'medium',
      spec: 'Persist one task atomically',
      completion_criteria: ['Task and Event commit together'],
      affected_paths: ['src/persistence/**'],
      workspace_path: '/workspace',
      warnings: [],
      revision: 1,
      created_at: '2026-07-19T02:00:00.000Z',
      updated_at: '2026-07-19T02:00:00.000Z',
      schema_version: 'v0',
    },
    run: {
      run_id: 'run_sqlite',
      task_id: 'task_sqlite',
      status: 'created',
      mode: 'single_agent',
      workspace_path: '/workspace',
      revision: 1,
      created_at: '2026-07-19T02:00:00.000Z',
      updated_at: '2026-07-19T02:00:00.000Z',
      schema_version: 'v0',
    },
    runtime_state: {
      task_id: 'task_sqlite',
      current_run_id: 'run_sqlite',
      resume_cursor: 'select_agent',
      waiting_on: [],
      artifact_refs: [],
      diagnostics: {},
      updated_at: '2026-07-19T02:00:00.000Z',
      schema_version: 'v0',
    },
    events: [
      {
        event_id: 'event_task_created',
        event_type: 'task.created',
        subject_id: 'task_sqlite',
        run_id: 'run_sqlite',
        task_id: 'task_sqlite',
        payload: { spec: 'Persist one task atomically' },
        created_at: '2026-07-19T02:00:00.000Z',
        schema_version: 'v0',
      },
    ],
  };
}
