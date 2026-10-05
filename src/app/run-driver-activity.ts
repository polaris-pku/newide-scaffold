/**
 * driver 侧的「此刻在做什么」——从**存活期事件流**里折出来的在飞状态。
 *
 * ## 为什么折事件,而不是像 agent 侧那样再写一个状态点
 *
 * agent 侧必须在调用**之前**写下状态点（见 `src/telemetry/agent-activity.ts`），因为 LLM
 * 调用进行中盘上什么都没有。driver 侧不一样：driver 的进度**本来就在事件里**
 * （`driver.turn_started` / `driver.tool_*`），而且 P5 已经让状态类事件进协调事件流、
 * 每条都带 `role_id`。所以在有序事件上折一次就够了——没有新的进程级状态，也就没有
 * 「忘了清」的生命周期问题，折叠本身还是一个可单测的纯函数。
 *
 * ## 四条规则
 *
 * 1. **按 `role_id` 归属。** facade 在每个 driver 事件上盖了调用它的席位
 *    （`driver-runtime-agent-execution-facade.ts`，council 会并发多个）。没有 `role_id`
 *    的事件**不猜归属**——宁可不报，也不把它算到某个席位头上。legacy 流（
 *    `integration-v0-flow`）就属于这一类，所以那条路径没有 driver 半边。
 * 2. **状态与活性分开。** `since` 是当前状态的起点，`last_event_at` 是**任意** driver
 *    事件的最近时间（含 chunk、phase、usage）。陈旧只看后者：片段一直在流就说明 driver
 *    活着，哪怕它已经在同一个工具上待了很久。
 * 3. **结尾不算状态。** `driver.turn_completed` / `driver.turn_failed` 让该席位的状态消失
 *    （这一轮 invoke 结束了），它们的结局（`stop_reason` / `reason`）已经在事件流里，
 *    在状态里重复一遍只是同一件事说两遍。
 * 4. **`driver.disconnected` 算状态，但「干净收尾之后的那一次」不算。** 它是「driver 进程
 *    走了」，不是「这一轮出错了」：实测 295 份 `driver-stream.jsonl` 里 38 份含 `disconnect`、
 *    共 74 次，其中 **72 次之前没有任何 `turn_completed`**（全是「起来又掉了、这一轮什么也
 *    没干成」）——那才是要报出去的异常。而 2026-10-04 的第一次真实 run 里，**每次 invoke 都
 *    在 `turn_completed` 之后跟着一条 `disconnect`**（`code: 0`，进程正常退出，47 秒里两次），
 *    于是折叠会把**上一次 invoke 的尾巴**报成新一次委派的状态——面板上就是每换一次 invoke
 *    闪一下「driver 掉线」。判据因此落在**顺序**上：`turn_completed` 之后来的 `disconnect`
 *    只清状态，之前来的（或压根没跑完一轮的）才报 `disconnected`。
 *    退出码帮不上忙：74 次里 **72 次 `code: 0`**，掉线的与正常收尾的长得一模一样。
 *
 * ## 与隐私白名单的关系
 *
 * 工具字段只取身份与标题（`tool_call_id` / `tool_name` / `tool_kind` / `tool_title`），
 * **不取** `raw_input` / `raw_output` / `content` / `locations`——面板要的是「在干什么」，
 * 不是「在写什么」。这也顺带把 §4.2 的 D3 决策（默认只给枚举 + 名字/种类/标题）落在
 * 一处，而不是靠每个消费方自觉。
 */
import type { RunDriverActivity } from '../protocol/run-snapshot';
import { DEFAULT_AGENT_ACTIVITY_STALE_MS, isAgentActivityStale } from '../telemetry';

