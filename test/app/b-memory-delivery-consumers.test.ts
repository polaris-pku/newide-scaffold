/**
 * 生产消费端装配测试（`src/app/b-memory-delivery-consumers.ts`）
 *
 * 这一层要证的是**接线本身**，而不是三个 worker 各自的语义（那三条链已经在
 * `src/memory/test/context-delivery-worker.test.ts` 与 `driver-feedback-worker.test.ts`
 * 上按文件 / 内存两条腿跑过了）。因此夹具走的是**生产的两步走**：
 *
 *   1. `BMemoryMaintenanceRunner.scheduleBuffer` 登记交付项 + 写 `scheduled` evidence
 *      （在线路径真的做的事）
 *   2. `MemoryDeliveryConsumers.runOnce` 消费它（缺的那一步）
 *
 * 观察面一律落在**副作用**上：Buffer 在哪个分区、仓库里的经验长什么样、evidence JSON 的
 * kind/status/experiences、置信度与 confidence_history。断言「某个函数被调用过」在接线接错
 * 时会照样通过——那种测试对这次改动毫无价值。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BMemoryMaintenanceRunner,
  FileBMemoryMaintenanceEvidenceStore,
} from '../../src/app/b-memory-maintenance-runner';
import {
  MEMORY_DELIVERY_CHANNELS,
  MemoryDeliveryConsumers,
} from '../../src/app/b-memory-delivery-consumers';
import {
  InMemoryBufferRepository,
  InMemoryMaintenanceRunStore,
  InMemoryMemoryDeliveryRepository,
  InMemoryRepository,
  buildDriverUsageFeedbackRecords,
  createAgentMemoryScope,
  stableExperienceId,
  type ExperienceExtractor,
  type LlmClient,
  type MemoryDeliveryRepository,
  type MemoryRepository,
} from '../../src/memory';
import type { BufferSnapshot, ExperienceRecord, SkillRecord } from '../../src/memory/schemas';
import type { CandidateExperience, ExtractionOutput } from '../../src/memory/types';

const ROLE = 'role_consumers';
const TASK_ID = 'task_consumers';
const RUN_ID = 'run_consumers';
const START = '2026-10-13T00:00:00.000Z';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'newide-delivery-consumers-'));
  roots.push(root);
  return root;
}

/** 提取器替身：这一层不考提取质量，只要「产出几条经验」与它们的置信度可控 */
function scriptedExtractor(count = 1, confidence = 0.6): ExperienceExtractor {
  return {
    extract(): Promise<ExtractionOutput> {
      return Promise.resolve({
        experiences: Array.from({ length: count }, (_unused, index) =>
          candidateExperience(index, confidence),
        ),
        result: {
          experiences_created: count,
          experiences_updated: 0,
          negative_experiences: 0,
          skills_promoted: 0,
        },
      });
    },
  };
}

function candidateExperience(index: number, confidence = 0.6): CandidateExperience {
  return {
    id: randomUUID(),
    description: `experience ${String(index)}`,
    description_embedding: [0.1, 0.2, 0.3],
    content: `content ${String(index)}`,
    confidence,
    tags: ['delivery-consumer'],
    confidence_history: [],
    referenced_count: 0,
    source_task_id: TASK_ID,
    source_driver: 'acp-external',
    type: 'positive',
    created_at: START,
    updated_at: START,
  };
}

/** 一条已批准、可作演化输入的 Skill（`promoted_from` 缺席：它不指向任何经验） */
function approvedSkill(): SkillRecord {
  return {
    id: randomUUID(),
    description: 'Prefer explicit contracts over implicit conventions.',
    description_embedding: [0.1, 0.2, 0.3],
    content: 'full skill content body',
    version: '1.0.0',
    review_status: 'approved',
    tags: ['delivery-consumer'],
    promoted_at: START,
    agent_id: ROLE,
    market_status: 'available',
    created_at: START,
    updated_at: START,
  };
}

/** 一条直接落库的经验（绕开提取，用来给晋升 / 演化摆好输入） */
function seededExperience(confidence: number): ExperienceRecord {
  return {
    id: randomUUID(),
    description: 'seeded experience',
    description_embedding: [0.1, 0.2, 0.3],
    content: 'seeded content',
    confidence,
    tags: ['delivery-consumer'],
    agent_id: ROLE,
    confidence_history: [{ value: confidence, updated_at: START, reason: 'seed' }],
    referenced_count: 0,
    source_task_id: TASK_ID,
    source_driver: 'acp-external',
    type: 'positive',
    created_at: START,
    updated_at: START,
  };
}

