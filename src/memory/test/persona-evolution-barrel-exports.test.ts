/**
 * Persona 演化的公开导出面与在线耦合边界（Phase 4-D）
 *
 * 这个文件做两件事，都只能从「外部调用方」的位置上做：
 *
 * 1. **公开入口够不够用**。整份文件只从 barrel（`src/memory/index.ts`）import——不写任何深
 *    路径——因此它红了就是「外部维护 runner / 调度器从公开入口拿不到某个能力」，而不是某处
 *    实现坏了（那是别的测试的事）。为什么值得单独钉一遍：模块里的实现测试全都走深路径 import，
 *    天然拿得到一切；而调度器（Phase 5）与应用层只允许通过 entrypoint 引入。缺一个导出，
 *    实现侧全绿、调用方编译不过，这种缺口只有以 barrel 为唯一入口的测试才看得见。
 * 2. **这条通道与外界的耦合边界**。演化不得接进在线 Driver、Context / Feedback 两条消费者、
 *    Buffer 流程或 Skill Promotion（计划 §3 与 §17），也不得被在线装配构造——调度接线是
 *    Phase 5 的事。这条「没有」用断言来表达：**看这条通道自己的模块都 import 了什么**，以及
 *    **组合根里有没有它的影子**。
 *
 * 第 2 件事的写法值得说清楚，因为它容易被误读成「用测试代替架构」：
 *
 * - 它是一道**绊线**，不是证明。真正的保证是模块边界与评审；这里能做的是把「有人把它接上
 *   去了」变成一次立刻变红的失败，而不是等到生产上出现「一次 Driver 请求里跑了演化」。
 * - 判据只看 **import 的模块名**（把 `../services/xxx` 取最后一段），不看正文——注释与文档里
 *   提到某条通道是正常的，import 它才是有耦合。
 * - **共享规则模块是允许的**：`delivery-lifecycle`（状态机）与 `delivery-error-classification`
 *   （失败码）是四条通道共用的那套规则，演化复用它们正是「没有第二套状态机」的落点，因此
 *   不在禁止名单里；被禁的是两条**消费者**、晋升通道、Buffer / 交付 outbox 与在线装配。
 * - Phase 5 把演化接进调度器时，这条绊线**应该**要改（改的是它，不是把 import 藏起来）。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUTO_APPROVAL_REVIEWER,
  DEFAULT_PERSONA_EVOLUTION_BATCH_SIZE,
  DEFAULT_PERSONA_EVOLUTION_MAX_DURATION_MS,
  DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY,
  DEFAULT_PERSONA_EVOLUTION_STRATEGY_CONFIG,
  DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION,
  DefaultPersonaEvolutionJob,
  DefaultPersonaEvolutionStrategy,
  InMemoryMaintenanceRunStore,
  InMemoryRepository,
  PERSONA_EVOLUTION_APPROVAL_MODES,
  PERSONA_EVOLUTION_BLOCKER_RULES,
  PERSONA_EVOLUTION_VERDICTS,
  PersonaEvolutionDecisionContractError,
  buildPersonaEvolutionSnapshot,
  classifyPersonaEvolutionFailure,
  executePersonaEvolutionCandidate,
  mergeMaintenanceRunAudit,
  personaEvolutionBatchSnapshotDigest,
  personaEvolutionIdempotencyKey,
  personaEvolutionInputSnapshotHash,
  personaEvolutionLastRun,
  personaEvolutionStateLabel,
  planPersonaEvolutionCandidate,
  type ClaimedPersonaEvolutionCandidate,
  type ExperienceRecord,
  type MaintenanceRunStore,
  type MemoryRepository,
  type MaintenanceRunAudit,
  type MaintenanceRunCandidateAudit,
  type PersonaDef,
  type PersonaEvolutionCandidateOutcome,
  type PersonaEvolutionCandidateStatus,
  type PersonaEvolutionClaimRequest,
  type PersonaEvolutionCompletionRequest,
  type PersonaEvolutionDecision,
  type PersonaEvolutionEvaluationInput,
  type PersonaEvolutionExecutionResult,
  type PersonaEvolutionExecutionStatus,
  type PersonaEvolutionFailureClassification,
  type PersonaEvolutionFailureKind,
  type PersonaEvolutionJob,
  type PersonaEvolutionJobOptions,
  type PersonaEvolutionLastRun,
  type PersonaEvolutionMarker,
  type PersonaEvolutionOutcome,
  type PersonaEvolutionRunOptions,
  type PersonaEvolutionRunResult,
  type PersonaEvolutionSkipReason,
  type PersonaEvolutionStateLabel,
  type PersonaEvolutionStrategy,
  type PersonaEvolutionViolation,
  type SkillRecord,
} from '../index';

const START = '2026-10-11T12:00:00.000Z';

function makeExperience(role_id: string, overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  return {
    id: randomUUID(),
    description: 'Prefer explicit contracts over implicit conventions.',
    description_embedding: [0.1, 0.2, 0.3],
    content: 'full experience content body',
    confidence: 0.9,
    tags: ['contracts'],
    agent_id: role_id,
    confidence_history: [{ value: 0.9, updated_at: START, reason: 'seed' }],
    referenced_count: 1,
    source_task_id: 'task_seed',
    source_driver: 'mock-driver',
    type: 'positive',
    created_at: START,
    updated_at: START,
    ...overrides,
  };
}

function makeSkill(role_id: string): SkillRecord {
  return {
    id: randomUUID(),
    description: 'Prefer explicit contracts over implicit conventions.',
    description_embedding: [0.1, 0.2, 0.3],
    content: 'full skill content body',
    version: '1.0.0',
    review_status: 'approved',
    tags: ['contracts'],
    promoted_at: START,
    agent_id: role_id,
    market_status: 'available',
    created_at: START,
    updated_at: START,
  };
}

/**
 * 类型层可达性：这一段只要编译得过，就说明这些类型确实从 barrel 拿得到。
 *
 * 类型在运行时会被擦除，因此它必须被用在**值位置**上才有意义——声明一个没人用的别名是测不出
 * 东西的（lint 也会先报 unused）。这里把它当成一个探针对象的部分类型。
 */
