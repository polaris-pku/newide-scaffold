/**
 * ExperienceExtractorProcessor 测试
 *
 * 验证：
 *   1. extractAll 处理所有 pending buffer
 *   2. extractAll 空 pending 返回空
 *   3. checkAndExtract 满足 policy 时处理
 *   4. checkAndExtract 不满足 policy 时跳过
 *   5. extractOne 抛出 missing buffer 错误
 */
import { describe, it, expect, vi } from 'vitest';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { AlwaysExtractPolicy } from '../adapters/always-extract-policy';
import { BatchBufferTriggerPolicy } from '../adapters/batch-buffer-trigger-policy';
import { ExperienceExtractorProcessor } from '../runtime/experience-extractor-processor';
import type { ExperienceExtractor } from '../ports/experience-extractor';
import type { BufferSnapshot } from '../schemas';
import type { ExtractionOutput } from '../types';

// ──────────────────────────────────────────────
// Mock ExperienceExtractor
// ──────────────────────────────────────────────

function createMockExtractor(experiencesPerCall: number = 1): ExperienceExtractor {
  return {
    extract: vi.fn().mockResolvedValue({
      experiences: Array.from({ length: experiencesPerCall }, (_, i) => ({
        id: `exp-${Date.now()}-${i}`,
        description: `Test experience ${i}`,
        description_embedding: [0.1, 0.2, 0.3],
        content: `Content ${i}`,
        confidence: 0.8,
        tags: ['test'],
        agent_id: 'role_test',
        type: 'positive' as const,
        confidence_history: [],
        referenced_count: 0,
        source_task_id: 'task_001',
        source_driver: 'test-driver',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })),
      result: {
        experiences_created: experiencesPerCall,
        experiences_updated: 0,
        negative_experiences: 0,
        skills_promoted: 0,
      },
    } satisfies ExtractionOutput),
  };
}

// ──────────────────────────────────────────────
// 测试基础设施
// ──────────────────────────────────────────────

async function createTestInfra(role_id = 'role_extract_test') {
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  await repository.initializeAgent({ role_id, name: 'Test Agent', tags: [] });
  await bufferRepository.ensureAgent(role_id);
  const memory = createAgentMemoryScope(repository, bufferRepository, role_id);
  return { repository, bufferRepository, memory, role_id };
}

async function writePendingBuffer(
  memory: ReturnType<typeof createAgentMemoryScope>,
  task_id = 'task_001',
) {
  const snapshot: BufferSnapshot = {
    task_id,
    task_description: `Test task ${task_id}`,
    driver_return: {
      artifacts: [],
      summary: 'Done',
      decisions: [],
      blockers: [],
      assumptions: [],
      referenced_experiences: [],
      effectiveness: 'fully_effective',
    },
    source_task_id: task_id,
    source_driver: 'test-driver',
    received_at: new Date().toISOString(),
    retry_count: 0,
    extraction_status: 'pending',
  };
  const saved = await memory.saveBufferSnapshot(snapshot);
  return { seq: saved.seq, snapshot: saved.snapshot };
}

// ──────────────────────────────────────────────
// 测试用例
// ──────────────────────────────────────────────

