/**
 * ──────────────────────────────────────────────────────────
 *  Memory 模块统一导出入口
 *
 *  按功能域分组，每组标明使用场景。
 *  ──────────────────────────────────────────────────────────
 *
 *  分层调用关系（自顶向下）：
 *
 *  外部调用者（Coordinator / BFF / 测试）
 *    │
 *    ├─ AgentManager                 ← 主要操作入口
 *    │    ├─ submitTask()            竞标→执行→写buffer
 *    │    ├─ collectCompetitionClaims()  仅竞标
 *    │    ├─ dispatchTask(role_id)   指定Agent执行
 *    │    └─ createAgent()           注册新Agent
 *    │
 *    ├─ RepositoryAgentBoardQuery    ← 只读查询入口
 *    │    ├─ listAgents()
 *    │    ├─ getAgent(role_id)
 *    │    ├─ listSkills(role_id)
 *    │    └─ listExperiences(role_id)
 *    │
 *    ├─ runTaskMemoryCycle()         ← 直接调用记忆周期
 *    ├─ buildDriverContext()         ← 上下文组装
 *    └─ writePendingBuffer()         ← 直接写buffer
 *
 *  各层依赖：
 *    AgentManager → Agent → AgentRunDeps（6个可注入依赖）
 *                   AgentRunDeps → LlmClient（LLM接口）
 *                                 → MemoryRepository（存储接口）
 */

// ════════════════════════════════════════════════════════
//  1. 跨模块契约 & 数据实体
//     给 Coordinator / 其他方向使用
// ════════════════════════════════════════════════════════

export * from './contract';
export * from './types';
export * as schemas from './schemas';

// ════════════════════════════════════════════════════════
//  2. 存储适配器
//     生产：PgMemoryRepository + FileBufferRepository
//     测试：InMemoryRepository + InMemoryBufferRepository
// ════════════════════════════════════════════════════════

export { InMemoryRepository } from './adapters/in-memory-repository';
export { InMemoryBufferRepository } from './adapters/in-memory-buffer-repository';
export {
  PgMemoryRepository,
  type PgMemoryRepositoryOptions,
} from './adapters/pg-memory-repository';
export { ensurePgMemorySchema } from './adapters/pg-memory-schema';
export {
  FileBufferRepository,
  type FileBufferRepositoryOptions,
} from './adapters/file-buffer-repository';

// ════════════════════════════════════════════════════════
//  3. LLM 客户端适配器
//     生产：LiteLLMClientAdapter（Vercel AI SDK，多Provider）
//     测试：MockLlmClient（预设响应）
// ════════════════════════════════════════════════════════

export { LiteLLMClientAdapter } from './adapters/litellm-client-adapter';
export { MockLlmClient } from './adapters/mock-llm-client';
export { LiteLLMEmbeddingProvider } from './adapters/litellm-embedding-provider';

// ════════════════════════════════════════════════════════
//  4. LLM 处理适配器（通过 LlmClient 接口依赖注入）
// ════════════════════════════════════════════════════════

export { LlmExperienceExtractor } from './adapters/llm-experience-extractor';
export { LlmContextCleaner } from './adapters/context-cleaner';
export { LlmSkillPromotion } from './adapters/llm-skill-promotion';

// ════════════════════════════════════════════════════════
//  5. 非 LLM 适配器（降级/测试用）
// ════════════════════════════════════════════════════════

export { NullContextCleaner } from './adapters/null-context-cleaner';
export { RuleBasedExperienceExtractor } from './adapters/rule-based-experience-extractor';
export { ruleBasedSkillPromotion } from './services/skill-promotion';
export { repositoryRetrieveMemoryForTask } from './adapters/repository-memory-retrieval';

// ════════════════════════════════════════════════════════
//  6. AgentMemoryScope（Agent与Repository之间的绑定门面）
// ════════════════════════════════════════════════════════

export { createAgentMemoryScope } from './adapters/agent-memory-scope';

// ════════════════════════════════════════════════════════
//  8. 服务层（可直接调用的编排函数）
// ════════════════════════════════════════════════════════

export { writePendingBuffer } from './services/buffer-writer';
export { prepareTaskContext, type MemoryQueryStrategy } from './services/memory-query';
export {
  retrieveMemoriesForTask,
  type MemoryRetrievalOptions,
  type MemoryRelevancePolicy,
  type RetrieveMemoriesInput,
} from './adapters/memory-retrieval';
export {
  ingestTaskBuffer,
  processPendingBuffer,
  extractBuffer,
  promoteExperiences,
  extractBufferForAgent,
  promoteExperiencesForAgent,
  extractAllBuffers,
  promoteAllExperiences,
} from './services/memory-cycle';

// ════════════════════════════════════════════════════════
//  9. MemoryProvider（给 Coordinator 用）
// ════════════════════════════════════════════════════════

export { MockMemoryProvider } from './mock-memory';
export { RepositoryMemoryProvider } from './adapters/repository-memory-provider';

// ════════════════════════════════════════════════════════
//  10. AgentBoardQuery（对外只读查询门面，供BFF/前端使用）
// ════════════════════════════════════════════════════════

export { RepositoryAgentBoardQuery } from './adapters/agent-board-query';

// ════════════════════════════════════════════════════════
//  11. Agent 运行时
// ════════════════════════════════════════════════════════

