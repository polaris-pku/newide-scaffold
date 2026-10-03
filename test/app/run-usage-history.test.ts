import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateUsageHistory,
  FileRunUsageHistoryReader,
  runUsageGapFacts,
  runUsageSummaryFacts,
} from '../../src/app/run-usage-history';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tokens(total: number, input = total, output = 0) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_input_tokens: input,
    total_tokens: total,
    call_count: 1,
  };
}

function summaryWith(input: {
  run_id: string;
  task_id: string;
  total?: number;
  by_source?: Record<string, unknown>;
  driver_billed?: number;
  without_usage?: boolean;
}): Record<string, unknown> {
  return {
    run_id: input.run_id,
    task_id: input.task_id,
    // driver_billed_usage 是 token_usage 里 claude_session_jsonl 腿的**视图**（子集），
    // 带上它是为了断言「不叠加」。
    ...(input.driver_billed !== undefined
      ? { driver_billed_usage: { metric: 'billed_tokens', ...tokens(input.driver_billed) } }
      : {}),
    ...(input.without_usage
      ? {}
      : {
          token_usage: {
            schema_version: 'newide.token_usage.v1',
            source: 'proxy',
            ...tokens(input.total ?? 0),
            sources: ['proxy'],
            by_source: input.by_source ?? { proxy: tokens(input.total ?? 0) },
          },
        }),
  };
}

function makeRunsRoot(): string {
  const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'newide-usage-history-'));
  temporaryDirectories.push(runsRoot);
  return runsRoot;
}

/**
 * 造一个 run 目录。`audit: true` 表示这个 run 确实执行过——`audit.jsonl` 在 `startStage`
 * 里写出，早于任何 executor，所以它是「执行过但没写 summary」与「从未推进」的唯一判据。
 */
function writeRunDir(
  runsRoot: string,
  runId: string,
  spec: { summary?: Record<string, unknown>; audit?: boolean; request?: Record<string, unknown> },
): void {
  const runDir = path.join(runsRoot, runId);
  mkdirSync(runDir, { recursive: true });
  if (spec.summary) writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(spec.summary));
  if (spec.audit) writeFileSync(path.join(runDir, 'audit.jsonl'), '');
  if (spec.request) writeFileSync(path.join(runDir, 'request.json'), JSON.stringify(spec.request));
}

