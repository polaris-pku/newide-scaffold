/**
 * 下游交付契约测试（工作包 B）
 *
 * 验证任务流程与 Memory Maintenance 的边界：
 *
 *   1. 生产路径只交付上下文，本进程不提取经验 / 不晋升 / 不演化 Persona
 *   2. 交付项可被下游按稳定引用读回（DriverReturn + AgentContextSnapshot）
 *   3. 下游没上线、没消费、重启，都不影响已完成的任务；交付项可重放
 *   4. Driver 使用反馈独立于经验是否存在，且重复提交不重复累计
 *   5. 实验路径（消融标签 / 显式 emulation）才在本进程模拟下游
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BMemoryMaintenanceRunner,
  FileBMemoryMaintenanceEvidenceStore,
  type BMemoryMaintenanceRunnerOptions,
} from '../../src/app/b-memory-maintenance-runner';
import { DriverRuntimeAgentExecutionFacade } from '../../src/app/driver-runtime-agent-execution-facade';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import type {
  DriverCapabilities,
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle,
  DriverStreamEventListener,
} from '../../src/driver';
import {
  InMemoryBufferRepository,
  InMemoryMemoryDeliveryRepository,
  InMemoryRepository,
  createAgentMemoryScope,
  type LlmClient,
  type ToolCallingClient,
} from '../../src/memory';
import type { BufferSnapshot, AgentContextSnapshot } from '../../src/memory/schemas';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ROLE = 'role_delivery';

interface Fixture {
  runner: BMemoryMaintenanceRunner;
  repository: InMemoryRepository;
  bufferRepository: InMemoryBufferRepository;
  delivery: InMemoryMemoryDeliveryRepository;
}

async function fixture(
  overrides: Partial<BMemoryMaintenanceRunnerOptions> = {},
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'newide-delivery-'));
  roots.push(root);
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  const delivery = new InMemoryMemoryDeliveryRepository();
  await repository.initializeAgent({ role_id: ROLE, name: ROLE });
  await bufferRepository.ensureAgent(ROLE);
  await delivery.ensureAgent(ROLE);
  const runner = new BMemoryMaintenanceRunner({
    repository,
    bufferRepository,
    deliveryRepository: delivery,
    llm: extractionLlm(),
    evidenceStore: new FileBMemoryMaintenanceEvidenceStore(path.join(root, 'evidence')),
    ...overrides,
  });
  return { runner, repository, bufferRepository, delivery };
}

async function writePending(
  repository: InMemoryRepository,
  bufferRepository: InMemoryBufferRepository,
  taskId: string,
  references: BufferSnapshot['driver_return']['referenced_experiences'] = [],
  agentContext?: AgentContextSnapshot,
): Promise<number> {
  const memory = createAgentMemoryScope(repository, bufferRepository, ROLE);
  const snapshot: BufferSnapshot = {
    task_id: taskId,
    task_description: 'Deliver context downstream.',
    driver_return: {
      summary: 'The task completed through the public B runtime.',
      artifacts: [{ type: 'file', path: 'src/result.ts', summary: 'created' }],
      decisions: [],
      blockers: [],
      referenced_experiences: references,
      assumptions: [],
    },
    source_task_id: taskId,
    source_driver: 'acp-external',
    received_at: new Date().toISOString(),
    retry_count: 0,
    extraction_status: 'pending',
  };
  // 声明 context_snapshot_ref 的唯一正当方式是**真的配一份上下文**（saveBufferSnapshot
  // 会自动写 ref）；只声明引用却不给上下文，读回来就是 unreadable，交付必须在首次提交时
  // 就拒绝它（见 submitContextDelivery）——所以这里用成对的上下文构造，而不是伪造一个 ref。
  return (await memory.saveBufferSnapshot(snapshot, agentContext)).seq;
}

function sampleAgentContext(): AgentContextSnapshot {
  return {
    snapshot_id: randomUUID(),
    source_task_id: 'task_deliver',
    agent_id: ROLE,
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

/**
 * 只答「提取」的 LLM：交付路径根本不该走到这里。
 *
 * 带一个会合点：`parties` 个调用都答完才一起放行。用它把两个 worker 的提取对齐到同一
 * 时刻——不对齐的话，先启动的那个可能整条流程（提取 → 入库 → 归档）都跑完了，另一个才
 * 读到 pending，于是「并发重入」根本没发生，测的就不是并发下的入库了。
 */
