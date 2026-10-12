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
export { cosineSimilarity } from './utils/vector';
export {
  PgMemoryRepository,
  type PgMemoryRepositoryOptions,
} from './adapters/pg-memory-repository';
export { ensurePgMemorySchema } from './adapters/pg-memory-schema';
export {
  createPGlitePool,
  PGlitePool,
  type PGlitePoolOptions,
} from './adapters/pglite-pool';
export type { SqlPool, SqlClient, SqlQueryResult } from './ports/sql-pool';
export {
  FileBufferRepository,
  type FileBufferRepositoryOptions,
} from './adapters/file-buffer-repository';
export { InMemoryMemoryDeliveryRepository } from './adapters/in-memory-memory-delivery';
export {
  FileMemoryDeliveryRepository,
  type FileMemoryDeliveryRepositoryOptions,
} from './adapters/file-memory-delivery';

// ════════════════════════════════════════════════════════
//  3. LLM 客户端适配器
//     生产：LiteLLMClientAdapter（Vercel AI SDK，多Provider）
//     测试：MockLlmClient（预设响应）
// ════════════════════════════════════════════════════════

export { LiteLLMClientAdapter } from './adapters/litellm-client-adapter';
export { MockLlmClient } from './adapters/mock-llm-client';
export { LiteLLMEmbeddingProvider } from './adapters/litellm-embedding-provider';
export {
  HashEmbeddingProvider,
  defaultHashEmbeddingProvider,
} from './adapters/hash-embedding-provider';

// ════════════════════════════════════════════════════════
//  4. LLM 处理适配器（通过 LlmClient 接口依赖注入）
// ════════════════════════════════════════════════════════

export { LlmExperienceExtractor } from './adapters/llm-experience-extractor';
export { LlmContextCleaner } from './adapters/context-cleaner';
export { LlmSkillPromotion } from './adapters/llm-skill-promotion';
export { LlmPersonaInduction } from './adapters/llm-persona-induction';

// ════════════════════════════════════════════════════════
//  5. 非 LLM 适配器（降级/测试用）
// ════════════════════════════════════════════════════════

export { NullContextCleaner } from './adapters/null-context-cleaner';
export { RuleBasedExperienceExtractor } from './adapters/rule-based-experience-extractor';
export { ruleBasedSkillPromotion } from './services/skill-promotion';
export { ruleBasedPersonaInduction } from './services/rule-based-persona-induction';
export {
  reviewSkill,
  type ReviewSkillInput,
  type SkillReviewDecision,
} from './services/skill-review';
export {
  createSkill,
  updateSkill,
  deleteSkill,
  publishSkillToMarket,
  updateExperience,
  deleteExperience,
  promoteExperienceToSkill,
  type CreateSkillInput,
  type CreateSkillOptions,
  type PromoteExperienceInput,
  type SkillWritePatch,
  type ExperienceWritePatch,
} from './services/memory-writer';
export {
  mergePersonaPatch,
  regeneratePersona,
  type PersonaPatch,
  type PersonaInducer,
} from './services/persona-update';
export {
  applyUserRating,
  type RateTaskInput,
  type UserRatingResult,
} from './services/feedback';
export {
  applyUsageFeedback,
  type UsageReference,
  type UsageFeedbackEntry,
  type UsageFeedbackResult,
} from './services/usage-feedback';
export {
  buildContextDeliveryItem,
  buildDriverUsageFeedbackRecords,
  contextDeliveryId,
  contextDeliveryKey,
  driverFeedbackId,
  driverFeedbackKey,
  type ContextDeliveryInput,
  type DriverFeedbackInput,
  type DriverReferencedExperience,
} from './services/context-delivery';
export {
  computeMemoryOverview,
  type MemoryOverview,
} from './services/memory-overview';
export { repositoryRetrieveMemoryForTask } from './adapters/repository-memory-retrieval';
export {
  resolveMemoryAblationPolicy,
  runWithMemoryAblationPolicy,
  getActiveMemoryAblationPolicy,
  type MemoryAblation,
  type MemoryAblationPolicy,
} from './ablation-policy';

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
  persistExtractedExperiences,
  stableExperienceId,
  type PersistedExtraction,
  type MemoryScopeFactory,
  promoteExperiences,
  extractBufferForAgent,
  promoteExperiencesForAgent,
  extractAllBuffers,
  promoteAllExperiences,
} from './services/memory-cycle';

// ════════════════════════════════════════════════════════
//  8.5 Metrics 采集与退休（Agent 生命周期管理）
// ════════════════════════════════════════════════════════

