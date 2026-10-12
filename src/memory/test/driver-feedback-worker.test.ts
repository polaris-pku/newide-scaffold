/**
 * Driver Feedback Worker（Phase 2）测试
 *
 * 覆盖「Driver 反馈 → Experience 回写」这条链在真实存储上的行为：消费、寄存、归并、
 * 幂等、fence 凭据、lease 续租与恢复、错误分类、重启与边界。断言一律落在**持久化之后的
 * 状态与副作用**上（交付项的状态、待归并队列里有没有那条记录、仓库里的经验长什么样），
 * 而不是「某个函数被调用过」——后者在存储语义出错时照样通过。
 *
 * 交付存储按两条腿（文件 / 内存）各跑一遍：测试替身掩盖生产差异是交付契约最贵的一类事故。经验仓库用 InMemoryRepository（另有一条腿用 PgMemoryRepository
 * 在 PGlite 上跑同一份 applyExperienceFeedback 契约——条件写的 SQL 只有真跑过才算数）。
 *
 * 时间全部由注入的 clock 提供，租约心跳的定时器也是注入的（手动触发）。因此「退避到点了
 * 没有」「续租失败之后还能不能写」这类断言不依赖真实时钟，也不会偶发。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * PGlite 是 WASM 引擎：建库本身要一秒起步。整仓并行跑测试时，这份启动成本会挤进
 * 单测默认的 5s 预算，于是那条腿偶发超时。这里放宽超时——测的是消费语义，
 * 不是「PGlite 在负载下多久起来」。
 */
vi.setConfig({ testTimeout: 30_000 });

import { FileMemoryDeliveryRepository } from '../adapters/file-memory-delivery';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { InMemoryMemoryDeliveryRepository } from '../adapters/in-memory-memory-delivery';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { FileMaintenanceRunStore } from '../adapters/file-maintenance-run-store';
import { PgMemoryRepository } from '../adapters/pg-memory-repository';
import { createPGlitePool } from '../adapters/pglite-pool';

/** 实体侧（经验 / 技能 / Persona）的进程内 PGlite 池，跨用例共享、文件收尾时关掉 */
let sharedPgMemoryPool: Awaited<ReturnType<typeof createPGlitePool>> | undefined;
async function pgMemoryPool(): Promise<Awaited<ReturnType<typeof createPGlitePool>>> {
  sharedPgMemoryPool ??= await createPGlitePool();
  return sharedPgMemoryPool;
}
import { ensurePgMemorySchema } from '../adapters/pg-memory-schema';
import {
  DriverFeedbackWorker,
  type DriverFeedbackRunResult,
} from '../runtime/driver-feedback-worker';
import { DefaultDriverFeedbackProcessor } from '../runtime/driver-feedback-processor';
import { buildDriverUsageFeedbackRecords } from '../services/context-delivery';
import {
  DEFAULT_FEEDBACK_CONSUME_RETRY_POLICY,
  DEFAULT_PENDING_FEEDBACK_RETRY_POLICY,
  type DeliveryRetryPolicy,
} from '../services/delivery-lifecycle';
import type { LeaseTimers } from '../services/lease-heartbeat';
import type { MemoryDeliveryRepository } from '../ports/memory-delivery';
import type { MemoryRepository } from '../ports/memory-repository';
import type { MaintenanceRunStore } from '../ports/maintenance-run-store';
import { DriverFeedbackContentSchema } from '../schemas';
import type {
  DriverFeedbackRecord,
  ExperienceRecord,
  PendingFeedbackRecord,
} from '../schemas';

const ROLE = 'role_feedback';
const OTHER_ROLE = 'role_feedback_other';
const START = '2026-10-10T00:00:00.000Z';

/**
 * 待归并通道的测试预算：真实缺省是 20 次 / 30s 起 / 封顶 15 分钟（约 3.8 小时）。
 * 测死信边界不需要等那么久，所以注入一份小预算——**边界本身**（次数用满即死信、
 * 退避按指数增长）与真实配置走的是同一段代码。
 */
const PENDING_POLICY: DeliveryRetryPolicy = {
  max_attempts: 3,
  base_delay_ms: 1_000,
  max_delay_ms: 60_000,
};

const roots: string[] = [];
let pgMemoryTouched = false;

afterEach(async () => {
  if (pgMemoryTouched) {
    const pool = await pgMemoryPool();
    await pool.query('TRUNCATE memory_agents CASCADE');
    pgMemoryTouched = false;
  }
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

afterAll(async () => {
  await sharedPgMemoryPool?.end();
  sharedPgMemoryPool = undefined;
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'newide-feedback-worker-'));
  roots.push(root);
  return root;
}

// ════════════════════════════════════════════════════════
//  测试用的时钟与定时器
// ════════════════════════════════════════════════════════

interface TestClock {
  now(): string;
  /** 前进若干毫秒——退避窗口与租约过期都靠它跨过去 */
  advance(ms: number): void;
}

function testClock(start = START): TestClock {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current = new Date(Date.parse(current) + ms).toISOString();
    },
  };
}

interface ManualTimers extends LeaseTimers {
  /** 手动触发出所有还活着的间隔回调 */
  fire(): void;
  /** 还登记着几个间隔 */
  activeCount(): number;
}

/**
 * 手动定时器：心跳的每一次 tick 由用例决定何时发生。
 *
 * 用真定时器测「续租成功 / 续租失败」要把租约压到毫秒级，再和异步 I/O 抢时间，
 * 写出的一定是偶发失败的测试。这里把「什么时候跳」变成显式动作，剩下的部分仍然是
 * 真实存储上真实发生的续租调用。
 */
