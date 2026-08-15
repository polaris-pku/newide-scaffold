import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SCHEMA_VERSION,
  createId,
  nowTimestamp,
  type AgentMessageType,
  type ArtifactRef,
} from '../core';
import {
  diffWorkspaceFiles,
  isDeliverableWorkspacePath,
  snapshotWorkspaceFiles,
  type WorkspaceFileSnapshot,
} from '../coordinator/workspace-change-detector';
import {
  AgentManager,
  InvokeDriverTool,
  createAgentMemoryScope,
  repositoryRetrieveMemoryForTask,
  resolveMemoryAblationPolicy,
  runWithMemoryAblationPolicy,
  type AgentTaskRequest,
  type BufferRepository,
  type CollectCompetitionClaimsOptions,
  type CompetitionClaimBatch,
  type DispatchTaskResult,
  type DriverContext,
  type DriverTask,
  type EmbeddingProvider,
  type MemoryRetrievalResult,
  type MemoryRepository,
  type ToolCallingClient,
} from '../memory';
import {
  MailboxSendTool,
  expectsMailboxReply,
  type MailboxSendToolInput,
  type MailboxToolOutcome,
  type PersistedMailboxEnvelope,
  type PersistentMailboxService,
} from '../mailbox';
import type {
  AgentExecutionFacade,
  AgentExecutionOptions,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutionStatus,
} from '../protocol/agent-execution';
import type {
  ParticipantSessionProvisionRequest,
  ParticipantSessionRegistry,
} from '../coordination/participant-session-registry';
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
  embedding?: EmbeddingProvider;
  evidenceStore?: AgentExecutionEvidenceStore;
  memoryMaintenance?: BMemoryMaintenancePort;
  mailbox?: {
    service: PersistentMailboxService;
    allowedRoleIds: readonly string[];
    defaultDeadlineSeconds?: number;
    sessionRegistry?: ParticipantSessionRegistry;
  };
}

interface InvocationContext {
  task_id: string;
  run_id: string;
  role_id: string;
  instruction: string;
  driver_instruction: string;
  driver_instruction_locked: boolean;
  workspace_path?: string;
  session_id?: string;
  signal?: AbortSignal;
  onDriverEvent?: AgentExecutionOptions['onDriverEvent'];
  execution?: DriverRunResult;
  retrieval: MemoryRetrievalResult;
  driver_invocation_context?: DriverRuntimeInvokerInput['driver_context'];
  agent_system_prompt_sha256?: string;
  inbound_mailbox?: PersistedMailboxEnvelope;
  notice_mailboxes: PersistedMailboxEnvelope[];
  mailbox_outcomes: MailboxToolOutcome[];
  mailbox_sequence: number;
  collaboration_brief?: string;
  driver_attempts: number;
  abortObserved: boolean;
}

const AGENT_RUNTIME_POLICY_ID = 'b-persona-tools-v1';
const TOP_LEVEL_MEMORY_ITEM_LIMIT = 5;
const TOP_LEVEL_MEMORY_ID_LIMIT = 120;
const TOP_LEVEL_MEMORY_DESCRIPTION_LIMIT = 240;
const TOP_LEVEL_MEMORY_CONTENT_LIMIT = 1_000;
const DEFAULT_MAILBOX_DEADLINE_SECONDS = 300;

