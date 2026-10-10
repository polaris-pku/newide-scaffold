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
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BMemoryMaintenanceRunner,
  FileBMemoryMaintenanceEvidenceStore,
  type BMemoryMaintenanceEvidenceStore,
} from '../../src/app/b-memory-maintenance-runner';
import { BMemoryBackendService } from '../../src/app/b-memory-backend-service';
import type { BMemoryMaintenanceCapabilities } from '../../src/app/b-public-capabilities';
import {
  FileBufferRepository,
  FileMemoryDeliveryRepository,
  InMemoryBufferRepository,
  InMemoryMemoryDeliveryRepository,
  InMemoryRepository,
  RepositoryAgentBoardQuery,
  createAgentMemoryScope,
  reviewSkill,
  type BufferRepository,
  type LlmClient,
  type MemoryDeliveryRepository,
} from '../../src/memory';
import type {
  AgentContextSnapshot,
  BufferSnapshot,
  DriverFeedbackRecord,
} from '../../src/memory/schemas';
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
  bufferRepository: BufferRepository;
  delivery: MemoryDeliveryRepository;
  agentStateRoot: string;
}

async function fixture(
  options: {
    root?: string;
    delivery?: MemoryDeliveryRepository;
    evidenceStore?: BMemoryMaintenanceEvidenceStore;
    /** 注入文件缓冲仓储，覆盖「归档后交付仍可读」的真实目录布局 */
    bufferRepository?: BufferRepository;
  } = {},
): Promise<Fixture> {
  const root = options.root ?? (await tempRoot());
  const agentStateRoot = path.join(root, 'agent-state');
  const repository = new InMemoryRepository();
  const bufferRepository = options.bufferRepository ?? new InMemoryBufferRepository();
  const delivery =
    options.delivery ??
    new FileMemoryDeliveryRepository({
      agentStateRoot,
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
  return { service, runner, repository, bufferRepository, delivery, agentStateRoot };
}

/** 与内存夹具同一套行为，但缓冲区落在真实目录树上（pending/processed/dead_letter） */
async function fileBackedFixture(): Promise<Fixture> {
  const root = await tempRoot();
  return fixture({
    root,
    bufferRepository: new FileBufferRepository({
      agentStateRoot: path.join(root, 'agent-state'),
    }),
  });
}

function extractionLlm(): LlmClient {
  return {
    async complete() {
      throw new Error('delivery path must not call the extractor');
    },
  };
}

/** 写一条待投递的 Buffer（走真实 AgentMemoryScope），返回它的 seq */
async function writePendingBuffer(
  f: Fixture,
  taskId: string,
  agentContext?: AgentContextSnapshot,
  /**
   * 显式的 context_snapshot_ref。缺省跟 agentContext 走：有上下文才声明引用。
   * 需要构造「声明了引用却没有上下文」这种损坏形态时才显式传值。
   */
  contextRef?: string | undefined,
): Promise<number> {
  const memory = createAgentMemoryScope(f.repository, f.bufferRepository, ROLE);
  const ref = contextRef ?? (agentContext ? '1' : undefined);
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
    ...(ref !== undefined ? { context_snapshot_ref: ref } : {}),
    received_at: new Date().toISOString(),
    retry_count: 0,
    extraction_status: 'pending',
  };
  return (await memory.saveBufferSnapshot(snapshot, agentContext)).seq;
}

function sampleAgentContext(roleId: string): AgentContextSnapshot {
  return {
    snapshot_id: randomUUID(),
    source_task_id: 'task_delivery',
    agent_id: roleId,
    thinking_trace: 'Reasoning trace',
    planning_trace: 'Planning trace',
    driver_calls: [
      { call_id: 'call_001', driver_id: 'acp-external', driver_return_ref: 'report_1.json' },
    ],
    cleaned_at: new Date().toISOString(),
    original_token_count: 1000,
    cleaned_token_count: 400,
    compression_ratio: 0.4,
  };
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

describe('交付 ack 与源 Buffer 的生命周期', () => {
  it('ack processed 后源 Buffer 离开 pending，交付 payload 仍完整可取（内存缓冲区）', async () => {
    const f = await fixture();
    const agentContext = sampleAgentContext(ROLE);
    const seq = await writePendingBuffer(f, 'task_delivery', agentContext);
    await f.runner.scheduleBuffer({
      task_id: 'task_delivery',
      run_id: 'run_task_delivery',
      role_id: ROLE,
      buffer_seq: seq,
    });
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });

    await f.service.claimDelivery({ channel: 'context', owner: 'downstream' });
    await f.service.ackDelivery({
      channel: 'context',
      role_id: ROLE,
      id: item!.delivery_id,
      owner: 'downstream',
      outcome: 'processed',
    });

    // 下游已经拿着这份上下文干活了：它不该再占着待办队列
    const state = await f.service.getBufferState(ROLE);
    expect(state.pending_seqs).not.toContain(seq);
    expect(state.meta).toMatchObject({ pending_count: 0, total_processed: 1 });
    expect(state.delivery.context).toMatchObject({ processed: 1, pending: 0 });

    // 归档不等于交付失效：payload 仍按 delivery_id 取回，且是完整的两半
    const payload = await f.service.getContextDelivery(ROLE, item!.delivery_id);
    expect(payload).toMatchObject({ payload_available: true });
    expect(payload?.driver_return?.summary).toBe('Completed.');
    expect(payload?.agent_context?.snapshot_id).toBe(agentContext.snapshot_id);
  });

  it('文件缓冲区：ack 后报告与上下文一起搬到 processed，交付仍读得回完整 payload', async () => {
    const f = await fileBackedFixture();
    const agentContext = sampleAgentContext(ROLE);
    const seq = await writePendingBuffer(f, 'task_delivery', agentContext);
    await f.runner.scheduleBuffer({
      task_id: 'task_delivery',
      run_id: 'run_task_delivery',
      role_id: ROLE,
      buffer_seq: seq,
    });
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });

    await f.service.claimDelivery({ channel: 'context', owner: 'downstream' });
    await f.service.ackDelivery({
      channel: 'context',
      role_id: ROLE,
      id: item!.delivery_id,
      owner: 'downstream',
      outcome: 'processed',
    });

    const bufferRoot = path.join(f.agentStateRoot, ROLE, 'buffer');
    await expect(readdir(path.join(bufferRoot, 'pending'))).resolves.toEqual([]);
    expect((await readdir(path.join(bufferRoot, 'processed'))).sort()).toEqual([
      'context_1.json',
      'report_1.json',
    ]);

    const payload = await f.service.getContextDelivery(ROLE, item!.delivery_id);
    expect(payload).toMatchObject({ payload_available: true });
    expect(payload?.driver_return?.summary).toBe('Completed.');
    expect(payload?.agent_context?.snapshot_id).toBe(agentContext.snapshot_id);
  });

  it('Buffer 进了死信，交付仍按 delivery_id 读得回完整 payload', async () => {
    const f = await fixture();
    const agentContext = sampleAgentContext(ROLE);
    const seq = await writePendingBuffer(f, 'task_delivery', agentContext);
    await f.runner.scheduleBuffer({
      task_id: 'task_delivery',
      run_id: 'run_task_delivery',
      role_id: ROLE,
      buffer_seq: seq,
    });
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });

    // 加工侧把这条 Buffer 打了死信：交付项自己没有被处理过，payload 不能跟着失效
    await f.bufferRepository.markBufferDeadLetter(ROLE, seq, 'extractor failed');

    const payload = await f.service.getContextDelivery(ROLE, item!.delivery_id);
    expect(payload).toMatchObject({ payload_available: true });
    expect(payload?.driver_return?.summary).toBe('Completed.');
    expect(payload?.agent_context?.snapshot_id).toBe(agentContext.snapshot_id);

    const state = await f.service.getBufferState(ROLE);
    expect(state.dead_letter_seqs).toEqual([seq]);
    expect(state.delivery.context).toMatchObject({ pending: 1, dead_letter: 0 });
  });

  it('ack failed 不动 Buffer：待办还在，重试才有意义', async () => {    const f = await fixture();
    const seq = await deliverOnce(f);
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });
    const archiveSpy = vi.spyOn(f.bufferRepository, 'archiveBuffer');

    await f.service.claimDelivery({ channel: 'context', owner: 'downstream' });
    const failedAck = await f.service.ackDelivery({
      channel: 'context',
      role_id: ROLE,
      id: item!.delivery_id,
      owner: 'downstream',
      outcome: 'failed',
      error: 'downstream unavailable',
      retryable: true,
    });

    // 失败路径根本不走归档：没有 archive 结论，也没有归档动作
    expect(failedAck?.channel === 'context' ? 'archive' in failedAck : true).toBe(false);
    expect(archiveSpy).not.toHaveBeenCalled();

    const state = await f.service.getBufferState(ROLE);
    expect(state.pending_seqs).toContain(seq);
    expect(state.meta).toMatchObject({ pending_count: 1, total_processed: 0 });
  });

  it('归档之后 replayPending 不再为这条 Buffer 补交交付', async () => {
    const f = await fixture();
    const seq = await deliverOnce(f);
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });
    await f.service.claimDelivery({ channel: 'context', owner: 'downstream' });
    await f.service.ackDelivery({
      channel: 'context',
      role_id: ROLE,
      id: item!.delivery_id,
      owner: 'downstream',
      outcome: 'processed',
    });

    await expect(f.runner.replayPending()).resolves.toEqual([]);
    await expect(f.service.listContextDeliveries({ role_id: ROLE })).resolves.toHaveLength(1);
    expect((await f.service.getBufferState(ROLE)).pending_seqs).not.toContain(seq);
  });
});

