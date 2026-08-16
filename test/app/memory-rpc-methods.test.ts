/**
 * memory.* RPC 接线测试（技能市场 + Agent 退休）
 *
 * 用例一：InMemory 仓库 + 真 AgentManager（mock LLM）+ 真实 BMemoryBackendService，
 * 验证 `memory.marketSearch` / `memory.marketImport` / `memory.retireAgent`
 * 从协议层一路委托到仓库/服务层的完整链路。
 *
 * 用例二：真 DriverRuntimeAgentExecutionFacade（CapturingDriver）+ 真 NewideBackendService
 * 转发，验证 `memory.retireAgent` 走完 facade → AgentManager 的生产路径，以及
 * `memory.marketImport` 走 NewideBackendService 转发。
 *
 * 运行：`pnpm vitest run test/app/memory-rpc-methods.test.ts`
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BMemoryBackendService } from '../../src/app/b-memory-backend-service';
import type { BMemoryMaintenanceCapabilities } from '../../src/app/b-public-capabilities';
import { DriverRuntimeAgentExecutionFacade } from '../../src/app/driver-runtime-agent-execution-facade';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { SCHEMA_VERSION, nowTimestamp, type ArtifactRef } from '../../src/core';
import type {
  DriverCapabilities,
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle,
} from '../../src/driver';
import {
  AgentManager,
  HashEmbeddingProvider,
  InMemoryBufferRepository,
  InMemoryRepository,
  MARKET_POOL_ROLE_ID,
  RepositoryAgentBoardQuery,
} from '../../src/memory';
import type { SkillRecord } from '../../src/memory/schemas';
import { JsonRpcDispatcher, JsonRpcLineSession } from '../../src/rpc/json-rpc-dispatcher';
import { MemoryRpcMethods } from '../../src/rpc/memory-methods';

describe('memory RPC market and retire wiring', () => {
  it('exposes market search/import and retire through a real AgentManager', async () => {
    const embedding = new HashEmbeddingProvider(32);
    const repository = new InMemoryRepository(embedding);
    const bufferRepository = new InMemoryBufferRepository();
    await repository.initializeAgent({ role_id: 'role_alpha', name: 'Alpha', tags: ['typescript'] });
    await repository.initializeAgent({ role_id: 'role_beta', name: 'Beta', tags: [] });

    const manager = await AgentManager.create(repository, bufferRepository, {
      tools: {
        llm: {
          completeWithTools: async () => ({
            content: 'Task completed. [done]',
            tool_calls: undefined,
          }),
        },
        tools: [],
        maxToolCalls: 1,
      },
      embedding,
    });

    const alphaSkill = await seedSkill(
      repository,
      'role_alpha',
      'TypeScript service contract patterns',
    );
    const betaSkill = await seedSkill(
      repository,
      'role_beta',
      'TypeScript compiler optimization',
    );

    const service = new BMemoryBackendService(
      { boardQuery: new RepositoryAgentBoardQuery(repository), maintenance: fakeMaintenance() },
      { provider: 'HashEmbeddingProvider', dimensions: 32, readiness: 'verified' },
      repository,
      {
        retireAgent: (roleId, options) => manager.retireAgent(roleId, options),
        runRetirementScan: (roleId) => manager.scanForRetirements(roleId),
      },
      embedding,
    );

    const output: string[] = [];
    const session = new JsonRpcLineSession(dispatcherFor(service), (line) => output.push(line));
    const send = async (...lines: string[]) => {
      output.length = 0;
      for (const line of lines) await session.handleLine(line);
      return output.map((line) => JSON.parse(line) as Record<string, unknown>);
    };

    // capabilities 报告三项新能力可用
    const [capabilities] = await send(
      '{"jsonrpc":"2.0","id":0,"method":"memory.getCapabilities","params":{}}',
    );
    expect(capabilities!).toMatchObject({
      id: 0,
      result: {
        capabilities: {
          operations: {
            market_search: { status: 'available' },
            market_import: { status: 'available' },
            retire_agent: { status: 'available' },
            retirement_scan: { status: 'available' },
          },
        },
      },
    });

    // marketSearch：全库召回 / exclude_agent_id 排除调用方 / top_k 截断
    const [searchAll, searchExcluded, searchTop1] = await send(
      '{"jsonrpc":"2.0","id":1,"method":"memory.marketSearch","params":{"query":"typescript","min_similarity":0}}',
      '{"jsonrpc":"2.0","id":2,"method":"memory.marketSearch","params":{"query":"typescript","min_similarity":0,"exclude_agent_id":"role_alpha"}}',
      '{"jsonrpc":"2.0","id":3,"method":"memory.marketSearch","params":{"query":"typescript","min_similarity":0,"top_k":1}}',
    );
    expect(skillIds(searchAll!)).toEqual(
      expect.arrayContaining([alphaSkill.id, betaSkill.id]),
    );
    expect(skillIds(searchExcluded!)).toHaveLength(1);
    expect(skillIds(searchExcluded!)).not.toContain(alphaSkill.id);
    expect(skillIds(searchTop1!)).toHaveLength(1);

    // marketImport：克隆副本 + 幂等 + 缺失源技能抛错
    const [imported, importedAgain, importMissing] = await send(
      `{"jsonrpc":"2.0","id":4,"method":"memory.marketImport","params":{"role_id":"role_alpha","source_skill_id":"${betaSkill.id}"}}`,
      `{"jsonrpc":"2.0","id":5,"method":"memory.marketImport","params":{"role_id":"role_alpha","source_skill_id":"${betaSkill.id}"}}`,
      '{"jsonrpc":"2.0","id":6,"method":"memory.marketImport","params":{"role_id":"role_alpha","source_skill_id":"00000000-0000-4000-8000-000000000000"}}',
    );
    expect(imported!).toMatchObject({
      id: 4,
      result: {
        import: {
          created: true,
          imported: { agent_id: 'role_alpha', imported_from: betaSkill.id },
        },
      },
    });
    expect(importedAgain!).toMatchObject({
      id: 5,
      result: { import: { created: false } },
    });
    expect(importMissing!).toMatchObject({
      id: 6,
      error: { code: -32603 },
    });

    // 引入副作用：源技能 imported_by 追加引入方
    const betaSkillsAfter = await repository.listSkills('role_beta');
    expect(betaSkillsAfter.find((skill) => skill.id === betaSkill.id)?.imported_by).toContain(
      'role_alpha',
    );

    // retireAgent：委托 AgentManager，资产处置把 approved Skill 迁入市场池
    const [retired] = await send(
      '{"jsonrpc":"2.0","id":7,"method":"memory.retireAgent","params":{"role_id":"role_beta","reason":"performance_degradation","replacement":"none"}}',
    );
    expect(retired!).toMatchObject({
      id: 7,
      result: {
        retire: {
          role_id: 'role_beta',
          status: 'retired',
          retired_reason: 'performance_degradation',
          asset_disposition: {
            skills_retained: 1,
            skills_discarded: 0,
            experiences_retained: 0,
            experiences_discarded: 0,
          },
        },
      },
    });

    // 退休后：技能不再挂在退休 Agent 名下，进入市场池并溯源 origin_agent_id
    expect(await repository.listSkills('role_beta')).toHaveLength(0);
    const marketSkills = await repository.listSkills(MARKET_POOL_ROLE_ID);
    expect(marketSkills).toContainEqual(
      expect.objectContaining({
        id: betaSkill.id,
        agent_id: MARKET_POOL_ROLE_ID,
        market_status: 'available',
        origin_agent_id: 'role_beta',
      }),
    );
    // 市场池 Agent 对 Board 隐藏（listAgentIds 过滤 __market__）
    expect(await repository.listAgentIds()).not.toContain(MARKET_POOL_ROLE_ID);

    // 幂等退休：已退休 Agent 再次 retire 不重复处置
    const [retiredAgain, invalidReason] = await send(
      '{"jsonrpc":"2.0","id":8,"method":"memory.retireAgent","params":{"role_id":"role_beta","reason":"manual"}}',
      '{"jsonrpc":"2.0","id":9,"method":"memory.retireAgent","params":{"role_id":"role_beta","reason":"bogus"}}',
    );
    expect(retiredAgain!).toMatchObject({
      id: 8,
      result: {
        retire: {
          status: 'retired',
          asset_disposition: {
            skills_retained: 0,
            skills_discarded: 0,
            experiences_retained: 0,
            experiences_discarded: 0,
          },
        },
      },
    });
    expect(invalidReason!).toMatchObject({
      id: 9,
      error: { code: -32602, message: 'Invalid params' },
    });

    // retirementScan：三重门控。role_alpha（无任务历史）→ keep；role_beta 已退休 → 跳过/抛错
    const [scanAll, scanOne, scanRetired] = await send(
      '{"jsonrpc":"2.0","id":10,"method":"memory.retirementScan","params":{}}',
      '{"jsonrpc":"2.0","id":11,"method":"memory.retirementScan","params":{"role_id":"role_alpha"}}',
      '{"jsonrpc":"2.0","id":12,"method":"memory.retirementScan","params":{"role_id":"role_beta"}}',
    );
    const scanAllScans = (scanAll!.result as { scans: Array<{ role_id: string; action: string }> })
      .scans;
    expect(scanAllScans).toHaveLength(1);
    expect(scanAllScans[0]).toMatchObject({ role_id: 'role_alpha', action: 'keep' });
    expect(scanOne!).toMatchObject({
      id: 11,
      result: { scans: [{ role_id: 'role_alpha', action: 'keep' }] },
    });
    expect(scanRetired!).toMatchObject({
      id: 12,
      error: { code: -32603 },
    });
  });

  it('routes market import and retire through NewideBackendService + DriverRuntimeAgentExecutionFacade', async () => {
    const embedding = new HashEmbeddingProvider(32);
    const repository = new InMemoryRepository(embedding);
    const bufferRepository = new InMemoryBufferRepository();
    await repository.initializeAgent({ role_id: 'role_alpha', name: 'Alpha', tags: [] });
    await repository.initializeAgent({ role_id: 'role_beta', name: 'Beta', tags: [] });
    const betaSkill = await seedSkill(
      repository,
      'role_beta',
      'TypeScript compiler optimization',
    );

    const facade = new DriverRuntimeAgentExecutionFacade({
      driver: new CapturingDriver(),
      repository,
      bufferRepository,
      llm: {
        completeWithTools: async () => ({
          content: 'Task completed. [done]',
          tool_calls: undefined,
        }),
      },
    });
    await facade.ready();

    const bMemoryService = new BMemoryBackendService(
      { boardQuery: new RepositoryAgentBoardQuery(repository), maintenance: fakeMaintenance() },
      { provider: 'HashEmbeddingProvider', dimensions: 32, readiness: 'verified' },
      repository,
      {
        retireAgent: (roleId, options) => facade.retireAgent(roleId, options),
        runRetirementScan: (roleId) => facade.runRetirementScan(roleId),
      },
      embedding,
    );

    // 真 NewideBackendService：其余参数全部用默认值，仅注入 bMemoryService（第 10 位）。
    const service = new NewideBackendService(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      bMemoryService,
    );

    const output: string[] = [];
    const session = new JsonRpcLineSession(memoryDispatcherFor(service), (line) => output.push(line));
    const send = async (...lines: string[]) => {
      output.length = 0;
      for (const line of lines) await session.handleLine(line);
      return output.map((line) => JSON.parse(line) as Record<string, unknown>);
    };

    // marketImport 走 NewideBackendService 转发 → BMemoryBackendService → 仓库
    const [imported] = await send(
      `{"jsonrpc":"2.0","id":0,"method":"memory.marketImport","params":{"role_id":"role_alpha","source_skill_id":"${betaSkill.id}"}}`,
    );
    expect(imported!).toMatchObject({
      id: 0,
      result: {
        import: {
          created: true,
          imported: { agent_id: 'role_alpha', imported_from: betaSkill.id },
        },
      },
    });

    // retireAgent 走 NewideBackendService → BMemoryBackendService → facade.retireAgent → AgentManager
    const [retired] = await send(
      '{"jsonrpc":"2.0","id":1,"method":"memory.retireAgent","params":{"role_id":"role_beta","reason":"persona_drift","replacement":"none"}}',
    );
    expect(retired!).toMatchObject({
      id: 1,
      result: {
        retire: {
          role_id: 'role_beta',
          status: 'retired',
          retired_reason: 'persona_drift',
          asset_disposition: {
            skills_retained: 1,
            skills_discarded: 0,
            experiences_retained: 0,
            experiences_discarded: 0,
          },
        },
      },
    });

    // 仓库层状态验证：退休状态落库、技能进入市场池并溯源
    expect((await repository.getAgent('role_beta')).status).toBe('retired');
    const marketSkills = await repository.listSkills(MARKET_POOL_ROLE_ID);
    expect(marketSkills).toContainEqual(
      expect.objectContaining({
        id: betaSkill.id,
        agent_id: MARKET_POOL_ROLE_ID,
        market_status: 'available',
        origin_agent_id: 'role_beta',
      }),
    );

    // retirementScan 走 NewideBackendService → BMemoryBackendService → facade → AgentManager
    const [scanned] = await send(
      '{"jsonrpc":"2.0","id":2,"method":"memory.retirementScan","params":{"role_id":"role_alpha"}}',
    );
    expect(scanned!).toMatchObject({
      id: 2,
      result: { scans: [{ role_id: 'role_alpha', action: 'keep' }] },
    });

    await service.close();
  });
});

function dispatcherFor(service: BMemoryBackendService): JsonRpcDispatcher {
  const dispatcher = new JsonRpcDispatcher();
  new MemoryRpcMethods({
    getMemoryCapabilities: () => service.getCapabilities(),
    listMemoryAgents: () => service.listAgents(),
    getMemoryAgent: (roleId) => service.getAgent(roleId),
    listMemorySkills: (roleId) => service.listSkills(roleId),
    listMemoryExperiences: (roleId) => service.listExperiences(roleId),
    listMemoryMaintenance: (roleId) => service.listMaintenance(roleId),
    promoteMemorySkills: (roleId, requestedBy) => service.promoteSkills(roleId, requestedBy),
    marketSearchMemorySkills: (query) => service.marketSearch(query),
    marketImportMemorySkill: (roleId, sourceSkillId) =>
      service.marketImport(roleId, sourceSkillId),
    retireMemoryAgent: (roleId, options) => service.retireAgent(roleId, options),
    runRetirementScan: (roleId) => service.runRetirementScan(roleId),
  }).register(dispatcher);
  return dispatcher;
}

function memoryDispatcherFor(service: NewideBackendService): JsonRpcDispatcher {
  const dispatcher = new JsonRpcDispatcher();
  // NewideBackendService 直接满足 MemoryMethodsService（生产组合根同样直接注入）
  new MemoryRpcMethods(service).register(dispatcher);
  return dispatcher;
}

function fakeMaintenance(): BMemoryMaintenanceCapabilities {
  return {
    scheduleBuffer: async () => {
      throw new Error('maintenance is not used in this test');
    },
    listEvidence: async () => [],
    promoteSkills: async () => {
      throw new Error('maintenance is not used in this test');
    },
  };
}

function skillIds(response: Record<string, unknown>): string[] {
  const skills = (response as { result: { skills: Array<{ id: string }> } }).result.skills;
  return skills.map((skill) => skill.id);
}

class CapturingDriver implements DriverRuntimeHandle {
  readonly driver_id = 'capturing-driver';
  readonly session_id = 'capturing-session';
  readonly capabilities: DriverCapabilities = {
    supports_acp_extension: false,
    supports_structured_output: true,
    supports_session_load: false,
    supports_tool_events: true,
    supports_permission_events: false,
  };
  readonly prompts: DriverPrompt[] = [];

  async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    this.prompts.push(input);
    const createdAt = nowTimestamp();
    return {
      driver_run_result_id: `driver_result_${String(this.prompts.length)}`,
      session_id: this.session_id,
      status: 'succeeded',
      response: 'Completed.',
      artifacts: [],
      transcript_ref: artifact('transcript', input.task_id, createdAt),
      tool_events: [],
      diagnostics: { driver_id: this.driver_id, duration_ms: 1, notes: [] },
      created_at: createdAt,
      schema_version: SCHEMA_VERSION,
    };
  }

  async interrupt(): Promise<void> {}

  async collectTranscript(taskId = 'task'): Promise<ArtifactRef> {
    return artifact('transcript', taskId, nowTimestamp());
  }
}

function artifact(type: ArtifactRef['type'], taskId: string, createdAt: string): ArtifactRef {
  return {
    artifact_id: randomUUID(),
    type,
    uri: `artifact://${type}/${taskId}`,
    producer_id: 'capturing-driver',
    task_id: taskId,
    created_at: createdAt,
    schema_version: SCHEMA_VERSION,
  };
}

async function seedSkill(
  repository: InMemoryRepository,
  roleId: string,
  description: string,
): Promise<SkillRecord> {
  const now = nowTimestamp();
  const skill: SkillRecord = {
    id: randomUUID(),
    description,
    description_embedding: [],
    content: `Content for: ${description}`,
    version: '1.0.0',
    review_status: 'approved',
    tags: [],
    promoted_at: now,
    agent_id: roleId,
    created_at: now,
    updated_at: now,
  };
  await repository.saveSkill(roleId, skill);
  return skill;
}
