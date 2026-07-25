import {
  SCHEMA_VERSION,
  createId,
  nowTimestamp,
  type ArtifactRef,
  type Checkpoint,
  type CheckpointId,
  type Event,
  type EventType,
  type Run,
  type RunId,
  type Task,
  type TaskCreateRequest,
  type TaskId,
} from '../core';
import { observeCheckpoint } from '../telemetry/adapters/c-coordination';
import {
  emitTelemetry,
  mirrorEventToTelemetry,
  NoopTelemetrySink,
  type TelemetrySink,
} from '../telemetry/telemetry-sink';
import { InMemoryArtifactStore } from './artifact-store';
import { InMemoryCheckpointStore } from './checkpoint-store';
import { InMemoryEventStore } from './event-store';
import { assertTaskStatusTransition } from './task-state-machine';

export interface RuntimeStores {
  events: InMemoryEventStore;
  artifacts: InMemoryArtifactStore;
  checkpoints: InMemoryCheckpointStore;
}

export interface RuntimeOrchestratorConfig {
  stores?: Partial<RuntimeStores>;
  telemetry?: TelemetrySink;
  onEvent?: (event: Event) => void;
}

export interface ResumeFromCheckpointResult {
  checkpoint: Checkpoint;
  resume_cursor: string;
  status: 'ready_to_resume' | 'needs_manual_recovery';
}

export class RuntimeOrchestrator {
  readonly stores: RuntimeStores;
  readonly telemetry: TelemetrySink;
  readonly onEvent: ((event: Event) => void) | undefined;
  private readonly tasks = new Map<TaskId, Task>();
  private readonly runs = new Map<RunId, Run>();

  constructor(config?: Partial<RuntimeStores> | RuntimeOrchestratorConfig) {
    const normalized = normalizeOrchestratorConfig(config);
    this.stores = {
      events: normalized.stores?.events ?? new InMemoryEventStore(),
      artifacts: normalized.stores?.artifacts ?? new InMemoryArtifactStore(),
      checkpoints: normalized.stores?.checkpoints ?? new InMemoryCheckpointStore(),
    };
    this.telemetry = normalized.telemetry ?? new NoopTelemetrySink();
    this.onEvent = normalized.onEvent;
  }

  createTask(request: TaskCreateRequest): Task {
    const task = this.buildTask(createId('task'), request);
    this.tasks.set(task.task_id, task);
    this.appendEvent({
      event_type: 'task.created',
      subject_id: task.task_id,
      task_id: task.task_id,
      payload: { spec: task.spec, risk_level: task.risk_level },
    });
    return task;
  }

  attachTaskForRun(taskId: TaskId, request: TaskCreateRequest): Task {
    if (this.tasks.has(taskId)) throw new Error(`Task ${taskId} is already attached`);
    const task = this.buildTask(taskId, request);
    this.tasks.set(task.task_id, task);
    return task;
  }

  createRun(taskId: TaskId): Run {
    const timestamp = nowTimestamp();
    const run: Run = {
      run_id: createId('run'),
      task_id: taskId,
      status: 'created',
      created_at: timestamp,
      updated_at: timestamp,
      schema_version: SCHEMA_VERSION,
    };

    this.runs.set(run.run_id, run);
    this.appendEvent({
      event_type: 'run.created',
      subject_id: run.run_id,
      run_id: run.run_id,
      task_id: taskId,
    });
    return run;
  }

  appendEvent(input: {
    event_type: EventType;
    subject_id: string;
    run_id?: RunId;
    task_id?: TaskId;
    payload?: Record<string, unknown>;
  }): Event {
    const event = this.stores.events.append(input);
    this.onEvent?.(event);
    void mirrorEventToTelemetry(this.telemetry, event);
    return event;
  }

