/**
 * 前端 RPC 的 application service。
 *
 * 这个文件负责异步启动 integration runner 并维护查询状态，不处理 JSON-RPC framing 或进程 I/O。
 */
import type { IntegrationV0Result } from '../coordinator/integration-v0-flow';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { CouncilRoleExecutionError } from '../council';
import {
  SCHEMA_VERSION,
  createId,
  type Event,
  type TaskCreateRequest,
} from '../core';
import {
  IntegrationV0CoordinatorRunner,
  type CoordinatorRunner,
} from '../coordinator/coordinator-runner';
import { createDefaultTaskRequest } from '../coordinator/task-request';
import type { TaskCursorInput, TaskResumeCursor } from '../persistence';
import {
  restoreFileAnchor,
  type ResumePackage,
  type RestoreFileAnchorResult,
} from '../checkpoint';
import {
  listAgentActivities,
  NoopTelemetrySink,
  releaseRunLlmUsageLedger,
  runWithLlmUsageLedger,
  runWithRunEventConsumption,
  RunEventConsumptionRecorder,
  type TelemetryRecord,
  type TelemetrySink,
} from '../telemetry';
import {
  InMemoryRunRegistry,
  type AppRunEvent,
  type AppRunMode,
  type AppRunSnapshot,
  type RunCancellationReason,
  type StagedTerminalTransition,
} from './run-registry';
import { FileRunAuditWriter, type RunAuditWriter } from './run-audit-writer';
import {
  FileRunTerminalOutputWriter,
  type RunTerminalOutputEvidence,
  type RunTerminalOutputWriter,
} from './run-terminal-output-writer';
import {
  FileRunRequestStore,
  type RunHistoryEntry,
  type RunRequestStore,
} from './run-request-store';
import { projectRunSnapshot } from './run-snapshot-projector';
import { withAlignedTimeline } from './run-timeline-sequence';
import {
  DRIVER_BILLED_SOURCE,
  billedFromDurable,
  pendingBilledSources,
  projectRunUsage,
} from './run-usage-projection';
import { projectRunActivity } from './run-activity-projection';
import type { RunSnapshot, RunUsage, RunUsageHistory } from '../protocol/run-snapshot';
import type { RunEvent } from '../protocol/run-event';
import { projectTaskSnapshot, type TaskRunFact } from './task-snapshot-projector';
import { councilResultEvidenceSchema, type TaskSnapshot } from '../protocol/task-snapshot';
import {
  TaskProcessorRunNotFoundError,
  TaskProcessorTaskNotFoundError,
  type AapMailboxBridge,
  type BeginTaskRunIntent,
  type ParticipantSessionProvisioner,
  type TaskProcessor,
  type TaskExecutionLoop,
} from '../coordination';
import type {
  MailboxDeliveryWorker,
  PersistentMailboxService,
  MailboxReplyInput,
  MailboxSendInput,
  MailboxSendResult,
  PersistedMailboxDelivery,
  PersistedMailboxEnvelope,
  SaveMailboxReplyResult,
} from '../mailbox';
import type { DriverStreamEvent } from '../driver/contract';
import type { DriverRoutingPort } from '../driver';
import type {
  AgentBoardAgentView,
  AgentBoardListItem,
  AgentHandle,
  CreateAgentSpec,
  CreateSkillInput,
  ExperienceView,
  ExperienceWritePatch,
  MarketImportResult,
  MarketSearchQuery,
  PersonaDef,
  PersonaPatch,
  RetireOptions,
  RetireResult,
  RetirementScanResult,
  ExperienceListFilter,
  SkillListFilter,
  SkillView,
  SkillWritePatch,
  UserRating,
  UserRatingResult,
  MemoryOverview,
  DeadLetterEntry,
  ReindexMemoryResult,
} from '../memory';
import type { SkillRecord, BufferMeta, BufferSnapshot, AgentContextSnapshot } from '../memory/schemas';
import type { BMemoryMaintenanceEvidence } from './b-memory-maintenance-runner';
import type { AgentMetaPatch, BMemoryBackendService } from './b-memory-backend-service';
import type { ReviewedSkill } from './b-public-capabilities';
import {
  FileDriverStreamAuditWriter,
  type DriverStreamAuditWriter,
} from './driver-stream-audit-writer';
import { NoopDriverUsageSink, type DriverUsageSink } from './driver-usage-jsonl-sink';
import {
  TaskDriverUsageAccumulator,
  driverUsageRecordFromObservation,
  usageObservationFromDriverEvent,
  type TaskDriverUsage,
} from './driver-usage-projector';
import {
  driverStreamChannel,
  isStreamFragment,
  projectDriverStreamLifecycleEvent,
} from './driver-stream-projection';
import {
  createUnavailableSystemStatusService,
  type SystemStatusService,
} from './system-status-service';
import type {
  SystemCapabilitiesV1,
  SystemLivenessV1,
  SystemReadinessV1,
  SystemSchemaManifestV1,
  SystemVersionV1,
} from '../protocol/system-status';
import type {
  RunArtifactContent,
  RunArtifactContentReader,
} from './run-artifact-content-reader';
import type { RunPayloadReader } from './run-payload-reader';
import type {
  DurableRunUsage,
  RunUsageHistoryReader,
  RunUsageHistoryScope,
} from './run-usage-history';

/** `run.getPayload` 的结果：引用本身 + 它指向的原始 driver 事件。 */
export interface RunPayloadResult {
  payload_ref: string;
  event: DriverStreamEvent;
}

/**
 * `run.getEvents` 的结果：timeline 的一个 `sequence > after_sequence` 的有序切片。
 *
 * 字段都是为了让**纯轮询**自洽，不需要额外一次 `getSnapshot`：
 * - `latest_sequence`：本 run 当前最大序号，轮询方拿它当下水位存起来（`events` 为空时
 *   也能知道「没有新的」而不必再猜）。
 * - `has_more`：给了 `limit` 且被截断时为 true，提示轮询方「还有，继续拉」而不是把
 *   截断误读成「到底了」。
 */
export interface RunEventsResult {
  events: RunEvent[];
  after_sequence: number;
  latest_sequence: number;
  has_more: boolean;
}

export interface RunCreateParams {
  prompt: string;
  workspace_path?: string;
  session_id?: string;
  task_id?: string;
  task_request?: TaskCreateRequest;
  mode?: AppRunMode;
  project_id?: string;
  client_task_id?: string;
  title?: string;
  /** F-eval memory ablation B0–B3; recorded on summary for --backend-summary. */
  memory_ablation?: 'B0' | 'B1' | 'B2' | 'B3' | 'B4';
  /** Optional override for materializer base / eval worktree root. */
  worktree_path?: string;
}

export interface RunCreateResult {
  run_id: string;
  task_id: string;
  status: 'running';
}

export interface RunListResult {
  runs: RunHistoryEntry[];
}

export interface RunRestartResult {
  run_id: string;
  task_id: string;
  restarted_from_run_id: string;
  status: 'running';
}

export interface TaskCreateParams extends TaskCreateRequest {
  workspace_path?: string;
  session_id?: string;
  mode?: AppRunMode;
  project_id?: string;
  client_task_id?: string;
  title?: string;
}

export interface TaskListResult {
  tasks: TaskSnapshot[];
}

export interface TaskSubscription {
  snapshot: TaskSnapshot;
  replay_events: AppRunEvent[];
  unsubscribe: () => void;
}

export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`Task ${taskId} was not found`);
    this.name = 'TaskNotFoundError';
  }
}

export class TaskNotRunningError extends Error {
  constructor(readonly taskId: string) {
    super(`Task ${taskId} has no running run`);
    this.name = 'TaskNotRunningError';
  }
}

export class TaskAlreadyRunningError extends Error {
  constructor(readonly taskId: string) {
    super(`Task ${taskId} already has a running run`);
    this.name = 'TaskAlreadyRunningError';
  }
}

export class TaskNotBlockedError extends Error {
  constructor(readonly taskId: string) {
    super(`Task ${taskId} is not blocked and cannot be resumed`);
    this.name = 'TaskNotBlockedError';
  }
}

export class TaskResumeAnchorError extends Error {
  readonly code = 'CHECKPOINT_ANCHOR_INVALID';

  constructor(
    readonly taskId: string,
    readonly checkpointId: string,
    readonly reason: string,
  ) {
    super(
      `Task ${taskId} cannot resume checkpoint ${checkpointId}: workspace anchor ${reason}`,
    );
    this.name = 'TaskResumeAnchorError';
  }
}

interface RunLineage {
  run_intent?: BeginTaskRunIntent;
  restarted_from_run_id?: string;
  persist_restarted_from_run_id?: boolean;
  resume_checkpoint_id?: string;
  requested_resume_cursor?: TaskResumeCursor;
  /**
   * Stage input the resumed run must start from. Without this a checkpoint_resume
   * falls back to the default select_agent cursor and silently restarts.
   */
  cursor_input?: TaskCursorInput;
}

interface PendingRunStart {
  controller: AbortController;
  settled: Promise<void>;
}

