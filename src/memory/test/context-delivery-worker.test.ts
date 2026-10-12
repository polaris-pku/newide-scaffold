/**
 * Context Delivery Worker（Phase 1）测试
 *
 * 覆盖的是「上下文交付 → Experience」这条消费链在真实存储上的行为：批量、run 记录、
 * fence 凭据、lease 续租与恢复、错误分类、崩溃窗口与幂等。断言一律落在**持久化之后的
 * 状态与副作用**上（交付项的状态、Buffer 在哪个分区、仓库里到底有几条 Experience），
 * 而不是「某个函数被调用过」——后者在存储语义出错时照样通过。
 *
 * 交付存储按 DELIVERY_ADAPTERS 跑两遍（文件 / 内存）：测试替身
 * 掩盖生产差异是交付契约最贵的一类事故。记忆仓库与 Buffer 用 InMemoryRepository /
 * FileBufferRepository（Buffer 在生产里就只有文件实现），另有一例专门验证 InMemory
 * Buffer 与文件实现语义一致。
 *
 * 时间全部由注入的 clock 提供，租约心跳的定时器也是注入的（手动触发）。因此「退避到点
 * 了没有」「续租失败之后还能不能写」这类断言不依赖真实时钟，也不会偶发。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';


import { FileMemoryDeliveryRepository } from '../adapters/file-memory-delivery';
import { FileMaintenanceRunStore } from '../adapters/file-maintenance-run-store';
import { FileBufferRepository } from '../adapters/file-buffer-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { buildContextDeliveryItem } from '../services/context-delivery';
import { stableExperienceId } from '../services/memory-cycle';
import type { LeaseTimers } from '../services/lease-heartbeat';
import {
  DefaultContextDeliveryProcessor,
  type ContextDeliveryProcessOutcome,
} from '../runtime/context-delivery-processor';
import {
  ContextDeliveryWorker,
  type ContextDeliveryRunResult,
} from '../runtime/context-delivery-worker';
import type { BufferRepository } from '../ports/buffer-repository';
import type { MemoryDeliveryRepository } from '../ports/memory-delivery';
import type { MaintenanceRunStore } from '../ports/maintenance-run-store';
import type { ExperienceExtractor } from '../ports/experience-extractor';
import type {
  AgentContextSnapshot,
  BufferSnapshot,
  ContextDeliveryItem,
  DeliveryStatus,
} from '../schemas';
import type { CandidateExperience, ExtractionOutput } from '../types';
import {
  DELIVERY_ADAPTERS,
  RUN_STORE_ADAPTERS,
} from './maintenance-adapters';

const ROLE = 'role_context_worker';
const OTHER_ROLE = 'role_context_worker_other';
const START = '2026-10-10T00:00:00.000Z';
/** 真实量级的退避：base 1s、上限 60s、最多 3 次投递 */
const RETRY_POLICY = { max_attempts: 3, base_delay_ms: 1_000, max_delay_ms: 60_000 };

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'newide-context-worker-'));
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
//  提取器替身与样例数据
// ════════════════════════════════════════════════════════

type ExtractHandler = (
  snapshot: BufferSnapshot,
  agentContext: AgentContextSnapshot | undefined,
) => Promise<ExtractionOutput>;

interface ScriptedExtractor extends ExperienceExtractor {
  calls: Array<{ snapshot: BufferSnapshot; agentContext: AgentContextSnapshot | undefined }>;
  /** 换掉这一次的产出（异常也从这里抛） */
  set(handler: ExtractHandler): void;
}

function scriptedExtractor(handler?: ExtractHandler): ScriptedExtractor {
  const calls: ScriptedExtractor['calls'] = [];
  let current: ExtractHandler = handler ?? (() => Promise.resolve(extractionOf(1)));
  return {
    calls,
    set(nextHandler) {
      current = nextHandler;
    },
    async extract(snapshot, agentContext) {
      calls.push({ snapshot, agentContext });
      return current(snapshot, agentContext);
    },
  };
}

function extractionOf(count: number): ExtractionOutput {
  return {
    experiences: Array.from({ length: count }, (_, index) => candidateExperience(index)),
    result: {
      experiences_created: count,
      experiences_updated: 0,
      negative_experiences: 0,
      skills_promoted: 0,
    },
  };
}

function candidateExperience(index: number): CandidateExperience {
  return {
    id: randomUUID(),
    description: `experience ${String(index)}`,
    description_embedding: [0.1, 0.2, 0.3],
    content: `content ${String(index)}`,
    confidence: 0.6,
    tags: ['context-delivery'],
    confidence_history: [],
    referenced_count: 0,
    source_task_id: 'task_context_worker',
    source_driver: 'acp-external',
    type: 'positive',
    created_at: START,
    updated_at: START,
  };
}

function sampleAgentContext(roleId: string): AgentContextSnapshot {
  return {
    snapshot_id: randomUUID(),
    source_task_id: 'task_context_worker',
    agent_id: roleId,
    thinking_trace: 'Reasoning trace',
    planning_trace: 'Planning trace',
    driver_calls: [
      { call_id: 'call_001', driver_id: 'acp-external', driver_return_ref: 'report_1.json' },
    ],
    cleaned_at: START,
    original_token_count: 1_000,
    cleaned_token_count: 400,
    compression_ratio: 0.4,
  };
}

// ════════════════════════════════════════════════════════
//  夹具
// ════════════════════════════════════════════════════════

