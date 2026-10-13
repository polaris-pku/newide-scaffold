/**
 * Skill Promotion 的公开导出面（Phase 3-D）
 *
 * 这个文件只做一件事：**只用 barrel（`src/memory/index.ts`）**把一次完整的晋升跑起来。
 * 它不 import 任何深路径，因此它红了就是「外部维护 runner 从公开入口拿不到某个能力」，
 * 而不是某处实现坏了——那是别的测试的事。
 *
 * 为什么值得单独钉一遍：模块里的实现测试全都走深路径 import，天然拿得到一切；而调度器
 * （Phase 5）与应用层只允许通过 entrypoint 引入。缺一个导出，实现侧全绿、调用方编译不过，
 * 这种缺口只有以 barrel 为唯一入口的测试才看得见。
 *
 * 覆盖的是「装配一次运行需要的全部东西」：构造 job 的依赖（repository / runStore /
 * strategy）、运行选项与结果类型、判定契约错误、执行内核、以及晋升状态的查询与人工放回。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROMOTION_STRATEGY_CONFIG,
  DEFAULT_PROMOTION_STRATEGY_VERSION,
  DEFAULT_PROMOTION_RETRY_POLICY,
  DEFAULT_SKILL_PROMOTION_BATCH_SIZE,
  DefaultPromotionStrategy,
  DefaultSkillPromotionJob,
  InMemoryMaintenanceRunStore,
  InMemoryRepository,
  PromotionDecisionContractError,
  executePromotionCandidate,
  promotionStateLabel,
  type ClaimedPromotionCandidate,
  type ExperienceRecord,
  type MaintenanceRunStore,
  type MemoryRepository,
  type PromotionCandidateQuery,
  type PromotionStateLabel,
  type PromotionStrategy,
  type SkillPromotionJob,
  type SkillPromotionJobOptions,
  type SkillPromotionRunOptions,
  type SkillPromotionRunResult,
  type SkillRecord,
} from '../index';

const START = '2026-10-11T12:00:00.000Z';

function makeExperience(role_id: string, overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  return {
    id: randomUUID(),
    description: 'Prefer explicit contracts over implicit conventions.',
    description_embedding: [0.1, 0.2, 0.3],
    content: 'full experience content body',
    confidence: 0.99,
    tags: ['contracts'],
    agent_id: role_id,
    confidence_history: [{ value: 0.99, updated_at: START, reason: 'seed' }],
    referenced_count: 1,
    source_task_id: 'task_seed',
    source_driver: 'mock-driver',
    type: 'positive',
    created_at: START,
    updated_at: START,
    ...overrides,
  };
}

/**
 * 类型层可达性：这一段只要编译得过，就说明下面这些类型确实从 barrel 拿得到。
 *
 * 类型在运行时会被擦除，因此它必须被用在**值位置**上才有意义——声明一个没人用的别名
 * 是测不出东西的（而且 lint 会先报 unused）。这里把它当成一个探针对象的部分类型。
 */
type BarrelPromotionSurface = {
  job: SkillPromotionJob;
  jobOptions: SkillPromotionJobOptions;
  runOptions: SkillPromotionRunOptions;
  runResult: SkillPromotionRunResult;
  strategy: PromotionStrategy;
  contractError: PromotionDecisionContractError;
  repository: MemoryRepository;
  runStore: MaintenanceRunStore;
  claimed: ClaimedPromotionCandidate;
  experience: ExperienceRecord;
  skill: SkillRecord;
  stateLabel: PromotionStateLabel;
  candidateQuery: PromotionCandidateQuery;
};

