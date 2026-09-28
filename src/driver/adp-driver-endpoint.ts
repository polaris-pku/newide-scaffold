/**
 * adp-driver-endpoint — System 内代理 A/D 的 ADP endpoint(A1 / issue #149)。
 *
 * 职责与核心逻辑:
 * - 把宿主内的驱动调用意图包装成协议 exchange:构造 P0 冻结的
 *   `driver.invoke` / `driver.cancel` 命令帧与 `driver.invocation_result` 回执帧
 *   (经 P0 schema 校验,禁止私有变体);
 * - 复用 P1 投递底座(ProtocolDeliveryStore):host.intent 调用行(causation 空)、
 *   outbox/inbox 状态与协议 journal 行在事务内一致落库,回执按 causation 收束
 *   原 outbox;
 * - 判重:同一 exchange_id 重复 invoke 返回既有状态/结果,绝不重复启动副作用;
 *   崩溃后按 P1 状态对账收束(未投递 = 明确未执行 → failed;已投递无回执 =
 *   执行状态不明 → unknown);
 * - 结局经 adp-status-mapping 证据化映射为 succeeded/failed/cancelled/unknown;
 *   unknown 永不自动重跑,failed 的自动重跑只看部署级 auto_retry[side_effect]
 *   (adp-retry-policy),部署配置不进入帧;
 * - 回执经宿主内回调(onReceipt)交还 Agent;迟到结果只对账入档,不改已发回执。
 *
 * 调用意图(§7.5 host.intent)单独留档、causation 为空;invoke 的 causation 指向
 * 外层 SAP execute(无则 null)。driver.cancel 不单独发回执帧:目标 invoke 的
 * 终态回执(cancelled/unknown)即取消的对账结果,其 outbox 停在 sent 不重投(§7.1)。
 */
import {
  adpCancelCommandSchema,
  adpInvokeCommandSchema,
  adpReceiptFrameSchema,
  createId,
  nowTimestamp,
  PROTOCOL_VERSION,
  type AdpFrame,
  type AdpSideEffect,
  type AdpStatus,
} from '../core';
import type { ProtocolDeliveryStore, ProtocolInboxKey } from '../persistence';
import type { DriverRunResult, DriverStreamEventListener, DriverStreamEvent } from './contract';
import type { DriverRuntimeReport } from './driver-runtime-invoker';
import { isDriverTransportError } from './driver-transport-error';
import { AdpInvocationState, type AdpInvocationEvidence } from './adp-invocation-state';
import { mapAdpOutcome, type AdpMappedOutcome } from './adp-status-mapping';
import { createAdpRetryPolicy, type AdpRetryPolicy } from './adp-retry-policy';

export type AdpInvokeFrame = Extract<AdpFrame, { command: 'driver.invoke' }>;
export type AdpCancelFrame = Extract<AdpFrame, { command: 'driver.cancel' }>;
export type AdpReceiptFrame = Extract<AdpFrame, { result: string }>;

export interface AdpDriverExecutionInput {
  call_id: string;
  attempt: number;
  signal: AbortSignal;
  onEvent?: DriverStreamEventListener;
  /** 执行体把 prompt 交给 transport 时调用:证据模型的 dispatched 来源 */
  control: { markDispatched(): void };
  /** abort 竞速后迟到的真实结果:由 endpoint 对账入档 */
  onLateResult?: (execution: DriverRunResult) => void;
}

export interface AdpDriverExecutionResult {
  execution: DriverRunResult;
  report?: DriverRuntimeReport;
}

export type AdpDriverExecutor = (input: AdpDriverExecutionInput) => Promise<AdpDriverExecutionResult>;

export interface AdpInvokeRequest {
  task_id: string;
  run_id: string;
  workspace_path: string;
  /** instruction.text:下发给驱动的任务指令 */
  instruction: string;
  /** 缺省自动生成;显式传入即为重复 exchange(走判重) */
  exchange_id?: string;
  /** 外层 SAP execute 的 exchange_id;无则 null(不指向调用) */
  causation_id?: string | null;
  side_effect?: AdpSideEffect;
  deadline_at?: string;
  execute: AdpDriverExecutor;
  onEvent?: DriverStreamEventListener;
}

