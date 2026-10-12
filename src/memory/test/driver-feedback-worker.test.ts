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
import {
  buildDriverUsageFeedbackRecords,
  driverFeedbackId,
  driverFeedbackKey,
} from '../services/context-delivery';
import {
  DEFAULT_FEEDBACK_CONSUME_RETRY_POLICY,
  DEFAULT_PENDING_FEEDBACK_RETRY_POLICY,
  type DeliveryRetryPolicy,
} from '../services/delivery-lifecycle';
import type { LeaseTimers } from '../services/lease-heartbeat';
import type { MemoryDeliveryRepository } from '../ports/memory-delivery';
import type { MemoryRepository } from '../ports/memory-repository';
import type { MaintenanceRunStore } from '../ports/maintenance-run-store';
import type { SqlPool, SqlQueryResult } from '../ports/sql-pool';
import { DRIVER_FEEDBACK_EVENT_VERSION, DriverFeedbackContentSchema } from '../schemas';
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

  /**
   * 「经验还没出现」与「不可能出现的经验 id」必须分开：前者寄存等待，后者当场进死信。
   * 这类记录只能由存储层直接写入（构造器已经在入口丢掉它们），所以这里手工造一条——
   * 键与 id 自洽、只有 experience_id 的形状不对。
   */
  it('引用的 id 连经验 id 的形状都不对：当场进死信，不寄存也不重试', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const placeholderId = 'context-experience-1';
    const feedback_key = driverFeedbackKey({
      role_id: ROLE,
      task_id: 'task_shape',
      experience_id: placeholderId,
      feedback_source: 'driver_usage',
      event_version: DRIVER_FEEDBACK_EVENT_VERSION,
    });
    await h.submit({
      feedback_id: driverFeedbackId(feedback_key),
      feedback_key,
      role_id: ROLE,
      task_id: 'task_shape',
      experience_id: placeholderId,
      applied: true,
      effectiveness: 'fully_effective',
      note: 'driver misread a context placeholder as an experience id',
      observed_at: START,
      feedback_source: 'driver_usage',
      event_version: DRIVER_FEEDBACK_EVENT_VERSION,
      status: 'pending',
      attempt_count: 0,
      created_at: START,
      updated_at: START,
    });

    const result = await h.worker.runOnce();

    expect(result.outcomes[0]?.status).toBe('dead_letter');
    expect(result.outcomes[0]?.failure?.retryable).toBe(false);
    expect(result.counts.dead_letter_count).toBe(1);
    // 不进待归并队列：等一条永远不会出现的经验只是白占一段保留期
    expect(await h.delivery.listPendingFeedback({ role_id: ROLE })).toHaveLength(0);
  });

  it('寄存记录里的 feedback_id 与它携带的内容对不上：归并时进死信，且报出两侧的值', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const feedback = feedbackFor(ROLE, randomUUID());
    await h.delivery.submitPendingFeedback({
      ...buildPending(feedback),
      feedback: { ...feedback, feedback_id: `${feedback.feedback_id}_tampered` },
    });

    const result = await h.worker.reconcilePending();

    expect(result.outcomes[0]?.status).toBe('dead_letter');
    expect(result.outcomes[0]?.failure?.code).toBe('payload_unreadable');
    expect(result.outcomes[0]?.failure?.retryable).toBe(false);
    // 诊断要把矛盾的两侧都写出来：这条记录从此只在死信里，人工恢复时不该再去库外对读一遍
    expect(result.outcomes[0]?.failure?.message).toContain('contradicts its own payload');
    expect(result.outcomes[0]?.failure?.message).toContain(`${feedback.feedback_id}_tampered`);
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
//  4. 待归并记录的关联键自洽（顶层字段 vs 它携带的内容）
// ════════════════════════════════════════════════════════

/**
 * 一条待归并记录把同一组关联键抄了两处：顶层（`feedback_id` / `role_id` / `experience_id`，
 * claim/lease/ack/fail 用的就是它们）与它携带的反馈内容（应用写入用的那一份）。两处不一致
 * 说明这份记录被手工改过或来自另一套构造规则，**必须在归并之前挡住**——应用走内容、死信
 * 落点走顶层，照它写下去要么把反馈写进另一个 Agent 的经验，要么让死信落在一条与内容无关
 * 的记录上。
 *
 * 两条腿（文件 / 内存）都跑：这条判据落在处理器里，但「记录从存储里读回来时字段
 * 还是不是我们写进去的那两个」属于各后端的义务。
 */
describe.each(DELIVERY_CASES)('待归并记录关联键不一致 — $name', (adapterCase) => {
  /**
   * 直接往待归并队列塞一条顶层与内容对不上的记录。
   *
   * 绕过 buildPendingFeedbackRecord（它构造出来的两份必然一致），模拟「被手工改过或来自
   * 另一套构造规则」的历史数据——这正是这条判据要挡的输入。
   */
  async function parkInconsistent(
    h: Harness,
    record: PendingFeedbackRecord,
  ): Promise<PendingFeedbackRecord> {
    const parked = await h.delivery.submitPendingFeedback(record);
    expect(parked.created).toBe(true);
    return parked.item;
  }

  it('顶层 role_id 与内容不一致：不写任何经验，进死信', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const experienceId = randomUUID();
    const declared = feedbackFor(ROLE, experienceId);
    const ours = await h.seedExperience(ROLE, experienceId);
    const theirs = await h.seedExperience(OTHER_ROLE, experienceId);
    // 内容说 ROLE、顶层说 OTHER_ROLE：照顶层 claim/落死信，照内容写经验
    await parkInconsistent(h, {
      ...buildPending(declared),
      role_id: OTHER_ROLE,
      feedback_id: declared.feedback_id,
    });

    const result = await h.worker.reconcilePending();

    expect(result.outcomes[0]?.status).toBe('dead_letter');
    expect(result.outcomes[0]?.failure?.code).toBe('payload_unreadable');
    expect(result.outcomes[0]?.failure?.retryable).toBe(false);
    expect(result.outcomes[0]?.failure?.message).toContain('role_id');
    // 内容指向的那条经验没被碰过：跨 Agent 的写入没有发生
    expect(await storedExperience(h.repository, experienceId)).toMatchObject({
      confidence: ours.confidence,
      referenced_count: ours.referenced_count,
    });
    expect(await storedExperience(h.repository, experienceId, OTHER_ROLE)).toMatchObject({
      confidence: theirs.confidence,
      referenced_count: theirs.referenced_count,
    });
  });

  it('顶层 experience_id 与内容不一致：不写任何经验，进死信', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const declared = feedbackFor(ROLE, randomUUID());
    const actual = await h.seedExperience(ROLE, declared.experience_id);
    await parkInconsistent(h, {
      ...buildPending(declared),
      experience_id: randomUUID(),
      feedback_id: declared.feedback_id,
    });

    const result = await h.worker.reconcilePending();

    expect(result.outcomes[0]?.status).toBe('dead_letter');
    expect(result.outcomes[0]?.failure?.message).toContain('experience_id');
    expect(await storedExperience(h.repository, actual.id)).toMatchObject({
      confidence: actual.confidence,
      referenced_count: actual.referenced_count,
      confidence_history: actual.confidence_history,
    });
  });

  it('顶层 feedback_id 与内容不一致：进死信，幂等键不受影响', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const declared = feedbackFor(ROLE, randomUUID());
    const experience = await h.seedExperience(ROLE, declared.experience_id);
    await parkInconsistent(h, {
      ...buildPending(declared),
      feedback_id: `${declared.feedback_id}_top_level`,
    });

    const result = await h.worker.reconcilePending();

    expect(result.outcomes[0]?.status).toBe('dead_letter');
    expect(result.outcomes[0]?.failure?.message).toContain('feedback_id');
    expect(await storedExperience(h.repository, experience.id)).toMatchObject({
      confidence: experience.confidence,
      referenced_count: experience.referenced_count,
    });
  });

  it('坏记录不落经验：经验集与 Agent 聚合一个数都不动', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const declared = feedbackFor(ROLE, randomUUID());
    const seeded = await h.seedExperience(ROLE, declared.experience_id);
    // 读回存过的那一份再比：seedExperience 返回的是写之前的记录（仓库落盘时会补向量）
    const before = await storedExperience(h.repository, seeded.id);
    const metricsBefore = await h.repository.getMetrics(ROLE);
    await parkInconsistent(h, { ...buildPending(declared), role_id: OTHER_ROLE });

    await h.worker.reconcilePending();

    expect(await storedExperience(h.repository, seeded.id)).toEqual(before);
    expect(await h.repository.getMetrics(ROLE)).toEqual(metricsBefore);
  });

  it('坏记录不会无限重试：一次归并即进死信，再跑也 claim 不到', async () => {
    const root = await tempRoot();
    const h = await harness({ root, case: adapterCase });
    const declared = feedbackFor(ROLE, randomUUID());
    const parked = await parkInconsistent(h, { ...buildPending(declared), role_id: OTHER_ROLE });

    const result = await h.worker.reconcilePending();

    // 一次就定局：不可重试的坏输入不该占用归并通道 20 次 / 3.8 小时的预算
    expect(result.counts.dead_letter_count).toBe(1);
    expect(result.counts.retried_count).toBe(0);
    expect(result.outcomes[0]?.attempt_count).toBe(1);

    // 再跑几轮也 claim 不到它，且不会把它拽回 pending
    for (let round = 0; round < 3; round += 1) {
      h.clock.advance(120_000);
      const again = await h.worker.reconcilePending();
      expect(again.counts.claimed_count).toBe(0);
    }
    const settled = await h.delivery.getPendingFeedback(parked.role_id, parked.feedback_id);
    expect(settled?.status).toBe('dead_letter');
    expect(settled?.attempt_count).toBe(1);
    // 人工处理所需的现场仍在：两边冲突的值都留在这条记录里
    expect(settled?.feedback.role_id).toBe(ROLE);
    expect(settled?.role_id).toBe(OTHER_ROLE);
  });
});