/** 折叠的输入：只需要类型、载荷与时间，registry 的 `AppRunEvent` 天然满足。 */
export interface DriverTimelineEvent {
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ProjectDriverActivityOptions {
  now?: Date;
  staleAfterMs?: number;
}

type DriverState = RunDriverActivity['state'];

interface DriverToolFields {
  tool_call_id?: string;
  tool_name?: string;
  tool_kind?: string;
  tool_title?: string;
}

interface DriverFold {
  state: DriverState;
  since: string;
  last_event_at: string;
  tool?: DriverToolFields;
}

/**
 * 一个席位的折叠中间态。
 *
 * `turnCompleted` 必须活在 `fold` **之外**：`turn_completed` 的语义是「状态消失」（`fold`
 * 变 `undefined`），但那条事实本身要留到紧随其后的 `disconnect` 才能用上（规则 4）。
 */
interface DriverSeat {
  fold?: DriverFold;
  /** 当前这次 invoke 是否已经**干净地跑完过一轮**。 */
  turnCompleted: boolean;
}

/**
 * 把事件流折成「每个席位当前的 driver 状态」。
 *
 * 返回空 Map 表示**没有任何可报的 driver 在飞状态**（没跑过 driver、或每个席位的最后
 * 一条 driver 事件都是 turn 收尾）。调用方据此让字段整个缺席，而不是报一个空闲。
 */
export function projectDriverActivityByRole(
  events: readonly DriverTimelineEvent[],
  options: ProjectDriverActivityOptions = {},
): Map<string, RunDriverActivity> {
  const seats = new Map<string, DriverSeat>();
  for (const event of events) {
    if (!event.type.startsWith('driver.')) continue;
    const roleId = readString(event.payload?.role_id);
    if (!roleId) continue;
    const at = typeof event.created_at === 'string' ? event.created_at : undefined;
    if (!at) continue;
    seats.set(
      roleId,
      advanceDriverSeat(seats.get(roleId) ?? { turnCompleted: false }, event.type, event.payload, at),
    );
  }

  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_AGENT_ACTIVITY_STALE_MS;
  const byRole = new Map<string, RunDriverActivity>();
  for (const [roleId, seat] of seats) {
    if (!seat.fold) continue;
    byRole.set(roleId, {
      state: seat.fold.state,
      since: seat.fold.since,
      last_event_at: seat.fold.last_event_at,
      // 陈旧复用 agent 侧那一份判据：同一件事（「多久没动静了」）不该有两个阈值口径。
      stale: isAgentActivityStale({ since: seat.fold.last_event_at }, now, staleAfterMs),
      ...(seat.fold.tool ?? {}),
    });
  }
  return byRole;
}

function advanceDriverSeat(
  seat: DriverSeat,
  eventType: string,
  payload: Record<string, unknown>,
  at: string,
): DriverSeat {
  switch (eventType) {
    case 'driver.turn_started':
      // 新的一轮 invoke：上一个工具不可能还在跑，工具字段整组丢掉；「跑完过一轮」也归零。
      return { turnCompleted: false, fold: { state: 'turn_running', since: at, last_event_at: at } };
    case 'driver.tool_started':
    case 'driver.tool_progress': {
      const incoming = readToolFields(payload);
      const carried =
        seat.fold?.state === 'tool_running'
          ? mergeToolFields(seat.fold.tool, incoming)
          : incoming;
      return {
        ...seat,
        fold: { state: 'tool_running', since: at, last_event_at: at, tool: carried },
      };
    }
    case 'driver.tool_completed':
    case 'driver.tool_failed':
      // 工具收尾 → 回到「这一轮 turn 在跑」。压根没有在跑的 turn 时就什么都不报
      // ——不编一个 turn 出来。
      if (!seat.fold) return seat;
      return { ...seat, fold: { state: 'turn_running', since: at, last_event_at: at } };
    case 'driver.turn_completed':
      // 状态消失，但「这一轮跑完了」这条事实要留给紧随其后的 `disconnect`。
      return { turnCompleted: true };
    case 'driver.turn_failed':
      // 失败收尾不算干净：之后来的 `disconnect` 仍然要报（那正是异常的样子）。
      return { turnCompleted: false };
    case 'driver.disconnected':
      // 见规则 4：干净跑完一轮之后的掉线只是这次 invoke 的尾巴。
      return {
        turnCompleted: false,
        ...(seat.turnCompleted
          ? {}
          : { fold: { state: 'disconnected' as const, since: at, last_event_at: at } }),
      };
    default:
      // phase / usage / plan / mode / 各种 chunk / stderr：只更新活性，不改状态。
      // 没有在飞状态时不因此凭空造一个——活性本身不是状态。
      return seat.fold === undefined
        ? seat
        : { ...seat, fold: { ...seat.fold, last_event_at: at } };
  }
}

/**
 * `tool_call_update` 是**部分更新**（投影侧的原话：「缺席的字段自然跳过，由上层把多次
 * 投影叠加起来看全貌」），所以这里要叠加，否则 `tool_progress` 一到就把 `tool_started`
 * 带出来的名字冲掉。
 *
 * 但换了工具就不能叠加：`tool_call_id` 两边都有且不同时，整组以新事件为准。
 */
function mergeToolFields(
  previous: DriverToolFields | undefined,
  incoming: DriverToolFields,
): DriverToolFields {
  if (!previous) return incoming;
  if (
    previous.tool_call_id &&
    incoming.tool_call_id &&
    previous.tool_call_id !== incoming.tool_call_id
  ) {
    return incoming;
  }
  return { ...previous, ...incoming };
}

function readToolFields(payload: Record<string, unknown>): DriverToolFields {
  const tool_call_id = readString(payload.tool_call_id);
  const tool_name = readString(payload.tool_name);
  const tool_kind = readString(payload.kind);
  const tool_title = readString(payload.title);
  return {
    ...(tool_call_id ? { tool_call_id } : {}),
    ...(tool_name ? { tool_name } : {}),
    ...(tool_kind ? { tool_kind } : {}),
    ...(tool_title ? { tool_title } : {}),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