export interface AdpSettledOutcome {
  state: 'settled';
  exchange_id: string;
  status: AdpStatus;
  receipt: AdpReceiptFrame;
  attempts: number;
  /** true = 判重返回的既有结果,本次没有启动任何副作用 */
  replayed: boolean;
  evidence: Readonly<AdpInvocationEvidence>;
  /** true = P1 落账不可用(如 task/run 行缺失)已降级为进程内记账 */
  journal_degraded: boolean;
  execution?: DriverRunResult;
  report?: DriverRuntimeReport;
  /** 执行体抛出的原始错误(abort 等),供上层原样重抛 */
  thrown?: unknown;
  mapped: AdpMappedOutcome;
}

export type AdpInvokeOutcome =
  | AdpSettledOutcome
  | { state: 'in_flight'; exchange_id: string; detail: 'running' | 'awaiting_delivery' };

export interface AdpCancelRequest {
  task_id: string;
  run_id: string;
  target_exchange_id: string;
  deadline_at?: string;
}

export type AdpCancelOutcome =
  | { state: 'cancel_delivered'; target_exchange_id: string; cancel_exchange_id: string }
  | { state: 'already_settled'; target_exchange_id: string; outcome: AdpSettledOutcome }
  | { state: 'unknown_target'; target_exchange_id: string; cancel_exchange_id: string };

export interface AdpReceiptDelivery {
  exchange_id: string;
  causation_id: string | null;
  receipt: AdpReceiptFrame;
  outcome: AdpSettledOutcome;
}

export interface AdpDriverEndpointOptions {
  store: ProtocolDeliveryStore;
  /** 应用装配声明的副作用分级;单次 invoke 可覆盖 */
  side_effect: AdpSideEffect;
  retryPolicy?: AdpRetryPolicy;
  /** failed 时按策略自动重执行的最大额外次数,默认 1 */
  maxAutoRetries?: number;
  /** deadline_at 缺省 = now + 该秒数,默认 1800 */
  deadlineSeconds?: number;
  /** inbox/outbox lease 时长(秒),默认 60 */
  leaseSeconds?: number;
  now?: () => string;
  /** 宿主内回调:回执交还 Agent */
  onReceipt?: (delivery: AdpReceiptDelivery) => void;
  owner?: string;
}

interface LiveInvocation {
  exchange_id: string;
  task_id: string;
  run_id: string;
  invoke_frame: AdpInvokeFrame;
  state: AdpInvocationState;
  controller: AbortController;
  /** P1 落账失败后降级为进程内记账;留档绝不打断业务路径 */
  degraded: boolean;
  settled?: AdpSettledOutcome;
}

export class AdpDriverEndpoint {
  private readonly store: ProtocolDeliveryStore;
  private readonly retryPolicy: AdpRetryPolicy;
  private readonly maxAutoRetries: number;
  private readonly deadlineSeconds: number;
  private readonly leaseSeconds: number;
  private readonly now: () => string;
  private readonly owner: string;
  private readonly live = new Map<string, LiveInvocation>();

  constructor(private readonly options: AdpDriverEndpointOptions) {
    this.store = options.store;
    this.retryPolicy = options.retryPolicy ?? createAdpRetryPolicy();
    this.maxAutoRetries = options.maxAutoRetries ?? 1;
    this.deadlineSeconds = options.deadlineSeconds ?? 1800;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.now = options.now ?? nowTimestamp;
    this.owner = options.owner ?? `adp-endpoint:${createId('adp')}`;
  }

