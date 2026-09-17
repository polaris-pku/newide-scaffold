/**
 * LLM 用量归属域 —— 「这一次 LLM 调用是替哪个环节花的」的唯一携带方式。
 *
 * 职责：把归属维度（stage / role / agent / tool / round）随异步上下文一起传下去，
 * 让 `recordProxyLlmUsage` 不必改签名、调用点也不必逐层传参，就能把 token 记到
 * 正确的环节名下。
 *
 * 为什么另起一条 ALS，而不是把归属塞进 `llm-usage-ledger` 的 ledger 里：
 * 两者的作用域形状不同。ledger 是 run 级的（一次 run 一个），归属是嵌套的
 * （run 里有 stage，stage 里有 role，role 里还有 tool / round）。混在一条 ALS 上，
 * 收窄归属就得改写 run 级身份，而 run 级身份要跨 stage 复用。
 *
 * 嵌套语义是**叠加**而不是覆盖：内层没给的维度沿用外层的值。若改成覆盖，
 * `runWithLlmUsageAttribution({ stage_cursor })` 里再包一层
 * `runWithLlmUsageAttribution({ role_id })`，stage 会被内层抹掉——token 从
 * stage 汇总里整批漏掉，而漏的时候不报错，只是数字变小。
 *
 * 未绑定归属域时 `getLlmUsageAttribution()` 返回 `undefined`，不是空对象：
 * 「没绑过」与「绑了但一个维度都没给」是两回事，后者会让调用方以为归属已经标好。
 * 单测、example、非 RPC 路径照常记账，只是 entry 上不带归属字段。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** 一次 LLM 调用的归属维度，全部可选：能确定多少就标注多少。 */
export interface LlmUsageAttribution {
  /** 主循环阶段游标，取值与 `stage.<cursor>` span 对齐。 */
  stage_cursor?: string;
  role_id?: string;
  agent_id?: string;
  /** 工具名：agent 循环里由某次工具调用触发的 LLM 调用才有。 */
  tool_name?: string;
  /** LLM 轮次序号。 */
  round?: number;
}

const storage = new AsyncLocalStorage<LlmUsageAttribution>();

/**
 * 在当前异步上下文内收窄归属域。
 *
 * 与外层已有的归属叠加：只覆盖本次显式给出的维度，未给出的沿用外层。返回值与异常
 * 原样透传；没有绑定记录器时的行为与调用点自己写一遍赋值完全相同。
 */
export function runWithLlmUsageAttribution<T>(
  attribution: LlmUsageAttribution,
  run: () => T,
): T {
  return storage.run(mergeAttribution(storage.getStore(), attribution), run);
}

/** 当前归属域；未绑定时返回 `undefined`。 */
export function getLlmUsageAttribution(): LlmUsageAttribution | undefined {
  return storage.getStore();
}

/** 逐字段判 `undefined` 而不是整体覆盖：`{ role_id }` 不该顺手清掉外层的 stage。 */
function mergeAttribution(
  outer: LlmUsageAttribution | undefined,
  inner: LlmUsageAttribution,
): LlmUsageAttribution {
  const merged: LlmUsageAttribution = { ...outer };
  if (inner.stage_cursor !== undefined) merged.stage_cursor = inner.stage_cursor;
  if (inner.role_id !== undefined) merged.role_id = inner.role_id;
  if (inner.agent_id !== undefined) merged.agent_id = inner.agent_id;
  if (inner.tool_name !== undefined) merged.tool_name = inner.tool_name;
  if (inner.round !== undefined) merged.round = inner.round;
  return merged;
}