describe('runUsageHistory', () => {
  it('filters the task scope and sums the system scope', () => {
    const facts = [
      runUsageSummaryFacts('run_a', summaryWith({ run_id: 'run_a', task_id: 'task_1', total: 100 })),
      runUsageSummaryFacts('run_b', summaryWith({ run_id: 'run_b', task_id: 'task_1', total: 50 })),
      runUsageSummaryFacts('run_c', summaryWith({ run_id: 'run_c', task_id: 'task_2', total: 7 })),
    ];

    const task = aggregateUsageHistory(facts, { scope: 'task', scope_id: 'task_1' }, 'T');
    expect(task.billed.totals.total_tokens).toBe(150);
    expect(task.runs_counted).toBe(2);
    expect(task.complete).toBe(true);
    expect(task.scope_id).toBe('task_1');

    expect(
      aggregateUsageHistory(facts, { scope: 'system' }, 'T').billed.totals.total_tokens,
    ).toBe(157);
  });

  it('never adds driver_billed_usage on top of token_usage', () => {
    // `driver_billed_usage` 是 `token_usage` 的 claude_session_jsonl 子集；
    // 两者相加就是重复计算，这是本模块最容易犯且最难发现的错。
    const facts = [
      runUsageSummaryFacts(
        'run_a',
        summaryWith({ run_id: 'run_a', task_id: 'task_1', total: 1000, driver_billed: 400 }),
      ),
    ];

    const history = aggregateUsageHistory(facts, { scope: 'task', scope_id: 'task_1' }, 'T');
    expect(history.billed.totals.total_tokens).toBe(1000);
  });

  it('reports runs with no usage instead of counting them as zero', () => {
    // 「缺 ≠ 0」：缺用量的 run 不贡献数字，而是把 complete 拉成 false 并留下计数。
    const facts = [
      runUsageSummaryFacts('run_a', summaryWith({ run_id: 'run_a', task_id: 't', total: 10 })),
      runUsageSummaryFacts(
        'run_b',
        summaryWith({ run_id: 'run_b', task_id: 't', without_usage: true }),
      ),
    ];

    const history = aggregateUsageHistory(facts, { scope: 'task', scope_id: 't' }, 'T');
    expect(history.billed.totals.total_tokens).toBe(10);
    expect(history.runs_counted).toBe(2);
    expect(history.runs_without_usage).toBe(1);
    expect(history.complete).toBe(false);
  });

  it('is not complete when nothing matched at all', () => {
    const history = aggregateUsageHistory([], { scope: 'task', scope_id: 'missing' }, 'T');
    expect(history.runs_counted).toBe(0);
    expect(history.complete).toBe(false);
    expect(history.billed.totals.total_tokens).toBe(0);
    // 没有任何 run 参与时按来源的分解是空对象，不是缺席——分解本身总是有意义的。
    expect(history.billed.by_source).toEqual({});
    expect(history.as_of).toBe('T');
  });

  it('splits by_source so the two legs stay distinguishable', () => {
    const facts = [
      runUsageSummaryFacts(
        'run_a',
        summaryWith({
          run_id: 'run_a',
          task_id: 't',
          total: 300,
          by_source: { proxy: tokens(100), claude_session_jsonl: tokens(200) },
        }),
      ),
    ];

    const history = aggregateUsageHistory(facts, { scope: 'task', scope_id: 't' }, 'T');
    expect(history.billed.totals.total_tokens).toBe(300);
    expect(history.billed.by_source.proxy?.total_tokens).toBe(100);
    expect(history.billed.by_source.claude_session_jsonl?.total_tokens).toBe(200);
  });

  it('skips directories that never advanced past run creation', async () => {
    // 只有 request.json 的目录不是 run——真实状态根里这种占大多数（582 个目录里 413 个）。
    // 把它们算成「没用量的 run」会让 complete 永远为 false，等于把信号淹掉。
    const runsRoot = makeRunsRoot();
    writeRunDir(runsRoot, 'run_a', {
      summary: summaryWith({ run_id: 'run_a', task_id: 'task_1', total: 120 }),
    });
    writeRunDir(runsRoot, 'run_never_advanced', { request: { task_id: 'task_1' } });

    const reader = new FileRunUsageHistoryReader(runsRoot, () => '2026-10-03T00:00:00.000Z');
    const history = await reader.read({ scope: 'system' });

    expect(history.runs_counted).toBe(1);
    expect(history.runs_without_usage).toBe(0);
    expect(history.complete).toBe(true);
    expect(history.billed.totals.total_tokens).toBe(120);
    expect(history.as_of).toBe('2026-10-03T00:00:00.000Z');
  });

  it('counts an executed run that never wrote a summary as a known gap', async () => {
    // 进程被杀 / 中断后没恢复：audit.jsonl 在，summary.json 永远不会有。花销读不出来，
    // 但绝不能因此让 complete 报 true——那才是本模块要防的失效模式。
    const runsRoot = makeRunsRoot();
    writeRunDir(runsRoot, 'run_a', {
      summary: summaryWith({ run_id: 'run_a', task_id: 'task_1', total: 120 }),
    });
    writeRunDir(runsRoot, 'run_interrupted', { audit: true, request: { task_id: 'task_1' } });

    const reader = new FileRunUsageHistoryReader(runsRoot, () => 'T');
    const history = await reader.read({ scope: 'system' });

    expect(history.runs_counted).toBe(2);
    expect(history.runs_without_usage).toBe(1);
    expect(history.complete).toBe(false);
    // 缺口不贡献数字：总量仍只有能读到的那一份。
    expect(history.billed.totals.total_tokens).toBe(120);
  });

  it('attributes an unsummarized gap to its task through request.json', async () => {
    const runsRoot = makeRunsRoot();
    writeRunDir(runsRoot, 'run_other', {
      summary: summaryWith({ run_id: 'run_other', task_id: 'task_other', total: 999 }),
    });
    writeRunDir(runsRoot, 'run_interrupted', { audit: true, request: { task_id: 'task_1' } });

    const reader = new FileRunUsageHistoryReader(runsRoot, () => 'T');
    const task = await reader.read({ scope: 'task', scope_id: 'task_1' });

    expect(task.runs_counted).toBe(1);
    expect(task.runs_without_usage).toBe(1);
    expect(task.complete).toBe(false);
    expect(task.billed.totals.total_tokens).toBe(0);
    // 别的 task 的 run 不该被卷进来。
    const other = await reader.read({ scope: 'task', scope_id: 'task_other' });
    expect(other.billed.totals.total_tokens).toBe(999);
    expect(other.complete).toBe(true);
  });

  it('keeps a gap it cannot attribute out of every task scope', async () => {
    // 已知限制：没有 request.json 就没有归属来源，task 查询看不见这条缺口，于是它对每个
    // task 都声称完整。这是**被断言的限制**，不是被忽略的行为——system 作用域必须看见它。
    const runsRoot = makeRunsRoot();
    writeRunDir(runsRoot, 'run_a', {
      summary: summaryWith({ run_id: 'run_a', task_id: 'task_1', total: 120 }),
    });
    writeRunDir(runsRoot, 'run_unattributable', { audit: true });

    const reader = new FileRunUsageHistoryReader(runsRoot, () => 'T');

    const task = await reader.read({ scope: 'task', scope_id: 'task_1' });
    expect(task.runs_counted).toBe(1);
    expect(task.complete).toBe(true);

    const system = await reader.read({ scope: 'system' });
    expect(system.runs_counted).toBe(2);
    expect(system.runs_without_usage).toBe(1);
    expect(system.complete).toBe(false);
  });

  it('builds a gap fact without tokens', () => {
    const attributed = runUsageGapFacts('run_x', { task_id: 'task_1' });
    expect(attributed).toEqual({ run_id: 'run_x', task_id: 'task_1' });
    // 缺口不折算成 0：没有 tokens 字段本身就是「缺」的表示。
    expect(attributed.tokens).toBeUndefined();

    // 没有 request.json（或里面没有 task_id）时不编造归属。
    expect(runUsageGapFacts('run_y', undefined)).toEqual({ run_id: 'run_y' });
    expect(runUsageGapFacts('run_z', { task_id: '' })).toEqual({ run_id: 'run_z' });
  });

  it('returns an empty, incomplete history when the runs root does not exist', async () => {
    const reader = new FileRunUsageHistoryReader(
      path.join(os.tmpdir(), 'newide-usage-history-absent-root'),
      () => 'T',
    );
    const history = await reader.read({ scope: 'system' });

    expect(history.runs_counted).toBe(0);
    expect(history.complete).toBe(false);
  });
});