function extractionLlm(parties = 1): LlmClient {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async complete() {
      arrivals += 1;
      if (arrivals >= parties) release?.();
      await gate;
      return JSON.stringify({
        experiences: [
          {
            description: 'Deliver before you accumulate',
            content: 'Hand context downstream instead of extracting in-process.',
            type: 'positive',
            confidence: 0.5,
            tags: ['delivery'],
          },
        ],
      });
    },
  };
}

describe('memory delivery contract (工作包 B)', () => {
  it('生产路径只登记交付项：不提取经验、不晋升、不演化 Persona', async () => {
    const { runner, repository, bufferRepository, delivery } = await fixture();
    const seq = await writePending(
      repository,
      bufferRepository,
      'task_deliver',
      [],
      sampleAgentContext(),
    );

    const evidence = await runner.scheduleBuffer({
      task_id: 'task_deliver',
      run_id: 'run_deliver',
      role_id: ROLE,
      buffer_seq: seq,
    });

    expect(evidence).toMatchObject({
      kind: 'context_delivery',
      status: 'scheduled',
      role_id: ROLE,
      buffer_seq: seq,
      experiences: [],
      skills: [],
    });
    expect(evidence.context_delivery).toMatchObject({
      memory_buffer_ref: `${ROLE}:${String(seq)}`,
      context_snapshot_ref: '1',
    });

    // 记忆一个字都没写；Buffer 也留在 pending 等下游
    await expect(repository.listExperiences(ROLE)).resolves.toEqual([]);
    await expect(repository.listSkills(ROLE)).resolves.toEqual([]);
    await expect(bufferRepository.getBufferMeta(ROLE)).resolves.toMatchObject({
      pending_count: 1,
      total_processed: 0,
    });

    // 交付项本身可查：下游的「有哪些活要干」入口
    const items = await delivery.listContextDeliveries({ role_id: ROLE });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      task_id: 'task_deliver',
      status: 'pending',
      report_ref: `report_${String(seq)}.json`,
      source_driver: 'acp-external',
    });
  });

  it('交付键稳定：重复提交只留一条，且不覆盖下游已推进的状态', async () => {
    const { runner, repository, bufferRepository, delivery } = await fixture();
    const seq = await writePending(repository, bufferRepository, 'task_idem');
    const request = {
      task_id: 'task_idem',
      run_id: 'run_idem',
      role_id: ROLE,
      buffer_seq: seq,
    };

    const first = await runner.scheduleBuffer(request);
    const second = await runner.scheduleBuffer(request);

    expect(second.context_delivery?.delivery_id).toBe(first.context_delivery?.delivery_id);
    expect(second.warnings.join(' ')).toContain('already delivered');
    await expect(delivery.listContextDeliveries({ role_id: ROLE })).resolves.toHaveLength(1);
  });

  it('下游重启/未消费不影响任务：replay 补齐交付项而不是重造 buffer', async () => {
    const { runner, repository, bufferRepository, delivery } = await fixture();
    const seq = await writePending(repository, bufferRepository, 'task_replay');
    await runner.scheduleBuffer({
      task_id: 'task_replay',
      run_id: 'run_replay',
      role_id: ROLE,
      buffer_seq: seq,
    });

    // 新进程起来：同一份存储上重放，交付项不多不少还是那一条
    const restarted = new BMemoryMaintenanceRunner({
      repository,
      bufferRepository,
      deliveryRepository: delivery,
      llm: extractionLlm(),
      evidenceStore: new FileBMemoryMaintenanceEvidenceStore(
        path.join(roots.at(-1)!, 'evidence-2'),
      ),
    });
    const replayed = await restarted.replayPending();

    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ kind: 'context_delivery', status: 'scheduled' });
    await expect(delivery.listContextDeliveries({ role_id: ROLE })).resolves.toHaveLength(1);
    await expect(repository.listExperiences(ROLE)).resolves.toEqual([]);
  });

  it('没有交付存储时不静默：显式 failed evidence 说明配置缺失', async () => {
    const { runner, repository, bufferRepository } = await fixture({ deliveryRepository: undefined });
    const seq = await writePending(repository, bufferRepository, 'task_no_store');

    const evidence = await runner.scheduleBuffer({
      task_id: 'task_no_store',
      run_id: 'run_no_store',
      role_id: ROLE,
      buffer_seq: seq,
    });

    expect(evidence.status).toBe('failed');
    expect(evidence.error).toContain('Memory delivery repository is not configured');
  });

  it('没有 outbox 时 Driver feedback 报错，而不是伪装成「本次没有反馈」', async () => {
    const { runner, repository, bufferRepository } = await fixture({
      deliveryRepository: undefined,
    });
    const seq = await writePending(repository, bufferRepository, 'task_no_outbox');
    const references = [
      {
        experience_id: 'exp_referenced',
        applied: true,
        effectiveness: 'fully_effective' as const,
        note: 'used it',
      },
    ];

    // 有东西要写却写不进去：必须是错误。返回空数组会让调用方以为「Driver 这次没引用经验」
    await expect(
      runner.recordDriverUsageFeedback({
        task_id: 'task_no_outbox',
        run_id: 'run_no_outbox',
        role_id: ROLE,
        buffer_seq: seq,
        references,
      }),
    ).rejects.toThrow(/no MemoryDeliveryRepository/);

    // 没有引用时本来就没有可丢的东西，安静返回空列表
    await expect(
      runner.recordDriverUsageFeedback({
        task_id: 'task_no_outbox',
        run_id: 'run_no_outbox',
        role_id: ROLE,
        buffer_seq: seq,
        references: [],
      }),
    ).resolves.toEqual([]);
  });

  it('经验尚不存在时也保存 Driver feedback，之后可按稳定 id 归并', async () => {
    const { runner, repository, bufferRepository, delivery } = await fixture();
    const references = [
      {
        experience_id: 'exp_not_written_yet',
        applied: true,
        effectiveness: 'fully_effective' as const,
        note: 'used the boundary rule',
      },
    ];
    const seq = await writePending(repository, bufferRepository, 'task_feedback', references);

    const recorded = await runner.recordDriverUsageFeedback({
      task_id: 'task_feedback',
      run_id: 'run_feedback',
      role_id: ROLE,
      buffer_seq: seq,
      references,
    });

    expect(recorded).toHaveLength(1);
    const record = recorded[0]!;
    expect(record).toMatchObject({
      role_id: ROLE,
      task_id: 'task_feedback',
      experience_id: 'exp_not_written_yet',
      applied: true,
      effectiveness: 'fully_effective',
      note: 'used the boundary rule',
      feedback_source: 'driver_usage',
      status: 'pending',
    });
    // 幂等键的五个因子都在键里：下游可以据此判断「这条反馈说的是哪件事」
    expect(record.feedback_key).toBe(
      `${ROLE}:task_feedback:exp_not_written_yet:driver_usage:${record.event_version}`,
    );

    // 经验此刻还不存在，反馈照样在 outbox 里等
    await expect(repository.listExperiences(ROLE)).resolves.toEqual([]);
    const pendingForExperience = await delivery.listDriverFeedback({
      role_id: ROLE,
      experience_id: 'exp_not_written_yet',
    });
    expect(pendingForExperience.map((item) => item.feedback_id)).toEqual([record.feedback_id]);
  });

  it('同一份 DriverReturn 重复提交反馈不会重复累计', async () => {
    const { runner, repository, bufferRepository, delivery } = await fixture();
    const references = [
      { experience_id: 'exp_x', applied: true, effectiveness: 'partially_effective' as const, note: 'a' },
      { experience_id: 'exp_x', applied: true, effectiveness: 'ineffective' as const, note: 'b' },
    ];
    const seq = await writePending(repository, bufferRepository, 'task_feedback_idem', references);
    const request = {
      task_id: 'task_feedback_idem',
      run_id: 'run_feedback_idem',
      role_id: ROLE,
      buffer_seq: seq,
      references,
    };

    const first = await runner.recordDriverUsageFeedback(request);
    const second = await runner.recordDriverUsageFeedback(request);

    // 同一条经验在本次任务里被引用两次 → 收敛成一条
    expect(first).toHaveLength(1);
    expect(second.map((item) => item.feedback_id)).toEqual(first.map((item) => item.feedback_id));
    // 第二次命中幂等键，返回的是第一次那条（effectiveness 没有被后一次覆盖）
    expect(second[0]!.effectiveness).toBe('partially_effective');
    const stored = await delivery.listDriverFeedback({ role_id: ROLE });
    expect(stored).toHaveLength(1);
  });

  it('消融标签改不动路径：进程内模拟只能由构造 runner 时显式打开', async () => {
    const production = await fixture();
    const emulated = await fixture({ mode: 'in_process_emulation' });

    const productionSeq = await writePending(
      production.repository,
      production.bufferRepository,
      'task_production',
    );
    const emulatedSeq = await writePending(
      emulated.repository,
      emulated.bufferRepository,
      'task_emulated',
    );

    // 生产 runner 收到消融标签也照旧只交付。标签是请求方的意图，不是本进程的行为开关——
    // 拿它去切换路径，普通任务流程就能用一个请求字段把提取/晋升拐进来，这条边界也就没了。
    const labelled = await production.runner.scheduleBuffer({
      task_id: 'task_production',
      run_id: 'run_production',
      role_id: ROLE,
      buffer_seq: productionSeq,
      memory_ablation: 'B3',
    });
    expect(labelled.kind).toBe('context_delivery');
    // 也不能静默降级：没有进程内模拟就没有记忆演化，各臂之间没有可比的记忆差，
    // 实验结论事后无从解释。降级这件事本身要留在 evidence 里。
    expect(labelled.warnings.join(' ')).toContain('memory_ablation=B3');
    expect(labelled.warnings.join(' ')).toContain('in-process memory emulation is not enabled');

    // 实验路径也不是 scheduleBuffer 的副作用：即便 runner 打开了进程内模拟，在线任务
    // 入口仍然只登记交付；要跑提取必须像下游系统那样**显式**调 processBuffer。
    await emulated.runner.scheduleBuffer({
      task_id: 'task_emulated',
      run_id: 'run_emulated',
      role_id: ROLE,
      buffer_seq: emulatedSeq,
      memory_ablation: 'B3',
    });
    await emulated.runner.waitForIdle();
    // 只登记交付，没有提取
    await expect(emulated.repository.listExperiences(ROLE)).resolves.toEqual([]);

    await emulated.runner.processBuffer({
      task_id: 'task_emulated',
      run_id: 'run_emulated',
      role_id: ROLE,
      buffer_seq: emulatedSeq,
      memory_ablation: 'B3',
    });
    await emulated.runner.waitForIdle();

    await expect(production.repository.listExperiences(ROLE)).resolves.toEqual([]);
    await expect(emulated.repository.listExperiences(ROLE)).resolves.toHaveLength(1);
    // 实验路径也照样交付：模拟下游不等于不给下游留输入
    await expect(
      emulated.delivery.listContextDeliveries({ role_id: ROLE }),
    ).resolves.toHaveLength(1);
  });

  it('生产 delivery 路径不调用 extractor：LLM 一响就说明走错了路', async () => {
    const extractorCalls: number[] = [];
    const { runner, repository, bufferRepository } = await fixture({
      llm: {
        async complete() {
          throw new Error('delivery path must not call the LLM');
        },
      },
      extractor: {
        async extract() {
          extractorCalls.push(1);
          throw new Error('delivery path must not call the extractor');
        },
      },
    });
    const seq = await writePending(repository, bufferRepository, 'task_no_extract');

    const evidence = await runner.scheduleBuffer({
      task_id: 'task_no_extract',
      run_id: 'run_no_extract',
      role_id: ROLE,
      buffer_seq: seq,
    });
    await runner.waitForIdle();

    expect(evidence).toMatchObject({ kind: 'context_delivery', status: 'scheduled' });
    expect(extractorCalls).toEqual([]);
    // 提取与晋升的产物都为空：没有 Experience，也没有 Skill
    await expect(repository.listExperiences(ROLE)).resolves.toEqual([]);
    await expect(repository.listSkills(ROLE)).resolves.toEqual([]);
    // Buffer 留在 pending 等下游处理，本进程不做归档
    await expect(bufferRepository.getBufferMeta(ROLE)).resolves.toMatchObject({
      pending_count: 1,
      total_processed: 0,
    });
  });

  it('两个 worker 同时处理同一条 Buffer：经验只落一份，双方都不收到冲突异常', async () => {
    // 两个 worker 共用一份「等两边都提取完再放行」的 LLM：不把提取对齐，先跑的那个可能
    // 整条流程都结束了，并发重入根本没发生，这条用例也就白测了
    const llm = extractionLlm(2);
    const first = await fixture({ mode: 'in_process_emulation', llm });
    const seq = await writePending(
      first.repository,
      first.bufferRepository,
      'task_two_workers',
      [],
      sampleAgentContext(),
    );

    // 第二个 worker：**同一个仓库**、独立实例（各自一条 enqueueRole 队列）。两个 Memory
    // Maintenance 进程共享存储时就是这副样子——各自的队列挡不住对方，只能靠稳定 id +
    // 存储层的原子幂等写入收敛。
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-delivery-worker-b-'));
    roots.push(root);
    const second = new BMemoryMaintenanceRunner({
      repository: first.repository,
      bufferRepository: first.bufferRepository,
      deliveryRepository: first.delivery,
      llm,
      mode: 'in_process_emulation',
      evidenceStore: new FileBMemoryMaintenanceEvidenceStore(path.join(root, 'evidence')),
    });

    const request = {
      task_id: 'task_two_workers',
      run_id: 'run_two_workers',
      role_id: ROLE,
      buffer_seq: seq,
    };
    const [left, right] = await Promise.all([
      first.runner.processBuffer(request),
      second.processBuffer(request),
    ]);

    // 交错顺序无所谓（谁先读到 pending、谁先落库都可能），结论必须一样：仓库里只有一份
    expect([left.status, right.status]).toContain('completed');
    const experiences = await first.repository.listExperiences(ROLE);
    expect(experiences).toHaveLength(1);
    // 归属仍由 role_id 定死，计数只加一次（owned_exps 也没有重复项）
    expect(experiences[0]?.agent_id).toBe(ROLE);
    await expect(first.repository.getAgent(ROLE)).resolves.toMatchObject({
      experience_count: 1,
      owned_exps: [experiences[0]?.id],
    });
    await expect(first.repository.getMetrics(ROLE)).resolves.toMatchObject({
      experience_count: 1,
    });
    // 谁都没把别人的成功报成冲突：失败的那一侧只能是因为「Buffer 已经被处理走了」
    for (const evidence of [left, right]) {
      if (evidence.status === 'failed') {
        expect(evidence.error ?? '').not.toMatch(/duplicate|conflict|unique/i);
      }
    }
    // Buffer 只被消费一次
    await expect(first.bufferRepository.listPendingBufferSeqs(ROLE)).resolves.toEqual([]);
    await expect(first.bufferRepository.getBufferMeta(ROLE)).resolves.toMatchObject({
      total_processed: 1,
      total_dead_letters: 0,
    });
  });

  it('生产 runner 直接调 processBuffer：拒绝在本进程提取，如实报 failed', async () => {
    const { runner, repository, bufferRepository } = await fixture();
    const seq = await writePending(repository, bufferRepository, 'task_guard');

    const result = await runner.processBuffer({
      task_id: 'task_guard',
      run_id: 'run_guard',
      role_id: ROLE,
      buffer_seq: seq,
    });

    expect(result).toMatchObject({ kind: 'experience_extraction', status: 'failed' });
    expect(result.error).toContain('in_process_emulation');
    // 拒绝得干脆：一条经验都没写，Buffer 也照旧留在 pending
    await expect(repository.listExperiences(ROLE)).resolves.toEqual([]);
    await expect(bufferRepository.listPendingBufferSeqs(ROLE)).resolves.toEqual([seq]);
  });

  it('任务结束时把 Driver 的使用反馈写进 outbox —— 引用的经验还不存在也照收', async () => {
    const { runner, repository, bufferRepository, delivery } = await fixture();
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'newide-delivery-ws-'));
    roots.push(workspace);
    const taskId = 'task_facade_feedback';
    // 驱动侧报告文件是 DriverReturn 的一手来源；用它把「引用了哪条经验」喂进链路
    await writeFile(
      path.join(workspace, `${taskId}_report.txt`),
      JSON.stringify({
        summary: 'Applied a remembered rule while implementing the change.',
        artifacts: [],
        decisions: [],
        blockers: [],
        referenced_experiences: [
          {
            experience_id: 'exp_from_earlier_task',
            applied: true,
            effectiveness: 'fully_effective',
            note: 'saved a round of rework',
          },
        ],
        assumptions: [],
      }),
      'utf8',
    );
    const facade = new DriverRuntimeAgentExecutionFacade({
      driver: stubDriver(),
      repository,
      bufferRepository,
      llm: invokeDriverOnceLlm(),
      memoryMaintenance: runner,
      deliveryRepository: delivery,
    });

    const result = await facade.runAgent({
      task_id: taskId,
      run_id: `run_${taskId}`,
      role_id: ROLE,
      instruction: 'Implement the change.',
      workspace_path: workspace,
      session_id: 'session_delivery',
      input_artifact_refs: [],
      context_policy: 'default',
      schema_version: SCHEMA_VERSION,
    });

    expect(result.status).toBe('completed');
    expect(result.diagnostics.driver_feedback_recorded).toBe(1);

    // 反馈进的是 outbox，不是被回写到经验上：那条经验压根不存在
    await expect(repository.listExperiences(ROLE)).resolves.toEqual([]);
    const records = await delivery.listDriverFeedback({ role_id: ROLE });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      task_id: taskId,
      experience_id: 'exp_from_earlier_task',
      applied: true,
      effectiveness: 'fully_effective',
      feedback_source: 'driver_usage',
      status: 'pending',
    });
  });

  it('生产任务路径装上抛错的 extractor/LLM/晋升配置也不会被调用', async () => {
    const calls: string[] = [];
    const { runner, repository, bufferRepository, delivery } = await fixture({
      // 下游模拟器用到的三样东西全部换成「一碰就抛」：生产路径只要碰到其中任何一个就会炸
      extractor: {
        async extract() {
          calls.push('extract');
          throw new Error('production task flow must not extract');
        },
      },
      llm: {
        async complete() {
          calls.push('llm');
          throw new Error('production task flow must not call the maintenance LLM');
        },
      },
      promotion: { confidenceThreshold: 0.1, autoApprove: true },
    });
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'newide-delivery-decouple-'));
    roots.push(workspace);
    const taskId = 'task_decoupled_flow';
    await writeFile(
      path.join(workspace, `${taskId}_report.txt`),
      JSON.stringify({
        summary: 'Completed without touching memory evolution.',
        artifacts: [],
        decisions: [],
        blockers: [],
        referenced_experiences: [],
        assumptions: [],
      }),
      'utf8',
    );
    const facade = new DriverRuntimeAgentExecutionFacade({
      driver: stubDriver(),
      repository,
      bufferRepository,
      llm: invokeDriverOnceLlm(),
      memoryMaintenance: runner,
      deliveryRepository: delivery,
    });

    // B2 是「标签曾经会开启进程内晋升」的那一臂：现在标签改不动任何东西
    const result = await facade.runAgent({
      task_id: taskId,
      run_id: `run_${taskId}`,
      role_id: ROLE,
      instruction: 'Implement the change.',
      workspace_path: workspace,
      session_id: 'session_decoupled',
      input_artifact_refs: [],
      context_policy: 'default',
      memory_ablation: 'B2',
      schema_version: SCHEMA_VERSION,
    });

    await runner.waitForIdle();
    expect(result.status).toBe('completed');
    expect(result.diagnostics.memory_maintenance).toMatchObject({
      kind: 'context_delivery',
      status: 'scheduled',
    });
    // 一次都没碰到：没有提取、没有 LLM、没有晋升
    expect(calls).toEqual([]);
    await expect(repository.listExperiences(ROLE)).resolves.toEqual([]);
    await expect(repository.listSkills(ROLE)).resolves.toEqual([]);
    // Buffer 留在 pending 等下游 ack；下游要的输入已经登记好
    await expect(bufferRepository.getBufferMeta(ROLE)).resolves.toMatchObject({
      pending_count: 1,
      total_processed: 0,
    });
    await expect(delivery.listContextDeliveries({ role_id: ROLE })).resolves.toHaveLength(1);
  });

  /**
   * 消融标签是**给定实验臂**的标记，不是本进程的行为开关。B0–B4 五臂走的是同一条生产边界：
   * 登记一条交付项、不写记忆、Buffer 留在 pending。
   */
  it('B0–B4 标签本身不改变生产 runner 的处理边界', async () => {
    for (const ablation of ['B0', 'B1', 'B2', 'B3', 'B4'] as const) {
      const { runner, repository, bufferRepository, delivery } = await fixture();
      const seq = await writePending(repository, bufferRepository, `task_${ablation}`);

      const evidence = await runner.scheduleBuffer({
        task_id: `task_${ablation}`,
        run_id: `run_${ablation}`,
        role_id: ROLE,
        buffer_seq: seq,
        memory_ablation: ablation,
      });

      expect(evidence).toMatchObject({ kind: 'context_delivery', status: 'scheduled' });
      await expect(delivery.listContextDeliveries({ role_id: ROLE })).resolves.toHaveLength(1);
      await expect(repository.listExperiences(ROLE)).resolves.toEqual([]);
      await expect(repository.listSkills(ROLE)).resolves.toEqual([]);
      await expect(bufferRepository.getBufferMeta(ROLE)).resolves.toMatchObject({
        pending_count: 1,
        total_processed: 0,
      });
    }
  });
});