export {
  recordBid,
  recordTaskOutcome,
  evaluateRetirementSignals,
  RETIREMENT_THRESHOLDS,
  type TaskOutcome,
  type RetirementSignals,
} from './services/metrics';
export {
  disposeRetiredAssets,
  createReplacementAgent,
  replacementRoleIdFor,
  type RetireOptions,
  type RetireResult,
  type RetireAssetDisposition,
  type RetireAssetInput,
} from './services/retirement';

// ════════════════════════════════════════════════════════
//  8.6 技能市场（Skill Market）
//     skill.market_search / skill.market_import（Spec §6.2）
// ════════════════════════════════════════════════════════

export {
  marketSearch,
  marketImport,
  DEFAULT_MARKET_TOP_K,
  type MarketSearchQuery,
} from './services/skill-market';
export type {
  ExperienceFeedbackApplication,
  ExperienceFeedbackOutcome,
  ExperienceFeedbackResult,
  ExperienceSaveResult,
  MarketSearchOptions,
  MarketImportResult,
  SkillSaveResult,
  TransferSkillToMarketOptions,
} from './ports/memory-repository';
/** 技能市场池 Agent 的固定 role_id（退休技能迁移至此名下） */
export { MARKET_POOL_ROLE_ID } from './schemas';
/** 某个字符串能不能命名一条经验（引用准入判据，见 schemas.canNameExperience） */
export { canNameExperience } from './schemas';

// ════════════════════════════════════════════════════════
//  8.7 三重门控退休检测（week3 RFC §8.2 触发机制）
//     RetirementDetector + 统计 / Persona 漂移 / LLM 三层评估器
// ════════════════════════════════════════════════════════

export { RetirementDetector } from './services/retirement-detection';
export { StatisticalRetirementEvaluator } from './services/retirement-detection';
export { PersonaDriftEvaluator, computePersonaDrift } from './services/retirement-detection';
export { LlmRetirementEvaluator } from './services/retirement-detection';
export {
  parseRetirementEvaluation,
  buildRetirementEvaluationUserPrompt,
  suggestRetireReason,
} from './services/retirement-detection';
export {
  RETIREMENT_COOLDOWNS,
  PERSONA_DRIFT_THRESHOLDS,
  type RetirementAction,
  type RetirementLayer,
  type RetirementEvaluation,
  type RetirementEvaluationInput,
  type RetirementEvaluator,
  type RetirementLayerOutcome,
  type RetirementScanResult,
  type RetirementDetectorOptions,
} from './services/retirement-detection';

// ════════════════════════════════════════════════════════
//  8.8 市场自学习（存活 Agent 扫描市场引入技能）
//     决策 = tag 相似度 + persona 相似度加权
// ════════════════════════════════════════════════════════

export {
  learnSkillsForAgent,
  buildLearningQuery,
  computeTagSimilarity,
  evaluateSkillLearning,
  DEFAULT_SKILL_LEARNING_OPTIONS,
} from './services/skill-learning';
export type {
  SkillLearningOptions,
  SkillLearningDecision,
  SkillLearningOutcome,
} from './services/skill-learning';

// ════════════════════════════════════════════════════════
//  8.9 向量索引维护（memory.reindex：切换 embedding 模型后全量重建索引）
// ════════════════════════════════════════════════════════

export {
  reindexMemory,
  type ReindexMemoryOptions,
  type ReindexMemoryResult,
  type ReindexFailure,
} from './services/memory-reindex';

// ════════════════════════════════════════════════════════
//  9. MemoryProvider（给 Coordinator 用）
// ════════════════════════════════════════════════════════

export { MockMemoryProvider } from './mock-memory';
export { RepositoryMemoryProvider } from './adapters/repository-memory-provider';

// ════════════════════════════════════════════════════════
//  10. AgentBoardQuery（对外只读查询门面，供BFF/前端使用）
// ════════════════════════════════════════════════════════

export { RepositoryAgentBoardQuery } from './adapters/agent-board-query';
export { toSkillView, toExperienceView } from './adapters/agent-board-query';

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
export { PersonaEvolutionProcessor } from './runtime/persona-evolution-processor';

// ════════════════════════════════════════════════════════
//  13. Tool-calling 运行时（Agent loop 工具调用模式）
// ════════════════════════════════════════════════════════