type BarrelPersonaEvolutionSurface = {
  job: PersonaEvolutionJob;
  jobOptions: PersonaEvolutionJobOptions;
  runOptions: PersonaEvolutionRunOptions;
  runResult: PersonaEvolutionRunResult;
  outcome: PersonaEvolutionCandidateOutcome;
  outcomeStatus: PersonaEvolutionCandidateStatus;
  executionResult: PersonaEvolutionExecutionResult;
  executionStatus: PersonaEvolutionExecutionStatus;
  strategy: PersonaEvolutionStrategy;
  evaluationInput: PersonaEvolutionEvaluationInput;
  decision: PersonaEvolutionDecision;
  marker: PersonaEvolutionMarker;
  evolutionOutcome: PersonaEvolutionOutcome;
  lastRun: PersonaEvolutionLastRun;
  skipReason: PersonaEvolutionSkipReason;
  stateLabel: PersonaEvolutionStateLabel;
  failureKind: PersonaEvolutionFailureKind;
  failureClassification: PersonaEvolutionFailureClassification;
  runAudit: MaintenanceRunAudit;
  candidateAudit: MaintenanceRunCandidateAudit;
  violation: PersonaEvolutionViolation;
  claimRequest: PersonaEvolutionClaimRequest;
  completionRequest: PersonaEvolutionCompletionRequest;
  claimed: ClaimedPersonaEvolutionCandidate;
  contractError: PersonaEvolutionDecisionContractError;
  repository: MemoryRepository;
  runStore: MaintenanceRunStore;
  skill: SkillRecord;
  experience: ExperienceRecord;
  persona: PersonaDef;
};