export { Agent } from './runtime/agent';
export {
  AgentManager,
  type AgentManagerOptions,
  type DispatchTaskResult,
  type MemoryTaskProjection,
  toMemoryTaskProjection,
} from './runtime/agent-manager';

// ════════════════════════════════════════════════════════
//  12. 离线 BufferProcessor 运行时
// ════════════════════════════════════════════════════════

export { ExperienceExtractorProcessor } from './runtime/experience-extractor-processor';
export { SkillPromotionProcessor } from './runtime/skill-promotion-processor';

// ════════════════════════════════════════════════════════
//  13. Tool-calling 运行时（Agent loop 工具调用模式）
// ════════════════════════════════════════════════════════

export { ToolRegistry } from './runtime/tool';
export { QueryMemoryTool as AgentQueryMemoryTool } from './runtime/tools/query-memory-tool';
export { InvokeDriverTool } from './runtime/tools/invoke-driver-tool';
export type { DriverTask, DriverHandler } from './runtime/tools/invoke-driver-tool';
export { DeepSeekToolCallingClient } from './adapters/deepseek-tool-calling-client';
export type { DeepSeekToolCallingClientOptions } from './adapters/deepseek-tool-calling-client';
export { LiteLLMToolCallingClient } from './adapters/litellm-tool-calling-client';
export type { LiteLLMToolCallingClientOptions } from './adapters/litellm-tool-calling-client';

// ════════════════════════════════════════════════════════
//  14. Litellm 集成工具（memory 侧实现的 litellm tool）
// ════════════════════════════════════════════════════════

export { QueryMemoryTool, SaveMemoryTool, createMemoryTools } from './litellm-memory-tools';

// ════════════════════════════════════════════════════════
//  15. 生产级运行时引导
// ════════════════════════════════════════════════════════

export { createAgentRuntime } from './runtime/create-agent-runtime';
export type { AgentRuntimeConfig } from './runtime/create-agent-runtime';

// ════════════════════════════════════════════════════════
//  16. Prompt 模板
// ════════════════════════════════════════════════════════

export { buildAgentSystemPrompt } from './prompts/agent-system-prompt';

// ════════════════════════════════════════════════════════
//  17. Buffer 触发策略
// ════════════════════════════════════════════════════════

export { BatchBufferTriggerPolicy } from './adapters/batch-buffer-trigger-policy';
export { AlwaysExtractPolicy } from './adapters/always-extract-policy';
export { DefaultPromotionTriggerPolicy } from './adapters/default-promotion-trigger-policy';

// ════════════════════════════════════════════════════════
//  18. 竞争派单（Competition Claim）
//     Agent 自评是否参选 + 竞标收集
// ════════════════════════════════════════════════════════

export type {
  CompetitionDecision,
  AgentCompetitionClaimContent,
  AgentCompetitionClaim,
  CompetitionClaimBatch,
  CollectCompetitionClaimsOptions,
} from './competition-types';
export type { CompetitionClaimEvaluator } from './ports/competition-claim-evaluator';
export { createMockCompetitionClaimEvaluator } from './adapters/mock-competition-claim-evaluator';

// ════════════════════════════════════════════════════════
//  19. Mock 适配器
// ════════════════════════════════════════════════════════

export { MockExperienceExtractor } from './mvp/adapters/mock-experience-extractor';

// ════════════════════════════════════════════════════════
//  20. Port 接口类型（供外部实现者使用）
// ════════════════════════════════════════════════════════

export type { BufferRepository, SaveBufferResult } from './ports/buffer-repository';
export type { MemoryRepository, MemoryVectorSearchOptions } from './ports/memory-repository';
export type { AgentMemoryScope } from './ports/agent-memory-scope';
export type { ExperienceExtractor } from './ports/experience-extractor';
export type { EmbeddingProvider } from './ports/embedding-provider';
export type { LlmClient, LlmMessage } from './ports/llm-client';
export type { SkillMarketPort, SkillMarketSearchResult } from './ports/skill-market-port';
export type { AgentContextCleaner, AgentContextCleanInput } from './ports/agent-context-cleaner';
export type { BufferTriggerPolicy } from './ports/buffer-trigger-policy';
export type { PromotionTriggerPolicy } from './ports/promotion-trigger-policy';
export type {
  AgentBoardQuery,
  AgentBoardListItem,
  AgentBoardAgentView,
  SkillView,
  ExperienceView,
} from './ports/agent-board-query';
export type {
  ExternalMemoryRepository,
  SearchAccessibleMemoriesInput,
  SearchAccessibleMemoriesOutput,
  SearchAccessibleMemoryHit,
  LoadAccessibleMemoriesInput,
  LoadAccessibleMemoriesOutput,
  RecordMemoryUsageFeedbackInput,
  MemoryItemType,
} from './ports/external-memory-repository';

// ════════════════════════════════════════════════════════
//  21. Agent 运行时类型
// ════════════════════════════════════════════════════════

export type { AgentTaskRequest, AgentLoopState } from './agent-types';
export type { AgentToolConfig } from './runtime/agent';

// ════════════════════════════════════════════════════════
//  22. Tool-calling 类型
// ════════════════════════════════════════════════════════

export type {
  Tool,
  ToolDefinition,
  ToolCall,
  ToolCallMessage,
  ToolCallResult,
  ToolCallingClient,
} from './runtime/tool';