  /** 发起(或判重返回)一次 driver.invoke exchange。 */
  async invoke(request: AdpInvokeRequest): Promise<AdpInvokeOutcome> {
    const exchange_id = request.exchange_id ?? createId('ex_adp');
    const existing = this.lookupExisting(exchange_id);
    if (existing) return existing;

    const side_effect = request.side_effect ?? this.options.side_effect;
    const created_at = this.now();
    const deadline_at = request.deadline_at ?? addSeconds(created_at, this.deadlineSeconds);
    const invoke_frame = adpInvokeCommandSchema.parse({
      protocol: 'agent-driver',
      protocol_version: PROTOCOL_VERSION,
      exchange_id,
      causation_id: request.causation_id ?? null,
      task_id: request.task_id,
      run_id: request.run_id,
      producer: { kind: 'agent', role_id: null },
      consumer: { kind: 'driver', role_id: null },
      attempt: 1,
      created_at,
      deadline_at,
      command: 'driver.invoke',
      workspace: { path: request.workspace_path },
      side_effect,
      instruction: { text: request.instruction, ref: null },
    }) as AdpInvokeFrame;

    const live: LiveInvocation = {
      exchange_id,
      task_id: request.task_id,
      run_id: request.run_id,
      invoke_frame,
      state: new AdpInvocationState(),
      controller: new AbortController(),
      degraded: false,
    };
    this.live.set(exchange_id, live);

    // 1) 调用意图单独留档(causation 空)+ 发出:同一发方事务。
    this.bookkeep(live, () => {
      this.store.withProtocolTransaction((tx) => {
        tx.appendCall({
          task_id: request.task_id,
          run_id: request.run_id,
          call_id: `${exchange_id}:intent`,
          role_id: null,
          event: 'host.intent',
          status: 'ok',
          summary: `A 想调用 D:${shortText(request.instruction)}`,
          completed_at: created_at,
        });
        tx.enqueueOutbox({
          id: outboxId(exchange_id),
          destination: this.driverConsumer(),
          frame: invoke_frame,
          status: 'pending',
          next_attempt_at: created_at,
        });
      });
    });

    // 2) 投递:收方入库 = 对方确认收到(发方进 sent)。
    const received_at = this.now();
    let inbox_revision: number | undefined;
    this.bookkeep(live, () => {
      const received = this.store.withProtocolTransaction((tx) =>
        tx.receiveInbox({
          consumer_id: this.driverConsumer(),
          frame: invoke_frame,
          received_at,
        }),
      );
      inbox_revision = received.inbox.revision;
      this.markOutboxSent(exchange_id, received_at);
    });

    // 3) 收方领取 → 执行(策略重试在内)→ 回执原子收束。
    if (!live.degraded && inbox_revision !== undefined) {
      const expected_revision = inbox_revision;
      const claimed = this.bookkeep(live, () =>
        this.store.claimInbox(
          this.driverInboxKey(exchange_id),
          this.owner,
          received_at,
          this.leaseUntil(received_at),
          expected_revision,
        ),
      );
      if (!claimed) {
        return { state: 'in_flight', exchange_id, detail: 'running' };
      }
    }

    const outcome = await this.executeAttempts(live, request, side_effect);
    return this.settleExchange(live, outcome);
  }

