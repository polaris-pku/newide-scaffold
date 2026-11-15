/**
 * consumption-report 脚本的取数与渲染测试。
 *
 * 守三件事：四份流水各自缺失时**降级而不报错**（老 run 没有 consumption、没有 span，
 * 假 driver run 没有 telemetry.jsonl），缺失原因如实写进 `missing`；`--all` 的合并口径
 * 与单 run 一致；坏行不炸整份报告。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateConsumption,
  collectRunConsumption,
  parseConsumptionCliArgs,
  renderConsumptionReport,
} from '../../scripts/consumption-report';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createRunsRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'consumption-report-'));
  tempDirs.push(root);
  return root;
}

/** 一份完整的 run：四类信号都在。 */
async function writeCompleteRun(runsRoot: string, runId: string): Promise<void> {
  const runDir = path.join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, 'summary.json'),
    JSON.stringify({
      run_id: runId,
      mode: 'council',
      status: 'completed',
      consumption: {
        schema_version: 'newide.run_consumption.v1',
        totals: { events: 3, llm_calls: 2, total_tokens: 158 },
        by_stage: {
          execute_agent: { events: 2, llm_calls: 2, total_tokens: 158, duration_ms: 146.8 },
        },
      },
    }),
    'utf8',
  );
  await writeFile(
    path.join(runDir, 'audit.jsonl'),
    [
      { type: 'run.started' },
      { type: 'handler.started' },
      { type: 'run.completed' },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(runDir, 'latency.jsonl'),
    [
      { name: 'stage.execute_agent', duration_ms: 100 },
      { name: 'stage.execute_agent', duration_ms: 46.8 },
      { name: 'agent.llm_round', duration_ms: 10 },
      { name: 'run.loop_total', duration_ms: 200 },
    ]
      .map((span) => JSON.stringify(span))
      .join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(runDir, 'telemetry.jsonl'),
    `${JSON.stringify({ event_type: 'proxy.llm_usage_recorded' })}\n`,
    'utf8',
  );
}

/** 老 run：没有 consumption 块、没有 span，只有事件与运行级 token_usage。 */
async function writeLegacyRun(runsRoot: string, runId: string): Promise<void> {
  const runDir = path.join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, 'summary.json'),
    JSON.stringify({
      run_id: runId,
      status: 'completed',
      token_usage: { total_tokens: 42, call_count: 1 },
    }),
    'utf8',
  );
  await writeFile(
    path.join(runDir, 'audit.jsonl'),
    `${JSON.stringify({ type: 'run.completed' })}\n`,
    'utf8',
  );
}

/**
 * 带派工区块的 run：summary.json 有 dispatch_summary，driver-usage.jsonl 有按派工归属与
 * legacy 无归属各一条。同一 session 的累计更新重复出现，用来验证「重复输入不重复记账」。
 */
async function writeDispatchRun(runsRoot: string, runId: string): Promise<void> {
  const runDir = path.join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, 'summary.json'),
    JSON.stringify({
      run_id: runId,
      status: 'completed',
      dispatch_summary: {
        total: 2,
        by_status: { succeeded: 1, unknown: 1 },
        last_dispatch: { dispatch_id: 'dsp_2', status: 'unknown', updated_at: '2026-11-14T00:00:02Z' },
        unknown: { count: 1, dispatch_ids: ['dsp_2'] },
        violations: { count: 0, kinds: [] },
      },
    }),
    'utf8',
  );
  await writeFile(
    path.join(runDir, 'driver-usage.jsonl'),
    [
      ledgerRow({ runId, session: 'session_1', dispatch: 'dsp_1', used: 100, sequence: 1 }),
      ledgerRow({ runId, session: 'session_1', dispatch: 'dsp_1', used: 300, sequence: 2, cost: 0.5 }),
      ledgerRow({ runId, session: 'session_2', dispatch: 'dsp_2', used: 50, sequence: 3 }),
      ledgerRow({ runId, session: 'session_legacy', used: 10, sequence: 4, cost: 0.1 }),
    ].join('\n'),
    'utf8',
  );
}

function ledgerRow(input: {
  runId: string;
  session: string;
  dispatch?: string;
  used: number;
  sequence: number;
  cost?: number;
}): string {
  return JSON.stringify({
    schema_version: 'newide.driver-usage-record.v1',
    recorded_at: '2026-11-14T00:00:00Z',
    run_id: input.runId,
    task_id: 'task_dispatch',
    stream_sequence: input.sequence,
    session_id: input.session,
    ...(input.dispatch !== undefined ? { dispatch_id: input.dispatch } : {}),
    metric: 'context_tokens_used',
    context_tokens_used: input.used,
    context_window_size: 200_000,
    ...(input.cost !== undefined
      ? { reported_cost: { amount: input.cost, currency: 'USD' } }
      : {}),
  });
}