/** runner 只用 llm 懒构造提取器，scheduleBuffer 那条路径从不碰它 */
const unusedLlm: LlmClient = {
  complete: () => Promise.reject(new Error('the LLM must not be called by scheduleBuffer')),
};

interface Harness {
  root: string;
  repository: InMemoryRepository;
  buffer: InMemoryBufferRepository;
  delivery: InMemoryMemoryDeliveryRepository;
  runStore: InMemoryMaintenanceRunStore;
  evidenceStore: FileBMemoryMaintenanceEvidenceStore;
  runner: BMemoryMaintenanceRunner;
  /** 走完生产的两步：登记一条 Buffer + 交付项 + scheduled evidence */
  schedule(): Promise<number>;
  consumers(overrides?: {
    extractor?: ExperienceExtractor;
    delivery?: MemoryDeliveryRepository;
    /** 换一个读不动的仓储，用来考一条通道失败时的隔离 */
    repository?: MemoryRepository;
    promotion?: { min_confidence?: number; auto_approve?: boolean };
    personaEvolution?: { auto_approve?: boolean };
    schedule?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
    cancel?: (timer: ReturnType<typeof setInterval>) => void;
  }): MemoryDeliveryConsumers;
}

async function harness(): Promise<Harness> {
  const root = await tempRoot();
  const repository = new InMemoryRepository();
  const buffer = new InMemoryBufferRepository();
  const delivery = new InMemoryMemoryDeliveryRepository();
  const runStore = new InMemoryMaintenanceRunStore();
  const evidenceStore = new FileBMemoryMaintenanceEvidenceStore(
    path.join(root, 'b', 'maintenance'),
  );
  await repository.initializeAgent({ role_id: ROLE, name: ROLE });
  await buffer.ensureAgent(ROLE);
  await delivery.ensureAgent(ROLE);

  const runner = new BMemoryMaintenanceRunner({
    repository,
    bufferRepository: buffer,
    deliveryRepository: delivery,
    llm: unusedLlm,
    evidenceStore,
  });

  const ref: Harness = {
    root,
    repository,
    buffer,
    delivery,
    runStore,
    evidenceStore,
    runner,
    async schedule() {
      const memory = createAgentMemoryScope(repository, buffer, ROLE);
      const snapshot: BufferSnapshot = {
        task_id: TASK_ID,
        task_description: 'Consume the context downstream.',
        driver_return: {
          summary: 'Completed.',
          artifacts: [],
          decisions: [],
          blockers: [],
          referenced_experiences: [],
          assumptions: [],
        },
        source_task_id: TASK_ID,
        source_driver: 'acp-external',
        received_at: START,
        retry_count: 0,
        extraction_status: 'pending',
      };
      const saved = await memory.saveBufferSnapshot(snapshot);
      const evidence = await runner.scheduleBuffer({
        task_id: TASK_ID,
        run_id: RUN_ID,
        role_id: ROLE,
        buffer_seq: saved.seq,
      });
      // 生产路径在任何 mode 下都只登记交付项——夹具在这里顺手把这半条边界也钉住：
      // 「登记完就提取了」会让下面所有断言失去意义。
      expect(evidence.kind).toBe('context_delivery');
      expect(evidence.status).toBe('scheduled');
      return saved.seq;
    },
    consumers(overrides = {}) {
      return new MemoryDeliveryConsumers({
        repository: overrides.repository ?? repository,
        bufferRepository: buffer,
        deliveryRepository: overrides.delivery ?? delivery,
        runStore,
        evidenceStore,
        llm: unusedLlm,
        extractor: overrides.extractor ?? scriptedExtractor(1),
        // 两条 job 通道的审核模式缺省是手动——夹具里不显式打开时，缺省就是「只记结论」，
        // 那正是要被测到的行为之一，因此这里不做任何「测试一律自动批准」的偷懒默认。
        ...(overrides.promotion !== undefined ? { promotion: overrides.promotion } : {}),
        ...(overrides.personaEvolution !== undefined
          ? { personaEvolution: overrides.personaEvolution }
          : {}),
        // 刻意**不**注入假时钟：交付项的 `next_attempt_at` 是 runner 登记时按真实时间写的，
        // 拿一个更早的参考时刻去 claim 会永远读不到「到期」，测出来的是夹具的时钟差，
        // 不是消费逻辑。
        ...(overrides.schedule !== undefined ? { schedule: overrides.schedule } : {}),
        ...(overrides.cancel !== undefined ? { cancel: overrides.cancel } : {}),
      });
    },
  };
  return ref;
}

