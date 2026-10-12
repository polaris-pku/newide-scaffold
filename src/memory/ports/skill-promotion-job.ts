/**
 * SkillPromotionJob 契约 — 独立晋升 job 的输入、输出与运行选项（Phase 3-A）
 *
 * 本文件只定义**契约**：job 收什么、吐什么、运行可以怎么配。实现（跑一次的过程、claim
 * 循环、run 收尾）在 runtime/skill-promotion-job.ts（Phase 3-C）。分开是因为批量外壳与
 * 观测口径要能脱离实现被审阅：调用方与测试依赖的是这里的形状，不是某一份实现。
 *
 * 与 Phase 1/2 两个 worker 保持同一套外壳形状（停止原因、计数、逐条结果、run 记录），
 * 这样运维不必为第三条通道再学一套词汇。差异只有两处，都是这条通道自己的性质：
 *
 * - 候选是**派生**出来的（从 Experience 上筛），不是上游投进来的交付项，所以没有
 *   delivery_id，逐条结果以 `experience_id` 为主键。
 * - 每条候选都带一个**策略判定**（`decision`），它是这条通道的业务结论；
 *   交付侧的结论只有「处理成功 / 失败」。
 */
import type {
  MaintenanceFailure,
  MaintenanceRun,
  MaintenanceRunCounts,
} from '../schemas';
import type { DeliveryFailureClassification } from '../services/delivery-error-classification';
import type { MemoryRepository } from './memory-repository';
import type { MaintenanceRunStore } from './maintenance-run-store';
import type {
  PromotionApprovalMode,
  PromotionDecision,
  PromotionStrategy,
} from './promotion-strategy';

/**
 * 一条候选处理完之后落在哪里。
 *
 * 前三个是**策略判定落地**的结果（业务结论），中间两个是**这一条自己的成败**，
 * 后一个是「连终态都没能写下来」：
 *
 * | 结果 | 含义 | 写了什么 |
 * | --- | --- | --- |
 * | `promoted` | 判定合格且自动批准 | Skill + 经验的 promoted_to + 晋升标记 |
 * | `pending_review` | 判定合格但人工审核模式 | 只写晋升标记（不写 Skill） |
 * | `rejected` | 判定不合格 | 只写晋升标记（带理由） |
 * | `skipped` | **本次不归我**：没 claim 到、期间被别人处理掉了 | 什么都没写 |
 * | `retried` | 处理失败，按退避回到队列 | 只写失败痕迹 |
 * | `dead_letter` | 用满次数或不可恢复 | 只写失败痕迹 + 死信 |
 * | `failed` | 失败本身也没能写进存储（凭据失效、存储写失败） | 什么都没写 |
 *
 * 「失败」与「跳过」的区别在这里是硬边界：**跳过不带 failure**，它是一个正常结果
 * （没活干、被别人抢先），运维不该把它读成故障；`failed` / `retried` / `dead_letter`
 * 才带 `failure`，且各自落进 run 的对应计数。
 */
export type PromotionCandidateStatus =
  | 'promoted'
  | 'pending_review'
  | 'rejected'
  | 'skipped'
  | 'retried'
  | 'dead_letter'
  | 'failed';

/** 一条候选的处理结果：既给 run 计数，也给事后排查 */
export interface PromotionCandidateOutcome {
  status: PromotionCandidateStatus;
  role_id: string;
  experience_id: string;
  /** 处理前这条候选的投递次数（claim 时已经 +1） */
  attempt_count: number;
  /** 处理它的那次 run（同一批共享一个 run_id） */
  run_id?: string;
  /** 策略判定；走到评估那一步才有（claim 没拿到时为缺席） */
  decision?: PromotionDecision;
  /** 判定或晋升产出的 Skill id；`promoted` 时才有 */
  skill_id?: string;
  /** 失败时的规范化分类；跳过与成功时为 undefined */
  failure?: DeliveryFailureClassification;
  /** 不构成失败但需要人看见的事实（例如复用了一条已存在的 Skill） */
  warnings: string[];
}