// ════════════════════════════════════════════════════════
//  5. lease：续租、过期与 fencing
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
  /**
   * 实现是否把记忆放在数据库里。
   *
   * 用得上的地方是「读快照 → 写回」的窗口：进程内实现没有一轮真实的存储往返，那条窗口短到
   * 没法靠调度稳定命中；数据库实现则是多条语句、跨 await 的真实往返，窗口就在那儿。因此
   * 只有它跑那条把窗口撑开的用例，其余用例两条腿共用。
   */
  databaseDrift: boolean;
}

const MEMORY_CASES: MemoryCase[] = [
  {
    name: 'InMemoryRepository',
    create: () => Promise.resolve(new InMemoryRepository()),
    databaseDrift: false,
  },
  {
    name: 'PgMemoryRepository（PGlite）',
    create: async () => {
      const pool = await pgMemoryPool();
      await ensurePgMemorySchema(pool, new HashEmbeddingProvider().dimensions);
      pgMemoryTouched = true;
      return new PgMemoryRepository({ pool });
    },
    databaseDrift: true,
  },
];

/**
 * 聚合根与经验集合同源：`avg_confidence` 必须等于当前经验集的真实均值。
 *
 * 这条不变量就是 P2 的全部要求——并发回写下它最容易破，破了之后库里看不出任何异常
 * （每条经验都对、只有那个均值停在旧快照上），因此每个并发用例都拿它当最后一道断言。
 */