interface Harness {
  root: string;
  repository: InMemoryRepository;
  buffer: BufferRepository;
  delivery: MemoryDeliveryRepository;
  runStore: MaintenanceRunStore;
  extractor: ScriptedExtractor;
  clock: TestClock;
  timers: ManualTimers;
  worker: ContextDeliveryWorker;
  processor: DefaultContextDeliveryProcessor;
  /** 登记一条 Buffer + 一条交付项 */
  deliver(options?: DeliverOptions): Promise<RegisteredDelivery>;
  /** 只登记交付项 / 登记到别的 role 等形态 */
  submit(item: ContextDeliveryItem): Promise<void>;
}

interface DeliverOptions {
  taskId?: string;
  role?: string;
  /** 成对写入一份 AgentContextSnapshot */
  withContext?: boolean;
  /** 显式声明 context_snapshot_ref（构造「声明了却没有上下文」的损坏形态） */
  contextRef?: string;
  /** 构造交付项时另写一个上下文引用（构造与 Buffer 不同源的交付项） */
  deliveryContextRef?: string;
  /** true 时只登记交付项，不写 Buffer（构造「引用了不存在的 Buffer」） */
  bareDelivery?: boolean;
  bufferSeq?: number;
  schemaVersion?: string;
}

interface RegisteredDelivery {
  seq: number;
  deliveryId: string;
}

interface HarnessOptions {
  root?: string;
  delivery?: MemoryDeliveryRepository;
  buffer?: BufferRepository;
  runStore?: MaintenanceRunStore;
  repository?: InMemoryRepository;
  lease_ms?: number;
  clock?: TestClock;
  timers?: ManualTimers;
  extractor?: ScriptedExtractor;
  worker_id?: string;
  /** false 时跳过 Agent 初始化（复用一个已经初始化过的仓库时用） */
  initialize?: boolean;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const root = options.root ?? (await tempRoot());
  const clock = options.clock ?? testClock();
  const timers = options.timers ?? manualTimers();
  const repository = options.repository ?? new InMemoryRepository();
  const buffer =
    options.buffer ??
    new FileBufferRepository({ agentStateRoot: join(root, 'agent-state') });
  const delivery =
    options.delivery ??
    new FileMemoryDeliveryRepository({
      agentStateRoot: join(root, 'agent-state'),
      retryPolicy: RETRY_POLICY,
      ...(options.lease_ms !== undefined ? { lease_ms: options.lease_ms } : {}),
    });
  const runStore = options.runStore ?? new FileMaintenanceRunStore({ root: join(root, 'runs') });
  const extractor = options.extractor ?? scriptedExtractor();

  // 共享同一份 Agent 存储的用例（并发）会重复走到这里，那时不再重新初始化
  if (options.initialize !== false) {
    for (const role of [ROLE, OTHER_ROLE]) {
      await repository.initializeAgent({ role_id: role, name: role });
      await buffer.ensureAgent(role);
      await delivery.ensureAgent(role);
    }
  }

  const processor = new DefaultContextDeliveryProcessor({
    deliveryRepository: delivery,
    bufferRepository: buffer,
    scopeFactory: (roleId) => createAgentMemoryScope(repository, buffer, roleId),
    extractor,
    processor_version: 'context-worker-1.0',
    now: clock.now,
    timers,
    ...(options.lease_ms !== undefined ? { lease_ms: options.lease_ms } : {}),
  });
  const worker = new ContextDeliveryWorker({
    deliveryRepository: delivery,
    runStore,
    processor,
    worker_id: options.worker_id ?? 'ctx-worker-a',
    now: clock.now,
    ...(options.lease_ms !== undefined ? { lease_ms: options.lease_ms } : {}),
  });

  const harnessRef: Harness = {
    root,
    repository,
    buffer,
    delivery,
    runStore,
    extractor,
    clock,
    timers,
    worker,
    processor,
    async deliver(deliverOptions = {}) {
      const role = deliverOptions.role ?? ROLE;
      const taskId = deliverOptions.taskId ?? 'task_context_worker';
      const agentContext = deliverOptions.withContext ? sampleAgentContext(role) : undefined;
      let seq = deliverOptions.bufferSeq ?? 0;
      let ref = deliverOptions.contextRef;
      if (!deliverOptions.bareDelivery) {
        const memory = createAgentMemoryScope(repository, buffer, role);
        const snapshot: BufferSnapshot = {
          task_id: taskId,
          task_description: 'Consume context downstream.',
          driver_return: {
            summary: 'Completed.',
            artifacts: [],
            decisions: [],
            blockers: [],
            referenced_experiences: [],
            assumptions: [],
          },
          source_task_id: taskId,
          source_driver: 'acp-external',
          // 成对写入时 ref 由仓储按分配到的 seq 写死；只有构造「声明了引用却没有上下文」
          // 这种损坏形态时才显式带上一个对不上的值。
          ...(deliverOptions.contextRef !== undefined
            ? { context_snapshot_ref: deliverOptions.contextRef }
            : {}),
          received_at: START,
          retry_count: 0,
          extraction_status: 'pending',
        };
        const saved = await memory.saveBufferSnapshot(snapshot, agentContext);
        seq = saved.seq;
        ref = saved.snapshot.context_snapshot_ref;
      }
      const itemRef = deliverOptions.deliveryContextRef ?? ref;
      const item = buildContextDeliveryItem({
        role_id: role,
        task_id: taskId,
        buffer_seq: seq,
        source_driver: 'acp-external',
        ...(deliverOptions.schemaVersion !== undefined
          ? { schema_version: deliverOptions.schemaVersion }
          : {}),
        ...(itemRef !== undefined ? { context_snapshot_ref: itemRef } : {}),
      });
      await delivery.submitContextDelivery(item);
      return { seq, deliveryId: item.delivery_id };
    },
    async submit(item) {
      await delivery.submitContextDelivery(item);
    },
  };
  return harnessRef;
}

