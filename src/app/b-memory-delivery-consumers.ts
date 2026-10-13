/**
 * B 侧 Memory Maintenance 消费端的生产装配（Phase 1 + Phase 2）
 *
 * 在线路径只生产输入：`scheduleBuffer` 登记一条 Context Delivery、任务收尾时把 Driver 反馈写进
 * 另一条 outbox。把这两条队列真的消费成 Experience 与置信度回写的那两个 worker
 * （`ContextDeliveryWorker` / `DriverFeedbackWorker`）此前**没有被任何生产路径构造过**，
 * 于是「只生产、不消费」。这个文件就是那处缺失的装配：把 worker、它们的内核处理器、run store
 * 与定时器接成一件事，由组合根构造一次、按间隔 drain。
 *
 * 三条通道，各自独立的 run、队列与失败预算：
 *
 *   1. `context_delivery`   消费 context 通道 → 提取 Experience + 归档 Buffer
 *   2. `driver_feedback`    消费 feedback outbox → 把反馈写进经验（经验还没出现就先寄存）
 *   3. `feedback_reconcile` 归并寄存下来的等待项 → 等的那条经验出现了就写进去
 *
 * 顺序是有意的，也是每一轮的执行顺序：上下文先被消费掉，本轮反馈才有可能命中刚刚提取出来的
 * 经验（反馈引用的是「本次任务用过的经验」，而那条经验正是同一次任务产出的 Buffer 提取来的）；
 * 归并放最后，因为它等的是更早的、可能还没出现的经验。反过来排，反馈会在第一轮全部寄存，
 * 要等下一轮归并才生效。
 *
 * 与在线路径的边界（计划 §3）：这里不调 `scheduleBuffer`、不造 Buffer、不晋升 Skill、
 * 不演化 Persona。提取出来的 Experience 只落库，Skill 与 Persona 由各自独立的 job 决定。
 *
 * 失败隔离：一条通道抛错只把它自己记成 failed，另外两条照常跑。三条通道共用一套存储，
 * 存储读不动会让每一条都以同一个原因各自失败——那是三条 failed，不是「一整块没接线」。
 * 同理，`no_work` 与 `failed` 必须分开：前者是「这一轮没活」，后者是「跑了但没跑成」，
 * 混起来会让「维护到底有没有在消费队列」读不出来。
 *
 * run 是观测与审计实体，不是事务边界：一次「9 条成功、1 条进死信」的运行是正常的运行，
 * 不是失败的运行。只有外壳自己读不动存储（worker_error）才算这条通道失败。
 */
import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSION, nowTimestamp } from '../core';
import {
  ContextDeliveryWorker,
  DefaultContextDeliveryProcessor,
  DefaultDriverFeedbackProcessor,
  DriverFeedbackWorker,
  LlmExperienceExtractor,
  createAgentMemoryScope,
  stableExperienceId,
  type BufferRepository,
  type ContextDeliveryProcessContext,
  type ContextDeliveryProcessOutcome,
  type ContextDeliveryProcessor,
  type ContextDeliveryRunResult,
  type DriverFeedbackRunResult,
  type ExperienceExtractor,
  type LlmClient,
  type MaintenanceRunCounts,
  type MaintenanceRunStore,
  type MemoryDeliveryRepository,
  type MemoryRepository,
} from '../memory';
import type { ContextDeliveryItem, ExperienceRecord } from '../memory/schemas';
import type {
  BMemoryMaintenanceEvidence,
  BMemoryMaintenanceEvidenceStore,
} from './b-memory-maintenance-runner';

/**
 * 三条消费通道。**数组顺序就是每一轮的执行顺序**（见文件头）。
 *
 * 名字与 `MaintenanceJobType` 对齐：`context_delivery` / `driver_feedback` / `feedback_reconcile`
 * 就是三个 worker 开出来的 run 的 `job_type`，因此报告里的键可以直接拿去 `MaintenanceRunStore`
 * 里对账。
 */
export const MEMORY_DELIVERY_CHANNELS = [
  'context_delivery',
  'driver_feedback',
  'feedback_reconcile',
] as const;

export type MemoryDeliveryChannel = (typeof MEMORY_DELIVERY_CHANNELS)[number];