export class NewideBackendService {
  private readonly terminalRuns = new Map<string, Promise<void>>();
  private readonly runWorkspaces = new Map<string, string>();
  private readonly taskListeners = new Map<string, Set<(event: AppRunEvent) => void>>();
  private readonly pendingRunStarts = new Set<PendingRunStart>();
  /** run 级 driver 事件序号计数器：每 run 内单调递增，作为引用与对账的唯一键。 */
  private readonly driverStreamSequences = new Map<string, number>();
  /**
   * 任务级 driver usage 累加器：事件流到达即折叠，是 `summary.driver_context_usage` 的
   * 正源；文件回读退为截断/崩溃时的兜底。见 driver-usage-projector 的类文档。
   */
  private readonly driverUsageByTask = new Map<string, TaskDriverUsageAccumulator>();
  /**
   * driver routing 端口。Run 创建时用它冻结一份快照；RPC 层也据此注册 `driver.*` 方法。
   * 缺省（测试与历史装配）时不做冻结，行为与接线前逐字段一致。
   */
  readonly driverRouting: DriverRoutingPort | undefined;
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly runner: CoordinatorRunner = new IntegrationV0CoordinatorRunner(),
    private readonly registry = new InMemoryRunRegistry(),
    private readonly auditWriter: RunAuditWriter = new FileRunAuditWriter(),
    private readonly terminalWriter: RunTerminalOutputWriter = new FileRunTerminalOutputWriter(
      undefined,
      undefined,
      undefined,
      (taskId) => this.getAccumulatedDriverUsage(taskId),
    ),
    private readonly requestStore: RunRequestStore = new FileRunRequestStore(),
    private readonly taskProcessor?: TaskProcessor,
    private readonly mailboxService?: PersistentMailboxService,
    private readonly mailboxRecovery: Promise<unknown> = Promise.resolve(),
    private readonly closeRuntime: () => Promise<void> | void = () => undefined,
    private readonly bMemoryService?: BMemoryBackendService,
    /**
     * driver 事件流的全量落盘。默认落文件，与 auditWriter / terminalWriter 同款
     * ——它是投影丢事件时唯一的真相源，不该依赖组装者记得注入。测试要静默时
     * 显式传 `new NoopDriverStreamAuditWriter()`。
     */
    private readonly driverStreamAuditWriter: DriverStreamAuditWriter = new FileDriverStreamAuditWriter(),
    private readonly taskExecutionLoop?: TaskExecutionLoop,
    private readonly systemStatusService: SystemStatusService = createUnavailableSystemStatusService(),
    private readonly mailboxDeliveryWorker?: MailboxDeliveryWorker,
    private readonly participantSessionProvisioner?: ParticipantSessionProvisioner,
    private readonly artifactContentReader?: RunArtifactContentReader,
    /** 事件消耗汇总的去处，生产注入按 run 落文件的 sink；不注入则整体空转。 */
    private readonly runEventConsumptionSink: TelemetrySink = new NoopTelemetrySink(),
    /**
     * 该 run 收到的 telemetry 记录的去处——与进入事件流的那批同源同过滤，生产注入
     * 按 run 落文件的 sink。与 `runEventConsumptionSink` 同为文件 sink 但收集面不同，
     * 别接反。
     */
    private readonly runTelemetryJsonlSink: TelemetrySink = new NoopTelemetrySink(),
    private readonly aapBridge?: AapMailboxBridge,
    /**
     * driver usage 观测的独立账本。默认空转，生产注入按 run 落文件的 sink。
     *
     * 与 `driverStreamAuditWriter` 的区别是这份只装 usage 观测，且**不受保留上限截断**：
     * 事件副本写满 8 MiB 就停，实测一次 council 因此只剩前 75 秒的观测，报表报出
     * `driver_sessions=1`（真值 5）。账本极小（同一次 run 一百多条），逐条同步追加，
     * 所以它可以是成本与占用的正源，而不必等终态 summary 出生。
     */
    private readonly driverUsageSink: DriverUsageSink = new NoopDriverUsageSink(),
    /**
     * 按 `payload_ref` 取回 driver 事件流原始行的读取口。
     *
     * 不注入时 `run.getPayload` 报「不可用」而不是返回空——外部被截断/缺失与
     * 「引用本来就不存在」是两件事，前端要能区分。
     */
    private readonly runPayloadReader?: RunPayloadReader,
    /**
     * 用量读取口。两个用途，时效不同：
     *
     * - `read`（异步）供 `run.getUsage` 的按作用域历史累计；
     * - `readRun`（同步）供 `getRunSnapshot` 给**已收尾**的 run 补 `usage.billed`——那份
     *   数据以前只活在进程内存里，重启即消失（`proxy.llm_usage_recorded` 不落 SQLite）。
     *
     * 不注入时两者都缺席，`run.getUsage` 报「不可用」而不是编一个 0。
     */
    private readonly runUsageHistoryReader?: RunUsageHistoryReader,
    /**
     * 本部署实际使用的 driver 计费腿名。
     *
     * 由组装点从 driver 档案（`DriverProfile.billing.source`）解析；缺省是历史名
     * `claude_session_jsonl`。它决定运行中的 run 把哪条腿报成「还没到」——换 driver
     * 之后这个名字必须跟着变，否则面板会一直等一条永远不会来的腿。
     */
    private readonly driverBilledSource: string = DRIVER_BILLED_SOURCE,
    /**
     * driver routing 端口。
     *
     * Run 创建时 `freezeForRun(run_id)` 复制当前 routing，写进 `request.json` 的
     * `driver_config`；执行期的 facade 解析同一份，于是「保存只影响新 Run」有据可依。
     */
    driverRouting?: DriverRoutingPort,
  ) {
    this.driverRouting = driverRouting;
  }

  /**
   * 面板用的用量查询：可选的「当前 run 用量」+ 必有的「按作用域的历史累计」。
   *
   * 两者刻意分块返回：前者是单个 run 的现值，后者是累计量，口径与时效都不同。
   *
   * `usage` 缺席表示**这个 run 在内存里没有、在持久层里也没有**（或没传 `run_id`），不是
   * 「用量为 0」。已收尾的 run 即使本进程不持有它也会被补上：账本里有行就用账本，账本里
   * 还没有行（账本上线之前的 run）就用该 run 自己的 `summary.json`。两条来源同值，见
   * `LedgerRunUsageHistoryReader.readRun`。
   *
   * `scope: 'run'` 给的是同一个 run 的**持久**那份，与 `usage` 同源；两者都读得到时数值
   * 必然相同（同一个账本），差别只在 `history` 还带 `runs_counted` / `complete` 这类
   * 关于「这份数据完不完整」的元信息。
   */
  async getRunUsage(input: {
    scope: RunUsageHistoryScope;
    scope_id?: string;
    run_id?: string;
  }): Promise<{ usage?: RunUsage; history: RunUsageHistory }> {
    if (!this.runUsageHistoryReader) {
      throw new Error('Run usage history reader is not configured');
    }
    const history = await this.runUsageHistoryReader.read({
      scope: input.scope,
      ...(input.scope_id ? { scope_id: input.scope_id } : {}),
    });
    const usage = input.run_id ? this.getRunSnapshot(input.run_id).usage : undefined;
    return { ...(usage ? { usage } : {}), history };
  }

  /**
   * 按引用取回 driver 事件流的原始行。
   *
   * 返回 `undefined` 表示「引用解析得了、但那一行取不到」（文件被保留策略截断、
   * 或 run 目录不存在）——调用方据此渲染「内容不可用」，而不是以为拿到了空数据。
   */
  async getRunPayload(
    runId: string,
    payloadRef: string,
  ): Promise<RunPayloadResult | undefined> {
    if (!this.runPayloadReader) {
      throw new Error('Run payload reader is not configured');
    }
    const event = await this.runPayloadReader.read(runId, payloadRef);
    return event ? { payload_ref: payloadRef, event } : undefined;
  }

  /**
   * 增量拉取 timeline：订阅的**拉取孪生口**，让纯轮询成为一等公民路径。
   *
   * 存在理由：前端要「先 getSnapshot 对齐、再补增量」，但过去补增量只有 `run.subscribe`
   * （推送）一条路。这个口把同一批事件用**同一个序号空间**按 `sequence` 差集发出去，
   * 于是纯轮询与订阅可以互换而读到的号一致。
   *
   * **序号同源不是复制来的约定，是构造出来的**：直接取 `getRunSnapshot` 的 `timeline`——
   * 那份已经被 `withAlignedTimeline` 对齐过（存活期）或回落到持久序号（重启后），与
   * `run.event` 推流是同一套号。绝不自己另扫一遍 SQLite，否则两条通道又会各拿一套号。
   *
   * 过滤语义与 `run.subscribe` 的 `after_sequence` 水位**完全一致**（`sequence > after`），
   * 因为这是它的孪生口，不是另一个东西。注意序号**非严格递增**（快照独有事件与前一个号
   * 并列），所以 `events` 保留 timeline 的**数组顺序**（权威顺序），`sequence` 只用于
   * 判缺与去重（去重键是 `event_id`）。并列号事件被同一个水位一起放过的边角，与
   * `run.subscribe` 同构——孪生口的价值在于行为一致，不在于比订阅更聪明。
   */
  getRunEvents(input: {
    run_id: string;
    after_sequence?: number;
    limit?: number;
  }): RunEventsResult {
    const after = input.after_sequence ?? 0;
    const timeline = this.getRunSnapshot(input.run_id).timeline;
    const candidates = timeline.filter((event) => event.sequence > after);
    const limited =
      input.limit === undefined ? candidates : candidates.slice(0, input.limit);
    return {
      events: limited,
      after_sequence: after,
      latest_sequence: timeline.reduce((max, event) => Math.max(max, event.sequence), 0),
      has_more: limited.length < candidates.length,
    };
  }

  async getArtifactContent(runId: string, artifactId: string): Promise<RunArtifactContent> {
    if (!this.artifactContentReader) {
      throw new Error('Artifact content reader is not configured');
    }
    return this.artifactContentReader.read(runId, artifactId);
  }

  async recoverMailboxWaits(): Promise<void> {
    await this.mailboxRecovery;
    if (!this.taskProcessor || !this.mailboxDeliveryWorker || !this.mailboxService) return;
    for (const context of this.taskProcessor.listMailboxWaitContexts()) {
      await this.continueMailboxWait(context.task_id).catch((error: unknown) => {
        process.stderr.write(
          `[mailbox] recovery failed for ${context.task_id}: ${toError(error).message}\n`,
        );
      });
    }
  }

  getSystemLiveness(): SystemLivenessV1 {
    return this.systemStatusService.liveness();
  }

  getSystemReadiness(): SystemReadinessV1 {
    return this.systemStatusService.readiness();
  }

  getSystemCapabilities(required?: readonly string[]): SystemCapabilitiesV1 {
    return this.systemStatusService.capabilities(required);
  }

  getSystemVersion(): SystemVersionV1 {
    return this.systemStatusService.version();
  }

  getSystemSchema(): SystemSchemaManifestV1 {
    return this.systemStatusService.schema();
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = this.closeGracefully();
    }
    return this.closePromise;
  }

  async sendMailboxMessage(input: MailboxSendInput): Promise<MailboxSendResult> {
    await this.mailboxRecovery;
    return this.requireMailboxService().send(input);
  }

  async listMailboxInbox(
    taskId: string,
    workspacePath: string,
    recipientRoleId: string,
    afterDeliveryId?: string,
  ): Promise<PersistedMailboxEnvelope[]> {
    await this.mailboxRecovery;
    return this.requireMailboxService().inbox(
      taskId,
      workspacePath,
      recipientRoleId,
      afterDeliveryId,
    );
  }

  async acknowledgeMailboxDelivery(
    deliveryId: string,
    recipientRoleId: string,
  ): Promise<PersistedMailboxDelivery> {
    await this.mailboxRecovery;
    return this.requireMailboxService().ack(deliveryId, recipientRoleId);
  }

  async replyMailboxMessage(input: MailboxReplyInput): Promise<SaveMailboxReplyResult> {
    await this.mailboxRecovery;
    const result = await this.requireMailboxService().reply(input);
    // A persisted reply is the only business wake-up signal for a waiting
    // Task. Continue it after the reply transaction commits; a recovery pass
    // will retry the same deterministic exchange if this process stops here.
    await this.continueMailboxWait(result.source_delivery.task_id).catch((error: unknown) => {
      process.stderr.write(`[mailbox] reply continuation failed: ${toError(error).message}\n`);
    });
    return result;
  }

  listMemoryAgents(status?: string): Promise<AgentBoardListItem[]> {
    return this.requireBMemoryService().listAgents(status);
  }

  getMemoryCapabilities() {
    return this.requireBMemoryService().getCapabilities();
  }

  getMemoryAgent(roleId: string): Promise<AgentBoardAgentView> {
    return this.requireBMemoryService().getAgent(roleId);
  }

  listMemorySkills(roleId: string, filter?: SkillListFilter): Promise<SkillView[]> {
    return this.requireBMemoryService().listSkills(roleId, filter);
  }

  listMemoryExperiences(
    roleId: string,
    filter?: ExperienceListFilter,
  ): Promise<ExperienceView[]> {
    return this.requireBMemoryService().listExperiences(roleId, filter);
  }

  listMemoryMaintenance(roleId?: string): Promise<BMemoryMaintenanceEvidence[]> {
    return this.requireBMemoryService().listMaintenance(roleId);
  }

  promoteMemorySkills(roleId: string, requestedBy: string): Promise<BMemoryMaintenanceEvidence> {
    return this.requireBMemoryService().promoteSkills(roleId, requestedBy);
  }

  promoteMemoryExperience(roleId: string, experienceId: string): Promise<SkillView> {
    return this.requireBMemoryService().promoteExperience(roleId, experienceId);
  }

  marketSearchMemorySkills(query: MarketSearchQuery): Promise<SkillRecord[]> {
    return this.requireBMemoryService().marketSearch(query);
  }

  marketImportMemorySkill(roleId: string, sourceSkillId: string): Promise<MarketImportResult> {
    return this.requireBMemoryService().marketImport(roleId, sourceSkillId);
  }

  retireMemoryAgent(roleId: string, options: RetireOptions): Promise<RetireResult> {
    return this.requireBMemoryService().retireAgent(roleId, options);
  }

  runRetirementScan(roleId?: string): Promise<RetirementScanResult[]> {
    return this.requireBMemoryService().runRetirementScan(roleId);
  }

  createMemoryAgent(spec: CreateAgentSpec): Promise<AgentHandle> {
    return this.requireBMemoryService().createAgent(spec);
  }

  updateMemoryAgent(roleId: string, patch: AgentMetaPatch): Promise<AgentHandle> {
    return this.requireBMemoryService().updateAgent(roleId, patch);
  }

  deleteMemoryAgent(roleId: string, options?: { force?: boolean }): Promise<void> {
    return this.requireBMemoryService().deleteAgent(roleId, options);
  }

  approveMemorySkill(roleId: string, skillId: string, reviewedBy: string): Promise<ReviewedSkill> {
    return this.requireBMemoryService().approveSkill(roleId, skillId, reviewedBy);
  }

  rejectMemorySkill(roleId: string, skillId: string, reviewedBy: string): Promise<ReviewedSkill> {
    return this.requireBMemoryService().rejectSkill(roleId, skillId, reviewedBy);
  }

  createMemorySkill(input: CreateSkillInput): Promise<SkillView> {
    return this.requireBMemoryService().createSkill(input);
  }

  updateMemorySkill(roleId: string, skillId: string, patch: SkillWritePatch): Promise<SkillView> {
    return this.requireBMemoryService().updateSkill(roleId, skillId, patch);
  }

  deleteMemorySkill(roleId: string, skillId: string): Promise<void> {
    return this.requireBMemoryService().deleteSkill(roleId, skillId);
  }

  publishMemorySkillToMarket(roleId: string, skillId: string): Promise<SkillView> {
    return this.requireBMemoryService().publishSkillToMarket(roleId, skillId);
  }

  updateMemoryExperience(
    roleId: string,
    experienceId: string,
    patch: ExperienceWritePatch,
  ): Promise<ExperienceView> {
    return this.requireBMemoryService().updateExperience(roleId, experienceId, patch);
  }

  deleteMemoryExperience(roleId: string, experienceId: string): Promise<void> {
    return this.requireBMemoryService().deleteExperience(roleId, experienceId);
  }

  updateMemoryPersona(roleId: string, patch: PersonaPatch): Promise<PersonaDef> {
    return this.requireBMemoryService().updatePersona(roleId, patch);
  }

  regenerateMemoryPersona(roleId: string): Promise<PersonaDef> {
    return this.requireBMemoryService().regeneratePersona(roleId);
  }

  rateMemoryTask(
    roleId: string,
    taskId: string,
    rating: UserRating,
    note?: string,
  ): Promise<UserRatingResult> {
    return this.requireBMemoryService().rateTask(roleId, taskId, rating, note);
  }

  getMemoryBufferState(roleId: string): Promise<{
    meta: BufferMeta;
    pending_seqs: number[];
    dead_letter_seqs: number[];
    dead_letters: DeadLetterEntry[];
  }> {
    return this.requireBMemoryService().getBufferState(roleId);
  }

  getMemoryPendingBuffer(
    roleId: string,
    seq: number,
  ): Promise<{ snapshot: BufferSnapshot; agent_context?: AgentContextSnapshot } | undefined> {
    return this.requireBMemoryService().getPendingBuffer(roleId, seq);
  }

  retryMemoryExtraction(roleId: string, seq: number): Promise<BMemoryMaintenanceEvidence> {
    return this.requireBMemoryService().retryExtraction(roleId, seq);
  }

  searchAgentMemory(
    roleId: string,
    query: string,
    options: {
      top_k?: number;
      min_similarity?: number;
      include_skills?: boolean;
      include_experiences?: boolean;
    } = {},
  ): Promise<{
    skills: Array<SkillView & { similarity: number }>;
    experiences: Array<ExperienceView & { similarity: number }>;
  }> {
    return this.requireBMemoryService().searchMemory(roleId, query, options);
  }

  getMemoryOverview(): Promise<MemoryOverview> {
    return this.requireBMemoryService().getOverview();
  }

  listMemoryPendingReviews(): Promise<SkillView[]> {
    return this.requireBMemoryService().listPendingReviews();
  }

  listMemoryExperiencesBySourceTask(taskId: string): Promise<ExperienceView[]> {
    return this.requireBMemoryService().listExperiencesBySourceTask(taskId);
  }

  reindexMemory(
    roleId?: string,
    options: { force?: boolean } = {},
  ): Promise<ReindexMemoryResult> {
    return this.requireBMemoryService().reindexMemory(roleId, options);
  }

  createRun(params: RunCreateParams): Promise<RunCreateResult> {
    return this.startRun(params);
  }

  async createTask(params: TaskCreateParams): Promise<TaskSnapshot> {
    const taskRequest = toTaskCreateRequest(params);
    const created = await this.startRun({
      prompt: taskRequest.spec,
      task_request: taskRequest,
      ...(params.workspace_path ? { workspace_path: params.workspace_path } : {}),
      ...(params.session_id ? { session_id: params.session_id } : {}),
      ...(params.mode ? { mode: params.mode } : {}),
      ...(params.project_id ? { project_id: params.project_id } : {}),
      ...(params.client_task_id ? { client_task_id: params.client_task_id } : {}),
      ...(params.title ? { title: params.title } : {}),
    });
    return this.getTask(created.task_id);
  }

  async getTask(taskId: string): Promise<TaskSnapshot> {
    const tasks = await this.collectTaskSnapshots();
    const task = tasks.find((candidate) => candidate.task.task_id === taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    return task;
  }

  async listTasks(): Promise<TaskListResult> {
    return { tasks: await this.collectTaskSnapshots() };
  }

  async cancelTask(taskId: string): Promise<TaskSnapshot> {
    await this.getTask(taskId);
    const current = this.registry
      .listSnapshots()
      .find((run) => run.task_id === taskId && run.status === 'running');
    if (!current) throw new TaskNotRunningError(taskId);
    await this.cancelRun(current.run_id);
    return this.getTask(taskId);
  }

  async startCouncil(taskId: string): Promise<TaskSnapshot> {
    const task = await this.getTask(taskId);
    if (task.current_run) {
      if (!this.taskProcessor) throw new TaskAlreadyRunningError(taskId);
      try {
        this.taskProcessor.setCouncilOverride(task.current_run.run_id);
      } catch (error) {
        if (error instanceof TaskProcessorRunNotFoundError) {
          throw new TaskAlreadyRunningError(taskId);
        }
        throw error;
      }
      return this.getTask(taskId);
    }
    let durableLaunch;
    try {
      durableLaunch = this.taskProcessor?.getTaskLaunchContext(taskId);
    } catch (error) {
      if (!(error instanceof TaskProcessorTaskNotFoundError)) throw error;
    }
    if (durableLaunch) {
      await this.startRun(
        {
          prompt: durableLaunch.task_request.spec,
          task_id: taskId,
          task_request: durableLaunch.task_request,
          workspace_path: durableLaunch.workspace_path,
          mode: 'council',
          ...(durableLaunch.session_id ? { session_id: durableLaunch.session_id } : {}),
          ...(durableLaunch.memory_ablation
            ? { memory_ablation: durableLaunch.memory_ablation }
            : {}),
        },
        { run_intent: { type: 'council_refinement' } },
      );
      return this.getTask(taskId);
    }
    const history = await this.requestStore.listHistory();
    const launch = history.find(
      (entry) => entry.task_id === taskId && entry.task_request && entry.workspace_path,
    );
    if (!launch?.task_request || !launch.workspace_path) throw new TaskNotFoundError(taskId);
    await this.startRun(
      {
        prompt: launch.task_request.spec,
        task_id: taskId,
        task_request: launch.task_request,
        workspace_path: launch.workspace_path,
        mode: 'council',
        ...(launch.session_id ? { session_id: launch.session_id } : {}),
        ...(launch.memory_ablation ? { memory_ablation: launch.memory_ablation } : {}),
      },
      { run_intent: { type: 'create' } },
    );
    return this.getTask(taskId);
  }

  async resumeTask(taskId: string): Promise<TaskSnapshot> {
    const task = await this.getTask(taskId);
    if (task.current_run) throw new TaskAlreadyRunningError(taskId);
    if (task.task.status !== 'blocked') throw new TaskNotBlockedError(taskId);
    if (!this.taskProcessor) {
      throw new Error(`Task ${taskId} cannot resume without the persistent Task processor`);
    }
    const resumePackage = this.taskProcessor.buildResumePackage(taskId);
    const resume = this.taskProcessor.getTaskResumeContext(taskId);
    const restore = this.restoreResumeWorkspace(taskId, resumePackage);
    if (restore.status !== 'restored') {
      throw new TaskResumeAnchorError(
        taskId,
        resume.checkpoint_id,
        restore.reason ?? 'restore_failed',
      );
    }
    await this.startRun(
      {
        prompt: resume.task_request.spec,
        task_id: taskId,
        task_request: resume.task_request,
        workspace_path: resume.workspace_path,
        mode: resume.mode,
        ...(resume.session_id ? { session_id: resume.session_id } : {}),
        ...(resume.memory_ablation ? { memory_ablation: resume.memory_ablation } : {}),
      },
      {
        run_intent: { type: 'checkpoint_resume', strategy: 'from_checkpoint' },
        restarted_from_run_id: resume.interrupted_run_id,
        resume_checkpoint_id: resume.checkpoint_id,
        requested_resume_cursor: resume.resume_cursor,
        cursor_input: resume.cursor_input,
      },
    );
    return this.getTask(taskId);
  }

  /**
   * Restore workspace content from the resume checkpoint's file anchor before the
   * resumed run starts, so the resumed stage sees the files the interrupted run left
   * behind rather than whatever is on disk now.
   *
   * A failed restore is terminal for resume: the caller keeps the Task blocked and
   * must choose an explicit restart from the beginning. The outcome is recorded
   * before the failure is surfaced to the RPC caller.
   */
  private restoreResumeWorkspace(
    taskId: string,
    resumePackage: ResumePackage,
  ): RestoreFileAnchorResult {
    const processor = this.taskProcessor;
    if (!processor) {
      return {
        status: 'skipped',
        reason: 'task_processor_unavailable',
        restored_files: [],
        extra_files: [],
        pruned_files: [],
      };
    }
    const anchor = resumePackage.file_anchor;
    const result: RestoreFileAnchorResult = anchor.recoverable
      ? restoreFileAnchor(anchor)
      : {
          status: 'skipped',
          reason: 'anchor_not_recoverable',
          restored_files: [],
          extra_files: [],
          pruned_files: [],
        };

    processor.recordWorkspaceRestore(
      taskId,
      resumePackage.checkpoint_id,
      // The interrupted run is the only real run this event can hang off: the resumed
      // run does not exist yet, and current_run_id was cleared by the interrupt.
      resumePackage.interrupted_run_id,
      {
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
        workspace_path: anchor.worktree_path,
        ...(anchor.snapshot_commit ? { snapshot_commit: anchor.snapshot_commit } : {}),
        restored_file_count: result.restored_files.length,
        extra_files: result.extra_files,
      },
    );
    return result;
  }

  async subscribeTask(
    taskId: string,
    listener: (event: AppRunEvent) => void,
    afterEventId?: string,
  ): Promise<TaskSubscription> {
    await this.getTask(taskId);
    let replayEvents: AppRunEvent[] = [];
    try {
      replayEvents = this.taskProcessor?.listTaskEvents(taskId, afterEventId) ?? [];
    } catch (error) {
      if (!(error instanceof TaskProcessorTaskNotFoundError)) throw error;
    }
    const listeners = this.taskListeners.get(taskId) ?? new Set();
    listeners.add(listener);
    this.taskListeners.set(taskId, listeners);
    const snapshot = await this.getTask(taskId);
    return {
      snapshot,
      replay_events: replayEvents,
      unsubscribe: () => {
        listeners.delete(listener);
        if (listeners.size === 0) this.taskListeners.delete(taskId);
      },
    };
  }

  async listRuns(): Promise<RunListResult> {
    const history = await this.requestStore.listHistory();
    return {
      // 仍在本进程运行中的 run 由 run.getSnapshot 提供真实状态；
      // 历史列表只回放已经落盘的 run，绝不把遗留目录伪装成 running。
      runs: history.filter((entry) => !this.isLiveRun(entry.run_id)),
    };
  }

  async restartRun(runId: string): Promise<RunRestartResult> {
    // restart 是"从持久化边界重新执行"：只恢复 request.json 里的输入，
    // 创建全新 run_id，不复活旧进程，也不声称恢复 Agent 内部状态。
    const request = await this.requestStore.load(runId);
    // 终态快照里的 session_id 是 Driver 真实会话；存在则复用，
    // 否则退回创建时显式携带的 session。
    const terminalSessionId = await this.requestStore
      .readTerminalSessionId(runId)
      .catch(() => undefined);
    const sessionId = terminalSessionId ?? request.session_id;
    const persistRestartLineage = this.hasPersistedRun(runId);
    const created = await this.startRun(
      {
        prompt: request.prompt,
        workspace_path: request.workspace_path,
        mode: request.mode,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(request.task_request ? { task_request: request.task_request } : {}),
        ...(request.project_id ? { project_id: request.project_id } : {}),
        ...(request.client_task_id ? { client_task_id: request.client_task_id } : {}),
        ...(request.title ? { title: request.title } : {}),
        ...(request.memory_ablation ? { memory_ablation: request.memory_ablation } : {}),
      },
      {
        run_intent: { type: 'create' },
        restarted_from_run_id: runId,
        persist_restarted_from_run_id: persistRestartLineage,
      },
    );
    return { ...created, restarted_from_run_id: runId };
  }

  private startRun(params: RunCreateParams, lineage?: RunLineage): Promise<RunCreateResult> {
    if (this.taskExecutionLoop && this.taskProcessor) {
      return this.startTaskLoopRun(params, lineage);
    }
    return this.startLegacyRun(params, lineage);
  }

  private async startTaskLoopRun(
    params: RunCreateParams,
    lineage?: RunLineage,
  ): Promise<RunCreateResult> {
    if (this.closing) throw new Error('Backend service is closing');
    const processor = this.taskProcessor!;
    const loop = this.taskExecutionLoop!;
    const mode = params.mode ?? readDefaultRunMode(process.env);
    const workspacePath = normalizeWorkspacePath(params.workspace_path ?? process.cwd());
    const taskRequest = params.task_request ?? createDefaultTaskRequest(params.prompt);
    const identity = {
      task_id: params.task_id ?? createId('task'),
      run_id: createId('run'),
    };
    const controller = new AbortController();
    this.registry.create({ ...identity, mode, controller });
    this.runWorkspaces.set(identity.run_id, workspacePath);
    // 在本 Run 的第一个阶段跑起来之前冻结 routing：此后无论 UI 怎么改，本 Run 都用这一份。
    const driverConfig = this.driverRouting?.freezeForRun(identity.run_id);
    this.registry.subscribe(identity.run_id, (event) => {
      void this.auditWriter.append(event).catch(() => undefined);
      this.notifyTaskListeners(identity.task_id, event);
    });
    try {
      processor.beginRun({
        ...identity,
        task_request: taskRequest,
        workspace_path: workspacePath,
        mode,
        ...(params.memory_ablation ? { memory_ablation: params.memory_ablation } : {}),
        run_intent: lineage?.run_intent ?? { type: 'create' },
        ...(params.session_id ? { session_id: params.session_id } : {}),
        ...(lineage?.restarted_from_run_id &&
        lineage.persist_restarted_from_run_id !== false
          ? { restarted_from_run_id: lineage.restarted_from_run_id }
          : {}),
        ...(lineage?.resume_checkpoint_id
          ? { resume_checkpoint_id: lineage.resume_checkpoint_id }
          : {}),
        ...(lineage?.requested_resume_cursor
          ? { requested_resume_cursor: lineage.requested_resume_cursor }
          : {}),
        ...(lineage?.cursor_input ? { cursor_input: lineage.cursor_input } : {}),
      });
      for (const event of processor.listTaskEvents(identity.task_id)) {
        if (event.run_id === identity.run_id) this.mirrorTaskAuthorityEvent(event);
      }
      await this.requestStore.save({
        ...identity,
        ...(driverConfig ? { driver_config: driverConfig } : {}),
        prompt: params.prompt,
        workspace_path: workspacePath,
        mode,
        task_request: taskRequest,
        ...(params.memory_ablation ? { memory_ablation: params.memory_ablation } : {}),
        ...(params.session_id ? { session_id: params.session_id } : {}),
        ...(params.project_id ? { project_id: params.project_id } : {}),
        ...(params.client_task_id ? { client_task_id: params.client_task_id } : {}),
        ...(params.title ? { title: params.title } : {}),
        ...(params.memory_ablation
          ? { memory_ablation: params.memory_ablation }
          : {}),
        ...(lineage?.restarted_from_run_id
          ? { restarted_from_run_id: lineage.restarted_from_run_id }
          : {}),
      });
    } catch (error) {
      const normalized = toError(error);
      try {
        processor.finishRun({
          run_id: identity.run_id,
          status: 'failed',
          error: { code: 'RUN_START_FAILED', message: normalized.message },
        });
        for (const event of processor.listTaskEvents(identity.task_id)) {
          if (event.run_id === identity.run_id) this.mirrorTaskAuthorityEvent(event);
        }
      } catch {
        // Preserve the original launch failure.
      }
      this.registry.fail(identity.run_id, 'RUN_START_FAILED', normalized.message);
      this.runWorkspaces.delete(identity.run_id);
      throw normalized;
    }

    const terminalRun = this.executeTaskAuthorityRun({
      identity,
      loop,
      controller,
      ...(params.session_id ? { session_id: params.session_id } : {}),
      ...(params.memory_ablation
        ? { memory_ablation: params.memory_ablation }
        : {}),
    });
    this.terminalRuns.set(identity.run_id, terminalRun);
    void terminalRun.finally(() => {
      this.terminalRuns.delete(identity.run_id);
      this.runWorkspaces.delete(identity.run_id);
    });
    return { ...identity, status: 'running' };
  }

  private async executeTaskAuthorityRun(input: {
    identity: { run_id: string; task_id: string };
    loop: TaskExecutionLoop;
    controller: AbortController;
    memory_ablation?: 'B0' | 'B1' | 'B2' | 'B3' | 'B4';
    session_id?: string;
  }): Promise<void> {
    const { run_id: runId, task_id: taskId } = input.identity;
    // 新主路径此前完全没有账本：adapter 照常调用 recordProxyLlmUsage，但没有作用域承接，
    // token 静默消失（`dropped_no_ledger`）。作用域覆盖整轮——run 身份在 beginRun 之前
    // 就已定死。sink 复用 appendTelemetry，用量事件因此进入 run 事件流，进而落
    // audit.jsonl 与 timeline.json（终态 summary.token_usage 从后者读出）。
    const sink: TelemetrySink = {
      emit: (record) => this.appendTelemetry(input.identity, record),
    };
    // 事件计数与账本共用这个 run 作用域：计数器的 ALS 必须在 loop 外层建立，因为
    // 阶段事件的出口（stage executor 的 emit）与提交回调都在 loop 内部。
    // 落点刻意**不是**上面那个 registry sink：汇总信号若进 run 的事件流，就会排在
    // run.completed 之后，破坏「最后一条事件是终态」的消费方断言。观测信号走自己的
    // 文件（`event-consumption.jsonl`），与 latency.jsonl 同一套约定。
    const consumption = new RunEventConsumptionRecorder({
      run_id: runId,
      task_id: taskId,
      sink: this.runEventConsumptionSink,
    });
    try {
      await runWithLlmUsageLedger(
        {
          case_id: taskId,
          run_id: runId,
          task_id: taskId,
          sink,
          scaffold_variant: 'full_system',
        },
        () => runWithRunEventConsumption(consumption, () => this.runAuthorityLoop(input)),
      );
    } finally {
      // 挂在 run 终态而不是别处：B 记忆维护在循环内部读同一个 run 的账本，提前释放会让
      // 它读到空账，进而用偏小的部分值覆盖 summary.token_usage。
      releaseRunLlmUsageLedger(runId);
      // 与上面同理放 finally：失败的 run 往往才是事件堆得最多的一类，只在成功路径
      // 发信号会正好把它漏掉。finish() 自身不抛错，不改变原来的异常语义。
      await consumption.finish();
    }
  }

  private async runAuthorityLoop(input: {
    identity: { run_id: string; task_id: string };
    loop: TaskExecutionLoop;
    controller: AbortController;
    memory_ablation?: 'B0' | 'B1' | 'B2' | 'B3' | 'B4';
    session_id?: string;
  }): Promise<void> {
    const processor = this.taskProcessor!;
    try {
      const taskSnapshot = await input.loop.run({
        ...input.identity,
        ...(input.memory_ablation
          ? { memory_ablation: input.memory_ablation }
          : {}),
        ...(input.session_id ? { session_id: input.session_id } : {}),
        signal: input.controller.signal,
        on_driver_event: (event) => this.appendDriverStreamEvent(input.identity, event),
        on_event: (event) => {
          processor.recordRunEvent(input.identity.run_id, event);
          this.mirrorTaskAuthorityEvent({
            event_id: event.event_id,
            sequence: 0,
            run_id: input.identity.run_id,
            task_id: input.identity.task_id,
            type: event.event_type,
            source: 'coordinator',
            created_at: event.created_at,
            payload: event.payload,
            schema_version: event.schema_version,
          });
        },
        on_committed_events: (events) => {
          for (const event of events) {
            this.mirrorTaskAuthorityEvent({
              event_id: event.event_id,
              sequence: event.sequence,
              run_id: input.identity.run_id,
              task_id: input.identity.task_id,
              type: event.event_type,
              source: 'coordinator',
              created_at: event.created_at,
              payload: event.payload,
              schema_version: event.schema_version,
            });
          }
        },
      });
      const projected = processor.getRunSnapshot(input.identity.run_id);
      if (!projected) throw new Error(`Run ${input.identity.run_id} has no persistent projection`);
      const executionState = processor.getRunExecutionState(input.identity.run_id);
      if (executionState.resume_cursor === 'mailbox_wait') {
        const waiting = processor.completeRunForMailboxWait(input.identity.run_id);
        for (const event of waiting.committed_events) {
          this.mirrorTaskAuthorityEvent({
            event_id: event.event_id,
            sequence: event.sequence,
            run_id: input.identity.run_id,
            task_id: input.identity.task_id,
            type: event.event_type,
            source: 'coordinator',
            created_at: event.created_at,
            payload: event.payload,
            schema_version: event.schema_version,
          });
        }
        const waitingProjection = processor.getRunSnapshot(input.identity.run_id);
        if (waitingProjection) {
          this.registry.setProjectedSnapshot(input.identity.run_id, waitingProjection);
        }
        this.registry.complete(input.identity.run_id);
        await this.driverStreamAuditWriter.flush(input.identity.run_id);
        await this.auditWriter.flush(input.identity.run_id);
        await this.terminalWriter.finalize(this.registry.getSnapshot(input.identity.run_id));
        await this.auditWriter.flush(input.identity.run_id).catch(() => undefined);
        await this.continueMailboxWait(input.identity.task_id).catch((error: unknown) => {
          process.stderr.write(
            `[mailbox] continuation failed for ${input.identity.task_id}: ${toError(error).message}\n`,
          );
        });
        return;
      }
      if (taskSnapshot.task.status === 'completed') {
        this.registry.complete(input.identity.run_id);
      } else if (taskSnapshot.task.status === 'cancelled') {
        this.registry.cancel(input.identity.run_id);
      } else {
        this.registry.fail(
          input.identity.run_id,
          taskSnapshot.error?.code ?? 'TASK_LOOP_FAILED',
          taskSnapshot.error?.message ?? `Task ended as ${taskSnapshot.task.status}`,
        );
      }
      this.registry.setProjectedSnapshot(input.identity.run_id, projected);
      await this.driverStreamAuditWriter.flush(input.identity.run_id);
      await this.auditWriter.flush(input.identity.run_id);
      await this.terminalWriter.finalize(this.registry.getSnapshot(input.identity.run_id));
      await this.auditWriter.flush(input.identity.run_id).catch(() => undefined);
    } catch (error) {
      const normalized = toError(error);
      try {
        const current = processor.getTaskSnapshot(input.identity.task_id);
        if (current.current_run?.run_id === input.identity.run_id) {
          processor.finishRun({
            run_id: input.identity.run_id,
            status: input.controller.signal.aborted ? 'cancelled' : 'failed',
            ...(input.controller.signal.aborted
              ? {}
              : {
                  error: {
                    code: 'TASK_LOOP_FAILED',
                    message: normalized.message,
                  },
                }),
          });
        }
        for (const event of processor.listTaskEvents(input.identity.task_id)) {
          if (event.run_id === input.identity.run_id) this.mirrorTaskAuthorityEvent(event);
        }
      } catch {
        // The persistent terminal transition is best-effort after a commit failure.
      }
      if (input.controller.signal.aborted) {
        this.registry.cancel(input.identity.run_id);
      } else {
        this.registry.fail(input.identity.run_id, 'TASK_LOOP_FAILED', normalized.message);
      }
      const projected = processor.getRunSnapshot(input.identity.run_id);
      if (projected) this.registry.setProjectedSnapshot(input.identity.run_id, projected);
      await this.driverStreamAuditWriter.flush(input.identity.run_id).catch(() => undefined);
      await this.auditWriter.flush(input.identity.run_id).catch(() => undefined);
      await this.terminalWriter
        .finalize(this.registry.getSnapshot(input.identity.run_id))
        .catch(() => undefined);
    }
  }

  private async continueMailboxWait(taskId: string): Promise<void> {
    const processor = this.taskProcessor;
    const mailbox = this.mailboxService;
    const worker = this.mailboxDeliveryWorker;
    if (!processor || !mailbox || !worker) return;
    const deadlock = (reason: string): void => {
      processor.blockMailboxDeadlock(taskId, `COLLABORATION_DEADLOCK: ${reason}`);
    };
    try {
      let context = processor
        .listMailboxWaitContexts()
        .find((candidate) => candidate.task_id === taskId);
      if (!context || context.delivery_ids.length !== 1) {
        deadlock('MAILBOX_WAIT_CONTEXT_MISSING');
        return;
      }
      const current = processor.getTaskSnapshot(taskId);
      if (current.current_run?.run_id === context.run_id) {
        processor.completeRunForMailboxWait(context.run_id);
        context = processor
          .listMailboxWaitContexts()
          .find((candidate) => candidate.task_id === taskId);
        if (!context) {
          deadlock('MAILBOX_WAIT_CONTEXT_MISSING');
          return;
        }
      }

      const sourceDeliveryId = context.delivery_ids[0]!;
      const source = mailbox.getEnvelope(sourceDeliveryId);
      // Council plan_first writes Mailbox messages from the council workspace,
      // which can differ from the Task worktree. Continuation must resume in
      // the same workspace the request was sent from, or startRun fails and
      // the Task stays waiting_help forever.
      const continuationWorkspace = source.message.workspace_path;
      let reply = mailbox.findReplyDelivery(sourceDeliveryId, context.sender_role_id);
      if (
        !reply &&
        source.delivery.deadline_at &&
        Date.parse(source.delivery.deadline_at) <= Date.now()
      ) {
        mailbox.markFailed(sourceDeliveryId, {
          code: 'MAILBOX_DEADLINE_EXCEEDED',
          message: 'Mailbox request reached its local deadline without a reply',
        });
        processor.expireMailboxWait(
          taskId,
          'Mailbox request reached its local deadline without a matching reply',
        );
        return;
      }
      const aapDispatch = this.aapBridge?.createAsk({
        task_id: source.message.task_id,
        run_id: context.run_id,
        from_role_id: source.message.from_role_id,
        to_role_id: source.delivery.recipient_role_id,
        message_id: source.message.message_id,
        delivery_id: source.delivery.delivery_id,
        content:
          source.message.content?.trim() ||
          (typeof source.message.payload.content === 'string'
            ? source.message.payload.content
            : JSON.stringify(source.message.payload)),
        ...(source.delivery.deadline_at ? { deadline_at: source.delivery.deadline_at } : {}),
        exchange_id: `aap_ask_${source.message.message_id}`,
      });
      // Upgrade a wait created before AAP wiring without changing its Mailbox
      // identity. The deterministic exchange makes this idempotent.
      if (aapDispatch) this.aapBridge!.persistAsk(aapDispatch);
      const aapAdmission = aapDispatch ? this.aapBridge!.beginAsk(aapDispatch) : undefined;
      if (!reply) {
        // A previous process may still own the AAP inbox lease. Preserve the
        // durable wait; retry after lease expiry or let a matching reply wake
        // the Task. Never turn an in-flight lease into a deadlock.
        if (aapAdmission?.should_execute === false) return;
        if (this.participantSessionProvisioner) {
          try {
            await this.participantSessionProvisioner({
              task_id: source.message.task_id,
              workspace_path: continuationWorkspace,
              role_id: source.delivery.recipient_role_id,
              run_id: context.run_id,
            });
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            deadlock(`SESSION_PROVISION_FAILED: ${message}`);
            return;
          }
        }
        const waitController = new AbortController();
        const deadlineMs = source.delivery.deadline_at
          ? Math.max(0, Date.parse(source.delivery.deadline_at) - Date.now())
          : undefined;
        const deadlineTimer = deadlineMs === undefined
          ? undefined
          : setTimeout(() => waitController.abort(), deadlineMs);
        let handled;
        try {
          handled = await worker.process({
            delivery_id: sourceDeliveryId,
            run_id: context.run_id,
            signal: waitController.signal,
          });
        } finally {
          if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        }
        if (waitController.signal.aborted) {
          mailbox.markFailed(sourceDeliveryId, {
            code: 'MAILBOX_DEADLINE_EXCEEDED',
            message: 'Mailbox request reached its local deadline without a reply',
          });
          processor.expireMailboxWait(
            taskId,
            'Mailbox request reached its local deadline without a matching reply',
          );
          return;
        }
        if (
          handled &&
          handled.status === 'retryable_failure' &&
          handled.error?.startsWith('COLLABORATION_DEADLOCK')
        ) {
          processor.blockMailboxDeadlock(taskId, handled.error);
          return;
        }
        reply = handled && handled.status === 'replied' && handled.reply
          ? mailbox.getEnvelope(handled.reply.delivery_id)
          : mailbox.findReplyDelivery(sourceDeliveryId, context.sender_role_id);
        if (!reply) {
          // A recipient may have completed a turn without producing its
          // business reply. Keep the durable wait until the local deadline;
          // the AAP lease makes a later recovery attempt idempotent.
          if (source.delivery.deadline_at) return;
          deadlock('MAILBOX_REPLY_MISSING');
          return;
        }
      }
      if (reply && aapDispatch && aapAdmission) {
        const replyContent =
          reply.message.content?.trim() ||
          (typeof reply.message.payload.content === 'string'
            ? reply.message.payload.content
            : JSON.stringify(reply.message.payload));
        const replyFrame = this.aapBridge!.createReply({
          ask: aapDispatch.frame,
          status: 'completed',
          summary: replyContent,
          exchange_id: `aap_reply_${reply.message.message_id}`,
        });
        if (this.aapBridge!.acceptReply(aapAdmission, replyFrame) === 'late') {
          processor.expireMailboxWait(
            taskId,
            'Mailbox reply arrived after the local deadline',
          );
          return;
        }
      }
      await this.startRun(
        {
          prompt: context.task_request.spec,
          task_id: taskId,
          task_request: context.task_request,
          workspace_path: continuationWorkspace,
          mode: context.mode,
          ...(context.session_id ? { session_id: context.session_id } : {}),
          ...(context.memory_ablation ? { memory_ablation: context.memory_ablation } : {}),
        },
        {
          run_intent: { type: 'mailbox_continuation', source_delivery_id: sourceDeliveryId },
          restarted_from_run_id: context.run_id,
          cursor_input: {
            cursor: 'execute_agent',
            winner_agent_id: context.sender_role_id,
            mailbox_delivery_id: reply.delivery.delivery_id,
          },
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        const snapshot = processor.getTaskSnapshot(taskId);
        if (snapshot.task.status === 'waiting_help' || snapshot.task.status === 'blocked') {
          deadlock(`CONTINUATION_FAILED: ${message}`);
        }
      } catch {
        // Best-effort: still surface the original continuation failure.
      }
      throw error;
    }
  }

  private mirrorTaskAuthorityEvent(event: AppRunEvent): void {
    const snapshot = this.registry.getSnapshot(event.run_id);
    if (snapshot.events.some((candidate) => candidate.event_id === event.event_id)) return;
    this.registry.appendEvent(event.run_id, event.type, event.payload, {
      event_id: event.event_id,
      created_at: event.created_at,
    });
  }

  private startLegacyRun(params: RunCreateParams, lineage?: RunLineage): Promise<RunCreateResult> {
    if (this.closing) {
      return Promise.reject(new Error('Backend service is closing'));
    }
    const mode = params.mode ?? readDefaultRunMode(process.env);
    const workspacePath = normalizeWorkspacePath(params.workspace_path ?? process.cwd());
    const taskRequest = params.task_request ?? createDefaultTaskRequest(params.prompt);
    const controller = new AbortController();
    let resolvePendingStart!: () => void;
    const pendingStart: PendingRunStart = {
      controller,
      settled: new Promise<void>((resolve) => {
        resolvePendingStart = resolve;
      }),
    };
    let pendingStartSettled = false;
    const settlePendingStart = (): void => {
      if (pendingStartSettled) return;
      pendingStartSettled = true;
      this.pendingRunStarts.delete(pendingStart);
      resolvePendingStart();
    };
    this.pendingRunStarts.add(pendingStart);
    return new Promise<RunCreateResult>((resolve, reject) => {
      let resolveTerminal!: () => void;
      const terminalRun = new Promise<void>((resolveRun) => {
        resolveTerminal = resolveRun;
      });
      let identity: { run_id: string; task_id: string } | undefined;
      const pendingTelemetry: TelemetryRecord[] = [];
      const pendingEvents: Event[] = [];
      const pendingDriverEvents: DriverStreamEvent[] = [];
      const telemetry: TelemetrySink = {
        emit: (record) => {
          if (!identity) {
            pendingTelemetry.push(record);
            return;
          }
          this.appendTelemetry(identity, record);
        },
      };

      let runnerPromise: Promise<IntegrationV0Result>;
      try {
        runnerPromise = this.runner.run({
          prompt: params.prompt,
          mode,
          workspace_path: workspacePath,
          ...(params.session_id ? { session_id: params.session_id } : {}),
          ...(params.task_id ? { task_id: params.task_id } : {}),
          task_request: taskRequest,
          ...(params.memory_ablation ? { memoryAblation: params.memory_ablation } : {}),
          ...(params.worktree_path ? { worktreePath: params.worktree_path } : {}),
          telemetry,
          signal: controller.signal,
          onDriverEvent: (event) => {
            if (!identity) {
              pendingDriverEvents.push(event);
              return;
            }
            this.appendDriverStreamEvent(identity, event);
          },
          onEvent: (event) => {
            if (!identity) {
              pendingEvents.push(event);
              return;
            }
            this.appendDomainEvent(identity, event);
          },
          onRunCreated: (created) => {
            if (identity) return;
            if (this.closing) {
              const error = new Error('Backend service is closing');
              controller.abort(error);
              reject(error);
              throw error;
            }
            identity = created;
            settlePendingStart();
            // legacy 路径同样在 Run 创建点冻结 routing：编排器与 facade 共用这一份投影。
            const legacyDriverConfig = this.driverRouting?.freezeForRun(created.run_id);
            this.terminalRuns.set(created.run_id, terminalRun);
            this.runWorkspaces.set(created.run_id, workspacePath);
            this.registry.create({ ...created, mode, controller });
            const runStartedEvent = createRunStartedEvent(created, mode);
            const taskCreatedEvent = pendingEvents.find(
              (event) => event.event_type === 'task.created',
            );
            const runCreatedEvent = pendingEvents.find(
              (event) => event.event_type === 'run.created',
            );
            try {
              this.taskProcessor?.beginRun({
                ...created,
                task_request: taskRequest,
                workspace_path: workspacePath,
                mode,
                run_intent: lineage?.run_intent ?? { type: 'create' },
                ...(params.session_id ? { session_id: params.session_id } : {}),
                ...(lineage?.restarted_from_run_id &&
                lineage.persist_restarted_from_run_id !== false
                  ? { restarted_from_run_id: lineage.restarted_from_run_id }
                  : {}),
                ...(lineage?.resume_checkpoint_id
                  ? { resume_checkpoint_id: lineage.resume_checkpoint_id }
                  : {}),
                ...(lineage?.requested_resume_cursor
                  ? { requested_resume_cursor: lineage.requested_resume_cursor }
                  : {}),
                ...(lineage?.cursor_input ? { cursor_input: lineage.cursor_input } : {}),
                ...(taskCreatedEvent ? { task_created_event: taskCreatedEvent } : {}),
                ...(runCreatedEvent ? { run_created_event: runCreatedEvent } : {}),
                run_started_event: runStartedEvent,
              });
            } catch (error) {
              controller.abort(error);
              reject(toError(error));
              throw error;
            }
            this.registry.subscribe(created.run_id, (event) => {
              if (this.taskProcessor && shouldPersistRuntimeEvent(event.type)) {
                this.taskProcessor.recordRunEvent(created.run_id, toDomainEvent(event));
              }
              void this.auditWriter.append(event).catch(() => undefined);
              this.notifyTaskListeners(created.task_id, event);
            });
            for (const event of pendingEvents) this.appendDomainEvent(created, event);
            for (const event of pendingDriverEvents) this.appendDriverStreamEvent(created, event);
            this.registry.appendEvent(
              created.run_id,
              'run.started',
              { mode },
              { event_id: runStartedEvent.event_id, created_at: runStartedEvent.created_at },
            );
            for (const record of pendingTelemetry) this.appendTelemetry(created, record);
            void this.requestStore
              .save({
                run_id: created.run_id,
                task_id: created.task_id,
                ...(legacyDriverConfig ? { driver_config: legacyDriverConfig } : {}),
                prompt: params.prompt,
                workspace_path: workspacePath,
                mode,
                task_request: taskRequest,
                ...(params.memory_ablation ? { memory_ablation: params.memory_ablation } : {}),
                ...(params.session_id ? { session_id: params.session_id } : {}),
                ...(params.project_id ? { project_id: params.project_id } : {}),
                ...(params.client_task_id ? { client_task_id: params.client_task_id } : {}),
                ...(params.title ? { title: params.title } : {}),
                ...(params.memory_ablation
                  ? { memory_ablation: params.memory_ablation }
                  : {}),
                ...(lineage?.restarted_from_run_id
                  ? { restarted_from_run_id: lineage.restarted_from_run_id }
                  : {}),
              })
              .then(() => resolve({ ...created, status: 'running' }))
              .catch((error: unknown) => {
                controller.abort(error);
                reject(toError(error));
              });
          },
        });
      } catch (error) {
        settlePendingStart();
        reject(toError(error));
        return;
      }

      void runnerPromise
        .then(async (result) => {
          if (!identity) {
            reject(new Error('Integration runner completed without reporting run identity'));
            return;
          }
          if (result.summary.status === 'completed') {
            const staged = this.registry.stageTerminal(identity.run_id, {
              status: 'completed',
              snapshot: result.frontend_snapshot,
            });
            if (staged) await this.persistTerminal(identity.run_id, staged);
          } else {
            const failure = result.summary.failure;
            const staged = this.registry.stageTerminal(identity.run_id, {
              status: 'failed',
              code: failure?.code ?? 'FLOW_FAILED',
              message: failure?.message ?? 'Integration flow failed',
              ...(failure?.details ? { details: failure.details } : {}),
              snapshot: result.frontend_snapshot,
            });
            if (staged) await this.persistTerminal(identity.run_id, staged);
          }
        })
        .catch(async (error: unknown) => {
          const normalized = toError(error);
          if (!identity) {
            reject(normalized);
            return;
          }
          const staged = this.registry.stageTerminal(identity.run_id, {
            status: 'failed',
            code: error instanceof CouncilRoleExecutionError ? error.code : 'RUNNER_FAILED',
            message: normalized.message,
            ...(error instanceof CouncilRoleExecutionError ? { details: error.details } : {}),
          });
          if (staged) await this.persistTerminal(identity.run_id, staged);
        })
        .then(
          () => {
            settlePendingStart();
            resolveTerminal();
          },
          () => {
            settlePendingStart();
            resolveTerminal();
          },
        );
      void terminalRun.then(() => this.terminalRuns.delete(identity?.run_id ?? ''));
      void terminalRun.then(() => this.runWorkspaces.delete(identity?.run_id ?? ''));
    });
  }

  private async closeGracefully(): Promise<void> {
    const pendingStarts = [...this.pendingRunStarts];
    const closeReason = new Error('Backend service is closing');
    for (const pendingStart of pendingStarts) pendingStart.controller.abort(closeReason);

    const recoveryResult = await Promise.allSettled([this.mailboxRecovery]);
    const cancellationResults = await Promise.allSettled(
      this.registry
        .listSnapshots()
        .filter((run) => run.status === 'running')
        .map((run) => this.cancelRun(run.run_id)),
    );
    await Promise.allSettled(pendingStarts.map((pendingStart) => pendingStart.settled));
    await Promise.allSettled([...this.terminalRuns.values()]);

    let runtimeFailure: unknown;
    try {
      await this.closeRuntime();
    } catch (error) {
      runtimeFailure = error;
    }

    const failures = [...recoveryResult, ...cancellationResults]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (runtimeFailure !== undefined) failures.push(runtimeFailure);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Failed to close backend service cleanly');
    }
  }

  private hasPersistedRun(runId: string): boolean {
    if (!this.taskProcessor) return false;
    try {
      this.taskProcessor.getRunExecutionState(runId);
      return true;
    } catch (error) {
      if (error instanceof TaskProcessorRunNotFoundError) return false;
      throw error;
    }
  }

  getSnapshot(runId: string): AppRunSnapshot {
    return this.registry.getSnapshot(runId);
  }

  getRunSnapshot(runId: string): RunSnapshot {
    // 用量两条腿（proxy 事件、driver 占用累加器）都只在进程内，所以快照投影器
    // （纯函数）拿不到它们，必须在这个组装点补挂。没有该 run 时保持缺席，不编 0。
    const liveRun = this.registry.has(runId) ? this.registry.getSnapshot(runId) : undefined;
    const persisted = this.taskProcessor?.getRunSnapshot(runId);
    if (persisted) {
      const liveProjection = this.terminalRuns.has(runId) ? liveRun : undefined;
      if (
        persisted.status !== 'running' &&
        liveProjection?.status === 'running'
      ) {
        const { final_output: _finalOutput, ...terminalizing } = persisted;
        return this.withLiveObservation(
          {
            ...terminalizing,
            status: 'running',
            current: {
              ...persisted.current,
              stage: 'delivery',
              task_status: 'running',
            },
            ...(persisted.task
              ? {
                  task: {
                    ...persisted.task,
                    status: 'running',
                  },
                }
              : {}),
            ...(persisted.run
              ? {
                  run: {
                    ...persisted.run,
                    status: 'running',
                    completed_at: undefined,
                  },
                }
              : {}),
          },
          liveRun,
        );
      }
      return this.withLiveObservation(persisted, liveRun);
    }
    return this.withLiveObservation(projectRunSnapshot(this.registry.getSnapshot(runId)), liveRun);
  }

  /**
   * 补挂只有本进程才知道的观测：timeline 序号对齐 + `usage` 块 + 在飞 `activity`。
   *
   * 三件事里只有 `usage` 的计费腿**有持久来源**，所以它分两段：在跑的 run 用存活期时间线，
   * 已收尾的 run 用账本（`readDurableRunUsage`）。另外两件都以「registry 确实持有该 run」为
   * 前提，拿不到就原样返回——不编数字、不编 0、不编一个「空闲」。
   */
  private withLiveObservation(
    snapshot: RunSnapshot,
    liveRun: AppRunSnapshot | undefined,
  ): RunSnapshot {
    const durableUsage = this.readDurableRunUsage(snapshot);
    if (!liveRun) {
      // 本进程不持有该 run（进程重启、或这个 run 是别的进程跑的）。此时唯一还能补的是
      // 账本里那一份计费用量——存活期时间线缺席，所以 `by_stage` 与 `context` 照旧缺席。
      const billed = billedFromDurable(durableUsage);
      // 与既有的 `usage` 合并而不是整个替换：账本只对 `billed` 说话，别把将来可能挂上去的
      // 其它块顺手抹掉。
      return billed ? { ...snapshot, usage: { ...snapshot.usage, billed } } : snapshot;
    }
    // 先对齐序号：快照 timeline 原本带的是 SQLite 行号，与推流通道不是一套号。
    const aligned = withAlignedTimeline(snapshot, liveRun.events);
    const usage = projectRunUsage({
      timeline: liveRun.events,
      driverUsage: this.getAccumulatedDriverUsage(snapshot.task_id),
      ...(durableUsage ? { durable: durableUsage } : {}),
      // 「还没到」的腿按 run 状态算：driver 计费腿是收尾时刮出来的，运行中注定没有。
      pendingSources: pendingBilledSources(snapshot.status, this.driverBilledSource),
    });
    // 在飞状态是内存里的，只有本进程持有的 run 才有；没有就是没有这个字段。
    // agent 半边来自进程级状态点，driver 半边从同一条存活期事件流里折出来（含 chunk，
    // 所以 `last_event_at` 能反映「driver 还在动」）。
    const activity = projectRunActivity(listAgentActivities(snapshot.run_id), {
      driver_events: this.registry.listRetainedEvents(snapshot.run_id),
    });
    return {
      ...aligned,
      ...(usage ? { usage } : {}),
      ...(activity ? { activity } : {}),
    };
  }

  /**
   * 已收尾 run 的持久计费用量；在跑的 run 一律返回 `undefined`。
   *
   * 两条判据都不能省：
   *
   * 1. **只对已收尾的 run 读账本。** 账本的行是 run 收尾时写的，在跑的 run 本来就没有行；
   *    而「账本恰好有一行」只可能来自上一次同 id 的收尾，不该覆盖正在累积的存活期时间线。
   * 2. **读失败就当缺席。** 账本是观测，读不出来不该让 `run.getSnapshot` 整个失败——这与
   *    本仓库观测层的既有纪律一致（写入侧同样是吞错 + 留下可见缺口）。
   */
  private readDurableRunUsage(snapshot: RunSnapshot): DurableRunUsage | undefined {
    if (snapshot.status === 'running') return undefined;
    try {
      return this.runUsageHistoryReader?.readRun(snapshot.run_id);
    } catch {
      return undefined;
    }
  }

  async waitForTerminal(runId: string): Promise<void> {
    const before = this.registry.getSnapshot(runId);
    await this.terminalRuns.get(runId);
    const snapshot = this.registry.getSnapshot(runId);
    if (snapshot.status === 'failed' && snapshot.error?.code === 'TERMINAL_OUTPUT_FAILED') {
      throw new Error(snapshot.error.message);
    }
    if (before.status === 'running' && snapshot.status === 'running') {
      throw new Error(`Run ${runId} did not reach a terminal state`);
    }
  }

  /**
   * Wait through Mailbox continuation Runs until the long-lived Task itself is terminal.
   * A Run completed with outcome=mailbox_wait is intentionally not a terminal Task result.
   */
  async waitForTaskTerminal(taskId: string): Promise<TaskSnapshot> {
    for (;;) {
      const snapshot = await this.getTask(taskId);
      if (['completed', 'failed', 'cancelled', 'blocked'].includes(snapshot.task.status)) {
        return snapshot;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  async cancelRun(
    runId: string,
    reason?: RunCancellationReason,
  ): Promise<{ cancelled: true }> {
    const staged = this.registry.stageTerminal(runId, {
      status: 'cancelled',
      ...(reason ? { reason } : {}),
    });
    if (staged) await this.persistTerminal(runId, staged);
    else await this.waitForTerminal(runId);
    const snapshot = this.registry.getSnapshot(runId);
    if (snapshot.status !== 'cancelled') {
      throw new Error(snapshot.error?.message ?? `Run ${runId} already reached ${snapshot.status}`);
    }
    return { cancelled: true };
  }

  /**
   * 订阅某 run 的推流通道。
   *
   * **片段类 driver 事件不发**（`isStreamFragment`，见 `driver-stream-projection.ts`）：
   * 它们是可合并的高频流式片段（实测一个 council run 可达 1.6 万条），逐条推给前端既贵又
   * 不可用——要看思考流该走独立的合并通道。状态类 driver 事件照发，所以「在跑哪个 turn /
   * 哪个工具」在订阅通道上仍然完整。
   *
   * 过滤只在这一层（以及 `notifyTaskListeners`）：registry 仍然保留并投递全部事件，
   * 因为 `audit.jsonl` 与存活期快照要的是完整记录，不是推流那份。
   */
  subscribe(
    runId: string,
    listener: (event: AppRunEvent) => void,
    afterSequence?: number,
  ): () => void {
    return this.registry.subscribe(
      runId,
      (event) => {
        if (!isStreamFragment(event.type)) listener(event);
      },
      afterSequence === undefined ? {} : { after_sequence: afterSequence },
    );
  }

  private isLiveRun(runId: string): boolean {
    return this.terminalRuns.has(runId);
  }

  private requireMailboxService(): PersistentMailboxService {
    if (!this.mailboxService) {
      throw new Error('Mailbox service is not configured');
    }
    return this.mailboxService;
  }

  private requireBMemoryService(): BMemoryBackendService {
    if (!this.bMemoryService) throw new Error('B memory service is unavailable');
    return this.bMemoryService;
  }

  /**
   * 把事件推给 `task.subscribe` 的监听者。
   *
   * 与 `subscribe` 同一条判据：片段类不发（`isStreamFragment`）。这里的调用方是两条
   * registry 订阅（task-loop 与 legacy），它们同时要写 `audit.jsonl`——**审计要全量，
   * 推流只发状态类**，所以过滤放在这一层而不是 registry 的投递里。
   */
  private notifyTaskListeners(taskId: string, event: AppRunEvent): void {
    if (isStreamFragment(event.type)) return;
    for (const listener of this.taskListeners.get(taskId) ?? []) listener(event);
  }

  private async collectTaskSnapshots(): Promise<TaskSnapshot[]> {
    const durableTasks = this.taskProcessor?.listTaskSnapshots() ?? [];
    const durableTaskIds = new Set(durableTasks.map((task) => task.task.task_id));
    const history = await this.requestStore.listHistory();
    const registryRuns = this.registry.listSnapshots();
    const registryRunIds = new Set(registryRuns.map((run) => run.run_id));
    const requestFacts = new Map<string, { task_request: TaskCreateRequest; created_at: string }>();
    const runFacts = new Map<string, TaskRunFact[]>();

    for (const entry of history) {
      if (!entry.task_id || !entry.task_request || !entry.created_at) continue;
      if (durableTaskIds.has(entry.task_id)) continue;
      const existing = requestFacts.get(entry.task_id);
      if (!existing || entry.created_at < existing.created_at) {
        requestFacts.set(entry.task_id, {
          task_request: entry.task_request,
          created_at: entry.created_at,
        });
      }
    }

    await Promise.all(
      history.map(async (entry) => {
        if (
          !entry.task_id ||
          durableTaskIds.has(entry.task_id) ||
          registryRunIds.has(entry.run_id)
        ) {
          return;
        }
        const snapshot = await this.requestStore.loadRunSnapshot(entry.run_id);
        const fact = historicalRunFact(entry, snapshot);
        if (fact) appendRunFact(runFacts, entry.task_id, fact);
      }),
    );

    for (const run of registryRuns) {
      if (durableTaskIds.has(run.task_id)) continue;
      appendRunFact(runFacts, run.task_id, liveRunFact(run));
    }

    const legacyTasks = [...requestFacts.entries()].map(([taskId, request]) =>
      projectTaskSnapshot({
        task_id: taskId,
        task_request: request.task_request,
        created_at: request.created_at,
        runs: runFacts.get(taskId) ?? [],
      }),
    );
    return [...durableTasks, ...legacyTasks].sort((left, right) =>
      right.task.updated_at.localeCompare(left.task.updated_at),
    );
  }

  private appendTelemetry(
    identity: { run_id: string; task_id: string },
    record: TelemetryRecord,
  ): void {
    if (record.source?.kind === 'event_store') return;
    if (record.run_id && record.run_id !== identity.run_id) return;
    if (record.task_id && record.task_id !== identity.task_id) return;
    this.registry.appendEvent(identity.run_id, record.event_type, record.payload);
    this.writeRunTelemetryRecord(identity, record);
  }

  /**
   * 追加一条该 run 的 telemetry 记录到观测文件。
   *
   * 挂在 `appendTelemetry` 而不是构造 sink 的地方：这里是 telemetry 记录归属到某个
   * run 的唯一漏斗，legacy 路径在拿到 identity 之前缓冲的记录也要从这里过一次
   * （`startLegacyRun` 的 pendingTelemetry），挂在别处要么漏掉它们、要么在 run 还没
   * 定身份时无处安放。
   *
   * `run_id` / `task_id` 按 identity 补齐：文件本就按 run 分目录，一行缺 run_id 在
   * 这个文件里就是坏行；registry 那边也是按 identity 归属的，两边口径因此一致。
   */
  private writeRunTelemetryRecord(
    identity: { run_id: string; task_id: string },
    record: TelemetryRecord,
  ): void {
    try {
      void Promise.resolve(
        this.runTelemetryJsonlSink.emit({
          ...record,
          run_id: identity.run_id,
          task_id: record.task_id ?? identity.task_id,
        }),
      ).catch(() => undefined);
    } catch {
      // 落盘是观测：同步抛出也只丢这一条信号，不影响 run。
    }
  }

  /**
   * 把事件追加进进程内 registry（推流通道与存活期快照的来源）。
   *
   * 返回是否真的追加了：调用方要靠这个答案决定后续动作，而「这条事件归谁」的判据
   * 必须只有一份——两条通道对同一条事件不许给出不同结论。
   */
  private appendDomainEvent(identity: { run_id: string; task_id: string }, event: Event): boolean {
    if (event.event_type === 'run.completed' || event.event_type === 'run.failed') return false;
    if (event.run_id && event.run_id !== identity.run_id) return false;
    if (event.task_id && event.task_id !== identity.task_id) return false;
    this.registry.appendEvent(identity.run_id, event.event_type, event.payload, {
      event_id: event.event_id,
      created_at: event.created_at,
    });
    return true;
  }

  /**
   * 把一条**已经进过 registry** 的事件补写进协调事件流（SQLite）。
   *
   * 为什么需要这一层：driver 事件流的投影此前只进进程内 registry 与审计文件
   * （`audit.jsonl` / `driver-stream.jsonl`），**不进协调事件流**。于是进程重启后，
   * 同一个 run 的持久 timeline 里 driver 那一段整个消失，只剩阶段事件——前端在
   * 重启前看得到「正在跑哪个工具」，重启后同一份快照里什么都没有。
   *
   * 为什么吞错：这条路径跑在 driver stderr 的解析回调里（`emitEvent` → 订阅者）。
   * driver 状态是观测，不该因为一次写库失败（run 已终态、revision 冲突、库忙）
   * 改变 run 的结局——与 `CommandDriverTransport.emitEvent`、
   * `FileRunEventConsumptionSink` 是同一条纪律。代价是可见的：事件已经在
   * `audit.jsonl` 上，丢的只是「持久 timeline 里的 driver 状态」这一块的完整性。
   *
   * 只写 `coordination` 通道（见 `driver-stream-projection.ts` 的分流表）；片段类
   * 写进来是量级事故，不是信息保全。
   */
  private persistRunEvent(identity: { run_id: string; task_id: string }, event: Event): void {
    const processor = this.taskProcessor;
    if (!processor) return;
    try {
      processor.recordRunEvent(identity.run_id, {
        ...event,
        // 投影事件的 run_id / task_id 取决于 driver 侧信封，可能缺席。缺席时用本次 run
        // 的身份补齐——`appendDomainEvent` 已经确认它要么属于本 run、要么没有署名。
        run_id: identity.run_id,
        task_id: identity.task_id,
      });
    } catch {
      // 见方法注释：观测失败不改 run 结局。
    }
  }

  private appendDriverStreamEvent(
    identity: { run_id: string; task_id: string },
    event: DriverStreamEvent,
  ): void {
    // run 级单调序号：driver 自带的 event.sequence 每次 invoke 重置，多 invoke 下
    // 不唯一。引用（payload_ref）、账本行与投影 payload 需要 run 内唯一的键，在接收点
    // 统一分配，各带一份。
    const streamSequence = this.nextDriverStreamSequence(identity.run_id);
    // usage 观测在这里进正源（进程内累加），并同步落一份不受保留上限影响的账本。
    // 序号要在写账本前定好，所以先取号；两条通道共用同一个时间戳与同一个提取器，
    // 口径因此不可能分叉。
    const recordedAt = event.created_at ?? new Date().toISOString();
    this.driverUsageFor(identity.task_id).observe(event, recordedAt);
    this.writeDriverUsageRecord(identity, event, recordedAt, streamSequence);
    void this.driverStreamAuditWriter
      .append(identity.run_id, identity.task_id, event, streamSequence)
      .catch(() => undefined);
    const projected = projectDriverStreamLifecycleEvent(event, streamSequence);
    if (!projected) return;
    // 先看 registry 收没收下：收下了才谈别的通道。两条通道对「这条事件归谁」的判据
    // 只有 appendDomainEvent 那一处，所以不会出现「registry 拒收但 SQLite 收下」。
    if (!this.appendDomainEvent(identity, projected)) return;
    // 分流（driver-stream-projection.ts 的 DRIVER_STREAM_CHANNELS）：状态类同时进协调
    // 事件流，让 driver 状态在进程重启后仍可读；片段类只留审计文件与进程内 registry。
    if (driverStreamChannel(projected.event_type) === 'coordination') {
      this.persistRunEvent(identity, projected);
    }
  }

  /**
   * 每个 usage 观测一行，落 `<run>/driver-usage.jsonl`；非 usage 事件直接跳过。
   *
   * 记的是**观测**而不是聚合结果：聚合只能在 run 结尾出生，而 council 恰恰死在结尾
   * ——summary.json 没写出来，进程内正源随之消失，成本只能从截断副本里重建。逐条追加
   * 则写下即完整，进程随后怎么被杀都不影响已在盘上的数字，报表因此可以直读这个文件，
   * 不再依赖 summary 的出生时序。
   *
   * 完整性判据交给读的一侧（带 `cost` 即拿到终值）：写的时候无从知道这个 session 还会
   * 不会有后续 update，在这里虚报完整就是把病灶换个地方重演。
   */
  private writeDriverUsageRecord(
    identity: { run_id: string; task_id: string },
    event: DriverStreamEvent,
    recordedAt: string,
    streamSequence: number,
  ): void {
    const observation = usageObservationFromDriverEvent(event, recordedAt, true);
    if (!observation) return;
    try {
      this.driverUsageSink.emit(
        driverUsageRecordFromObservation(observation, {
          run_id: identity.run_id,
          task_id: identity.task_id,
          stream_sequence: streamSequence,
          recorded_at: recordedAt,
        }),
      );
    } catch {
      // 落盘是观测：同步抛出也只丢这一条信号，不影响 run。
    }
  }

  private nextDriverStreamSequence(runId: string): number {
    const next = (this.driverStreamSequences.get(runId) ?? 0) + 1;
    this.driverStreamSequences.set(runId, next);
    return next;
  }

  /** 任务级 driver usage 累加器（事件流正源）的当前快照；无观测返回 undefined。 */
  getAccumulatedDriverUsage(taskId: string): TaskDriverUsage | undefined {
    return this.driverUsageByTask.get(taskId)?.finalize();
  }

  private driverUsageFor(taskId: string): TaskDriverUsageAccumulator {
    const existing = this.driverUsageByTask.get(taskId);
    if (existing) return existing;
    const created = new TaskDriverUsageAccumulator();
    this.driverUsageByTask.set(taskId, created);
    return created;
  }

  private async persistTerminal(runId: string, staged: StagedTerminalTransition): Promise<void> {
    try {
      await this.driverStreamAuditWriter.flush(runId);
      await this.auditWriter.flush(runId);
      const terminalEvidence = await this.terminalWriter.finalize(staged.snapshot);
      const projected = projectRunSnapshot(staged.snapshot);
      this.taskProcessor?.finishRun({
        run_id: runId,
        status: terminalStatus(staged.snapshot.status),
        ...(staged.snapshot.status === 'completed'
          ? {
              final_output: resolveTaskFinalOutput(
                projected,
                terminalEvidence,
                this.runWorkspaces.get(runId),
              ),
            }
          : {}),
        snapshot: projected,
        ...(staged.snapshot.error ? { error: { ...staged.snapshot.error } } : {}),
        event: toDomainEvent(staged.event),
      });
      this.registry.commitTerminal(runId, staged);
      await this.auditWriter.flush(runId).catch(() => undefined);
    } catch (error) {
      this.registry.abortTerminal(runId, staged.token);
      const failure = this.registry.stageTerminal(runId, {
        status: 'failed',
        code: 'TERMINAL_OUTPUT_FAILED',
        message: toError(error).message,
      });
      if (!failure) return;
      this.taskProcessor?.finishRun({
        run_id: runId,
        status: 'failed',
        ...(failure.snapshot.error ? { error: { ...failure.snapshot.error } } : {}),
        event: toDomainEvent(failure.event),
      });
      this.registry.commitTerminal(runId, failure);
    }
  }
}

function toTaskCreateRequest(params: TaskCreateParams): TaskCreateRequest {
  return {
    spec: params.spec,
    ...(params.role_id ? { role_id: params.role_id } : {}),
    ...(params.parent_task_id ? { parent_task_id: params.parent_task_id } : {}),
    ...(params.deps ? { deps: [...params.deps] } : {}),
    ...(params.risk_level ? { risk_level: params.risk_level } : {}),
    ...(params.affected_paths ? { affected_paths: [...params.affected_paths] } : {}),
    completion_criteria: [...params.completion_criteria],
    ...(params.budget ? { budget: { ...params.budget } } : {}),
  };
}

function appendRunFact(facts: Map<string, TaskRunFact[]>, taskId: string, fact: TaskRunFact): void {
  const current = facts.get(taskId) ?? [];
  current.push(fact);
  facts.set(taskId, current);
}

function liveRunFact(input: AppRunSnapshot): TaskRunFact {
  const snapshot = projectRunSnapshot(input);
  const startedAt = eventTimestamp(input, 'run.started') ?? input.events[0]?.created_at;
  const completedAt = [...input.events]
    .reverse()
    .find((event) =>
      ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type),
    )?.created_at;
  const sessionId = snapshot.run?.session_id ?? snapshot.final_output?.session_id;
  return {
    run_id: input.run_id,
    task_id: input.task_id,
    status: input.status,
    mode: input.mode,
    restartable: input.status !== 'running',
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(completedAt ? { completed_at: completedAt } : {}),
    ...(input.error ? { error: { ...input.error } } : {}),
    revision: input.revision,
    snapshot,
  };
}

function historicalRunFact(
  entry: RunHistoryEntry,
  snapshot: RunSnapshot | undefined,
): TaskRunFact | undefined {
  const taskId = entry.task_id ?? snapshot?.task_id;
  const mode = entry.mode ?? snapshot?.mode;
  if (!taskId || !mode) return undefined;
  const sessionId =
    entry.session_id ?? snapshot?.run?.session_id ?? snapshot?.final_output?.session_id;
  const error = entry.error ?? snapshot?.errors[0];
  return {
    run_id: entry.run_id,
    task_id: taskId,
    status: entry.status,
    mode,
    restartable: entry.restartable,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(snapshot?.run?.started_at
      ? { started_at: snapshot.run.started_at }
      : entry.created_at
        ? { started_at: entry.created_at }
        : {}),
    ...(snapshot?.run?.completed_at ? { completed_at: snapshot.run.completed_at } : {}),
    ...(error ? { error: { ...error } } : {}),
    revision: snapshot?.timeline.length ?? 0,
    ...(snapshot ? { snapshot } : {}),
  };
}

function eventTimestamp(input: AppRunSnapshot, type: string): string | undefined {
  return input.events.find((event) => event.type === type)?.created_at;
}

const PROCESSOR_CONTROL_EVENTS = new Set([
  'task.created',
  'run.created',
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

function createRunStartedEvent(
  identity: { run_id: string; task_id: string },
  mode: AppRunMode,
): Event {
  return {
    event_id: createId('run_event'),
    event_type: 'run.started',
    subject_id: identity.run_id,
    run_id: identity.run_id,
    task_id: identity.task_id,
    payload: { mode },
    created_at: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
  };
}

function shouldPersistRuntimeEvent(type: string): boolean {
  return !PROCESSOR_CONTROL_EVENTS.has(type);
}

function toDomainEvent(event: AppRunEvent): Event {
  return {
    event_id: event.event_id,
    event_type: event.type,
    subject_id:
      typeof event.payload.subject_id === 'string' ? event.payload.subject_id : event.run_id,
    run_id: event.run_id,
    task_id: event.task_id,
    payload: { ...event.payload },
    created_at: event.created_at,
    schema_version: SCHEMA_VERSION,
  };
}

function terminalStatus(status: AppRunSnapshot['status']): 'completed' | 'failed' | 'cancelled' {
  if (status === 'running') throw new Error('Cannot persist a running snapshot as terminal');
  return status;
}

function resolveTaskFinalOutput(
  snapshot: RunSnapshot,
  terminalEvidence: RunTerminalOutputEvidence | void,
  workspacePath: string | undefined,
): { artifact_ref: string; sha256: string; workspace_path: string } {
  if (!workspacePath) throw new Error(`Run ${snapshot.run_id} has no workspace path`);
  const councilResult = councilResultEvidenceSchema.safeParse(snapshot.council?.result);
  if (councilResult.success) {
    return {
      artifact_ref: councilResult.data.final_artifact_ref,
      sha256: councilResult.data.final_artifact_sha256,
      workspace_path: councilArtifactPath(workspacePath, councilResult.data.verification_refs),
    };
  }
  if (!terminalEvidence) {
    throw new Error(`Run ${snapshot.run_id} completed without terminal artifact evidence`);
  }
  return {
    ...terminalEvidence,
    workspace_path: workspacePath,
  };
}

function councilArtifactPath(workspacePath: string, verificationRefs: readonly string[]): string {
  for (const reference of verificationRefs) {
    if (!reference.startsWith('workspace:')) continue;
    const hashSeparator = reference.lastIndexOf(':sha256:');
    if (hashSeparator <= 'workspace:'.length) continue;
    return path.resolve(workspacePath, reference.slice('workspace:'.length, hashSeparator));
  }
  return workspacePath;
}

function normalizeWorkspacePath(input: string): string {
  if (!path.isAbsolute(input)) {
    throw new Error('workspace_path must be an absolute directory');
  }
  try {
    const workspacePath = realpathSync(input);
    if (!statSync(workspacePath).isDirectory()) {
      throw new Error('not a directory');
    }
    return workspacePath;
  } catch {
    throw new Error(`workspace_path must be an existing directory: ${input}`);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * NEWIDE_DEFAULT_RUN_MODE 解析：run.create 未显式传 mode 时用该值决定
 * single_agent / council。默认 single_agent。
 */
export function readDefaultRunMode(env: NodeJS.ProcessEnv): AppRunMode {
  const raw = env.NEWIDE_DEFAULT_RUN_MODE?.trim();
  if (!raw) return 'single_agent';
  if (raw === 'council' || raw === 'single_agent') return raw;
  throw new Error(`Invalid NEWIDE_DEFAULT_RUN_MODE: ${raw}. Expected council or single_agent.`);
}