function manualTimers(): ManualTimers {
  const handlers = new Map<number, () => void>();
  let next = 1;
  return {
    setInterval(handler) {
      const id = next;
      next += 1;
      handlers.set(id, handler);
      return id;
    },
    clearInterval(handle) {
      handlers.delete(handle as number);
    },
    fire() {
      for (const handler of [...handlers.values()]) handler();
    },
    activeCount() {
      return handlers.size;
    },
  };
}

/** 等一个条件成立；超时即断言失败，不静默放过 */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// ════════════════════════════════════════════════════════
//  样例数据
// ════════════════════════════════════════════════════════

/** 一条合法的 Driver 使用反馈（id/键由构造器派生，因此契约校验会通过） */
function feedbackFor(
  roleId: string,
  experienceId: string,
  overrides: { task_id?: string; note?: string; effectiveness?: DriverFeedbackRecord['effectiveness'] } = {},
): DriverFeedbackRecord {
  const [record] = buildDriverUsageFeedbackRecords({
    role_id: roleId,
    task_id: overrides.task_id ?? 'task_feedback',
    references: [
      {
        experience_id: experienceId,
        applied: true,
        effectiveness: overrides.effectiveness ?? 'fully_effective',
        note: overrides.note ?? 'solved it',
      },
    ],
    observed_at: START,
  });
  return record!;
}