async function expectAggregateMatchesExperiences(repository: MemoryRepository): Promise<void> {
  const experiences = await repository.listExperiences(ROLE);
  const trueAverage =
    experiences.length === 0
      ? 0
      : Math.round(
          (experiences.reduce((sum, item) => sum + item.confidence, 0) / experiences.length) * 1_000,
        ) / 1_000;
  const metrics = await repository.getMetrics(ROLE);
  expect(metrics.avg_confidence).toBe(trueAverage);
  expect(metrics.experience_count).toBe(experiences.length);
}

/**
 * 一个能**安排交错**的最小 SqlPool：把「另一个消费者恰好在这一刻推进了聚合」这件事变得确定。
 *
 * 为什么需要它：`avg_confidence` 漂移是一场并发写竞争——两条反馈读同一份经验集合，各自算出
 * 一个均值，后写的那一方覆盖先写的。嵌入式 PGlite 是单连接数据库，所有语句在一条队列上按序
 * 执行，两次往返之间的窗口按秒都撑不开，于是这场竞争在它上面稳定复现不了（外部 PostgreSQL
 * 上每方各占一条连接，窗口就是真的）。这个替身提供两条能力：
 *
 * - **快照隔离**：事务内的读看得见已提交的状态与自己的写，看不见另一个事务未提交的写——
 *   这正是多连接下「某条反馈读到的是别人提交之前的集合」的由来。
 * - **按语句挂钩子**：可以在某条语句之后让外部世界推进聚合（`bumpAverageAfterFirstExperienceWrite`），
 *   模拟并发消费者刚写完聚合并提交。
 *
 * 它只实现本条契约用到的语句；未识别的一律拒绝，免得用例在「其实什么都没测到」的情况下通过。
 */
