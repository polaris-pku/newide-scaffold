/**
 * 下游交付 claim / 重试 / 崩溃恢复的服务层与 RPC 测试（工作包 C）
 *
 * 适配器层的状态机由 src/memory/test/memory-delivery-claim.test.ts 覆盖；这里验证
 * 从 RPC 一路到存储的实际链路，以及计划里点名的三类崩溃点：
 *
 *   1. claim 之后、ack 之前进程消失 → 重启恢复后最终只交付一次
 *   2. 连续失败到上限 → dead_letter 在 getBufferState 里可见，可人工 retry
 *   3. 写 evidence 之前中断 → 交付项已落盘，重跑命中幂等键而不是再交一份
 *
 * 以及一条边界：下游怎么失败都不改 Task/Run 与 Buffer 的状态——交付状态是独立的
 * 事实，不是任务终态的一部分。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BMemoryMaintenanceRunner,
  FileBMemoryMaintenanceEvidenceStore,
  type BMemoryMaintenanceEvidenceStore,
} from '../../src/app/b-memory-maintenance-runner';
import { BMemoryBackendService } from '../../src/app/b-memory-backend-service';
import type { BMemoryMaintenanceCapabilities } from '../../src/app/b-public-capabilities';
import {
  FileMemoryDeliveryRepository,
  InMemoryBufferRepository,
  InMemoryMemoryDeliveryRepository,
  InMemoryRepository,
  RepositoryAgentBoardQuery,
  createAgentMemoryScope,
  reviewSkill,
  type LlmClient,
  type MemoryDeliveryRepository,
} from '../../src/memory';
import type { BufferSnapshot, DriverFeedbackRecord } from '../../src/memory/schemas';
import { JsonRpcDispatcher, JsonRpcLineSession } from '../../src/rpc/json-rpc-dispatcher';
import { MemoryRpcMethods, type MemoryMethodsService } from '../../src/rpc/memory-methods';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ROLE = 'role_claim_service';

/** 交付退避压到 1ms：状态机本身由适配器测试覆盖，这里只想快速走完三次投递 */
const FAST_RETRY = { max_attempts: 3, base_delay_ms: 1, max_delay_ms: 1 };

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'newide-delivery-claim-app-'));
  roots.push(root);
  return root;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Fixture {
  service: BMemoryBackendService;
  runner: BMemoryMaintenanceRunner;
  repository: InMemoryRepository;
  bufferRepository: InMemoryBufferRepository;
  delivery: MemoryDeliveryRepository;
}

async function fixture(
  options: {
    root?: string;
    delivery?: MemoryDeliveryRepository;
    evidenceStore?: BMemoryMaintenanceEvidenceStore;
  } = {},
): Promise<Fixture> {
  const root = options.root ?? (await tempRoot());
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  const delivery =
    options.delivery ??
    new FileMemoryDeliveryRepository({
      agentStateRoot: path.join(root, 'agent-state'),
      retryPolicy: FAST_RETRY,
    });
  await repository.initializeAgent({ role_id: ROLE, name: ROLE });
  await bufferRepository.ensureAgent(ROLE);
  await delivery.ensureAgent(ROLE);
  const runner = new BMemoryMaintenanceRunner({
    repository,
    bufferRepository,
    deliveryRepository: delivery,
    llm: extractionLlm(),
    evidenceStore:
      options.evidenceStore ?? new FileBMemoryMaintenanceEvidenceStore(path.join(root, 'evidence')),
  });
  // 生产路径只交付：不需要 mode override，标签本身就是判据
  const service = new BMemoryBackendService(
    {
      boardQuery: new RepositoryAgentBoardQuery(repository),
      maintenance: runner as unknown as BMemoryMaintenanceCapabilities,
      reviewSkill: (input) => reviewSkill(repository, input),
      bufferRepository,
      deliveryRepository: delivery,
    },
    { provider: 'HashEmbeddingProvider', dimensions: 32, readiness: 'verified' },
    {},
    repository,
  );
  return { service, runner, repository, bufferRepository, delivery };
}