export { ToolRegistry } from './runtime/tool';
export { QueryMemoryTool as AgentQueryMemoryTool } from './runtime/tools/query-memory-tool';
export { InvokeDriverTool } from './runtime/tools/invoke-driver-tool';
export type { DriverTask, DriverHandler } from './runtime/tools/invoke-driver-tool';
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
export { DefaultPersonaTriggerPolicy } from './adapters/default-persona-trigger-policy';

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
//  20. Port 接口类型（供外部实现者使用）
// ════════════════════════════════════════════════════════

export type {
  AgentContextReadStatus,
  BufferArchiveOutcome,
  BufferLocation,
  BufferRepository,
  DeadLetterEntry,
  PendingBufferRead,
  SaveBufferResult,
  StoredBuffer,
} from './ports/buffer-repository';
export type {
  MemoryDeliveryRepository,
  ContextDeliveryFilter,
  DriverFeedbackFilter,
  PendingFeedbackFilter,
  DeliverySubmitResult,
  DeliveryChannel,
  DeliveryClaimRequest,
  DeliveryRecordLocator,
  DeliveryRepositoryPolicy,
  ClaimedDelivery,
  ClaimedContextDelivery,
  ClaimedDriverFeedback,
  ClaimedPendingFeedback,
} from './ports/memory-delivery';
export {
  DEFAULT_DELIVERY_LEASE_MS,
  DEFAULT_DELIVERY_LOCK_TTL_MS,
  DEFAULT_DELIVERY_RETRY_POLICY,
  DEFAULT_FEEDBACK_CONSUME_RETRY_POLICY,
  DEFAULT_PENDING_FEEDBACK_RETRY_POLICY,
  DEFAULT_PROMOTION_RETRY_POLICY,
  newClaimToken,
  resolveChannelRetryPolicy,
  type DeliveryChannelKind,
  type DeliveryRetryPolicy,
} from './services/delivery-lifecycle';

// ════════════════════════════════════════════════════════
//  2b. Memory Maintenance：交付/反馈以外的维护侧持久化
//      维护 run 是观测与审计实体；文件与内存两种后端共用同一套转移规则。
// ════════════════════════════════════════════════════════

export {
  classifyDeliveryFailure,
  isRetryableDeliveryFailure,
  knownDeliveryFailure,
  type DeliveryFailureClassification,
} from './services/delivery-error-classification';
export { InMemoryMaintenanceRunStore } from './adapters/in-memory-maintenance-run-store';
export {
  FileMaintenanceRunStore,
  type FileMaintenanceRunStoreOptions,
} from './adapters/file-maintenance-run-store';
export type {
  MaintenanceRunStore,
  StartMaintenanceRunInput,
  FinishMaintenanceRunInput,
  MaintenanceRunQuery,
} from './ports/maintenance-run-store';
export type {
  ExperiencePromotion,
  MaintenanceFailure,
  MaintenanceFailureCode,
  MaintenanceJobType,
  MaintenanceRun,
  MaintenanceRunAudit,
  MaintenanceRunCandidateAudit,
  MaintenanceRunCounts,
  MaintenanceRunInputSnapshotAudit,
  MaintenanceRunParentVersionRange,
  MaintenanceRunStatus,
  PendingFeedbackRecord,
  PromotionOutcome,
} from './schemas';
// 晋升状态的读取面返回的就是这两个实体：`listPromotionCandidates` / `listExperiences` 给
// `ExperienceRecord`，`listSkills` / `saveSkillIfAbsent` 给 `SkillRecord`。外部维护 runner
// 要能接住这两个返回值，所以它们必须是一等导出，而不是只能绕 `schemas` 命名空间拿
export type { ExperienceRecord, SkillRecord } from './schemas';
export {
  EMPTY_MAINTENANCE_RUN_COUNTS,
  applyMaintenanceRunLimit,
  compareMaintenanceRuns,
  completeMaintenanceRun,
  createMaintenanceRun,
  createMaintenanceRunId,
  failMaintenanceRun,
  isMaintenanceRunTerminal,
  mergeMaintenanceRunAudit,
  mergeMaintenanceRunCounts,
  selectMaintenanceRuns,
} from './services/maintenance-run-lifecycle';

// ════════════════════════════════════════════════════════
//  2c. Memory Maintenance：上下文消费（Phase 1）
//      交付项 → Experience 的消费内核 + 批量运行外壳。它只吃 context 通道，
//      不晋升 Skill、不演化 Persona —— 那两件事是后续独立的 job。
// ════════════════════════════════════════════════════════

