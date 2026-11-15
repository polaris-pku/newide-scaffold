import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileRunTerminalOutputWriter,
  summarizeRunConsumption,
} from '../../src/app/run-terminal-output-writer';
import type { AppRunSnapshot } from '../../src/app/run-registry';
import { createRunLatency } from '../../src/telemetry';
import { ROLE_DISPATCH_EVENT } from '../../src/app/run-dispatch-events';
import { RunDispatchJournal } from '../../src/persistence';
import { buildExecutionBrief, buildExecutionEvidence, hashExecutionBrief } from '../../src/driver';

const tempDirs: string[] = [];

describe('FileRunTerminalOutputWriter', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes queryable failed result, timeline, and frontend snapshot', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const writer = new FileRunTerminalOutputWriter(runsRoot);
    const snapshot = failedSnapshot();

    const evidence = await writer.finalize(snapshot);

    const runDir = path.join(runsRoot, 'run_failed');
    await expect(readJson(path.join(runDir, 'result.json'))).resolves.toMatchObject({
      run_id: 'run_failed',
      task_id: 'task_failed',
      status: 'failed',
      errors: [{ code: 'RUNNER_FAILED', message: 'driver exited' }],
      audit_path: path.join(runDir, 'audit.jsonl'),
    });
    await expect(readJson(path.join(runDir, 'timeline.json'))).resolves.toEqual(snapshot.events);
    await expect(readJson(path.join(runDir, 'frontend-snapshot.json'))).resolves.toMatchObject({
      schema_version: 'v0',
      run_id: 'run_failed',
      task_id: 'task_failed',
      status: 'failed',
      timeline: snapshot.events,
      agent_runs: [],
      artifacts: [],
      gates: [],
      errors: [{ code: 'RUNNER_FAILED', message: 'driver exited' }],
      final_output: { status: 'failed', artifact_refs: [], files_written: [] },
    });
    await expect(readJson(path.join(runDir, 'frontend-snapshot.json'))).resolves.not.toHaveProperty(
      'revision',
    );
    const snapshotBytes = await readFile(path.join(runDir, 'frontend-snapshot.json'));
    expect(evidence).toEqual({
      artifact_ref: expect.stringMatching(/^file:/),
      sha256: createHash('sha256').update(snapshotBytes).digest('hex'),
    });
  });

  it('aggregates proxy.llm_usage_recorded into summary.token_usage', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const snapshot = failedSnapshot();
    snapshot.events = [
      {
        event_id: 'run_event_proxy_1',
        sequence: 1,
        run_id: 'run_failed',
        task_id: 'task_failed',
        type: 'proxy.llm_usage_recorded',
        source: 'proxy',
        created_at: '2026-07-11T08:00:00.000Z',
        payload: { case_id: 'task_failed', input_tokens: 120, output_tokens: 30 },
        schema_version: 'v0',
      },
      {
        event_id: 'run_event_proxy_2',
        sequence: 2,
        run_id: 'run_failed',
        task_id: 'task_failed',
        type: 'proxy.llm_usage_recorded',
        source: 'proxy',
        created_at: '2026-07-11T08:00:01.000Z',
        payload: { case_id: 'task_failed', input_tokens: 10, output_tokens: 5 },
        schema_version: 'v0',
      },
      ...snapshot.events,
    ];

    await new FileRunTerminalOutputWriter(runsRoot).finalize(snapshot);

    await expect(
      readJson(path.join(runsRoot, 'run_failed', 'summary.json')),
    ).resolves.toMatchObject({
      token_usage: {
        schema_version: 'newide.token_usage.v1',
        source: 'proxy',
        input_tokens: 130,
        output_tokens: 35,
        total_tokens: 165,
        call_count: 2,
      },
    });
  });

  it('summarizes per-stage events, tokens and latency into summary.consumption', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const runLatency = createRunLatency({ root: runsRoot, persist: false });
    await runLatency
      .createRecorder({ run_id: 'run_failed', task_id: 'task_failed' })
      .span('stage.execute_agent', {}, async () => undefined);
    const snapshot = failedSnapshot();
    snapshot.events = [
      {
        event_id: 'run_event_stage',
        sequence: 2,
        run_id: 'run_failed',
        task_id: 'task_failed',
        type: 'handler.started',
        source: 'coordinator',
        created_at: '2026-07-11T08:00:01.000Z',
        payload: { cursor: 'execute_agent' },
        schema_version: 'v0',
      },
      {
        event_id: 'run_event_usage',
        sequence: 3,
        run_id: 'run_failed',
        task_id: 'task_failed',
        type: 'proxy.llm_usage_recorded',
        source: 'proxy',
        created_at: '2026-07-11T08:00:02.000Z',
        payload: {
          stage_cursor: 'execute_agent',
          input_tokens: 120,
          output_tokens: 30,
          cache_read_input_tokens: 8,
        },
        schema_version: 'v0',
      },
      {
        event_id: 'run_event_stage_done',
        sequence: 4,
        run_id: 'run_failed',
        task_id: 'task_failed',
        type: 'handler.completed',
        source: 'coordinator',
        created_at: '2026-07-11T08:00:03.000Z',
        payload: { cursor: 'execute_agent', next_cursor: 'gate' },
        schema_version: 'v0',
      },
      ...snapshot.events,
    ];

    await new FileRunTerminalOutputWriter(runsRoot, runLatency).finalize(snapshot);

    const summary = (await readJson(path.join(runsRoot, 'run_failed', 'summary.json'))) as {
      consumption: {
        totals: Record<string, number>;
        by_stage: Record<string, { events: number; llm_calls: number; duration_ms: number }>;
        latency_by_name: Record<string, { count: number }>;
      };
    };
    // total_tokens 走账本口径：含 cache，所以不等于 input + output。
    expect(summary.consumption.totals).toMatchObject({
      events: 4,
      llm_calls: 1,
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 8,
      total_tokens: 158,
    });
    // started / usage / completed 三条都算在它们界定的那个 stage 名下。
    expect(summary.consumption.by_stage.execute_agent).toMatchObject({ events: 3, llm_calls: 1 });
    // run.failed 在窗口关闭之后，落在 unattributed 桶。
    expect(summary.consumption.by_stage.unattributed).toMatchObject({ events: 1 });
    expect(summary.consumption.by_stage.execute_agent?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(summary.consumption.latency_by_name['stage.execute_agent']).toMatchObject({ count: 1 });
  });

  it('degrades to event counts when the run has neither spans nor usage records', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);

    await new FileRunTerminalOutputWriter(runsRoot).finalize(failedSnapshot());

    const summary = (await readJson(path.join(runsRoot, 'run_failed', 'summary.json'))) as {
      consumption: Record<string, unknown>;
    };
    expect(summary.consumption).toMatchObject({
      schema_version: 'newide.run_consumption.v1',
      totals: { events: 1, llm_calls: 0, total_tokens: 0, duration_ms: 0 },
      by_stage: { unattributed: { events: 1 } },
    });
    expect(summary.consumption).not.toHaveProperty('latency_by_name');
  });

  it('writes memory_ablation from agent.execution_requested when context_pack is missing', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const snapshot = failedSnapshot();
    snapshot.events = [
      {
        event_id: 'run_event_req',
        sequence: 1,
        run_id: 'run_failed',
        task_id: 'task_failed',
        type: 'agent.execution_requested',
        source: 'agent',
        created_at: '2026-07-11T08:00:00.000Z',
        payload: { role_id: 'role_ts_engineer', ablation: 'B2' },
        schema_version: 'v0',
      },
      ...snapshot.events,
    ];

    await new FileRunTerminalOutputWriter(runsRoot).finalize(snapshot);

    await expect(
      readJson(path.join(runsRoot, 'run_failed', 'summary.json')),
    ).resolves.toMatchObject({
      run_id: 'run_failed',
      status: 'failed',
      memory_ablation: 'B2',
    });
  });

  it('does not overwrite richer integration outputs', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const runDir = path.join(runsRoot, 'run_failed');
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'result.json'), '{"rich":true}', 'utf-8');

    await new FileRunTerminalOutputWriter(runsRoot).finalize(failedSnapshot());

    await expect(readJson(path.join(runDir, 'result.json'))).resolves.toEqual({ rich: true });
  });

  it('includes the Task Driver usage aggregate in summary.json', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const runDir = path.join(runsRoot, 'run_failed');
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, 'driver-stream.jsonl'),
      `${JSON.stringify({
        task_id: 'task_failed',
        recorded_at: '2026-08-14T00:00:00Z',
        event: {
          event_type: 'usage_update',
          session_id: 'session_usage',
          role_id: 'role_usage',
          payload: { update: { used: 321, size: 200_000 } },
        },
      })}\n`,
      'utf8',
    );

    await new FileRunTerminalOutputWriter(runsRoot).finalize(failedSnapshot());

    const summary = await readJson(path.join(runDir, 'summary.json'));
    expect(summary).toMatchObject({
      driver_context_usage: {
        available: true,
        source: 'driver_stream_usage_update',
        context_tokens_used: 321,
        sessions: [{ session_id: 'session_usage', role_id: 'role_usage' }],
      },
    });
    expect(summary).not.toHaveProperty('token_usage');
  });

  it('merges driver_context_usage into an existing v1 summary without replacing billed tokens', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const runDir = path.join(runsRoot, 'run_failed');
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, 'summary.json'),
      `${JSON.stringify({
        run_id: 'run_failed',
        task_id: 'task_failed',
        token_usage: {
          schema_version: 'newide.token_usage.v1',
          source: 'proxy',
          input_tokens: 12,
          output_tokens: 3,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          total_input_tokens: 12,
          total_tokens: 15,
          call_count: 1,
          sources: ['proxy'],
          by_source: {},
        },
      }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(runDir, 'driver-stream.jsonl'),
      `${JSON.stringify({
        task_id: 'task_failed',
        recorded_at: '2026-08-14T00:00:00Z',
        event: {
          event_type: 'usage_update',
          session_id: 'session_usage',
          role_id: 'role_usage',
          payload: { update: { used: 321, size: 200_000 } },
        },
      })}\n`,
      'utf8',
    );

    await new FileRunTerminalOutputWriter(runsRoot).finalize(failedSnapshot());

    await expect(readJson(path.join(runDir, 'summary.json'))).resolves.toMatchObject({
      token_usage: {
        schema_version: 'newide.token_usage.v1',
        source: 'proxy',
        total_tokens: 15,
        call_count: 1,
      },
      driver_context_usage: {
        available: true,
        source: 'driver_stream_usage_update',
        context_tokens_used: 321,
        sessions: [{ session_id: 'session_usage', role_id: 'role_usage' }],
      },
      // summary.json 已先存在时首写是空操作（wx），consumption 只能靠收尾那次并入。
      consumption: {
        schema_version: 'newide.run_consumption.v1',
        totals: { events: 1 },
      },
    });
  });

  it('migrates a legacy driver_usage block to driver_context_usage', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const runDir = path.join(runsRoot, 'run_failed');
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, 'summary.json'),
      `${JSON.stringify({
        run_id: 'run_failed',
        task_id: 'task_failed',
        driver_usage: {
          available: true,
          source: 'driver_stream_usage_update',
          metric: 'context_tokens_used',
          context_tokens_used: 321,
          reported_costs: [],
          sessions: [{ session_id: 'session_usage', role_id: 'role_usage', complete: true }],
          complete: true,
        },
      }, null, 2)}\n`,
      'utf8',
    );

    await new FileRunTerminalOutputWriter(runsRoot).finalize(failedSnapshot());

    const summary = await readJson(path.join(runDir, 'summary.json'));
    expect(summary.driver_context_usage).toMatchObject({ context_tokens_used: 321 });
    expect(summary).not.toHaveProperty('driver_usage');
  });

  it('preserves memory ablation in summary when execution fails before context build', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const snapshot = failedSnapshot();
    snapshot.events.unshift({
      event_id: 'run_event_created',
      sequence: 0,
      run_id: snapshot.run_id,
      task_id: snapshot.task_id,
      type: 'run.created',
      source: 'coordinator',
      created_at: '2026-07-11T07:59:59.000Z',
      payload: { mode: 'council', memory_ablation: 'B0' },
      schema_version: 'v0',
    });

    await new FileRunTerminalOutputWriter(runsRoot).finalize(snapshot);

    await expect(readJson(path.join(runsRoot, 'run_failed', 'summary.json'))).resolves.toMatchObject({
      memory_ablation: 'B0',
    });
  });

  it('replaces a completed legacy frontend snapshot without replacing its result manifest', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const runDir = path.join(runsRoot, 'run_failed');
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'result.json'), '{"rich":true}', 'utf-8');
    await writeFile(path.join(runDir, 'frontend-snapshot.json'), '{"legacy":true}', 'utf-8');
    const { error: _error, ...withoutError } = failedSnapshot();

    await new FileRunTerminalOutputWriter(runsRoot).finalize({
      ...withoutError,
      status: 'completed',
      current: { stage: 'delivery', active_node_code: 'N18' },
    });

    await expect(readJson(path.join(runDir, 'result.json'))).resolves.toEqual({ rich: true });
    await expect(readJson(path.join(runDir, 'frontend-snapshot.json'))).resolves.toMatchObject({
      status: 'completed',
      timeline: withoutError.events,
      errors: [],
      final_output: { status: 'completed' },
    });
  });

  it('does not let a failing driver billed scrape fail the run', async () => {
    // 刮 Claude 的 session JSONL 是**观测**。它抛错时如果一路传出去，`finalize` 就会失败，
    // 而 `persistTerminal` 的 catch 会把已经完成的 run 重写成 `failed`
    // （`TERMINAL_OUTPUT_FAILED`）——一个观测步骤毁掉 run 的结局。这条用例钉住它。
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const runDir = path.join(runsRoot, 'run_scrape');
    await mkdir(runDir, { recursive: true });
    // 预置 summary.json：`finalize` 的首写是 `wx` 只建不改，所以这份会留下来；而
    // worktree_path 必须在——没有它 `mergeBilledTokenUsage` 会在刮取**之前**就跳过，
    // 这条用例就空转了。
    await writeFile(
      path.join(runDir, 'summary.json'),
      JSON.stringify({ worktree_path: '/tmp/worktree' }),
      'utf-8',
    );
    const writer = new FileRunTerminalOutputWriter(runsRoot, undefined, async () => {
      throw new Error('claude session jsonl unavailable');
    });

    await expect(
      writer.finalize({
        ...failedSnapshot(),
        run_id: 'run_scrape',
        status: 'completed',
      }),
    ).resolves.toBeDefined();

    // 而且失败的原因必须留在产物里：「这次 run 没有 driver 腿」与「刮取失败了」是两件事。
    await expect(readJson(path.join(runDir, 'summary.json'))).resolves.toMatchObject({
      driver_billed_merge: { status: 'scrape_failed' },
    });
  });

  it('does not let an unusable summary file fail the run, but reports it', async () => {
    // 这条覆盖的是**文件层**的失败（上面那条覆盖刮取层的失败），两条都不该改动 run 的结局。
    // 预置一份坏掉的 summary.json：首写 `wx` 只建不改，所以它不会被覆盖，于是追加观测的两步
    // 都会栽在它上面——`mergeSummaryExtras` 的 `JSON.parse` 抛 SyntaxError，而它只容忍 ENOENT。
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const runDir = path.join(runsRoot, 'run_corrupt');
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'summary.json'), 'not json', 'utf-8');
    const writer = new FileRunTerminalOutputWriter(runsRoot);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await expect(
        writer.finalize({ ...failedSnapshot(), run_id: 'run_corrupt', status: 'completed' }),
      ).resolves.toBeDefined();

      // 吞掉不等于静默：失败必须被报出来，否则这条守卫就是在替读者隐瞒。
      expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain(
        'summary extras failed',
      );
      // 核心产物照旧由内存那份写出，所以 run 的真实结局没有被补充观测改写。
      await expect(readJson(path.join(runDir, 'result.json'))).resolves.toMatchObject({
        run_id: 'run_corrupt',
        status: 'completed',
      });
    } finally {
      stderr.mockRestore();
    }
  });

  it('persists dispatch summary/progress alongside the snapshot and summary', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const writer = new FileRunTerminalOutputWriter(runsRoot);
    const snapshot = failedSnapshot();
    snapshot.events = [
      {
        event_id: 'run_event_accepted',
        sequence: 1,
        run_id: 'run_failed',
        task_id: 'task_failed',
        type: ROLE_DISPATCH_EVENT.accepted,
        source: 'agent',
        created_at: '2026-07-11T08:00:00.000Z',
        payload: { dispatch_id: 'dsp_1', kind: 'execute', read_only: false, session_mode: 'fresh' },
        schema_version: 'v0',
      },
      {
        event_id: 'run_event_started',
        sequence: 2,
        run_id: 'run_failed',
        task_id: 'task_failed',
        type: ROLE_DISPATCH_EVENT.started,
        source: 'agent',
        created_at: '2026-07-11T08:00:01.000Z',
        payload: { dispatch_id: 'dsp_1', kind: 'execute' },
        schema_version: 'v0',
      },
      {
        event_id: 'run_event_settled',
        sequence: 3,
        run_id: 'run_failed',
        task_id: 'task_failed',
        type: ROLE_DISPATCH_EVENT.settled,
        source: 'agent',
        created_at: '2026-07-11T08:00:02.000Z',
        payload: { dispatch_id: 'dsp_1', kind: 'execute', status: 'unknown', violations: [] },
        schema_version: 'v0',
      },
      {
        event_id: 'run_event_terminated',
        sequence: 4,
        run_id: 'run_failed',
        task_id: 'task_failed',
        type: ROLE_DISPATCH_EVENT.role_terminated,
        source: 'agent',
        created_at: '2026-07-11T08:00:03.000Z',
        payload: { code: 'dispatch_unknown_unresolved', actor: 'role' },
        schema_version: 'v0',
      },
    ];

    await writer.finalize(snapshot);

    const runDir = path.join(runsRoot, 'run_failed');
    const summary = (await readJson(path.join(runDir, 'summary.json'))) as Record<string, unknown>;
    expect(summary.dispatch_summary).toMatchObject({
      total: 1,
      by_status: { unknown: 1 },
      unknown: { count: 1, dispatch_ids: ['dsp_1'] },
    });
    expect(summary.dispatch_progress).toMatchObject({
      terminated: { code: 'dispatch_unknown_unresolved', actor: 'role' },
    });
    // 上位快照与落盘回读同源：frontend-snapshot / result 带着与 summary 相同的投影。
    await expect(readJson(path.join(runDir, 'frontend-snapshot.json'))).resolves.toMatchObject({
      dispatch_summary: summary.dispatch_summary,
      dispatch_progress: summary.dispatch_progress,
    });
    await expect(readJson(path.join(runDir, 'result.json'))).resolves.toMatchObject({
      dispatch_summary: summary.dispatch_summary,
    });
  });

  it('R4-01: rebuilds the dispatch summary from Journal when the settled event was lost', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(runsRoot);
    const runDir = path.join(runsRoot, 'run_failed');
    await mkdir(runDir, { recursive: true });
    const identity = { run_id: 'run_failed', task_id: 'task_failed', role_id: 'role_1' };
    const journal = await RunDispatchJournal.open({ runDir, identity });
    const brief = buildExecutionBrief({
      identity: {
        dispatch_id: 'dsp_journal',
        run_id: identity.run_id,
        task_id: identity.task_id,
        role_id: identity.role_id,
        sequence: 1,
        accepted_at: '2026-07-11T08:00:00.000Z',
      },
      request: { kind: 'execute', instruction: 'do the work' },
    }).brief;
    await journal.appendAccepted({
      brief,
      brief_sha256: hashExecutionBrief(brief),
      budget_before: {
        dispatches_left: 1,
        role_tokens_left: 1_000,
        deadline_at: '2026-07-11T09:00:00.000Z',
      },
    });
    await journal.appendDispatched({ dispatch_id: 'dsp_journal' });
    const evidence = buildExecutionEvidence({
      dispatch_id: 'dsp_journal',
      observation: {
        transport: { evidence: 'execution_unconfirmed' },
        result: { status: 'succeeded', response: 'done' },
      },
    });
    const ref = await journal.appendEvidence({ dispatch_id: 'dsp_journal', evidence });
    await journal.appendSettled({
      dispatch_id: 'dsp_journal',
      status: 'succeeded',
      evidence,
      evidence_sha256: ref.sha256,
      violations: [],
    });
    await journal.close();

    // 事件出口只成功落了 accepted；settled 事件丢失 → 纯事件投影会停在 unknown。
    const snapshot = failedSnapshot();
    snapshot.events = [
      {
        event_id: 'run_event_accepted',
        sequence: 2,
        run_id: 'run_failed',
        task_id: 'task_failed',
        type: ROLE_DISPATCH_EVENT.accepted,
        source: 'agent',
        created_at: '2026-07-11T08:00:01.000Z',
        payload: {
          dispatch_id: 'dsp_journal',
          kind: 'execute',
          read_only: false,
          session_mode: 'fresh',
          sequence: 1,
        },
        schema_version: 'v0',
      },
    ];

    const writer = new FileRunTerminalOutputWriter(runsRoot);
    await writer.finalize(snapshot);
    // 重复收尾：同一份事实不放大计数（文件已存在时首写为空操作）。
    await writer.finalize(snapshot);

    const summary = (await readJson(path.join(runDir, 'summary.json'))) as Record<string, unknown>;
    expect(summary.dispatch_summary).toMatchObject({
      total: 1,
      by_status: { succeeded: 1 },
      unknown: { count: 0, dispatch_ids: [] },
    });
    expect(summary.dispatch_progress).toMatchObject({
      evidence_refs: [
        {
          dispatch_id: 'dsp_journal',
          path: 'journal/evidence/dsp_journal.json',
          sha256: ref.sha256,
        },
      ],
    });
    // 终态产物与 summary 同源：result / frontend-snapshot 也按 Journal 事实补齐。
    await expect(readJson(path.join(runDir, 'result.json'))).resolves.toMatchObject({
      dispatch_summary: summary.dispatch_summary,
    });
    await expect(readJson(path.join(runDir, 'frontend-snapshot.json'))).resolves.toMatchObject({
      dispatch_summary: summary.dispatch_summary,
    });
    // legacy Run（没有 Journal）不得被补出派工事实。
    const legacyRoot = await mkdtemp(path.join(os.tmpdir(), 'terminal-output-'));
    tempDirs.push(legacyRoot);
    await new FileRunTerminalOutputWriter(legacyRoot).finalize(failedSnapshot());
    const legacySummary = (await readJson(
      path.join(legacyRoot, 'run_failed', 'summary.json'),
    )) as Record<string, unknown>;
    expect(legacySummary).not.toHaveProperty('dispatch_summary');
  });
});

describe('summarizeRunConsumption', () => {
  it('attributes events to the stage open at the time, and prefers an explicit stage', () => {
    const summary = summarizeRunConsumption([
      { type: 'run.created', payload: { mode: 'single_agent' } },
      { type: 'handler.started', payload: { cursor: 'select_agent' } },
      { type: 'handler.completed', payload: { cursor: 'select_agent', next_cursor: 'gate' } },
      // 窗口已关：这条属于 run，不该塞给 select_agent。
      { type: 'run.started', payload: { mode: 'single_agent' } },
      { type: 'handler.started', payload: { cursor: 'deliver' } },
      // 用量事件自带归属：它记在 gate 名下，即使此刻开着的是 deliver。
      {
        type: 'proxy.llm_usage_recorded',
        payload: { stage_cursor: 'gate', input_tokens: 7, output_tokens: 3 },
      },
    ]);

    expect(summary.by_stage.unattributed).toMatchObject({ events: 2 });
    expect(summary.by_stage.select_agent).toMatchObject({ events: 2, llm_calls: 0 });
    expect(summary.by_stage.deliver).toMatchObject({ events: 1, llm_calls: 0 });
    expect(summary.by_stage.gate).toMatchObject({ events: 1, llm_calls: 1, total_tokens: 10 });
    expect(summary.totals).toMatchObject({ events: 6, llm_calls: 1, total_tokens: 10 });
    expect(summary).not.toHaveProperty('latency_by_name');
  });

  it('keeps driver stream projections out of stage counts and in their own bucket', () => {
    const summary = summarizeRunConsumption([
      { type: 'handler.started', payload: { cursor: 'execute_agent' } },
      { type: 'driver.agent_message_chunk', payload: { event_sequence: 1, session_id: 's1' } },
      { type: 'driver.tool_started', payload: { event_sequence: 2, tool_call_id: 'tc_1' } },
      { type: 'driver.agent_message_chunk', payload: { event_sequence: 3 } },
      // 阶段自己发的 driver.* 领域事件没有 event_sequence，仍算阶段做功。
      { type: 'driver.run_result', payload: { status: 'succeeded' } },
      { type: 'handler.completed', payload: { cursor: 'execute_agent', next_cursor: 'gate' } },
    ]);

    // started / run_result / completed 三条是阶段做功；三条流投影不占它的计数。
    expect(summary.by_stage.execute_agent).toMatchObject({ events: 3 });
    expect(summary.by_stage.driver_stream).toMatchObject({ events: 3 });
    // 总数是各桶之和：driver_stream 计入总数，但不占阶段的计数。
    expect(summary.totals.events).toBe(6);
  });

  it('folds stage spans into stage durations and keeps the rest by name', () => {
    const summary = summarizeRunConsumption(
      [{ type: 'handler.started', payload: { cursor: 'gate' } }],
      {
        run_id: 'run_x',
        span_count: 3,
        by_name: {
          'stage.gate': { count: 1, total_duration_ms: 42, max_duration_ms: 42 },
          // stage 有 span 但没有事件归到它名下时，耗时仍要出现，故这里应新建桶。
          'stage.deliver': { count: 1, total_duration_ms: 5, max_duration_ms: 5 },
          'agent.llm_round': { count: 2, total_duration_ms: 10, max_duration_ms: 6 },
        },
        by_layer: {
          stage: { count: 2, total_duration_ms: 47 },
          agent: { count: 2, total_duration_ms: 10 },
        },
      },
    );

    expect(summary.by_stage.gate).toMatchObject({ events: 1, duration_ms: 42 });
    expect(summary.by_stage.deliver).toMatchObject({ events: 0, duration_ms: 5 });
    expect(summary.totals.duration_ms).toBe(47);
    expect(summary.latency_by_name).toMatchObject({
      'agent.llm_round': { count: 2, total_duration_ms: 10 },
    });
  });
});

function failedSnapshot(): AppRunSnapshot {
  return {
    schema_version: 'v0',
    revision: 1,
    run_id: 'run_failed',
    task_id: 'task_failed',
    status: 'failed',
    mode: 'single_agent',
    current: { stage: 'intervention', active_node_code: 'N18' },
    events: [
      {
        event_id: 'run_event_1',
        sequence: 1,
        run_id: 'run_failed',
        task_id: 'task_failed',
        type: 'run.failed',
        source: 'coordinator',
        created_at: '2026-07-11T08:00:00.000Z',
        payload: { code: 'RUNNER_FAILED' },
        schema_version: 'v0',
      },
    ],
    error: { code: 'RUNNER_FAILED', message: 'driver exited' },
  };
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}