describe('Skill Promotion 的 barrel 导出面', () => {
  it('运行期导出全部可从 barrel 拿到（构造 job 与调用内核都不需要深路径）', () => {
    expect(typeof DefaultSkillPromotionJob).toBe('function');
    expect(typeof DefaultPromotionStrategy).toBe('function');
    expect(typeof executePromotionCandidate).toBe('function');
    expect(typeof PromotionDecisionContractError).toBe('function');
    expect(typeof promotionStateLabel).toBe('function');
    expect(typeof InMemoryRepository).toBe('function');
    expect(typeof InMemoryMaintenanceRunStore).toBe('function');
    // 常量也是装配的一部分：外部 runner 要能照默认值表达「我没改批量上限」
    expect(DEFAULT_PROMOTION_STRATEGY_VERSION).toBe('promotion-threshold.v1');
    expect(typeof DEFAULT_SKILL_PROMOTION_BATCH_SIZE).toBe('number');
    expect(DEFAULT_PROMOTION_RETRY_POLICY.max_attempts).toBeGreaterThan(0);
    expect(DEFAULT_PROMOTION_STRATEGY_CONFIG.approval).toBe('manual_review');
  });

  it('类型导出全部可从 barrel 拿到（外部 runner 能声明自己的接口）', () => {
    const probe: Partial<BarrelPromotionSurface> = {};
    expect(probe).toEqual({});
  });

  it('只用 barrel 就能把一次晋升跑通，并用同一入口查回晋升状态', async () => {
    const role_id = `role_barrel_${randomUUID()}`;
    const repository: MemoryRepository = new InMemoryRepository();
    const runStore: MaintenanceRunStore = new InMemoryMaintenanceRunStore();
    await repository.initializeAgent({ role_id, name: 'Barrel Agent' });
    const experience = makeExperience(role_id);
    await repository.saveExperience(role_id, experience);

    const job: SkillPromotionJob = new DefaultSkillPromotionJob({
      repository,
      runStore,
      strategy: new DefaultPromotionStrategy({ approval: 'auto_approve' }),
      worker_id: 'worker-barrel',
      role_id,
      now: () => START,
    });
    const runOptions: SkillPromotionRunOptions = { batchSize: 5 };
    const result: SkillPromotionRunResult = await job.run(runOptions);

    expect(result.outcomes.map((item) => item.status)).toEqual(['promoted']);
    expect(result.counts).toMatchObject({ claimed_count: 1, completed_count: 1 });

    // 查询面：候选查询、经验上的晋升标记、产出的技能，全部从 barrel 的类型接住
    const candidateQuery: PromotionCandidateQuery = {
      role_id,
      now: START,
      strategy_version: DEFAULT_PROMOTION_STRATEGY_VERSION,
      approval: 'auto_approve',
    };
    expect(await repository.listPromotionCandidates(candidateQuery)).toHaveLength(0);
    const stored: ExperienceRecord = (await repository.listExperiences(role_id))[0]!;
    const label: PromotionStateLabel = promotionStateLabel(stored);
    expect(label).toBe('promoted');
    const skills: SkillRecord[] = await repository.listSkills(role_id);
    expect(skills).toHaveLength(1);
    expect(stored.promoted_to).toBe(skills[0]?.id);
  });

  it('只实现端口（不继承任何基类）就足以当晋升策略，并走完死信与人工重试', async () => {
    const role_id = `role_barrel_dead_${randomUUID()}`;
    const repository: MemoryRepository = new InMemoryRepository();
    await repository.initializeAgent({ role_id, name: 'Barrel Dead Letter Agent' });
    await repository.saveExperience(role_id, makeExperience(role_id));

    // 外部策略只需要实现端口上的三个成员；这里模拟一次配置错（权限类错误 → 不可重试）
    let calls = 0;
    const brokenStrategy: PromotionStrategy = {
      version: 'barrel-threshold.v1',
      config: { ...DEFAULT_PROMOTION_STRATEGY_CONFIG, version: 'barrel-threshold.v1' },
      evaluate: async () => {
        calls += 1;
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    };

    const job = new DefaultSkillPromotionJob({
      repository,
      runStore: new InMemoryMaintenanceRunStore(),
      strategy: brokenStrategy,
      worker_id: 'worker-barrel',
      role_id,
      now: () => START,
    });

    const failed: SkillPromotionRunResult = await job.run({ batchSize: 5 });
    expect(calls).toBe(1);
    expect(failed.outcomes.map((item) => item.status)).toEqual(['dead_letter']);
    const stored: ExperienceRecord = (await repository.listExperiences(role_id))[0]!;
    expect(promotionStateLabel(stored)).toBe('dead_letter');

    // 人工放回是 repository 的能力，同样从 barrel 的类型上调用
    const revived: ExperienceRecord | undefined = await repository.retryDeadLetterPromotion({
      role_id,
      experience_id: stored.id,
      now: START,
    });
    expect(revived?.promotion?.status).toBe('pending');
    expect(promotionStateLabel(revived!)).toBe('unevaluated');
  });
});