export {
  DefaultContextDeliveryProcessor,
  type ContextDeliveryProcessOutcome,
  type ContextDeliveryProcessContext,
  type ContextDeliveryProcessStatus,
  type ContextDeliveryProcessor,
  type ContextDeliveryProcessorOptions,
} from './runtime/context-delivery-processor';
export {
  ContextDeliveryWorker,
  DEFAULT_CONTEXT_DELIVERY_BATCH_SIZE,
  DEFAULT_CONTEXT_DELIVERY_MAX_DURATION_MS,
  type ContextDeliveryRestoreResult,
  type ContextDeliveryRunOptions,
  type ContextDeliveryRunResult,
  type ContextDeliveryStopReason,
  type ContextDeliveryWorkerOptions,
} from './runtime/context-delivery-worker';
export {
  SYSTEM_LEASE_TIMERS,
  leaseRenewIntervalMs,
  startLeaseHeartbeat,
  type LeaseHeartbeat,
  type LeaseHeartbeatOptions,
  type LeaseTimers,
} from './services/lease-heartbeat';
export {
  applyFeedbackToExperience,
  averageConfidence,
  isFeedbackApplied,
  nextConfidenceAfterFeedback,
  recomputeAvgConfidence,
} from './services/usage-feedback';
export {
  buildPendingFeedbackRecord,
  describePendingFeedbackBindingMismatch,
  feedbackApplicationOf,
  isSupportedFeedbackVersion,
  pendingFeedbackBindingMismatches,
  pendingFeedbackId,
} from './services/pending-feedback';

// ════════════════════════════════════════════════════════
//  2d. Memory Maintenance：反馈消费与归并（Phase 2）
//      outbox 里的 Driver 反馈 → 写进 Experience；经验还没出现就寄存进待归并队列，
//      由独立的归并 run 等它出现。它不调 scheduleBuffer、不晋升 Skill、不演化 Persona，
//      也不参与在线任务流程——在线流程只负责把反馈写进 outbox。
// ════════════════════════════════════════════════════════

export {
  DefaultDriverFeedbackProcessor,
  type DriverFeedbackApplicationOutcome,
  type DriverFeedbackProcessContext,
  type DriverFeedbackProcessOutcome,
  type DriverFeedbackProcessStatus,
  type DriverFeedbackProcessor,
  type DriverFeedbackProcessorOptions,
} from './runtime/driver-feedback-processor';
export {
  DriverFeedbackWorker,
  DEFAULT_DRIVER_FEEDBACK_BATCH_SIZE,
  DEFAULT_DRIVER_FEEDBACK_MAX_DURATION_MS,
  type DriverFeedbackJob,
  type DriverFeedbackRestoreResult,
  type DriverFeedbackRunOptions,
  type DriverFeedbackRunResult,
  type DriverFeedbackStopReason,
  type DriverFeedbackWorkerOptions,
} from './runtime/driver-feedback-worker';
export type { MemoryRepository, MemoryVectorSearchOptions } from './ports/memory-repository';
export type { AgentMemoryScope } from './ports/agent-memory-scope';
export type { ExperienceExtractor } from './ports/experience-extractor';
export type { EmbeddingProvider } from './ports/embedding-provider';
export type { LlmClient, LlmMessage } from './ports/llm-client';
export type { AgentContextCleaner, AgentContextCleanInput } from './ports/agent-context-cleaner';
export type { CallJournalPort, CallJournalEvent } from './ports/call-journal';
export type { BufferTriggerPolicy } from './ports/buffer-trigger-policy';
export type { PromotionTriggerPolicy } from './ports/promotion-trigger-policy';
export type { PersonaTriggerPolicy } from './ports/persona-trigger-policy';
export type { PersonaInductionInput } from './services/rule-based-persona-induction';
export type {
  AgentBoardQuery,
  AgentBoardListItem,
  AgentBoardAgentView,
  SkillView,
  ExperienceView,
  SkillListFilter,
  ExperienceListFilter,
} from './ports/agent-board-query';
export type { RoleTokenUsageReader } from './ports/role-token-usage';