  /**
   * 发起 driver.cancel:帧的 causation 必须指向目标 invoke(P0 校验)。
   * 目标 invoke 的终态回执(cancelled/unknown)即取消的对账结果。
   */
  async cancel(request: AdpCancelRequest): Promise<AdpCancelOutcome> {
    const created_at = this.now();
    const cancel_exchange_id = createId('ex_adp_cancel');
    const cancel_frame = adpCancelCommandSchema.parse({
      protocol: 'agent-driver',
      protocol_version: PROTOCOL_VERSION,
      exchange_id: cancel_exchange_id,
      causation_id: request.target_exchange_id,
      task_id: request.task_id,
      run_id: request.run_id,
      producer: { kind: 'agent', role_id: null },
      consumer: { kind: 'driver', role_id: null },
      attempt: 1,
      created_at,
      deadline_at: request.deadline_at ?? addSeconds(created_at, this.deadlineSeconds),
      command: 'driver.cancel',
      target_exchange_id: request.target_exchange_id,
    }) as AdpCancelFrame;

    try {
      this.store.withProtocolTransaction((tx) => {
        tx.appendCall({
          task_id: request.task_id,
          run_id: request.run_id,
          call_id: `${cancel_exchange_id}:intent`,
          role_id: null,
          event: 'host.intent',
          status: 'ok',
          summary: `A 想取消 D 调用 ${request.target_exchange_id}`,
          completed_at: created_at,
        });
        tx.enqueueOutbox({
          id: outboxId(cancel_exchange_id),
          destination: this.driverConsumer(),
          frame: cancel_frame,
          status: 'pending',
          next_attempt_at: created_at,
        });
        tx.receiveInbox({
          consumer_id: this.driverConsumer(),
          frame: cancel_frame,
          received_at: created_at,
        });
      });
      this.markOutboxSent(cancel_exchange_id, created_at);
    } catch {
      // P1 落账不可用时取消照常生效,只是不留档(降级,不打断业务)。
    }

    const live = this.live.get(request.target_exchange_id);
    if (live && !live.settled) {
      live.state.markCancelRequested();
      live.controller.abort(new Error(`driver.cancel ${cancel_exchange_id}`));
      return {
        state: 'cancel_delivered',
        target_exchange_id: request.target_exchange_id,
        cancel_exchange_id,
      };
    }

    const existing = this.lookupExisting(request.target_exchange_id);
    if (existing && existing.state === 'settled') {
      return {
        state: 'already_settled',
        target_exchange_id: request.target_exchange_id,
        outcome: { ...existing, replayed: true },
      };
    }
    if (existing && existing.state === 'in_flight') {
      return {
        state: 'cancel_delivered',
        target_exchange_id: request.target_exchange_id,
        cancel_exchange_id,
      };
    }
    return {
      state: 'unknown_target',
      target_exchange_id: request.target_exchange_id,
      cancel_exchange_id,
    };
  }

  /**
   * 迟到结果对账(§4:unknown 收束后迟到的真实结果只入档)。
   * 不改已发回执、不触发重跑、不产生第二次副作用。
   */
  reconcileLateResult(exchange_id: string, execution: DriverRunResult): void {
    const live = this.live.get(exchange_id);
    if (!live) return;
    try {
      this.store.withProtocolTransaction((tx) =>
        tx.appendCall({
          task_id: live.task_id,
          run_id: live.run_id,
          call_id: `${exchange_id}:late:${createId('late')}`,
          role_id: null,
          event: 'driver.invocation_late_result',
          status: execution.status,
          summary: `迟到结果对账:${execution.status}(已按 ${live.settled?.status ?? '未收束'} 收束,不重发回执)`,
          completed_at: this.now(),
          duration_ms: execution.diagnostics.duration_ms,
        }),
      );
    } catch {
      // 对账留档绝不打断业务路径(best-effort)。
    }
  }

  // ── 内部:执行 + 策略重试 ─────────────────────────────────────

  private async executeAttempts(
    live: LiveInvocation,
    request: AdpInvokeRequest,
    side_effect: AdpSideEffect,
  ): Promise<AttemptOutcome> {
    const max_attempts = 1 + this.maxAutoRetries;
    for (let attempt = 1; ; attempt += 1) {
      let execution: DriverRunResult | undefined;
      let report: DriverRuntimeReport | undefined;
      let thrown: unknown;
      let threw = false;
      try {
        const result = await request.execute({
          call_id: `${live.exchange_id}:attempt:${attempt}`,
          attempt,
          signal: live.controller.signal,
          // 证据观察器始终在场:执行体上报的工具活动就是副作用证据。
          onEvent: this.wrapEvents(live, request.onEvent),
          control: { markDispatched: () => live.state.markDispatched() },
          onLateResult: (late) => this.reconcileLateResult(live.exchange_id, late),
        });
        execution = result.execution;
        report = result.report;
        live.state.markResultReceived();
        if (execution.tool_events.length > 0 || execution.artifacts.length > 0) {
          live.state.observeEffect();
        }
      } catch (error) {
        threw = true;
        thrown = error;
        if (isDriverTransportError(error)) live.state.noteTransportEvidence(error.evidence);
      }

      const mapped = mapAdpOutcome({
        kind: execution ? 'result' : 'thrown',
        evidence: live.state.evidence,
        ...(execution ? { execution } : {}),
        ...(threw ? { error: thrown } : {}),
      });

      const can_retry =
        mapped.status === 'failed' &&
        attempt < max_attempts &&
        this.retryPolicy.shouldAutoRetry('failed', side_effect);
      if (!can_retry) {
        return {
          mapped,
          ...(execution ? { execution } : {}),
          ...(report ? { report } : {}),
          ...(threw ? { thrown } : {}),
          attempts: attempt,
        };
      }
      // 部署策略重试:同一 exchange 重新执行,仅记调用行(调用不进因果图)。
      this.recordAttempt(live, attempt + 1);
    }
  }