describe('collectRunConsumption', () => {
  it('reads all four streams when the run has them', async () => {
    const runsRoot = await createRunsRoot();
    await writeCompleteRun(runsRoot, 'run_full');

    const run = await collectRunConsumption(runsRoot, 'run_full');

    expect(run).toMatchObject({
      run_id: 'run_full',
      mode: 'council',
      status: 'completed',
      missing: [],
      total_events: 3,
      total_tokens: 158,
      llm_calls: 2,
    });
    expect(run.by_stage.execute_agent).toEqual({
      events: 2,
      llm_calls: 2,
      total_tokens: 158,
      duration_ms: 146.8,
    });
    expect(run.by_span['stage.execute_agent']).toEqual({
      count: 2,
      total_duration_ms: 146.8,
      max_duration_ms: 100,
    });
    // span 之和会把父 span 一并算进去（loop_total 含 stage），墙钟只认根 span。
    expect(run.span_total_duration_ms).toBe(356.8);
    expect(run.wall_ms).toBe(200);
    // 覆盖 run 的只有根 span，其余都是它的子集，所以墙钟明显小于 span 之和。
    expect(renderConsumptionReport([run], { aggregate: false })).toContain('墙钟 200.0ms');
    expect(run.by_event_type).toEqual({ 'run.started': 1, 'handler.started': 1, 'run.completed': 1 });
    expect(run.telemetry_records).toEqual({ 'proxy.llm_usage_recorded': 1 });
  });

  it('degrades to event counts for a run written before the consumption block existed', async () => {
    const runsRoot = await createRunsRoot();
    await writeLegacyRun(runsRoot, 'run_legacy');

    const run = await collectRunConsumption(runsRoot, 'run_legacy');

    // 缺什么要如实标出来：看报告的人不能把「没有」读成「是 0」。
    expect(run.missing).toEqual(['consumption', 'latency', 'telemetry']);
    expect(run.by_stage).toEqual({});
    expect(run.by_span).toEqual({});
    expect(run.total_events).toBe(1);
    // 没有 consumption 时才退回运行级 token_usage。
    expect(run.total_tokens).toBe(42);
    expect(run.llm_calls).toBe(1);
    expect(run.span_total_duration_ms).toBe(0);
    expect(run).not.toHaveProperty('wall_ms');

    const rendered = renderConsumptionReport([run], { aggregate: false });
    expect(rendered).toContain('（无：该 run 没有 consumption 块');
    expect(rendered).toContain('（无：该 run 没有 latency.jsonl，只有事件计数）');
    expect(rendered).toContain('缺失信号：consumption / latency / telemetry（缺不等于 0）');
    expect(rendered).toContain('墙钟 -（无 run.loop_total');
  });

  it('skips unparseable jsonl lines instead of failing the whole report', async () => {
    const runsRoot = await createRunsRoot();
    await writeLegacyRun(runsRoot, 'run_torn');
    await writeFile(
      path.join(runsRoot, 'run_torn', 'latency.jsonl'),
      `${JSON.stringify({ name: 'stage.gate', duration_ms: 5 })}\n{"name":"stage.gate",`,
      'utf8',
    );

    const run = await collectRunConsumption(runsRoot, 'run_torn');

    expect(run.by_span['stage.gate']).toMatchObject({ count: 1, total_duration_ms: 5 });
  });

  it('reports a missing run directory as every signal being absent', async () => {
    const runsRoot = await createRunsRoot();

    const run = await collectRunConsumption(runsRoot, 'run_absent');

    expect(run.total_events).toBe(0);
    expect(run.missing).toEqual(['audit', 'consumption', 'latency', 'summary', 'telemetry']);
  });

  it('reports the dispatch block: summary, per-dispatch usage, and legacy unattributed', async () => {
    const runsRoot = await createRunsRoot();
    await writeDispatchRun(runsRoot, 'run_dispatch');

    const run = await collectRunConsumption(runsRoot, 'run_dispatch');

    // dispatch_summary 原样展示（不重新解释它的字段）。
    expect(run.dispatch.dispatch_summary).toMatchObject({
      total: 2,
      by_status: { succeeded: 1, unknown: 1 },
      unknown: { count: 1, dispatch_ids: ['dsp_2'] },
    });
    // 同 session 的累计更新取 max（300 而不是 100+300），重复输入不重复记账。
    expect(run.dispatch.usage_by_dispatch).toEqual({
      dsp_1: { context_tokens_used: 300, sessions: 1, complete: true },
      dsp_2: { context_tokens_used: 50, sessions: 1, complete: false },
    });
    // 没有 dispatch_id 的旧记录单独成块；没有这类记录时该字段缺席（另一条用例）。
    expect(run.dispatch.unattributed).toEqual({
      context_tokens_used: 10,
      sessions: 1,
      complete: true,
    });
    expect(run.dispatch.missing).toEqual([]);

    const rendered = renderConsumptionReport([run], { aggregate: false });
    expect(rendered).toContain('按派工 driver usage');
    expect(rendered).toContain('dsp_1');
    expect(rendered).toContain('无归属（legacy，无 dispatch_id）');
    expect(rendered).toContain('摘要：total=2');
  });

  it('keeps a legacy run honest: dispatch sources are missing, not zero', async () => {
    const runsRoot = await createRunsRoot();
    await writeLegacyRun(runsRoot, 'run_legacy');

    const run = await collectRunConsumption(runsRoot, 'run_legacy');

    expect(run.dispatch).toEqual({
      usage_by_dispatch: {},
      missing: ['dispatch_summary', 'driver_usage'],
    });
    expect(run.dispatch).not.toHaveProperty('unattributed');

    const rendered = renderConsumptionReport([run], { aggregate: false });
    expect(rendered).toContain('派工区块缺失：dispatch_summary / driver_usage（缺不等于 0）');
  });

  it('reports an affected run without crashing while another run keeps the dispatch data', async () => {
    const runsRoot = await createRunsRoot();
    await writeDispatchRun(runsRoot, 'run_dispatch');
    await writeLegacyRun(runsRoot, 'run_legacy');

    const dispatchFull = await collectRunConsumption(runsRoot, 'run_dispatch');
    const legacy = await collectRunConsumption(runsRoot, 'run_legacy');
    const totals = aggregateConsumption([dispatchFull, legacy]);

    // --all 不合并 per-run dispatch_summary（合并摘要等于编一个新的派工分母），但 usage 可以按
    // dispatch_id 相加；缺失信号取并集，缺的那 run 不会被读成 0。
    expect(totals.dispatch).not.toHaveProperty('dispatch_summary');
    expect(totals.dispatch.usage_by_dispatch).toEqual({
      dsp_1: { context_tokens_used: 300, sessions: 1, complete: true },
      dsp_2: { context_tokens_used: 50, sessions: 1, complete: false },
    });
    expect(totals.dispatch.missing).toEqual(['dispatch_summary', 'driver_usage']);
    expect(totals.dispatch.unattributed).toEqual({
      context_tokens_used: 10,
      sessions: 1,
      complete: true,
    });
  });
});