/** 一条通道这一轮的结果状态 */
export type MemoryDeliveryChannelStatus =
  /** 跑完了且真的 claim 到了记录（claim 到上限、超时、被中止等正常收尾都算） */
  | 'completed'
  /** 跑完了，但这一轮一条都没 claim 到（队列空 / 退避窗口没到 / 已被别人领走） */
  | 'no_work'
  /** 抛错，或外壳把 run 标成了 failed——两种都不算成功 */
  | 'failed'
  /** 本次没有调度这条通道（`--channel` 限定了别的通道） */
  | 'not_run';

export interface MemoryDeliveryChannelReport {
  status: MemoryDeliveryChannelStatus;
  /** 通道自报的停止原因（no_work / batch_size / max_duration / aborted / worker_error） */
  stop_reason?: string;
  /** 这次运行开的 maintenance run；抛错或未运行时缺席 */
  run_id?: string;
  /** run 的计数（claimed / completed / retried / dead_letter / skipped / failure） */
  counts?: MaintenanceRunCounts;
  /** 启动恢复放回队列的条数 */
  restored_count?: number;
  /** 逐条结果里 warnings 的总条数（不落全文，只给一个「有多少话要说」的量） */
  warning_count?: number;
  /** 规范化后的失败原因；只有 status='failed' 时存在 */
  error?: { message: string };
}

export interface MemoryDeliveryDrainReport {
  ran_at: string;
  /** 三条通道各自的结果，键就是通道名 */
  channels: Record<MemoryDeliveryChannel, MemoryDeliveryChannelReport>;
}

export interface MemoryDeliveryDrainOptions {
  /** 本次要调度哪些通道；缺省三条全跑 */
  channels?: readonly MemoryDeliveryChannel[];
  /** 只消费该 role 的记录；缺省跨 role */
  role_id?: string;
  /** 本次每条通道的 claim 上限；缺省用 worker 配置 */
  batch_size?: number;
  /** 本次每条通道的墙钟上限（毫秒）；缺省用 worker 配置 */
  max_duration_ms?: number;
  /** 优雅停止信号：置位后不再 claim 新记录，在途的那条照常跑完 */
  signal?: AbortSignal;
}

export interface MemoryDeliveryConsumersOptions {
  repository: MemoryRepository;
  bufferRepository: BufferRepository;
  deliveryRepository: MemoryDeliveryRepository;
  /** 三条通道的 run 记录落点（文件实现；生产状态不留在内存 Map 里） */
  runStore: MaintenanceRunStore;
  /**
   * 维护 evidence 的落点。上下文交付项被消费成 Experience 之后，交付时写下的那条
   * `context_delivery / scheduled` evidence 要就地改写成
   * `experience_extraction / completed` —— 否则运维面会永远停在「已登记、没人处理」。
   */
  evidenceStore: BMemoryMaintenanceEvidenceStore;
  /** B 侧文本 LLM：提取器的模型侧依赖；调用失败时提取器自己降级到规则版 */
  llm: LlmClient;
  /** 提取器覆盖（测试缝）；缺省 LlmExperienceExtractor（内含规则版降级） */
  extractor?: ExperienceExtractor;
  /** 每条通道缺省的 claim 上限 */
  batch_size?: number;
  /** 每条通道缺省的墙钟上限（毫秒） */
  max_duration_ms?: number;
  /** 参考时刻（测试注入）；缺省取系统时间 */
  now?: () => string;
  /** 定时器调度函数（默认 setInterval）；便于测试注入假定时器 */
  schedule?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  /** 定时器取消函数（默认 clearInterval） */
  cancel?: (timer: ReturnType<typeof setInterval>) => void;
  logger?: (message: string) => void;
}

export class MemoryDeliveryConsumers {
  readonly contextDeliveryWorker: ContextDeliveryWorker;
  readonly driverFeedbackWorker: DriverFeedbackWorker;
  /** 上下文通道实际用的处理器（带 evidence 回写的外壳），供测试直接驱动 */
  readonly contextDeliveryProcessor: ContextDeliveryProcessor;

  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<unknown> | undefined;
  private running = false;
  private lastReport: MemoryDeliveryDrainReport | undefined;
  private readonly now: () => string;
  private readonly schedule: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly cancel: (timer: ReturnType<typeof setInterval>) => void;
  private readonly logger: (message: string) => void;