/** 本次运行声明的审核模式 */
export interface SkillPromotionRunOptions {
  /** 本次最多处理多少条候选；缺省用 job 配置，再缺省用实现自己的默认上限 */
  batchSize?: number;
  /** 本次墙钟上限（毫秒） */
  maxDurationMs?: number;
  /** 优雅停止信号：置位后不再 claim 新候选，在途的那条照常跑完 */
  signal?: AbortSignal;
  /** 本次是否先做启动恢复（回收过期租约）；缺省用 job 配置 */
  restoreExpired?: boolean;
  /** 只处理该 role 的候选；缺省用 job 配置，再缺省跨 role */
  role_id?: string;
  /** 本次运行的参考时刻（同时作为 run 的 started_at）；缺省取当前时间 */
  now?: string;
  /** 本次的审核模式（覆盖 job 配置）。决定判定合格之后是晋升还是只记 pending_review */
  approval?: PromotionApprovalMode;
  /**
   * 本次运行声明的策略版本。
   *
   * 它是一道**断言**而不是开关：与注入的策略实际版本不一致时 job 拒绝启动（抛错）。审计里
   * 记下的版本必须就是真正生效的那一个，而「配置里写的是 v2、注入的却是 v1」正是会让人
   * 事后读错判决结果的那种错。
   */
  strategy_version?: string;
  /**
   * 只演练不落地：照常筛候选、照常问策略，但不 claim、不改任何状态、不写 Skill。
   * 用来回答「按这套配置跑一次会发生什么」。
   */
  dryRun?: boolean;
}

/** 批次为什么停下来（与 Phase 1/2 两个 worker 同义） */
export type SkillPromotionStopReason =
  | 'no_work'
  | 'batch_size'
  | 'max_duration'
  | 'aborted'
  | 'worker_error';

export interface SkillPromotionRunResult {
  /** 本次运行的记录（已收尾） */
  run: MaintenanceRun;
  counts: MaintenanceRunCounts;
  stop_reason: SkillPromotionStopReason;
  /** 启动回收放回队列的条数（没做恢复时为 0） */
  restored_count: number;
  /** 逐条结果：run 计数之外的诊断面（判定、失败码、warnings） */
  outcomes: PromotionCandidateOutcome[];
  /** 本次真正生效的策略版本；写进 run 审计与每条判定 */
  strategy_version: string;
  /** 本次真正生效的审核模式（运行选项覆盖之后的值） */
  approval: PromotionApprovalMode;
  /** 本次是否只演练不落地 */
  dry_run: boolean;
  /** 外壳自身失败（读不动存储等）时的规范化原因；成功运行时为 undefined */
  worker_failure?: MaintenanceFailure;
}

/** 启动恢复的结果：被放回队列的候选 */
export interface PromotionRestoreResult {
  count: number;
  /** 恢复出来的候选所属 role 与经验 id，按处理顺序 */
  restored: Array<{ role_id: string; experience_id: string }>;
}

/**
 * 独立晋升 job。
 *
 * `run` 是唯一入口：每次调用开一条 `skill_promotion` 的 maintenance run，跑完收尾。
 * 它**不**从 Context consumer、Feedback consumer、`scheduleBuffer()` 或在线 Driver 流程里
 * 被调用，也不调用它们中的任何一个——四条通道各自独立，靠调度器分别触发（见计划 §12）。
 */
export interface SkillPromotionJob {
  run(options?: SkillPromotionRunOptions): Promise<SkillPromotionRunResult>;

  /** 启动恢复：把租约过期仍停在 processing 的候选放回队列 */
  restoreExpired(options?: { now?: string; role_id?: string }): Promise<PromotionRestoreResult>;
}

/**
 * job 的构造依赖。刻意只接**端口**（MemoryRepository / PromotionStrategy /
 * MaintenanceRunStore），不接任何具体后端——三个维护组件的组合方式由组合根决定。
 */
export interface SkillPromotionJobOptions {
  /** 经验与技能的读写面（候选、claim、结论落地、Skill 幂等写入都在这里） */
  repository: MemoryRepository;
  /** 逐条判定的策略（版本与阈值都带着它） */
  strategy: PromotionStrategy;
  /** run 的审计存储 */
  runStore: MaintenanceRunStore;
  /**
   * 执行者标识：既写进 run 记录，也作为候选的 claim owner。
   * 缺省按实例生成一个；owner 只作交叉核对，真正的判据是每次 claim 发下的 token。
   */
  worker_id?: string;
  /** claim / 续租的租约时长；缺省用 DEFAULT_DELIVERY_LEASE_MS */
  lease_ms?: number;
  /** 只处理该 role 的候选；缺省跨 role */
  role_id?: string;
  /** 缺省的审核模式；缺省用策略配置里的那一个 */
  approval?: PromotionApprovalMode;
  /** 参考时刻（测试注入）；缺省取系统时间 */
  now?: () => string;
  /** run 的缺省批量上限 */
  batch_size?: number;
  /** run 的缺省墙钟上限 */
  max_duration_ms?: number;
  /** 缺省是否先做启动恢复；缺省 true */
  restore_expired?: boolean;
}
