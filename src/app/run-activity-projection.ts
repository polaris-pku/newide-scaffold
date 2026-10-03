/**
 * 把内存里的在飞状态折成协议里的 `activity` 块。
 *
 * 纯函数：输入是 `listAgentActivities(runId)` 的结果，输出直接进 `RunSnapshot`。折成单独
 * 一个模块是为了让它可单测——投影逻辑一旦藏在 service 私有方法里，「结束了到底有没有清空」
 * 这类断言就只能靠端到端跑起来才验得到。
 *
 * 两条映射规则：
 *
 * - `awaiting_llm` → `thinking`；`invoking_driver` → `delegating`。telemetry 侧的取名是
 *   「在等什么」，协议侧的取名是「面板该显示什么」，两边语义不同所以不共用类型。
 * - **没有在飞状态就返回 `undefined`**，让调用方整个字段都不挂。不给 `idle`：进程活着但不在
 *   状态点里，与「状态点漏了」从这一份数据上分不出来，报 `idle` 是在替读者下结论。
 */
import type { RunActivity } from '../protocol/run-snapshot';
import {
  DEFAULT_AGENT_ACTIVITY_STALE_MS,
  isAgentActivityStale,
  type AgentActivity,
  type AgentActivityKind,
} from '../telemetry';

export interface ProjectRunActivityOptions {
  now?: Date;
  staleAfterMs?: number;
}

const STATE_BY_KIND: Record<AgentActivityKind, 'thinking' | 'delegating'> = {
  awaiting_llm: 'thinking',
  invoking_driver: 'delegating',
};

export function projectRunActivity(
  activities: readonly AgentActivity[],
  options: ProjectRunActivityOptions = {},
): RunActivity | undefined {
  if (activities.length === 0) return undefined;
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_AGENT_ACTIVITY_STALE_MS;
  const agents = activities
    // 按 role 排序而不是按写入顺序：council 的并发席位写入顺序是调度产物，同一份状态
    // 两次读出来顺序不同会让快照不可比、也会让「内容没变但 diff 变了」。
    .slice()
    .sort((left, right) => left.role_id.localeCompare(right.role_id))
    .map((activity) => ({
      role_id: activity.role_id,
      state: STATE_BY_KIND[activity.kind],
      since: activity.since,
      seq: activity.seq,
      stale: isAgentActivityStale(activity, now, staleAfterMs),
      ...(activity.round !== undefined ? { round: activity.round } : {}),
      ...(activity.tool_name ? { tool_name: activity.tool_name } : {}),
    }));
  return { subject: 'agent', agents };
}