  constructor(private readonly options: MemoryDeliveryConsumersOptions) {
    this.now = options.now ?? nowTimestamp;
    this.schedule = options.schedule ?? setInterval;
    this.cancel = options.cancel ?? clearInterval;
    this.logger = options.logger ?? (() => {});

    // 三个内核都接受注入的时钟；只在调用方真的给了的时候透传（`exactOptionalPropertyTypes`
    // 下「显式传 undefined」与「不传」不是一回事）。
    const clock = options.now !== undefined ? { now: options.now } : {};
    // 批量与墙钟上限两个 worker 各有一份缺省；实例级的配置在构造时下发，`runOnce` 里的
    // 同名字段是**本次**的覆盖（见 runChannel）。
    const limits = {
      ...(options.batch_size !== undefined ? { batch_size: options.batch_size } : {}),
      ...(options.max_duration_ms !== undefined
        ? { max_duration_ms: options.max_duration_ms }
        : {}),
    };
    const extractor = options.extractor ?? new LlmExperienceExtractor(options.llm);
    const inner = new DefaultContextDeliveryProcessor({
      deliveryRepository: options.deliveryRepository,
      bufferRepository: options.bufferRepository,
      scopeFactory: (roleId) =>
        createAgentMemoryScope(options.repository, options.bufferRepository, roleId),
      extractor,
      processor_version: 'b-context-consumer-1.0',
      ...clock,
    });
    this.contextDeliveryProcessor = new EvidenceRecordingContextDeliveryProcessor(inner, {
      repository: options.repository,
      evidenceStore: options.evidenceStore,
      now: this.now,
    });
    this.contextDeliveryWorker = new ContextDeliveryWorker({
      deliveryRepository: options.deliveryRepository,
      runStore: options.runStore,
      processor: this.contextDeliveryProcessor,
      worker_id: `b-context-consumer-${randomUUID()}`,
      // 启动恢复归这里：租约过期仍停在 processing 的记录要回到队列，否则它们要等下一次
      // 调度才有人管——而「上一个进程崩过」正是最需要自动恢复的场景。
      restore_expired: true,
      ...limits,
      ...clock,
    });
    this.driverFeedbackWorker = new DriverFeedbackWorker({
      deliveryRepository: options.deliveryRepository,
      runStore: options.runStore,
      processor: new DefaultDriverFeedbackProcessor({
        deliveryRepository: options.deliveryRepository,
        // 反馈的写入面是 repository 而不是 scope：应用必须原子且按 feedback_id 幂等。
        repository: options.repository,
        processor_version: 'b-feedback-consumer-1.0',
        ...clock,
      }),
      worker_id: `b-feedback-consumer-${randomUUID()}`,
      restore_expired: true,
      ...limits,
      ...clock,
    });
  }

  /**
   * 跑一轮：按 `MEMORY_DELIVERY_CHANNELS` 的顺序逐条跑，每条各自隔离。
   *
   * 防重入：定时器到点时上一轮还没跑完，第二次调用直接返回上一轮的报告——重入不是「再跑一遍」
   * 的意思，重复 claim 只会把记录从自己手里抢来抢去。手动补跑（CLI 新进程）不会撞上它。
   */
  async runOnce(options: MemoryDeliveryDrainOptions = {}): Promise<MemoryDeliveryDrainReport> {
    if (this.running) {
      return this.lastReport ?? this.emptyReport();
    }
    this.running = true;
    const execution = this.runOnceInternal(options);
    this.inFlight = execution;
    try {
      const report = await execution;
      this.lastReport = report;
      return report;
    } finally {
      this.running = false;
      if (this.inFlight === execution) this.inFlight = undefined;
    }
  }

  /** 停止后等在途那一轮跑完，避免组合根先关存储、后关这个循环。 */
  async waitForIdle(): Promise<void> {
    await this.inFlight;
  }