  private wrapEvents(live: LiveInvocation, onEvent?: DriverStreamEventListener) {
    return (event: DriverStreamEvent): void => {
      if (isEffectEvidence(event)) live.state.observeEffect();
      onEvent?.(event);
    };
  }

  private recordAttempt(live: LiveInvocation, attempt: number): void {
    try {
      this.store.withProtocolTransaction((tx) =>
        tx.appendCall({
          task_id: live.task_id,
          run_id: live.run_id,
          call_id: `${live.exchange_id}:attempt:${attempt}`,
          role_id: null,
          event: 'driver.invoke_attempt',
          status: 'retry',
          summary: `auto_retry[side_effect]=true → 重新执行 attempt ${attempt}`,
          completed_at: this.now(),
        }),
      );
    } catch {
      // 留档失败不阻断重试路径。
    }
  }

  // ── 内部:收束(回执原子落账 + 宿主内回调) ────────────────────

  private settleExchange(live: LiveInvocation, outcome: AttemptOutcome): AdpSettledOutcome {
    const completed_at = this.now();
    const receipt = adpReceiptFrameSchema.parse({
      protocol: 'agent-driver',
      protocol_version: PROTOCOL_VERSION,
      exchange_id: createId('ex_adp_result'),
      causation_id: live.exchange_id,
      task_id: live.task_id,
      run_id: live.run_id,
      producer: { kind: 'driver', role_id: null },
      consumer: { kind: 'agent', role_id: null },
      attempt: 1,
      created_at: completed_at,
      deadline_at: live.invoke_frame.deadline_at,
      result: 'driver.invocation_result',
      status: outcome.mapped.status,
      summary: outcome.mapped.summary,
      error: outcome.mapped.error,
    }) as AdpReceiptFrame;

    // 回执 outbox + 收方 complete:同一事务(P1:业务结果与 reply 原子提交)。
    this.bookkeep(live, () => {
      const driver_key = this.driverInboxKey(live.exchange_id);
      const driver_lease = this.ensureInboxLease(driver_key, completed_at);
      this.store.withProtocolTransaction((tx) =>
        tx.completeInbox({
          key: driver_key,
          lease_owner: this.owner,
          expected_revision: driver_lease,
          completed_at,
          reply: {
            id: outboxId(receipt.exchange_id),
            destination: this.agentConsumer(),
            frame: receipt,
          },
        }),
      );
    });

    // 回执投递 A 侧:receiveInbox 会按 causation 收束原 invoke outbox。
    this.bookkeep(live, () => {
      const delivered_at = this.now();
      const agent_received = this.store.withProtocolTransaction((tx) =>
        tx.receiveInbox({
          consumer_id: this.agentConsumer(),
          frame: receipt,
          received_at: delivered_at,
        }),
      );
      const agent_key: ProtocolInboxKey = {
        consumer_id: this.agentConsumer(),
        protocol: 'agent-driver',
        exchange_id: receipt.exchange_id,
      };
      const agent_claimed = this.store.claimInbox(
        agent_key,
        this.owner,
        delivered_at,
        this.leaseUntil(delivered_at),
        agent_received.inbox.revision,
      );
      if (agent_claimed) {
        this.store.withProtocolTransaction((tx) =>
          tx.completeInbox({
            key: agent_key,
            lease_owner: this.owner,
            expected_revision: agent_claimed.revision,
            completed_at: delivered_at,
          }),
        );
      }
    });

    const settled: AdpSettledOutcome = {
      state: 'settled',
      exchange_id: live.exchange_id,
      status: outcome.mapped.status,
      receipt,
      attempts: outcome.attempts,
      replayed: false,
      evidence: live.state.evidence,
      journal_degraded: live.degraded,
      ...(outcome.execution ? { execution: outcome.execution } : {}),
      ...(outcome.report ? { report: outcome.report } : {}),
      ...(outcome.thrown !== undefined ? { thrown: outcome.thrown } : {}),
      mapped: outcome.mapped,
    };
    live.state.settle();
    live.settled = settled;

    // 回执经宿主内回调交还 Agent(该步不是 SAP 消息,§4.4)。
    this.options.onReceipt?.({
      exchange_id: live.exchange_id,
      causation_id: live.invoke_frame.causation_id,
      receipt,
      outcome: settled,
    });
    return settled;
  }

