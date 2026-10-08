/**
 * 按 role 路由 driver 的测试（driver 可配置化 / facade 解析阶段）。
 *
 * 钉住三件事：
 * - 给了 `resolveDriver` 时，同一次 run 里不同 role 的 `invoke_driver` 落到不同 driver；
 * - `diagnostics.driver_id` 必须与**真正收到 prompt** 的那个 driver 一致——不能一个真跑、
 *   另一个只被记名；
 * - 不给 `resolveDriver` 时行为与历史一致：全部落到构造时那一个 driver。这条是
 *   「零配置不改变行为」在 facade 层的对应保证。
 */

import { describe, expect, it } from 'vitest';

import { DriverRuntimeAgentExecutionFacade } from '../../src/app/driver-runtime-agent-execution-facade';
import { SCHEMA_VERSION, nowTimestamp, type ArtifactRef } from '../../src/core';
import type {
  DriverCapabilities,
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle,
} from '../../src/driver';
import {
  InMemoryBufferRepository,
  InMemoryRepository,
  type ToolCallingClient,
} from '../../src/memory';

/** 记录收到过哪些 prompt，并回报自己的 driver_id 的桩驱动。 */
class StubDriver implements DriverRuntimeHandle {
  readonly prompts: DriverPrompt[] = [];
  readonly capabilities: DriverCapabilities = {
    supports_acp_extension: false,
    supports_structured_output: true,
    supports_session_load: true,
    supports_tool_events: false,
    supports_permission_events: false,
  };

  constructor(
    readonly driver_id: string,
    readonly session_id: string = `${driver_id}:session`,
  ) {}

  async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    this.prompts.push(input);
    const created_at = nowTimestamp();
    const transcript_ref: ArtifactRef = {
      artifact_id: `artifact_${this.driver_id}`,
      type: 'transcript',
      uri: `artifact://transcript/${this.driver_id}`,
      producer_id: this.driver_id,
      task_id: input.task_id,
      metadata: {},
      created_at,
      schema_version: SCHEMA_VERSION,
    };
    return {
      driver_run_result_id: `result_${this.driver_id}`,
      session_id: input.session_id ?? this.session_id,
      status: 'succeeded',
      response: `handled by ${this.driver_id}`,
      artifacts: [],
      transcript_ref,
      tool_events: [],
      diagnostics: { driver_id: this.driver_id, duration_ms: 1, notes: [] },
      created_at,
      schema_version: SCHEMA_VERSION,
    };
  }

  interrupt(): Promise<void> {
    return Promise.resolve();
  }

  collectTranscript(): Promise<ArtifactRef> {
    return Promise.reject(new Error('collectTranscript is not exercised in this test'));
  }
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

function createFacade(
  driver: DriverRuntimeHandle,
  resolveDriver?: (roleId: string, runId?: string) => DriverRuntimeHandle,
) {
  return new DriverRuntimeAgentExecutionFacade({
    driver,
    ...(resolveDriver ? { resolveDriver } : {}),
    repository: new InMemoryRepository(),
    bufferRepository: new InMemoryBufferRepository(),
    llm: invokeDriverLlm(),
  });
}

describe('per-role driver routing', () => {
  it('sends each role to the driver its mapping names', async () => {
    const claude = new StubDriver('driver_claude');
    const codex = new StubDriver('driver_codex');
    const facade = createFacade(claude, (roleId) =>
      roleId === 'reviewer' ? codex : claude,
    );

    const reviewed = await facade.runAgent(request('task_route', 'reviewer'));

    // 真正收到 prompt 的是 codex，claude 一次都没被打到
    expect(codex.prompts).toHaveLength(1);
    expect(claude.prompts).toHaveLength(0);
    // 而且记名与真跑必须是同一个
    expect(reviewed.diagnostics.driver_id).toBe('driver_codex');
  });

  it('routes two roles of the same task to two different drivers', async () => {
    const claude = new StubDriver('driver_claude');
    const codex = new StubDriver('driver_codex');
    const facade = createFacade(claude, (roleId) =>
      roleId === 'reviewer' ? codex : claude,
    );

    await facade.runAgent(request('task_two_roles', 'proposer'));
    await facade.runAgent(request('task_two_roles', 'reviewer'));

    expect(claude.prompts.map((prompt) => prompt.task_id)).toEqual(['task_two_roles']);
    expect(codex.prompts.map((prompt) => prompt.task_id)).toEqual(['task_two_roles']);
  });

  it('falls back to the default driver for an unmapped role', async () => {
    const claude = new StubDriver('driver_claude');
    const codex = new StubDriver('driver_codex');
    const facade = createFacade(claude, (roleId) =>
      roleId === 'reviewer' ? codex : claude,
    );

    const result = await facade.runAgent(request('task_default', 'proposer'));

    expect(claude.prompts).toHaveLength(1);
    expect(codex.prompts).toHaveLength(0);
    expect(result.diagnostics.driver_id).toBe('driver_claude');
  });

  it('keeps the historical single-driver behaviour when no resolver is configured', async () => {
    const only = new StubDriver('driver_solo');
    const facade = createFacade(only);

    const first = await facade.runAgent(request('task_solo', 'proposer'));
    const second = await facade.runAgent(request('task_solo', 'reviewer'));

    expect(only.prompts).toHaveLength(2);
    expect(first.diagnostics.driver_id).toBe('driver_solo');
    expect(second.diagnostics.driver_id).toBe('driver_solo');
  });

  it('reports the routed driver on the artifact producer, not the fallback', async () => {
    const claude = new StubDriver('driver_claude');
    const codex = new StubDriver('driver_codex');
    const facade = createFacade(claude, (roleId) =>
      roleId === 'reviewer' ? codex : claude,
    );

    const result = await facade.runAgent(request('task_producer', 'reviewer'));

    expect(result.transcript_ref?.producer_id).toBe('driver_codex');
  });

  it('passes the run id to the resolver', async () => {
    const claude = new StubDriver('driver_claude');
    const seen: Array<[string, string | undefined]> = [];
    const facade = createFacade(claude, (roleId, runId) => {
      seen.push([roleId, runId]);
      return claude;
    });

    await facade.runAgent(request('task_visible', 'proposer'));

    expect(seen).toContainEqual(['proposer', 'run_task_visible']);
  });

  it('keeps each run on the mapping it was created with', async () => {
    const claude = new StubDriver('driver_claude');
    const codex = new StubDriver('driver_codex');
    // run_a 冻结时 reviewer → codex；保存后 run_b 冻结到 reviewer → claude（跟随默认为 codex 的旧映射已经改掉）
    const frozen: Record<string, DriverRuntimeHandle> = { run_a: codex, run_b: claude };
    const facade = createFacade(claude, (_roleId, runId) =>
      runId ? (frozen[runId] ?? claude) : claude,
    );

    await facade.runAgent(request('a', 'reviewer'));
    await facade.runAgent(request('b', 'reviewer'));

    expect(codex.prompts.map((prompt) => prompt.task_id)).toEqual(['a']);
    expect(claude.prompts.map((prompt) => prompt.task_id)).toEqual(['b']);
  });
});