  /** 启动周期循环；intervalMs <= 0 时不启动（调用方负责把 0 当成配置错误）。 */
  start(intervalMs: number): void {
    // 判「有没有在跑」用 `=== null` 而不是真假值：句柄是调度器给的不透明值，`0` 是合法的
    // 定时器 id。按真假值判，一次 `start()` 之后 `stop()` 会静默什么都不做——循环停不下来
    // 而调用方以为停住了。
    if (this.timer !== null || intervalMs <= 0) return;
    this.timer = this.schedule(() => {
      void this.runOnce().catch((error: unknown) => {
        this.logger(`Memory delivery drain failed: ${messageOf(error)}`);
      });
    }, intervalMs);
    this.logger(`Memory delivery drain started (interval=${intervalMs}ms)`);
  }

  stop(): void {
    if (this.timer === null) return;
    this.cancel(this.timer);
    this.timer = null;
    this.logger('Memory delivery drain stopped');
  }

  /** 最近一轮的报告（供观测 / 测试断言）。 */
  lastRunReport(): MemoryDeliveryDrainReport | undefined {
    return this.lastReport;
  }

  // ── 内部 ────────────────────────────────────────────────────────

  private async runOnceInternal(
    options: MemoryDeliveryDrainOptions,
  ): Promise<MemoryDeliveryDrainReport> {
    const selected = options.channels;
    const channels = {} as Record<MemoryDeliveryChannel, MemoryDeliveryChannelReport>;
    for (const channel of MEMORY_DELIVERY_CHANNELS) {
      channels[channel] =
        selected && !selected.includes(channel)
          ? { status: 'not_run' }
          : await this.runChannel(channel, options);
    }
    return { ran_at: this.now(), channels };
  }

