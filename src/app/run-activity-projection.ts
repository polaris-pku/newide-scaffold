/**
 * 把内存里的在飞状态折成协议里的 `activity` 块。
 *
 * 纯函数：输入是 `listAgentActivities(runId)` 的结果（agent 半边）与存活期事件流
 * （driver 半边），输出直接进 `RunSnapshot`。折成单独一个模块是为了让它可单测——投影逻辑
 * 一旦藏在 service 私有方法里，「结束了到底有没有清空」这类断言就只能靠端到端跑起来才验得到。
 *
 * 两条映射规则：
 *
 * - `awaiting_llm` → `thinking`；`invoking_driver` → `delegating`。telemetry 侧的取名是
 *   「在等什么」，协议侧的取名是「面板该显示什么」，两边语义不同所以不共用类型。
 * - **没有在飞状态就返回 `undefined`**，让调用方整个字段都不挂。不给 `idle`：进程活着但不在
 *   状态点里，与「状态点漏了」从这一份数据上分不出来，报 `idle` 是在替读者下结论。
 *
 * driver 半边折在每个席位**内部**（`agents[].driver`）：driver 事件被 facade 盖上调用它的
 * `role_id`，所以「哪个席位的 driver」是事实而不是推断。折法见 `run-driver-activity.ts`。
 */
import type { RunActivity, RunActivityEntry } from '../protocol/run-snapshot';
import {
  DEFAULT_AGENT_ACTIVITY_STALE_MS,
  isAgentActivityStale,
  type AgentActivity,
  type AgentActivityKind,
} from '../telemetry';
import {
  projectDriverActivityByRole,
  type DriverTimelineEvent,
  type ProjectDriverActivityOptions,
} from './run-driver-activity';

export interface ProjectRunActivityOptions {
  now?: Date;
  staleAfterMs?: number;
  /** 存活期事件流（registry）。没有它就只折得出 agent 半边。 */
  driver_events?: readonly DriverTimelineEvent[];
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
  const driverOptions: ProjectDriverActivityOptions = { now, staleAfterMs };
  const driverByRole = projectDriverActivityByRole(
    options.driver_events ?? [],
    driverOptions,
  );
  const agents: RunActivityEntry[] = activities
    // 按 role 排序而不是按写入顺序：council 的并发席位写入顺序是调度产物，同一份状态
    // 两次读出来顺序不同会让快照不可比、也会让「内容没变但 diff 变了」。
    .slice()
    .sort((left, right) => left.role_id.localeCompare(right.role_id))
    .map((activity) => {
      const state = STATE_BY_KIND[activity.kind];
      // **父子一致性**（§4.2 点名的「最容易出的 bug」）：driver 半边只在 agent 正在
      // 委派时有意义。让它随 agent 状态一起消失，而不是靠「记得清空」——否则一次
      // straggler 就会让面板在「思考中」旁边挂着一个早已结束的工具名。
      const driver = state === 'delegating' ? driverByRole.get(activity.role_id) : undefined;
      return {
        role_id: activity.role_id,
        state,
        since: activity.since,
        seq: activity.seq,
        stale: isAgentActivityStale(activity, now, staleAfterMs),
        ...(activity.round !== undefined ? { round: activity.round } : {}),
        ...(activity.tool_name ? { tool_name: activity.tool_name } : {}),
        // 没有在跑的 driver 调用就整个缺席，不报一个「空闲」。
        ...(driver ? { driver } : {}),
      };
    });
  return { subject: 'agent', agents };
}