// ──────────────────────────────────────────────
// 最小驱动替身：够跑通一次「Agent → invoke_driver → Buffer」即可
// ──────────────────────────────────────────────

function stubDriver(): DriverRuntimeHandle {
  const capabilities: DriverCapabilities = {
    supports_acp_extension: false,
    supports_structured_output: true,
    supports_session_load: false,
    supports_tool_events: false,
    supports_permission_events: false,
  };
  const transcript: ArtifactRef = {
    artifact_id: 'artifact_delivery_transcript',
    type: 'transcript',
    uri: 'artifact://transcript/delivery',
    producer_id: 'stub-driver',
    created_at: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
  };
  return {
    driver_id: 'stub-driver',
    session_id: 'session_stub',
    capabilities,
    async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
      return {
        driver_run_result_id: 'driver_result_delivery',
        session_id: input.session_id,
        status: 'succeeded',
        response: 'Stub driver completed the change.',
        artifacts: [],
        transcript_ref: transcript,
        tool_events: [],
        diagnostics: { driver_id: 'stub-driver', duration_ms: 1, notes: [] },
        created_at: new Date().toISOString(),
        schema_version: SCHEMA_VERSION,
      };
    },
    subscribeToEvents(_listener: DriverStreamEventListener): () => void {
      return () => undefined;
    },
    async interrupt(): Promise<void> {},
    async collectTranscript(): Promise<ArtifactRef> {
      return transcript;
    },
  };
}

/** 顶层 Agent：第一轮派给 driver，第二轮报完成 */
function invokeDriverOnceLlm(): ToolCallingClient {
  return {
    async completeWithTools(input) {
      const lastMessage = input.messages.at(-1);
      if (lastMessage?.role === 'tool') {
        return { content: 'Task completed. [done]', tool_calls: undefined };
      }
      return {
        content: null,
        tool_calls: [
          {
            id: 'delivery_tool_call_1',
            type: 'function',
            function: { name: 'invoke_driver', arguments: '{"instruction":"Do the work"}' },
          },
        ],
      };
    },
  };
}
