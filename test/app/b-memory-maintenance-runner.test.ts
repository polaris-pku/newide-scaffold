import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BMemoryMaintenanceRunner,
  FileBMemoryMaintenanceEvidenceStore,
  type BMemoryMaintenanceEvidence,
  type BMemoryMaintenanceEvidenceStore,
} from '../../src/app/b-memory-maintenance-runner';
import {
  InMemoryBufferRepository,
  InMemoryRepository,
  createAgentMemoryScope,
  type ExperienceExtractor,
  type LlmClient,
} from '../../src/memory';
import type { BufferSnapshot } from '../../src/memory/schemas';

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

  it('replays durable pending Buffers after application restart', async () => {
    let markExtractionStarted!: () => void;
    const extractionStarted = new Promise<void>((resolve) => {
      markExtractionStarted = resolve;
    });
    let releaseExtraction!: (value: string) => void;
    const extractionResult = new Promise<string>((resolve) => {
      releaseExtraction = resolve;
    });
    const { runner, repository, bufferRepository, evidenceStore } = await fixture({
      async complete() {
        markExtractionStarted();
        return extractionResult;
      },
    });
    await writePending(repository, bufferRepository, 'role_ts_engineer', 'task_replay');

    const results = await runner.replayPending();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ task_id: 'task_replay', status: 'scheduled' });
    await extractionStarted;
    releaseExtraction(experienceExtractionResponse());
    await runner.waitForIdle();
    await expect(evidenceStore.get(results[0]!.maintenance_ref)).resolves.toMatchObject({
      task_id: 'task_replay',
      status: 'completed',
    });
    await expect(repository.listExperiences('role_ts_engineer')).resolves.toHaveLength(1);
  });

  it('single-flights concurrent scheduling for the same durable Buffer', async () => {
    const { runner, repository, bufferRepository, evidenceStore } = await fixture();
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

    expect(new Set(scheduled.map((item) => item.maintenance_ref)).size).toBe(1);
    expect(save.mock.calls.filter(([item]) => item.status === 'scheduled')).toHaveLength(1);
    await expect(repository.listExperiences('role_ts_engineer')).resolves.toHaveLength(1);
    await expect(evidenceStore.get(scheduled[0]!.maintenance_ref)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('observes a failed background job when failed evidence cannot be persisted', async () => {
    let scheduled: BMemoryMaintenanceEvidence | undefined;
    const failingStore: BMemoryMaintenanceEvidenceStore = {
      async save(evidence) {
        if (evidence.status !== 'scheduled') throw new Error('maintenance store write failed');
        scheduled = evidence;
        return { uri: 'file:///maintenance/scheduled.json' };
      },
      async get(maintenanceRef) {
        return scheduled?.maintenance_ref === maintenanceRef ? scheduled : undefined;
      },
      async list() {
        return scheduled ? [scheduled] : [];
      },
    };
    const { runner, repository, bufferRepository } = await fixture(
      {
        async complete() {
          throw new Error('extraction failed');
        },
      },
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
    ).resolves.toMatchObject({ status: 'scheduled' });
    await expect(runner.waitForIdle()).resolves.toBeUndefined();
    await Promise.resolve();
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
      driver_usage?: { source?: string; context_tokens_used?: number };
    };
    expect(summary.driver_usage).toMatchObject({
      source: 'driver_stream_usage_update',
      context_tokens_used: 321,
    });
    expect(summary.token_usage).toMatchObject({
      schema_version: 'newide.token_usage.v1',
    });
    expect(summary.token_usage?.source).not.toBe('driver_stream_usage_update');
  });
});

async function fixture(
  llm: LlmClient = maintenanceLlm(),
  providedEvidenceStore?: BMemoryMaintenanceEvidenceStore,
  extractor?: ExperienceExtractor,
  extra?: { runsRoot?: string; promotion?: { confidenceThreshold?: number; autoApprove?: boolean } },
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'newide-b-maintenance-'));
  roots.push(root);
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  await repository.initializeAgent({ role_id: 'role_ts_engineer', name: 'TypeScript Engineer' });
  await bufferRepository.ensureAgent('role_ts_engineer');
  const evidenceStore =
    providedEvidenceStore ?? new FileBMemoryMaintenanceEvidenceStore(path.join(root, 'evidence'));
  const runner = new BMemoryMaintenanceRunner({
    repository,
    bufferRepository,
    llm,
    evidenceStore,
    ...(extractor ? { extractor } : {}),
    ...(extra?.runsRoot ? { runsRoot: extra.runsRoot } : {}),
    ...(extra?.promotion ? { promotion: extra.promotion } : {}),
  });
  return { runner, repository, bufferRepository, evidenceStore };
}

/** 提取总是失败的提取器（模拟 LLM 与规则版降级均失败） */
function failingExtractor(): ExperienceExtractor {
  return {
    async extract() {
      throw new Error('LLM provider unavailable');
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
  const snapshot: BufferSnapshot = {
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
  return (await memory.saveBufferSnapshot(snapshot)).seq;
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
