/**
 * ExperienceExtractor 端口
 *
 * 从 BufferSnapshot + 可选 AgentContextSnapshot 提取结构化经验候选（CandidateExperience）。
 * 实现见 adapters/rule-based-experience-extractor.ts 与 adapters/llm-experience-extractor.ts。
 *
 * **归属不由提取器决定**：产出里没有 `agent_id`——一条 Buffer 属于哪个 Agent 只有
 * `memory.role_id` 说得准，提取器拿不到它。落库时由持久化层
 * （persistExtractedExperiences）统一补上 role_id，`source_task_id` 只作溯源。
 * 因此任何提取入口都不可能写出空 agent_id 或挂到别的 Agent 名下。
 */
import type { AgentContextSnapshot, BufferSnapshot } from "../schemas";
import type { ExtractionOutput } from "../types";

export interface ExperienceExtractor {
  extract(
    snapshot: BufferSnapshot,
    agentContext?: AgentContextSnapshot,
  ): Promise<ExtractionOutput>;
}