/** 该 role 唯一那条交付 evidence（按 maintenance_ref 取；夹具里一次只有一个） */
async function onlyEvidence(h: Harness) {
  const all = await h.evidenceStore.list(ROLE);
  expect(all).toHaveLength(1);
  return all[0]!;
}

describe('MemoryDeliveryConsumers — 定时/手动消费一条在线登记的 Buffer', () => {
  it('把 Buffer 消费成 Experience，并把交付 evidence 就地改写成 completed', async () => {
    const h = await harness();
    const seq = await h.schedule();

    // 登记之后：输入还躺在 pending，交付项已登记，evidence 停在「已交付、等下游」
    expect(await h.buffer.listPendingBufferSeqs(ROLE)).toEqual([seq]);
    const before = await onlyEvidence(h);
    expect(before.kind).toBe('context_delivery');
    expect(before.status).toBe('scheduled');
    expect(before.experiences).toEqual([]);

    const report = await h.consumers().runOnce();

    expect(report.channels.context_delivery.status).toBe('completed');
    expect(report.channels.context_delivery.counts?.completed_count).toBe(1);
    // 消费完输入就该离开 pending（这是「消费」与「看过」的分界）
    expect(await h.buffer.listPendingBufferSeqs(ROLE)).toEqual([]);
    expect((await h.buffer.getStoredBuffer(ROLE, seq))?.location).toBe('processed');

    const experiences = await h.repository.listExperiences(ROLE);
    expect(experiences.map((experience) => experience.id)).toEqual([
      stableExperienceId(ROLE, seq, 0),
    ]);

    const after = await onlyEvidence(h);
    expect(after.kind).toBe('experience_extraction');
    expect(after.status).toBe('completed');
    expect(after.experiences).toHaveLength(1);
    // 溯源不丢：改写的是同一条 evidence，交付引用与 task/run 都还在
    expect(after.maintenance_ref).toBe(before.maintenance_ref);
    expect(after.task_id).toBe(TASK_ID);
    expect(after.run_id).toBe(RUN_ID);
    expect(after.context_delivery?.delivery_id).toBe(before.context_delivery?.delivery_id);
  });

  it('同一轮里先把上下文消费掉，本轮 Driver 反馈才能命中刚提取出来的经验', async () => {
    const h = await harness();
    const seq = await h.schedule();
    const consumers = h.consumers();

    // 反馈先入 outbox，经验还不存在——这正是生产里的顺序（任务收尾先交反馈，
    // 提取是之后的事）。它在同一轮里必须被排在前面的上下文通道救回来。
    const [feedback] = buildDriverUsageFeedbackRecords({
      role_id: ROLE,
      task_id: TASK_ID,
      observed_at: START,
      references: [
        {
          experience_id: stableExperienceId(ROLE, seq, 0),
          applied: true,
          effectiveness: 'fully_effective',
          note: 'reused it successfully',
        },
      ],
    });
    await h.delivery.submitDriverFeedback(feedback!);
    expect(await h.repository.listExperiences(ROLE)).toEqual([]);

    const report = await consumers.runOnce();

    expect(report.channels.context_delivery.status).toBe('completed');
    expect(report.channels.driver_feedback.status).toBe('completed');
    expect(report.channels.driver_feedback.counts?.completed_count).toBe(1);
    // 命中了，因此不需要寄存去等下一次归并
    expect(await h.delivery.listPendingFeedback({ role_id: ROLE })).toEqual([]);

    const applied = await h.repository.listExperiences(ROLE);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.confidence).toBeCloseTo(0.7, 6);
    expect(applied[0]!.referenced_count).toBe(1);
    expect(applied[0]!.confidence_history).toEqual([
      {
        value: 0.7,
        // 写入时刻取的是消费端的时钟（真实时间），这里只钉住形状与溯源
        updated_at: expect.any(String),
        reason: 'usage_validation:fully_effective',
        feedback_id: feedback!.feedback_id,
      },
    ]);
    // 观察时刻来自反馈自己（driver 上报的 observed_at），不是写入时刻
    expect(applied[0]!.last_referenced_at).toBe(START);
    expect((await h.repository.getMetrics(ROLE)).avg_confidence).toBeCloseTo(0.7, 6);
  });

  it('重复跑一轮不会把同一条反馈记两次（幂等落在 feedback_id 上）', async () => {
    const h = await harness();
    const seq = await h.schedule();
    const consumers = h.consumers();
    const [feedback] = buildDriverUsageFeedbackRecords({
      role_id: ROLE,
      task_id: TASK_ID,
      observed_at: START,
      references: [
        {
          experience_id: stableExperienceId(ROLE, seq, 0),
          applied: true,
          effectiveness: 'fully_effective',
          note: 'reused it successfully',
        },
      ],
    });
    await h.delivery.submitDriverFeedback(feedback!);

    await consumers.runOnce();
    // 再投一次同一份反馈（重放 / 崩溃重跑的形状），然后归并队列也跑一轮
    await h.delivery.submitDriverFeedback(feedback!);
    await consumers.runOnce();

    const experiences = await h.repository.listExperiences(ROLE);
    expect(experiences).toHaveLength(1);
    expect(experiences[0]!.referenced_count).toBe(1);
    expect(
      experiences[0]!.confidence_history.filter(
        (entry) => entry.feedback_id === feedback!.feedback_id,
      ),
    ).toHaveLength(1);
    expect(experiences[0]!.confidence).toBeCloseTo(0.7, 6);
  });

  it('--channel 限定之外的通道记 not_run，不会偷偷跟着跑', async () => {
    const h = await harness();
    await h.schedule();

    const report = await h.consumers().runOnce({ channels: ['context_delivery'] });

    expect(Object.keys(report.channels)).toEqual([...MEMORY_DELIVERY_CHANNELS]);
    expect(report.channels.context_delivery.status).toBe('completed');
    expect(report.channels.driver_feedback).toEqual({ status: 'not_run' });
    expect(report.channels.feedback_reconcile).toEqual({ status: 'not_run' });
    expect(await h.buffer.listPendingBufferSeqs(ROLE)).toEqual([]);
    expect(await h.repository.listExperiences(ROLE)).toHaveLength(1);
  });

  it('一条通道读不动存储只让它自己 failed，另外两条照常跑完', async () => {
    const h = await harness();
    await h.schedule();

    const broken = Object.create(h.delivery) as MemoryDeliveryRepository;
    broken.claimNextDelivery = async (input) => {
      if (input.channel === 'context') throw new Error('delivery store is unreadable');
      return h.delivery.claimNextDelivery(input);
    };

    const report = await h.consumers({ delivery: broken }).runOnce();

    expect(report.channels.context_delivery.status).toBe('failed');
    expect(report.channels.context_delivery.error?.message).toContain('unreadable');
    // 失败隔离：另外两条不是 not_run、也不是 failed——它们真的跑过且这一轮没活
    expect(report.channels.driver_feedback.status).toBe('no_work');
    expect(report.channels.feedback_reconcile.status).toBe('no_work');
  });

  it('没有活可干时三条通道都如实报 no_work（而不是 failed，也不是没接线）', async () => {
    const h = await harness();
    const report = await h.consumers().runOnce();

    expect(report.channels.context_delivery.status).toBe('no_work');
    expect(report.channels.driver_feedback.status).toBe('no_work');
    expect(report.channels.feedback_reconcile.status).toBe('no_work');
    expect(report.channels.context_delivery.stop_reason).toBe('no_work');
  });
});