  private async runChannel(
    channel: MemoryDeliveryChannel,
    options: MemoryDeliveryDrainOptions,
  ): Promise<MemoryDeliveryChannelReport> {
    const runOptions = {
      ...(options.batch_size !== undefined ? { batchSize: options.batch_size } : {}),
      ...(options.max_duration_ms !== undefined ? { maxDurationMs: options.max_duration_ms } : {}),
      ...(options.role_id !== undefined ? { role_id: options.role_id } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };
    try {
      switch (channel) {
        case 'context_delivery':
          return channelReportOf(await this.contextDeliveryWorker.runOnce(runOptions));
        case 'driver_feedback':
          return channelReportOf(await this.driverFeedbackWorker.runOnce(runOptions));
        case 'feedback_reconcile':
          return channelReportOf(await this.driverFeedbackWorker.reconcilePending(runOptions));
      }
    } catch (error) {
      // 通道抛错只影响它自己：另外两条通道的队列、重试预算与退避都不同，没有理由连坐。
      return { status: 'failed', error: { message: messageOf(error) } };
    }
  }

  private emptyReport(): MemoryDeliveryDrainReport {
    const channels = {} as Record<MemoryDeliveryChannel, MemoryDeliveryChannelReport>;
    for (const channel of MEMORY_DELIVERY_CHANNELS) channels[channel] = { status: 'not_run' };
    return { ran_at: this.now(), channels };
  }
}

/**
 * 把一次通道运行的结果收成报告。
 *
 * 两条判据都是踩过的坑，不是随手写的：
 *
 * - **`worker_error` 与抛错一样算 failed**：worker 自己吞掉异常、如实把 run 标成 failed，
 *   然后**正常返回**——照字面记成 completed，一份已经 failed 的 run 会读起来像跑成功了。
 * - **有没有活看 `claimed_count`，不看 `stop_reason`**：`stop_reason` 说的是**这一轮为什么停下来**，
 *   而批量循环的正常收尾就是「claim 不到了」（`no_work`）。于是「领了 1 条、处理完、再领没有」
 *   的运行也会报 `stop_reason: 'no_work'`——把状态照着它映射，一次真的消费过的运行会被读成
 *   「这轮没活」。`stop_reason` 仍然照原样带在报告里（batch_size / max_duration / aborted
 *   照样看得出来），但它不是状态判据。
 */
function channelReportOf(result: ContextDeliveryRunResult | DriverFeedbackRunResult): MemoryDeliveryChannelReport {
  const base = {
    stop_reason: result.stop_reason,
    run_id: result.run.run_id,
    counts: result.counts,
    restored_count: result.restored_count,
    warning_count: result.outcomes.reduce((total, outcome) => total + outcome.warnings.length, 0),
  };
  if (result.worker_failure !== undefined) {
    return {
      ...base,
      status: 'failed',
      error: { message: `${result.worker_failure.code}: ${result.worker_failure.message}` },
    };
  }
  return { ...base, status: result.counts.claimed_count > 0 ? 'completed' : 'no_work' };
}

// ════════════════════════════════════════════════════════
//  交付 evidence 的回写外壳
// ════════════════════════════════════════════════════════

export interface EvidenceRecordingContextDeliveryProcessorOptions {
  repository: MemoryRepository;
  evidenceStore: BMemoryMaintenanceEvidenceStore;
  now?: () => string;
}

/**
 * 在上下文消费内核外面套一层 evidence 回写：一条交付项被消费成 Experience 之后，把交付时写下的
 * 那条 `context_delivery / scheduled` evidence **就地**改写成
 * `experience_extraction / completed`（同一个 maintenance_ref，因此 run_id / task_id 的溯源不丢）。
 *
 * 为什么要在生产侧做这件事：`scheduleBuffer` 为每条 Buffer 登记的是一条「已交付、等下游处理」
 * 的 evidence。生产路径以前没有下游，这条 evidence 停在 scheduled 上是对的；现在下游就在本进程
 * 里，它处理完了却不回写，运维面就会一直显示「已登记、没人处理」——那是在说一件已经不发生的事。
 *
 * 三条约束：
 * - **不动 run**：run 是各 worker 自己的观测实体（job_type / 计数 / 结局），这里只改 B 服务那条
 *   evidence JSON，两者互不代偿。
 * - **best-effort**：evidence 是观测面，不是事务边界。写不进去只追加一条 warning 到这条交付项的
 *   结果里（run 的逐条 outcome 会把它带出来），绝不让交付项本身失败——那会把「经验已落库、
 *   Buffer 已归档、交付已 ack」的一次成功说成失败。
 * - **取回的经验按稳定 id 认**：落库时 id 由 (role_id, buffer_seq, 序号) 决定（见
 *   persistExtractedExperiences），所以「本次这条 Buffer 产出了哪些经验」是能重算出来的事实，
 *   不需要靠 source_task_id 去猜（同一个 role 在一次任务里可能有多条 Buffer，按任务过滤会把
 *   别人的产出算进来）。数量对不上就如实报一条 warning，而不是安静地少列几条。
 * - **靠一个可重建的索引找那条 evidence**：交付项只带 (role_id, buffer_seq)，而 evidence 的
 *   文件名是 maintenance_ref = hash(role_id, buffer_seq, task_id)——从交付项反推不出来。见
 *   `maintenanceRefFor`：按 role 缓存一份 `delivery_id → maintenance_ref` 的映射，未命中时重建，
 *   因此稳态下不是「每消费一条就扫一遍 evidence 目录」。
 */
export class EvidenceRecordingContextDeliveryProcessor implements ContextDeliveryProcessor {
  private readonly now: () => string;
  /**
   * role_id → (delivery_id → maintenance_ref)。
   *
   * 这是一份**派生**缓存：内容全部来自 evidence 存储，丢了随时能重建，因此不需要失效策略。
   * 唯一要处理的是「缓存建好之后新登记进来的交付项」——查不到就重建一次（见 maintenanceRefFor）。
   */
  private readonly evidenceIndex = new Map<string, Map<string, string>>();

  constructor(
    private readonly inner: ContextDeliveryProcessor,
    private readonly options: EvidenceRecordingContextDeliveryProcessorOptions,
  ) {
    this.now = options.now ?? nowTimestamp;
  }

  async process(
    delivery: ContextDeliveryItem,
    context: ContextDeliveryProcessContext,
  ): Promise<ContextDeliveryProcessOutcome> {
    const outcome = await this.inner.process(delivery, context);
    // 只有真的走完「落库 + 归档 + ack」的那条路径才回写。retried / dead_letter / skipped /
    // failed 都还留着下一次的机会，现在改 evidence 等于替还没发生的结果先签字。
    if (outcome.status !== 'completed') return outcome;
    const warnings = await this.record(delivery, outcome);
    return warnings.length > 0 ? { ...outcome, warnings: [...outcome.warnings, ...warnings] } : outcome;
  }