describe('ack 与源 Buffer 归档的一致性（两个存储，没有跨存储事务）', () => {
  it('ack processed 且归档成功：archive=archived，Buffer 移入 processed，无归档缺口', async () => {
    const f = await fileBackedFixture();
    const agentContext = sampleAgentContext(ROLE);
    const seq = await writePendingBuffer(f, 'task_delivery', agentContext);
    await f.runner.scheduleBuffer({
      task_id: 'task_delivery',
      run_id: 'run_task_delivery',
      role_id: ROLE,
      buffer_seq: seq,
    });
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });

    await f.service.claimDelivery({ channel: 'context', owner: 'downstream' });
    const acked = await f.service.ackDelivery({
      channel: 'context',
      role_id: ROLE,
      id: item!.delivery_id,
      owner: 'downstream',
      outcome: 'processed',
    });

    expect(acked?.channel === 'context' ? acked.archive : undefined).toEqual({ status: 'archived' });
    const state = await f.service.getBufferState(ROLE);
    expect(state.pending_seqs).not.toContain(seq);
    expect(state.meta).toMatchObject({ pending_count: 0, total_processed: 1 });
    expect(state.delivery.archive_backlog).toEqual([]);
  });

  /**
   * 归档是 ack 之后的后续动作：ack 的成功语义只覆盖交付状态（下游确实处理完了，
   * 不能回滚），归档失败必须原样报出来——既不能吞掉，也不能伪装成「全都成功」。
   * 缺口的最终状态是「交付 processed + Buffer 仍 pending」，可查询、可重试。
   */
  it('归档 I/O 失败不被吞掉：ack 仍成功，但结果与状态都如实报出，且可修复', async () => {
    const f = await fixture();
    const seq = await deliverOnce(f);
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });

    const spy = vi
      .spyOn(f.bufferRepository, 'markBufferProcessed')
      .mockRejectedValue(new Error('EIO: simulated archive I/O failure'));

    await f.service.claimDelivery({ channel: 'context', owner: 'downstream' });
    const acked = await f.service.ackDelivery({
      channel: 'context',
      role_id: ROLE,
      id: item!.delivery_id,
      owner: 'downstream',
      outcome: 'processed',
    });
    spy.mockRestore();

    // 交付状态照常推进（不能回滚下游已经做完的事）……
    expect(acked?.channel === 'context' ? acked.delivery.status : undefined).toBe('processed');
    // ……但归档结果不能看起来完全成功
    const archive = acked?.channel === 'context' ? acked.archive : undefined;
    expect(archive).toMatchObject({ status: 'failed' });
    expect(archive?.status === 'failed' ? archive.message : '').toContain(
      'simulated archive I/O failure',
    );

    // 最终状态：交付 processed，Buffer 仍在 pending —— 这就是定义好的一致性策略
    const state = await f.service.getBufferState(ROLE);
    expect(state.pending_seqs).toContain(seq);
    expect(state.delivery.context).toMatchObject({ processed: 1, pending: 0 });
    // 缺口不只是这次调用的返回值：后端状态里查得到，重启后也一样
    expect(state.delivery.archive_backlog).toEqual([
      expect.objectContaining({
        delivery_id: item!.delivery_id,
        buffer_seq: seq,
        task_id: 'task_delivery',
      }),
    ]);

    // 运维拿 archive_backlog 里的 seq 调 retryExtraction 即可补做归档
    const repair = await f.service.retryExtraction(ROLE, seq);
    expect(repair.warnings.join(' ')).toContain('Archived Buffer');
    const repaired = await f.service.getBufferState(ROLE);
    expect(repaired.pending_seqs).not.toContain(seq);
    expect(repaired.delivery.archive_backlog).toEqual([]);
  });

  /**
   * 配对 Buffer 的归档缺口：交付已 processed，归档却因为**配对的上下文搬不动**而没落地。
   * 关键不变量是报告那一半不能被先搬走——report 留在 pending，缺口才由持久状态本身
   * （交付 processed + Buffer 仍 pending）推导出来，重启后照样看得见、拿 seq 就能补做。
   */
  it('配对 context 搬不动：归档缺口可发现，补回上下文后 retryExtraction 可修复', async () => {
    const f = await fileBackedFixture();
    const agentContext = sampleAgentContext(ROLE);
    const seq = await writePendingBuffer(f, 'task_delivery', agentContext);
    await f.runner.scheduleBuffer({
      task_id: 'task_delivery',
      run_id: 'run_task_delivery',
      role_id: ROLE,
      buffer_seq: seq,
    });
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });

    // 交付之后把配对的上下文弄丢：归档时 context 搬不动，报告就不该被先搬走
    const contextPath = path.join(f.agentStateRoot, ROLE, 'buffer', 'pending', 'context_1.json');
    const contextJson = await readFile(contextPath, 'utf8');
    await rm(contextPath);

    await f.service.claimDelivery({ channel: 'context', owner: 'downstream' });
    const acked = await f.service.ackDelivery({
      channel: 'context',
      role_id: ROLE,
      id: item!.delivery_id,
      owner: 'downstream',
      outcome: 'processed',
    });

    // 交付状态照常推进（不回滚下游），但归档结果必须如实报失败
    expect(acked?.channel === 'context' ? acked.delivery.status : undefined).toBe('processed');
    expect(acked?.channel === 'context' ? acked.archive : undefined).toMatchObject({
      status: 'failed',
    });

    const state = await f.service.getBufferState(ROLE);
    expect(state.pending_seqs).toContain(seq);
    expect(state.delivery.archive_backlog).toEqual([
      expect.objectContaining({ delivery_id: item!.delivery_id, buffer_seq: seq }),
    ]);

    // 运维把丢掉的上下文补回来 → 归档缺口可被 retryExtraction 补做
    await writeFile(contextPath, contextJson, 'utf8');
    const repair = await f.service.retryExtraction(ROLE, seq);
    expect(repair.warnings.join(' ')).toContain('Archived Buffer');

    const repaired = await f.service.getBufferState(ROLE);
    expect(repaired.pending_seqs).not.toContain(seq);
    expect(repaired.delivery.archive_backlog).toEqual([]);
  });

  it('重复 ack 幂等：不二次归档、不改终态', async () => {
    const f = await fixture();
    await deliverOnce(f);
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });
    const request = {
      channel: 'context' as const,
      role_id: ROLE,
      id: item!.delivery_id,
      owner: 'downstream',
      outcome: 'processed' as const,
    };

    await f.service.claimDelivery({ channel: 'context', owner: 'downstream' });
    const first = await f.service.ackDelivery(request);
    expect(first?.channel === 'context' ? first.archive : undefined).toEqual({ status: 'archived' });

    const archiveSpy = vi.spyOn(f.bufferRepository, 'archiveBuffer');
    const second = await f.service.ackDelivery(request);

    // 第二次什么也没发生：completeDelivery 只对 processing 生效
    expect(second).toBeUndefined();
    expect(archiveSpy).not.toHaveBeenCalled();

    const state = await f.service.getBufferState(ROLE);
    expect(state.meta).toMatchObject({ pending_count: 0, total_processed: 1 });
    expect(state.delivery.context).toMatchObject({ processed: 1 });
    expect(state.delivery.archive_backlog).toEqual([]);
  });
});

