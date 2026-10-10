/**
 * 按 role 切换 driver 的 spawn 身份测试（driver 可配置化 / 取证层）。
 *
 * `driver-registry.test.ts` 钉住的是「transport 收到什么参数」，
 * `driver-per-role-routing.test.ts` 钉住的是「facade 把 role 解析给哪个 handle」。
 * 两者之间还有一个缺口：**子进程自己收到的 agent 是谁**。本文件补这个缺口，两层取证：
 *
 * 1. 注入式 transport：记录每个 driver 的 spawn 参数（`env.ACP_AGENT_ID`），并让桩结果把
 *    「我收到的 agent」原样回报到 `diagnostics.driver_id`（真实 A 侧就是这么填的），断言
 *    `role_primary` 与 `reviewer` 各走各的 runtime、没有共用错误的 driver；
 * 2. 真实 spawn：用仓库自带的 `CommandDriverTransport` 真的起一个 node 子进程，由
 *    **子进程把自己环境变量里的 `ACP_AGENT_ID` 写到磁盘**，再断言落盘内容与 role 期望一致。
 *    YAML 里写了什么不算证据，子进程收到什么才算。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { DriverRuntimeAgentExecutionFacade } from '../../src/app/driver-runtime-agent-execution-facade';
import { SCHEMA_VERSION, nowTimestamp, type ArtifactRef } from '../../src/core';
import {
  CommandDriverTransport,
  createDriverRegistry,
  parseDriverConfig,
  type CommandDriverTransportOptions,
  type DriverConfig,
} from '../../src/driver';
import {
  InMemoryBufferRepository,
  InMemoryRepository,
  type ToolCallingClient,
} from '../../src/memory';

const ENTRY_RELATIVE = path.join('dist', 'src', 'driver', 'contract-runner.js');
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'newide-driver-spawn-identity-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * 两个 driver 档案 + 一条 role 映射。
 *
 * role 名用生产里真实出现的形态（`role_*` 是 B 侧 role_id，`reviewer` 是显式映射），
 * 验证的是「role → driver」这条映射在装配层与执行层之间的同一性。
 */
const config: DriverConfig = parseDriverConfig({
  default_driver: 'claude',
  drivers: {
    claude: { agent: 'claude' },
    codex: { agent: 'codex' },
  },
  roles: { reviewer: 'codex' },
});