function extractionLlm(): LlmClient {
  return {
    async complete() {
      throw new Error('delivery path must not call the extractor');
    },
  };
}

/** 写一条待投递的 Buffer（走真实 AgentMemoryScope），返回它的 seq */
async function writePendingBuffer(f: Fixture, taskId: string): Promise<number> {
  const memory = createAgentMemoryScope(f.repository, f.bufferRepository, ROLE);
  const snapshot: BufferSnapshot = {
    task_id: taskId,
    task_description: 'Deliver context downstream.',
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
    context_snapshot_ref: '1',
    received_at: new Date().toISOString(),
    retry_count: 0,
    extraction_status: 'pending',
  };
  return (await memory.saveBufferSnapshot(snapshot)).seq;
}

/** 走真实任务收尾路径登记一条交付项，返回它的 buffer seq */
async function deliverOnce(f: Fixture, taskId = 'task_delivery'): Promise<number> {
  const seq = await writePendingBuffer(f, taskId);
  await f.runner.scheduleBuffer({
    task_id: taskId,
    run_id: `run_${taskId}`,
    role_id: ROLE,
    buffer_seq: seq,
  });
  return seq;
}

describe('交付 claim / ack（服务层）', () => {
  it('claim 一次、ack processed：两条通道各自只交付一次', async () => {
    const f = await fixture();
    await deliverOnce(f);

    const claimed = await f.service.claimDelivery({ channel: 'context', owner: 'downstream-a' });
    expect(claimed).toMatchObject({ channel: 'context' });
    const deliveryId =
      claimed?.channel === 'context' ? claimed.delivery.delivery_id : 'unreachable';

    // 同一条不会再被投递给第二个消费者
    expect(await f.service.claimDelivery({ channel: 'context', owner: 'downstream-b' })).toBeUndefined();

    const acked = await f.service.ackDelivery({
      channel: 'context',
      role_id: ROLE,
      id: deliveryId,
      owner: 'downstream-a',
      outcome: 'processed',
      processor_version: 'downstream-1.0',
    });
    expect(acked).toMatchObject({ channel: 'context' });
    expect(acked?.channel === 'context' ? acked.delivery : undefined).toMatchObject({
      status: 'processed',
      attempt_count: 1,
      processor_version: 'downstream-1.0',
    });

    const processed = await f.service.listContextDeliveries({ role_id: ROLE, status: 'processed' });
    expect(processed).toHaveLength(1);
    expect(await f.service.listRetryableDeliveries({ role_id: ROLE })).toHaveLength(0);
  });

  it('下游连续失败到上限后 dead_letter 可见，人工 retry 后能重新投递', async () => {
    const f = await fixture();
    const seq = await deliverOnce(f);
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await f.service.claimDelivery({ channel: 'context', owner: 'downstream' });
      expect(claimed, `attempt ${String(attempt)} should be claimable`).toBeDefined();
      await f.service.ackDelivery({
        channel: 'context',
        role_id: ROLE,
        id: item!.delivery_id,
        owner: 'downstream',
        outcome: 'failed',
        error: `downstream unavailable ${String(attempt)}`,
        retryable: true,
      });
      await sleep(10);
    }

    const state = await f.service.getBufferState(ROLE);
    expect(state.delivery).toMatchObject({
      available: true,
      context: { pending: 0, processing: 0, processed: 0, dead_letter: 1 },
    });
    expect(state.delivery.dead_letters).toEqual([
      expect.objectContaining({
        channel: 'context',
        id: item!.delivery_id,
        attempt_count: 3,
        last_error: 'downstream unavailable 3',
      }),
    ]);

    // 下游怎么失败都不改 Buffer 的状态：跑完三轮回合，待办 Buffer 还在原地
    expect(state.pending_seqs).toContain(seq);
    expect(await f.service.listRetryableDeliveries({ role_id: ROLE })).toHaveLength(0);

    const revived = await f.service.retryDelivery({
      channel: 'context',
      role_id: ROLE,
      id: item!.delivery_id,
    });
    expect(revived?.channel === 'context' ? revived.delivery : undefined).toMatchObject({
      status: 'pending',
      attempt_count: 0,
    });
    expect(await f.service.listRetryableDeliveries({ role_id: ROLE })).toHaveLength(1);
  });

  it('memory.retryExtraction 同时恢复 Buffer 与它的交付项（两处死信各自独立）', async () => {
    const f = await fixture();
    const seq = await deliverOnce(f);
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });

    // 让交付项进死信（不可重试的失败）
    await f.service.claimDelivery({ channel: 'context', owner: 'downstream' });
    await f.service.ackDelivery({
      channel: 'context',
      role_id: ROLE,
      id: item!.delivery_id,
      owner: 'downstream',
      outcome: 'failed',
      error: 'permanent downstream error',
      retryable: false,
    });
    // Buffer 那条也进死信（提取失败的历史路径）
    await f.bufferRepository.markBufferDeadLetter(ROLE, seq, 'extraction failed');

    await f.service.retryExtraction(ROLE, seq);

    const state = await f.service.getBufferState(ROLE);
    expect(state.pending_seqs).toContain(seq);
    expect(state.dead_letter_seqs).not.toContain(seq);
    expect(state.delivery.context.dead_letter).toBe(0);
    expect(state.delivery.context.pending).toBe(1);
    expect(await f.service.listRetryableDeliveries({ role_id: ROLE })).toHaveLength(1);
  });

  it('feedback outbox 与上下文交付共用 claim 接口，互不串味', async () => {
    const f = await fixture();
    await deliverOnce(f);
    await f.runner.recordDriverUsageFeedback({
      role_id: ROLE,
      task_id: 'task_delivery',
      buffer_seq: 1,
      references: [
        {
          experience_id: 'exp_1',
          applied: true,
          effectiveness: 'fully_effective',
          note: 'worked',
        },
      ],
    });

    const feedback = await f.service.claimDelivery({ channel: 'feedback', owner: 'merger' });
    expect(feedback).toMatchObject({ channel: 'feedback' });
    const record = (feedback as { feedback: DriverFeedbackRecord }).feedback;
    expect(record).toMatchObject({ status: 'processing', attempt_count: 1, experience_id: 'exp_1' });

    await f.service.ackDelivery({
      channel: 'feedback',
      role_id: ROLE,
      id: record.feedback_id,
      owner: 'merger',
      outcome: 'processed',
    });

    // 上下文那条仍然安安静静地等着
    expect(await f.service.listRetryableDeliveries({ channel: 'context', role_id: ROLE })).toHaveLength(1);
    expect(await f.service.listRetryableDeliveries({ channel: 'feedback', role_id: ROLE })).toHaveLength(0);
  });
});

