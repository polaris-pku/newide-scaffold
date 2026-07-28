import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { SCHEMA_VERSION, createId, nowTimestamp, type ArtifactRef } from '../core';
import {
  AgentManager,
  InvokeDriverTool,
  createAgentMemoryScope,
  repositoryRetrieveMemoryForTask,
  type BufferRepository,
  type DispatchTaskResult,
  type DriverContext,
  type DriverTask,
  type MemoryRetrievalResult,
  type MemoryRepository,
  type ToolCallingClient,
} from '../memory';
import type {
  AgentExecutionFacade,
  AgentExecutionOptions,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutionStatus,
} from '../protocol/agent-execution';
import type { AgentTaskRequest } from '../memory/agent-types';
import type {
  CollectCompetitionClaimsOptions,
  CompetitionClaimBatch,
} from '../memory/competition-types';
import type { AgentCompetitionQuery } from '../memory/ports/agent-competition-query';
import type {
  AgentMailboxWakePort,
  AgentMailboxWakeRequestV1,
} from '../protocol/agent-mailbox-wake';
import type {
  DriverRunResult,
  DriverRunStatus,
  DriverRuntimeHandle,
  DriverStreamEvent,
} from '../driver/contract';
import {
  createDriverRuntimeInvoker,
  type DriverRuntimeInvokerInput,
} from '../driver/driver-runtime-invoker';
import type {
  AgentContextPackEvidence,
  AgentExecutionEvidenceStore,
} from './agent-execution-evidence-store';
import type {
  BMemoryMaintenanceEvidence,
  BMemoryMaintenancePort,
} from './b-memory-maintenance-runner';

export interface DriverRuntimeAgentExecutionFacadeOptions {
  driver: DriverRuntimeHandle;
  repository: MemoryRepository;
  bufferRepository: BufferRepository;
  llm: ToolCallingClient;
  evidenceStore?: AgentExecutionEvidenceStore;
  memoryMaintenance?: BMemoryMaintenancePort;
}

interface InvocationContext {
  task_id: string;
  run_id: string;
  instruction: string;
  workspace_path?: string;
  session_id?: string;
  signal?: AbortSignal;
  onDriverEvent?: AgentExecutionOptions['onDriverEvent'];
  execution?: DriverRunResult;
  retrieval: MemoryRetrievalResult;
  driver_invocation_context?: DriverRuntimeInvokerInput['driver_context'];
  driver_attempts: number;
  abortObserved: boolean;
}

const AGENT_SYSTEM_PROMPT = [
  'You execute one role in a Coordinator-managed workflow.',
  'You may call query_memory before delegating when prior context is useful.',
  'Call invoke_driver exactly once with the complete concrete task.',
  'After invoke_driver returns, do not call more tools. Summarize the result and include "[done]".',
].join('\n');

const TOP_LEVEL_MEMORY_ITEM_LIMIT = 5;
const TOP_LEVEL_MEMORY_ID_LIMIT = 120;
const TOP_LEVEL_MEMORY_DESCRIPTION_LIMIT = 240;
const TOP_LEVEL_MEMORY_CONTENT_LIMIT = 1_000;

