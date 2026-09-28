/**
 * adp-invocation-state — 单次 ADP exchange 的生命周期与证据模型(A1 / issue #149)。
 *
 * 职责与核心逻辑:
 * - 状态机 `starting → dispatched → returning → settled` 记录一次 driver 调用
 *   走到了哪一步;
 * - 证据模型记录三类事实:prompt 是否已交付 transport(dispatched)、是否观察到
 *   副作用活动(tool 事件 / workspace 写)、是否有明确「未执行」证据(transport
 *   阶段证据);
 * - unknown 判定的唯一依据就是这些证据(issue #149 DoD:只有明确证据才能判断
 *   未执行,无法确认执行或副作用状态时使用 unknown)。
 */
import type { DriverExecutionEvidence } from './driver-transport-error';

export type AdpInvocationPhase = 'starting' | 'dispatched' | 'returning' | 'settled';

export interface AdpInvocationEvidence {
  /** prompt 已交给 transport(执行体已开始调用驱动) */
  dispatched: boolean;
  /** 观察到副作用活动:tool 事件 / 工具调用 / 工作区写 */
  effects_observed: boolean;
  /** 收到过驱动返回的 DriverRunResult */
  result_received: boolean;
  /** 本 exchange 收到过 driver.cancel / abort */
  cancel_requested: boolean;
  /** transport 层给出的阶段证据(spawn 失败 = 明确未执行等) */
  transport_evidence?: DriverExecutionEvidence;
}

export class AdpInvocationState {
  private current: AdpInvocationPhase = 'starting';
  private readonly facts: AdpInvocationEvidence = {
    dispatched: false,
    effects_observed: false,
    result_received: false,
    cancel_requested: false,
  };

  get phase(): AdpInvocationPhase {
    return this.current;
  }

  get evidence(): Readonly<AdpInvocationEvidence> {
    return { ...this.facts };
  }

  markDispatched(): void {
    this.facts.dispatched = true;
    if (this.current === 'starting') this.current = 'dispatched';
  }

  observeEffect(): void {
    this.facts.effects_observed = true;
  }

  markResultReceived(): void {
    this.facts.result_received = true;
    if (this.current !== 'settled') this.current = 'returning';
  }

  markCancelRequested(): void {
    this.facts.cancel_requested = true;
  }

  noteTransportEvidence(evidence: DriverExecutionEvidence): void {
    // not_executed 是「明确证据」,一旦记下就不会被 execution_unconfirmed 覆盖。
    if (this.facts.transport_evidence === 'not_executed') return;
    this.facts.transport_evidence = evidence;
  }

  settle(): void {
    this.current = 'settled';
  }

  /**
   * 是否有明确证据证明驱动从未执行。
   * 两条来源:prompt 从未交付 transport,或 transport 报出 not_executed
   * (spawn 失败 / 进程从未接触 prompt)。其余一律视为「无法确认」。
   */
  hasNotExecutedEvidence(): boolean {
    return !this.facts.dispatched || this.facts.transport_evidence === 'not_executed';
  }
}
