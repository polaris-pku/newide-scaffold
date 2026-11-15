/**
 * Role 派工的低频生命周期事件词表（阶段 4）。
 *
 * 这是 Journal → 对外投影之间**唯一**的事件名与载荷约定来源：role 引擎按这里发射，
 * `run-dispatch-projection.ts` 按这里折叠，两边共用同一组常量，避免「写一个名字、读另一个
 * 名字」这种只有跑起来才发现的漂移。
 *
 * 为什么是事件而不是新账本：Journal 已经是派工事实源（`RD-JRN-01`），这里发射的只是
 * **低频投影信号**（一次派工最多 accepted/started/settled 三条 + 对账一条），进 run 时间线
 * 后同时满足「运行中可读」「重启后仍可读」「订阅推送」三件事。完整指令、对话、transcript
 * 一律不进事件载荷（体积与隐私边界，见设计稿 §4.2 D3）。
 *
 * 公共 source 仍走 `agent.*` 前缀（`projectRunEventSource` 把它投影成 `agent`），不新增
 * 一套 role source 分类。
 */

/** 事件名常量；`as const` 让类型与运行时值同源。 */
export const ROLE_DISPATCH_EVENT = {
  /** 宿主接受了 brief 并（按写屏障）准备派工：`{dispatch_id, kind, read_only, session_mode, sequence, retry_of?}`。 */
  accepted: 'agent.dispatch_accepted',
  /** driver 调用开始：`{dispatch_id, kind}`。 */
  started: 'agent.dispatch_started',
  /** 派工按事实收束：`{dispatch_id, kind, status, violations[], evidence_ref?}`。 */
  settled: 'agent.dispatch_settled',
  /** 迟到回执/对账结果：只升级 unknown，不覆盖已发终态：`{dispatch_id, status, source}`。 */
  reconciled: 'agent.dispatch_reconciled',
  /** 从父链继承的既有派工（只读投影，不是本 Run 的执行事实）：`{source_run_id, ...}`。 */
  inherited: 'agent.dispatch_inherited',
  /** role 计划更新（只读历史事实；计划不是执行/完成证据）：`{plan, round?}`。 */
  plan_updated: 'agent.plan_updated',
  /** role 的 finish 被接受：`{status, verification_count?, unresolved_count?}`。 */
  finish_requested: 'agent.finish_requested',
  /** 引擎的 typed termination：`{code, actor, message?}`；Task/Run 状态仍由 C 层写。 */
  role_terminated: 'agent.role_terminated',
} as const;

export type RoleDispatchEventType = (typeof ROLE_DISPATCH_EVENT)[keyof typeof ROLE_DISPATCH_EVENT];

/**
 * 引擎交给阶段事件出口的生命周期信号。
 *
 * `subject_id` 通常是 `dispatch_id`（派工类）或 `run_id`（role 级）；出口再补
 * task/run 身份与时间戳。引擎在没注入出口时不发事件（单测/嵌入式使用零副作用）。
 */
export interface RoleLifecycleEvent {
  type: RoleDispatchEventType;
  subject_id: string;
  payload: Record<string, unknown>;
}

/** 是否为阶段 4 引入的 role 生命周期事件（投影与测试共用）。 */
export function isRoleDispatchEventType(value: string): value is RoleDispatchEventType {
  return (Object.values(ROLE_DISPATCH_EVENT) as string[]).includes(value);
}