interface StubExperience {
  role_id: string;
  payload: Record<string, unknown>;
}

interface StubPoolState {
  agents: Map<string, { metrics: Record<string, unknown>; handle: unknown }>;
  experiences: Map<string, StubExperience>;
}

interface StubSqlPool {
  pool: SqlPool;
  /** 每次事务提交计数：重试能否收敛，就看它长不长得对 */
  commits(): number;
  /** 每次事务回滚计数：条件写被拒的那一版会走这里 */
  rollbacks(): number;
  /** 在某条「UPDATE memory_experiences」之后，替另一个消费者把聚合推进一版 */
  bumpAverageAfterFirstExperienceWrite(): void;
}

function createStubSqlPool(role_id: string, seed: { experience: ExperienceRecord }): StubSqlPool {
  const global: StubPoolState = {
    agents: new Map([
      [
        role_id,
        {
          metrics: {
            role_id,
            total_tasks: 0,
            tasks_bid: 0,
            tasks_won: 0,
            tasks_completed: 0,
            tasks_succeeded: 0,
            tasks_partial: 0,
            tasks_failed: 0,
            skill_count: 0,
            experience_count: 1,
            imported_skill_count: 0,
            promoted_skill_count: 0,
            avg_confidence: 0.8,
            token_cost_total: 0,
            persona_version: 1,
          },
          handle: {},
        },
      ],
    ]),
    experiences: new Map([
      [
        seed.experience.id,
        { role_id, payload: seed.experience as unknown as Record<string, unknown> },
      ],
    ]),
  };

  let staggerExperienceWrites = false;
  let readMetricsFromCommitted = false;
  let commits = 0;
  let rollbacks = 0;

  /** 另一条连接上的消费者：推进聚合，并立刻提交（本事务的快照不该看见它） */
  const bumpAverageExternally = (): void => {
    const agent = global.agents.get(role_id);
    if (!agent) throw new Error('stub: agent row is missing');
    agent.metrics = { ...agent.metrics, avg_confidence: 0.75 };
    commits += 1; // 外部提交，不是本事务的提交
  };

  const snapshot = (): StubPoolState => ({
    agents: new Map(
      [...global.agents].map(([key, value]) => [
        key,
        // 深一层拷贝 metrics：否则「另一个消费者推进聚合」会顺着共享引用改到本事务自己的
        // 视图里，快照隔离就不成立了（那样测的是替身的漏洞，不是仓储的行为）
        { ...value, metrics: JSON.parse(JSON.stringify(value.metrics)) as Record<string, unknown> },
      ]),
    ),
    experiences: new Map(
      [...global.experiences].map(([key, value]) => [key, { ...value, payload: { ...value.payload } }]),
    ),
  });

  const dispatch = <T>(
    db: StubPoolState,
    text: string,
    params: unknown[] | undefined,
  ): SqlQueryResult<T> => {
    const rows = <R>(values: R[]): SqlQueryResult<T> => ({
      rows: values as unknown as T[],
      rowCount: values.length,
    });

    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
      if (text === 'COMMIT') commits += 1;
      if (text === 'ROLLBACK') rollbacks += 1;
      return { rows: [], rowCount: null };
    }

    if (text.includes('SELECT handle, persona, metrics FROM memory_agents')) {
      const agent = db.agents.get(params?.[0] as string);
      return rows(agent ? [{ handle: agent.handle, persona: {}, metrics: agent.metrics }] : []);
    }

    if (text.includes('SELECT metrics FROM memory_agents')) {
      // 条件写读聚合时走的是一次**新的快照**（真实数据库里 READ COMMITTED 的语句级快照）：
      // 另一个连接刚提交的聚合推进必须被看见，否则「聚合已经变了」这件事根本无从判断。
      const source = readMetricsFromCommitted ? global : db;
      const agent = source.agents.get(params?.[0] as string);
      return rows(agent ? [{ metrics: agent.metrics }] : []);
    }

    if (text.includes('SELECT payload FROM memory_experiences')) {
      const experience = text.includes('AND id = $2')
        ? db.experiences.get(params?.[1] as string)
        : [...db.experiences.values()].find((item) => item.role_id === params?.[0]);
      return rows(experience ? [{ payload: experience.payload }] : []);
    }

    if (text.includes('ORDER BY payload')) {
      return rows(
        [...db.experiences.values()]
          .filter((item) => item.role_id === params?.[0])
          .map((item) => ({ payload: item.payload })),
      );
    }

    if (text.includes('UPDATE memory_experiences')) {
      const experience = db.experiences.get(params?.[1] as string);
      if (!experience) return rows([]);
      if (text.includes('NOT (payload ->')) {
        const history = experience.payload.confidence_history as { feedback_id?: string }[];
        const feedbackId = (params?.[6] as { feedback_id?: string }[])?.[0]?.feedback_id;
        if (feedbackId !== undefined && history.some((entry) => entry.feedback_id === feedbackId)) {
          return rows([]);
        }
      }
      experience.payload = JSON.parse(params?.[2] as string) as Record<string, unknown>;
      const written = { payload: experience.payload };
      // 钩子：这一次写之后，另一个消费者推进了聚合并提交（本事务看不到）
      if (staggerExperienceWrites) {
        staggerExperienceWrites = false;
        bumpAverageExternally();
      }
      return rows([written]);
    }

    if (text.includes('UPDATE memory_agents')) {
      const agent = db.agents.get(params?.[0] as string);
      if (!agent) return rows([]);
      if (text.includes("metrics->>'avg_confidence'")) {
        // 条件写：聚合被别的消费者推进过就一行也写不进去
        if (String(agent.metrics.avg_confidence) !== String(params?.[1])) return rows([]);
        agent.metrics = { ...agent.metrics, avg_confidence: params?.[2] as number };
      } else {
        agent.metrics = JSON.parse(params?.[1] as string) as Record<string, unknown>;
      }
      return rows([{ role_id: params?.[0] }]);
    }

    throw new Error(`stub SqlPool does not implement: ${text}`);
  };

  const query = async <T>(text: string, params?: unknown[]): Promise<SqlQueryResult<T>> =>
    dispatch<T>(snapshot(), text, params);

  const pool: SqlPool = {
    query,
    connect: async () => {
      const transaction = snapshot();
      return {
        query: <T>(text: string, params?: unknown[]) => {
          const result = dispatch<T>(transaction, text, params);
          if (text === 'COMMIT') {
            global.agents = transaction.agents;
            global.experiences = transaction.experiences;
          }
          return Promise.resolve(result);
        },
        release: () => undefined,
      };
    },
    end: () => Promise.resolve(),
  };

  return {
    pool,
    commits: () => commits,
    rollbacks: () => rollbacks,
    bumpAverageAfterFirstExperienceWrite: () => {
      staggerExperienceWrites = true;
      // 聚合的条件读走已提交状态；本事务的写仍然只在自己那份快照里，提交时才落地
      readMetricsFromCommitted = true;
    },
  };
}