// ════════════════════════════════════════════════════════
//  2e. Memory Maintenance：技能晋升（Phase 3）
//      独立的 Job：按可配置、可版本化的策略扫出候选，逐条判定，把结论落到经验自己的
//      晋升标记上（claim/lease/fencing 与交付通道共用同一套状态机）。它不从 Context
//      consumer、Feedback consumer、scheduleBuffer() 或在线 Driver 流程里被调用，也不
//      调用它们中的任何一个。
//      三段各自的落点：契约、策略、持久化状态（3-A）；单条候选的执行内核（3-B：原子幂等写
//      Skill + 回写经验 + 失败分类）；批量外壳（3-C：claim 循环、批大小与墙钟上限、run
//      记录与收尾、启动恢复、dry-run）。因为 Profile/Persona 归 Phase 4，这里没有任何
//      Persona 相关入口；而把 job 接进调度器（谁在什么时候跑它）归 Phase 5。
// ════════════════════════════════════════════════════════

export {
  DefaultPromotionStrategy,
  DEFAULT_PROMOTION_STRATEGY_CONFIG,
  DEFAULT_PROMOTION_STRATEGY_VERSION,
} from './adapters/default-promotion-strategy';
export {
  PROMOTION_APPROVAL_MODES,
  PROMOTION_BLOCKER_RULES,
  PROMOTION_VERDICTS,
} from './ports/promotion-strategy';
export type {
  PromotionApprovalMode,
  PromotionBlockerRule,
  PromotionDecision,
  PromotionEvaluationInput,
  PromotionStrategy,
  PromotionStrategyConfig,
  PromotionVerdict,
} from './ports/promotion-strategy';
export {
  comparePromotionCandidates,
  initialPromotionMarker,
  isPromotedExperience,
  planPromotionCandidate,
  promotionStateLabel,
  reevaluatePromotionMarker,
  selectPromotionCandidates,
  type PromotionCandidateInput,
  type PromotionCandidatePlan,
  type PromotionSkipReason,
  type PromotionStateLabel,
} from './services/promotion-candidates';
export type {
  ClaimedPromotionCandidate,
  PromotionCandidateQuery,
  PromotionClaimRequest,
  PromotionCompletionRequest,
  PromotionFailureRequest,
  PromotionRestoreOptions,
} from './ports/memory-repository';
export {
  AGENT_MISSING_PREFIX,
  PROMOTION_DECISION_CONTRACT_CODE,
  PromotionDecisionContractError,
  assertPromotionDecisionConsistent,
  auditPromotionDecision,
  buildPromotedSkill,
  classifyPromotionFailure,
  describeContractFailure,
  executePromotionCandidate,
  isPromotionDecisionContractError,
  type PromotionDecisionViolation,
  type PromotionExecutionOptions,
  type PromotionExecutionResult,
  type PromotionExecutionStatus,
  type PromotionExecutorDeps,
} from './services/promotion-executor';
export {
  DefaultSkillPromotionJob,
  DEFAULT_SKILL_PROMOTION_BATCH_SIZE,
  DEFAULT_SKILL_PROMOTION_MAX_DURATION_MS,
} from './runtime/skill-promotion-job';
export type {
  PromotionCandidateOutcome,
  PromotionCandidateStatus,
  PromotionRestoreResult,
  SkillPromotionJob,
  SkillPromotionJobOptions,
  SkillPromotionRunOptions,
  SkillPromotionRunResult,
  SkillPromotionStopReason,
} from './ports/skill-promotion-job';

// ════════════════════════════════════════════════════════
//  20b. Memory Maintenance：Persona 演化（Phase 4）
//      独立的 Persona 演化通道：策略端口与 job 契约、版本模型与演化标记、选候选与输入快照
//      的纯规则、判定契约与失败分类（4-A），持久化状态面与条件写（4-B），执行内核与批量
//      外壳（4-C）。跑一次用 `DefaultPersonaEvolutionJob`：它按角色 claim、逐条隔离、
//      写出一条 `persona_evolution` 的 maintenance run。
//
//      它只读已批准 / 已生效的技能与晋升状态已落定的经验，由外部调度器独立触发；在线
//      Driver、Context consumer、Feedback consumer 与 Skill Promotion 都不调用它，它也
//      不调用它们中的任何一个。
// ════════════════════════════════════════════════════════

