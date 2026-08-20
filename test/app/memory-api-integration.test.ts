/**
 * Memory API 集成验证（M7）
 *
 * 在进程内组合生产装配（NewideBackendService → BMemoryBackendService →
 * 真 InMemoryRepository + InMemoryBufferRepository + 真 AgentManager lifecycle），
 * 通过 JsonRpcDispatcher 驱动 memory.* 全链路：
 *   createAgent → updateAgent → createSkill → publishSkillToMarket →
 *   updateSkill → marketImport → rateTask → updateExperience →
 *   updatePersona → regeneratePersona → getBufferState → retryExtraction →
 *   getPendingBuffer → 列表过滤 → searchMemory → deleteAgent 安全边界
 *   （未退休无 force 拒绝 / force 二次确认允许）→ retireAgent → deleteAgent
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BMemoryBackendService } from '../../src/app/b-memory-backend-service';
import type { BMemoryMaintenanceCapabilities } from '../../src/app/b-public-capabilities';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { nowTimestamp } from '../../src/core';
import {
  AgentManager,
  HashEmbeddingProvider,
  InMemoryBufferRepository,
  InMemoryRepository,
  RepositoryAgentBoardQuery,
  reviewSkill,
} from '../../src/memory';
import type { BufferSnapshot, ExperienceRecord } from '../../src/memory/schemas';
import { JsonRpcDispatcher } from '../../src/rpc/json-rpc-dispatcher';
import { MemoryRpcMethods } from '../../src/rpc/memory-methods';

const ROLE = 'role_integration';
const BUYER = 'role_buyer';
const TASK = 'task_integration';
const FORCE_ROLE = 'role_force_delete';

interface RpcResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

describe('memory.* full API integration (M7)', () => {
  it('exercises the complete manual memory management surface', async () => {
    const embedding = new HashEmbeddingProvider(32);
    const repository = new InMemoryRepository(embedding);
    const bufferRepository = new InMemoryBufferRepository();
    const manager = await AgentManager.create(repository, bufferRepository, {
      tools: {
        llm: {
          completeWithTools: async () => ({
            content: 'Task completed. [done]',
            tool_calls: undefined,
          }),
        },
        tools: [],
      },
      embedding,
    });

    const scheduled: Array<{ role_id: string; buffer_seq: number }> = [];
    const maintenance = fakeMaintenance(scheduled);
    const bMemoryService = new BMemoryBackendService(
      {
        boardQuery: new RepositoryAgentBoardQuery(repository),
        maintenance,
        reviewSkill: (input) => reviewSkill(repository, input),
        bufferRepository,
      },
      { provider: 'HashEmbeddingProvider', dimensions: 32, readiness: 'verified' },
      {},
      repository,
      {
        retireAgent: (roleId, options) => manager.retireAgent(roleId, options),
        runRetirementScan: (roleId) => manager.scanForRetirements(roleId),
        createAgent: (spec) => manager.createAgent(spec),
        updateAgent: async (roleId, patch) => {
          await repository.updateAgentMeta(roleId, patch);
          return repository.getAgent(roleId);
        },
        deleteAgent: (roleId, options) => manager.deleteAgent(roleId, options),
      },
      embedding,
    );
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
    const dispatcher = new JsonRpcDispatcher();
    new MemoryRpcMethods(service).register(dispatcher);
    const call = (id: number, method: string, params: unknown): Promise<RpcResponse> =>
      dispatcher.dispatch({ jsonrpc: '2.0', id, method, params }) as Promise<RpcResponse>;

    // 1. capabilities v2 且关键能力可用
    const capabilities = await call(1, 'memory.getCapabilities', {});
    expect(capabilities.result!.capabilities).toMatchObject({
      schema_version: 'newide.b-memory-capabilities.v2',
      operations: {
        create_agent: { status: 'available' },
        create_skill: { status: 'available' },
        update_persona: { status: 'available' },
        rate_task: { status: 'available' },
        get_buffer_state: { status: 'available' },
        search_memory: { status: 'available' },
        get_overview: { status: 'available' },
        list_pending_reviews: { status: 'available' },
        list_experiences_by_source_task: { status: 'available' },
      },
    });

    // 2. 创建两个 Agent（手动创建闭环）
    await call(2, 'memory.createAgent', {
      role_id: ROLE,
      name: 'Integration Agent',
      persona_seed: 'Seed summary.',
    });
    const createdBuyer = await call(3, 'memory.createAgent', {
      role_id: BUYER,
      name: 'Buyer Agent',
    });
    expect(createdBuyer.result!.agent).toMatchObject({ role_id: BUYER });

    // 3. 更新 Agent 元数据
    const updated = await call(4, 'memory.updateAgent', {
      role_id: ROLE,
      tags: ['typescript', 'fullstack'],
    });
    expect(updated.result!.agent).toMatchObject({ tags: ['typescript', 'fullstack'] });

    // 4. 手动创建技能 → 上架 → 编辑
    const skill = await call(5, 'memory.createSkill', {
      role_id: ROLE,
      description: 'TS service patterns',
      content: 'Define explicit contracts.',
      tags: ['typescript'],
    });
    const skillId = (skill.result!.skill as { id: string }).id;
    expect(skill.result!.skill).toMatchObject({ review_status: 'pending' });

    // 4a. 待审核队列：createSkill 后应包含该 pending 技能
    const pendingReviews = await call(100, 'memory.listPendingReviews', {});
    expect(pendingReviews.result!.skills).toHaveLength(1);
    expect(pendingReviews.result!.skills[0]).toMatchObject({ id: skillId });

    const published = await call(6, 'memory.publishSkillToMarket', {
      role_id: ROLE,
      skill_id: skillId,
    });
    expect(published.result!.skill).toMatchObject({ market_status: 'available' });

    await call(7, 'memory.updateSkill', {
      role_id: ROLE,
      skill_id: skillId,
      tags: ['typescript', 'backend'],
    });

    // 市场引入要求技能 approved（isMarketEligibleSkill 过滤）→ 先审核再导入
    await call(8, 'memory.approveSkill', {
      role_id: ROLE,
      skill_id: skillId,
      reviewed_by: 'integration',
    });
    // 4b. 审核后待审核队列应清空
    const noPending = await call(101, 'memory.listPendingReviews', {});
    expect(noPending.result!.skills).toHaveLength(0);

    const imported = await call(9, 'memory.marketImport', {
      role_id: BUYER,
      source_skill_id: skillId,
    });
    expect(imported.result!.import).toMatchObject({ created: true });

    // 6. 种子经验与 pending buffer（模拟任务产物），再评分
    await repository.saveExperience(ROLE, integrationExperience(TASK));
    await bufferRepository.ensureAgent(ROLE);
    await bufferRepository.saveBufferSnapshot(ROLE, integrationBuffer(1, TASK));

    const rated = await call(10, 'memory.rateTask', {
      role_id: ROLE,
      task_id: TASK,
      rating: 'resolved',
    });
    expect(rated.result!.rating).toEqual({ updated_experiences: 1, buffer_updated: true });

    // 7. 编辑经验置信度
    const [experience] = await repository.listExperiences(ROLE);
    const experienceUpdate = await call(11, 'memory.updateExperience', {
      role_id: ROLE,
      experience_id: experience!.id,
      confidence: 0.9,
    });
    expect(experienceUpdate.result!.experience).toMatchObject({ confidence: 0.9 });

    // 8. Persona：手动 PATCH + 按需重生成（无 LLM 走规则版）
    const personaPatch = await call(12, 'memory.updatePersona', {
      role_id: ROLE,
      summary: 'Manually edited summary',
    });
    expect(personaPatch.result!.persona).toMatchObject({ summary: 'Manually edited summary' });
    const regenerated = await call(13, 'memory.regeneratePersona', { role_id: ROLE });
    expect((regenerated.result!.persona as { version: number }).version).toBeGreaterThan(
      (personaPatch.result!.persona as { version: number }).version,
    );

    // 9. Buffer：置死信（带失败原因）→ 状态总览（含死信详情）→ 重试提取 → 查看恢复后的 pending
    await bufferRepository.markBufferDeadLetter(ROLE, 1, 'LLM extraction timeout');
    const state = await call(14, 'memory.getBufferState', { role_id: ROLE });
    expect(state.result!.state).toMatchObject({ dead_letter_seqs: [1] });
    expect(state.result!.state).toMatchObject({
      dead_letters: [{ seq: 1, task_id: TASK, reason: 'LLM extraction timeout' }],
    });

    const retried = await call(15, 'memory.retryExtraction', { role_id: ROLE, seq: 1 });
    expect(retried.result!.maintenance).toMatchObject({ status: 'scheduled' });
    expect(scheduled).toContainEqual({ role_id: ROLE, buffer_seq: 1 });

    const pending = await call(16, 'memory.getPendingBuffer', { role_id: ROLE, seq: 1 });
    expect(pending.result!.buffer).toMatchObject({
      snapshot: { task_id: TASK, user_rating: 'resolved' },
    });

    // 10. 列表过滤 + 单 Agent 检索
    const filtered = await call(17, 'memory.listSkills', {
      role_id: ROLE,
      review_status: 'approved',
    });
    expect((filtered.result!.skills as unknown[]).length).toBeGreaterThanOrEqual(1);

    const search = await call(18, 'memory.searchMemory', {
      role_id: ROLE,
      query: 'typescript',
      top_k: 5,
      min_similarity: 0,
    });
    expect(search.result!.skills).toHaveLength(1);
    expect(search.result!.experiences).toHaveLength(1);
    // 召回项应携带相似度分数（解释"为什么召回这条"）
    expect(
      (search.result!.skills as Array<{ similarity: number }>)[0]!.similarity,
    ).toBeGreaterThanOrEqual(0);
    expect(
      (search.result!.experiences as Array<{ similarity: number }>)[0]!.similarity,
    ).toBeGreaterThanOrEqual(0);

    // 10b. 按任务溯源：该任务产出的经验应能被反查
    const byTask = await call(102, 'memory.listExperiencesBySourceTask', { task_id: TASK });
    expect(byTask.result!.experiences).toHaveLength(1);
    expect(byTask.result!.experiences[0]).toMatchObject({ source_task_id: TASK });

    // 10c. 全局总览：聚合 Agent / 技能 / 经验 / buffer / 置信度
    const overview = await call(103, 'memory.getOverview', {});
    expect(overview.result!.overview).toMatchObject({
      agents: { total: 2 },
      // ROLE 上架 1 个 available 技能 + BUYER 引入副本（继承 available）
      skills: { total: 2, pending_review: 0, in_market: 2 },
      experiences: { total: 1 },
      buffer: { dead_letters: 0 },
    });
    expect(
      (overview.result!.overview as { quality: { avg_confidence: number } }).quality.avg_confidence,
    ).toBe(0.9);

    // 11. 未退休 Agent 删除安全边界：无 force 拒绝，force 二次确认后允许
    const rejected = await call(19, 'memory.deleteAgent', {
      role_id: ROLE,
      confirm: true,
    });
    expect(rejected.error).toBeDefined();
    expect(rejected.error!.message).toMatch(/retired before deletion/);

    await call(20, 'memory.createAgent', { role_id: FORCE_ROLE, name: 'Force Delete' });
    const forced = await call(21, 'memory.deleteAgent', {
      role_id: FORCE_ROLE,
      confirm: true,
      force: true,
    });
    expect(forced.result!.deleted).toBe(true);
    expect(await repository.listAgentIds()).not.toContain(FORCE_ROLE);

    // 12. 退休 → 硬删除（闭环删除）
    await call(22, 'memory.retireAgent', { role_id: ROLE, reason: 'manual' });
    const deleted = await call(23, 'memory.deleteAgent', {
      role_id: ROLE,
      confirm: true,
    });
    expect(deleted.result!.deleted).toBe(true);
    expect(await repository.listAgentIds()).not.toContain(ROLE);
  });
});

function fakeMaintenance(
  scheduled: Array<{ role_id: string; buffer_seq: number }>,
): BMemoryMaintenanceCapabilities {
  return {
    scheduleBuffer: async (input) => {
      scheduled.push({ role_id: input.role_id, buffer_seq: input.buffer_seq });
      return {
        maintenance_ref: `b_maintenance_${randomUUID()}`,
        kind: 'experience_extraction' as const,
        status: 'scheduled' as const,
        role_id: input.role_id,
        buffer_seq: input.buffer_seq,
        experiences: [],
        skills: [],
        warnings: [],
        created_at: nowTimestamp(),
        completed_at: nowTimestamp(),
        schema_version: 'v0',
      };
    },
    listEvidence: async () => [],
    promoteSkills: async () => {
      throw new Error('promoteSkills is not used in the integration flow');
    },
  };
}

function integrationExperience(taskId: string): ExperienceRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'Use explicit contracts',
    description_embedding: [],
    content: 'Define contracts before implementation.',
    confidence: 0.6,
    tags: ['typescript'],
    agent_id: ROLE,
    confidence_history: [],
    referenced_count: 0,
    source_task_id: taskId,
    source_driver: 'test-driver',
    type: 'positive',
    created_at: now,
    updated_at: now,
  };
}

function integrationBuffer(seq: number, taskId: string): BufferSnapshot {
  const now = nowTimestamp();
  return {
    task_id: taskId,
    task_description: 'Do a task.',
    driver_return: {
      artifacts: [],
      summary: 'Done.',
      decisions: [],
      blockers: [],
      referenced_experiences: [],
      assumptions: [],
    },
    source_task_id: taskId,
    source_driver: 'test-driver',
    received_at: now,
    retry_count: 0,
    extraction_status: 'pending',
  };
}
