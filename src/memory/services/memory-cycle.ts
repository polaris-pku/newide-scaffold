/**
 * memory-cycle — 任务记忆后处理服务
 *
 * 提供主动提取/晋升函数，以及 buffer 写入/处理。
 */
import { createHash } from 'node:crypto';
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
import type { CallJournalPort } from '../ports/call-journal';
import type { ExtractionOutput, PromotionOutcome, CandidateExperience } from '../types';
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
 *
 * 留档说明（B1）：只有本函数（生产提取路径，maintenance runner 驱动）接入
 * CallJournalPort；extractBuffer / extractAllBuffers 无生产调用方且没有 task/run
 * 身份可填，不留档——将来获得调用方时复用同一 record 模式。
 */
export interface ProcessPendingInput {
  task: AgentTaskRequest;
  extractor: ExperienceExtractor;
  promote: (
    memory: AgentMemoryScope,
    task: AgentTaskRequest,
    experiences: ExperienceRecord[],
  ) => Promise<PromotionOutcome>;
  /** 进程内调用留档端口（可选）：缺省不留档，行为不变 */
  callJournal?: CallJournalPort;
}

/** processPendingBuffer 的返回：提取结果 + 晋升结果 */
export interface ProcessPendingResult {
  extraction: ExtractionOutput;
  promotion: PromotionOutcome;
}

/**
 * extract 留档 call_id 的进程内尝试序号：Date.now() 在同毫秒内会碰撞，
 * 拼上单调序号保证每次尝试（含快速失败重试）的 call_id 唯一。
 */
let extractAttemptSequence = 0;

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
 * 提取结果的稳定身份。
 *
 * 提取落库的粒度是**整条 Buffer**（保存第 N 条失败 → 重试整条），而提取器给出的 id 是
 * 当场生成的随机 UUID：重试会把前面已经写成功的那些再写一遍，一条 Buffer 反复失败就会
 * 攒出成倍的副本。这里把 id 换成由 `(role_id, buffer_seq, 第 i 条)` 推出的确定性 UUID
 * （RFC 4122 v5 形状，SHA-256 当摘要函数），「同一份提取结果的第 i 条」在任何一次重试里
 * 都是同一条，重复执行撞在同一个 id 上，再由 persistExtractedExperiences 认出来跳过。
 *
 * 用位置索引而不是内容派生：LLM 提取重试时可能给出措辞不同的同一批经验，按内容派生会把
 * 它们当成新条目。位置保证「一条 Buffer 至多留下提取结果长度份经验」这个上界。
 */
export function stableExperienceId(role_id: string, buffer_seq: number, index: number): string {
  return deterministicUuid(
    `newide:experience:${role_id}\u0000${String(buffer_seq)}\u0000${String(index)}`,
  );
}

