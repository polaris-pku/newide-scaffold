import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeBilledTokenUsage } from '../../src/app/run-token-usage-merge';
import { FileRunTerminalOutputWriter } from '../../src/app/run-terminal-output-writer';
import type { AppRunSnapshot } from '../../src/app/run-registry';
import { emptyTokenUsageSummary, toRunTokenUsageSummary } from '../../src/telemetry';

const tempDirs: string[] = [];

/** driver 侧刮出来的那部分：input+cache_read 进 total_input，再加 output。两个会话各一条。 */
const CLAUDE_SCRAPED = {
  ...toRunTokenUsageSummary([
    {
      input_tokens: 3000,
      output_tokens: 300,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1200,
      source: 'claude_session_jsonl',
      recorded_at: '2026-09-19T00:00:00.000Z',
    },
    {
      input_tokens: 2000,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 800,
      source: 'claude_session_jsonl',
      recorded_at: '2026-09-19T00:00:01.000Z',
    },
  ]),
  by_session: {
    session_a: {
      session_id: 'session_a',
      input_tokens: 3000,
      output_tokens: 300,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1200,
      total_input_tokens: 4200,
      total_tokens: 4500,
      call_count: 1,
    },
    session_b: {
      session_id: 'session_b',
      input_tokens: 2000,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 800,
      total_input_tokens: 2800,
      total_tokens: 3000,
      call_count: 1,
    },
  },
};
const CLAUDE_SCRAPED_TOTAL = 5000 + 2000 + 500;

const PROXY_TOKEN_USAGE = {
  schema_version: 'newide.token_usage.v1',
  source: 'proxy',
  input_tokens: 1200,
  output_tokens: 300,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  total_input_tokens: 1200,
  total_tokens: 1500,
  call_count: 3,
  sources: ['proxy'],
  by_source: {},
};

async function makeRunsRoot(): Promise<string> {
  const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'token-merge-'));
  tempDirs.push(runsRoot);
  return runsRoot;
}