export class DriverRuntimeAgentExecutionFacade
  implements AgentExecutionFacade, AgentCompetitionQuery, AgentMailboxWakePort
{
  private readonly manager: Promise<AgentManager>;
  private readonly roleReady = new Map<string, Promise<AgentManager>>();
  private readonly invalidatedRoles = new Set<string>();
  private readonly executionQueues = new Map<string, Promise<void>>();
  private readonly invocationContext = new AsyncLocalStorage<InvocationContext>();
  private readonly invokeDriverRuntime: ReturnType<typeof createDriverRuntimeInvoker>;

  constructor(private readonly options: DriverRuntimeAgentExecutionFacadeOptions) {
    this.invokeDriverRuntime = createDriverRuntimeInvoker(options.driver);
    this.manager = this.createManager();
  }

  async ready(): Promise<void> {
    await this.manager;
  }

  private createManager(): Promise<AgentManager> {
    return AgentManager.create(this.options.repository, this.options.bufferRepository, {
      tools: {
        llm: {
          completeWithTools: (input) => this.completeWithTools(input),
        },
        tools: [new InvokeDriverTool((task) => this.invokeDriver(task))],
        systemPrompt: AGENT_SYSTEM_PROMPT,
        maxToolCalls: 4,
      },
    });
  }

  async ensureAgent(agentId: string): Promise<void> {
    await this.ensureRole(agentId);
  }

  async wakeAgent(request: AgentMailboxWakeRequestV1): Promise<void> {
    const agentId = request.recipient_agent_id ?? request.recipient_role_id;
    if (!agentId) throw new Error('Mailbox wake requires an Agent or role recipient');
    await this.ensureAgent(agentId);
  }

  async collectCompetitionClaims(
    task: AgentTaskRequest,
    options?: CollectCompetitionClaimsOptions,
  ): Promise<CompetitionClaimBatch> {
    return (await this.manager).collectCompetitionClaims(task, options);
  }

  async runAgent(
    input: AgentExecutionRequest,
    options?: AgentExecutionOptions,
  ): Promise<AgentExecutionResult> {
    throwIfAborted(options?.signal);
    const normalizedInput = input.workspace_path
      ? { ...input, workspace_path: path.resolve(input.workspace_path) }
      : input;
    const runtimeRoleId = normalizedInput.role_id;
    const queueKeys = [
      `role:${runtimeRoleId}`,
      ...(normalizedInput.workspace_path ? [`workspace:${normalizedInput.workspace_path}`] : []),
    ];
    return this.enqueue(
      queueKeys,
      async () => {
        throwIfAborted(options?.signal);
        const manager = await this.ensureRole(runtimeRoleId);
        return this.execute(manager, normalizedInput, runtimeRoleId, options);
      },
      options?.signal,
    );
  }

  private async execute(
    manager: AgentManager,
    input: AgentExecutionRequest,
    runtimeRoleId: string,
    options?: AgentExecutionOptions,
  ): Promise<AgentExecutionResult> {
    throwIfAborted(options?.signal);
    const task: AgentTaskRequest = {
      spec: input.instruction,
      task_id: input.task_id,
      call_id: createId('call'),
      source_driver: this.options.driver.driver_id,
    };
    const retrieval = await withAbort(
      repositoryRetrieveMemoryForTask(
        createAgentMemoryScope(
          this.options.repository,
          this.options.bufferRepository,
          runtimeRoleId,
        ),
        task,
        input.task_id,
      ),
      options?.signal,
    );
    throwIfAborted(options?.signal);
    const invocation: InvocationContext = {
      task_id: input.task_id,
      run_id: input.run_id,
      instruction: input.instruction,
      ...(input.workspace_path ? { workspace_path: input.workspace_path } : {}),
      ...(input.session_id ? { session_id: input.session_id } : {}),
      retrieval,
      driver_attempts: 0,
      abortObserved: false,
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.onDriverEvent
        ? {
            onDriverEvent: (event: DriverStreamEvent) =>
              options.onDriverEvent?.({ ...event, role_id: input.role_id }),
          }
        : {}),
    };
    const rawDispatch = await this.invocationContext.run(invocation, () =>
      manager.dispatchTask(runtimeRoleId, task),
    );
    const dispatched = withRetrievedMemory(rawDispatch, retrieval, input.instruction);

    if (invocation.abortObserved || (invocation.signal?.aborted && !invocation.execution)) {
      await this.recoverRole(runtimeRoleId);
      throwIfAborted(invocation.signal);
    }
    return this.buildResult(
      input,
      dispatched,
      runtimeRoleId,
      invocation.execution,
      invocation.driver_attempts,
      invocation.driver_invocation_context,
    );
  }

  private async ensureRole(role_id: string): Promise<AgentManager> {
    const existing = this.roleReady.get(role_id);
    if (existing) return existing;

    const manager = this.invalidatedRoles.has(role_id) ? this.createManager() : this.manager;
    const creating = manager
      .then(async (manager) => {
        if (!manager.getAgent(role_id)) {
          await manager.createAgent({ role_id, name: role_id, tags: [] });
        }
        this.invalidatedRoles.delete(role_id);
        return manager;
      })
      .catch((error: unknown) => {
        this.roleReady.delete(role_id);
        throw error;
      });
    this.roleReady.set(role_id, creating);
    return creating;
  }

  private async recoverRole(role_id: string): Promise<void> {
    this.roleReady.delete(role_id);
    this.invalidatedRoles.add(role_id);
    await this.ensureRole(role_id).catch(() => undefined);
  }

  private async completeWithTools(
    input: Parameters<ToolCallingClient['completeWithTools']>[0],
  ): ReturnType<ToolCallingClient['completeWithTools']> {
    const invocation = this.invocationContext.getStore();
    if (!invocation) {
      return this.options.llm.completeWithTools(input);
    }
    try {
      throwIfAborted(invocation.signal);
      return await withAbort(
        this.options.llm.completeWithTools(withTopLevelMemoryContext(input, invocation.retrieval)),
        invocation.signal,
      );
    } catch (error) {
      if (invocation.signal?.aborted) invocation.abortObserved = true;
      throw error;
    }
  }

  private async invokeDriver(task: DriverTask) {
    const invocation = this.invocationContext.getStore();
    if (!invocation) {
      throw new Error('B invoke_driver was called outside an AgentExecutionFacade invocation');
    }
    if (invocation.execution) {
      throw new Error('A C role execution can invoke the driver only once');
    }
    throwIfAborted(invocation.signal);
    try {
      const driverInvocationContext: DriverRuntimeInvokerInput['driver_context'] = {
        task_instruction: invocation.instruction,
        skills: deduplicateMemoryItems([
          ...toDriverMemoryItems(invocation.retrieval.skills),
          ...toMemoryItems('skill', task.context?.skills),
        ]),
        experiences: deduplicateMemoryItems([
          ...toDriverMemoryItems(invocation.retrieval.experiences),
          ...toMemoryItems('experience', task.context?.experiences),
          ...delegationContext(invocation.instruction, task.instruction),
        ]),
      };
      invocation.driver_invocation_context = driverInvocationContext;
      const invoke = () => {
        invocation.driver_attempts += 1;
        return this.invokeDriverRuntime(
          {
            task_id: invocation.task_id,
            run_id: invocation.run_id,
            ...(invocation.workspace_path ? { workspace_path: invocation.workspace_path } : {}),
            ...(invocation.session_id ? { session_id: invocation.session_id } : {}),
            call_id: createId('call'),
            source_driver: this.options.driver.driver_id,
            driver_context: driverInvocationContext,
          },
          invocation.signal || invocation.onDriverEvent
            ? {
                ...(invocation.signal ? { signal: invocation.signal } : {}),
                ...(invocation.onDriverEvent ? { onDriverEvent: invocation.onDriverEvent } : {}),
              }
            : undefined,
        );
      };
      let result = await invoke();
      if (isArtifactFreeRetryableFailure(result.execution)) {
        throwIfAborted(invocation.signal);
        result = await invoke();
      }
      invocation.execution = result.execution;
      return result.report;
    } catch (error) {
      if (invocation.signal?.aborted) invocation.abortObserved = true;
      throw error;
    }
  }

  private async buildResult(
    input: AgentExecutionRequest,
    dispatched: DispatchTaskResult,
    runtimeRoleId: string,
    execution: DriverRunResult | undefined,
    driverAttempts: number,
    driverInvocationContext: DriverRuntimeInvokerInput['driver_context'] | undefined,
  ): Promise<AgentExecutionResult> {
    const memoryMaintenance = await this.processMemoryMaintenance(
      input,
      runtimeRoleId,
      dispatched.cycle.buffer_seq,
    );
    if (!execution) {
      return this.buildNoExecutionResult(
        input,
        dispatched,
        runtimeRoleId,
        driverInvocationContext,
        memoryMaintenance,
      );
    }

    const contextEvidence = await this.persistContextEvidence(
      input,
      dispatched,
      runtimeRoleId,
      driverInvocationContext,
    );

    const dispatchFailed = dispatched.status !== 'completed';
    const dispatchError = dispatchFailed
      ? {
          code: `B_${dispatched.status.toUpperCase()}`,
          message: dispatched.cycle.buffer_snapshot.driver_return.summary,
          retryable: dispatched.status === 'blocked',
        }
      : undefined;

    return {
      agent_run_id: createId('agent_run'),
      agent_id: runtimeRoleId,
      role_id: input.role_id,
      context_pack_ref: contextEvidence.context_pack_ref,
      driver_run_result_id: execution.driver_run_result_id,
      artifact_refs: [...execution.artifacts],
      transcript_ref: execution.transcript_ref,
      session_id: execution.session_id,
      response: execution.response ?? '',
      tool_events: [...execution.tool_events],
      diagnostics: {
        ...execution.diagnostics,
        driver_status: execution.status,
        driver_attempts: driverAttempts,
        dispatch_status: dispatched.status,
        context_policy: input.context_policy,
        input_artifact_refs: [...input.input_artifact_refs],
        buffer_seq: dispatched.cycle.buffer_seq,
        retrieval: {
          experiences: dispatched.cycle.retrieval.experiences.length,
          skills: dispatched.cycle.retrieval.skills.length,
        },
        promotion: dispatched.cycle.promotion.check,
        ...(memoryMaintenance ? { memory_maintenance: memoryMaintenance } : {}),
        context_pack_persisted: contextEvidence.persisted,
        ...(contextEvidence.uri ? { context_pack_uri: contextEvidence.uri } : {}),
        ...(execution.error
          ? { driver_error: { ...execution.error }, driver_error_code: execution.error.code }
          : dispatchError
            ? { driver_error: dispatchError, driver_error_code: dispatchError.code }
            : {}),
      },
      status: mapStatus(dispatched.status, execution.status),
      memory_buffer_ref: contextEvidence.memory_buffer_ref,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }

  private async buildNoExecutionResult(
    input: AgentExecutionRequest,
    dispatched: DispatchTaskResult,
    runtimeRoleId: string,
    driverInvocationContext: DriverRuntimeInvokerInput['driver_context'] | undefined,
    memoryMaintenance: BMemoryMaintenanceEvidence | undefined,
  ): Promise<AgentExecutionResult> {
    const created_at = nowTimestamp();
    const errorCode = `B_${dispatched.status.toUpperCase()}`;
    const errorMessage = dispatched.cycle.buffer_snapshot.driver_return.summary;
    const transcript: ArtifactRef = {
      artifact_id: createId('artifact'),
      type: 'transcript',
      uri: `artifact://transcript/${encodeURIComponent(input.task_id)}/${encodeURIComponent(input.role_id)}`,
      producer_id: this.options.driver.driver_id,
      task_id: input.task_id,
      metadata: { dispatch_status: dispatched.status, error: errorMessage },
      created_at,
      schema_version: SCHEMA_VERSION,
    };
    const contextEvidence = await this.persistContextEvidence(
      input,
      dispatched,
      runtimeRoleId,
      driverInvocationContext,
    );

    return {
      agent_run_id: createId('agent_run'),
      agent_id: runtimeRoleId,
      role_id: input.role_id,
      context_pack_ref: contextEvidence.context_pack_ref,
      driver_run_result_id: createId('driver_result'),
      artifact_refs: [],
      transcript_ref: transcript,
      session_id: this.options.driver.session_id,
      response: '',
      tool_events: [],
      diagnostics: {
        driver_id: this.options.driver.driver_id,
        driver_status: 'failed',
        dispatch_status: dispatched.status,
        driver_error_code: errorCode,
        driver_error: {
          code: errorCode,
          message: errorMessage,
          retryable: dispatched.status === 'blocked',
        },
        context_policy: input.context_policy,
        input_artifact_refs: [...input.input_artifact_refs],
        buffer_seq: dispatched.cycle.buffer_seq,
        retrieval: {
          experiences: dispatched.cycle.retrieval.experiences.length,
          skills: dispatched.cycle.retrieval.skills.length,
        },
        ...(memoryMaintenance ? { memory_maintenance: memoryMaintenance } : {}),
        context_pack_persisted: contextEvidence.persisted,
        ...(contextEvidence.uri ? { context_pack_uri: contextEvidence.uri } : {}),
      },
      status: dispatched.status === 'cancelled' ? 'cancelled' : 'failed',
      memory_buffer_ref: contextEvidence.memory_buffer_ref,
      created_at,
      schema_version: SCHEMA_VERSION,
    };
  }

  private async processMemoryMaintenance(
    input: AgentExecutionRequest,
    runtimeRoleId: string,
    bufferSeq: number,
  ): Promise<BMemoryMaintenanceEvidence | undefined> {
    if (!this.options.memoryMaintenance) return undefined;
    try {
      return await this.options.memoryMaintenance.scheduleBuffer({
        task_id: input.task_id,
        run_id: input.run_id,
        role_id: runtimeRoleId,
        buffer_seq: bufferSeq,
      });
    } catch (error) {
      const completedAt = nowTimestamp();
      return {
        maintenance_ref: createId('b_maintenance'),
        kind: 'experience_extraction',
        status: 'failed',
        task_id: input.task_id,
        run_id: input.run_id,
        role_id: runtimeRoleId,
        buffer_seq: bufferSeq,
        experiences: [],
        skills: [],
        warnings: ['Memory maintenance could not be scheduled; Agent execution was preserved.'],
        error: error instanceof Error ? error.message : String(error),
        created_at: completedAt,
        completed_at: completedAt,
        schema_version: SCHEMA_VERSION,
      };
    }
  }

  private async persistContextEvidence(
    input: AgentExecutionRequest,
    dispatched: DispatchTaskResult,
    runtimeRoleId: string,
    driverInvocationContext: DriverRuntimeInvokerInput['driver_context'] | undefined,
  ): Promise<{
    context_pack_ref: string;
    memory_buffer_ref: string;
    persisted: boolean;
    uri?: string;
  }> {
    const memoryBufferRef = `${runtimeRoleId}:${dispatched.cycle.buffer_seq}`;
    const identity = JSON.stringify({
      task_id: input.task_id,
      run_id: input.run_id,
      agent_id: runtimeRoleId,
      role_id: input.role_id,
      context_policy: input.context_policy,
      input_artifact_refs: input.input_artifact_refs,
      memory_buffer_ref: memoryBufferRef,
      retrieval: dispatched.cycle.retrieval,
      driver_context: dispatched.cycle.driver_context,
      ...(driverInvocationContext ? { driver_invocation_context: driverInvocationContext } : {}),
    });
    const contextPackRef = `context_pack_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
    const evidence: AgentContextPackEvidence = {
      context_pack_id: contextPackRef,
      task_id: input.task_id,
      run_id: input.run_id,
      agent_id: runtimeRoleId,
      role_id: input.role_id,
      context_policy: input.context_policy,
      input_artifact_refs: [...input.input_artifact_refs],
      memory_buffer_ref: memoryBufferRef,
      retrieval: {
        experiences: [...dispatched.cycle.retrieval.experiences],
        skills: [...dispatched.cycle.retrieval.skills],
      },
      driver_context: dispatched.cycle.driver_context,
      ...(driverInvocationContext ? { driver_invocation_context: driverInvocationContext } : {}),
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
    if (!this.options.evidenceStore) {
      return {
        context_pack_ref: contextPackRef,
        memory_buffer_ref: memoryBufferRef,
        persisted: false,
      };
    }
    const saved = await this.options.evidenceStore.saveContextPack(evidence);
    return {
      context_pack_ref: contextPackRef,
      memory_buffer_ref: memoryBufferRef,
      persisted: true,
      uri: saved.uri,
    };
  }

  private enqueue<T>(
    queueKeys: string[],
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = queueKeys.map(
      (queueKey) => this.executionQueues.get(queueKey) ?? Promise.resolve(),
    );
    let started = false;
    const running = Promise.all(previous).then(() => {
      started = true;
      return operation();
    });
    const completed = running.then(
      () => undefined,
      () => undefined,
    );
    for (const queueKey of queueKeys) {
      this.executionQueues.set(queueKey, completed);
    }
    void completed.then(() => {
      for (const queueKey of queueKeys) {
        if (this.executionQueues.get(queueKey) === completed) {
          this.executionQueues.delete(queueKey);
        }
      }
    });
    return rejectWhileQueued(running, signal, () => started);
  }
}

function mapStatus(
  dispatchStatus: DispatchTaskResult['status'],
  driverStatus: DriverRunStatus,
): AgentExecutionStatus {
  if (dispatchStatus === 'cancelled') return 'cancelled';
  if (dispatchStatus !== 'completed') return 'failed';
  return (
    {
      succeeded: 'completed',
      failed: 'failed',
      cancelled: 'cancelled',
      interrupted: 'interrupted',
    } as const
  )[driverStatus];
}

function toMemoryItems(prefix: string, values: string[] | undefined) {
  return (values ?? []).map((content, index) => ({
    id: `${prefix}_${String(index + 1)}`,
    description: `B runtime ${prefix} context`,
    content,
  }));
}

function toDriverMemoryItems(values: Array<{ id: string; description: string; content: string }>) {
  return values.map(({ id, description, content }) => ({ id, description, content }));
}

function deduplicateMemoryItems<T extends { content: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.content)) return false;
    seen.add(value.content);
    return true;
  });
}

function withRetrievedMemory(
  dispatched: DispatchTaskResult,
  retrieval: MemoryRetrievalResult,
  taskInstruction: string,
): DispatchTaskResult {
  const driverContext: DriverContext = {
    task_instruction: taskInstruction,
    skills: [...retrieval.skills],
    experiences: [...retrieval.experiences],
  };
  return {
    ...dispatched,
    cycle: {
      ...dispatched.cycle,
      retrieval: {
        skills: [...retrieval.skills],
        experiences: [...retrieval.experiences],
      },
      driver_context: driverContext,
    },
  };
}

function withTopLevelMemoryContext(
  input: Parameters<ToolCallingClient['completeWithTools']>[0],
  retrieval: MemoryRetrievalResult,
): Parameters<ToolCallingClient['completeWithTools']>[0] {
  const memoryContext = renderTopLevelMemoryContext(retrieval);
  if (!memoryContext) return input;

  let injected = false;
  return {
    ...input,
    messages: input.messages.map((message) => {
      if (injected || message.role !== 'user' || message.content === null) return message;
      injected = true;
      return { ...message, content: `${message.content}\n\n${memoryContext}` };
    }),
  };
}

function renderTopLevelMemoryContext(retrieval: MemoryRetrievalResult): string {
  if (retrieval.skills.length === 0 && retrieval.experiences.length === 0) return '';

  const visibleSkills = retrieval.skills.slice(0, TOP_LEVEL_MEMORY_ITEM_LIMIT);
  const visibleExperiences = retrieval.experiences.slice(
    0,
    TOP_LEVEL_MEMORY_ITEM_LIMIT - visibleSkills.length,
  );
  const visibleCount = visibleSkills.length + visibleExperiences.length;
  const totalCount = retrieval.skills.length + retrieval.experiences.length;
  const sections = [
    renderMemorySection('Approved skills', visibleSkills, retrieval.skills.length),
    renderMemorySection('Eligible experiences', visibleExperiences, retrieval.experiences.length),
  ].filter((section) => section.length > 0);
  return [
    'Retrieved memory selected by B before execution:',
    ...sections,
    ...(visibleCount < totalCount
      ? [`Omitted memory records: ${String(totalCount - visibleCount)}.`]
      : []),
  ].join('\n');
}

function renderMemorySection(
  heading: string,
  records: Array<{ id: string; description: string; content: string }>,
  totalCount: number,
): string {
  if (records.length === 0) return '';
  return [
    `${heading} (shown ${String(records.length)} of ${String(totalCount)}):`,
    ...records.map(
      (record) =>
        `- ${truncate(record.id, TOP_LEVEL_MEMORY_ID_LIMIT)}: ${truncate(record.description, TOP_LEVEL_MEMORY_DESCRIPTION_LIMIT)}\n  ${truncate(record.content, TOP_LEVEL_MEMORY_CONTENT_LIMIT)}`,
    ),
  ].join('\n');
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function delegationContext(original: string, delegated: string) {
  if (delegated.trim() === original.trim()) return [];
  return [{ id: 'b_delegation', description: 'B runtime delegation guidance', content: delegated }];
}

function isArtifactFreeRetryableFailure(execution: DriverRunResult): boolean {
  return (
    execution.status === 'failed' &&
    execution.error?.code === 'EXTERNAL_DRIVER_TRANSPORT_ERROR' &&
    execution.error?.retryable === true &&
    execution.artifacts.length === 0
  );
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function rejectWhileQueued<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  hasStarted: () => boolean,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted && !hasStarted()) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      if (!hasStarted()) reject(abortReason(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException(
    typeof signal.reason === 'string' ? signal.reason : 'The operation was aborted',
    'AbortError',
  );
}
