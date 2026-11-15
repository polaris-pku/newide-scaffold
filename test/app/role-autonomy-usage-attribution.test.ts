/**
 * 阶段 4（OBS-03）：role 自主循环的 LLM 用量归属。
 *
 * stage 2/3 的 stage 包装只把 `execute_agent` 放进归属域；role LLM 调用发生在引擎内部，
 * 如果 facade 不再套一层 `role_id`，这些 token 会只进 execute_agent 桶、在 role 维度永远缺席。
 * 本测试在真实 facade 边界上断言两层归属同时存在（叠加而不是覆盖），并检查账本行真的带上
 * role_id/stage_cursor（不是只断言调用过包装函数）。
 */
import { describe, expect, it } from 'vitest';
import { DriverRuntimeAgentExecutionFacade } from '../../src/app/driver-runtime-agent-execution-facade';
import type { RoleAutonomyEnginePort } from '../../src/app/role-autonomy-contract';
import { SCHEMA_VERSION } from '../../src/core';
import type { DriverRuntimeHandle } from '../../src/driver';
import { InMemoryBufferRepository, InMemoryRepository } from '../../src/memory';
import type { AgentExecutionResult } from '../../src/protocol/agent-execution';
import {
  getRunLlmUsageLedger,
  recordProxyLlmUsage,
  runWithLlmUsageAttribution,
  runWithLlmUsageLedger,
} from '../../src/telemetry';

const RUN_ID = 'run_role_usage';

function completedResult(): AgentExecutionResult {
  return {
    agent_run_id: 'agent_run_1',
    role_id: 'role_backend_engineer',
    context_pack_ref: 'context_pack_1',
    driver_run_result_id: 'driver_result_1',
    artifact_refs: [],
    transcript_ref: {
      artifact_id: 'artifact_1',
      type: 'transcript',
      uri: 'file:///tmp/transcript.json',
      producer_id: 'driver_test',
      created_at: '2026-11-15T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    },
    session_id: 'session_1',
    response: 'done',
    tool_events: [],
    diagnostics: {},
    status: 'completed',
    created_at: '2026-11-15T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

describe('role autonomy LLM usage attribution', () => {
  it('records role engine LLM usage under execute_agent + role_id without dropping the stage', async () => {
    let usagePromise: Promise<void> | undefined;
    const engine: RoleAutonomyEnginePort = {
      run: async () => {
        // 引擎内部真实发生的 proxy LLM 记账点（归属由外层作用域补全）。
        usagePromise = recordProxyLlmUsage({ input_tokens: 7, output_tokens: 3 });
        return completedResult();
      },
    };
    const facade = new DriverRuntimeAgentExecutionFacade({
      driver: { driver_id: 'driver_test' } as unknown as DriverRuntimeHandle,
      repository: new InMemoryRepository(),
      bufferRepository: new InMemoryBufferRepository(),
      roleAutonomy: engine,
    });

    await runWithLlmUsageLedger({ run_id: RUN_ID, case_id: 'phase4' }, async () => {
      // stage 层包装与 stage executor 的真实调用点同形（runStageWithAttribution）。
      await runWithLlmUsageAttribution({ stage_cursor: 'execute_agent' }, () =>
        facade.runAgent({
          task_id: 'task_1',
          run_id: RUN_ID,
          role_id: 'role_backend_engineer',
          instruction: 'implement the task',
          input_artifact_refs: [],
          context_policy: 'production_task_loop',
          execution_engine: 'role_autonomy',
          schema_version: SCHEMA_VERSION,
        }),
      );
    });
    await usagePromise;

    const ledger = getRunLlmUsageLedger(RUN_ID);
    expect(ledger?.entries).toHaveLength(1);
    expect(ledger?.entries[0]).toMatchObject({
      stage_cursor: 'execute_agent',
      role_id: 'role_backend_engineer',
      input_tokens: 7,
      output_tokens: 3,
    });
  });

  it('does not attribute legacy facade usage to a role id it never received', async () => {
    // 反例：engine 未装配时 role_autonomy 请求必须显式报错，而不是悄悄退化成 legacy 记账。
    const facade = new DriverRuntimeAgentExecutionFacade({
      driver: { driver_id: 'driver_test' } as unknown as DriverRuntimeHandle,
      repository: new InMemoryRepository(),
      bufferRepository: new InMemoryBufferRepository(),
    });
    await expect(
      facade.runAgent({
        task_id: 'task_1',
        run_id: RUN_ID,
        role_id: 'role_backend_engineer',
        instruction: 'implement the task',
        input_artifact_refs: [],
        context_policy: 'production_task_loop',
        execution_engine: 'role_autonomy',
        schema_version: SCHEMA_VERSION,
      }),
    ).rejects.toThrow(/no role autonomy engine wired/);
  });
});
