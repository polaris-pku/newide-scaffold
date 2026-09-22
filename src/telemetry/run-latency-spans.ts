/**
 * Run-latency span 登记处 —— span 名字与 layer 的唯一事实来源。
 *
 * 职责：定义「本仓能产出哪些耗时 span」，以及每个 span 归属哪一层。
 *
 * 为什么需要它：如果让调用点自己同时写 span 名和 layer，两者是同一件事写两遍，
 * 就会漂移——漂移的后果不是报错，而是报告按 layer 分组时这些 span 落到意想不到
 * 的分组里，看归因的人却无从察觉。这里把 layer 收敛成 span 词汇表的属性：
 * - 静态 span：进 `RUN_LATENCY_SPANS` 登记处，调用点传登记名，拼错是编译错误；
 * - 动态族：名字后缀在运行时才知道（stage 游标、agent 工具名、driver 里程碑），
 *   由 `stageSpan` / `agentToolSpan` / `driverMilestoneSpan` 生成，前缀与 layer
 *   仍只在族定义处写一次。
 *
 * 名字是外部契约：`latency.jsonl` 与 `scripts/consumption-report.mjs` 按字面量读，
 * 所以登记处同时就是对外承诺的 span 清单。改名字等于改契约。
 */

/**
 * span 归属层，用于汇总时分组。
 *
 * 定义在本模块而不是 run-latency-trace.ts：layer 是 span 词汇表的属性，登记处拥有
 * 词汇表；recorder 反向从登记处取 layer。这样两者之间只有单向依赖，不会形成运行时
 * 循环引用。
 */
export type RunLatencyLayer = 'stage' | 'loop' | 'facade' | 'agent' | 'driver';

/**
 * 静态 span 登记处：名字 → layer。
 *
 * 不变式（由 test/telemetry/run-latency-spans.test.ts 钉住）：名字的点号前缀必须
 * 等于 layer，唯一例外是根 span `run.loop_total`。
 *
 * `satisfies` 保证每个值都是合法 layer，同时保留字面量类型供 `keyof` 取联合，
 * 因此写错 span 名在编译期就会被挡住。
 */
export const RUN_LATENCY_SPANS = {
  // ---- stage：C 方向 stage 机骨架，由 TaskExecutionLoop 包裹 ----
  'stage.select_agent': 'stage',
  'stage.execute_agent': 'stage',
  'stage.council': 'stage',
  'stage.gate': 'stage',
  'stage.deliver': 'stage',

  // ---- loop：run 级执行循环 ----
  // 根 span。名字里的 `run.` 前缀与 layer `loop` 不一致，是刻意保留的例外：
  // 它是报告用来对齐整个 run 时间轴的锚点，改名会打断既有 latency.jsonl 的可比性。
  'run.loop_total': 'loop',
  'loop.read_run_state': 'loop',
  'loop.start_stage': 'loop',
  'loop.advance_stage': 'loop',
  'loop.inter_stage_gap': 'loop',

  // ---- facade：单次角色执行（DriverRuntimeAgentExecutionFacade）的各阶段 ----
  'facade.run_total': 'facade',
  'facade.queue_wait': 'facade',
  'facade.retrieve_memory': 'facade',
  'facade.dispatch': 'facade',
  'facade.collect_artifacts': 'facade',
  'facade.build_result': 'facade',
  'facade.workspace_snapshot_before': 'facade',
  'facade.workspace_snapshot_after': 'facade',

  // ---- agent：Agent 循环内部（工具调用见 agentToolSpan 动态族）----
  'agent.llm_round': 'agent',

  // ---- driver：ACP driver 调用本体 ----
  // 这三段由 transport 自己观测，首尾相接铺满 driver.invoke，不留空档也不重叠：
  // 进程启动其实也算在 handshake 里，因为 spawn() 是非阻塞的，写 stdin 之前没有
  // 可观测的等待。ACP 侧上报的内部段（见 driverPhaseSpan）嵌在它们之内。
  'driver.invoke': 'driver',
  'driver.handshake': 'driver',
  'driver.turn': 'driver',
  'driver.shutdown': 'driver',
} as const satisfies Record<string, RunLatencyLayer>;

/** 登记名联合。拼错的 span 名在这里被挡住。 */
export type RunLatencySpanName = keyof typeof RUN_LATENCY_SPANS;

/**
 * 一个已确定名字与 layer 的 span 引用。
 *
 * layer 与名字同源，所以调用点拿到的 ref 不可能出现二者矛盾。
 */
export interface RunLatencySpanRef {
  readonly name: string;
  readonly layer: RunLatencyLayer;
}

/** 登记名 → ref。 */
export function latencySpan(name: RunLatencySpanName): RunLatencySpanRef {
  return { name, layer: RUN_LATENCY_SPANS[name] };
}

/**
 * 动态族：stage 游标 span。
 *
 * stage 机的游标取值由状态决定，无法在登记处穷举，但前缀与 layer 同源，只写一次。
 */
export function stageSpan(cursor: string): RunLatencySpanRef {
  return { name: `stage.${cursor}`, layer: 'stage' };
}

/** 动态族：agent 工具调用 span（`agent.tool.query_memory` 等）。 */
export function agentToolSpan(toolName: string): RunLatencySpanRef {
  return { name: `agent.tool.${toolName}`, layer: 'agent' };
}

/** driver transport 会上报的冷启动里程碑。闭集，避免把笔误写进流水。 */
export const DRIVER_TIMING_MILESTONES = [
  'driver.prompt_written',
  'driver.first_output',
  'driver.event_channel',
] as const;

export type DriverTimingMilestoneName = (typeof DRIVER_TIMING_MILESTONES)[number];

/**
 * 动态族：driver 冷启动里程碑。
 *
 * 名字本身就是闭集，所以直接登记在这里；transport 层只上报名字，不拼 layer。
 */
export function driverMilestoneSpan(name: DriverTimingMilestoneName): RunLatencySpanRef {
  return { name, layer: 'driver' };
}

/**
 * 动态族：ACP 侧上报的段耗时（`driver.phase.<phase>`）。
 *
 * 段名来自另一个仓库的契约——`driver.phase` 事件的 `payload.phase`，运行时才知道，
 * 所以只能做成动态族，拿不到编译期校验。它是 transport 自测那几段的更细一层：
 * `driver.handshake` 拆开就是 initialize + authenticate + session。
 *
 * 之所以值得记：判断「冷启动贵在哪」靠的正是这一层——它当初把 npx 的包解析开销
 * 从 ACP 握手里分辨了出来。
 */
export function driverPhaseSpan(phase: string): RunLatencySpanRef {
  return { name: `driver.phase.${phase}`, layer: 'driver' };
}

/** 登记名或现成 ref 统一成 ref；供 recorder 与自由函数共用。 */
export function resolveRunLatencySpan(
  nameOrRef: RunLatencySpanName | RunLatencySpanRef,
): RunLatencySpanRef {
  return typeof nameOrRef === 'string' ? latencySpan(nameOrRef) : nameOrRef;
}