describe('ExperienceExtractorProcessor', () => {
  describe('extractAll — 手动模式', () => {
    it('处理所有 pending buffer 并返回提取结果', async () => {
      const { memory } = await createTestInfra('role_extract_all');
      const extractor = createMockExtractor(1);
      const processor = new ExperienceExtractorProcessor(new AlwaysExtractPolicy(), extractor);

      // 写入 2 条 pending buffer
      await writePendingBuffer(memory, 'task_001');
      await writePendingBuffer(memory, 'task_002');

      const results = await processor.extractAll(memory);

      expect(results).toHaveLength(2);
      expect(results[0]!.extraction.experiences).toHaveLength(1);
      expect(results[1]!.extraction.experiences).toHaveLength(1);
      // 晋升被跳过
      expect(results[0]!.promotion.check.eligible).toBe(false);
      expect(results[0]!.promotion.check.reasons).toContain(
        'Promotion deferred to SkillPromotionProcessor',
      );

      // buffer 应已被标记为 processed
      const seqs = await memory.listPendingBufferSeqs();
      expect(seqs).toHaveLength(0);
    });

    it('没有 pending buffer 时返回空数组', async () => {
      const { memory } = await createTestInfra('role_extract_empty');
      const processor = new ExperienceExtractorProcessor(
        new AlwaysExtractPolicy(),
        createMockExtractor(1),
      );

      const results = await processor.extractAll(memory);
      expect(results).toHaveLength(0);
    });
  });

  describe('checkAndExtract — 自动模式', () => {
    it('policy 满足条件时提取', async () => {
      const { memory } = await createTestInfra('role_check_ok');
      const extractor = createMockExtractor(1);
      // batchSize=2, 写入3条 => 容量门控触发
      const policy = new BatchBufferTriggerPolicy(2, 3600000);
      const processor = new ExperienceExtractorProcessor(policy, extractor);

      await writePendingBuffer(memory, 'task_001');
      await writePendingBuffer(memory, 'task_002');
      await writePendingBuffer(memory, 'task_003');

      const results = await processor.checkAndExtract(memory);
      expect(results).toHaveLength(3);

      // buffer 已处理
      const seqs = await memory.listPendingBufferSeqs();
      expect(seqs).toHaveLength(0);
    });

    it('policy 不满足条件时跳过', async () => {
      const { memory } = await createTestInfra('role_check_skip');
      const extractor = createMockExtractor(1);
      // batchSize=10, 仅1条 => 容量门控不触发
      const policy = new BatchBufferTriggerPolicy(10, 3600000);
      const processor = new ExperienceExtractorProcessor(policy, extractor);

      await writePendingBuffer(memory, 'task_001');

      const results = await processor.checkAndExtract(memory);
      expect(results).toHaveLength(0);

      // buffer 没有被处理
      const seqs = await memory.listPendingBufferSeqs();
      expect(seqs).toHaveLength(1);
    });

    it('没有 pending buffer 时返回空数组', async () => {
      const { memory } = await createTestInfra('role_check_none');
      const processor = new ExperienceExtractorProcessor(
        new AlwaysExtractPolicy(),
        createMockExtractor(1),
      );

      const results = await processor.checkAndExtract(memory);
      expect(results).toHaveLength(0);
    });
  });

  describe('错误处理', () => {
    it('提取不存在的 buffer 时抛出错误', async () => {
      const { memory } = await createTestInfra('role_extract_err');
      const processor = new ExperienceExtractorProcessor(
        new AlwaysExtractPolicy(),
        createMockExtractor(1),
      );

      await expect(
        // @ts-expect-error — extractOne 是 private 方法，测试中直接访问
        processor.extractOne(memory, 999),
      ).rejects.toThrow('Pending buffer not found: seq=999');
    });
  });

  /**
   * 提取落库的粒度是**整条 Buffer**（保存第 N 条失败 → 整条重来），而提取器给出的 id 是
   * 当场生成的随机 UUID。没有稳定身份的话，每次重试都会把前 N-1 条再写一遍。
   * 这里把三种「写完一部分才失败」的现场各钉一次。
   */
  describe('落库幂等：稳定身份 + 归属校正', () => {
    it('保存第 2 条失败后重跑：已写入的不重复写，最终恰好 [提取结果长度] 条', async () => {
      const { memory, repository, role_id } = await createTestInfra('role_idem_partial');
      const processor = new ExperienceExtractorProcessor(
        new AlwaysExtractPolicy(),
        createMockExtractor(3),
      );
      await writePendingBuffer(memory, 'task_idem_partial');

      const originalSave = repository.saveExperienceIfAbsent.bind(repository);
      let writes = 0;
      // 落库走的是存储层的原子幂等写入（唯一键 = Experience.id），所以注入失败也要打在这里：
      // 打 saveExperience 已经打不中了，那正是这次改动把「查 + 写」收进存储层的证据
      const spy = vi
        .spyOn(repository, 'saveExperienceIfAbsent')
        .mockImplementation(async (r, e) => {
          writes += 1;
          if (writes === 2) throw new Error('experience write failed');
          return originalSave(r, e);
        });

      await expect(processor.extractAll(memory)).rejects.toThrow('experience write failed');
      spy.mockRestore();
      // 第 1 条已经落库，Buffer 仍是 pending（归档这一半没做）
      await expect(repository.listExperiences(role_id)).resolves.toHaveLength(1);
      await expect(memory.listPendingBufferSeqs()).resolves.toEqual([1]);

      await processor.extractAll(memory);

      const experiences = await repository.listExperiences(role_id);
      expect(experiences).toHaveLength(3);
      expect(new Set(experiences.map((item) => item.id)).size).toBe(3);
      await expect(memory.listPendingBufferSeqs()).resolves.toEqual([]);
    });

    it('markBufferProcessed 失败后重跑：经验不重复，Buffer 最终归档', async () => {
      const { memory, repository, role_id } = await createTestInfra('role_idem_mark');
      const processor = new ExperienceExtractorProcessor(
        new AlwaysExtractPolicy(),
        createMockExtractor(2),
      );
      await writePendingBuffer(memory, 'task_idem_mark');

      const spy = vi
        .spyOn(memory, 'markBufferProcessed')
        .mockRejectedValueOnce(new Error('archive failed'));

      await expect(processor.extractAll(memory)).rejects.toThrow('archive failed');
      spy.mockRestore();
      await expect(repository.listExperiences(role_id)).resolves.toHaveLength(2);

      await processor.extractAll(memory);

      await expect(repository.listExperiences(role_id)).resolves.toHaveLength(2);
      await expect(memory.listPendingBufferSeqs()).resolves.toEqual([]);
    });

    it('无上下文快照的 Buffer：归属当前 Agent，source_task_id 只作任务溯源', async () => {
      const { memory, repository, role_id } = await createTestInfra('role_owner');
      // 提取器产出的候选经验**根本没有 agent_id 字段**（见 CandidateExperience），
      // 所以「拿 source_task_id 顶替 agent_id」这条路在类型上就不存在。落库时归属由
      // persistExtractedExperiences 按 memory.role_id 补齐。
      const extractor: ExperienceExtractor = {
        extract: vi.fn().mockResolvedValue({
          experiences: [
            {
              id: 'not-a-real-uuid',
              description: 'Test experience',
              description_embedding: [0.1, 0.2, 0.3],
              content: 'Content',
              confidence: 0.8,
              tags: ['test'],
              type: 'positive' as const,
              confidence_history: [],
              referenced_count: 0,
              source_task_id: 'task_001',
              source_driver: 'test-driver',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          result: {
            experiences_created: 1,
            experiences_updated: 0,
            negative_experiences: 0,
            skills_promoted: 0,
          },
        } satisfies ExtractionOutput),
      };
      const processor = new ExperienceExtractorProcessor(new AlwaysExtractPolicy(), extractor);
      await writePendingBuffer(memory, 'task_001');

      await processor.extractAll(memory);

      const stored = await repository.listExperiences(role_id);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.agent_id).toBe(role_id);
      expect(stored[0]!.agent_id).not.toBe('');
      expect(stored[0]!.source_task_id).toBe('task_001');
    });
  });
});