describe.each(MEMORY_CASES)(
  'applyExperienceFeedback 契约 — $name',
  ({ create, databaseDrift }) => {
  /** 一条作用在某条经验上的反馈应用（id 由用例给，便于断言幂等与溯源） */
  function applicationFor(
    experienceId: string,
    feedbackId: string,
    effectiveness: 'fully_effective' | 'partially_effective' | 'ineffective',
  ) {
    return {
      feedback_id: feedbackId,
      experience_id: experienceId,
      applied: true,
      effectiveness,
      note: feedbackId,
      observed_at: '2026-10-10T01:00:00.000Z',
      feedback_source: 'driver_usage' as const,
    };
  }

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

  it('并发回写后 avg_confidence 等于经验集合的真实均值（不是旧快照）', async () => {
    const repository = await create();
    await repository.ensureAgent(ROLE);
    const experience = experienceFor(ROLE, randomUUID());
    await repository.saveExperienceIfAbsent(ROLE, experience);

    const [up, down] = await Promise.all([
      repository.applyExperienceFeedback(
        ROLE,
        applicationFor(experience.id, 'drvfb_avg_up', 'fully_effective'),
      ),
      repository.applyExperienceFeedback(
        ROLE,
        applicationFor(experience.id, 'drvfb_avg_down', 'ineffective'),
      ),
    ]);

    expect([up.outcome, down.outcome]).toEqual(['applied', 'applied']);
    const stored = (await repository.listExperiences(ROLE))[0]!;
    expect(stored.confidence).toBe(0.8);
    expect((await repository.getMetrics(ROLE)).avg_confidence).toBe(stored.confidence);
    await expectAggregateMatchesExperiences(repository);
    // 聚合根内嵌的快照与列同源：同一个数在两个读口上给出两个答案就是漂移
    expect((await repository.getAgent(ROLE)).metric.avg_confidence).toBe(
      (await repository.getMetrics(ROLE)).avg_confidence,
    );
    expect((await repository.getMetrics(ROLE)).experience_count).toBe(1);
  });

  it.skipIf(!databaseDrift)(
    '聚合被别人推进过时不吃旧快照：条件写被拒、重读后收敛，绝不用过期均值覆盖',
    async () => {
      const experience = experienceFor(ROLE, randomUUID());
      const stub = createStubSqlPool(ROLE, { experience });
      const repository = new PgMemoryRepository({ pool: stub.pool, autoMigrate: false });
      // 与「另一条连接上的消费者刚写完聚合并提交」等价：本事务读到经验、写下自己那一版之后，
      // 外部把 avg_confidence 推到了 0.75
      stub.bumpAverageAfterFirstExperienceWrite();

      const result = await repository.applyExperienceFeedback(
        ROLE,
        applicationFor(experience.id, 'drvfb_guard', 'fully_effective'),
      );

      expect(result.outcome).toBe('applied');
      const metrics = await repository.getMetrics(ROLE);
      // 被拒的那一版会整段重来：回滚掉自己的写，重读聚合（0.75），
      // 再用**这一版经验集合**（0.9）重算——0.9 才是与集合同源的均值
      expect(metrics.avg_confidence).toBe(0.9);
      expect(stub.rollbacks()).toBe(1);
      expect(stub.commits()).toBe(2); // 外部那次 + 本事务最终那次
      const written = await repository.listExperiences(ROLE);
      expect(written[0]?.confidence).toBe(0.9);
      expect(written[0]?.referenced_count).toBe(2);
    },
  );

  it('同一条反馈并发应用：只生效一次，聚合也只跟一次', async () => {
    const repository = await create();
    await repository.ensureAgent(ROLE);
    const experience = experienceFor(ROLE, randomUUID());
    await repository.saveExperienceIfAbsent(ROLE, experience);

    const [first, second] = await Promise.all([
      repository.applyExperienceFeedback(
        ROLE,
        applicationFor(experience.id, 'drvfb_race_one', 'fully_effective'),
      ),
      repository.applyExperienceFeedback(
        ROLE,
        applicationFor(experience.id, 'drvfb_race_one', 'fully_effective'),
      ),
    ]);

    expect([first.outcome, second.outcome].sort()).toEqual(['already_applied', 'applied']);
    const stored = (await repository.listExperiences(ROLE))[0]!;
    expect(stored.confidence).toBe(0.9);
    expect(stored.referenced_count).toBe(2);
    expect((await repository.getMetrics(ROLE)).avg_confidence).toBe(0.9);
  });

  it('并发回写到不同经验：两条都落地，均值仍等于整个集合的真实均值', async () => {
    const repository = await create();
    await repository.ensureAgent(ROLE);
    const raised = experienceFor(ROLE, randomUUID());
    const low = experienceFor(ROLE, randomUUID(), { confidence: 0.9 });
    await repository.saveExperienceIfAbsent(ROLE, raised);
    await repository.saveExperienceIfAbsent(ROLE, low);

    // 两条反馈各改一条经验：谁先写、谁后写都不该让均值停在只反映其中一条的旧值上
    const [up, down] = await Promise.all([
      repository.applyExperienceFeedback(ROLE, applicationFor(raised.id, 'drvfb_pair_up', 'fully_effective')),
      repository.applyExperienceFeedback(ROLE, applicationFor(low.id, 'drvfb_pair_down', 'ineffective')),
    ]);

    expect([up.outcome, down.outcome]).toEqual(['applied', 'applied']);
    const metrics = await repository.getMetrics(ROLE);
    // 0.8→0.9 与 0.9→0.8：集合变成 0.9 / 0.8，均值 0.85
    expect(metrics.avg_confidence).toBe(0.85);
    await expectAggregateMatchesExperiences(repository);
    expect(metrics.experience_count).toBe(2);
    // 既有聚合字段没有被这次回写破坏
    expect(metrics.skill_count).toBe(0);
    expect((await repository.getAgent(ROLE)).experience_count).toBe(2);
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