export class DriverRuntimeAgentExecutionFacade implements AgentExecutionFacade {
  private readonly manager: Promise<AgentManager>;
  private readonly roleReady = new Map<string, Promise<AgentManager>>();
  private readonly invalidatedRoles = new Set<string>();
  private readonly executionQueues = new Map<string, Promise<void>>();
  private readonly sessionProvisioning = new Map<string, Promise<string>>();
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
    const tools = [
      new InvokeDriverTool((task) => this.invokeDriver(task)),
      ...(this.options.mailbox
        ? [new MailboxSendTool((input) => this.sendMailbox(input))]
        : []),
    ];
    return AgentManager.create(this.options.repository, this.options.bufferRepository, {
      tools: {
        llm: {
          completeWithTools: (input) => this.completeWithTools(input),
        },
        tools,
        maxToolCalls: this.options.mailbox ? 6 : 4,
      },
      ...(this.options.embedding ? { embedding: this.options.embedding } : {}),
    });
  }

  async ensureAgent(agentId: string): Promise<void> {
    await this.ensureRole(agentId);
  }

  async provisionParticipantSession(input: ParticipantSessionProvisionRequest): Promise<string> {
    const workspacePath = path.resolve(input.workspace_path);
    const existing = this.options.mailbox?.sessionRegistry?.get(
      input.task_id,
      workspacePath,
      input.role_id,
    );
    if (existing) return existing;
    const key = `${input.task_id}\u0000${workspacePath}\u0000${input.role_id}`;
    const pending = this.sessionProvisioning.get(key);
    if (pending) return pending;
    const provisioning = this.createParticipantSession({
      ...input,
      workspace_path: workspacePath,
    }).finally(() => this.sessionProvisioning.delete(key));
    this.sessionProvisioning.set(key, provisioning);
    return provisioning;
  }

  private async createParticipantSession(
    input: ParticipantSessionProvisionRequest,
  ): Promise<string> {
    await this.ensureRole(input.role_id);
    const result = await this.options.driver.sendPrompt({
      task_id: input.task_id,
      run_id: `${input.run_id}:session-provision:${input.role_id}`,
      prompt: [
        'NewIDE session initialization only.',
        `Register this ACP session for collaboration role ${input.role_id}.`,
        'Do not modify files, call tools, or solve the task. Reply with SESSION_READY and stop.',
        'This instruction applies only to this initialization turn; every later turn must follow its newest task instruction instead.',
      ].join('\n'),
      workspace_path: input.workspace_path,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    });
    const usableSession =
      Boolean(result.session_id) &&
      result.session_id !== this.options.driver.session_id &&
      result.session_id !== 'session-unavailable';
    // Claude Agent SDK can stream SESSION_READY then throw a DeepSeek 402 on a
    // follow-up (title / telemetry). The init turn already succeeded.
    const sessionReady = /\bSESSION_READY\b/.test(result.response ?? '');
    if (!usableSession || (result.status !== 'succeeded' && !sessionReady)) {
      const detail = result.error?.message ?? result.diagnostics.notes.join('; ');
      throw new Error(
        `ACP did not create a usable Session for ${input.role_id} (status=${result.status}${detail ? `, detail=${detail}` : ''})`,
      );
    }
    this.options.mailbox?.sessionRegistry?.register({
      task_id: input.task_id,
      workspace_path: input.workspace_path,
      role_id: input.role_id,
      session_id: result.session_id,
    });
    return result.session_id;
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
    let boundSession =
      normalizedInput.workspace_path && this.options.mailbox?.sessionRegistry
        ? this.options.mailbox.sessionRegistry.get(
            normalizedInput.task_id,
            normalizedInput.workspace_path,
            normalizedInput.role_id,
          )
        : undefined;
    if (
      !normalizedInput.session_id &&
      !boundSession &&
      normalizedInput.workspace_path &&
      this.options.mailbox?.sessionRegistry
    ) {
      boundSession = await this.provisionParticipantSession({
        task_id: normalizedInput.task_id,
        workspace_path: normalizedInput.workspace_path,
        role_id: normalizedInput.role_id,
        run_id: normalizedInput.run_id,
      });
    }
    const scopedInput =
      normalizedInput.session_id || !boundSession
        ? normalizedInput
        : { ...normalizedInput, session_id: boundSession };
    const runtimeRoleId = scopedInput.role_id;
    // Mailbox semantics serialize one logical role, while different roles
    // remain runnable in parallel even when they share a workspace.
    const queueKeys = [
      `role:${runtimeRoleId}`,
    ];
    return this.enqueue(
      queueKeys,
      async () => {
        throwIfAborted(options?.signal);
        const manager = await this.ensureRole(runtimeRoleId);
        const result = await this.execute(manager, scopedInput, runtimeRoleId, options);
        const effectiveSessionId = scopedInput.session_id ?? result.session_id;
        if (
          effectiveSessionId &&
          scopedInput.workspace_path &&
          this.options.mailbox?.sessionRegistry &&
          result.status === 'completed'
        ) {
          this.options.mailbox.sessionRegistry.register({
            task_id: scopedInput.task_id,
            workspace_path: scopedInput.workspace_path,
            role_id: scopedInput.role_id,
            session_id: effectiveSessionId,
          });
        }
        if (result.status === 'completed' && scopedInput.workspace_path) {
          this.finishNoticeMailbox(scopedInput, result);
        }
        return result;
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
    const ablationPolicy = resolveMemoryAblationPolicy(input.memory_ablation);
    const task: AgentTaskRequest = {
      spec: input.instruction,
      task_id: input.task_id,
      call_id: createId('call'),
      source_driver: this.options.driver.driver_id,
    };
    const inboundMailbox = input.mailbox_delivery_id
      ? this.requireInboundMailbox(input)
      : undefined;
    const noticeMailboxes =
      !input.mailbox_delivery_id && input.workspace_path && this.options.mailbox
        ? this.options.mailbox.service
            .inbox(input.task_id, input.workspace_path, input.role_id)
            .filter(
              (envelope) =>
                isMailboxDeliveryAvailable(envelope) && !envelopeExpectsReply(envelope),
            )
        : [];
    return runWithMemoryAblationPolicy(ablationPolicy, async () => {
      const retrieval = await withAbort(
        repositoryRetrieveMemoryForTask(
          createAgentMemoryScope(
            this.options.repository,
            this.options.bufferRepository,
            runtimeRoleId,
          ),
          task,
          input.task_id,
          {
            ...(this.options.embedding ? { embedding: this.options.embedding } : {}),
            selection: {
              include_skills: ablationPolicy.include_skills,
              include_recent_experience: ablationPolicy.include_recent_experience,
            },
          },
        ),
        options?.signal,
      );
      throwIfAborted(options?.signal);
      const invocation: InvocationContext = {
        task_id: input.task_id,
        run_id: input.run_id,
        role_id: runtimeRoleId,
        instruction: input.instruction,
        driver_instruction: input.driver_instruction ?? input.instruction,
        driver_instruction_locked: input.driver_instruction !== undefined,
        ...(input.workspace_path ? { workspace_path: input.workspace_path } : {}),
        ...(input.session_id ? { session_id: input.session_id } : {}),
        retrieval,
        ...(inboundMailbox ? { inbound_mailbox: inboundMailbox } : {}),
        notice_mailboxes: noticeMailboxes,
        mailbox_outcomes: [],
        mailbox_sequence: 0,
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
      const workspaceBefore = input.workspace_path
        ? await snapshotWorkspaceFiles(input.workspace_path)
        : undefined;
      const rawDispatch = await this.invocationContext.run(invocation, () =>
        manager.dispatchTask(runtimeRoleId, task),
      );
      const dispatched = withRetrievedMemory(rawDispatch, retrieval, input.instruction);
      const workspaceArtifacts = await collectWorkspaceArtifacts(
        input,
        workspaceBefore,
        invocation.execution,
      );

      if (invocation.abortObserved || (invocation.signal?.aborted && !invocation.execution)) {
        await this.recoverRole(runtimeRoleId);
        throwIfAborted(invocation.signal);
      }
      const result = await this.buildResult(
        input,
        dispatched,
        runtimeRoleId,
        invocation.execution,
        workspaceArtifacts,
        invocation.driver_attempts,
        invocation.driver_invocation_context,
        invocation.agent_system_prompt_sha256,
        invocation.mailbox_outcomes,
      );
      if (inboundMailbox && result.status === 'completed') {
        this.finishInboundMailbox(
          inboundMailbox,
          result,
          invocation.mailbox_outcomes,
          input.session_id,
        );
      }
      return result;
    });
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
      const systemPromptSha256 = hashSystemPrompt(input.messages);
      if (systemPromptSha256) {
        invocation.agent_system_prompt_sha256 ??= systemPromptSha256;
      }
      const pendingReply = invocation.mailbox_outcomes.find(
        (outcome) => outcome.kind === 'request' && outcome.wait_for_reply,
      );
      const completedReply = invocation.mailbox_outcomes.find(
        (outcome) => outcome.kind === 'reply',
      );
      if (pendingReply) {
        return {
          content: `Mailbox request ${pendingReply.message_id} persisted; waiting for ${pendingReply.to_role_id}. [done]`,
          tool_calls: undefined,
        };
      }
      if (completedReply) {
        return {
          content: `Mailbox reply ${completedReply.message_id} persisted. [done]`,
          tool_calls: undefined,
        };
      }
      invocation.collaboration_brief ??= await this.buildCollaborationBrief(invocation);
      return await withAbort(
        this.options.llm.completeWithTools(
          withTopLevelExecutionContext(
            input,
            invocation.retrieval,
            invocation.collaboration_brief,
          ),
        ),
        invocation.signal,
      );
    } catch (error) {
      if (invocation.signal?.aborted) invocation.abortObserved = true;
      throw error;
    }
  }

  private requireInboundMailbox(input: AgentExecutionRequest): PersistedMailboxEnvelope {
    const mailbox = this.options.mailbox;
    if (!mailbox || !input.mailbox_delivery_id) {
      throw new Error('Mailbox delivery execution requires configured Mailbox runtime');
    }
    const envelope = mailbox.service.getEnvelope(input.mailbox_delivery_id);
    if (
      envelope.message.task_id !== input.task_id ||
      envelope.delivery.task_id !== input.task_id ||
      envelope.delivery.recipient_role_id !== input.role_id ||
      !input.workspace_path ||
      path.resolve(envelope.message.workspace_path) !== path.resolve(input.workspace_path) ||
      path.resolve(envelope.delivery.workspace_path) !== path.resolve(input.workspace_path)
    ) {
      throw new Error('Mailbox delivery does not match the Agent invocation scope');
    }
    return envelope;
  }

  private async sendMailbox(input: MailboxSendToolInput): Promise<MailboxToolOutcome> {
    const mailbox = this.options.mailbox;
    const invocation = this.invocationContext.getStore();
    if (!mailbox || !invocation) {
      throw new Error('mailbox.send was called outside a configured Agent invocation');
    }
    const kind = input.kind ?? legacyMailboxKind(input.type);
    const content = input.content ?? legacyMailboxContent(input.payload);
    if (!input.to_role_id?.trim() || !kind || !content) {
      throw new Error('mailbox_send requires to_role_id, kind and content');
    }
    if (!invocation.workspace_path) {
      throw new Error('mailbox.send requires a workspace-bound Agent invocation');
    }
    if (!mailbox.allowedRoleIds.includes(input.to_role_id)) {
      throw new Error(`Mailbox recipient ${input.to_role_id} is not in the collaboration roster`);
    }
    invocation.mailbox_sequence += 1;
    const waitForReply = expectsMailboxReply(kind);
    if (
      waitForReply &&
      invocation.mailbox_outcomes.some(
        (outcome) => outcome.kind === 'request' && outcome.wait_for_reply,
      )
    ) {
      throw new Error('An Agent turn can wait for only one Mailbox reply');
    }
    const idempotencyKey = `${invocation.run_id}:mailbox:${String(invocation.mailbox_sequence)}`;
    const deadlineSeconds =
      mailbox.defaultDeadlineSeconds ?? DEFAULT_MAILBOX_DEADLINE_SECONDS;

    if (
      invocation.inbound_mailbox &&
      envelopeExpectsReply(invocation.inbound_mailbox)
    ) {
      const inbound = invocation.inbound_mailbox;
      if (input.to_role_id !== inbound.message.from_role_id) {
        throw new Error(
          `Mailbox reply must target the sender role ${inbound.message.from_role_id}`,
        );
      }
      const sessionId = invocation.execution?.session_id ?? invocation.session_id;
      if (!sessionId) {
        throw new Error('Invoke the driver before replying so the target Session is known');
      }
      const source = mailbox.service.markInjected(
        inbound.delivery.delivery_id,
        invocation.role_id,
        sessionId,
      );
      const reply = await mailbox.service.reply({
        source_delivery_id: source.delivery_id,
        from_role_id: invocation.role_id,
        kind: kind === 'request' ? 'notice' : kind,
        content,
        ...(input.type ? { type: input.type } : {}),
        ...(input.payload ? { payload: { ...input.payload } } : {}),
        ...(input.artifact_refs ? { artifact_refs: [...input.artifact_refs] } : {}),
        requires_ack: false,
        idempotency_key: idempotencyKey,
      });
      const replyDelivery = reply.reply.deliveries[0];
      if (!replyDelivery) throw new Error('Mailbox reply did not create a Delivery');
      const outcome: MailboxToolOutcome = {
        kind: 'reply',
        message_id: reply.reply.message.message_id,
        delivery_id: replyDelivery.delivery_id,
        thread_id: reply.reply.message.thread_id,
        from_role_id: invocation.role_id,
        to_role_id: replyDelivery.recipient_role_id,
        status: replyDelivery.status === 'injected' ? 'injected' : 'pending',
        wait_for_reply: false,
        source_delivery_id: source.delivery_id,
      };
      invocation.mailbox_outcomes.push(outcome);
      return outcome;
    }
    if (invocation.inbound_mailbox && !invocation.execution) {
      throw new Error(
        'Process the inbound Mailbox delivery with invoke_driver before sending another message',
      );
    }

    const sent = await mailbox.service.send({
      task_id: invocation.task_id,
      workspace_path: invocation.workspace_path,
      thread_id: createId('thread'),
      from_role_id: invocation.role_id,
      to_role_id: input.to_role_id,
      kind,
      content,
      ...(input.type ? { type: input.type } : {}),
      ...(input.payload ? { payload: { ...input.payload } } : {}),
      ...(input.artifact_refs ? { artifact_refs: [...input.artifact_refs] } : {}),
      requires_ack: waitForReply,
      ...(waitForReply ? { deadline_seconds: deadlineSeconds } : {}),
      idempotency_key: idempotencyKey,
    });
    const delivery = sent.deliveries[0];
    if (!delivery) throw new Error('Mailbox send did not create a Delivery');
    const outcome: MailboxToolOutcome = {
      kind: waitForReply ? 'request' : 'notice',
      message_id: sent.message.message_id,
      delivery_id: delivery.delivery_id,
      thread_id: sent.message.thread_id,
      from_role_id: invocation.role_id,
      to_role_id: delivery.recipient_role_id,
      status: 'pending',
      wait_for_reply: waitForReply,
    };
    invocation.mailbox_outcomes.push(outcome);
    return outcome;
  }

  private finishInboundMailbox(
    inbound: PersistedMailboxEnvelope,
    result: AgentExecutionResult,
    outcomes: readonly MailboxToolOutcome[],
    boundSessionId?: string,
  ): void {
    const mailbox = this.options.mailbox;
    if (!mailbox) return;
    const current = mailbox.service.getEnvelope(inbound.delivery.delivery_id).delivery;
    const injected =
      current.status === 'pending'
      ? mailbox.service.markInjected(
            current.delivery_id,
            current.recipient_role_id,
            boundSessionId ?? result.session_id,
          )
        : current;
    const replied = outcomes.some(
      (outcome) =>
        outcome.kind === 'reply' && outcome.source_delivery_id === injected.delivery_id,
    );
    if (
      injected.status === 'injected' &&
      (!envelopeExpectsReply(inbound) || replied)
    ) {
      mailbox.service.ack(injected.delivery_id, injected.recipient_role_id);
    }
  }

  private async buildCollaborationBrief(invocation: InvocationContext): Promise<string> {
    const mailbox = this.options.mailbox;
    if (!mailbox) return '';
    const allowed = new Set(mailbox.allowedRoleIds);
    const roleIds = (await this.options.repository.listAgentIds()).filter((roleId) =>
      allowed.has(roleId),
    );
    const members = await Promise.all(
      roleIds.map((roleId) => this.options.repository.getAgent(roleId)),
    );
    const inbound = invocation.inbound_mailbox;
    return [
      'Collaboration brief:',
      `- Current role: ${invocation.role_id}`,
      `- Task: ${invocation.task_id}`,
      `- Workspace: ${invocation.workspace_path ?? '(not bound)'}`,
      '- Available teammate roles:',
      ...members.map(
        (member) =>
          `  - ${member.role_id} (${member.name}, ${member.status}): ${truncate(member.persona.summary, TOP_LEVEL_MEMORY_DESCRIPTION_LIMIT)}`,
      ),
      '- Communication: use mailbox_send(to_role_id, kind, content, artifact_refs?).',
      ...(inbound
        ? [
            '- Inbound delivery takes precedence over the original Task wording; do not repeat the original outbound request.',
          ]
        : []),
      ...(inbound
        ? [
            'Inbound mailbox envelope:',
            `- delivery_id: ${inbound.delivery.delivery_id}`,
            `- message_id: ${inbound.message.message_id}`,
            `- thread_id: ${inbound.message.thread_id}`,
            `- from_role_id: ${inbound.message.from_role_id}`,
            `- kind: ${inbound.message.kind ?? legacyMailboxKind(inbound.message.type) ?? 'notice'}`,
            `- content: ${inbound.message.content ?? legacyMailboxContent(inbound.message.payload) ?? JSON.stringify(inbound.message.payload)}`,
            ...(inbound.message.artifact_refs.length > 0
              ? [`- artifact_refs: ${JSON.stringify(inbound.message.artifact_refs)}`]
              : []),
            ...(envelopeExpectsReply(inbound)
              ? [
                  '- Process the request through invoke_driver first, then reply with mailbox_send to the sender role.',
                ]
              : [
                  '- Process this message through invoke_driver and continue the Task; no Mailbox acknowledgement tool call is required.',
                ]),
          ]
        : []),
      ...(invocation.notice_mailboxes.length > 0
        ? [
            'Durable notices available on this natural turn:',
            ...invocation.notice_mailboxes.map(
              (notice) =>
                `- delivery_id: ${notice.delivery.delivery_id}; from_role_id: ${notice.message.from_role_id}; ` +
                `content: ${notice.message.content ?? legacyMailboxContent(notice.message.payload) ?? JSON.stringify(notice.message.payload)}` +
                (notice.message.artifact_refs.length > 0
                  ? `; artifact_refs: ${JSON.stringify(notice.message.artifact_refs)}`
                  : ''),
            ),
          ]
        : []),
    ].join('\n');
  }

  private finishNoticeMailbox(
    input: AgentExecutionRequest,
    result: AgentExecutionResult,
  ): void {
    const mailbox = this.options.mailbox;
    if (!mailbox || !input.workspace_path) return;
    const notices = mailbox.service
      .inbox(input.task_id, input.workspace_path, input.role_id)
      .filter(
        (envelope) => isMailboxDeliveryAvailable(envelope) && !envelopeExpectsReply(envelope),
      );
    for (const notice of notices) {
      const current = mailbox.service.getEnvelope(notice.delivery.delivery_id).delivery;
      const injected =
        current.status === 'pending'
          ? mailbox.service.markInjected(
              current.delivery_id,
              current.recipient_role_id,
              input.session_id ?? result.session_id,
            )
          : current;
      if (injected.status === 'injected') {
        mailbox.service.ack(injected.delivery_id, injected.recipient_role_id);
      }
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
        task_instruction: invocation.driver_instruction,
        skills: deduplicateMemoryItems([
          ...toDriverMemoryItems(invocation.retrieval.skills),
          ...toMemoryItems('skill', task.context?.skills),
        ]),
        experiences: deduplicateMemoryItems([
          ...toDriverMemoryItems(invocation.retrieval.experiences),
          ...toMemoryItems('experience', task.context?.experiences),
          ...(invocation.driver_instruction_locked
            ? []
            : delegationContext(invocation.driver_instruction, task.instruction)),
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
    workspaceArtifacts: ArtifactRef[],
    driverAttempts: number,
    driverInvocationContext: DriverRuntimeInvokerInput['driver_context'] | undefined,
    agentSystemPromptSha256: string | undefined,
    mailboxOutcomes: readonly MailboxToolOutcome[],
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
        agentSystemPromptSha256,
        workspaceArtifacts,
        memoryMaintenance,
        mailboxOutcomes,
      );
    }

    const contextEvidence = await this.persistContextEvidence(
      input,
      dispatched,
      runtimeRoleId,
      driverInvocationContext,
      agentSystemPromptSha256,
    );
    const agentRuntime = buildAgentRuntimeEvidence(dispatched, agentSystemPromptSha256);

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
      artifact_refs: mergeArtifacts(execution.artifacts, workspaceArtifacts),
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
        agent_runtime: agentRuntime,
        ...(mailboxOutcomes.length > 0
          ? { mailbox_outcomes: mailboxOutcomes.map((outcome) => ({ ...outcome })) }
          : {}),
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
    agentSystemPromptSha256: string | undefined,
    workspaceArtifacts: ArtifactRef[],
    memoryMaintenance: BMemoryMaintenanceEvidence | undefined,
    mailboxOutcomes: readonly MailboxToolOutcome[],
  ): Promise<AgentExecutionResult> {
    const created_at = nowTimestamp();
    const mailboxWait = mailboxOutcomes.find(
      (outcome) => outcome.kind === 'request' && outcome.wait_for_reply,
    );
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
      agentSystemPromptSha256,
    );
    const agentRuntime = buildAgentRuntimeEvidence(dispatched, agentSystemPromptSha256);

    return {
      agent_run_id: createId('agent_run'),
      agent_id: runtimeRoleId,
      role_id: input.role_id,
      context_pack_ref: contextEvidence.context_pack_ref,
      driver_run_result_id: createId('driver_result'),
      artifact_refs: [...workspaceArtifacts],
      transcript_ref: transcript,
      session_id: input.session_id ?? this.options.driver.session_id,
      response: mailboxWait
        ? `Waiting for Mailbox reply from ${mailboxWait.to_role_id}.`
        : '',
      tool_events: [],
      diagnostics: {
        driver_id: this.options.driver.driver_id,
        driver_status: mailboxWait ? 'not_invoked' : 'failed',
        dispatch_status: dispatched.status,
        ...(mailboxWait
          ? { mailbox_wait: true }
          : {
              driver_error_code: errorCode,
              driver_error: {
                code: errorCode,
                message: errorMessage,
                retryable: dispatched.status === 'blocked',
              },
            }),
        context_policy: input.context_policy,
        input_artifact_refs: [...input.input_artifact_refs],
        buffer_seq: dispatched.cycle.buffer_seq,
        retrieval: {
          experiences: dispatched.cycle.retrieval.experiences.length,
          skills: dispatched.cycle.retrieval.skills.length,
        },
        agent_runtime: agentRuntime,
        ...(mailboxOutcomes.length > 0
          ? { mailbox_outcomes: mailboxOutcomes.map((outcome) => ({ ...outcome })) }
          : {}),
        ...(memoryMaintenance ? { memory_maintenance: memoryMaintenance } : {}),
        context_pack_persisted: contextEvidence.persisted,
        ...(contextEvidence.uri ? { context_pack_uri: contextEvidence.uri } : {}),
      },
      status: mailboxWait
        ? 'completed'
        : dispatched.status === 'cancelled'
          ? 'cancelled'
          : 'failed',
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
    const ablationPolicy = resolveMemoryAblationPolicy(input.memory_ablation);
    if (!ablationPolicy.schedule_extraction) return undefined;
    try {
      return await this.options.memoryMaintenance.scheduleBuffer({
        task_id: input.task_id,
        run_id: input.run_id,
        role_id: runtimeRoleId,
        buffer_seq: bufferSeq,
        ...(input.memory_ablation ? { memory_ablation: input.memory_ablation } : {}),
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
    agentSystemPromptSha256: string | undefined,
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
      ...(input.participant_id ? { participant_id: input.participant_id } : {}),
      ...(input.council_seat ? { council_seat: input.council_seat } : {}),
      ...(input.council_seat_index !== undefined
        ? { council_seat_index: input.council_seat_index }
        : {}),
      context_policy: input.context_policy,
      input_artifact_refs: input.input_artifact_refs,
      memory_buffer_ref: memoryBufferRef,
      retrieval: dispatched.cycle.retrieval,
      driver_context: dispatched.cycle.driver_context,
      ...(driverInvocationContext ? { driver_invocation_context: driverInvocationContext } : {}),
      agent_runtime: buildAgentRuntimeEvidence(dispatched, agentSystemPromptSha256),
    });
    const contextPackRef = `context_pack_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
    const evidence: AgentContextPackEvidence = {
      context_pack_id: contextPackRef,
      task_id: input.task_id,
      run_id: input.run_id,
      agent_id: runtimeRoleId,
      role_id: input.role_id,
      ...(input.participant_id ? { participant_id: input.participant_id } : {}),
      ...(input.council_seat ? { council_seat: input.council_seat } : {}),
      ...(input.council_seat_index !== undefined
        ? { council_seat_index: input.council_seat_index }
        : {}),
      context_policy: input.context_policy,
      input_artifact_refs: [...input.input_artifact_refs],
      memory_buffer_ref: memoryBufferRef,
      retrieval: {
        experiences: [...dispatched.cycle.retrieval.experiences],
        skills: [...dispatched.cycle.retrieval.skills],
      },
      driver_context: dispatched.cycle.driver_context,
      ...(driverInvocationContext ? { driver_invocation_context: driverInvocationContext } : {}),
      agent_runtime: buildAgentRuntimeEvidence(dispatched, agentSystemPromptSha256),
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

function envelopeExpectsReply(envelope: PersistedMailboxEnvelope): boolean {
  return (
    !envelope.message.reply_to_message_id &&
    expectsMailboxReply(envelope.message.kind ?? legacyMailboxKind(envelope.message.type) ?? 'notice')
  );
}

function isMailboxDeliveryAvailable(envelope: PersistedMailboxEnvelope): boolean {
  return envelope.delivery.status === 'pending' || envelope.delivery.status === 'injected';
}

function legacyMailboxKind(
  type: AgentMessageType | undefined,
): 'request' | 'notice' | undefined {
  if (!type) return undefined;
  return expectsMailboxReply(type) ? 'request' : 'notice';
}

function legacyMailboxContent(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  if (typeof payload.content === 'string' && payload.content.trim()) return payload.content;
  return JSON.stringify(payload);
}

function hashSystemPrompt(
  messages: Array<{ role: string; content: string | null }>,
): string | undefined {
  const prompt = messages
    .filter((message) => message.role === 'system' && message.content)
    .map((message) => message.content)
    .join('\n\n');
  if (!prompt) return undefined;
  return createHash('sha256').update(prompt).digest('hex');
}

function buildAgentRuntimeEvidence(
  dispatched: DispatchTaskResult,
  systemPromptSha256: string | undefined,
): AgentContextPackEvidence['agent_runtime'] {
  const persona = dispatched.cycle.persona;
  return {
    policy_id: AGENT_RUNTIME_POLICY_ID,
    persona_ref: `persona://${encodeURIComponent(persona.role_id)}/v${String(persona.version)}`,
    persona_version: persona.version,
    persona_generated_at: persona.generated_at,
    ...(systemPromptSha256 ? { system_prompt_sha256: systemPromptSha256 } : {}),
  };
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

function withTopLevelExecutionContext(
  input: Parameters<ToolCallingClient['completeWithTools']>[0],
  retrieval: MemoryRetrievalResult,
  collaborationBrief: string,
): Parameters<ToolCallingClient['completeWithTools']>[0] {
  const memoryContext = renderTopLevelMemoryContext(retrieval);
  const context = [memoryContext, collaborationBrief].filter(Boolean).join('\n\n');
  if (!context) return input;

  let injected = false;
  return {
    ...input,
    messages: input.messages.map((message) => {
      if (injected || message.role !== 'user' || message.content === null) return message;
      injected = true;
      return { ...message, content: `${message.content}\n\n${context}` };
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

async function collectWorkspaceArtifacts(
  input: AgentExecutionRequest,
  before: WorkspaceFileSnapshot | undefined,
  execution: DriverRunResult | undefined,
): Promise<ArtifactRef[]> {
  if (!input.workspace_path || !before) return [];
  const after = await snapshotWorkspaceFiles(input.workspace_path);
  const changedFiles = diffWorkspaceFiles(before, after).filter(isDeliverableWorkspacePath);
  const producerId = execution?.diagnostics.driver_id ?? 'agent-execution-facade';
  const artifacts: ArtifactRef[] = [];

  for (const relativePath of changedFiles) {
    const absolutePath = path.resolve(input.workspace_path, relativePath);
    const stat = await fs.stat(absolutePath).catch(() => undefined);
    if (!stat?.isFile() || stat.size > 5 * 1024 * 1024) continue;
    const bytes = await fs.readFile(absolutePath).catch(() => undefined);
    if (!bytes) continue;
    const fileUrl = pathToFileURL(absolutePath).href;
    const createdAt = nowTimestamp();
    artifacts.push({
      artifact_id: createId('artifact'),
      type: 'patch',
      uri: `artifact://workspace-file/${encodeURIComponent(input.task_id)}/${encodeURIComponent(relativePath)}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      producer_id: producerId,
      task_id: input.task_id,
      metadata: {
        source: 'workspace-change',
        workspace_path: input.workspace_path,
        target_path: relativePath,
      },
      content: {
        kind: 'file',
        content_ref: fileUrl,
        target_path: relativePath,
        media_type: mediaTypeFor(relativePath),
      },
      created_at: createdAt,
      schema_version: SCHEMA_VERSION,
    });
  }
  return artifacts;
}

/** Normalize artifact target paths so Windows `\` and POSIX `/` compare equal. */
export function normalizeArtifactTargetPath(value: string): string {
  return value.replace(/\\/g, '/');
}

export function mergeArtifacts(
  driverArtifacts: readonly ArtifactRef[],
  workspaceArtifacts: readonly ArtifactRef[],
): ArtifactRef[] {
  const result: ArtifactRef[] = [];
  const seenTargets = new Set<string>();
  // Workspace snapshots contain the complete post-run file. Prefer them over
  // Driver edit snippets when both artifacts target the same path.
  for (const artifact of [...workspaceArtifacts, ...driverArtifacts]) {
    const target = artifact.content?.target_path;
    const key = target ? normalizeArtifactTargetPath(target) : undefined;
    if (key && seenTargets.has(key)) continue;
    if (key) seenTargets.add(key);
    result.push(artifact);
  }
  return result;
}

function mediaTypeFor(relativePath: string): string {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === '.ts') return 'text/typescript';
  if (extension === '.tsx') return 'text/tsx';
  if (extension === '.js' || extension === '.jsx') return 'text/javascript';
  if (extension === '.json') return 'application/json';
  if (extension === '.css') return 'text/css';
  if (extension === '.html') return 'text/html';
  return 'text/plain';
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