/** 读一条交付项的当前状态（不存在即失败） */
async function deliveryStatus(
  h: Harness,
  role: string,
  deliveryId: string,
): Promise<ContextDeliveryItem> {
  const item = await h.delivery.getContextDelivery(role, deliveryId);
  if (!item) throw new Error(`delivery ${deliveryId} not found`);
  return item;
}

async function statusOf(h: Harness, deliveryId: string): Promise<DeliveryStatus> {
  return (await deliveryStatus(h, ROLE, deliveryId)).status;
}

/** 仓库里这个 role 的经验 id 集合（幂等断言都看它） */
async function experienceIds(h: Harness, role = ROLE): Promise<string[]> {
  return (await h.repository.listExperiences(role)).map((experience) => experience.id).sort();
}

function outcomesWith(
  result: ContextDeliveryRunResult,
  status: ContextDeliveryProcessOutcome['status'],
): ContextDeliveryProcessOutcome[] {
  return result.outcomes.filter((outcome) => outcome.status === status);
}

// ════════════════════════════════════════════════════════
//  交付存储三后端共同的核心语义
// ════════════════════════════════════════════════════════

describe.each(DELIVERY_ADAPTERS)('$name — Context Delivery Worker', ({ create, reopen }) => {
  it('正常处理：Experience 幂等落库、Buffer 归档、delivery 完成、run 计数正确', async () => {
    const root = await tempRoot();
    const h = await harness({ root, delivery: await create(root) });
    const first = await h.deliver({ withContext: true });
    const second = await h.deliver({ taskId: 'task_two', withContext: true });

    const result = await h.worker.runOnce();

    expect(result.stop_reason).toBe('no_work');
    expect(result.counts).toMatchObject({
      claimed_count: 2,
      completed_count: 2,
      retried_count: 0,
      dead_letter_count: 0,
      skipped_count: 0,
      failure_count: 0,
    });
    expect(outcomesWith(result, 'completed')).toHaveLength(2);

    // 交付被确认完成
    expect(await statusOf(h, first.deliveryId)).toBe('processed');
    expect(await statusOf(h, second.deliveryId)).toBe('processed');

    // Buffer 归档离开 pending
    expect(await h.buffer.listPendingBufferSeqs(ROLE)).toEqual([]);
    expect((await h.buffer.getStoredBuffer(ROLE, first.seq))?.location).toBe('processed');

    // Experience 落库：稳定 id 由 (role, seq, 序号) 决定，且归属是 role_id
    const stored = await h.repository.listExperiences(ROLE);
    expect(stored.map((experience) => experience.id).sort()).toEqual(
      [stableExperienceId(ROLE, first.seq, 0), stableExperienceId(ROLE, second.seq, 0)].sort(),
    );
    expect(stored.every((experience) => experience.agent_id === ROLE)).toBe(true);

    // run 落盘：job type / worker / 起止时间都在
    const run = await h.runStore.get(result.run.run_id);
    expect(run).toMatchObject({
      job_type: 'context_delivery',
      status: 'completed',
      worker_id: 'ctx-worker-a',
      claimed_count: 2,
      completed_count: 2,
    });
    expect(run?.started_at).toBe(START);
    expect(run?.finished_at).toBeDefined();

    // 空跑一次：没有活不报错，计数全零
    const idle = await h.worker.runOnce();
    expect(idle.stop_reason).toBe('no_work');
    expect(idle.counts.claimed_count).toBe(0);
    expect(await experienceIds(h)).toEqual(stored.map((experience) => experience.id).sort());
  });

  it('同一条输入重复消费：Experience 不增，旧凭据写不进终态', async () => {
    const root = await tempRoot();
    const h = await harness({ root, delivery: await create(root) });
    await h.deliver({ withContext: true });

    const claimed = await h.delivery.claimNextDelivery({
      channel: 'context',
      owner: 'ctx-worker-a',
      now: h.clock.now(),
    });
    if (claimed?.channel !== 'context') throw new Error('claim failed');
    const item = claimed.item;

    const first = await h.processor.process(item, { worker_id: 'ctx-worker-a' });
    expect(first.status).toBe('completed');
    const afterFirst = await experienceIds(h);
    expect(afterFirst).toHaveLength(1);

    // 拿同一份（此时已经过期的）claim 重放一遍：提取会重跑，但落库命中稳定 id，不产生第二份
    const replay = await h.processor.process(item, { worker_id: 'ctx-worker-a' });
    expect(replay.experiences_created).toBe(0);
    expect(replay.experiences_already_present).toBe(1);
    expect(replay.status).toBe('failed');
    expect(await experienceIds(h)).toEqual(afterFirst);
    expect(await statusOf(h, item.delivery_id)).toBe('processed');
  });

  it('引用了不存在的 Buffer：按坏输入进 dead_letter，不写任何 Experience', async () => {
    const root = await tempRoot();
    const h = await harness({ root, delivery: await create(root) });
    const registered = await h.deliver({ bareDelivery: true, bufferSeq: 7 });

    const result = await h.worker.runOnce();

    expect(result.counts).toMatchObject({ claimed_count: 1, dead_letter_count: 1, retried_count: 0 });
    const [outcome] = result.outcomes;
    expect(outcome?.status).toBe('dead_letter');
    expect(outcome?.failure).toMatchObject({ code: 'payload_unreadable', retryable: false });
    expect(await statusOf(h, registered.deliveryId)).toBe('dead_letter');
    expect(await experienceIds(h)).toEqual([]);

    // 死信里保留了原因，运维能看出是哪一步坏的
    const dead = await deliveryStatus(h, ROLE, registered.deliveryId);
    expect(dead.last_error).toContain('in no partition');
    expect(dead.attempt_count).toBe(1);
  });

  it('上下文声明了引用却读不出来：拒绝提取并进 dead_letter', async () => {
    const root = await tempRoot();
    const h = await harness({ root, delivery: await create(root) });
    // 显式声明 context_snapshot_ref，但成对写入时不给 agentContext → 文件实现报 unreadable
    const registered = await h.deliver({ contextRef: '1' });

    const result = await h.worker.runOnce();

    expect(result.counts.dead_letter_count).toBe(1);
    expect(result.outcomes[0]?.failure?.code).toBe('payload_unreadable');
    expect(await statusOf(h, registered.deliveryId)).toBe('dead_letter');
    expect(h.extractor.calls).toHaveLength(0);
    expect(await experienceIds(h)).toEqual([]);
  });

  it('契约版本不认识：不猜着解析，直接进 dead_letter', async () => {
    const root = await tempRoot();
    const h = await harness({ root, delivery: await create(root) });
    const registered = await h.deliver({ schemaVersion: 'context-delivery.v2' });

    const result = await h.worker.runOnce();

    expect(result.counts.dead_letter_count).toBe(1);
    expect(result.outcomes[0]?.failure?.message).toContain('context-delivery.v2');
    expect(await statusOf(h, registered.deliveryId)).toBe('dead_letter');
    expect(h.extractor.calls).toHaveLength(0);
  });

  it('模型超时/暂时不可用：按退避重试，用满次数后进 dead_letter', async () => {
    const root = await tempRoot();
    const h = await harness({ root, delivery: await create(root) });
    const registered = await h.deliver({ withContext: true });
    h.extractor.set(() => Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' })));

    const first = await h.worker.runOnce();
    expect(first.counts).toMatchObject({ claimed_count: 1, retried_count: 1, dead_letter_count: 0 });
    expect(first.outcomes[0]?.failure).toMatchObject({
      code: 'downstream_unavailable',
      retryable: true,
    });
    const afterFirst = await deliveryStatus(h, ROLE, registered.deliveryId);
    expect(afterFirst.status).toBe('pending');
    expect(afterFirst.attempt_count).toBe(1);
    // 指数退避：第 1 次失败后等 base_delay_ms
    expect(afterFirst.next_retry_at).toBe(
      new Date(Date.parse(START) + RETRY_POLICY.base_delay_ms).toISOString(),
    );

    // 退避窗口没到：claim 不到，这就是「这次没活」
    const tooEarly = await h.worker.runOnce();
    expect(tooEarly.stop_reason).toBe('no_work');
    expect(tooEarly.counts.claimed_count).toBe(0);

    h.clock.advance(RETRY_POLICY.base_delay_ms);
    const second = await h.worker.runOnce();
    expect(second.counts.retried_count).toBe(1);
    expect((await deliveryStatus(h, ROLE, registered.deliveryId)).attempt_count).toBe(2);

    h.clock.advance(RETRY_POLICY.base_delay_ms * 2);
    const third = await h.worker.runOnce();
    expect(third.counts).toMatchObject({ dead_letter_count: 1, retried_count: 0 });
    const dead = await deliveryStatus(h, ROLE, registered.deliveryId);
    expect(dead.status).toBe('dead_letter');
    expect(dead.attempt_count).toBe(RETRY_POLICY.max_attempts);
    expect(dead.last_error).toContain('downstream_unavailable');
    expect(await experienceIds(h)).toEqual([]);
  });

  it('不可恢复的提取失败：不进退避，直接死信', async () => {
    const root = await tempRoot();
    const h = await harness({ root, delivery: await create(root) });
    const registered = await h.deliver({ withContext: true });
    h.extractor.set(() => Promise.reject(new ZodError([])));

    const result = await h.worker.runOnce();

    expect(result.counts).toMatchObject({ dead_letter_count: 1, retried_count: 0 });
    expect(result.outcomes[0]?.failure).toMatchObject({ code: 'payload_unreadable', retryable: false });
    const dead = await deliveryStatus(h, ROLE, registered.deliveryId);
    expect(dead.status).toBe('dead_letter');
    expect(dead.next_retry_at).toBeUndefined();
  });

  it('同批一条坏掉不阻塞其他记录', async () => {
    const root = await tempRoot();
    const h = await harness({ root, delivery: await create(root) });
    // 三条一起排队，中间那条的提取器抛不可恢复错误
    const first = await h.deliver({ taskId: 'task_ok_1', withContext: true });
    const broken = await h.deliver({ taskId: 'task_broken', withContext: true });
    const third = await h.deliver({ taskId: 'task_ok_2', withContext: true });
    h.extractor.set((snapshot) =>
      snapshot.task_id === 'task_broken'
        ? Promise.reject(new ZodError([]))
        : Promise.resolve(extractionOf(1)),
    );

    const result = await h.worker.runOnce();

    expect(result.counts).toMatchObject({
      claimed_count: 3,
      completed_count: 2,
      dead_letter_count: 1,
      failure_count: 0,
    });
    expect(await statusOf(h, first.deliveryId)).toBe('processed');
    expect(await statusOf(h, broken.deliveryId)).toBe('dead_letter');
    expect(await statusOf(h, third.deliveryId)).toBe('processed');
    // 成功的那两条各自留下一条经验（坏的那条什么都没留）
    expect(await experienceIds(h)).toHaveLength(2);
  });

  it('重启恢复：上一个 worker 留下的 processing（租约已过期）能被放回队列并处理完', async () => {
    const root = await tempRoot();
    const dead = await create(root);
    const first = await harness({ root, delivery: dead, worker_id: 'ctx-worker-dead' });
    const registered = await first.deliver({ withContext: true });

    // 上一个进程 claim 走之后就没了（不处理、不续租）
    const stale = await dead.claimNextDelivery({
      channel: 'context',
      owner: 'ctx-worker-dead',
      now: first.clock.now(),
      lease_ms: 1_000,
    });
    expect(stale?.channel).toBe('context');
    expect(await statusOf(first, registered.deliveryId)).toBe('processing');

    // 租约没过期时不能被抢
    const beforeExpiry = await first.worker.restoreExpired();
    expect(beforeExpiry.count).toBe(0);

    first.clock.advance(2_000);
    const revived = await harness({
      root,
      delivery: await reopen(root, dead),
      clock: first.clock,
      timers: first.timers,
      worker_id: 'ctx-worker-b',
    });
    const result = await revived.worker.runOnce();

    expect(result.restored_count).toBe(1);
    expect(result.counts).toMatchObject({ claimed_count: 1, completed_count: 1 });
    expect(await statusOf(revived, registered.deliveryId)).toBe('processed');
    expect(await experienceIds(revived)).toEqual([stableExperienceId(ROLE, registered.seq, 0)]);
    expect(await revived.buffer.listPendingBufferSeqs(ROLE)).toEqual([]);
  });

  it('两个 worker 同时消费：同一条交付只有一个拿到凭据', async () => {
    const root = await tempRoot();
    const shared = await create(root);
    const a = await harness({ root, delivery: shared, worker_id: 'ctx-worker-a' });
    const registered = await a.deliver({ withContext: true });
    const b = await harness({
      root,
      delivery: await reopen(root, shared),
      runStore: a.runStore,
      repository: a.repository,
      buffer: a.buffer,
      clock: a.clock,
      timers: a.timers,
      worker_id: 'ctx-worker-b',
      initialize: false,
    });

    const [runA, runB] = await Promise.all([a.worker.runOnce(), b.worker.runOnce()]);

    const completed = [...runA.outcomes, ...runB.outcomes].filter(
      (outcome) => outcome.status === 'completed',
    );
    expect(completed).toHaveLength(1);
    expect(await statusOf(a, registered.deliveryId)).toBe('processed');
    // 只产生一份经验，说明败方确实什么都没做
    expect(await experienceIds(a)).toEqual([stableExperienceId(ROLE, registered.seq, 0)]);
    expect(runA.counts.claimed_count + runB.counts.claimed_count).toBe(1);
  });
});

// ════════════════════════════════════════════════════════
//  上下文消费的故障与恢复（文件交付存储）
// ════════════════════════════════════════════════════════

describe('Context Delivery Worker — 故障与恢复', () => {
  it('Experience 落库失败：按可重试错误退回队列，Buffer 不动，重试后完成且只落一次', async () => {
    const h = await harness();
    const registered = await h.deliver({ withContext: true });
    const save = vi
      .spyOn(h.repository, 'saveExperienceIfAbsent')
      .mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'EIO' }));

    const first = await h.worker.runOnce();

    expect(first.counts.retried_count).toBe(1);
    expect(first.outcomes[0]?.failure).toMatchObject({ code: 'storage_error', retryable: true });
    expect(await statusOf(h, registered.deliveryId)).toBe('pending');
    // 落库没成功，归档就不能发生：输入必须留在待办队列里
    expect(await h.buffer.listPendingBufferSeqs(ROLE)).toEqual([registered.seq]);
    expect(await experienceIds(h)).toEqual([]);

    save.mockRestore();
    h.clock.advance(RETRY_POLICY.base_delay_ms);
    const second = await h.worker.runOnce();

    expect(second.counts.completed_count).toBe(1);
    expect(await statusOf(h, registered.deliveryId)).toBe('processed');
    expect(await experienceIds(h)).toEqual([stableExperienceId(ROLE, registered.seq, 0)]);
    expect(await h.buffer.listPendingBufferSeqs(ROLE)).toEqual([]);
  });

  it('Buffer 归档失败：不 ack，Experience 只落一次，重试后补上归档', async () => {
    const h = await harness();
    const registered = await h.deliver({ withContext: true });
    const archive = vi
      .spyOn(h.buffer, 'archiveBuffer')
      .mockResolvedValueOnce({ status: 'failed', message: 'partial: source not removed' });

    const first = await h.worker.runOnce();

    expect(first.counts.retried_count).toBe(1);
    expect(first.outcomes[0]?.failure).toMatchObject({ code: 'storage_error', retryable: true });
    // 归档没落地就不 ack：交付必须还能重投，而不是被报成完成
    expect(await statusOf(h, registered.deliveryId)).toBe('pending');
    expect(await experienceIds(h)).toEqual([stableExperienceId(ROLE, registered.seq, 0)]);

    archive.mockRestore();
    h.clock.advance(RETRY_POLICY.base_delay_ms);
    const second = await h.worker.runOnce();

    expect(second.counts.completed_count).toBe(1);
    expect(second.outcomes[0]?.experiences_created).toBe(0);
    expect(second.outcomes[0]?.experiences_already_present).toBe(1);
    expect(await statusOf(h, registered.deliveryId)).toBe('processed');
    expect((await h.buffer.getStoredBuffer(ROLE, registered.seq))?.location).toBe('processed');
    // 重试没有攒出第二份经验
    expect(await experienceIds(h)).toEqual([stableExperienceId(ROLE, registered.seq, 0)]);
  });

  it('ack 被拒（凭据失效）：不报完成，交给租约恢复后重跑，归档与经验都不重复', async () => {
    const h = await harness();
    const registered = await h.deliver({ withContext: true });
    const complete = vi
      .spyOn(h.delivery, 'completeDelivery')
      .mockResolvedValueOnce(undefined);

    const crashed = await h.worker.runOnce();

    expect(crashed.counts.failure_count).toBe(1);
    expect(crashed.outcomes[0]?.status).toBe('failed');
    // 经验与归档都已经落地（那两步是幂等的），但交付**没有**被报成完成
    expect(await experienceIds(h)).toEqual([stableExperienceId(ROLE, registered.seq, 0)]);
    expect(await statusOf(h, registered.deliveryId)).toBe('processing');

    complete.mockRestore();
    h.clock.advance(120_000);
    const recovered = await h.worker.runOnce();

    expect(recovered.restored_count).toBe(1);
    expect(recovered.counts.completed_count).toBe(1);
    expect(await statusOf(h, registered.deliveryId)).toBe('processed');
    expect(await experienceIds(h)).toEqual([stableExperienceId(ROLE, registered.seq, 0)]);
    expect(recovered.outcomes[0]?.experiences_created).toBe(0);
  });

  it('损坏的 Buffer 报告：按坏输入进 dead_letter 并留下可定位的路径', async () => {
    const h = await harness();
    const registered = await h.deliver({ withContext: true });
    const reportPath = join(
      h.root,
      'agent-state',
      ROLE,
      'buffer',
      'pending',
      `report_${String(registered.seq)}.json`,
    );
    await writeFile(reportPath, '{ not json', 'utf8');

    const result = await h.worker.runOnce();

    expect(result.counts.dead_letter_count).toBe(1);
    expect(result.outcomes[0]?.failure?.code).toBe('payload_unreadable');
    expect(result.outcomes[0]?.failure?.message).toContain(`report_${String(registered.seq)}.json`);
    expect(await experienceIds(h)).toEqual([]);
  });

  it('声明与键不符的引用（被改过 / 不同源的交付项）：不照着读，直接死信', async () => {
    const h = await harness();
    // 1) report_ref 与 role/seq 对不上
    const mismatched = buildContextDeliveryItem({
      role_id: ROLE,
      task_id: 'task_tampered',
      buffer_seq: 999,
      source_driver: 'acp-external',
    });
    await h.submit({ ...mismatched, report_ref: 'report_998.json' });
    // 2) 交付项声明的上下文引用与 Buffer 自己声明的不是同一个
    const crossing = await h.deliver({ withContext: true, deliveryContextRef: '7' });

    const result = await h.worker.runOnce();

    expect(result.counts).toMatchObject({ claimed_count: 2, dead_letter_count: 2 });
    expect(result.outcomes.map((outcome) => outcome.failure?.code)).toEqual([
      'payload_unreadable',
      'payload_unreadable',
    ]);
    expect(await statusOf(h, crossing.deliveryId)).toBe('dead_letter');
    // 坏引用一律不喂给提取器，也不产生任何经验
    expect(h.extractor.calls).toHaveLength(0);
    expect(await experienceIds(h)).toEqual([]);
  });

  it('优雅停止：不再 claim 新记录，在途的那条照常跑完', async () => {
    const h = await harness();
    const controller = new AbortController();
    await h.deliver({ taskId: 'task_1', withContext: true });
    await h.deliver({ taskId: 'task_2', withContext: true });
    await h.deliver({ taskId: 'task_3', withContext: true });
    // 处理第一条的过程中收到停止信号
    h.extractor.set(async () => {
      controller.abort();
      return extractionOf(1);
    });

    const result = await h.worker.runOnce({ signal: controller.signal });

    expect(result.stop_reason).toBe('aborted');
    expect(result.counts.claimed_count).toBe(1);
    expect(result.counts.completed_count).toBe(1);
    expect(await h.buffer.listPendingBufferSeqs(ROLE)).toHaveLength(2);

    // 已经置位的信号：一条都不领
    const again = await h.worker.runOnce({ signal: controller.signal });
    expect(again.stop_reason).toBe('aborted');
    expect(again.counts.claimed_count).toBe(0);
  });

  it('批量上限与运行时长上限：一次运行不会无限 claim', async () => {
    const h = await harness();
    for (let index = 0; index < 5; index += 1) {
      await h.deliver({ taskId: `task_${String(index)}`, withContext: true });
    }

    const limited = await h.worker.runOnce({ batchSize: 2 });
    expect(limited.stop_reason).toBe('batch_size');
    expect(limited.counts.claimed_count).toBe(2);

    // 墙钟预算为零：一条都不领
    const noTime = await h.worker.runOnce({ maxDurationMs: 0 });
    expect(noTime.stop_reason).toBe('max_duration');
    expect(noTime.counts.claimed_count).toBe(0);

    // 处理途中用光墙钟：跑完手上这条就不再 claim 下一条
    h.extractor.set(async () => {
      h.clock.advance(5_000);
      return extractionOf(1);
    });
    const expired = await h.worker.runOnce({ maxDurationMs: 1_000 });
    expect(expired.stop_reason).toBe('max_duration');
    expect(expired.counts.claimed_count).toBe(1);

    const rest = await h.worker.runOnce({ maxDurationMs: 600_000 });
    expect(rest.stop_reason).toBe('no_work');
    expect(rest.counts.claimed_count).toBe(2);
  });

  it('只消费 context 通道：反馈 outbox 在被消费前原样留着', async () => {
    const h = await harness();
    await h.deliver({ withContext: true });
    const feedback = {
      feedback_id: 'fb_1',
      feedback_key: `${ROLE}:task:exp:driver_usage:driver-usage.v1`,
      role_id: ROLE,
      task_id: 'task_context_worker',
      experience_id: 'exp_1',
      applied: true,
      effectiveness: 'fully_effective' as const,
      note: 'used it',
      observed_at: START,
      feedback_source: 'driver_usage' as const,
      event_version: 'driver-usage.v1',
      status: 'pending' as const,
      attempt_count: 0,
      created_at: START,
      updated_at: START,
    };
    await h.delivery.submitDriverFeedback(feedback);

    const result = await h.worker.runOnce();

    expect(result.counts.claimed_count).toBe(1);
    expect(result.outcomes[0]?.delivery_id).not.toBe('fb_1');
    const feedbackAfter = await h.delivery.getDriverFeedback(ROLE, 'fb_1');
    expect(feedbackAfter?.status).toBe('pending');
    expect(feedbackAfter?.attempt_count).toBe(0);
  });
});

