/**
 * Feedback（M4：memory.rateTask）测试
 *
 * 验证：
 *   1. resolved：置信度 +0.05、写 source_user_rating、追加 confidence_history、
 *      重算 avg_confidence
 *   2. unresolved：置信度 −0.1（下限 0 截断）
 *   3. buffer：匹配 task_id 的 pending 快照写入 user_rating（buffer_updated=true）；
 *      无匹配 pending 时 buffer_updated=false
 *   4. 无派生经验时 updated_experiences=0
 */
import { describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { applyUserRating } from '../services/feedback';
import type { BufferSnapshot, ExperienceRecord } from '../schemas';

const ROLE = 'role_rate';
const TASK = 'task_rate_001';

async function setup() {
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  await repository.initializeAgent({ role_id: ROLE, name: 'Rate Me' });
  return { repository, bufferRepository };
}

function experience(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  const now = nowTimestamp();
  return {
    id: `exp_${Math.random().toString(36).slice(2)}`,
    description: 'A lesson',
    description_embedding: [],
    content: 'lesson content',
    confidence: 0.5,
    tags: ['typescript'],
    agent_id: ROLE,
    confidence_history: [],
    referenced_count: 0,
    source_task_id: TASK,
    source_driver: 'test-driver',
    type: 'positive',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function pendingBuffer(seq: number): BufferSnapshot {
  const now = nowTimestamp();
  return {
    task_id: TASK,
    task_description: 'Do a task.',
    driver_return: {
      artifacts: [],
      summary: 'Done.',
      decisions: [],
      blockers: [],
      referenced_experiences: [],
      assumptions: [],
    },
    source_task_id: TASK,
    source_driver: 'test-driver',
    received_at: now,
    retry_count: 0,
    extraction_status: 'pending',
  };
}

describe('applyUserRating', () => {
  it('upgrades confidence on resolved and writes source_user_rating + history', async () => {
    const { repository, bufferRepository } = await setup();
    const target = experience({ confidence: 0.5 });
    await repository.saveExperience(ROLE, target);

    const result = await applyUserRating(repository, bufferRepository, {
      role_id: ROLE,
      task_id: TASK,
      rating: 'resolved',
      note: 'great work',
    });

    expect(result.updated_experiences).toBe(1);
    const updated = (await repository.listExperiences(ROLE))[0]!;
    expect(updated.confidence).toBeCloseTo(0.55);
    expect(updated.source_user_rating).toBe('resolved');
    expect(updated.confidence_history.at(-1)).toMatchObject({
      value: 0.55,
      reason: 'user_rating:resolved (great work)',
    });
    expect((await repository.getMetrics(ROLE)).avg_confidence).toBeCloseTo(0.55);
  });

  it('downgrades confidence on unresolved with a zero floor', async () => {
    const { repository, bufferRepository } = await setup();
    const low = experience({ confidence: 0.05 });
    const high = experience({ confidence: 0.5 });
    await repository.saveExperience(ROLE, low);
    await repository.saveExperience(ROLE, high);

    await applyUserRating(repository, bufferRepository, {
      role_id: ROLE,
      task_id: TASK,
      rating: 'unresolved',
    });

    const experiences = await repository.listExperiences(ROLE);
    expect(experiences.find((e) => e.id === low.id)!.confidence).toBe(0);
    expect(experiences.find((e) => e.id === high.id)!.confidence).toBeCloseTo(0.4);
  });

  it('writes the rating into a still-pending buffer for the task', async () => {
    const { repository, bufferRepository } = await setup();
    await bufferRepository.ensureAgent(ROLE);
    await bufferRepository.saveBufferSnapshot(ROLE, pendingBuffer(1));
    await bufferRepository.saveBufferSnapshot(ROLE, pendingBuffer(2));

    const result = await applyUserRating(repository, bufferRepository, {
      role_id: ROLE,
      task_id: TASK,
      rating: 'partially_resolved',
    });

    expect(result.buffer_updated).toBe(true);
    const pending = await bufferRepository.getPendingBuffer(ROLE, 1);
    expect(pending!.snapshot.user_rating).toBe('partially_resolved');
  });

  it('reports buffer_updated=false when no pending buffer matches the task', async () => {
    const { repository, bufferRepository } = await setup();
    const result = await applyUserRating(repository, bufferRepository, {
      role_id: ROLE,
      task_id: 'task_other',
      rating: 'resolved',
    });
    expect(result).toEqual({ updated_experiences: 0, buffer_updated: false });
  });
});