/**
 * 「没有上下文」与「有上下文却读不出来」在下游看都是 agent_context 缺席，含义却相反：
 * 前者是历史 Buffer 的正常形态（允许降级），后者是一份**声明过**的上下文丢了。
 * 这里的用例把两种情形与三种损坏形态（文件缺失 / JSON 损坏 / schema 不匹配）分开钉死。
 */
describe('getContextDelivery：上下文损坏不被误判为「没有上下文」', () => {
  it('配对完整：payload_available=true，报告与上下文两半都在', async () => {
    const f = await fileBackedFixture();
    const agentContext = sampleAgentContext(ROLE);
    const seq = await writePendingBuffer(f, 'task_delivery', agentContext);
    await f.runner.scheduleBuffer({
      task_id: 'task_delivery',
      run_id: 'run_task_delivery',
      role_id: ROLE,
      buffer_seq: seq,
    });
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });

    const payload = await f.service.getContextDelivery(ROLE, item!.delivery_id);
    expect(payload).toMatchObject({ payload_available: true });
    expect(payload?.payload_warning).toBeUndefined();
    expect(payload?.driver_return?.summary).toBe('Completed.');
    expect(payload?.agent_context?.snapshot_id).toBe(agentContext.snapshot_id);
  });

  it('没有声明引用的历史 Buffer 且无 context 文件：保持兼容降级', async () => {
    const f = await fileBackedFixture();
    // 没有 agentContext、也没有 context_snapshot_ref：写入侧本来就没做上下文清理
    const seq = await writePendingBuffer(f, 'task_delivery');
    await f.runner.scheduleBuffer({
      task_id: 'task_delivery',
      run_id: 'run_task_delivery',
      role_id: ROLE,
      buffer_seq: seq,
    });
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });
    expect(item?.context_snapshot_ref).toBeUndefined();

    const payload = await f.service.getContextDelivery(ROLE, item!.delivery_id);
    // 报告照给，没有 agent_context 也不报 warning：这是允许的降级路径
    expect(payload).toMatchObject({ payload_available: true });
    expect(payload?.payload_warning).toBeUndefined();
    expect(payload?.driver_return?.summary).toBe('Completed.');
    expect(payload?.agent_context).toBeUndefined();
  });

  it.each([
    { form: 'JSON 损坏', write: '{ not json' },
    { form: 'schema 不匹配', write: '{"snapshot_id":"not-a-uuid"}' },
  ])('声明了引用但 context $form：不得报「完整 payload 可用」', async ({ write }) => {
    const f = await fileBackedFixture();
    const agentContext = sampleAgentContext(ROLE);
    const seq = await writePendingBuffer(f, 'task_delivery', agentContext);
    await f.runner.scheduleBuffer({
      task_id: 'task_delivery',
      run_id: 'run_task_delivery',
      role_id: ROLE,
      buffer_seq: seq,
    });
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });
    await writeFile(
      path.join(f.agentStateRoot, ROLE, 'buffer', 'pending', 'context_1.json'),
      write,
      'utf8',
    );

    const payload = await f.service.getContextDelivery(ROLE, item!.delivery_id);
    expect(payload?.payload_available).toBe(false);
    expect(payload?.payload_warning).toMatch(/context_1\.json/);
    expect(payload?.agent_context).toBeUndefined();
    // DriverReturn 仍可单独读取，只是明确告诉你另一半不可用
    expect(payload?.driver_return?.summary).toBe('Completed.');
  });

  it('声明了引用但 context 文件缺失：报不可用，而不是「本次没有上下文」', async () => {
    const f = await fileBackedFixture();
    const agentContext = sampleAgentContext(ROLE);
    const seq = await writePendingBuffer(f, 'task_delivery', agentContext);
    await f.runner.scheduleBuffer({
      task_id: 'task_delivery',
      run_id: 'run_task_delivery',
      role_id: ROLE,
      buffer_seq: seq,
    });
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });
    await rm(path.join(f.agentStateRoot, ROLE, 'buffer', 'pending', 'context_1.json'));

    const payload = await f.service.getContextDelivery(ROLE, item!.delivery_id);
    expect(payload?.payload_available).toBe(false);
    expect(payload?.payload_warning).toMatch(/context_snapshot_ref=1/);
  });

  it('归档（processed 分区）之后上下文损坏：同样报不可用，不静默丢一半', async () => {
    const f = await fileBackedFixture();
    const agentContext = sampleAgentContext(ROLE);
    const seq = await writePendingBuffer(f, 'task_delivery', agentContext);
    await f.runner.scheduleBuffer({
      task_id: 'task_delivery',
      run_id: 'run_task_delivery',
      role_id: ROLE,
      buffer_seq: seq,
    });
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });
    await f.service.claimDelivery({ channel: 'context', owner: 'downstream' });
    await f.service.ackDelivery({
      channel: 'context',
      role_id: ROLE,
      id: item!.delivery_id,
      owner: 'downstream',
      outcome: 'processed',
    });

    await writeFile(
      path.join(f.agentStateRoot, ROLE, 'buffer', 'processed', 'context_1.json'),
      '{ not json',
      'utf8',
    );
    const payload = await f.service.getContextDelivery(ROLE, item!.delivery_id);
    expect(payload?.payload_available).toBe(false);
    expect(payload?.payload_warning).toMatch(/context_1\.json/);
    expect(payload?.driver_return?.summary).toBe('Completed.');
  });
});

