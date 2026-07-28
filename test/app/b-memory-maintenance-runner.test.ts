import { mkdtemp, rm } from 'node:fs/promises';
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
});

async function fixture(
  llm: LlmClient = maintenanceLlm(),
  providedEvidenceStore?: BMemoryMaintenanceEvidenceStore,
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
  });
  return { runner, repository, bufferRepository, evidenceStore };
}

async function writePending(
  repository: InMemoryRepository,
  bufferRepository: InMemoryBufferRepository,
  roleId: string,
  taskId: string,
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
      referenced_experiences: [],
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