// ════════════════════════════════════════════════════════
//  lease：续租、过期与 fencing
// ════════════════════════════════════════════════════════

describe('Context Delivery Worker — lease 续租与 fencing', () => {
  it('长任务在处理途中续租成功：记录始终归属本 worker，最终完成', async () => {
    const h = await harness({ lease_ms: 900 });
    const registered = await h.deliver({ withContext: true });
    const renew = vi.spyOn(h.delivery, 'renewDeliveryClaim');
    let release: (() => void) | undefined;
    h.extractor.set(async () => {
      // 处理期间心跳应当至少跳一次；模拟一次续租之后再放行
      h.clock.advance(400);
      h.timers.fire();
      await waitFor(() => renew.mock.calls.length >= 1, 'the lease renewal');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return extractionOf(1);
    });

    const pending = h.worker.runOnce();
    await waitFor(() => release !== undefined, 'the extraction to start');
    // 续租之后租约被推到更晚：另一个 worker 想抢也抢不走
    expect(await h.delivery.restoreExpiredDeliveryClaims({ channel: 'context', now: h.clock.now() }))
      .toEqual([]);
    release?.();
    const result = await pending;

    expect(renew).toHaveBeenCalled();
    expect(result.counts.completed_count).toBe(1);
    expect(await statusOf(h, registered.deliveryId)).toBe('processed');
  });

  it('续租失败（记录已被别人接手）：旧 worker 不写任何终态', async () => {
    const h = await harness({ lease_ms: 900 });
    const registered = await h.deliver({ withContext: true });
    const original = h.delivery.renewDeliveryClaim.bind(h.delivery);
    let settledRenewals = 0;
    const renew = vi
      .spyOn(h.delivery, 'renewDeliveryClaim')
      .mockImplementation(async (input) => {
        const outcome = await original(input);
        settledRenewals += 1;
        return outcome;
      });
    let release: (() => void) | undefined;
    h.extractor.set(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return extractionOf(1);
    });

    const inFlight = h.worker.runOnce();
    await waitFor(() => release !== undefined, 'the extraction to start');
    // 另一个 worker 接管：先按过期回收，再重新 claim（拿到的是新凭据）
    h.clock.advance(2_000);
    await h.delivery.restoreExpiredDeliveryClaims({ channel: 'context', now: h.clock.now() });
    const takenOver = await h.delivery.claimDelivery({
      channel: 'context',
      role_id: ROLE,
      id: registered.deliveryId,
      owner: 'ctx-worker-b',
      now: h.clock.now(),
    });
    expect(takenOver?.channel).toBe('context');

    // 旧 worker 的心跳这时候才跳：凭据已经作废，续租必然被拒（等到它落地再看结果）
    h.timers.fire();
    await waitFor(() => settledRenewals >= 1, 'the lease renewal to settle');
    release?.();
    const result = await inFlight;

    expect(renew).toHaveBeenCalled();
    expect(result.outcomes[0]?.status).toBe('skipped');
    expect(result.counts.skipped_count).toBe(1);
    expect(result.counts.completed_count).toBe(0);
    // 它连落库与归档都没做：那两步是对一条已经不属于自己的记录的动作
    expect(await experienceIds(h)).toEqual([]);
    expect(await h.buffer.listPendingBufferSeqs(ROLE)).toEqual([registered.seq]);
    const held = await deliveryStatus(h, ROLE, registered.deliveryId);
    expect(held.status).toBe('processing');
    expect(held.claim_owner).toBe('ctx-worker-b');
    expect(held.claim_token).toBe(
      takenOver?.channel === 'context' ? takenOver.item.claim_token : undefined,
    );

    // 新持有者凭自己的凭据可以正常写完
    h.extractor.set(() => Promise.resolve(extractionOf(1)));
    const finished = await h.processor.process(held, { worker_id: 'ctx-worker-b' });
    expect(finished.status).toBe('completed');
    expect(await statusOf(h, registered.deliveryId)).toBe('processed');
    expect(await experienceIds(h)).toEqual([stableExperienceId(ROLE, registered.seq, 0)]);
  });

  it('claim 之后租约过期：旧凭据既不能续租也不能写终态', async () => {
    const h = await harness({ lease_ms: 1_000 });
    await h.deliver({ withContext: true });
    const claimed = await h.delivery.claimNextDelivery({
      channel: 'context',
      owner: 'ctx-worker-a',
      now: h.clock.now(),
      lease_ms: 1_000,
    });
    if (claimed?.channel !== 'context') throw new Error('claim failed');
    const token = claimed.item.claim_token;
    if (!token) throw new Error('claim did not issue a token');

    h.clock.advance(5_000);
    const locator = { channel: 'context' as const, role_id: ROLE, id: claimed.item.delivery_id };
    expect(await h.delivery.renewDeliveryClaim({ ...locator, claim_token: token, now: h.clock.now() }))
      .toBeUndefined();
    expect(await h.delivery.completeDelivery({ ...locator, claim_token: token, now: h.clock.now() }))
      .toBeUndefined();
    expect(
      await h.delivery.failDelivery({
        ...locator,
        claim_token: token,
        error: 'late',
        retryable: true,
        now: h.clock.now(),
      }),
    ).toBeUndefined();
    expect(await statusOf(h, claimed.item.delivery_id)).toBe('processing');
  });

  it('worker 在 claim 之后崩溃：进程重启后记录被回收并重新处理', async () => {
    const h = await harness({ lease_ms: 1_000 });
    const registered = await h.deliver({ withContext: true });
    const claimed = await h.delivery.claimNextDelivery({
      channel: 'context',
      owner: 'ctx-worker-crashed',
      now: h.clock.now(),
      lease_ms: 1_000,
    });
    expect(claimed).toBeDefined();

    // 重启：同一份存储上的新 worker，先恢复再消费
    const restarted = await harness({ root: h.root, delivery: h.delivery, clock: h.clock, timers: h.timers });
    h.clock.advance(2_000);
    const result = await restarted.worker.runOnce();

    expect(result.restored_count).toBe(1);
    expect(result.counts.completed_count).toBe(1);
    expect(await statusOf(restarted, registered.deliveryId)).toBe('processed');
    expect(await experienceIds(restarted)).toEqual([stableExperienceId(ROLE, registered.seq, 0)]);
  });
});

