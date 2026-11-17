/**
 * Codex rollout scrape: cumulative `total_token_usage` is taken once per session,
 * cached input is split out, and matching is strict (session id or workspace cwd).
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { collectCodexSessionUsage } from '../../src/telemetry';

const tempDirs: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeCodexHome(
  sessionId: string,
  cwd: string,
  totals: Array<{ input: number; cached: number; output: number }>,
): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
  tempDirs.push(home);
  const dir = path.join(home, 'sessions', '2026', '11', '17');
  await mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: { id: sessionId, cwd },
    }),
  ];
  for (const total of totals) {
    lines.push(
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: total.input,
              cached_input_tokens: total.cached,
              output_tokens: total.output,
              total_tokens: total.input + total.output,
            },
          },
        },
      }),
    );
  }
  await writeFile(
    path.join(dir, `rollout-2026-11-17T12-00-00-${sessionId}.jsonl`),
    `${lines.join('\n')}\n`,
    'utf8',
  );
  return home;
}

describe('collectCodexSessionUsage', () => {
  it('按会话 id 命中，取最后一条累计值并拆出缓存读', async () => {
    const sessionId = '01a1e7ae-bf09-7531-9543-b59acf8f42d0';
    const worktree = path.join(os.tmpdir(), 'worktree-x');
    process.env.CODEX_HOME = await makeCodexHome(sessionId, worktree, [
      { input: 500, cached: 400, output: 50 },
      { input: 1000, cached: 800, output: 120 },
    ]);

    const summary = await collectCodexSessionUsage({ sessionId, worktreePath: worktree });

    expect(summary.source).toBe('codex_jsonl');
    expect(summary.input_tokens).toBe(200);
    expect(summary.cache_read_input_tokens).toBe(800);
    expect(summary.cache_creation_input_tokens).toBe(0);
    expect(summary.output_tokens).toBe(120);
    expect(summary.total_tokens).toBe(1120);
    expect(summary.session_id).toBe(sessionId);
    expect(summary.by_session?.[sessionId]?.total_tokens).toBe(1120);
  });

  it('会话 id 不匹配时不读别的会话', async () => {
    const sessionId = '01a1e7ae-bf09-7531-9543-b59acf8f42d0';
    const worktree = path.join(os.tmpdir(), 'worktree-y');
    process.env.CODEX_HOME = await makeCodexHome(sessionId, worktree, [
      { input: 100, cached: 0, output: 10 },
    ]);

    const summary = await collectCodexSessionUsage({
      sessionId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      worktreePath: worktree,
    });

    expect(summary.total_tokens).toBe(0);
    expect(summary.call_count).toBe(0);
    expect(summary.source).toBe('unavailable');
  });

  it('没有会话 id 时按 session_meta 的 cwd 匹配工作区', async () => {
    const sessionId = '01a1e7ae-bf09-7531-9543-b59acf8f42d1';
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'ws-'));
    tempDirs.push(worktree);
    process.env.CODEX_HOME = await makeCodexHome(sessionId, worktree, [
      { input: 40, cached: 20, output: 4 },
    ]);

    const matched = await collectCodexSessionUsage({ worktreePath: worktree });
    const other = await collectCodexSessionUsage({ worktreePath: path.join(os.tmpdir(), 'nope') });

    expect(matched.total_tokens).toBe(44);
    expect(matched.session_id).toBe(sessionId);
    expect(other.total_tokens).toBe(0);
  });
});
