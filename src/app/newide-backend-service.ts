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
  type MessageRecipient,
  type TaskCreateRequest,
} from '../core';
import {
  IntegrationV0CoordinatorRunner,
  type CoordinatorRunner,
} from '../coordinator/coordinator-runner';
import { createDefaultTaskRequest } from '../coordinator/task-request';
import type { TaskResumeCursor } from '../persistence';
import type { TelemetryRecord, TelemetrySink } from '../telemetry/telemetry-sink';
import {
  InMemoryRunRegistry,
  type AppRunEvent,
  type AppRunMode,
  type AppRunSnapshot,
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
  type TaskProcessor,
} from './task-processor';
import type {
  PersistentMailboxService,
  MailboxReplyInput,
  MailboxSendInput,
  MailboxSendResult,
} from './persistent-mailbox-service';
import type { DriverStreamEvent } from '../driver/contract';
import type {
  PersistedMailboxDelivery,
  PersistedMailboxEnvelope,
  SaveMailboxReplyResult,
} from '../persistence';
import type { AgentBoardAgentView, AgentBoardListItem, ExperienceView, SkillView } from '../memory';
import type { BMemoryMaintenanceEvidence } from './b-memory-maintenance-runner';
import type { BMemoryBackendService } from './b-memory-backend-service';
import {
  NoopDriverStreamAuditWriter,
  type DriverStreamAuditWriter,
} from './driver-stream-audit-writer';

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

interface RunLineage {
  run_intent?: BeginTaskRunIntent;
  restarted_from_run_id?: string;
  persist_restarted_from_run_id?: boolean;
  resume_checkpoint_id?: string;
  requested_resume_cursor?: TaskResumeCursor;
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
  ) {}

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
    recipient: MessageRecipient,
    afterDeliveryId?: string,
  ): Promise<PersistedMailboxEnvelope[]> {
    await this.mailboxRecovery;
    return this.requireMailboxService().inbox(recipient, afterDeliveryId);
  }

  async acknowledgeMailboxDelivery(
    deliveryId: string,
    recipient: MessageRecipient,
  ): Promise<PersistedMailboxDelivery> {
    await this.mailboxRecovery;
    return this.requireMailboxService().ack(deliveryId, recipient);
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
    const resume = this.taskProcessor.getTaskResumeContext(taskId);
    await this.startRun(
      {
        prompt: resume.task_request.spec,
        task_id: taskId,
        task_request: resume.task_request,
        workspace_path: resume.workspace_path,
        mode: resume.mode,
        ...(resume.session_id ? { session_id: resume.session_id } : {}),
      },
      {
        run_intent: { type: 'checkpoint_resume', strategy: 'restart_from_beginning' },
        restarted_from_run_id: resume.interrupted_run_id,
        resume_checkpoint_id: resume.checkpoint_id,
        requested_resume_cursor: resume.resume_cursor,
      },
    );
    return this.getTask(taskId);
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
    if (this.closing) {
      return Promise.reject(new Error('Backend service is closing'));
    }
    const mode = params.mode ?? 'single_agent';
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
                ...(params.session_id ? { session_id: params.session_id } : {}),
                ...(params.project_id ? { project_id: params.project_id } : {}),
                ...(params.client_task_id ? { client_task_id: params.client_task_id } : {}),
                ...(params.title ? { title: params.title } : {}),
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
    try {
      return projectRunSnapshot(this.registry.getSnapshot(runId));
    } catch (error) {
      const persisted = this.taskProcessor?.getRunSnapshot(runId);
      if (persisted) return persisted;
      throw error;
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

  async cancelRun(runId: string): Promise<{ cancelled: true }> {
    const staged = this.registry.stageTerminal(runId, { status: 'cancelled' });
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
