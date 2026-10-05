/**
 * Agent 侧的「此刻在做什么」——进程内、按 `(run_id, role_id)` 索引的在飞状态。
 *
 * ## 为什么需要它
 *
 * `agent.llm_round` 与 `agent.tool.*` 都是 `await` **之后**才落盘的 span
 * （`run-latency-trace.ts:259-266`）：它们能告诉你一次调用花了多久，但**调用进行中**
 * 盘上什么都没有。于是「正在等 LLM」这件事在系统里根本不存在——面板只能在结束后才知道
 * 刚才在等。要显示「思考中 / 委派给 driver」，就必须有一个在调用**之前**写下的状态点。
 *
 * ## 为什么不是 ALS
 *
 * `run-latency-trace` 与 `llm-usage-ledger` 用 AsyncLocalStorage，是因为读它们的人
 * （run 收尾路径）与写它们的人在**同一个异步上下文**里。这里读的人是 RPC 处理器
 * （`run.getSnapshot`），与 agent 循环不在一个上下文，ALS 在那里只会读出 `undefined`
 * ——一个永远读不到的实时状态和没有状态等价。所以用**进程级 Map**。
 * （`llm-usage-ledger` 自己也有一个 `runLedgers` 跨 ALS 存活的 Map，理由相同。）
 *
 * ## 三条纪律
 *
 * 1. **必须显式清除。** 写入点一律走 `withAgentActivity`，它在 `finally` 里清。少了这条，
 *    一次抛错就会让面板永远停在「思考中」——比没有状态更糟，因为它看起来像真的。
 * 2. **状态陈旧要能被看见。** 记录带 `since`，读的人据此判断陈旧：进程卡死时状态会停在
 *    最后一刻，面板该显示「无进展 N 秒」，而不是继续假装它在动。
 * 3. **隐私白名单。** 只记枚举 + 工具名 + 轮次，**不记** prompt / 内容 / 参数 / 指令。
 *    面板要的是「在干什么」，不是「在说什么」。
 *
 * 键是 `(run_id, role_id)` 而不是 `run_id`：council 一次跑会并发多个席位，按 run 索引会
 * 让它们互相覆盖，只剩最后一个角色能被看见。
 */

/** Agent 此刻的状态。只列真正写了状态点的那两个。 */
export type AgentActivityKind = 'awaiting_llm' | 'invoking_driver';

export interface AgentActivity {
  run_id: string;
  role_id: string;
  kind: AgentActivityKind;
  /** 工具名。目前只有 `invoking_driver` 会带。 */
  tool_name?: string;
  /** 进入这个状态的时间（ISO）。陈旧判断交给读的人。 */
  since: string;
  round?: number;
  /**
   * 同一 `(run_id, role_id)` 内单调递增，从 1 开始。
   *
   * 给前端丢弃过期更新用：last-value 字段在推流通道上会乱序，只靠 `since` 判新旧是不够的
   * ——同一毫秒内可以发生两次转移。计数器**不清零**：重新进入状态也要拿到更大的号。
   */
  seq: number;
}

/**
 * `run_id` 可选：没有它就没有可索引的键，此时状态点空转而不是编一个假键。
 *
 * 显式写成 `string | undefined`（而不是只加 `?`）是为了配合 `exactOptionalPropertyTypes`：
 * 调用点本来就可能「有这个字段但值是 undefined」，与其在每处写条件展开，不如在这里说清。
 */
export interface AgentActivityInput {
  run_id?: string | undefined;
  role_id: string;
  kind: AgentActivityKind;
  tool_name?: string;
  round?: number;
}

/** 默认陈旧阈值：超过它就认为「这个状态可能已经不代表实况」。 */
export const DEFAULT_AGENT_ACTIVITY_STALE_MS = 60_000;

/**
 * 用 NUL 作分隔符：`run_id` / `role_id` 里可能出现 `:`、`/` 之类字符，用它们拼键迟早撞。
 */
function activityKey(runId: string, roleId: string): string {
  return `${runId}\u0000${roleId}`;
}

const activities = new Map<string, AgentActivity>();
/**
 * 每个键的转移计数。**刻意与 `activities` 分开**：状态被清除后计数还要留着，否则重新
 * 进入会拿到一个不比上次大的 `seq`，前端就会把它当成过期更新丢掉。
 */
const sequences = new Map<string, number>();

/** 写下一个状态点。没有 `run_id` 时整个调用是空转。 */
export function beginAgentActivity(
  input: AgentActivityInput,
  now: () => string = () => new Date().toISOString(),
): void {
  if (!input.run_id) return;
  const key = activityKey(input.run_id, input.role_id);
  const seq = (sequences.get(key) ?? 0) + 1;
  sequences.set(key, seq);
  activities.set(key, {
    run_id: input.run_id,
    role_id: input.role_id,
    kind: input.kind,
    ...(input.tool_name ? { tool_name: input.tool_name } : {}),
    ...(input.round !== undefined ? { round: input.round } : {}),
    since: now(),
    seq,
  });
}

/** 清除状态点。没有 `run_id` 时同样空转。 */
export function endAgentActivity(input: Pick<AgentActivityInput, 'run_id' | 'role_id'>): void {
  if (!input.run_id) return;
  activities.delete(activityKey(input.run_id, input.role_id));
}

/**
 * 把一段**在飞**的工作包成状态点：进入前写下，`finally` 里清除。
 *
 * 所有写入点都该走这里而不是裸调 `beginAgentActivity`——清除放在一处，调用点就没机会忘。
 * 返回值与异常原样透传。
 */
export async function withAgentActivity<T>(
  input: AgentActivityInput,
  run: () => Promise<T>,
): Promise<T> {
  beginAgentActivity(input);
  try {
    return await run();
  } finally {
    endAgentActivity(input);
  }
}

export function getAgentActivity(
  runId: string,
  roleId: string,
): AgentActivity | undefined {
  return activities.get(activityKey(runId, roleId));
}

/**
 * 读某个 run（或全进程）当前的在飞状态。
 *
 * 返回的是**快照拷贝**：调用方拿到之后状态点可能就被清掉了，直接交引用会让读的人
 * 看见一个「正在消失」的对象。
 */
export function listAgentActivities(runId?: string): AgentActivity[] {
  const all = [...activities.values()];
  return (runId === undefined ? all : all.filter((activity) => activity.run_id === runId)).map(
    (activity) => ({ ...activity }),
  );
}

/**
 * 状态是否可能已经陈旧。
 *
 * **刻意不做自动清理**：进程卡死时状态会停在最后一刻，那正是要被看见的东西。自动清掉
 * 等于把「卡住了」伪装成「空闲」。让读的人把陈旧显式渲染出来。
 */
export function isAgentActivityStale(
  activity: Pick<AgentActivity, 'since'>,
  now: Date = new Date(),
  thresholdMs: number = DEFAULT_AGENT_ACTIVITY_STALE_MS,
): boolean {
  const since = Date.parse(activity.since);
  if (Number.isNaN(since)) return true;
  return now.getTime() - since > thresholdMs;
}

/** 仅供测试：清空进程级状态，避免用例之间互相串。 */
export function resetAgentActivities(): void {
  activities.clear();
  sequences.clear();
}
