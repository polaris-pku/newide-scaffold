/**
 * 记忆流程组合类型
 *
 * 由 Spec 实体组合而成的流程结果：Driver 上下文、提取输出、晋升检查、
 * 完整任务记忆周期（MemoryCycleResult）等。
 * 供 services 与 Agent.runOnce 返回值使用。
 */
import type {
  BufferSnapshot,
  ExperienceRecord,
  ExtractResult,
  PersonaDef,
  SkillRecord,
} from './schemas';
import type { MemoryRetrievalResult } from './services/memory-query';

/**
 * 经验提取操作的输出。
 * 由 ExperienceExtractor 从 buffer 原材料中解析产生。
 */
export interface ExtractionOutput {
  /** 本次提取出的经验记录列表 */
  experiences: ExperienceRecord[];
  /** 提取摘要统计（新建/更新/晋升计数等） */
  result: ExtractResult;
}

/**
 * 下发给 Driver 的执行上下文。
 *
 * Driver 可见的全部记忆信息仅此三项，不含 Persona。
 * 由 buildDriverContext 内部调用 queryMemory 检索；与 task_instruction 合并后
 * 经 memory-cycle 下发给 Driver。
 */
export interface DriverContext {
  /**
   * 顶层 Agent 写给 Driver 的任务指令。
   * 由 planTaskInstruction 产出，不是 Coordinator 传入的 task.spec。
   */
  task_instruction: string;
  /** 入选技能，含 description 与 content 全文（排在经验之前，便于 Driver 优先关注） */
  skills: SkillRecord[];
  /** 入选经验，含 description 与 content 全文 */
  experiences: ExperienceRecord[];
}

/**
 * 技能晋升资格检查结果。
 * 判断经验是否满足晋升为 Skill 的条件及阻塞原因。
 */
export interface PromotionCheckResult {
  /** 是否满足晋升条件 */
  eligible: boolean;
  /** 是否可自动批准（无需人工审核） */
  auto_approved: boolean;
  /** 满足条件的说明 */
  reasons: string[];
  /** 阻止晋升的规则列表 */
  blocking_rules: string[];
}

/**
 * 技能晋升操作的完整结果。
 * 含晋升检查结论；晋升成功时附带新创建的 SkillRecord。
 */
export interface PromotionOutcome {
  check: PromotionCheckResult;
  /** 晋升成功时返回的新 Skill；未晋升时为 undefined */
  skill?: SkillRecord;
}

/**
 * Persona 演化操作的完整结果。
 * 含演化资格检查结论；演化成功时附带新生成的 PersonaDef（version 为旧版 +1）。
 */
export interface PersonaEvolutionOutcome {
  check: PromotionCheckResult;
  /** 演化成功时返回的新 Persona；未触发/未满足条件时为 undefined */
  persona?: PersonaDef;
}

/**
 * runTaskMemoryCycle / Agent.runOnce 的完整返回结果。
 * 涵盖任务前检索、Driver 调用、buffer 写入、经验提取与技能晋升的全链路产物。
 */
export interface MemoryCycleResult {
  /** 执行任务的 Agent role_id */
  agent_id: string;
  /**
   * 任务开始时的 Persona 快照。
   * 仅供顶层 Agent / 观测使用，未传入 DriverContext。
   */
  persona: PersonaDef;
  /** 任务开始前的技能列表（用于对比晋升前后变化） */
  skills_before: SkillRecord[];
  /**
   * 记忆检索结果（仅 exp + skill）。
   * 与 driver_context 中记忆部分一致，不含 task_instruction。
   */
  retrieval: MemoryRetrievalResult;
  /** 实际下发给 Driver 的完整上下文（instruction + exp + skill） */
  driver_context: DriverContext;
  /** 写入 pending buffer 的 Driver 6 字段报告快照 */
  buffer_snapshot: BufferSnapshot;
  /** buffer 在 pending 队列中的序号 */
  buffer_seq: number;
  /** 从 buffer 提取的经验及统计 */
  extraction: ExtractionOutput;
  /** 技能晋升检查结果 */
  promotion: PromotionOutcome;
}

export type { MemoryRetrievalResult } from './services/memory-query';

// ──────────────────────────────────────────────────────────
// LiteLLM Memory Tool contracts
// ──────────────────────────────────────────────────────────

/** Interface for memory storage (injected by scaffold) */
export interface MemoryStore {
  search(query: string, limit?: number): Promise<MemoryEntry[]>;
  save(entry: MemoryEntry): Promise<void>;
  get(id: string): Promise<MemoryEntry | null>;
}

export interface MemoryEntry {
  id: string;
  type: 'experience' | 'skill' | 'fact' | 'context';
  content: string;
  tags?: string[];
  importance?: number;
  timestamp?: string;
  source?: string;
}