describe('aggregateConsumption', () => {
  it('sums per-run signals and unions what was missing', async () => {
    const runsRoot = await createRunsRoot();
    await writeCompleteRun(runsRoot, 'run_full');
    await writeLegacyRun(runsRoot, 'run_legacy');

    const runs = [
      await collectRunConsumption(runsRoot, 'run_full'),
      await collectRunConsumption(runsRoot, 'run_legacy'),
    ];
    const totals = aggregateConsumption(runs);

    expect(totals).toMatchObject({
      run_id: '*',
      total_events: 4,
      total_tokens: 200,
      llm_calls: 3,
      span_total_duration_ms: 356.8,
      wall_ms: 200,
    });
    expect(totals.by_stage.execute_agent).toMatchObject({ events: 2, duration_ms: 146.8 });
    expect(totals.by_span['agent.llm_round']).toMatchObject({ count: 1, max_duration_ms: 10 });
    expect(totals.missing).toEqual(['consumption', 'latency', 'telemetry']);

    const rendered = renderConsumptionReport(runs, { aggregate: true });
    expect(rendered).toContain('全部 2 个 run');
  });
});

describe('parseConsumptionCliArgs', () => {
  it('requires exactly one of --run / --all', () => {
    expect(() => parseConsumptionCliArgs([], {})).toThrow('需要 --run <run_id> 或 --all 之一');
    expect(parseConsumptionCliArgs(['--all'], {})).toMatchObject({ all: true, json: false });
    expect(parseConsumptionCliArgs(['--run', 'run_x', '--json'], {})).toMatchObject({
      runId: 'run_x',
      json: true,
    });
  });

  it('rejects unknown flags and flag-shaped values', () => {
    expect(() => parseConsumptionCliArgs(['--all', '--nope'], {})).toThrow('未知参数：--nope');
    expect(() => parseConsumptionCliArgs(['--run', '--all'], {})).toThrow('--run 需要一个 run_id');
  });

  it('defaults the runs root to the backend state root', () => {
    expect(parseConsumptionCliArgs(['--all'], { NEWIDE_STATE_ROOT: '/tmp/state' }).runsRoot).toBe(
      path.join(path.resolve('/tmp/state'), 'runs'),
    );
  });
});
