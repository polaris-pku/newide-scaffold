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

  it('counts an assistant message once when Claude Code writes the same message twice', async () => {
    const sandboxHome = await mkdtemp(path.join(os.tmpdir(), 'claude-sandbox-home-'));
    tempDirs.push(sandboxHome);
    const sessionId = 'session-dedup';
    const projectDir = path.join(sandboxHome, '.claude', 'projects', '-eval-dedup-primary');
    await mkdir(projectDir, { recursive: true });
    // 实测形状：同一轮 assistant 消息写两行，message.id 相同、uuid 不同、usage 一模一样。
    const line = (uuid: string): string =>
      JSON.stringify({
        type: 'assistant',
        uuid,
        sessionId,
        message: {
          id: 'msg_shared',
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 20,
          },
        },
      });
    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${line('uuid-a')}\n${line('uuid-b')}\n`,
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
      input_tokens: 100,
      cache_read_input_tokens: 20,
      total_tokens: 125,
      call_count: 1,
    });
  });

  it('still counts two different assistant messages separately', async () => {
    const sandboxHome = await mkdtemp(path.join(os.tmpdir(), 'claude-sandbox-home-'));
    tempDirs.push(sandboxHome);
    const sessionId = 'session-distinct';
    const projectDir = path.join(sandboxHome, '.claude', 'projects', '-eval-distinct-primary');
    await mkdir(projectDir, { recursive: true });
    const line = (id: string, input: number): string =>
      JSON.stringify({
        type: 'assistant',
        uuid: `uuid-${id}`,
        sessionId,
        message: {
          id,
          usage: {
            input_tokens: input,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
    await writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${line('msg_a', 10)}\n${line('msg_b', 20)}\n`,
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
      input_tokens: 30,
      output_tokens: 2,
      total_tokens: 32,
      call_count: 2,
    });
  });

  it('sums every driver session when the run had several', async () => {
    const sandboxHome = await mkdtemp(path.join(os.tmpdir(), 'claude-sandbox-home-'));
    tempDirs.push(sandboxHome);
    const writeSession = async (sessionId: string, projectName: string, input: number) => {
      const projectDir = path.join(sandboxHome, '.claude', 'projects', projectName);
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        path.join(projectDir, `${sessionId}.jsonl`),
        `${JSON.stringify({
          type: 'assistant',
          uuid: `uuid-${sessionId}`,
          sessionId,
          message: {
            id: `msg_${sessionId}`,
            usage: {
              input_tokens: input,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        })}\n`,
        'utf8',
      );
    };
    // council 的形态：每个角色一个 project 目录、一个 session。
    await writeSession('session-primary', '-eval-council-primary', 100);
    await writeSession('session-reviewer', '-eval-council-review', 200);

    process.env.ACP_PROCESS_SANDBOX_HOME = sandboxHome;
    process.env.HOME = path.join(sandboxHome, 'missing-user-home');
    delete process.env.USERPROFILE;

    const result = await collectClaudeSessionUsage({
      sessionIds: ['session-primary', 'session-reviewer'],
      worktreePath: '/tmp/does-not-match-project-encoding/repo',
    });

    expect(result).toMatchObject({
      input_tokens: 300,
      output_tokens: 2,
      total_tokens: 302,
      call_count: 2,
    });
    // 多会话时没有单一取值，不能随便挑一个冒充「这个 run 的 session」。
    expect(result.session_id).toBeUndefined();
    expect(result.session_path).toBeUndefined();
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
