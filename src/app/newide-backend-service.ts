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
import type { TelemetryRecord, TelemetrySink } from '../telemetry/telemetry-sink';
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
import type { RunSnapshot } from '../protocol/run-snapshot';
import { projectTaskSnapshot, type TaskRunFact } from './task-snapshot-projector';
import { councilResultEvidenceSchema, type TaskSnapshot } from '../protocol/task-snapshot';
import {
  TaskProcessorRunNotFoundError,
  TaskProcessorTaskNotFoundError,
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
  SkillView,
  SkillWritePatch,
} from '../memory';
import type { SkillRecord } from '../memory/schemas';
import type { BMemoryMaintenanceEvidence } from './b-memory-maintenance-runner';
import type { AgentMetaPatch, BMemoryBackendService } from './b-memory-backend-service';
import type { ReviewedSkill } from './b-public-capabilities';
import {
  NoopDriverStreamAuditWriter,
  type DriverStreamAuditWriter,
} from './driver-stream-audit-writer';
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
  memory_ablation?: 'B0' | 'B1' | 'B2' | 'B3';
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
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly runner: CoordinatorRunner = new IntegrationV0CoordinatorRunner(),
    private readonly registry = new InMemoryRunRegistry(),
    private readonly auditWriter: RunAuditWriter = new FileRunAuditWriter(),
    private readonly terminalWriter: RunTerminalOutputWriter = new FileRunTerminalOutputWriter(),
    private readonly requestStore: RunRequestStore = new FileRunRequestStore(),
    private readonly taskProcessor?: TaskProcessor,
    private readonly mailboxService?: PersistentMailboxService,
    private readonly mailboxRecovery: Promise<unknown> = Promise.resolve(),
    private readonly closeRuntime: () => Promise<void> | void = () => undefined,
    private readonly bMemoryService?: BMemoryBackendService,
    private readonly driverStreamAuditWriter: DriverStreamAuditWriter = new NoopDriverStreamAuditWriter(),
    private readonly taskExecutionLoop?: TaskExecutionLoop,
    private readonly systemStatusService: SystemStatusService = createUnavailableSystemStatusService(),
    private readonly mailboxDeliveryWorker?: MailboxDeliveryWorker,
    private readonly participantSessionProvisioner?: ParticipantSessionProvisioner,
  ) {}

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
    return this.requireMailboxService().reply(input);
  }

  listMemoryAgents(): Promise<AgentBoardListItem[]> {
    return this.requireBMemoryService().listAgents();
  }

  getMemoryCapabilities() {
    return this.requireBMemoryService().getCapabilities();
  }

  getMemoryAgent(roleId: string): Promise<AgentBoardAgentView> {
    return this.requireBMemoryService().getAgent(roleId);
  }

  listMemorySkills(roleId: string): Promise<SkillView[]> {
    return this.requireBMemoryService().listSkills(roleId);
  }

  listMemoryExperiences(roleId: string): Promise<ExperienceView[]> {
    return this.requireBMemoryService().listExperiences(roleId);
  }

  listMemoryMaintenance(roleId?: string): Promise<BMemoryMaintenanceEvidence[]> {
    return this.requireBMemoryService().listMaintenance(roleId);
  }

  promoteMemorySkills(roleId: string, requestedBy: string): Promise<BMemoryMaintenanceEvidence> {
    return this.requireBMemoryService().promoteSkills(roleId, requestedBy);
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

  deleteMemoryAgent(roleId: string): Promise<void> {
    return this.requireBMemoryService().deleteAgent(roleId);
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
    memory_ablation?: 'B0' | 'B1' | 'B2' | 'B3';
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
      if (!reply) {
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
        const handled = await worker.process({
          delivery_id: sourceDeliveryId,
          run_id: context.run_id,
        });
        if (
          handled.status === 'retryable_failure' &&
          handled.error?.startsWith('COLLABORATION_DEADLOCK')
        ) {
          processor.blockMailboxDeadlock(taskId, handled.error);
          return;
        }
        reply =
          handled.status === 'replied' && handled.reply
            ? mailbox.getEnvelope(handled.reply.delivery_id)
            : mailbox.findReplyDelivery(sourceDeliveryId, context.sender_role_id);
        if (!reply) {
          deadlock('MAILBOX_REPLY_MISSING');
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
    const persisted = this.taskProcessor?.getRunSnapshot(runId);
    if (persisted) {
      const liveProjection = this.terminalRuns.has(runId)
        ? this.registry.getSnapshot(runId)
        : undefined;
      if (
        persisted.status !== 'running' &&
        liveProjection?.status === 'running'
      ) {
        const { final_output: _finalOutput, ...terminalizing } = persisted;
        return {
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
        };
      }
      return persisted;
    }
    return projectRunSnapshot(this.registry.getSnapshot(runId));
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

  subscribe(runId: string, listener: (event: AppRunEvent) => void): () => void {
    return this.registry.subscribe(runId, listener);
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

  private notifyTaskListeners(taskId: string, event: AppRunEvent): void {
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
  }

  private appendDomainEvent(identity: { run_id: string; task_id: string }, event: Event): void {
    if (event.event_type === 'run.completed' || event.event_type === 'run.failed') return;
    if (event.run_id && event.run_id !== identity.run_id) return;
    if (event.task_id && event.task_id !== identity.task_id) return;
    this.registry.appendEvent(identity.run_id, event.event_type, event.payload, {
      event_id: event.event_id,
      created_at: event.created_at,
    });
  }

  private appendDriverStreamEvent(
    identity: { run_id: string; task_id: string },
    event: DriverStreamEvent,
  ): void {
    void this.driverStreamAuditWriter
      .append(identity.run_id, identity.task_id, event)
      .catch(() => undefined);
    const projected = projectDriverStreamLifecycleEvent(event);
    if (projected) this.appendDomainEvent(identity, projected);
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

function projectDriverStreamLifecycleEvent(event: DriverStreamEvent): Event | undefined {
  const payload: Record<string, unknown> = {
    ...(event.session_id ? { session_id: event.session_id } : {}),
    ...(event.role_id ? { role_id: event.role_id } : {}),
    ...(event.sequence !== undefined ? { event_sequence: event.sequence } : {}),
  };
  const rawPayload = recordValue(event.payload);
  const update = recordValue(rawPayload?.update);
  let eventType: string;
  switch (event.event_type) {
    case 'driver.turn_started':
    case 'turn_started':
      eventType = 'driver.turn_started';
      break;
    case 'driver.turn_completed':
    case 'turn_completed':
      eventType = 'driver.turn_completed';
      addString(payload, 'stop_reason', update?.stopReason);
      break;
    case 'driver.turn_failed':
    case 'turn_failed':
      eventType = 'driver.turn_failed';
      addString(payload, 'reason', update?.reason);
      break;
    case 'driver.interrupt_requested':
      eventType = 'driver.interrupt_requested';
      addString(payload, 'reason', rawPayload?.reason);
      break;
    case 'tool_call':
      eventType = 'driver.tool_started';
      addToolIdentity(payload, update);
      break;
    case 'tool_call_update': {
      const status = update?.status;
      if (status !== 'completed' && status !== 'failed') return undefined;
      eventType = status === 'completed' ? 'driver.tool_completed' : 'driver.tool_failed';
      addToolIdentity(payload, update);
      break;
    }
    default:
      return undefined;
  }
  return {
    event_id: createId('run_event'),
    event_type: eventType,
    subject_id: event.run_id ?? event.session_id ?? event.event_type,
    ...(event.run_id ? { run_id: event.run_id } : {}),
    ...(event.task_id ? { task_id: event.task_id } : {}),
    payload,
    created_at: event.created_at ?? new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
  };
}

function addToolIdentity(
  payload: Record<string, unknown>,
  update: Record<string, unknown> | undefined,
): void {
  addString(payload, 'tool_call_id', update?.toolCallId);
  addString(payload, 'title', update?.title);
  const meta = recordValue(update?._meta);
  const claudeCode = recordValue(meta?.claudeCode);
  addString(payload, 'tool_name', claudeCode?.toolName);
}

function addString(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) target[key] = value;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