describe('MemoryDeliveryConsumers — 提取器不给经验时的 evidence', () => {
  it('提取出 0 条也照样把交付 evidence 收成 completed（空 experiences 是合法结论）', async () => {
    const h = await harness();
    await h.schedule();

    const report = await h.consumers({ extractor: scriptedExtractor(0) }).runOnce();

    expect(report.channels.context_delivery.status).toBe('completed');
    expect(await h.repository.listExperiences(ROLE)).toEqual([]);
    const evidence = await onlyEvidence(h);
    expect(evidence.kind).toBe('experience_extraction');
    expect(evidence.status).toBe('completed');
    expect(evidence.experiences).toEqual([]);
  });

  it('同一轮里两条 Buffer 各回各的 evidence，不会串到同一条上', async () => {
    const h = await harness();
    await h.schedule();
    await h.schedule();

    const report = await h.consumers().runOnce();

    expect(report.channels.context_delivery.counts?.completed_count).toBe(2);
    const all = await h.evidenceStore.list(ROLE);
    expect(all.map((item) => item.buffer_seq).sort()).toEqual([1, 2]);
    for (const item of all) {
      expect(item.kind).toBe('experience_extraction');
      expect(item.status).toBe('completed');
      expect(item.experiences).toHaveLength(1);
    }
    expect((await h.repository.listExperiences(ROLE)).map((item) => item.id).sort()).toEqual(
      [stableExperienceId(ROLE, 1, 0), stableExperienceId(ROLE, 2, 0)].sort(),
    );
  });
});