export {
  DEFAULT_PERSONA_EVOLUTION_STRATEGY_CONFIG,
  DEFAULT_PERSONA_EVOLUTION_STRATEGY_VERSION,
  DefaultPersonaEvolutionStrategy,
} from './adapters/default-persona-evolution-strategy';
export {
  PERSONA_EVOLUTION_APPROVAL_MODES,
  PERSONA_EVOLUTION_BLOCKER_RULES,
  PERSONA_EVOLUTION_VERDICTS,
} from './ports/persona-evolution-strategy';
export type {
  PersonaEvolutionApprovalMode,
  PersonaEvolutionBlockerRule,
  PersonaEvolutionDecision,
  PersonaEvolutionEvaluationInput,
  PersonaEvolutionExperienceSnapshot,
  PersonaEvolutionFeedbackSummary,
  PersonaEvolutionInputSnapshot,
  PersonaEvolutionLastRun,
  PersonaEvolutionPersonaDraft,
  PersonaEvolutionSkillSnapshot,
  PersonaEvolutionStrategy,
  PersonaEvolutionStrategyConfig,
  PersonaEvolutionVerdict,
} from './ports/persona-evolution-strategy';
export type {
  PersonaEvolutionCandidateOutcome,
  PersonaEvolutionCandidateStatus,
  PersonaEvolutionJob,
  PersonaEvolutionJobOptions,
  PersonaEvolutionRestoreResult,
  PersonaEvolutionRunOptions,
  PersonaEvolutionRunResult,
  PersonaEvolutionStopReason,
} from './ports/persona-evolution-job';
export {
  DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY,
} from './services/delivery-lifecycle';
export {
  buildPersonaEvolutionSnapshot,
  compareRecordsById,
  initialPersonaEvolutionMarker,
  isApprovedSkill,
  isEligibleExperience,
  personaEvolutionBatchSnapshotDigest,
  personaEvolutionIdempotencyKey,
  personaEvolutionInputSnapshotHash,
  personaEvolutionLastRun,
  personaEvolutionStateLabel,
  planPersonaEvolutionCandidate,
  reevaluatePersonaEvolutionMarker,
  selectApprovedSkills,
  selectEligibleExperiences,
  type PersonaEvolutionCandidateInput,
  type PersonaEvolutionCandidatePlan,
  type PersonaEvolutionFeedbackSummaryInput,
  type PersonaEvolutionSkipReason,
  type PersonaEvolutionStateLabel,
} from './services/persona-evolution-candidates';
export {
  PERSONA_EVOLUTION_DECISION_CONTRACT_CODE,
  PERSONA_EVOLUTION_FAILURE_KINDS,
  PersonaEvolutionDecisionContractError,
  assertPersonaEvolutionDecisionConsistent,
  auditPersonaEvolutionDecision,
  buildEvolvedPersona,
  describePersonaEvolutionContractFailure,
  isPersonaEvolutionDecisionContractError,
  isRetryablePersonaEvolutionFailure,
  personaEvolutionFailure,
  resolvePersonaEvolutionWrite,
  summarizePersonaEvolutionChange,
  type PersonaEvolutionFailureClassification,
  type PersonaEvolutionFailureKind,
  type PersonaEvolutionViolation,
  type PersonaEvolutionWriteResolution,
} from './services/persona-evolution-decision';
export type {
  PersonaEvolutionMarker,
  PersonaEvolutionOutcome,
} from './schemas';
export type {
  ClaimedPersonaEvolutionCandidate,
  PersonaEvolutionClaimRequest,
  PersonaEvolutionCompletionRequest,
  PersonaEvolutionCompletionResult,
  PersonaEvolutionFailureRequest,
  PersonaEvolutionRestoreOptions,
  RestoredPersonaEvolutionClaim,
} from './ports/memory-repository';
export { personaEvolutionFeedbackSummary } from './services/persona-evolution-candidates';
export { personaEvolutionSettlement } from './services/persona-evolution-decision';
export {
  AUTO_APPROVAL_REVIEWER,
  classifyPersonaEvolutionFailure,
  executePersonaEvolutionCandidate,
  type PersonaEvolutionExecutionOptions,
  type PersonaEvolutionExecutionResult,
  type PersonaEvolutionExecutionStatus,
  type PersonaEvolutionExecutorDeps,
  type PersonaEvolutionFailureLayer,
} from './services/persona-evolution-executor';
export {
  DEFAULT_PERSONA_EVOLUTION_BATCH_SIZE,
  DEFAULT_PERSONA_EVOLUTION_MAX_DURATION_MS,
  DefaultPersonaEvolutionJob,
} from './runtime/persona-evolution-job';

// ════════════════════════════════════════════════════════
//  21. Agent 运行时类型
// ════════════════════════════════════════════════════════

export type { AgentTaskRequest, AgentLoopState } from './agent-types';
export type { AgentToolConfig } from './runtime/agent';
export type {
  AgentArchiveRecord,
  AgentHandle,
  CreateAgentSpec,
  PersonaDef,
  UserRating,
} from './schemas';

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