describe('两处死信的独立恢复（memory.retryExtraction）', () => {
  it('仅 Buffer 在死信：恢复 Buffer，不碰本来就在 pending 的交付', async () => {
    const f = await fixture();
    const seq = await deliverOnce(f);
    await f.bufferRepository.markBufferDeadLetter(ROLE, seq, 'extractor failed');

    const evidence = await f.service.retryExtraction(ROLE, seq);
    expect(evidence.status).toBe('scheduled');

    const state = await f.service.getBufferState(ROLE);
    expect(state.pending_seqs).toContain(seq);
    expect(state.dead_letter_seqs).toEqual([]);
    expect(state.delivery.context).toMatchObject({ pending: 1, dead_letter: 0 });
    // 交付没有被重试复制成第二条
    await expect(f.service.listContextDeliveries({ role_id: ROLE })).resolves.toHaveLength(1);
  });

  it('仅交付在死信：恢复交付，Buffer 留在 pending（旧实现会在这里抛错）', async () => {
    const f = await fixture();
    const seq = await deliverOnce(f);
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });
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

    await f.service.retryExtraction(ROLE, seq);

    const state = await f.service.getBufferState(ROLE);
    expect(state.delivery.context).toMatchObject({ pending: 1, dead_letter: 0 });
    expect(await f.service.listRetryableDeliveries({ role_id: ROLE })).toHaveLength(1);
    // Buffer 那侧原本就在 pending：计数不能被恢复流程再加一次
    expect(state.pending_seqs).toEqual([seq]);
    expect(state.meta.pending_count).toBe(1);
  });

  it('两者同时死信：一次调用把两边都放回队列', async () => {
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

  it('重复 retry 幂等：交付不复制、Buffer 不重复计数', async () => {
    const f = await fixture();
    const seq = await deliverOnce(f);
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });
    await f.bufferRepository.markBufferDeadLetter(ROLE, seq, 'extraction failed');
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

    await f.service.retryExtraction(ROLE, seq);
    await f.service.retryExtraction(ROLE, seq);
    await f.service.retryExtraction(ROLE, seq);

    await expect(f.service.listContextDeliveries({ role_id: ROLE })).resolves.toHaveLength(1);
    const state = await f.service.getBufferState(ROLE);
    expect(state.pending_seqs).toEqual([seq]);
    expect(state.meta.pending_count).toBe(1);
    expect(state.delivery.context).toMatchObject({ pending: 1, dead_letter: 0 });
  });

  it('已 processed 的交付不会被重试拉回队列', async () => {
    const f = await fixture();
    const seq = await deliverOnce(f);
    const [item] = await f.service.listContextDeliveries({ role_id: ROLE });
    await f.service.claimDelivery({ channel: 'context', owner: 'downstream' });
    await f.service.ackDelivery({
      channel: 'context',
      role_id: ROLE,
      id: item!.delivery_id,
      owner: 'downstream',
      outcome: 'processed',
    });

    // Buffer 已随 ack 归档，没有可恢复的死信：如实报 skipped 而不是抛错
    const evidence = await f.service.retryExtraction(ROLE, seq);
    expect(evidence.status).toBe('skipped');
    expect(evidence.warnings.join(' ')).toContain('neither pending nor dead-lettered');

    const [still] = await f.service.listContextDeliveries({ role_id: ROLE });
    expect(still).toMatchObject({ status: 'processed', attempt_count: 1 });
    const state = await f.service.getBufferState(ROLE);
    expect(state.pending_seqs).not.toContain(seq);
    expect(await f.service.listRetryableDeliveries({ role_id: ROLE })).toHaveLength(0);
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