async function writeSummary(
  runsRoot: string,
  runId: string,
  tokenUsage: unknown,
  extras: Record<string, unknown> = {},
): Promise<string> {
  const runDir = path.join(runsRoot, runId);
  await mkdir(runDir, { recursive: true });
  const summaryPath = path.join(runDir, 'summary.json');
  await writeFile(
    summaryPath,
    `${JSON.stringify(
      {
        run_id: runId,
        task_id: 'task_merge',
        session_id: 'session_a',
        worktree_path: '/tmp/worktree',
        ...(tokenUsage === undefined ? {} : { token_usage: tokenUsage }),
        ...extras,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return summaryPath;
}

describe('mergeBilledTokenUsage', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('merges driver billed tokens on top of the existing proxy leg', async () => {
    const runsRoot = await makeRunsRoot();
    const summaryPath = await writeSummary(runsRoot, 'run_merge', PROXY_TOKEN_USAGE);
    const collect = vi.fn(async () => CLAUDE_SCRAPED);

    const result = await mergeBilledTokenUsage(summaryPath, collect);

    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: '/tmp/worktree',
        sessionId: 'session_a',
      }),
    );
    expect(result).toMatchObject({
      status: 'merged',
      total_tokens_before: 1500,
      total_tokens_after: 1500 + CLAUDE_SCRAPED_TOTAL,
    });
    const written = JSON.parse(await readFile(summaryPath, 'utf8')) as {
      token_usage: { source: string; total_tokens: number; by_source: Record<string, unknown> };
    };
    expect(written.token_usage.total_tokens).toBe(1500 + CLAUDE_SCRAPED_TOTAL);
    expect(written.token_usage.source).toBe('mixed');
    expect(Object.keys(written.token_usage.by_source).sort()).toEqual([
      'claude_session_jsonl',
      'proxy',
    ]);
  });

  it('leaves the file untouched when the scrape returns nothing', async () => {
    const runsRoot = await makeRunsRoot();
    const summaryPath = await writeSummary(runsRoot, 'run_empty', PROXY_TOKEN_USAGE);
    const before = await readFile(summaryPath, 'utf8');

    const result = await mergeBilledTokenUsage(summaryPath, async () => emptyTokenUsageSummary());

    expect(result).toMatchObject({
      status: 'skipped_no_session_usage',
      total_tokens_before: 1500,
      total_tokens_after: 1500,
    });
    expect(await readFile(summaryPath, 'utf8')).toBe(before);
  });

  it('scrapes every driver session the run reported, not just the primary one', async () => {
    const runsRoot = await makeRunsRoot();
    const summaryPath = await writeSummary(runsRoot, 'run_multi', PROXY_TOKEN_USAGE, {
      driver_context_usage: {
        available: true,
        source: 'driver_stream_usage_update',
        metric: 'context_tokens_used',
        context_tokens_used: 10,
        reported_costs: [],
        sessions: [{ session_id: 'session_a' }, { session_id: 'session_b' }],
        complete: true,
      },
    });
    const collect = vi.fn(async () => CLAUDE_SCRAPED);

    await mergeBilledTokenUsage(summaryPath, collect);

    // session_id 是 'session_a'（writeSummary 默认），driver_context_usage 里还有 session_b。
    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIds: ['session_a', 'session_b'] }),
    );
  });

  it('still collects session ids from the legacy driver_usage block', async () => {
    const runsRoot = await makeRunsRoot();
    const summaryPath = await writeSummary(runsRoot, 'run_legacy', PROXY_TOKEN_USAGE, {
      driver_usage: {
        available: true,
        source: 'driver_stream_usage_update',
        metric: 'context_tokens_used',
        context_tokens_used: 10,
        reported_costs: [],
        sessions: [{ session_id: 'session_a' }, { session_id: 'session_b' }],
      },
    });
    const collect = vi.fn(async () => CLAUDE_SCRAPED);

    await mergeBilledTokenUsage(summaryPath, collect);

    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIds: ['session_a', 'session_b'] }),
    );
  });

  it('writes driver_billed_usage with per-session billed detail and roles', async () => {
    const runsRoot = await makeRunsRoot();
    const summaryPath = await writeSummary(runsRoot, 'run_billed', PROXY_TOKEN_USAGE, {
      driver_context_usage: {
        available: true,
        source: 'driver_stream_usage_update',
        metric: 'context_tokens_used',
        context_tokens_used: 40,
        reported_costs: [{ amount: 0.5, currency: 'USD' }],
        sessions: [
          {
            session_id: 'session_a',
            role_id: 'role_a',
            context_tokens_used: 10,
            reported_cost: { amount: 0.5, currency: 'USD' },
            complete: true,
          },
          { session_id: 'session_b', role_id: 'role_b', context_tokens_used: 30, complete: true },
        ],
        complete: true,
      },
    });

    await mergeBilledTokenUsage(summaryPath, async () => CLAUDE_SCRAPED);

    const written = JSON.parse(await readFile(summaryPath, 'utf8')) as {
      driver_billed_usage: Record<string, unknown>;
    };
    expect(written.driver_billed_usage).toMatchObject({
      source: 'claude_session_jsonl',
      metric: 'billed_tokens',
      input_tokens: 5000,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2000,
      total_input_tokens: 7000,
      total_tokens: 7500,
      call_count: 2,
      reported_costs: [{ amount: 0.5, currency: 'USD' }],
    });
    // 逐会话：实际计费 + role_id + 自报成本并排，与 context 占用是两个口径。
    expect(written.driver_billed_usage.sessions).toEqual([
      {
        session_id: 'session_a',
        input_tokens: 3000,
        output_tokens: 300,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1200,
        total_input_tokens: 4200,
        total_tokens: 4500,
        call_count: 1,
        role_id: 'role_a',
        reported_cost: { amount: 0.5, currency: 'USD' },
      },
      {
        session_id: 'session_b',
        input_tokens: 2000,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 800,
        total_input_tokens: 2800,
        total_tokens: 3000,
        call_count: 1,
        role_id: 'role_b',
      },
    ]);
  });

  it('omits driver_billed_usage when the scrape has no per-session detail', async () => {
    const runsRoot = await makeRunsRoot();
    const summaryPath = await writeSummary(runsRoot, 'run_noby', PROXY_TOKEN_USAGE);

    await mergeBilledTokenUsage(summaryPath, async () =>
      toRunTokenUsageSummary([
        {
          input_tokens: 100,
          output_tokens: 10,
          source: 'claude_session_jsonl',
          recorded_at: '2026-09-19T00:00:00.000Z',
        },
      ]),
    );

    const written = JSON.parse(await readFile(summaryPath, 'utf8')) as Record<string, unknown>;
    expect(written.driver_billed_usage).toBeUndefined();
    expect(written.token_usage.total_tokens).toBe(1500 + 110);
  });

  it('is idempotent: merging twice does not count the same tokens twice', async () => {
    const runsRoot = await makeRunsRoot();
    const summaryPath = await writeSummary(runsRoot, 'run_twice', PROXY_TOKEN_USAGE);
    const collect = vi.fn(async () => CLAUDE_SCRAPED);

    const first = await mergeBilledTokenUsage(summaryPath, collect);
    const second = await mergeBilledTokenUsage(summaryPath, collect);

    expect(first.status).toBe('merged');
    expect(second.status).toBe('already_merged');
    // 第二次连刮都不该刮：driver 那一腿已经在了。
    expect(collect).toHaveBeenCalledTimes(1);
    const written = JSON.parse(await readFile(summaryPath, 'utf8')) as {
      token_usage: { total_tokens: number };
    };
    expect(written.token_usage.total_tokens).toBe(1500 + CLAUDE_SCRAPED_TOTAL);
  });

  it('skips and does not scrape when the summary has no worktree_path', async () => {
    const runsRoot = await makeRunsRoot();
    const summaryPath = await writeSummary(runsRoot, 'run_nowt', PROXY_TOKEN_USAGE, {
      worktree_path: undefined,
    });
    const collect = vi.fn(async () => CLAUDE_SCRAPED);

    const result = await mergeBilledTokenUsage(summaryPath, collect);

    expect(result.status).toBe('skipped_no_worktree');
    expect(collect).not.toHaveBeenCalled();
  });

  it('reports unchanged rather than throwing when summary.json is missing', async () => {
    const runsRoot = await makeRunsRoot();

    const result = await mergeBilledTokenUsage(path.join(runsRoot, 'run_absent', 'summary.json'));

    expect(result).toEqual({ status: 'unchanged', total_tokens_before: 0, total_tokens_after: 0 });
  });
});

describe('FileRunTerminalOutputWriter driver billed tokens', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('folds driver billed tokens into token_usage at finalize', async () => {
    const runsRoot = await makeRunsRoot();
    const summaryPath = await writeSummary(runsRoot, 'run_failed', PROXY_TOKEN_USAGE);
    const collect = vi.fn(async () => CLAUDE_SCRAPED);

    await new FileRunTerminalOutputWriter(runsRoot, undefined, collect).finalize(failedSnapshot());

    expect(collect).toHaveBeenCalledTimes(1);
    const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as {
      token_usage: { sources: string[]; total_tokens: number };
    };
    expect([...summary.token_usage.sources].sort()).toEqual(['claude_session_jsonl', 'proxy']);
    expect(summary.token_usage.total_tokens).toBe(1500 + CLAUDE_SCRAPED_TOTAL);
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