describe('MemoryDeliveryConsumers — 晋升通道（Phase 3）', () => {
  it('同一轮里反馈先把置信度抬过门槛，晋升随即命中（通道顺序是承重的）', async () => {
    const h = await harness();
    const seq = await h.schedule();
    // 提取出来的经验只有 0.88：单看它不合格——判据是**严格大于** 0.95。这正是「经验刚被提取
    // 出来」的样子，置信度还没被任何反馈抬过。
    const consumers = h.consumers({
      extractor: scriptedExtractor(1, 0.88),
      promotion: { auto_approve: true },
    });
    const [feedback] = buildDriverUsageFeedbackRecords({
      role_id: ROLE,
      task_id: TASK_ID,
      observed_at: START,
      references: [
        {
          experience_id: stableExperienceId(ROLE, seq, 0),
          applied: true,
          effectiveness: 'fully_effective',
          note: 'reused it successfully',
        },
      ],
    });
    await h.delivery.submitDriverFeedback(feedback!);

    const report = await consumers.runOnce();

    expect(report.channels.driver_feedback.status).toBe('completed');
    expect(report.channels.skill_promotion.status).toBe('completed');
    expect(report.channels.skill_promotion.approval).toBe('auto_approve');

    // 反馈先落：0.88 + 0.1 → 0.98（封顶）
    const experiences = await h.repository.listExperiences(ROLE);
    expect(experiences[0]!.confidence).toBeCloseTo(0.98, 6);

    // 晋升后落：同一轮里它看到的就是抬过之后的置信度。把这条排到 `driver_feedback` 前面，
    // 它看到的会是 0.88 并判不合格，这条断言随即失败——顺序保的就是这件事。
    const skills = await h.repository.listSkills(ROLE);
    expect(skills).toHaveLength(1);
    expect(experiences[0]!.promoted_to).toBe(skills[0]!.id);
    expect(experiences[0]!.promotion?.outcome).toBe('promoted');
  });

  it('缺省手动：只记待审结论、不写 Skill；开关打开后下一轮把它接起来', async () => {
    const h = await harness();
    await h.schedule();
    const consumers = h.consumers({ extractor: scriptedExtractor(1, 0.99) });

    const first = await consumers.runOnce();

    expect(first.channels.skill_promotion.status).toBe('completed');
    // 报告必须带 `approval`：`completed_count` 把 promoted 与 pending_review 算在同一格里，
    // 少了它，「这轮到底产出了没有」从计数上读不出来。
    expect(first.channels.skill_promotion.approval).toBe('manual_review');
    expect(await h.repository.listSkills(ROLE)).toEqual([]);
    const marked = (await h.repository.listExperiences(ROLE))[0]!;
    expect(marked.promotion?.outcome).toBe('pending_review');
    expect(marked.promoted_to).toBeUndefined();

    // 放宽成自动批准：这是人工放行的**唯一**一条路——`listPendingReviews` 认的是 Skill 上的
    // `review_status`，而手动模式下根本不写 Skill，那条队列里不会有它。
    const loosened = h.consumers({
      extractor: scriptedExtractor(1, 0.99),
      promotion: { auto_approve: true },
    });
    const second = await loosened.runOnce();

    expect(second.channels.skill_promotion.status).toBe('completed');
    expect(await h.repository.listSkills(ROLE)).toHaveLength(1);
  });
});