  /**
   * 这条交付项登记时写下的 evidence 是哪一个 maintenance_ref。
   *
   * 先查缓存；没查到就重建一次该 role 的索引再查——重建能捞到「缓存建立之后新登记的交付项」，
   * 而它在稳态下几乎不会发生（缓存建立于本进程第一条被消费的交付项）。对真的没有 evidence 的
   * 交付项，每次都会重建：那是异常路径，宁可慢也要如实报出来，不该被缓存成「没有」。
   */
  private async maintenanceRefFor(
    roleId: string,
    deliveryId: string,
  ): Promise<string | undefined> {
    const cached = this.evidenceIndex.get(roleId)?.get(deliveryId);
    if (cached !== undefined) return cached;
    const index = new Map<string, string>();
    for (const item of await this.options.evidenceStore.list(roleId)) {
      const id = item.context_delivery?.delivery_id;
      if (id !== undefined) index.set(id, item.maintenance_ref);
    }
    this.evidenceIndex.set(roleId, index);
    return index.get(deliveryId);
  }

  /** 回写一条交付项的 evidence；返回给这次处理加上的 warnings（失败也算 warning，不抛错）。 */
  private async record(
    delivery: ContextDeliveryItem,
    outcome: ContextDeliveryProcessOutcome,
  ): Promise<string[]> {
    const failureWarnings: string[] = [];
    let maintenanceRef: string | undefined;
    try {
      maintenanceRef = await this.maintenanceRefFor(delivery.role_id, delivery.delivery_id);
    } catch (error) {
      return [
        `Context delivery evidence for ${delivery.delivery_id} could not be indexed: ${messageOf(error)}`,
      ];
    }
    if (maintenanceRef === undefined) {
      // 交付项还在但没有对应的交付 evidence：要么 evidence 目录被清理过，要么这条交付项不是
      // 本进程登记的。没有 maintenance_ref 就无处可写，如实说出来而不是静默跳过。
      return [
        `No context delivery evidence names delivery ${delivery.delivery_id}; this extraction was not recorded against a maintenance reference.`,
      ];
    }
    let evidence: BMemoryMaintenanceEvidence | undefined;
    try {
      // 索引只给 ref，内容现读：证据可能已经被上一次（崩溃重跑）改写过，拿缓存里的旧内容去拼
      // 会把 warnings 覆盖掉。
      evidence = await this.options.evidenceStore.get(maintenanceRef);
    } catch (error) {
      return [
        `Maintenance evidence ${maintenanceRef} could not be read for delivery ${delivery.delivery_id}: ${messageOf(error)}`,
      ];
    }
    if (!evidence) {
      return [
        `Maintenance evidence ${maintenanceRef} names delivery ${delivery.delivery_id} but could not be read back.`,
      ];
    }

    const expected = outcome.experiences_created + outcome.experiences_already_present;
    const stableIds = new Set(
      Array.from({ length: expected }, (_unused, index) =>
        stableExperienceId(delivery.role_id, delivery.buffer_seq, index),
      ),
    );
    let experiences: ExperienceRecord[];
    try {
      experiences = (await this.options.repository.listExperiences(delivery.role_id)).filter(
        (experience) => stableIds.has(experience.id),
      );
    } catch (error) {
      return [
        `Experiences for Buffer ${delivery.role_id}:${String(delivery.buffer_seq)} could not be read back: ${messageOf(error)}`,
      ];
    }
    if (experiences.length < expected) {
      failureWarnings.push(
        `Extraction reported ${String(expected)} experience(s) for Buffer ${delivery.role_id}:${String(delivery.buffer_seq)} but only ${String(experiences.length)} were readable under this Buffer's stable ids.`,
      );
    }

    try {
      await this.options.evidenceStore.save({
        ...evidence,
        kind: 'experience_extraction',
        status: 'completed',
        experiences,
        skills: [],
        warnings: [...evidence.warnings, ...outcome.warnings, ...failureWarnings],
        completed_at: this.now(),
        schema_version: SCHEMA_VERSION,
      });
    } catch (error) {
      failureWarnings.push(
        `Maintenance evidence ${evidence.maintenance_ref} could not be rewritten as a completed extraction: ${messageOf(error)}`,
      );
    }
    return failureWarnings;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