  // ── 内部:判重与崩溃后对账 ───────────────────────────────────

  private lookupExisting(exchange_id: string): AdpInvokeOutcome | undefined {
    const live = this.live.get(exchange_id);
    if (live) {
      if (live.settled) return { ...live.settled, replayed: true };
      return { state: 'in_flight', exchange_id, detail: 'running' };
    }
    const driver_inbox = this.store.getInbox(this.driverInboxKey(exchange_id));
    const outbox = this.store.getOutbox(outboxId(exchange_id));
    if (!driver_inbox && !outbox) return undefined;

    if (driver_inbox?.status === 'complete' && driver_inbox.reply_exchange_id) {
      const agent_inbox = this.store.getInbox({
        consumer_id: this.agentConsumer(),
        protocol: 'agent-driver',
        exchange_id: driver_inbox.reply_exchange_id,
      });
      if (agent_inbox) {
        return this.replayFromReceipt(exchange_id, agent_inbox.frame as AdpReceiptFrame);
      }
    }
    if (driver_inbox && driver_inbox.status !== 'complete') {
      // 上一进程已死且无回执:执行或副作用状态无法确认 → 对账收束 unknown。
      return this.settleRecovered(exchange_id, driver_inbox.frame as AdpInvokeFrame);
    }
    // outbox 在但从未投递:明确证据未执行 → 对账收束 failed(启动失败)。
    if (outbox) {
      return this.settleRecovered(exchange_id, outbox.frame as AdpInvokeFrame);
    }
    return undefined;
  }

  private replayFromReceipt(exchange_id: string, receipt: AdpReceiptFrame): AdpSettledOutcome {
    return {
      state: 'settled',
      exchange_id,
      status: receipt.status,
      receipt,
      attempts: 1,
      replayed: true,
      evidence: {
        dispatched: true,
        effects_observed: receipt.status !== 'succeeded' && receipt.status !== 'cancelled',
        result_received: true,
        cancel_requested: false,
      },
      journal_degraded: false,
      mapped: {
        status: receipt.status,
        error: receipt.error,
        summary: receipt.summary,
        notes: ['replayed from settled exchange (idempotent)'],
      },
    };
  }