describe('崩溃点恢复', () => {
  it('claim 之后 ack 之前进程消失：重启恢复后最终只交付一份', async () => {
    const root = await tempRoot();
    const first = await fixture({ root });
    const seq = await deliverOnce(first);

    // 用只够 1ms 的 lease claim，然后「进程退出」——没有任何人持有它
    const claimed = await first.service.claimDelivery({
      channel: 'context',
      owner: 'downstream-that-crashed',
      lease_ms: 1,
    });
    expect(claimed).toMatchObject({ channel: 'context' });
    await sleep(20);

    // 重启：同一个 state root 上新建运行时（生产组合根会在启动时做恢复）
    const restarted = await fixture({ root });
    const restored = await restarted.service.restoreExpiredDeliveries({ role_id: ROLE });
    expect(restored).toHaveLength(1);
    expect(restored[0]?.channel === 'context' ? restored[0].delivery : undefined).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      last_error: 'Claim lease expired without completion.',
    });

    const resumed = await restarted.service.claimDelivery({
      channel: 'context',
      owner: 'downstream-after-restart',
    });
    const deliveryId = resumed?.channel === 'context' ? resumed.delivery.delivery_id : 'unreachable';
    await restarted.service.ackDelivery({
      channel: 'context',
      role_id: ROLE,
      id: deliveryId,
      owner: 'downstream-after-restart',
      outcome: 'processed',
    });

    const all = await restarted.service.listContextDeliveries({ role_id: ROLE });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'processed', attempt_count: 2 });
    // Buffer 序号没变过：恢复的是交付，不是重新生成上下文
    expect(all[0]?.buffer_seq).toBe(seq);
  });

  it('写 evidence 之前中断：交付项已落盘，重跑命中幂等键而不是再交一份', async () => {
    const root = await tempRoot();
    // evidence 写盘会在「交付项已提交之后、证据落盘之前」失败——这正是计划点名的
    // 第三个崩溃点：交付事实与证据不是同一个事务。
    const real = new FileBMemoryMaintenanceEvidenceStore(path.join(root, 'evidence'));
    let evidenceWritable = false;
    const flaky: BMemoryMaintenanceEvidenceStore = {
      save: async (evidence) => {
        if (!evidenceWritable) throw new Error('evidence store is unwritable');
        return real.save(evidence);
      },
      get: (maintenanceRef) => real.get(maintenanceRef),
      list: (roleId) => real.list(roleId),
    };
    const f = await fixture({ root, evidenceStore: flaky });
    const seq = await writePendingBuffer(f, 'task_evidence_crash');
    await expect(
      f.runner.scheduleBuffer({
        task_id: 'task_evidence_crash',
        run_id: 'run_evidence_crash',
        role_id: ROLE,
        buffer_seq: seq,
      }),
    ).rejects.toThrow('evidence store is unwritable');

    // 交付项已经落了盘：交付事实与证据不是同一个事务，证据失败不该把交付一起回滚
    const deliveries = await f.service.listContextDeliveries({ role_id: ROLE });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.buffer_seq).toBe(seq);

    // 重跑：命中幂等键，不会再交一份，也不会因为证据缺失而重新生成上下文
    evidenceWritable = true;
    const replay = await f.runner.scheduleBuffer({
      task_id: 'task_evidence_crash',
      run_id: 'run_retry',
      role_id: ROLE,
      buffer_seq: seq,
    });
    expect(replay.context_delivery?.delivery_id).toBe(deliveries[0]!.delivery_id);
    expect(replay.warnings).toEqual([
      'Context was already delivered under the same key; the existing delivery was kept.',
    ]);
    expect(await f.service.listContextDeliveries({ role_id: ROLE })).toHaveLength(1);
  });
});

