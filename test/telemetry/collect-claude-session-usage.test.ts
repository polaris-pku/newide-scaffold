import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectClaudeSessionUsage } from '../../src/telemetry/collect-claude-session-usage';

const tempDirs: string[] = [];
const originalHome = {
  ACP_PROCESS_SANDBOX_HOME: process.env.ACP_PROCESS_SANDBOX_HOME,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  restoreEnv('ACP_PROCESS_SANDBOX_HOME', originalHome.ACP_PROCESS_SANDBOX_HOME);
  restoreEnv('HOME', originalHome.HOME);
  restoreEnv('USERPROFILE', originalHome.USERPROFILE);
});

describe('collectClaudeSessionUsage', () => {
  it('reads session jsonl from ACP_PROCESS_SANDBOX_HOME even when worktree encoding does not match', async () => {
    const sandboxHome = await mkdtemp(path.join(os.tmpdir(), 'claude-sandbox-home-'));
    tempDirs.push(sandboxHome);
    const sessionId = 'session-sandbox-usage';
    const projectDir = path.join(
      sandboxHome,
      '.claude',
      'projects',
      '-eval-council-primary',
    );
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: 'assistant',
        sessionId,
        message: {
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      })}\n`,
      'utf8',
    );

    process.env.ACP_PROCESS_SANDBOX_HOME = sandboxHome;
    process.env.HOME = path.join(sandboxHome, 'missing-user-home');
    delete process.env.USERPROFILE;

    await expect(
      collectClaudeSessionUsage({
        sessionId,
        worktreePath: '/tmp/does-not-match-project-encoding/repo',
      }),
    ).resolves.toMatchObject({
      source: 'claude_session_jsonl',
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      call_count: 1,
      session_id: sessionId,
    });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