  registerArtifact(artifact: ArtifactRef): ArtifactRef {
    const registered = this.stores.artifacts.register(artifact);
    this.appendEvent({
      event_type: 'artifact.registered',
      subject_id: artifact.artifact_id,
      ...(artifact.task_id ? { task_id: artifact.task_id } : {}),
      payload: {
        type: artifact.type,
        uri: artifact.uri,
        producer_id: artifact.producer_id,
      },
    });
    return registered;
  }

  saveCheckpoint(checkpoint: Checkpoint): Checkpoint {
    const saved = this.stores.checkpoints.save(checkpoint);
    this.appendEvent({
      event_type: 'checkpoint.saved',
      subject_id: checkpoint.checkpoint_id,
      task_id: checkpoint.task_id,
      payload: {
        checkpoint_type: checkpoint.checkpoint_type,
        trigger: checkpoint.trigger,
        artifact_refs: checkpoint.artifact_refs,
      },
    });
    void emitTelemetry(this.telemetry, observeCheckpoint(saved));
    return saved;
  }

  resumeFromCheckpoint(checkpointId: CheckpointId): ResumeFromCheckpointResult {
    const checkpoint = this.stores.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${checkpointId} was not found`);
    }

    return {
      checkpoint,
      resume_cursor: checkpoint.runtime_state?.resume_cursor ?? checkpoint.checkpoint_id,
      status: checkpoint.validity_status === 'valid' ? 'ready_to_resume' : 'needs_manual_recovery',
    };
  }

  updateRunStatus(runId: RunId, status: Run['status']): Run {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run ${runId} was not found`);
    }

    const updated: Run = {
      ...run,
      status,
      updated_at: nowTimestamp(),
    };
    this.runs.set(runId, updated);
    return updated;
  }

  updateTaskStatus(taskId: TaskId, status: Task['status']): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }

    assertTaskStatusTransition(task.status, status);
    const updated: Task = {
      ...task,
      status,
      updated_at: nowTimestamp(),
    };
    this.tasks.set(taskId, updated);
    return updated;
  }

  private buildTask(taskId: TaskId, request: TaskCreateRequest): Task {
    const timestamp = nowTimestamp();
    return {
      task_id: taskId,
      ...(request.parent_task_id ? { parent_id: request.parent_task_id } : {}),
      status: 'created',
      ...(request.role_id ? { role_id: request.role_id } : {}),
      risk_level: request.risk_level ?? 'low',
      spec: request.spec,
      completion_criteria: [...(request.completion_criteria ?? [])],
      ...(request.affected_paths ? { affected_paths: [...request.affected_paths] } : {}),
      ...(request.budget ? { budget: { ...request.budget } } : {}),
      created_at: timestamp,
      updated_at: timestamp,
      schema_version: SCHEMA_VERSION,
    };
  }
}


function normalizeOrchestratorConfig(
  config?: Partial<RuntimeStores> | RuntimeOrchestratorConfig,
): RuntimeOrchestratorConfig {
  if (!config) {
    return {};
  }

  if ('telemetry' in config || 'onEvent' in config) {
    const orchestratorConfig = config as RuntimeOrchestratorConfig & Partial<RuntimeStores>;
    const { telemetry, onEvent, stores, events, artifacts, checkpoints } = orchestratorConfig;
    const legacyStores: Partial<RuntimeStores> = {};
    if (events !== undefined) legacyStores.events = events;
    if (artifacts !== undefined) legacyStores.artifacts = artifacts;
    if (checkpoints !== undefined) legacyStores.checkpoints = checkpoints;
    const resolvedStores =
      stores ?? (Object.keys(legacyStores).length > 0 ? legacyStores : undefined);

    return {
      ...(telemetry ? { telemetry } : {}),
      ...(onEvent ? { onEvent } : {}),
      ...(resolvedStores ? { stores: resolvedStores } : {}),
    };
  }

  if ('stores' in config) {
    return config as RuntimeOrchestratorConfig;
  }

  return { stores: config as Partial<RuntimeStores> };
}