// ════════════════════════════════════════════════════════
//  在线 / 维护边界
// ════════════════════════════════════════════════════════

describe('Context Delivery Worker — 边界检查', () => {
  it('消费上下文不晋升 Skill、不演化 Persona', async () => {
    const h = await harness();
    await h.deliver({ taskId: 'task_1', withContext: true });
    await h.deliver({ taskId: 'task_2', withContext: true });
    const saveSkill = vi.spyOn(h.repository, 'saveSkill');
    const saveSkillIfAbsent = vi.spyOn(h.repository, 'saveSkillIfAbsent');
    const updateSkill = vi.spyOn(h.repository, 'updateSkill');
    const savePersona = vi.spyOn(h.repository, 'savePersona');

    const result = await h.worker.runOnce();

    expect(result.counts.completed_count).toBe(2);
    expect(saveSkill).not.toHaveBeenCalled();
    expect(saveSkillIfAbsent).not.toHaveBeenCalled();
    expect(updateSkill).not.toHaveBeenCalled();
    expect(savePersona).not.toHaveBeenCalled();
    expect(await h.repository.listSkills(ROLE)).toEqual([]);
    // 经验也没有被标成「已晋升」：晋升是后续独立 job 的事
    const stored = await h.repository.listExperiences(ROLE);
    expect(stored.every((experience) => experience.promoted_to === undefined)).toBe(true);
  });

  it('InMemory Buffer 与文件 Buffer 语义一致：同样完成、同样归档', async () => {
    const h = await harness({ buffer: new InMemoryBufferRepository() });
    const registered = await h.deliver({ withContext: true });

    const result = await h.worker.runOnce();

    expect(result.counts.completed_count).toBe(1);
    expect(await statusOf(h, registered.deliveryId)).toBe('processed');
    expect((await h.buffer.getStoredBuffer(ROLE, registered.seq))?.location).toBe('processed');
    expect(await h.buffer.listPendingBufferSeqs(ROLE)).toEqual([]);
    expect(await experienceIds(h)).toEqual([stableExperienceId(ROLE, registered.seq, 0)]);
  });
});