describe('MemoryDeliveryConsumers — 人格演化通道（Phase 4）', () => {
  it('写出新版本并落标记；同一份输入再跑一轮是幂等命中', async () => {
    const h = await harness();
    // 演化只吃**已批准**的输入
    await h.repository.saveSkillIfAbsent(ROLE, approvedSkill());
    await h.repository.saveExperience(ROLE, seededExperience(0.9));

    const consumers = h.consumers({ personaEvolution: { auto_approve: true } });
    const before = await h.repository.getPersona(ROLE);

    const report = await consumers.runOnce({ channels: ['persona_evolution'] });

    expect(report.channels.persona_evolution.status).toBe('completed');
    expect(report.channels.persona_evolution.approval).toBe('auto_approve');
    expect(report.channels.persona_evolution.strategy_version).toBeDefined();

    const after = await h.repository.getPersona(ROLE);
    expect(after.version).toBe(before.version + 1);
    const marker = await h.repository.getPersonaEvolutionMarker(ROLE);
    expect(marker?.outcome).toBe('evolved');
    expect(marker?.source_run_id).toBe(report.channels.persona_evolution.run_id);

    // 同一份输入、同一版策略：没有活，版本不动
    const again = await consumers.runOnce({ channels: ['persona_evolution'] });
    expect(again.channels.persona_evolution.status).toBe('no_work');
    expect((await h.repository.getPersona(ROLE)).version).toBe(after.version);
  });
});

describe('MemoryDeliveryConsumers — 新通道的失败隔离与演练', () => {
  it('一条 job 通道读不动存储只让它自己 failed，另外四条照常跑完', async () => {
    const h = await harness();
    await h.schedule();

    const broken = Object.create(h.repository) as MemoryRepository;
    broken.claimNextPromotionCandidate = async () => {
      throw new Error('promotion store is unreadable');
    };

    const report = await h.consumers({ repository: broken }).runOnce();

    expect(report.channels.skill_promotion.status).toBe('failed');
    expect(report.channels.skill_promotion.error?.message).toContain('unreadable');
    // 失败隔离：它自己 failed，而另外四条不是 failed，也不是没接线
    expect(report.channels.context_delivery.status).toBe('completed');
    expect(report.channels.driver_feedback.status).toBe('no_work');
    expect(report.channels.persona_evolution.status).not.toBe('failed');
  });

  it('--dry-run 点名了不可演练的通道就整轮拒绝，一条都不跑', async () => {
    const h = await harness();
    await h.schedule();

    await expect(h.consumers().runOnce({ dry_run: true })).rejects.toThrow(/dry_run/);
    // 拒绝发生在任何通道开跑之前：队列一条都没被消费
    expect(await h.buffer.listPendingBufferSeqs(ROLE)).toEqual([1]);

    const report = await h.consumers().runOnce({
      dry_run: true,
      channels: ['persona_evolution'],
    });
    expect(report.channels.persona_evolution.dry_run).toBe(true);
    expect(report.channels.persona_evolution.status).toBe('no_work');
    expect(report.channels.context_delivery.status).toBe('not_run');
    expect(await h.buffer.listPendingBufferSeqs(ROLE)).toEqual([1]);
  });
});

describe('MemoryDeliveryConsumers — 定时器', () => {
  it('到点就自己消费一次，stop() 之后不再跑', async () => {
    const h = await harness();
    await h.schedule();

    const handlers: Array<() => void> = [];
    let cancelled = 0;
    const consumers = h.consumers({
      schedule: (handler) => {
        handlers.push(handler);
        return 0 as unknown as ReturnType<typeof setInterval>;
      },
      cancel: () => {
        cancelled += 1;
      },
    });
    consumers.start(3_600_000);
    expect(handlers).toHaveLength(1);
    expect(await h.buffer.listPendingBufferSeqs(ROLE)).toEqual([1]);

    // 一次 tick：不调 runOnce，只让定时器自己动
    handlers[0]!();
    await consumers.waitForIdle();

    expect(await h.buffer.listPendingBufferSeqs(ROLE)).toEqual([]);
    expect(await h.repository.listExperiences(ROLE)).toHaveLength(1);
    expect(consumers.lastRunReport()?.channels.context_delivery.status).toBe('completed');

    consumers.stop();
    expect(cancelled).toBe(1);
    // 停表之后同一批句柄不该再被触发（真定时器由 cancel 保证，这里钉住 stop 的记账）
    expect(handlers).toHaveLength(1);
  });
});