describe('capabilities 与 RPC 接线', () => {
  it('capabilities v4 如实报告 claim 隔离级别与重试上限', async () => {
    const f = await fixture();
    const capabilities = f.service.getCapabilities();
    expect(capabilities.schema_version).toBe('newide.b-memory-capabilities.v4');
    expect(capabilities.memory_maintenance).toMatchObject({
      ownership: 'external',
      claim: {
        status: 'available',
        // 文件实现用独占锁文件，多进程消费才成立
        isolation: 'exclusive_lock_file',
        max_attempts: 3,
      },
    });
    expect(capabilities.operations.claim_delivery).toEqual({ status: 'available' });
    expect(capabilities.operations.ack_delivery).toEqual({ status: 'available' });

    const inMemory = await fixture({ delivery: new InMemoryMemoryDeliveryRepository() });
    expect(inMemory.service.getCapabilities().memory_maintenance.claim).toMatchObject({
      isolation: 'process_mutex',
    });
  });

  it('memory.claimDelivery / ackDelivery / getBufferState 走通 RPC', async () => {
    const f = await fixture();
    await deliverOnce(f);
    const send = rpcSession(f.service);

    const [capabilities] = await send(
      '{"jsonrpc":"2.0","id":1,"method":"memory.getCapabilities","params":{}}',
    );
    expect(capabilities).toMatchObject({
      result: { capabilities: { schema_version: 'newide.b-memory-capabilities.v4' } },
    });

    const [claimed] = await send(
      '{"jsonrpc":"2.0","id":2,"method":"memory.claimDelivery","params":{"channel":"context","owner":"rpc-consumer","lease_ms":60000}}',
    );
    const claimedResult = claimed!.result as { delivery: { delivery: { delivery_id: string } } };
    const deliveryId = claimedResult.delivery.delivery.delivery_id;
    expect(claimedResult.delivery.delivery).toMatchObject({ status: 'processing' });

    // 没人可投时就明确回 null，而不是报错
    const [nothing] = await send(
      '{"jsonrpc":"2.0","id":3,"method":"memory.claimDelivery","params":{"channel":"context","owner":"rpc-consumer-2"}}',
    );
    expect((nothing!.result as { delivery: unknown }).delivery).toBeNull();

    const [acked] = await send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'memory.ackDelivery',
        params: {
          channel: 'context',
          role_id: ROLE,
          id: deliveryId,
          owner: 'rpc-consumer',
          outcome: 'processed',
        },
      }),
    );
    expect(
      (acked!.result as { delivery: { delivery: { status: string } } }).delivery.delivery.status,
    ).toBe('processed');

    const [state] = await send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'memory.getBufferState',
        params: { role_id: ROLE },
      }),
    );
    expect(
      (state!.result as { state: { delivery: unknown } }).state.delivery,
    ).toMatchObject({ available: true, context: { processed: 1 } });

    // 参数校验依然严格：多余字段直接 INVALID_PARAMS
    const [invalid] = await send(
      '{"jsonrpc":"2.0","id":6,"method":"memory.claimDelivery","params":{"channel":"context","owner":"x","nope":1}}',
    );
    expect((invalid as { error?: { code: number } }).error?.code).toBe(-32602);
  });
});

