/**
 * memory-cycle — 任务记忆后处理服务
 *
 * 提供主动提取/晋升函数，以及 buffer 写入/处理。
 */
import { createId, nowTimestamp } from '../../core';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { MemoryRepository } from '../ports/memory-repository';
import type { BufferRepository } from '../ports/buffer-repository';
import type { ExperienceExtractor } from '../ports/experience-extractor';
import type {
  AgentContextSnapshot,
  BufferSnapshot,
  DriverReturn,
  ExperienceRecord,
} from '../schemas';
import type { AgentTaskRequest } from '../agent-types';
import type { ExtractionOutput, PromotionOutcome } from '../types';
import { writePendingBuffer } from './buffer-writer';

/**
 * 技能晋升处理器（服务层依赖的结构接口）。
 * 实现见 adapters/llm-skill-promotion.ts、services/skill-promotion.ts。
 */
export interface SkillPromotion {
  promote(
    memory: AgentMemoryScope,
    task: AgentTaskRequest,
    experiences: ExperienceRecord[],
  ): Promise<PromotionOutcome>;
}

/** 构造 AgentMemoryScope 的工厂，由组合根注入，避免服务层直连 adapter。 */
export type MemoryScopeFactory = (role_id: string) => AgentMemoryScope;

/**
 * ingestTaskBuffer 的输入。
 * 将 Driver 返回报告与顶层 Agent 上下文快照成对写入 pending buffer。
 */
export interface TaskBufferIngestInput {
  /** 原始任务请求（buffer 中 task_description 取 task.spec） */
  task: AgentTaskRequest;
  task_id: string;
  call_id: string;
  source_driver: string;
  /** Driver 6 字段结构化报告 */
  driver_return: DriverReturn;
  /** 顶层 Agent 清理后的上下文快照（与 buffer 成对存储） */
  agentContext?: AgentContextSnapshot | undefined;
}

/**
 * processPendingBuffer 的输入。
 * 指定提取器与晋升处理器，对单条 pending buffer 执行后处理。
 */
export interface ProcessPendingInput {
  task: AgentTaskRequest;
  extractor: ExperienceExtractor;
  promote: (
    memory: AgentMemoryScope,
    task: AgentTaskRequest,
    experiences: ExperienceRecord[],
  ) => Promise<PromotionOutcome>;
}

/** processPendingBuffer 的返回：提取结果 + 晋升结果 */
export interface ProcessPendingResult {
  extraction: ExtractionOutput;
  promotion: PromotionOutcome;
}

/**
 * 将 Driver 报告与 Agent 上下文写入 pending buffer。
 * task_description 使用 task.spec（完整任务规格），非 task_instruction。
 *
 * @returns 分配的 buffer 序号与快照副本
 */
export async function ingestTaskBuffer(
  memory: AgentMemoryScope,
  input: TaskBufferIngestInput,
): Promise<{ seq: number; snapshot: BufferSnapshot }> {
  const snapshot: BufferSnapshot = {
    task_id: input.task_id,
    task_description: input.task.spec,
    driver_return: input.driver_return,
    source_task_id: input.task_id,
    source_driver: input.source_driver,
    received_at: nowTimestamp(),
    retry_count: 0,
    extraction_status: 'pending',
  };

  const saved = await writePendingBuffer(memory, snapshot, input.agentContext);
  return { seq: saved.seq, snapshot: saved.snapshot };
}

/**
 * 处理单条 pending buffer：提取经验 → 入库 → 晋升检查 → 标记 processed。
 */
export async function processPendingBuffer(
  memory: AgentMemoryScope,
  seq: number,
  input: ProcessPendingInput,
): Promise<ProcessPendingResult> {
  const pending = await memory.getPendingBuffer(seq);
  if (!pending) {
    throw new Error(`Pending buffer not found: seq=${seq}`);
  }

  const extraction = await input.extractor.extract(pending.snapshot, pending.agentContext);

  for (const experience of extraction.experiences) {
    await memory.saveExperience(experience);
  }

  const promotion = await input.promote(memory, input.task, extraction.experiences);
  if (promotion.skill) {
    extraction.result.skills_promoted = 1;
  }

  await memory.markBufferProcessed(seq);
  return { extraction, promotion };
}

/**
 * 主动提取：从指定 pending buffer 中提取经验并保存，不做晋升。
 *
 * 适合场景：只想跑提取、查看 LLM 抽出了什么经验，暂不晋升。
 *
 * @param memory    - Agent 记忆作用域
 * @param seq       - pending buffer 序号
 * @param extractor - 经验提取器（由组合根注入）
 * @returns 提取结果（含 experiences 列表）
 */
export async function extractBuffer(
  memory: AgentMemoryScope,
  seq: number,
  extractor: ExperienceExtractor,
): Promise<ExtractionOutput> {
  const pending = await memory.getPendingBuffer(seq);
  if (!pending) {
    throw new Error(`Pending buffer not found: seq=${seq}`);
  }

  const extraction = await extractor.extract(pending.snapshot, pending.agentContext);

  for (const experience of extraction.experiences) {
    await memory.saveExperience(experience);
  }

  return extraction;
}