/** 由种子串派生一个 UUID v5 形状的标识（同一 seed 永远得到同一 id）。 */
function deterministicUuid(seed: string): string {
  const bytes = Buffer.from(createHash('sha256').update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5（name-based）
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** persistExtractedExperiences 的结果 */
export interface PersistedExtraction {
  /** 落库之后，这批提取结果在仓库里的样子（本次写入的 + 之前已在的同 id 条目） */
  experiences: ExperienceRecord[];
  /** 本次真正写入仓库的条数 */
  created: number;
  /** 撞上稳定 id、仓库里已有同一条、被跳过的条数 */
  already_present: number;
}

/**
 * 把一次提取的产出落库，三条规则合在一处：
 *
 * 1. **稳定身份**：id 由 (role_id, buffer_seq, 序号) 决定（见 stableExperienceId），重试
 *    认得出「这条已经写过」。
 * 2. **归属补齐**：owner 的唯一权威是 Buffer 所属的 role_id（`memory.role_id`）——
 *    不是上下文快照里的 agent_id，更不是 `source_task_id`（那是任务溯源字段，不是归属）。
 *    提取器产出的候选经验**没有** agent_id 字段（见 CandidateExperience），所以无论有没有
 *    上下文快照，最终落库的 agent_id 都由这里定死为 role_id，不可能出现空串或错主。
 * 3. **幂等落库**：逐条走 saveExperienceIfAbsent（唯一键 = Experience.id）。它把「查有没有」
 *    与「写进去」合并在存储层原子完成，因此**并发重入**也只会留下一条——两个独立的 Memory
 *    Maintenance worker 同时处理同一个 `(role_id, buffer_seq)` 时，谁都不会写出副本，谁也
 *    不会收到主键冲突。命中的那一条返回的是**仓库里已有**的记录，跳过条数如实交回调用方。
 *
 * 不吞异常：任何一条写失败都原样抛出，由调用方（维护 runner）转成可重试的 failed evidence。
 * 已经写进去的不需要回滚——重试时第 3 条规则会把它们跳过。
 */
export async function persistExtractedExperiences(
  memory: AgentMemoryScope,
  buffer_seq: number,
  experiences: readonly CandidateExperience[],
): Promise<PersistedExtraction> {
  const persisted: ExperienceRecord[] = [];
  let created = 0;

  for (const [index, experience] of experiences.entries()) {
    const candidate: ExperienceRecord = {
      ...experience,
      id: stableExperienceId(memory.role_id, buffer_seq, index),
      agent_id: memory.role_id,
    };
    const stored = await memory.saveExperienceIfAbsent(candidate);
    persisted.push(stored.experience);
    if (stored.created) created += 1;
  }

  return {
    experiences: persisted,
    created,
    already_present: experiences.length - created,
  };
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
  assertContextUsable(memory.role_id, seq, pending);

  // 进程内调用留档（B1）：收尾时单点上报，成功与失败都记；call_id 每次尝试唯一
  // （时刻 + 进程内序号，同毫秒重试也不撞），否则首次失败行会因 journal 幂等索引
  // 吞掉重试的成功行。留档失败绝不影响提取主流程（best-effort）。
  const journal = input.callJournal;
  const startedAt = Date.now();
  const attemptSeq = ++extractAttemptSequence;
  const record = (status: 'ok' | 'error', summary: string): void => {
    if (!journal) return;
    try {
      journal.record({
        call_id: `extract:${memory.role_id}:${String(seq)}:${String(startedAt)}:${String(attemptSeq)}`,
        event: 'extract',
        task_id: input.task.task_id ?? pending.snapshot.task_id,
        run_id: input.task.run_id,
        role_id: memory.role_id,
        workspace_path: input.task.workspace_path,
        status,
        summary: summary.slice(0, 300),
        duration_ms: Date.now() - startedAt,
        completed_at: nowTimestamp(),
      });
    } catch {
      // best-effort：留档绝不打断提取流程（对齐 recordDispatchMetrics 惯用法）
    }
  };

  try {
    const extraction = await input.extractor.extract(pending.snapshot, pending.agentContext);

    const persisted = await persistExtractedExperiences(memory, seq, extraction.experiences);
    // 证据里列出的是**仓库里实际有的**那一批（重试命中的旧条目内容与本次提取可能不同），
    // 不是本次提取器的瞬时产物——否则 evidence 与 memory 会对不上。落库的那一批带着
    // 补齐后的 agent_id，晋升必须拿它（而不是候选）作为输入。
    extraction.experiences = persisted.experiences;
    if (persisted.already_present > 0) {
      extraction.warnings = [
        ...(extraction.warnings ?? []),
        `${String(persisted.already_present)} extracted experience(s) already existed for Buffer ` +
          `${memory.role_id}:${String(seq)} and were not written again.`,
      ];
    }

    const promotion = await input.promote(memory, input.task, persisted.experiences);
    if (promotion.skill) {
      extraction.result.skills_promoted = 1;
    }

    await memory.markBufferProcessed(seq);
    record(
      'ok',
      `experiences=${String(extraction.experiences.length)} skills_promoted=${String(extraction.result.skills_promoted)}`,
    );
    return { extraction, promotion };
  } catch (error) {
    record('error', error instanceof Error ? error.message : String(error));
    throw error;
  }
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
  assertContextUsable(memory.role_id, seq, pending);

  const extraction = await extractor.extract(pending.snapshot, pending.agentContext);

  const persisted = await persistExtractedExperiences(memory, seq, extraction.experiences);
  extraction.experiences = persisted.experiences;
  if (persisted.already_present > 0) {
    extraction.warnings = [
      ...(extraction.warnings ?? []),
      `${String(persisted.already_present)} extracted experience(s) already existed for Buffer ` +
        `${memory.role_id}:${String(seq)} and were not written again.`,
    ];
  }

  return extraction;
}

/**
 * 提取前的上下文可用性闸门：声明过 context_snapshot_ref 却读不出上下文时**拒绝提取**。
 *
 * 这种 Buffer 的报告那一半是好的、上下文那一半丢了（文件缺失 / JSON 损坏 / schema 不匹配）。
 * 若放行，`pending.agentContext` 会是 undefined，提取器只拿到报告，把「半份输入」当成
 * 「本次没有上下文」——丢失就这样被静默地做成了一条不完整的经验。宁可失败，也不要一份
 * 假装完整的产物：调用方（processBuffer / replayPending）会把这条如实报成 failed evidence。
 *
 * 历史 Buffer（没有 context_snapshot_ref）不受影响：那是写入侧确实没做上下文清理，
 * `agentContextStatus === 'absent'`，兼容降级照旧。
 */
function assertContextUsable(
  roleId: string,
  seq: number,
  pending: { agentContextStatus: string; agentContextError?: string },
): void {
  if (pending.agentContextStatus === 'unreadable') {
    throw new Error(
      pending.agentContextError ??
        `Agent context for Buffer ${roleId}:${String(seq)} could not be read; refusing to extract from a partial input.`,
    );
  }
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