// ════════════════════════════════════════════════════════
//  run 记录的三后端一致性
// ════════════════════════════════════════════════════════

describe.each(RUN_STORE_ADAPTERS)('$name — 消费 run 记录', ({ create, reopen, durable }) => {
  it('runOnce 在 run store 上留下可查询的终态记录', async () => {
    const root = await tempRoot();
    const runStore = await create(join(root, 'runs'));
    const h = await harness({ root, runStore });
    await h.deliver({ withContext: true });

    const result = await h.worker.runOnce();

    expect(result.run).toMatchObject({
      job_type: 'context_delivery',
      status: 'completed',
      worker_id: 'ctx-worker-a',
      claimed_count: 1,
      completed_count: 1,
      failure_count: 0,
    });
    if (durable) {
      // 持久层上的 run 在「重启」之后仍然查得到
      const restarted = await reopen(join(root, 'runs'), runStore);
      expect(await restarted.get(result.run.run_id)).toMatchObject({ status: 'completed' });
    }
    expect(
      await runStore.list({ job_type: 'context_delivery', worker_id: 'ctx-worker-a' }),
    ).toHaveLength(1);
  });
});

describe('Context Delivery Worker — 外壳失败', () => {
  it('外壳自己失败（claim 读不动存储）：run 记 failed，已处理的部分照常留痕', async () => {
    const h = await harness();
    await h.deliver({ withContext: true });
    const claim = vi
      .spyOn(h.delivery, 'claimNextDelivery')
      .mockRejectedValueOnce(Object.assign(new Error('database is down'), { code: 'ECONNRESET' }));

    const result = await h.worker.runOnce();

    expect(result.stop_reason).toBe('worker_error');
    expect(result.worker_failure).toMatchObject({ code: 'downstream_unavailable' });
    expect(result.run.status).toBe('failed');
    expect(result.run.last_error).toContain('downstream_unavailable');

    claim.mockRestore();
    const recovered = await h.worker.runOnce();
    expect(recovered.counts.completed_count).toBe(1);
  });

  it('只有 context 通道会被 claim：别的 role 的交付项照旧排队', async () => {
    const h = await harness();
    const ours = await h.deliver({ withContext: true });
    const theirs = await h.deliver({ role: OTHER_ROLE, withContext: true });

    const result = await h.worker.runOnce({ role_id: ROLE });

    expect(result.counts.claimed_count).toBe(1);
    expect(await statusOf(h, ours.deliveryId)).toBe('processed');
    const untouched = await deliveryStatus(h, OTHER_ROLE, theirs.deliveryId);
    expect(untouched.status).toBe('pending');
    expect(untouched.attempt_count).toBe(0);
  });
});