/**
 * 主动晋升：扫描 repo 中已保存的未晋升经验，调用晋升处理器提升为技能。
 *
 * 筛选条件：
 *   - type === 'positive'
 *   - confidence > 阈值（默认 0.95，options.confidenceThreshold 可覆盖）
 *   - promoted_to === undefined
 *
 * 每条经验晋升后自动调用 memory.saveSkill() 和 memory.updateExperience()。
 *
 * @param memory   - Agent 记忆作用域
 * @param promoter - 技能晋升处理器（由组合根注入）
 * @param options  - confidenceThreshold：晋升置信度门槛（全自动化测评降阈值用）
 * @returns 晋升结果列表（每个 eligible 经验一条）
 */
export interface PromotionServiceOptions {
  /** 晋升置信度门槛，默认 0.95（对齐 Spec §4.3） */
  confidenceThreshold?: number;
}

export async function promoteExperiences(
  memory: AgentMemoryScope,
  promoter: SkillPromotion,
  options: PromotionServiceOptions = {},
): Promise<PromotionOutcome[]> {
  const threshold = options.confidenceThreshold ?? 0.95;
  const all = await memory.listExperiences();
  const eligible = all.filter(
    (e) => e.type === 'positive' && e.confidence > threshold && e.promoted_to === undefined,
  );

  if (eligible.length === 0) {
    return [];
  }

  const dummyTask: AgentTaskRequest = {
    spec: 'skill-promotion',
    task_id: `promotion-${createId('promo')}`,
    call_id: `promotion-${createId('promo')}`,
    source_driver: 'promotion-processor',
  };

  const results: PromotionOutcome[] = [];
  for (const experience of eligible) {
    const outcome = await promoter.promote(memory, dummyTask, [experience]);
    results.push(outcome);
  }

  return results;
}

/**
 * 批量提取：对所有 Agent 的每条 pending buffer 执行 extractBuffer。
 *
 * @param repository - Agent 注册仓库（用于列出所有 role_id）
 * @param bufferRepository - Buffer 仓库
 * @param scopeFactory - 构造 AgentMemoryScope 的工厂
 * @param extractor    - 经验提取器
 * @returns 每个 Agent 的提取结果列表
 */
export async function extractAllBuffers(
  repository: MemoryRepository,
  bufferRepository: BufferRepository,
  scopeFactory: MemoryScopeFactory,
  extractor: ExperienceExtractor,
): Promise<{ role_id: string; results: ExtractionOutput[] }[]> {
  const agentIds = await repository.listAgentIds();
  const allResults: { role_id: string; results: ExtractionOutput[] }[] = [];

  for (const role_id of agentIds) {
    const memory = scopeFactory(role_id);
    const seqs = await memory.listPendingBufferSeqs();
    if (seqs.length === 0) continue;

    const results: ExtractionOutput[] = [];
    for (const seq of seqs) {
      const extraction = await extractBuffer(memory, seq, extractor);
      results.push(extraction);
    }
    allResults.push({ role_id, results });
  }

  return allResults;
}

/**
 * 批量晋升：对所有 Agent 执行 promoteExperiences。
 *
 * @param repository - Agent 注册仓库（用于列出所有 role_id）
 * @param bufferRepository - Buffer 仓库
 * @param scopeFactory - 构造 AgentMemoryScope 的工厂
 * @param promoter     - 技能晋升处理器
 * @returns 每个 Agent 的晋升结果列表
 */
export async function promoteAllExperiences(
  repository: MemoryRepository,
  bufferRepository: BufferRepository,
  scopeFactory: MemoryScopeFactory,
  promoter: SkillPromotion,
  options: PromotionServiceOptions = {},
): Promise<{ role_id: string; outcomes: PromotionOutcome[] }[]> {
  const agentIds = await repository.listAgentIds();
  const allResults: { role_id: string; outcomes: PromotionOutcome[] }[] = [];

  for (const role_id of agentIds) {
    const memory = scopeFactory(role_id);
    const outcomes = await promoteExperiences(memory, promoter, options);
    allResults.push({ role_id, outcomes });
  }

  return allResults;
}

/**
 * 指定 Agent 提取：通过 scopeFactory 创建 memory scope 后提取。
 *
 * @param role_id          - 目标 Agent
 * @param seq              - pending buffer 序号
 * @param scopeFactory     - 构造 AgentMemoryScope 的工厂
 * @param extractor        - 经验提取器
 */
export async function extractBufferForAgent(
  role_id: string,
  seq: number,
  scopeFactory: MemoryScopeFactory,
  extractor: ExperienceExtractor,
): Promise<ExtractionOutput> {
  const memory = scopeFactory(role_id);
  return extractBuffer(memory, seq, extractor);
}

/**
 * 指定 Agent 晋升：通过 scopeFactory 创建 memory scope 后晋升。
 *
 * @param role_id          - 目标 Agent
 * @param scopeFactory     - 构造 AgentMemoryScope 的工厂
 * @param promoter         - 技能晋升处理器
 * @param options          - confidenceThreshold：晋升置信度门槛（全自动化测评降阈值用）
 */
export async function promoteExperiencesForAgent(
  role_id: string,
  scopeFactory: MemoryScopeFactory,
  promoter: SkillPromotion,
  options: PromotionServiceOptions = {},
): Promise<PromotionOutcome[]> {
  const memory = scopeFactory(role_id);
  return promoteExperiences(memory, promoter, options);
}
