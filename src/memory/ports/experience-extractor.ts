/**
 * ExperienceExtractor 端口
 *
 * 从 BufferSnapshot + 可选 AgentContextSnapshot 提取结构化经验（ExperienceRecord）。
 * 实现见 adapters/rule-based-experience-extractor.ts 与 adapters/llm-experience-extractor.ts。
 */
import type { AgentContextSnapshot, BufferSnapshot } from "../schemas";
import type { ExtractionOutput } from "../types";

export interface ExperienceExtractor {
  extract(
    snapshot: BufferSnapshot,
    agentContext?: AgentContextSnapshot,
  ): Promise<ExtractionOutput>;
}