describe('Persona 演化的 barrel 导出面', () => {
  it('运行期导出全部可从 barrel 拿到（装配一次运行不需要深路径）', () => {
    expect(typeof DefaultPersonaEvolutionJob).toBe('function');
    expect(typeof DefaultPersonaEvolutionStrategy).toBe('function');
    expect(typeof executePersonaEvolutionCandidate).toBe('function');
    expect(typeof classifyPersonaEvolutionFailure).toBe('function');
    expect(typeof PersonaEvolutionDecisionContractError).toBe('function');
    expect(typeof personaEvolutionStateLabel).toBe('function');
    expect(typeof personaEvolutionInputSnapshotHash).toBe('function');
    expect(typeof personaEvolutionIdempotencyKey).toBe('function');
    expect(typeof personaEvolutionLastRun).toBe('function');
    expect(typeof buildPersonaEvolutionSnapshot).toBe('function');
    expect(typeof planPersonaEvolutionCandidate).toBe('function');
    // 审计面的两个入口也在 barrel 上：一是这次运行处理的那组输入怎么被摘要成一个标识
    // （外部 runner 要对账「两次运行的输入是不是同一批」），二是审计怎么按字段合并
    expect(typeof personaEvolutionBatchSnapshotDigest).toBe('function');
    expect(typeof mergeMaintenanceRunAudit).toBe('function');
    expect(typeof InMemoryRepository).toBe('function');
    expect(typeof InMemoryMaintenanceRunStore).toBe('function');
    // 常量也是装配的一部分：外部 runner 要能照默认值表达「我没改批量上限 / 我没换判据」
    expect(DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION).toBe('persona-threshold.v1');
    expect(typeof DEFAULT_PERSONA_EVOLUTION_BATCH_SIZE).toBe('number');
    expect(typeof DEFAULT_PERSONA_EVOLUTION_MAX_DURATION_MS).toBe('number');
    expect(DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY.max_attempts).toBeGreaterThan(0);
    // 缺省是人工审核：自动批准必须是显式打开的开关
    expect(DEFAULT_PERSONA_EVOLUTION_STRATEGY_CONFIG.approval).toBe('manual_review');
    expect(AUTO_APPROVAL_REVIEWER).toBe('system:auto-approval');
    // 三个运行时词表：契约新增成员时它们先变，调用方按它们校验自己的配置
    expect(PERSONA_EVOLUTION_APPROVAL_MODES).toEqual(['auto_approve', 'manual_review']);
    expect(PERSONA_EVOLUTION_VERDICTS).toHaveLength(3);
    expect(PERSONA_EVOLUTION_BLOCKER_RULES.length).toBeGreaterThan(0);
  });

  it('类型导出全部可从 barrel 拿到（外部 runner 能声明自己的接口）', () => {
    const probe: Partial<BarrelPersonaEvolutionSurface> = {};
    expect(probe).toEqual({});
  });

  it('只用 barrel 就能把一次演化跑通，并用同一入口查回版本与状态', async () => {
    const role_id = `role_barrel_persona_${randomUUID()}`;
    const repository: MemoryRepository = new InMemoryRepository();
    const runStore: MaintenanceRunStore = new InMemoryMaintenanceRunStore();
    await repository.initializeAgent({ role_id, name: 'Barrel Persona Agent' });
    await repository.saveSkillIfAbsent(
      role_id,
      makeSkill(role_id),
    );
    await repository.saveExperience(role_id, makeExperience(role_id));

    const job: PersonaEvolutionJob = new DefaultPersonaEvolutionJob({
      repository,
      runStore,
      strategy: new DefaultPersonaEvolutionStrategy({ approval: 'auto_approve' }),
      worker_id: 'worker-barrel',
      role_id,
      now: () => START,
    });
    const runOptions: PersonaEvolutionRunOptions = { batchSize: 5 };
    const result: PersonaEvolutionRunResult = await job.run(runOptions);

    expect(result.outcomes.map((item) => item.status)).toEqual(['evolved']);
    expect(result.counts).toMatchObject({ claimed_count: 1, completed_count: 1 });
    expect(result.strategy_version).toBe(DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION);
    expect(result.approval).toBe('auto_approve');

    // 查询面：版本、演化标记、状态标签，全部从 barrel 的类型接住
    const persona: PersonaDef = await repository.getPersona(role_id);
    expect(persona.version).toBe(2);
    const stored: PersonaEvolutionMarker | undefined =
      await repository.getPersonaEvolutionMarker(role_id);
    expect(stored?.outcome).toBe('evolved');
    expect(stored?.parent_version).toBe(1);
    expect(stored?.persona_version).toBe(2);
    expect(stored?.source_run_id).toBe(result.run.run_id);
    const label: PersonaEvolutionStateLabel = personaEvolutionStateLabel(stored);
    expect(label).toBe('evolved');
    // 上一次结论也是从同一入口读的：判定要看的「历史」就在这里
    expect(personaEvolutionLastRun(stored)?.persona_version).toBe(2);

    // run 审计同样从 barrel 的类型接住：这次按哪一版判据、依据哪一份输入，run 记录说得清
    const audit: MaintenanceRunAudit | undefined = (await runStore.get(result.run.run_id))?.audit;
    expect(audit?.strategy_version).toBe(DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION);
    expect(audit?.input_snapshot?.candidate_count).toBe(1);
    const candidate: MaintenanceRunCandidateAudit | undefined = audit?.candidates?.[0];
    expect(candidate?.candidate_id).toBe(role_id);
    expect(candidate?.result_version).toBe(2);
    expect(candidate?.input_snapshot_hash).toBe(stored?.input_snapshot_hash);

    // 再跑一次是幂等命中：没有活，版本不动
    const again: PersonaEvolutionRunResult = await job.run({ batchSize: 5 });
    expect(again.stop_reason).toBe('no_work');
    expect((await repository.getPersona(role_id)).version).toBe(2);
  });

  it('只用 barrel 就能把一条演化推到死信并人工放回', async () => {
    const role_id = `role_barrel_persona_dead_${randomUUID()}`;
    const repository: MemoryRepository = new InMemoryRepository();
    await repository.initializeAgent({ role_id, name: 'Barrel Persona Dead Letter Agent' });
    await repository.saveSkillIfAbsent(role_id, makeSkill(role_id));

    // 外部策略只需要实现端口上的三个成员；这里模拟一次配置错（权限类错误 → 不可重试）
    let calls = 0;
    const brokenStrategy: PersonaEvolutionStrategy = {
      version: 'barrel-persona.v1',
      config: { ...DEFAULT_PERSONA_EVOLUTION_STRATEGY_CONFIG, version: 'barrel-persona.v1' },
      evaluate: async () => {
        calls += 1;
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    };

    const job = new DefaultPersonaEvolutionJob({
      repository,
      runStore: new InMemoryMaintenanceRunStore(),
      strategy: brokenStrategy,
      worker_id: 'worker-barrel',
      role_id,
      now: () => START,
    });

    const failed: PersonaEvolutionRunResult = await job.run({ batchSize: 5 });
    expect(calls).toBe(1);
    expect(failed.outcomes.map((item) => item.status)).toEqual(['dead_letter']);
    // 判定层抛出的不可重试错误归 policy_failure：修它的是改配置，不是再跑一遍
    expect(failed.outcomes[0]?.failure).toMatchObject({ code: 'policy_rejected', retryable: false });
    expect(classifyPersonaEvolutionFailure(new Error('boom'), 'judgement').retryable).toBe(true);

    const stored: PersonaEvolutionMarker | undefined =
      await repository.getPersonaEvolutionMarker(role_id);
    expect(personaEvolutionStateLabel(stored)).toBe('dead_letter');
    expect((await repository.getPersona(role_id)).version).toBe(1);

    // 人工放回是 repository 的能力，同样从 barrel 的类型上调用
    const revived: PersonaEvolutionMarker | undefined =
      await repository.retryDeadLetterPersonaEvolution({ role_id, now: START });
    expect(revived?.status).toBe('pending');
    expect(revived?.attempt_count).toBe(0);
    expect(personaEvolutionStateLabel(revived)).toBe('unevaluated');
  });

  it('dry-run 的跳过原因与投影都能从结果里读到（真跑看不到「本来会跳过」）', async () => {
    const role_id = `role_barrel_persona_dry_${randomUUID()}`;
    const repository: MemoryRepository = new InMemoryRepository();
    await repository.initializeAgent({ role_id, name: 'Barrel Persona Dry Agent' });

    // 没有输入：真跑会拒绝，演练照实报「真跑一次会得到什么」而什么都不写
    const job = new DefaultPersonaEvolutionJob({
      repository,
      runStore: new InMemoryMaintenanceRunStore(),
      strategy: new DefaultPersonaEvolutionStrategy({ approval: 'auto_approve' }),
      worker_id: 'worker-barrel',
      role_id,
      now: () => START,
    });
    const projected = await job.run({ batchSize: 5, dryRun: true });

    const outcome: PersonaEvolutionCandidateOutcome | undefined = projected.outcomes[0];
    expect(outcome?.status).toBe('rejected');
    expect(outcome?.decision?.blocking_rules).toEqual(['no_approved_input']);
    expect(projected.counts.claimed_count).toBe(0);
    expect(await repository.getPersonaEvolutionMarker(role_id)).toBeUndefined();

    // 已有结论的角色再演练一次：这一条报的是「本来会跳过」以及原因
    await repository.saveSkillIfAbsent(role_id, makeSkill(role_id));
    await job.run({ batchSize: 5 });
    const skipped = await job.run({ batchSize: 5, dryRun: true });
    expect(skipped.outcomes[0]?.status).toBe('skipped');
    expect(skipped.outcomes[0]?.skip_reason).toBe('already_evolved_for_snapshot');
  });
});

// ════════════════════════════════════════════════════════
//  耦合边界：这条通道不许被接进别的四条流程
// ════════════════════════════════════════════════════════

/** 这条通道自己的模块（不含测试）：判据、执行内核、外壳、端口与默认策略 */
const CHANNEL_SOURCES = [
  '../ports/persona-evolution-strategy.ts',
  '../ports/persona-evolution-job.ts',
  '../services/persona-evolution-candidates.ts',
  '../services/persona-evolution-decision.ts',
  '../services/persona-evolution-executor.ts',
  '../adapters/default-persona-evolution-strategy.ts',
  '../runtime/persona-evolution-job.ts',
] as const;

/**
 * 禁止出现在上面那些模块的 import 里的模块名（取 `../x/y` 的最后一段）。
 *
 * 共享的**规则**模块不在名单里：`delivery-lifecycle`（状态机与重试策略）与
 * `delivery-error-classification`（失败码）是四条通道共用的那一份定义，演化复用它们正是
 * 「没有第二套状态机」的落点。
 */
const FORBIDDEN_MODULES = [
  // 在线写入与两条消费者
  'buffer-writer',
  'context-delivery',
  'context-delivery-processor',
  'context-delivery-worker',
  'feedback',
  'pending-feedback',
  'driver-feedback-processor',
  'driver-feedback-worker',
  // 交付 / 反馈 outbox
  'memory-delivery',
  'in-memory-memory-delivery',
  'pg-memory-delivery',
  'file-memory-delivery',
  'buffer-repository',
  'file-buffer-repository',
  // Skill Promotion
  'skill-promotion',
  'skill-promotion-processor',
  'skill-promotion-job',
  'default-promotion-strategy',
  'default-promotion-trigger-policy',
  'promotion-candidates',
  'promotion-executor',
  'promotion-integrity',
  'promotion-state',
  // 组合根
  'b-memory-maintenance-runner',
  'b-memory-backend-service',
] as const;

/** 取一个 import 说明符的模块名：去掉扩展名，取最后一段 */
function moduleNameOf(specifier: string): string {
  return (specifier.replace(/\.(ts|js)$/, '').split('/').pop() ?? specifier).trim();
}

/** 一个源文件里所有静态 / 动态 import 的说明符 */
async function importedSpecifiers(file: URL): Promise<string[]> {
  const source = await readFile(fileURLToPath(file), 'utf8');
  const specifiers: string[] = [];
  // `import ... from 'x'` / `export ... from 'x'`：`[^;]` 会跨行，因此多行 import 也抓得到
  for (const match of source.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
    specifiers.push(match[1]!);
  }
  // 副作用导入 `import 'x'` 与动态导入 `await import('x')`
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specifiers.push(match[1]!);
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

describe('Persona 演化与在线流程的耦合边界', () => {
  it('这条通道的模块不 import 两条消费者、Buffer/交付 outbox、Skill Promotion 或在线装配', async () => {
    const violations: string[] = [];
    for (const relative of CHANNEL_SOURCES) {
      const specifiers = await importedSpecifiers(new URL(relative, import.meta.url));
      for (const specifier of specifiers) {
        const name = moduleNameOf(specifier);
        if ((FORBIDDEN_MODULES as readonly string[]).includes(name)) {
          violations.push(`${relative} → ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('组合根（src/app）里没有演化 job 的任何影子：调度接线属于 Phase 5', async () => {
    const root = fileURLToPath(new URL('../../app/', import.meta.url));
    const entries = await readdir(root, { recursive: true });
    const hits: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.ts')) continue;
      const text = await readFile(join(root, entry), 'utf8');
      if (/persona-evolution|DefaultPersonaEvolutionJob/.test(text)) hits.push(entry);
    }
    // 一旦有人把它接进在线装配，这里先红——那时要改的是这条断言（有意识地接线），
    // 而不是把接线藏进动态 import
    expect(hits).toEqual([]);

    // 扫描器本身是活的：拿一个**确实**含这个名字的目录（本模块自己）跑同一段判据，
    // 它必须报出来。否则上面那条空数组可能只是「什么都没扫到」
    const channelRoot = fileURLToPath(new URL('../', import.meta.url));
    const scanned = await readdir(channelRoot, { recursive: true });
    const found = await Promise.all(
      scanned
        .filter((entry) => entry.endsWith('.ts'))
        .map(async (entry) =>
          /persona-evolution|DefaultPersonaEvolutionJob/.test(
            await readFile(join(channelRoot, entry), 'utf8'),
          ),
        ),
    );
    expect(found.filter(Boolean).length).toBeGreaterThan(0);
  });

  it('绊线本身是活的：名单里的模块名真的会被认出来', async () => {
    // 用一个已知会 import 消费者的模块反向验证判据（消费自己当然 import 交付存储）
    const specifiers = await importedSpecifiers(
      new URL('../runtime/context-delivery-worker.ts', import.meta.url),
    );
    const names = specifiers.map(moduleNameOf);
    expect(names.some((name) => (FORBIDDEN_MODULES as readonly string[]).includes(name))).toBe(true);
  });
});