function transcriptRef(driverId: string, taskId: string): ArtifactRef {
  return {
    artifact_id: `artifact_${driverId}`,
    type: 'transcript',
    uri: `artifact://transcript/${driverId}`,
    producer_id: driverId,
    task_id: taskId,
    metadata: {},
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

/** 第一轮调 invoke_driver，拿到工具结果后收尾——与生产路径的调用形态一致。 */
function invokeDriverLlm(): ToolCallingClient {
  let sequence = 0;
  return {
    async completeWithTools(input) {
      if (input.messages.at(-1)?.role === 'tool') {
        return { content: 'Task completed. [done]', tool_calls: undefined };
      }
      sequence += 1;
      return {
        content: null,
        tool_calls: [
          {
            id: `tool_call_${String(sequence)}`,
            type: 'function',
            function: {
              name: 'invoke_driver',
              arguments: JSON.stringify({ instruction: 'Execute through the routed driver.' }),
            },
          },
        ],
      };
    },
  };
}

function request(taskId: string, roleId: string) {
  return {
    task_id: taskId,
    run_id: `run_${taskId}`,
    role_id: roleId,
    instruction: 'Execute through B runtime.',
    input_artifact_refs: [],
    context_policy: 'default',
    schema_version: SCHEMA_VERSION,
  };
}

function facadeFor(registry: ReturnType<typeof createDriverRegistry>) {
  return new DriverRuntimeAgentExecutionFacade({
    driver: registry.get(registry.default_driver),
    resolveDriver: (roleId) => registry.resolveForRole(roleId).handle,
    repository: new InMemoryRepository(),
    bufferRepository: new InMemoryBufferRepository(),
    llm: invokeDriverLlm(),
  });
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('driver identity per role (recorded spawn params)', () => {
  const spawnRecords: CommandDriverTransportOptions[] = [];

  it('hands each role a distinct runtime whose spawn env names that role agent', async () => {
    const registry = createDriverRegistry({
      config,
      runnerDir: makeRunnerDirWithEntry(),
      defaultEntryRelative: ENTRY_RELATIVE,
      baseEnv: { ACP_WORKSPACE: '/ws' },
      parentEnv: {},
      createTransport: (options) => {
        spawnRecords.push(options);
        const declaredAgent = options.env?.ACP_AGENT_ID ?? '';
        return {
          // 桩结果把「我收到的 agent」写进 diagnostics.driver_id，
          // 对应真实 A 侧 contract-runner 的 `driver_id: params.agentId`。
          invoke: async (input) => ({
            driver_run_result_id: `result_${declaredAgent}`,
            session_id: `session_${declaredAgent}`,
            status: 'succeeded' as const,
            response: `handled by ${declaredAgent}. [done]`,
            artifacts: [],
            transcript_ref: transcriptRef(declaredAgent, input.task_id),
            tool_events: [],
            diagnostics: {
              driver_id: declaredAgent,
              duration_ms: 1,
              notes: [`agent_id=${declaredAgent}`],
            },
            created_at: nowTimestamp(),
            schema_version: SCHEMA_VERSION,
          }),
        };
      },
    });

    const facade = facadeFor(registry);
    const primary = await facade.runAgent(request('task_identity', 'role_primary'));
    const reviewer = await facade.runAgent(request('task_identity', 'reviewer'));

    // 执行事件里的 driver_id 必须与 role 的映射一致。
    expect(primary.diagnostics.driver_id).toBe('claude');
    expect(reviewer.diagnostics.driver_id).toBe('codex');

    // 两次执行各自打到各自的 transport：spawn 参数按顺序是 claude、codex，没有串台。
    expect(spawnRecords.map((options) => options.env?.ACP_AGENT_ID)).toEqual(['claude', 'codex']);
    expect(new Set(spawnRecords).size).toBe(2);

    // 档案侧的同一性：driver_id → agent 的对应不能被装配丢掉。
    expect(registry.profileOf('claude').agent).toBe('claude');
    expect(registry.profileOf('codex').agent).toBe('codex');
    expect(registry.resolveForRole('role_primary').driver_id).toBe('claude');
    expect(registry.resolveForRole('reviewer').driver_id).toBe('codex');
  });
});

describe('driver identity per role (real subprocess spawn)', () => {
  it('delivers the profile agent to the child process, per role', async () => {
    const runnerDir = makeTempDir();
    const entryPath = path.join(runnerDir, ENTRY_RELATIVE);
    const envLogPath = path.join(runnerDir, 'received-env.jsonl');
    mkdirSync(path.dirname(entryPath), { recursive: true });
    writeFileSync(entryPath, recordingRunnerSource(envLogPath), 'utf8');

    const registry = createDriverRegistry({
      config,
      runnerDir,
      defaultEntryRelative: ENTRY_RELATIVE,
      baseEnv: { ACP_WORKSPACE: runnerDir, DRIVER_PROBE_MARKER: 'shared-base' },
      parentEnv: {},
      inactivityTimeoutMs: 60_000,
      // 用生产 transport 本体：这里要的就是真 spawn。
      createTransport: (options) => new CommandDriverTransport(options),
    });

    try {
      const facade = facadeFor(registry);
      const primary = await facade.runAgent(request('task_spawn', 'role_primary'));
      const reviewer = await facade.runAgent(request('task_spawn', 'reviewer'));

      expect(primary.diagnostics.driver_id).toBe('claude');
      expect(reviewer.diagnostics.driver_id).toBe('codex');

      const received = readFileSync(envLogPath, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { ACP_AGENT_ID: string; task_id: string });

      // 子进程自报：primary 那次 spawn 收到 claude，reviewer 那次收到 codex。
      expect(received.map((entry) => entry.ACP_AGENT_ID)).toEqual(['claude', 'codex']);
      expect(new Set(received.map((entry) => entry.ACP_AGENT_ID)).size).toBe(2);
    } finally {
      await registry.shutdown().catch(() => undefined);
    }
  });
});

function makeRunnerDirWithEntry(): string {
  const dir = makeTempDir();
  const entry = path.join(dir, ENTRY_RELATIVE);
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, '// not spawned: this case injects a recording transport\n', 'utf8');
  return dir;
}

/**
 * 录制桩 contract-runner（CJS，被 `node <entry>` 直接跑）。
 *
 * 它把**自己进程环境里的** `ACP_AGENT_ID` 与收到的 prompt 落盘，再按跨仓契约在 stdout 末行
 * 回一个 DriverRunResult；`diagnostics.driver_id` 取的就是那个环境变量。
 */
function recordingRunnerSource(logPath: string): string {
  const safeLogPath = JSON.stringify(logPath.replace(/\\/g, '/'));
  return `const fs = require('node:fs');
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { body += chunk; });
process.stdin.on('end', () => {
  const agent = process.env.ACP_AGENT_ID;
  const input = JSON.parse(body);
  fs.appendFileSync(${safeLogPath}, JSON.stringify({
    ACP_AGENT_ID: agent ?? null,
    marker: process.env.DRIVER_PROBE_MARKER ?? null,
    task_id: input.task_id,
    cwd: process.cwd(),
  }) + '\\n');
  const created_at = new Date().toISOString();
  const transcript_ref = {
    artifact_id: 'artifact_spawn_' + agent,
    type: 'transcript',
    uri: 'artifact://transcript/spawn_' + agent,
    producer_id: String(agent),
    task_id: input.task_id,
    metadata: {},
    created_at,
    schema_version: input.schema_version,
  };
  const result = {
    driver_run_result_id: 'driver_result_spawn_' + agent,
    session_id: 'session_spawn_' + agent,
    status: 'succeeded',
    response: 'SPAWN_OK from ' + agent + '. [done]',
    artifacts: [],
    transcript_ref,
    tool_events: [],
    diagnostics: { driver_id: agent, duration_ms: 1, notes: ['agent_id=' + agent] },
    created_at,
    schema_version: input.schema_version,
  };
  process.stdout.write(JSON.stringify(result) + '\\n');
});
`;
}