/** 只接本文件用到的方法；其余方法被调用时立刻报错，避免假装它已经接好了 */
function rpcSession(service: BMemoryBackendService): (...lines: string[]) => Promise<unknown[]> {
  const wired: Partial<MemoryMethodsService> = {
    getMemoryCapabilities: () => service.getCapabilities(),
    getMemoryBufferState: (roleId) => service.getBufferState(roleId),
    listMemoryContextDeliveries: (filter) => service.listContextDeliveries(filter),
    getMemoryContextDelivery: (roleId, deliveryId) => service.getContextDelivery(roleId, deliveryId),
    listMemoryDriverFeedback: (filter) => service.listDriverFeedback(filter),
    claimMemoryDelivery: (input) => service.claimDelivery(input),
    renewMemoryDeliveryClaim: (input) => service.renewDeliveryClaim(input),
    ackMemoryDelivery: (input) => service.ackDelivery(input),
    retryMemoryDelivery: (input) => service.retryDelivery(input),
    restoreExpiredMemoryDeliveries: (options) => service.restoreExpiredDeliveries(options),
    listRetryableMemoryDeliveries: (options) => service.listRetryableDeliveries(options),
  };
  const partial = new Proxy(wired, {
    get(target, property) {
      if (property in target) return (target as Record<string, unknown>)[property as string];
      return () => {
        throw new Error(`RPC method ${String(property)} is not wired in this test`);
      };
    },
  }) as MemoryMethodsService;

  const dispatcher = new JsonRpcDispatcher();
  new MemoryRpcMethods(partial).register(dispatcher);
  const output: string[] = [];
  const session = new JsonRpcLineSession(dispatcher, (line) => output.push(line));
  return async (...lines: string[]) => {
    output.length = 0;
    for (const line of lines) await session.handleLine(line);
    return output.map((line) => JSON.parse(line) as Record<string, unknown>);
  };
}