  /** 崩溃恢复:按 P1 状态把死掉的 exchange 对账收束(不启动任何副作用)。 */
  private settleRecovered(exchange_id: string, invoke_frame: AdpInvokeFrame): AdpSettledOutcome {
    const live: LiveInvocation = {
      exchange_id,
      task_id: invoke_frame.task_id,
      run_id: invoke_frame.run_id,
      invoke_frame,
      state: new AdpInvocationState(),
      controller: new AbortController(),
      degraded: false,
    };
    const dispatched = this.store.getInbox(this.driverInboxKey(exchange_id)) !== undefined;
    if (dispatched) live.state.markDispatched();
    else live.state.noteTransportEvidence('not_executed');

    const mapped = mapAdpOutcome({
      kind: 'thrown',
      evidence: live.state.evidence,
      error: new Error(
        dispatched
          ? 'exchange recovered after restart with no result; outcome unconfirmed'
          : 'exchange was never delivered to the driver; never executed',
      ),
    });
    // 恢复路径:确保收方 inbox 存在且可领取,再走统一收束。
    if (!dispatched) {
      this.bookkeep(live, () => {
        const at = this.now();
        const received = this.store.withProtocolTransaction((tx) =>
          tx.receiveInbox({
            consumer_id: this.driverConsumer(),
            frame: invoke_frame,
            received_at: at,
          }),
        );
        this.store.claimInbox(
          this.driverInboxKey(exchange_id),
          this.owner,
          at,
          this.leaseUntil(at),
          received.inbox.revision,
        );
      });
    }
    return this.settleExchange(live, { mapped, attempts: 1 });
  }

  // ── 内部:lease 与小工具 ─────────────────────────────────────

  /**
   * P1 落账守卫:落账失败(如 task/run 行缺失)绝不打断业务路径,降级为
   * 进程内记账(与 ProtocolCallJournal 的留档哲学一致)。
   */
  private bookkeep<T>(live: LiveInvocation, operation: () => T): T | undefined {
    if (live.degraded) return undefined;
    try {
      return operation();
    } catch (error) {
      live.degraded = true;
      if (process.env.NEWIDE_ADP_DEBUG_DEGRADED) {
        console.error(
          `[adp] journal degraded on ${live.exchange_id}:`,
          error instanceof Error ? error.message : String(error),
          `| task=${live.task_id} run=${live.run_id}`,
        );
      }
      return undefined;
    }
  }

  /**
   * 取得完成 inbox 所需的有效 lease:未过期则续期,已过期(超时长执行)则按
   * P1 的 lease 过期恢复入口重新领取。
   */
  private ensureInboxLease(key: ProtocolInboxKey, at: string): number {
    const record = this.store.getInbox(key);
    if (!record) throw new Error(`Inbox ${key.exchange_id} was not found`);
    const until = this.leaseUntil(at);
    if (record.lease_expires_at && record.lease_expires_at > at) {
      return this.store.renewInboxLease(key, this.owner, record.revision, at, until).revision;
    }
    const reclaimed = this.store.claimInbox(key, this.owner, at, until, record.revision);
    if (!reclaimed) throw new Error(`Inbox ${key.exchange_id} lease could not be reacquired`);
    return reclaimed.revision;
  }

  private markOutboxSent(exchange_id: string, at: string): void {
    const claimed = this.store.claimOutbox(
      outboxId(exchange_id),
      this.owner,
      at,
      this.leaseUntil(at),
      1,
    );
    if (claimed) this.store.markOutboxSent(outboxId(exchange_id), this.owner, claimed.revision, at);
  }

  private leaseUntil(at: string): string {
    return addSeconds(at, this.leaseSeconds);
  }

  private driverConsumer(): string {
    return 'adp:driver-side';
  }

  private agentConsumer(): string {
    return 'adp:agent-side';
  }

  private driverInboxKey(exchange_id: string): ProtocolInboxKey {
    return { consumer_id: this.driverConsumer(), protocol: 'agent-driver', exchange_id };
  }
}

interface AttemptOutcome {
  mapped: AdpMappedOutcome;
  execution?: DriverRunResult;
  report?: DriverRuntimeReport;
  thrown?: unknown;
  attempts: number;
}

function outboxId(exchange_id: string): string {
  return `adp-out:${exchange_id}`;
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function shortText(text: string, limit = 120): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > limit ? `${line.slice(0, limit - 3)}...` : line;
}

/** 流事件里的工具活动 = 副作用证据(写工作区/外部调用留下的痕迹)。 */
function isEffectEvidence(event: DriverStreamEvent): boolean {
  if (event.event_type.includes('tool')) return true;
  const payload = event.payload;
  return !!payload && typeof payload === 'object' && 'tool_name' in payload;
}
