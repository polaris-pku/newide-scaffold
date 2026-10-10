import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BMemoryMaintenanceRunner,
  FileBMemoryMaintenanceEvidenceStore,
  type BMemoryMaintenanceEvidenceStore,
  type BMemoryMaintenanceMode,
} from '../../src/app/b-memory-maintenance-runner';
import {
  FileBufferRepository,
  FileMemoryDeliveryRepository,
  InMemoryBufferRepository,
  InMemoryMemoryDeliveryRepository,
  InMemoryRepository,
  createAgentMemoryScope,
  type CallJournalEvent,
  type CallJournalPort,
  type ExperienceExtractor,
  type LlmClient,
} from '../../src/memory';
import type { AgentContextSnapshot, BufferSnapshot } from '../../src/memory/schemas';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('BMemoryMaintenanceRunner', () => {
  it('extracts, persists, and exposes Experience evidence from a pending B Buffer', async () => {
    const { runner, repository, bufferRepository, evidenceStore } = await fixture();
    const seq = await writePending(repository, bufferRepository, 'role_ts_engineer', 'task_001');

    const result = await runner.processBuffer({
      task_id: 'task_001',
      run_id: 'run_001',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
    });

    expect(result).toMatchObject({
      kind: 'experience_extraction',
      status: 'completed',
      role_id: 'role_ts_engineer',
      buffer_seq: 1,
      experiences: [
        expect.objectContaining({
          description: 'Persist app composition boundaries',
          source_task_id: 'task_001',
        }),
      ],
      skills: [],
      evidence_uri: expect.stringMatching(/^file:/),
    });
    await expect(repository.listExperiences('role_ts_engineer')).resolves.toHaveLength(1);
    await expect(bufferRepository.getBufferMeta('role_ts_engineer')).resolves.toMatchObject({
      pending_count: 0,
      total_processed: 1,
    });
    await expect(evidenceStore.get(result.maintenance_ref)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  describe('CallJournalPort 留档（B1）', () => {
    function createStubPort(): CallJournalPort & { events: CallJournalEvent[] } {
      const events: CallJournalEvent[] = [];
      return { events, record: (event) => void events.push(event) };
    }

    it('processBuffer 成功 → 1 条 extract 事件，含 task/run/role/workspace', async () => {
      const port = createStubPort();
      const { runner, repository, bufferRepository } = await fixture(
        maintenanceLlm(),
        undefined,
        undefined,
        { callJournal: port },
      );
      const seq = await writePending(repository, bufferRepository, 'role_ts_engineer', 'task_j1');

      await runner.processBuffer({
        task_id: 'task_j1',
        run_id: 'run_j1',
        role_id: 'role_ts_engineer',
        buffer_seq: seq,
        workspace_path: '/ws/proj',
      });

      expect(port.events).toHaveLength(1);
      expect(port.events[0]).toMatchObject({
        event: 'extract',
        status: 'ok',
        task_id: 'task_j1',
        run_id: 'run_j1',
        role_id: 'role_ts_engineer',
        workspace_path: '/ws/proj',
      });
      expect(port.events[0].call_id).toContain('extract:role_ts_engineer:');
      expect(port.events[0].duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('failingExtractor → 记 error 事件，evidence failed 行为不变', async () => {
      const port = createStubPort();
      const { runner, repository, bufferRepository } = await fixture(
        maintenanceLlm(),
        undefined,
        failingExtractor(),
        { callJournal: port },
      );
      const seq = await writePending(repository, bufferRepository, 'role_ts_engineer', 'task_j2');

      const result = await runner.processBuffer({
        task_id: 'task_j2',
        run_id: 'run_j2',
        role_id: 'role_ts_engineer',
        buffer_seq: seq,
      });

      expect(result.status).toBe('failed');
      expect(port.events).toHaveLength(1);
      expect(port.events[0]).toMatchObject({
        event: 'extract', status: 'error', task_id: 'task_j2', run_id: 'run_j2',
      });
      expect(port.events[0].summary).toContain('LLM provider unavailable');
    });

    it('不注入 port → 正常完成且无事件', async () => {
      const { runner, repository, bufferRepository } = await fixture();
      const seq = await writePending(repository, bufferRepository, 'role_ts_engineer', 'task_j3');

      const result = await runner.processBuffer({
        task_id: 'task_j3',
        run_id: 'run_j3',
        role_id: 'role_ts_engineer',
        buffer_seq: seq,
      });

      expect(result.status).toBe('completed');
    });
  });

  it('writes back usage feedback: referenced Experience confidence grows from driver effectiveness', async () => {
    const { runner, repository, bufferRepository, evidenceStore } = await fixture();
    // 预存一条经验，供后续任务在 DriverReturn.referenced_experiences 中引用
    const now = new Date().toISOString();
    const referenced = {
      id: '00000000-0000-0000-0000-00000000feed',
      description: 'Reusable normalization pattern',
      description_embedding: [],
      content: 'Trim/lowercase then collapse separators into a single hyphen.',
      confidence: 0.7,
      tags: ['typescript'],
      agent_id: 'role_ts_engineer',
      confidence_history: [{ value: 0.7, updated_at: now, reason: 'seed' }],
      referenced_count: 0,
      source_task_id: 'task_seed',
      source_driver: 'test-driver',
      type: 'positive',
      created_at: now,
      updated_at: now,
    };
    await repository.saveExperience('role_ts_engineer', referenced);

    const seq = await writePending(
      repository,
      bufferRepository,
      'role_ts_engineer',
      'task_usage',
      [
        {
          experience_id: referenced.id,
          applied: true,
          effectiveness: 'fully_effective',
          note: 'normalization pattern worked',
        },
      ],
    );

    const result = await runner.processBuffer({
      task_id: 'task_usage',
      run_id: 'run_usage',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
    });

    expect(result.status).toBe('completed');
    expect(result.warnings.join(' ')).toContain(
      'Usage feedback applied to 1 referenced experience(s)',
    );
    // 磁盘 evidence JSON 中间产物：带逐条置信度增长明细
    expect(result.usage_feedback).toEqual([
      {
        experience_id: referenced.id,
        description: 'Reusable normalization pattern',
        effectiveness: 'fully_effective',
        from_confidence: 0.7,
        to_confidence: 0.8,
        referenced_count: 1,
      },
    ]);
    // 从磁盘重新读取落盘的 evidence 文件，确认产物确实存在且内容一致
    const persisted = await evidenceStore.get(result.maintenance_ref);
    expect(persisted?.usage_feedback).toEqual(result.usage_feedback);
    expect(persisted?.evidence_uri).toMatch(/^file:/);
    const experiences = await repository.listExperiences('role_ts_engineer');
    const updated = experiences.find((experience) => experience.id === referenced.id)!;
    expect(updated.confidence).toBeCloseTo(0.8);
    expect(updated.referenced_count).toBe(1);
    expect(updated.confidence_history.at(-1)).toMatchObject({
      reason: 'usage_validation:fully_effective',
    });
  });

  /**
   * 启动重放（replayPending）只做一件事：为每条 pending Buffer 补交一次上下文交付。
   *
   * 它跑在 readiness 路径上，属于维护入口而不是加工入口——本进程不提取。记忆演化由下游
   * （实验里由本进程模拟）在**显式调用** processBuffer 时才发生。
   */
  it('replays durable pending Buffers after application restart as context deliveries', async () => {
    const { runner, repository, bufferRepository, evidenceStore, deliveryRepository } =
      await fixture();
    const seq = await writePending(repository, bufferRepository, 'role_ts_engineer', 'task_replay');

    const results = await runner.replayPending();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      task_id: 'task_replay',
      kind: 'context_delivery',
      status: 'scheduled',
    });
    await expect(evidenceStore.get(results[0]!.maintenance_ref)).resolves.toMatchObject({
      task_id: 'task_replay',
      kind: 'context_delivery',
      status: 'scheduled',
    });
    // 重放不消费：交付项登记好了，Buffer 仍在 pending 等下游，本进程一条经验都没写
    await expect(
      deliveryRepository.listContextDeliveries({ role_id: 'role_ts_engineer' }),
    ).resolves.toHaveLength(1);
    await expect(repository.listExperiences('role_ts_engineer')).resolves.toEqual([]);
    await expect(bufferRepository.listPendingBufferSeqs('role_ts_engineer')).resolves.toEqual([seq]);

    // 下游（实验脚手架）显式消费这条交付 —— 提取只在这里发生
    const processed = await runner.processBuffer({
      task_id: 'task_replay',
      run_id: 'run_replay',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
    });
    await runner.waitForIdle();

    expect(processed).toMatchObject({ kind: 'experience_extraction', status: 'completed' });
    await expect(repository.listExperiences('role_ts_engineer')).resolves.toHaveLength(1);
    await expect(bufferRepository.getBufferMeta('role_ts_engineer')).resolves.toMatchObject({
      pending_count: 0,
      total_processed: 1,
    });
  });

  /**
   * 启动重放跑在 readiness 路径上（backend-rpc-stdio 把它的异常当后端起不来的理由），
   * 所以一条读不出来的 pending 报告必须只影响它自己：别的 Agent、别的 Buffer 照常补齐
   * 交付，故障本身以一条 failed evidence 的形式留在重放结果里等人去修。
   */
  describe('启动重放对损坏 Buffer 的隔离', () => {
    it('一条坏记录不阻断其余重放，且原因可查', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'newide-b-replay-'));
      roots.push(root);
      const agentStateRoot = path.join(root, 'agent-state');
      const repository = new InMemoryRepository();
      const bufferRepository = new FileBufferRepository({ agentStateRoot });
      const deliveryRepository = new FileMemoryDeliveryRepository({ agentStateRoot });
      for (const roleId of ['role_broken', 'role_healthy']) {
        await repository.initializeAgent({ role_id: roleId, name: roleId });
        await bufferRepository.ensureAgent(roleId);
        await deliveryRepository.ensureAgent(roleId);
      }
      await bufferRepository.saveBufferSnapshot('role_broken', snapshotFor('task_broken'));
      await bufferRepository.saveBufferSnapshot('role_healthy', snapshotFor('task_healthy'));
      await writeFile(
        path.join(agentStateRoot, 'role_broken', 'buffer', 'pending', 'report_1.json'),
        '{ this is not json',
        'utf8',
      );

      const runner = new BMemoryMaintenanceRunner({
        repository,
        bufferRepository,
        deliveryRepository,
        // 生产路径不提取：走到提取就等于走错了路
        llm: {
          async complete() {
            throw new Error('delivery path must not call the extractor');
          },
        },
        evidenceStore: new FileBMemoryMaintenanceEvidenceStore(path.join(root, 'evidence')),
        mode: 'delivery',
      });

      const results = await runner.replayPending();

      expect(results).toHaveLength(2);
      const failed = results.find((entry) => entry.role_id === 'role_broken');
      expect(failed).toMatchObject({
        kind: 'context_delivery',
        status: 'failed',
        role_id: 'role_broken',
        buffer_seq: 1,
      });
      expect(failed?.error).toContain('Unreadable buffer report');
      // 诊断要落到证据存储里，供运维事后查，而不是只在这次调用里闪过
      await expect(
        new FileBMemoryMaintenanceEvidenceStore(path.join(root, 'evidence')).get(
          failed!.maintenance_ref,
        ),
      ).resolves.toMatchObject({ status: 'failed' });

      const healthy = results.find((entry) => entry.role_id === 'role_healthy');
      expect(healthy).toMatchObject({ status: 'scheduled', task_id: 'task_healthy' });
      await expect(
        deliveryRepository.listContextDeliveries({ role_id: 'role_healthy' }),
      ).resolves.toHaveLength(1);
      // 坏的那条没有被当成「已交付」悄悄放过
      await expect(
        deliveryRepository.listContextDeliveries({ role_id: 'role_broken' }),
      ).resolves.toHaveLength(0);
    });

    /**
     * 声明了 context_snapshot_ref、上下文文件却读不出来：这条记录是坏的，不是「本次没有
     * 上下文」。它必须和坏报告一样被隔离——单独记一条失败、跳过它，别的 Agent 与 Buffer
     * 照常重放。降级成「没有上下文」就等于把半份输入交给下游。
     */
    it('声明了引用却读不出上下文：只记这一条失败，其他 Agent/Buffer 照常重放', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'newide-b-replay-context-'));
      roots.push(root);
      const agentStateRoot = path.join(root, 'agent-state');
      const repository = new InMemoryRepository();
      const bufferRepository = new FileBufferRepository({ agentStateRoot });
      const deliveryRepository = new FileMemoryDeliveryRepository({ agentStateRoot });
      for (const roleId of ['role_broken_context', 'role_healthy']) {
        await repository.initializeAgent({ role_id: roleId, name: roleId });
        await bufferRepository.ensureAgent(roleId);
        await deliveryRepository.ensureAgent(roleId);
      }
      // 报告完好，且声明了 context_snapshot_ref=1；配对的 context 文件却是坏的
      await bufferRepository.saveBufferSnapshot('role_broken_context', {
        ...snapshotFor('task_broken_context'),
        context_snapshot_ref: '1',
      });
      await writeFile(
        path.join(agentStateRoot, 'role_broken_context', 'buffer', 'pending', 'context_1.json'),
        '{ not json',
        'utf8',
      );
      await bufferRepository.saveBufferSnapshot('role_healthy', snapshotFor('task_healthy'));

      const runner = new BMemoryMaintenanceRunner({
        repository,
        bufferRepository,
        deliveryRepository,
        // 生产路径不提取：走到提取就等于走错了路
        llm: {
          async complete() {
            throw new Error('delivery path must not call the extractor');
          },
        },
        evidenceStore: new FileBMemoryMaintenanceEvidenceStore(path.join(root, 'evidence')),
        mode: 'delivery',
      });

      const results = await runner.replayPending();

      expect(results).toHaveLength(2);
      const failed = results.find((entry) => entry.role_id === 'role_broken_context');
      expect(failed).toMatchObject({
        kind: 'context_delivery',
        status: 'failed',
        role_id: 'role_broken_context',
        buffer_seq: 1,
      });
      expect(failed?.error).toMatch(/context_1\.json/);
      // 没有把这条当成正常 Buffer 登记成交付（否则下游会拿到半份输入）
      await expect(
        deliveryRepository.listContextDeliveries({ role_id: 'role_broken_context' }),
      ).resolves.toHaveLength(0);

      const healthy = results.find((entry) => entry.role_id === 'role_healthy');
      expect(healthy).toMatchObject({ status: 'scheduled', task_id: 'task_healthy' });
      await expect(
        deliveryRepository.listContextDeliveries({ role_id: 'role_healthy' }),
      ).resolves.toHaveLength(1);
    });
  });

  it('single-flights concurrent scheduling for the same durable Buffer', async () => {
    const { runner, repository, bufferRepository, evidenceStore, deliveryRepository } =
      await fixture();
    const seq = await writePending(
      repository,
      bufferRepository,
      'role_ts_engineer',
      'task_concurrent',
    );
    const save = vi.spyOn(evidenceStore, 'save');
    const request = {
      task_id: 'task_concurrent',
      run_id: 'run_concurrent',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
    };

    const scheduled = await Promise.all(
      Array.from({ length: 8 }, () => runner.scheduleBuffer(request)),
    );
    await runner.waitForIdle();

    // 8 次并发调度收敛成一条 evidence、一条交付项、一条 experience_extraction 证据——没有
    // 重复登记，也没有顺带提取（scheduleBuffer 只登记交付）。
    expect(new Set(scheduled.map((item) => item.maintenance_ref)).size).toBe(1);
    expect(scheduled.every((item) => item.kind === 'context_delivery')).toBe(true);
    expect(save.mock.calls.filter(([item]) => item.status === 'scheduled')).toHaveLength(1);
    await expect(
      deliveryRepository.listContextDeliveries({ role_id: 'role_ts_engineer' }),
    ).resolves.toHaveLength(1);
    await expect(repository.listExperiences('role_ts_engineer')).resolves.toEqual([]);
    await expect(evidenceStore.get(scheduled[0]!.maintenance_ref)).resolves.toMatchObject({
      kind: 'context_delivery',
      status: 'scheduled',
    });
  });

  /**
   * 证据是这次加工的对外账本：写不进去就必须如实失败，不能回一个「已登记」的空壳。
   * scheduleBuffer 与 processBuffer 两条入口都直接拒绝，调用方拿到的失败与真实状态一致。
   */
  it('证据存储写不进去时如实拒绝，不假装已登记', async () => {
    const failingStore: BMemoryMaintenanceEvidenceStore = {
      async save() {
        throw new Error('maintenance store write failed');
      },
      async get() {
        return undefined;
      },
      async list() {
        return [];
      },
    };
    const { runner, repository, bufferRepository } = await fixture(
      maintenanceLlm(),
      failingStore,
    );
    const seq = await writePending(repository, bufferRepository, 'role_ts_engineer', 'task_failed');

    await expect(
      runner.scheduleBuffer({
        task_id: 'task_failed',
        run_id: 'run_failed',
        role_id: 'role_ts_engineer',
        buffer_seq: seq,
      }),
    ).rejects.toThrow('maintenance store write failed');

    await expect(
      runner.processBuffer({
        task_id: 'task_failed',
        run_id: 'run_failed',
        role_id: 'role_ts_engineer',
        buffer_seq: seq,
      }),
    ).rejects.toThrow('maintenance store write failed');
    await expect(runner.waitForIdle()).resolves.toBeUndefined();
  });

  it('promotes eligible Experience into an inspectable pending Skill', async () => {
    const { runner, repository, bufferRepository } = await fixture();
    const seq = await writePending(repository, bufferRepository, 'role_ts_engineer', 'task_skill');
    await runner.processBuffer({
      task_id: 'task_skill',
      run_id: 'run_skill',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
    });

    const result = await runner.promoteSkills({
      role_id: 'role_ts_engineer',
      requested_by: 'user',
    });

    expect(result).toMatchObject({
      kind: 'skill_promotion',
      status: 'completed',
      skills: [expect.objectContaining({ review_status: 'pending' })],
    });
    await expect(repository.listSkills('role_ts_engineer')).resolves.toMatchObject([
      { review_status: 'pending', agent_id: 'role_ts_engineer' },
    ]);
  });

  it('auto-approves promoted Skills via promotion.autoApprove (automated evaluation)', async () => {
    const { runner, repository, bufferRepository } = await fixture(maintenanceLlm(), undefined, undefined, {
      promotion: { autoApprove: true },
    });
    const seq = await writePending(repository, bufferRepository, 'role_ts_engineer', 'task_auto');
    await runner.processBuffer({
      task_id: 'task_auto',
      run_id: 'run_auto',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
    });

    const result = await runner.promoteSkills({
      role_id: 'role_ts_engineer',
      requested_by: 'user',
    });

    expect(result).toMatchObject({
      kind: 'skill_promotion',
      status: 'completed',
      skills: [expect.objectContaining({ review_status: 'approved' })],
    });
    await expect(repository.listSkills('role_ts_engineer')).resolves.toMatchObject([
      { review_status: 'approved' },
    ]);
  });

  it('promotes below-default-confidence Experience when promotion.confidenceThreshold is lowered', async () => {
    const { runner, repository, bufferRepository } = await fixture(
      confidenceLlm(0.6),
      undefined,
      undefined,
      { promotion: { confidenceThreshold: 0.5 } },
    );
    const seq = await writePending(
      repository,
      bufferRepository,
      'role_ts_engineer',
      'task_threshold_low',
    );
    await runner.processBuffer({
      task_id: 'task_threshold_low',
      run_id: 'run_threshold_low',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
    });

    const result = await runner.promoteSkills({
      role_id: 'role_ts_engineer',
      requested_by: 'user',
    });

    expect(result.status).toBe('completed');
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({ review_status: 'pending' });
    await expect(repository.listSkills('role_ts_engineer')).resolves.toHaveLength(1);
  });

  it('keeps the default 0.95 gate: confidence 0.6 Experience is not promoted', async () => {
    const { runner, repository, bufferRepository } = await fixture(confidenceLlm(0.6));
    const seq = await writePending(
      repository,
      bufferRepository,
      'role_ts_engineer',
      'task_threshold_default',
    );
    await runner.processBuffer({
      task_id: 'task_threshold_default',
      run_id: 'run_threshold_default',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
    });

    const result = await runner.promoteSkills({
      role_id: 'role_ts_engineer',
      requested_by: 'user',
    });

    expect(result.status).toBe('completed');
    expect(result.skills).toEqual([]);
    await expect(repository.listSkills('role_ts_engineer')).resolves.toEqual([]);
  });

  it('auto-approves Skills when processing Buffer under ablation B2', async () => {
    const { runner, repository, bufferRepository } = await fixture();
    const seq = await writePending(repository, bufferRepository, 'role_ts_engineer', 'task_b2');

    const result = await runner.processBuffer({
      task_id: 'task_b2',
      run_id: 'run_b2',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
      memory_ablation: 'B2',
    });

    expect(result.status).toBe('completed');
    expect(result.skills).toEqual([
      expect.objectContaining({ review_status: 'approved' }),
    ]);
    await expect(repository.listSkills('role_ts_engineer')).resolves.toMatchObject([
      { review_status: 'approved' },
    ]);
  });

  it('does not promote Skills when processing Buffer under ablation B1', async () => {
    const { runner, repository, bufferRepository } = await fixture();
    const seq = await writePending(repository, bufferRepository, 'role_ts_engineer', 'task_b1');

    const result = await runner.processBuffer({
      task_id: 'task_b1',
      run_id: 'run_b1',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
      memory_ablation: 'B1',
    });

    expect(result.status).toBe('completed');
    expect(result.skills).toEqual([]);
    await expect(repository.listSkills('role_ts_engineer')).resolves.toEqual([]);
    await expect(repository.listExperiences('role_ts_engineer')).resolves.toHaveLength(1);
  });

  it('waits for an in-flight explicit Skill promotion role operation', async () => {
    let calls = 0;
    let markPromotionStarted!: () => void;
    const promotionStarted = new Promise<void>((resolve) => {
      markPromotionStarted = resolve;
    });
    let releasePromotion!: (value: string) => void;
    const promotionResult = new Promise<string>((resolve) => {
      releasePromotion = resolve;
    });
    const { runner, repository, bufferRepository } = await fixture({
      async complete() {
        calls += 1;
        if (calls === 1) return experienceExtractionResponse();
        markPromotionStarted();
        return promotionResult;
      },
    });
    const seq = await writePending(
      repository,
      bufferRepository,
      'role_ts_engineer',
      'task_promotion_barrier',
    );
    await runner.processBuffer({
      task_id: 'task_promotion_barrier',
      run_id: 'run_promotion_barrier',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
    });

    const promotion = runner.promoteSkills({
      role_id: 'role_ts_engineer',
      requested_by: 'user',
    });
    await promotionStarted;
    let idleResolved = false;
    const idle = runner.waitForIdle().then(() => {
      idleResolved = true;
    });
    await Promise.resolve();
    expect(idleResolved).toBe(false);

    releasePromotion(
      JSON.stringify({
        description: 'Keep B behind public ports',
        content: 'Compose B dependencies in the application layer.',
        tags: ['architecture'],
      }),
    );
    await expect(promotion).resolves.toMatchObject({
      status: 'completed',
      skills: [expect.objectContaining({ review_status: 'pending' })],
    });
    await idle;
    expect(idleResolved).toBe(true);
  });

  it('automatically dead-letters the buffer with the failure reason when extraction fails', async () => {
    const { runner, repository, bufferRepository, evidenceStore } = await fixture(
      maintenanceLlm(),
      undefined,
      failingExtractor(),
    );
    const seq = await writePending(repository, bufferRepository, 'role_ts_engineer', 'task_fail');

    const result = await runner.processBuffer({
      task_id: 'task_fail',
      run_id: 'run_fail',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
    });

    expect(result).toMatchObject({
      kind: 'experience_extraction',
      status: 'failed',
      error: 'LLM provider unavailable',
      buffer_seq: seq,
    });
    // 自动死信闭环：buffer 移入死信并记录失败原因
    expect(await bufferRepository.listDeadLetterSeqs('role_ts_engineer')).toEqual([seq]);
    expect(await bufferRepository.listPendingBufferSeqs('role_ts_engineer')).toEqual([]);
    const entries = await bufferRepository.listDeadLetterEntries('role_ts_engineer');
    expect(entries[0]).toMatchObject({
      seq,
      task_id: 'task_fail',
      reason: 'LLM provider unavailable',
    });
    // evidence 仍持久化为 failed
    await expect(evidenceStore.get(result.maintenance_ref)).resolves.toMatchObject({
      status: 'failed',
      error: 'LLM provider unavailable',
    });
  });

  it('returns failed evidence even when auto dead-lettering itself fails', async () => {
    const { runner, repository, bufferRepository } = await fixture(
      maintenanceLlm(),
      undefined,
      failingExtractor(),
    );
    const seq = await writePending(repository, bufferRepository, 'role_ts_engineer', 'task_lock');
    const markSpy = vi
      .spyOn(bufferRepository, 'markBufferDeadLetter')
      .mockRejectedValue(new Error('store locked'));

    const result = await runner.processBuffer({
      task_id: 'task_lock',
      run_id: 'run_lock',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
    });

    expect(result).toMatchObject({ status: 'failed', error: 'LLM provider unavailable' });
    expect(markSpy).toHaveBeenCalledWith('role_ts_engineer', seq, 'LLM provider unavailable');
    // 置死信失败不应影响 failed evidence 返回
    expect(await bufferRepository.listDeadLetterSeqs('role_ts_engineer')).toEqual([]);
  });

  it('归档失败 → 死信 → 恢复重试：已写入的 Experience 不被重复写', async () => {
    // 每次调用都给新随机 id 的提取器：正是「重试会重写一遍」的那种形状
    const { runner, repository, bufferRepository } = await fixture(
      maintenanceLlm(),
      undefined,
      deterministicExtractor(2),
    );
    const seq = await writePending(repository, bufferRepository, 'role_ts_engineer', 'task_idem');

    // 提取与落库都成功，只有归档那一步失败 —— 报告还留在 pending，runner 据此把它打成分信
    const archiveSpy = vi
      .spyOn(bufferRepository, 'markBufferProcessed')
      .mockRejectedValueOnce(new Error('archive unavailable'));

    const failed = await runner.processBuffer({
      task_id: 'task_idem',
      run_id: 'run_idem',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
    });

    expect(failed).toMatchObject({ status: 'failed', error: 'archive unavailable' });
    expect(archiveSpy).toHaveBeenCalledTimes(1);
    archiveSpy.mockRestore();
    // 两条经验已经写进去了，Buffer 进了死信：这是个「写了一半」的现场
    await expect(repository.listExperiences('role_ts_engineer')).resolves.toHaveLength(2);
    await expect(bufferRepository.listDeadLetterSeqs('role_ts_engineer')).resolves.toEqual([seq]);

    // 人工恢复死信后重跑：稳定身份让同一批提取结果撞回同样的 id，不会翻倍
    await bufferRepository.restoreDeadLetter('role_ts_engineer', seq);
    const retried = await runner.processBuffer({
      task_id: 'task_idem',
      run_id: 'run_idem',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
    });

    expect(retried).toMatchObject({ status: 'completed', buffer_seq: seq });
    const experiences = await repository.listExperiences('role_ts_engineer');
    expect(experiences).toHaveLength(2);
    expect(new Set(experiences.map((item) => item.id)).size).toBe(2);
    await expect(bufferRepository.listPendingBufferSeqs('role_ts_engineer')).resolves.toEqual([]);
  });

  it('没有上下文快照的 Buffer：提取出的 Experience 归属当前 Agent，source_task_id 留作溯源', async () => {
    const { runner, repository, bufferRepository } = await fixture(
      maintenanceLlm(),
      undefined,
      // source_task_id 与 Buffer 所属 Agent 无关，正是「拿溯源字段当归属」会留下的形状
      deterministicExtractor(1, 'task_owner'),
    );
    const seq = await writePending(repository, bufferRepository, 'role_ts_engineer', 'task_owner');

    await runner.processBuffer({
      task_id: 'task_owner',
      run_id: 'run_owner',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
    });

    const experiences = await repository.listExperiences('role_ts_engineer');
    expect(experiences).toHaveLength(1);
    // 归属只能是 Buffer 所属的 role_id —— 不是空串，也不是 source_task_id
    expect(experiences[0]!.agent_id).toBe('role_ts_engineer');
    expect(experiences[0]!.agent_id).not.toBe('');
    expect(experiences[0]!.source_task_id).toBe('task_owner');
    expect(experiences[0]!.agent_id).not.toBe(experiences[0]!.source_task_id);
  });

  it('keeps council driver-stream usage when refreshing summary after extraction', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'newide-b-maint-runs-'));
    roots.push(runsRoot);
    const runDir = path.join(runsRoot, 'run_token_refresh');
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, 'summary.json'),
      `${JSON.stringify({
        run_id: 'run_token_refresh',
        task_id: 'task_token_refresh',
        session_id: 'session_primary',
        worktree_path: '/tmp/worktree',
        token_usage: {
          schema_version: 'newide.token_usage.v1',
          source: 'proxy',
          input_tokens: 12,
          output_tokens: 3,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          total_input_tokens: 12,
          total_tokens: 15,
          call_count: 1,
          sources: ['proxy'],
          by_source: {},
        },
      }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(runDir, 'driver-stream.jsonl'),
      `${JSON.stringify({
        task_id: 'task_token_refresh',
        recorded_at: '2026-08-14T00:00:00Z',
        event: {
          event_type: 'usage_update',
          session_id: 'session_primary',
          role_id: 'role_ts_engineer',
          payload: { update: { used: 321, size: 200_000 } },
        },
      })}\n`,
      'utf8',
    );
    const { runner, repository, bufferRepository } = await fixture(
      maintenanceLlm(),
      undefined,
      undefined,
      { runsRoot },
    );
    const seq = await writePending(
      repository,
      bufferRepository,
      'role_ts_engineer',
      'task_token_refresh',
    );

    await runner.processBuffer({
      task_id: 'task_token_refresh',
      run_id: 'run_token_refresh',
      role_id: 'role_ts_engineer',
      buffer_seq: seq,
    });

    const summary = JSON.parse(await readFile(path.join(runDir, 'summary.json'), 'utf8')) as {
      token_usage?: { source?: string; schema_version?: string };
      driver_context_usage?: { source?: string; context_tokens_used?: number };
    };
    expect(summary.driver_context_usage).toMatchObject({
      source: 'driver_stream_usage_update',
      context_tokens_used: 321,
    });
    expect(summary.token_usage).toMatchObject({
      schema_version: 'newide.token_usage.v1',
    });
    expect(summary.token_usage?.source).not.toBe('driver_stream_usage_update');
  });
});

/**
 * 首次提交交付（submitContextDelivery）与 in-process emulation（processBuffer）都必须对
 * **损坏的 AgentContextSnapshot** 说不：声明过 context_snapshot_ref 却读不出来的上下文，是
 * 一条坏掉的输入，不是「本次没有上下文」。放行就是把半份 payload（只有 DriverReturn）交给
 * 下游或喂进提取器，还让它以为输入是完整的。历史 Buffer（没有声明引用）不受影响，照常降级。
 */
describe('BMemoryMaintenanceRunner：损坏上下文在首次交付与模拟提取处都被拦下', () => {
  const ROLE = 'role_delivery_context';

  it('首次 scheduleBuffer 遇到损坏 context：返回 failed evidence，不登记交付项', async () => {
    const f = await fileBackedDeliveryRunner(ROLE);
    await savePairedBuffer(f, ROLE, 'task_bad_ctx', sampleContextSnapshot(ROLE));
    await writeFile(contextFilePath(f.agentStateRoot, ROLE), '{ not json', 'utf8');

    const evidence = await f.runner.scheduleBuffer({
      task_id: 'task_bad_ctx',
      run_id: 'run_bad_ctx',
      role_id: ROLE,
      buffer_seq: 1,
    });

    expect(evidence).toMatchObject({ kind: 'context_delivery', status: 'failed' });
    expect(evidence.error).toMatch(/context_1\.json/);
    // error 与 warnings 都要带上原因：否则运维在两处任一处都看不到是哪条坏
    expect(evidence.warnings.join(' ')).toMatch(/context_1\.json/);
    await expect(f.deliveryRepository.listContextDeliveries({ role_id: ROLE })).resolves.toHaveLength(
      0,
    );
  });

  it.each([
    {
      form: '文件缺失',
      damage: async (f: FileDeliveryFixture) => {
        await rm(contextFilePath(f.agentStateRoot, ROLE), { force: true });
      },
    },
    {
      form: 'JSON 损坏',
      damage: async (f: FileDeliveryFixture) => {
        await writeFile(contextFilePath(f.agentStateRoot, ROLE), '{ not json', 'utf8');
      },
    },
    {
      form: 'schema 不匹配',
      damage: async (f: FileDeliveryFixture) => {
        await writeFile(
          contextFilePath(f.agentStateRoot, ROLE),
          `${JSON.stringify({ snapshot_id: 'not-a-uuid' })}\n`,
          'utf8',
        );
      },
    },
  ])('声明了引用但 context $form：fail 而不降级成「没有上下文」', async ({ damage }) => {
    const f = await fileBackedDeliveryRunner(ROLE);
    await savePairedBuffer(f, ROLE, 'task_damaged', sampleContextSnapshot(ROLE));
    await damage(f);

    const evidence = await f.runner.scheduleBuffer({
      task_id: 'task_damaged',
      run_id: 'run_damaged',
      role_id: ROLE,
      buffer_seq: 1,
    });

    expect(evidence.status).toBe('failed');
    expect(evidence.error).toBeTruthy();
    await expect(f.deliveryRepository.listContextDeliveries({ role_id: ROLE })).resolves.toHaveLength(
      0,
    );
  });

  it('replayPending 与首次 scheduleBuffer 对同一损坏上下文行为一致', async () => {
    const f = await fileBackedDeliveryRunner(ROLE);
    await savePairedBuffer(f, ROLE, 'task_replay_bad', sampleContextSnapshot(ROLE));
    await writeFile(contextFilePath(f.agentStateRoot, ROLE), '{ not json', 'utf8');

    const first = await f.runner.scheduleBuffer({
      task_id: 'task_replay_bad',
      run_id: 'run_first',
      role_id: ROLE,
      buffer_seq: 1,
    });
    const replayed = await f.runner.replayPending();

    expect(first.status).toBe('failed');
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({
      kind: 'context_delivery',
      status: 'failed',
      role_id: ROLE,
      buffer_seq: 1,
    });
    await expect(f.deliveryRepository.listContextDeliveries({ role_id: ROLE })).resolves.toHaveLength(
      0,
    );
  });

  it('历史 Buffer（无 context_snapshot_ref）仍能正常提交交付', async () => {
    const f = await fileBackedDeliveryRunner(ROLE);
    const memory = createAgentMemoryScope(f.repository, f.bufferRepository, ROLE);
    const seq = (await memory.saveBufferSnapshot(snapshotFor('task_legacy'))).seq;

    const evidence = await f.runner.scheduleBuffer({
      task_id: 'task_legacy',
      run_id: 'run_legacy',
      role_id: ROLE,
      buffer_seq: seq,
    });

    expect(evidence).toMatchObject({ kind: 'context_delivery', status: 'scheduled' });
    await expect(f.deliveryRepository.listContextDeliveries({ role_id: ROLE })).resolves.toHaveLength(
      1,
    );
  });

  it('in-process emulation 不消费 unreadable 上下文，也不把 Buffer 打成死信', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-b-emu-ctx-'));
    roots.push(root);
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    await repository.initializeAgent({ role_id: 'role_emu_bad', name: 'role_emu_bad' });
    await bufferRepository.ensureAgent('role_emu_bad');
    // 声明了引用却没有上下文 → unreadable
    const memory = createAgentMemoryScope(repository, bufferRepository, 'role_emu_bad');
    const seq = (
      await memory.saveBufferSnapshot({
        ...snapshotFor('task_emu_bad'),
        context_snapshot_ref: '1',
      })
    ).seq;

    let extractorCalled = false;
    const runner = new BMemoryMaintenanceRunner({
      repository,
      bufferRepository,
      llm: {
        async complete() {
          throw new Error('emulation must not reach the LLM for a broken context');
        },
      },
      extractor: {
        async extract() {
          extractorCalled = true;
          throw new Error('must not extract from a partial input');
        },
      },
      evidenceStore: new FileBMemoryMaintenanceEvidenceStore(path.join(root, 'evidence')),
      mode: 'in_process_emulation',
    });

    const result = await runner.processBuffer({
      task_id: 'task_emu_bad',
      run_id: 'run_emu_bad',
      role_id: 'role_emu_bad',
      buffer_seq: seq,
    });

    expect(result).toMatchObject({ kind: 'experience_extraction', status: 'failed' });
    expect(result.error).toMatch(/context_snapshot_ref=1/);
    expect(extractorCalled).toBe(false);
    // 没有置死信：坏的是数据不是提取过程，留在 pending 上每次都被看见
    await expect(bufferRepository.listPendingBufferSeqs('role_emu_bad')).resolves.toEqual([seq]);
  });
});

interface FileDeliveryFixture {
  agentStateRoot: string;
  repository: InMemoryRepository;
  bufferRepository: FileBufferRepository;
  deliveryRepository: FileMemoryDeliveryRepository;
  runner: BMemoryMaintenanceRunner;
}

async function fileBackedDeliveryRunner(
  roleId: string,
  mode: BMemoryMaintenanceMode = 'delivery',
): Promise<FileDeliveryFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'newide-b-delivery-ctx-'));
  roots.push(root);
  const agentStateRoot = path.join(root, 'agent-state');
  const repository = new InMemoryRepository();
  const bufferRepository = new FileBufferRepository({ agentStateRoot });
  const deliveryRepository = new FileMemoryDeliveryRepository({ agentStateRoot });
  await repository.initializeAgent({ role_id: roleId, name: roleId });
  await bufferRepository.ensureAgent(roleId);
  await deliveryRepository.ensureAgent(roleId);
  const runner = new BMemoryMaintenanceRunner({
    repository,
    bufferRepository,
    deliveryRepository,
    // 生产路径不提取：走到提取就等于走错了路
    llm: {
      async complete() {
        throw new Error('delivery path must not call the extractor');
      },
    },
    evidenceStore: new FileBMemoryMaintenanceEvidenceStore(path.join(root, 'evidence')),
    mode,
  });
  return { agentStateRoot, repository, bufferRepository, deliveryRepository, runner };
}

function contextFilePath(agentStateRoot: string, roleId: string): string {
  return path.join(agentStateRoot, roleId, 'buffer', 'pending', 'context_1.json');
}

function sampleContextSnapshot(roleId: string): AgentContextSnapshot {
  return {
    snapshot_id: randomUUID(),
    source_task_id: 'task_ctx',
    agent_id: roleId,
    thinking_trace: 'Reasoning trace',
    planning_trace: 'Planning trace',
    driver_calls: [{ call_id: 'c1', driver_id: 'test-driver', driver_return_ref: 'report_1.json' }],
    cleaned_at: new Date().toISOString(),
    original_token_count: 100,
    cleaned_token_count: 40,
    compression_ratio: 0.4,
  };
}

async function savePairedBuffer(
  f: FileDeliveryFixture,
  roleId: string,
  taskId: string,
  context: AgentContextSnapshot,
): Promise<number> {
  const memory = createAgentMemoryScope(f.repository, f.bufferRepository, roleId);
  return (await memory.saveBufferSnapshot(snapshotFor(taskId), context)).seq;
}

async function fixture(
  llm: LlmClient = maintenanceLlm(),
  providedEvidenceStore?: BMemoryMaintenanceEvidenceStore,
  extractor?: ExperienceExtractor,
  extra?: {
    runsRoot?: string;
    promotion?: { confidenceThreshold?: number; autoApprove?: boolean };
    callJournal?: CallJournalPort;
  },
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'newide-b-maintenance-'));
  roots.push(root);
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  const deliveryRepository = new InMemoryMemoryDeliveryRepository();
  await repository.initializeAgent({ role_id: 'role_ts_engineer', name: 'TypeScript Engineer' });
  await bufferRepository.ensureAgent('role_ts_engineer');
  await deliveryRepository.ensureAgent('role_ts_engineer');
  const evidenceStore =
    providedEvidenceStore ?? new FileBMemoryMaintenanceEvidenceStore(path.join(root, 'evidence'));
  const runner = new BMemoryMaintenanceRunner({
    repository,
    bufferRepository,
    deliveryRepository,
    llm,
    evidenceStore,
    // 本文件测的是**实验/维护路径**：本进程内模拟下游 Memory Maintenance 的提取与晋升。
    // 在线任务路径（scheduleBuffer）在两种 mode 下都只登记交付项；提取只能由调用方显式
    // 调 processBuffer 触发（见 memory-delivery-contract.test.ts 的生产路径断言）。
    mode: 'in_process_emulation',
    ...(extractor ? { extractor } : {}),
    ...(extra?.runsRoot ? { runsRoot: extra.runsRoot } : {}),
    ...(extra?.promotion ? { promotion: extra.promotion } : {}),
    ...(extra?.callJournal ? { callJournal: extra.callJournal } : {}),
  });
  return { runner, repository, bufferRepository, evidenceStore, deliveryRepository };
}

/** 提取总是失败的提取器（模拟 LLM 与规则版降级均失败） */
function failingExtractor(): ExperienceExtractor {
  return {
    async extract() {
      throw new Error('LLM provider unavailable');
    },
  };
}

/**
 * 每次调用都产出同一批（但 id 每次重新随机）的提取器。
 *
 * id 随机正是要验的东西：重试时提取器会给出全新的 UUID，只有落库侧的稳定身份能认出
 * 「这条已经写过」。归属不在提取器的输出里（候选经验没有 agent_id），落库时按
 * memory.role_id 补齐——这里把 source_task_id 设成别的值，验它不会被拿来当 owner。
 */
function deterministicExtractor(count: number, sourceTaskId = 'task_idem'): ExperienceExtractor {
  return {
    async extract() {
      const now = new Date().toISOString();
      return {
        experiences: Array.from({ length: count }, (_, index) => ({
          id: randomUUID(),
          description: `Deterministic experience ${String(index)}`,
          description_embedding: [0.1, 0.2, 0.3],
          content: `Content ${String(index)}`,
          confidence: 0.8,
          tags: ['test'],
          confidence_history: [],
          referenced_count: 0,
          source_task_id: sourceTaskId,
          source_driver: 'test-driver',
          type: 'positive' as const,
          created_at: now,
          updated_at: now,
        })),
        result: {
          experiences_created: count,
          experiences_updated: 0,
          negative_experiences: 0,
          skills_promoted: 0,
        },
      };
    },
  };
}

async function writePending(
  repository: InMemoryRepository,
  bufferRepository: InMemoryBufferRepository,
  roleId: string,
  taskId: string,
  references: BufferSnapshot['driver_return']['referenced_experiences'] = [],
): Promise<number> {
  const memory = createAgentMemoryScope(repository, bufferRepository, roleId);
  return (await memory.saveBufferSnapshot(snapshotFor(taskId, references))).seq;
}

function snapshotFor(
  taskId: string,
  references: BufferSnapshot['driver_return']['referenced_experiences'] = [],
): BufferSnapshot {
  return {
    task_id: taskId,
    task_description: 'Keep B implementation behind public ports.',
    driver_return: {
      summary: 'The task completed through the public B runtime.',
      artifacts: [],
      decisions: [],
      blockers: [],
      referenced_experiences: references,
      assumptions: [],
    },
    source_task_id: taskId,
    source_driver: 'test-driver',
    received_at: new Date().toISOString(),
    retry_count: 0,
    extraction_status: 'pending',
  };
}

function maintenanceLlm(): LlmClient {
  let calls = 0;
  return {
    async complete() {
      calls += 1;
      if (calls % 2 === 1) {
        return JSON.stringify({
          experiences: [
            {
              description: 'Persist app composition boundaries',
              content: 'Consume B through its public repository and buffer ports.',
              type: 'positive',
              confidence: 0.99,
              tags: ['architecture'],
            },
          ],
        });
      }
      return JSON.stringify({
        description: 'Keep B behind public ports',
        content: 'Compose B dependencies in the application layer.',
        tags: ['architecture'],
      });
    },
  };
}

/** 提取出的经验置信度固定为给定值（低于默认 0.95 门槛，用于阈值测试） */
function confidenceLlm(confidence: number): LlmClient {
  let calls = 0;
  return {
    async complete() {
      calls += 1;
      if (calls % 2 === 1) {
        return JSON.stringify({
          experiences: [
            {
              description: 'Low confidence experience',
              content: 'Some reusable content.',
              type: 'positive',
              confidence,
              tags: ['test'],
            },
          ],
        });
      }
      return JSON.stringify({
        description: 'Promoted low confidence experience',
        content: 'Generalized reusable content.',
        tags: ['test'],
      });
    },
  };
}

function experienceExtractionResponse(): string {
  return JSON.stringify({
    experiences: [
      {
        description: 'Persist app composition boundaries',
        content: 'Consume B through its public repository and buffer ports.',
        type: 'positive',
        confidence: 0.99,
        tags: ['architecture'],
      },
    ],
  });
}