function experienceFor(roleId: string, id: string, overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  return {
    id,
    description: 'Retry the driver call with a bounded backoff.',
    description_embedding: [],
    content: 'bounded retry beats unbounded waiting',
    confidence: 0.8,
    tags: ['retry'],
    agent_id: roleId,
    confidence_history: [{ value: 0.8, updated_at: START, reason: 'seed' }],
    referenced_count: 1,
    source_task_id: 'task_seed',
    source_driver: 'acp-external',
    type: 'positive',
    created_at: START,
    updated_at: START,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════
//  交付存储的三条腿（与 DELIVERY_ADAPTERS 同一组后端）
// ════════════════════════════════════════════════════════

interface DeliveryCase {
  name: string;
  /** 开一个指向该存储的适配器实例；budget 是待归并通道的重试预算 */
  create: (root: string, budget: DeliveryRetryPolicy) => Promise<MemoryDeliveryRepository>;
  /** 重启：新实例指向**同一份存储**（内存实现只能原样返回，它不假装持久化） */
  reopen: (root: string, previous: MemoryDeliveryRepository) => Promise<MemoryDeliveryRepository>;
  durable: boolean;
}

const DELIVERY_CASES: DeliveryCase[] = [
  {
    name: 'FileMemoryDeliveryRepository',
    create: (root, budget) =>
      Promise.resolve(
        new FileMemoryDeliveryRepository({
          agentStateRoot: join(root, 'agent-state'),
          pendingFeedbackRetryPolicy: budget,
        }),
      ),
    reopen: (root, _previous) =>
      Promise.resolve(
        new FileMemoryDeliveryRepository({
          agentStateRoot: join(root, 'agent-state'),
          pendingFeedbackRetryPolicy: PENDING_POLICY,
        }),
      ),
    durable: true,
  },
  {
    name: 'InMemoryMemoryDeliveryRepository',
    create: (_root, budget) =>
      Promise.resolve(new InMemoryMemoryDeliveryRepository({ pendingFeedbackRetryPolicy: budget })),
    reopen: (_root, previous) => Promise.resolve(previous),
    durable: false,
  },
];

// ════════════════════════════════════════════════════════
//  组装
// ════════════════════════════════════════════════════════

interface HarnessOptions {
  root?: string;
  case?: DeliveryCase;
  repository?: MemoryRepository;
  delivery?: MemoryDeliveryRepository;
  runStore?: MaintenanceRunStore;
  clock?: TestClock;
  timers?: ManualTimers;
  lease_ms?: number;
  worker_id?: string;
  /** false 时跳过 Agent 初始化（复用一个已经初始化过的仓库时用） */
  initialize?: boolean;
}

interface Harness {
  root: string;
  repository: MemoryRepository;
  delivery: MemoryDeliveryRepository;
  runStore: MaintenanceRunStore;
  clock: TestClock;
  timers: ManualTimers;
  processor: DefaultDriverFeedbackProcessor;
  worker: DriverFeedbackWorker;
  /** 把一条反馈提交进 outbox */
  submit(record: DriverFeedbackRecord): Promise<void>;
  /** 写一条经验进仓库 */
  seedExperience(roleId?: string, experienceId?: string): Promise<ExperienceRecord>;
  /** 换一个指向同一份存储的新 worker（模拟进程重启） */
  restart(): Promise<Harness>;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  // 缺省走文件腿（真的持久化、真的锁）——矩阵化的用例都显式传 case，不走这个缺省
  const adapterCase = options.case ?? DELIVERY_CASES[0]!;
  const root = options.root ?? (await tempRoot());
  const clock = options.clock ?? testClock();
  const timers = options.timers ?? manualTimers();
  const repository = options.repository ?? new InMemoryRepository();
  const delivery = options.delivery ?? (await adapterCase.create(root, PENDING_POLICY));
  const runStore = options.runStore ?? new FileMaintenanceRunStore({ root: join(root, 'runs') });

  if (options.initialize !== false) {
    for (const role of [ROLE, OTHER_ROLE]) {
      await repository.ensureAgent(role);
      await delivery.ensureAgent(role);
    }
  }

  const processor = new DefaultDriverFeedbackProcessor({
    deliveryRepository: delivery,
    repository,
    processor_version: 'feedback-worker-1.0',
    now: clock.now,
    timers,
    ...(options.lease_ms !== undefined ? { lease_ms: options.lease_ms } : {}),
  });
  const worker = new DriverFeedbackWorker({
    deliveryRepository: delivery,
    runStore,
    processor,
    worker_id: options.worker_id ?? 'fb-worker-a',
    now: clock.now,
    ...(options.lease_ms !== undefined ? { lease_ms: options.lease_ms } : {}),
  });

  const built: Harness = {
    root,
    repository,
    delivery,
    runStore,
    clock,
    timers,
    processor,
    worker,
    async submit(record) {
      await delivery.submitDriverFeedback(record);
    },
    async seedExperience(roleId = ROLE, experienceId = randomUUID()) {
      const experience = experienceFor(roleId, experienceId);
      await repository.saveExperienceIfAbsent(roleId, experience);
      return experience;
    },
    async restart() {
      const reopened = await adapterCase.reopen(root, delivery);
      // 进程重启：交付存储换一个新实例指向同一份存储；记忆仓库沿用同一份（内存实现本来
      // 就没有持久层，换一个新的等于换了一条记忆，那不是「重启」而是「换机器」）
      return harness({
        ...options,
        root,
        repository,
        delivery: reopened,
        clock,
        timers,
        initialize: false,
      });
    },
  };
  return built;
}

/** 一条待归并反馈记录（测试直接读 pending 通道用） */
async function pendingRecords(
  delivery: MemoryDeliveryRepository,
  roleId = ROLE,
): Promise<PendingFeedbackRecord[]> {
  return delivery.listPendingFeedback({ role_id: roleId });
}

/** 仓库里那条经验（断言回写结果用） */
async function storedExperience(
  repository: MemoryRepository,
  experienceId: string,
  roleId = ROLE,
): Promise<ExperienceRecord> {
  const found = (await repository.listExperiences(roleId)).find((item) => item.id === experienceId);
  if (!found) throw new Error(`Experience ${experienceId} is not in the repository`);
  return found;
}

// ════════════════════════════════════════════════════════
//  1. 待归并通道的存储契约（三条腿）
// ════════════════════════════════════════════════════════

describe.each(DELIVERY_CASES)('待归并反馈存储契约 — $name', ({ create, reopen, name }) => {
  it('按 feedback_id 幂等：同一条反馈只寄存一份，且不覆盖已推进的记录', async () => {
    const root = await tempRoot();
    const store = await create(root, PENDING_POLICY);
    await store.ensureAgent(ROLE);
    const feedback = feedbackFor(ROLE, randomUUID());

    const first = await store.submitPendingFeedback(buildPending(feedback));
    expect(first.created).toBe(true);
    const again = await store.submitPendingFeedback(buildPending(feedback));
    expect(again.created).toBe(false);
    expect(await pendingRecords(store)).toHaveLength(1);

    // 已经被归并任务 claim 走的记录不能被上游重放拽回 pending
    const claimed = await store.claimDelivery({
      channel: 'pending_feedback',
      role_id: ROLE,
      id: feedback.feedback_id,
      owner: 'reconciler-a',
      now: first.item.created_at,
    });
    expect(claimed?.channel).toBe('pending_feedback');
    const replay = await store.submitPendingFeedback(buildPending(feedback));
    expect(replay.created).toBe(false);
    expect(replay.item.status).toBe('processing');
  });

  it('寄存的记录自带原始反馈副本，可按关联经验与状态查询', async () => {
    const root = await tempRoot();
    const store = await create(root, PENDING_POLICY);
    await store.ensureAgent(ROLE);
    const experienceId = randomUUID();
    const feedback = feedbackFor(ROLE, experienceId, { note: 'used the retry budget' });
    await store.submitPendingFeedback(buildPending(feedback));

    const [parked] = await pendingRecords(store);
    expect(parked?.feedback).toEqual(DriverFeedbackContentSchema.parse(feedback));
    expect(parked?.experience_id).toBe(experienceId);
    expect(await store.listPendingFeedback({ experience_id: experienceId })).toHaveLength(1);
    expect(await store.listPendingFeedback({ experience_id: randomUUID() })).toHaveLength(0);
    expect(await store.listPendingFeedback({ status: 'processing' })).toHaveLength(0);
    expect(await store.listPendingFeedback({ status: 'pending' })).toHaveLength(1);
  });

  it('三条通道互不串味：claim 只在本通道的记录里挑', async () => {
    const root = await tempRoot();
    const store = await create(root, PENDING_POLICY);
    await store.ensureAgent(ROLE);
    const feedback = feedbackFor(ROLE, randomUUID());
    await store.submitDriverFeedback(feedback);
    await store.submitPendingFeedback(buildPending(feedback));

    const parked = await store.claimNextDelivery({
      channel: 'pending_feedback',
      owner: 'reconciler-a',
      now: START,
    });
    expect(parked?.channel).toBe('pending_feedback');
    // outbox 那条没被动过：它是另一条通道的活
    expect((await store.getDriverFeedback(ROLE, feedback.feedback_id))?.status).toBe('pending');

    const outbox = await store.claimNextDelivery({
      channel: 'feedback',
      owner: 'consumer-a',
      now: START,
    });
    expect(outbox?.channel).toBe('feedback');
  });

  it('重启后待归并记录还在（内存实现不假装持久化）', async () => {
    const root = await tempRoot();
    const store = await create(root, PENDING_POLICY);
    await store.ensureAgent(ROLE);
    const feedback = feedbackFor(ROLE, randomUUID());
    await store.submitPendingFeedback(buildPending(feedback));

    const reopened = await reopen(root, store);
    const records = await pendingRecords(reopened);
    if (name.startsWith('InMemory')) {
      expect(records).toHaveLength(1);
    } else {
      expect(records.map((record) => record.feedback_id)).toEqual([feedback.feedback_id]);
    }
  });

  it('deleteAgent 把待归并记录一并清掉（与 Buffer/交付存储同一次清理）', async () => {
    const root = await tempRoot();
    const store = await create(root, PENDING_POLICY);
    await store.ensureAgent(ROLE);
    await store.submitPendingFeedback(buildPending(feedbackFor(ROLE, randomUUID())));

    await store.deleteAgent(ROLE);

    expect(await pendingRecords(store)).toHaveLength(0);
  });

  it('各通道带着自己的重试预算：上下文走基策略，反馈与待归并各有覆盖', async () => {
    const root = await tempRoot();
    const store = await new FileMemoryDeliveryRepository({ agentStateRoot: root });
    expect(store.policy.channel_retry_policies?.feedback).toEqual(
      DEFAULT_FEEDBACK_CONSUME_RETRY_POLICY,
    );
    expect(store.policy.channel_retry_policies?.pending_feedback).toEqual(
      DEFAULT_PENDING_FEEDBACK_RETRY_POLICY,
    );
    // 基策略仍是 Phase 0/1 的那份：上下文通道的行为不因 Phase 2 改变
    expect(store.policy.max_attempts).toBe(3);
    expect(store.policy.channel_retry_policies?.context).toBeUndefined();
  });
});

/**
 * 由一条反馈造出它的待归并记录。
 *
 * 与生产同形：副本是反馈的**内容**（`DriverFeedbackContent`），不带交付状态机字段。
 * 这里刻意不走 buildPendingFeedbackRecord，是为了让存储契约的用例只依赖端口语义
 * ——处理器那条构造路径由消费/归并两节单独验。
 */
function buildPending(feedback: DriverFeedbackRecord): PendingFeedbackRecord {
  return {
    feedback_id: feedback.feedback_id,
    role_id: feedback.role_id,
    experience_id: feedback.experience_id,
    feedback: DriverFeedbackContentSchema.parse(feedback),
    status: 'pending',
    attempt_count: 0,
    created_at: feedback.observed_at,
    updated_at: feedback.observed_at,
  };
}

// ════════════════════════════════════════════════════════
//  2. 消费：一条反馈怎么变成经验上的一次回写
// ════════════════════════════════════════════════════════

describe.each(DELIVERY_CASES)('Driver Feedback Worker 消费 — $name', (adapterCase) => {
  it('经验已存在：反馈写进经验，交付 processed（一次业务应用）', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const experience = await h.seedExperience(ROLE, randomUUID());
    const feedback = feedbackFor(ROLE, experience.id, { note: 'confidence grew' });
    await h.submit(feedback);

    const result = await h.worker.runOnce();

    expect(result.job).toBe('driver_feedback');
    expect(result.stop_reason).toBe('no_work');
    expect(result.counts.claimed_count).toBe(1);
    expect(result.counts.completed_count).toBe(1);
    expect(result.outcomes[0]?.application).toBe('applied');

    const updated = await storedExperience(h.repository, experience.id);
    expect(updated.confidence).toBe(0.9);
    expect(updated.referenced_count).toBe(2);
    expect(updated.last_referenced_at).toBe(START);
    expect(updated.confidence_history.at(-1)?.feedback_id).toBe(feedback.feedback_id);
    expect((await h.delivery.getDriverFeedback(ROLE, feedback.feedback_id))?.status).toBe(
      'processed',
    );
    // 没有经验缺席，就没有待归并记录
    expect(await pendingRecords(h.delivery)).toHaveLength(0);
  });

  it('经验还不存在：先寄存再 ack，反馈不丢', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const experienceId = randomUUID();
    const feedback = feedbackFor(ROLE, experienceId, { note: 'no experience yet' });
    await h.submit(feedback);

    const result = await h.worker.runOnce();

    expect(result.counts.completed_count).toBe(1);
    expect(result.outcomes[0]?.application).toBe('parked');
    const parked = await pendingRecords(h.delivery);
    expect(parked).toHaveLength(1);
    // 副本是反馈的**内容**：payload 与关联键原样保留，交付进度（状态/投递次数/凭据/租约）
    // 一个字都不带——同一个 payload 里不该出现第二个、而且是冻结的状态
    expect(parked[0]?.feedback).toEqual(DriverFeedbackContentSchema.parse(feedback));
    expect(parked[0]?.feedback).not.toHaveProperty('status');
    expect(parked[0]?.experience_id).toBe(experienceId);
    expect((await h.delivery.getDriverFeedback(ROLE, feedback.feedback_id))?.status).toBe(
      'processed',
    );
  });

  it('重复投递（崩溃后重跑：经验已经写过，交付又被投一次）只应用一次', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const experience = await h.seedExperience(ROLE, randomUUID());
    const feedback = feedbackFor(ROLE, experience.id);
    // 模拟「应用成功、ack 没落地」之后的重跑：反馈已经作用过这条经验
    await h.repository.applyExperienceFeedback(ROLE, {
      feedback_id: feedback.feedback_id,
      experience_id: experience.id,
      applied: true,
      effectiveness: 'fully_effective',
      note: feedback.note,
      observed_at: START,
      feedback_source: 'driver_usage',
    });
    const afterFirstApply = await storedExperience(h.repository, experience.id);
    await h.submit(feedback);

    const result = await h.worker.runOnce();

    expect(result.outcomes[0]?.application).toBe('already_applied');
    const updated = await storedExperience(h.repository, experience.id);
    expect(updated.confidence).toBe(afterFirstApply.confidence);
    expect(updated.referenced_count).toBe(afterFirstApply.referenced_count);
    expect(updated.confidence_history).toHaveLength(afterFirstApply.confidence_history.length);
  });

  it('同一条反馈在 outbox 里只会有一条，第二次运行无事可做', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const experience = await h.seedExperience(ROLE, randomUUID());
    const feedback = feedbackFor(ROLE, experience.id);
    await h.submit(feedback);
    await h.submit(feedback);

    const first = await h.worker.runOnce();
    const second = await h.worker.runOnce();

    expect(first.counts.completed_count).toBe(1);
    expect(second.counts.claimed_count).toBe(0);
    expect((await storedExperience(h.repository, experience.id)).referenced_count).toBe(2);
  });

  it('契约版本不认识：坏输入进死信，不重投也不落经验', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const experience = await h.seedExperience(ROLE, randomUUID());
    const feedback = {
      ...feedbackFor(ROLE, experience.id),
      event_version: 'driver-usage.v2',
    };
    await h.submit(feedback);

    const result = await h.worker.runOnce();

    expect(result.outcomes[0]?.status).toBe('dead_letter');
    expect(result.outcomes[0]?.failure?.code).toBe('payload_unreadable');
    expect(result.counts.dead_letter_count).toBe(1);
    const stored = await h.delivery.getDriverFeedback(ROLE, feedback.feedback_id);
    expect(stored?.status).toBe('dead_letter');
    // 经验没被动过，也没有寄存
    expect((await storedExperience(h.repository, experience.id)).referenced_count).toBe(1);
    expect(await pendingRecords(h.delivery)).toHaveLength(0);
  });

  it('记录被改过（声明的键与自己的因子对不上）：坏输入进死信', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const experience = await h.seedExperience(ROLE, randomUUID());
    const feedback = feedbackFor(ROLE, experience.id);
    // 手工改过的记录：键还是那条经验的键，经验却被换成了另一条
    await h.submit({ ...feedback, experience_id: randomUUID() });

    const result = await h.worker.runOnce();

    expect(result.outcomes[0]?.status).toBe('dead_letter');
    expect(result.outcomes[0]?.failure?.code).toBe('payload_unreadable');
    expect(result.outcomes[0]?.failure?.message).toContain('but its own fields derive');
    expect(result.counts.dead_letter_count).toBe(1);
  });

  it('没有活就立刻返回：不轮询、不空转，run 照旧收尾', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });

    const result = await h.worker.runOnce();

    expect(result.stop_reason).toBe('no_work');
    expect(result.counts).toMatchObject({ claimed_count: 0, completed_count: 0 });
    expect(result.run.status).toBe('completed');
    expect(await h.runStore.list({ job_type: 'driver_feedback' })).toHaveLength(1);
  });

  it('只消费本 role 的反馈（跨 role 缺省才全量）', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const mine = await h.seedExperience(ROLE, randomUUID());
    const theirs = await h.seedExperience(OTHER_ROLE, randomUUID());
    await h.submit(feedbackFor(ROLE, mine.id));
    await h.submit(feedbackFor(OTHER_ROLE, theirs.id));

    const scoped = await h.worker.runOnce({ role_id: ROLE });

    expect(scoped.counts.claimed_count).toBe(1);
    expect((await storedExperience(h.repository, mine.id)).referenced_count).toBe(2);
    expect((await storedExperience(h.repository, theirs.id, OTHER_ROLE)).referenced_count).toBe(1);
  });

  it('边界：不造 Context Delivery、不写 Skill、不碰 Persona', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const experience = await h.seedExperience(ROLE, randomUUID());
    await h.submit(feedbackFor(ROLE, experience.id));
    const missing = feedbackFor(ROLE, randomUUID());
    await h.submit(missing);

    const submitContext = vi.spyOn(h.delivery, 'submitContextDelivery');
    const saveSkill = vi.spyOn(h.repository, 'saveSkillIfAbsent');
    const updateSkill = vi.spyOn(h.repository, 'updateSkill');
    const savePersona = vi.spyOn(h.repository, 'savePersona');

    const consumed = await h.worker.runOnce();
    const reconciled = await h.worker.reconcilePending();

    expect(consumed.counts.completed_count).toBe(2);
    expect(reconciled.counts.claimed_count).toBe(1);
    expect(submitContext).not.toHaveBeenCalled();
    expect(saveSkill).not.toHaveBeenCalled();
    expect(updateSkill).not.toHaveBeenCalled();
    expect(savePersona).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════
//  3. 归并：反馈先到、Experience 后到
// ════════════════════════════════════════════════════════

describe.each(DELIVERY_CASES)('Driver Feedback Worker 归并 — $name', (adapterCase) => {
  it('反馈先到、经验后到：最终被归并进那条经验', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const experienceId = randomUUID();
    const feedback = feedbackFor(ROLE, experienceId, { note: 'arrived first' });
    await h.submit(feedback);

    const consume = await h.worker.runOnce();
    expect(consume.outcomes[0]?.application).toBe('parked');

    // 「上下文后到」：这条经验终于被提取出来了
    await h.seedExperience(ROLE, experienceId);
    h.clock.advance(60_000);

    const reconcile = await h.worker.reconcilePending();

    expect(reconcile.job).toBe('feedback_reconcile');
    expect(reconcile.counts.completed_count).toBe(1);
    expect(reconcile.outcomes[0]?.application).toBe('applied');
    const updated = await storedExperience(h.repository, experienceId);
    expect(updated.confidence).toBe(0.9);
    expect(updated.confidence_history.at(-1)?.feedback_id).toBe(feedback.feedback_id);
    const settled = await h.delivery.getPendingFeedback(ROLE, feedback.feedback_id);
    expect(settled?.status).toBe('processed');
  });

  it('经验一直不出现：有限次重试后退避进死信，原始反馈仍在', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const experienceId = randomUUID();
    const feedback = feedbackFor(ROLE, experienceId, { note: 'never lands' });
    await h.submit(feedback);
    await h.worker.runOnce();

    const statuses: string[] = [];
    for (let attempt = 0; attempt < PENDING_POLICY.max_attempts; attempt += 1) {
      h.clock.advance(120_000);
      const result = await h.worker.reconcilePending();
      statuses.push(result.outcomes[0]?.status ?? 'none');
    }
    expect(statuses).toEqual(['retried', 'retried', 'dead_letter']);

    // 用满次数之后不再无限重试：队列里没有可投递的记录
    h.clock.advance(120_000);
    const after = await h.worker.reconcilePending();
    expect(after.counts.claimed_count).toBe(0);

    const deadLettered = await h.delivery.getPendingFeedback(ROLE, feedback.feedback_id);
    expect(deadLettered?.status).toBe('dead_letter');
    expect(deadLettered?.attempt_count).toBe(PENDING_POLICY.max_attempts);
    expect(deadLettered?.last_error).toContain('experience_missing');
    // 人工处理所需的现场都还在：原始反馈与关联键
    expect(deadLettered?.feedback).toMatchObject({
      feedback_id: feedback.feedback_id,
      experience_id: experienceId,
      effectiveness: 'fully_effective',
      note: 'never lands',
      observed_at: START,
    });
    expect(deadLettered?.experience_id).toBe(experienceId);
  });

  it('寄存记录来自更早的契约版本：归并时当场进死信，不无限重试', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const feedback = feedbackFor(ROLE, randomUUID());
    await h.delivery.submitPendingFeedback({
      ...buildPending(feedback),
      feedback: { ...feedback, event_version: 'driver-usage.v9' },
    });

    const result = await h.worker.reconcilePending();

    expect(result.outcomes[0]?.status).toBe('dead_letter');
    expect(result.outcomes[0]?.failure?.retryable).toBe(false);
    expect(result.counts.dead_letter_count).toBe(1);
  });

  it('寄存记录里的 feedback_id 与自己的因子对不上：归并时进死信', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const feedback = feedbackFor(ROLE, randomUUID());
    await h.delivery.submitPendingFeedback({
      ...buildPending(feedback),
      feedback: { ...feedback, feedback_id: `${feedback.feedback_id}_tampered` },
    });

    const result = await h.worker.reconcilePending();

    expect(result.outcomes[0]?.status).toBe('dead_letter');
    expect(result.outcomes[0]?.failure?.message).toContain('does not match the id derived');
  });

  it('重启后仍能归并：新进程接着处理上一次寄存的记录', async () => {
    const root = await tempRoot();
    const first = await harness({ root, case: adapterCase });
    const experienceId = randomUUID();
    const feedback = feedbackFor(ROLE, experienceId);
    await first.submit(feedback);
    expect((await first.worker.runOnce()).outcomes[0]?.application).toBe('parked');

    // 换一个进程：新的交付存储实例 + 新的 worker（内存实现返回同一个实例）
    const restarted = await first.restart();
    await restarted.seedExperience(ROLE, experienceId);
    const result = await restarted.worker.reconcilePending();

    expect(result.counts.completed_count).toBe(1);
    const updated = await storedExperience(restarted.repository, experienceId);
    expect(updated.confidence).toBe(0.9);
  });

  it('归并任务只动待归并队列，不顺手消费 outbox', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const experience = await h.seedExperience(ROLE, randomUUID());
    await h.submit(feedbackFor(ROLE, experience.id, { note: 'still in the outbox' }));

    const result = await h.worker.reconcilePending();

    expect(result.counts.claimed_count).toBe(0);
    expect((await storedExperience(h.repository, experience.id)).referenced_count).toBe(1);
  });
});

// ════════════════════════════════════════════════════════
//  4. lease：续租、过期与 fencing
// ════════════════════════════════════════════════════════

describe('Driver Feedback Worker — lease 续租与 fencing', () => {
  it('处理途中续租成功：记录始终归属本 worker，最终完成', async () => {
    const h = await harness({ lease_ms: 900 });
    const experience = await h.seedExperience(ROLE, randomUUID());
    const feedback = feedbackFor(ROLE, experience.id);
    await h.submit(feedback);

    const renew = vi.spyOn(h.delivery, 'renewDeliveryClaim');
    const original = h.repository.applyExperienceFeedback.bind(h.repository);
    let release: (() => void) | undefined;
    vi.spyOn(h.repository, 'applyExperienceFeedback').mockImplementation(async (roleId, input) => {
      h.clock.advance(400);
      h.timers.fire();
      await waitFor(() => renew.mock.calls.length >= 1, 'the lease renewal');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(roleId, input);
    });

    const pending = h.worker.runOnce();
    await waitFor(() => release !== undefined, 'the feedback application to start');
    // 续租之后租约被推到更晚：另一个 worker 想抢也抢不走
    expect(
      await h.delivery.restoreExpiredDeliveryClaims({ channel: 'feedback', now: h.clock.now() }),
    ).toEqual([]);
    release?.();
    const result = await pending;

    expect(renew).toHaveBeenCalled();
    expect(result.counts.completed_count).toBe(1);
    expect((await storedExperience(h.repository, experience.id)).confidence).toBe(0.9);
  });

  it('续租失败（记录已被别人接手）：旧 worker 不写任何终态', async () => {
    const h = await harness({ lease_ms: 900 });
    const experience = await h.seedExperience(ROLE, randomUUID());
    const feedback = feedbackFor(ROLE, experience.id);
    await h.submit(feedback);

    const original = h.repository.applyExperienceFeedback.bind(h.repository);
    let settledRenewals = 0;
    const renew = vi.spyOn(h.delivery, 'renewDeliveryClaim').mockImplementation(async () => {
      settledRenewals += 1;
      return undefined;
    });
    let release: (() => void) | undefined;
    let applied = false;
    vi.spyOn(h.repository, 'applyExperienceFeedback').mockImplementation(async (roleId, input) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      applied = true;
      return original(roleId, input);
    });

    const inFlight = h.worker.runOnce();
    await waitFor(() => release !== undefined, 'the feedback application to start');
    // 另一个 worker 接管：先按过期回收，再重新 claim（拿到的是新凭据）
    h.clock.advance(2_000);
    await h.delivery.restoreExpiredDeliveryClaims({ channel: 'feedback', now: h.clock.now() });
    const takenOver = await h.delivery.claimDelivery({
      channel: 'feedback',
      role_id: ROLE,
      id: feedback.feedback_id,
      owner: 'fb-worker-b',
      now: h.clock.now(),
    });
    expect(takenOver?.channel).toBe('feedback');

    h.timers.fire();
    await waitFor(() => settledRenewals >= 1, 'the lease renewal to settle');
    release?.();
    const result = await inFlight;

    expect(renew).toHaveBeenCalled();
    expect(applied).toBe(true);
    expect(result.outcomes[0]?.status).toBe('skipped');
    expect(result.counts.skipped_count).toBe(1);
    expect(result.counts.completed_count).toBe(0);
    // 终态没被旧 worker 写掉：记录仍是新持有者手里的 processing
    const current = await h.delivery.getDriverFeedback(ROLE, feedback.feedback_id);
    expect(current?.status).toBe('processing');
    expect(current?.claim_owner).toBe('fb-worker-b');
  });

  it('claim 之后租约过期：启动恢复把它放回队列，另一个 worker 能接着做', async () => {
    const h = await harness({ lease_ms: 900, worker_id: 'fb-worker-a' });
    const experienceId = randomUUID();
    const feedback = feedbackFor(ROLE, experienceId);
    await h.submit(feedback);

    // 上一个进程 claim 走之后就没了（不处理、不续租）
    await h.delivery.claimNextDelivery({ channel: 'feedback', owner: 'fb-worker-a', now: START });
    // 存储自己的租约（缺省 60s）过得比 worker 的 900ms 慢：按它来判过期
    h.clock.advance(90_000);

    const other = new DriverFeedbackWorker({
      deliveryRepository: h.delivery,
      runStore: h.runStore,
      processor: h.processor,
      worker_id: 'fb-worker-b',
      now: h.clock.now,
      lease_ms: 900,
    });
    const result = await other.runOnce();

    expect(result.restored_count).toBe(1);
    expect(result.counts.completed_count).toBe(1);
    expect(result.outcomes[0]?.application).toBe('parked');
    expect(await pendingRecords(h.delivery)).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════
//  5. applyExperienceFeedback 的契约（两种记忆仓库）
// ════════════════════════════════════════════════════════

interface MemoryCase {
  name: string;
  create: () => Promise<MemoryRepository>;
}

const MEMORY_CASES: MemoryCase[] = [
  {
    name: 'InMemoryRepository',
    create: () => Promise.resolve(new InMemoryRepository()),
  },
  {
    name: 'PgMemoryRepository（PGlite）',
    create: async () => {
      const pool = await pgMemoryPool();
      await ensurePgMemorySchema(pool, new HashEmbeddingProvider().dimensions);
      pgMemoryTouched = true;
      return new PgMemoryRepository({ pool });
    },
  },
];

describe.each(MEMORY_CASES)('applyExperienceFeedback 契约 — $name', ({ create }) => {
  it('经验存在：置信度按效果调整、引用计数 +1、历史带上反馈 id', async () => {
    const repository = await create();
    await repository.ensureAgent(ROLE);
    const experience = experienceFor(ROLE, randomUUID());
    await repository.saveExperienceIfAbsent(ROLE, experience);

    const result = await repository.applyExperienceFeedback(ROLE, {
      feedback_id: 'drvfb_test_one',
      experience_id: experience.id,
      applied: true,
      effectiveness: 'partially_effective',
      note: 'helped a bit',
      observed_at: '2026-10-10T01:00:00.000Z',
      feedback_source: 'driver_usage',
    });

    expect(result.outcome).toBe('applied');
    const updated = (await repository.listExperiences(ROLE))[0]!;
    expect(updated.confidence).toBe(0.85);
    expect(updated.referenced_count).toBe(2);
    expect(updated.last_referenced_at).toBe('2026-10-10T01:00:00.000Z');
    expect(updated.confidence_history.at(-1)).toMatchObject({
      reason: 'usage_validation:partially_effective',
      feedback_id: 'drvfb_test_one',
    });
    // 聚合根跟着走：均值反映回写后的经验集合
    expect((await repository.getMetrics(ROLE)).avg_confidence).toBe(0.85);
  });

  it('同一条反馈应用两次：第二次是幂等命中，什么都不改', async () => {
    const repository = await create();
    await repository.ensureAgent(ROLE);
    const experience = experienceFor(ROLE, randomUUID());
    await repository.saveExperienceIfAbsent(ROLE, experience);
    const input = {
      feedback_id: 'drvfb_test_twice',
      experience_id: experience.id,
      applied: true,
      effectiveness: 'fully_effective' as const,
      note: 'ok',
      observed_at: '2026-10-10T01:00:00.000Z',
      feedback_source: 'driver_usage' as const,
    };

    const first = await repository.applyExperienceFeedback(ROLE, input);
    const second = await repository.applyExperienceFeedback(ROLE, input);

    expect(first.outcome).toBe('applied');
    expect(second.outcome).toBe('already_applied');
    const updated = (await repository.listExperiences(ROLE))[0]!;
    expect(updated.confidence).toBe(0.9);
    expect(updated.referenced_count).toBe(2);
    expect(updated.confidence_history).toHaveLength(2);
  });

  it('经验不存在：如实回答，不建经验也不动别的记录', async () => {
    const repository = await create();
    await repository.ensureAgent(ROLE);

    const result = await repository.applyExperienceFeedback(ROLE, {
      feedback_id: 'drvfb_test_missing',
      experience_id: randomUUID(),
      applied: true,
      effectiveness: 'ineffective',
      note: 'nope',
      observed_at: '2026-10-10T01:00:00.000Z',
      feedback_source: 'driver_usage',
    });

    expect(result).toEqual({ outcome: 'experience_missing' });
    expect(await repository.listExperiences(ROLE)).toEqual([]);
  });

  it('两条不同的反馈并发写同一条经验：都落地，谁也没被覆盖', async () => {
    const repository = await create();
    await repository.ensureAgent(ROLE);
    const experience = experienceFor(ROLE, randomUUID());
    await repository.saveExperienceIfAbsent(ROLE, experience);
    const application = (feedbackId: string, effectiveness: 'fully_effective' | 'ineffective') => ({
      feedback_id: feedbackId,
      experience_id: experience.id,
      applied: true,
      effectiveness,
      note: feedbackId,
      observed_at: '2026-10-10T01:00:00.000Z',
      feedback_source: 'driver_usage' as const,
    });

    const [up, down] = await Promise.all([
      repository.applyExperienceFeedback(ROLE, application('drvfb_conc_up', 'fully_effective')),
      repository.applyExperienceFeedback(ROLE, application('drvfb_conc_down', 'ineffective')),
    ]);

    expect([up.outcome, down.outcome]).toEqual(['applied', 'applied']);
    const updated = (await repository.listExperiences(ROLE))[0]!;
    expect(updated.referenced_count).toBe(3);
    // 一次 +0.1、一次 -0.1：两条都生效，净值回到起点（丢更新就会少一条历史）
    expect(updated.confidence).toBe(0.8);
    expect(updated.confidence_history.map((entry) => entry.feedback_id)).toEqual(
      expect.arrayContaining(['drvfb_conc_up', 'drvfb_conc_down']),
    );
  });
});

// ════════════════════════════════════════════════════════
//  6. 运行外壳的边界
// ════════════════════════════════════════════════════════

describe('Driver Feedback Worker — 运行外壳', () => {
  it('batchSize 上限与停止原因', async () => {
    const h = await harness();
    const experience = await h.seedExperience(ROLE, randomUUID());
    for (let index = 0; index < 3; index += 1) {
      await h.submit(feedbackFor(ROLE, experience.id, { task_id: `task_${String(index)}` }));
    }

    const result: DriverFeedbackRunResult = await h.worker.runOnce({ batchSize: 2 });

    expect(result.stop_reason).toBe('batch_size');
    expect(result.counts.claimed_count).toBe(2);
    expect(result.counts.completed_count).toBe(2);
  });

  it('run 的失败与记录无关：外壳读取失败时 run 标 failed，记录还在', async () => {
    const h = await harness();
    const experience = await h.seedExperience(ROLE, randomUUID());
    const feedback = feedbackFor(ROLE, experience.id);
    await h.submit(feedback);
    vi.spyOn(h.delivery, 'claimNextDelivery').mockRejectedValueOnce(
      Object.assign(new Error('database is gone'), { code: 'ECONNRESET' }),
    );

    const result = await h.worker.runOnce();

    expect(result.stop_reason).toBe('worker_error');
    expect(result.worker_failure?.code).toBe('downstream_unavailable');
    expect(result.run.status).toBe('failed');
    // 记录没被动过：下次运行照样能消费
    expect((await h.delivery.getDriverFeedback(ROLE, feedback.feedback_id))?.status).toBe('pending');
  });

  it('单条处理器的异常不掀掉整批', async () => {
    const h = await harness();
    const experience = await h.seedExperience(ROLE, randomUUID());
    await h.submit(feedbackFor(ROLE, experience.id));
    await h.submit(feedbackFor(ROLE, experience.id, { task_id: 'task_second' }));
    const original = h.processor.process.bind(h.processor);
    let calls = 0;
    vi.spyOn(h.processor, 'process').mockImplementation(async (delivery, context) => {
      calls += 1;
      if (calls === 1) throw new Error('processor blew up');
      return original(delivery, context);
    });

    const result = await h.worker.runOnce();

    expect(result.counts.claimed_count).toBe(2);
    expect(result.counts.failure_count).toBe(1);
    expect(result.counts.completed_count).toBe(1);
    expect(result.outcomes[0]?.status).toBe('failed');
    expect(result.outcomes[1]?.status).toBe('completed');
  });

  it('abort signal：置位后不再 claim 新的记录', async () => {
    const h = await harness();
    const experience = await h.seedExperience(ROLE, randomUUID());
    await h.submit(feedbackFor(ROLE, experience.id));
    const controller = new AbortController();
    controller.abort();

    const result = await h.worker.runOnce({ signal: controller.signal });

    expect(result.stop_reason).toBe('aborted');
    expect(result.counts.claimed_count).toBe(0);
  });

  it('两种 job 各开自己的 run，计数与类型都不串', async () => {
    const h = await harness();
    const experienceId = randomUUID();
    await h.submit(feedbackFor(ROLE, experienceId));

    const consume = await h.worker.runOnce();
    const reconcile = await h.worker.reconcilePending();

    expect([consume.run.job_type, reconcile.run.job_type]).toEqual([
      'driver_feedback',
      'feedback_reconcile',
    ]);
    expect(await h.runStore.list({ job_type: 'driver_feedback' })).toHaveLength(1);
    expect(await h.runStore.list({ job_type: 'feedback_reconcile' })).toHaveLength(1);
    expect(consume.counts.completed_count).toBe(1);
    expect(reconcile.counts.completed_count).toBe(0);
    expect(reconcile.counts.retried_count).toBe(1);
  });
});
