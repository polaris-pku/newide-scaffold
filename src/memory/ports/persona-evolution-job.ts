/**
 * PersonaEvolutionJob 契约 — 独立演化 job 的输入、输出与运行选项（Phase 4-A）
 *
 * 与 `SkillPromotionJob`（Phase 3-A）刻意同构：停止原因、计数、逐条结果、run 记录四个口径
 * 完全一致，运维不必为第三条通道再学一套词汇。差异只有这条通道自己的性质：
 *
 * - **候选是「角色」而不是「行」**：晋升的候选是一条经验（每行各自持有状态），演化的候选
 *   是一个 Agent（一条演化流）。因此逐条结果以 `role_id` 为主键，claim/lease 也按 role 持有，
 *   而「这条候选是什么」由输入快照 hash 决定（见 services/persona-evolution-candidates.ts）。
 * - **产物是一个版本**，不是一条新记录：`evolved` 意味着库里的 Persona 版本号 +1，且它的
 *   来源（父版本、输入快照、策略版本、source run）全部记在演化标记上。
 * - **有 dry-run**：照常筛候选、照常算快照与判定，但不 claim、不改任何状态、不写 Persona。
 *   它的结论只作为投影留在 `outcomes` 里，run 的六个计数**一律为 0**——一次什么都没写的
 *   运行不该在吞吐指标里留下数字。
 *
 * 三条与晋升相同、理由也相同的硬约束：
 *
 * - **claim 数量与墙钟都有上限**，单条失败不阻塞同批，优雅停止不再 claim 新的。
 * - **没有活就立刻返回**，不轮询、不 sleep。
 * - **启动恢复先跑**：先把租约过期仍停在 processing 的候选放回队列，再去消费。
 *
 * 这条通道**不**从在线 Driver、Context consumer、Feedback consumer、`scheduleBuffer()` 或
 * Skill Promotion 的任何路径被调用，也不调用它们中的任何一个。四条通道各自独立，靠外部
 * 调度器分别触发（计划 §12）。
 */
import type { MaintenanceFailure, MaintenanceRun, MaintenanceRunCounts } from '../schemas';
import type { PersonaEvolutionFailureClassification } from '../services/persona-evolution-decision';
import type { PersonaEvolutionSkipReason } from '../services/persona-evolution-candidates';
import type { MemoryRepository } from './memory-repository';
import type { MaintenanceRunStore } from './maintenance-run-store';
import type {
  PersonaEvolutionApprovalMode,
  PersonaEvolutionDecision,
  PersonaEvolutionStrategy,
} from './persona-evolution-strategy';

/**
 * 一条候选处理完之后落在哪里。
 *
 * 前三个是**判定落地**的结果（业务结论），中间两个是**这一条自己的成败**，后一个是
 * 「连终态都没能写下来」：
 *
 * | 结果 | 含义 | 写了什么 |
 * | --- | --- | --- |
 * | `evolved` | 判定合格且自动批准 | 新 Persona 版本 + 演化标记（父版本 / 快照 / run） |
 * | `pending_review` | 判定合格但人工审核模式 | 只写演化标记（**不写 Persona**） |
 * | `rejected` | 判定不合格 | 只写演化标记（带理由与挡板规则） |
 * | `skipped` | **本次不归我**：没 claim 到、快照与上次相同、期间被别人处理掉了 | 什么都没写 |
 * | `retried` | 处理失败，按退避回到队列 | 只写失败痕迹 |
 * | `dead_letter` | 用满次数或不可恢复 | 只写失败痕迹 + 死信 |
 * | `failed` | 失败本身也没能写进存储（凭据失效、存储写失败） | 什么都没写 |
 *
 * 「跳过」与「失败」的区别在这里同样是硬边界：**跳过不带 failure**，它是一个正常结果
 * （没活干、输入没变化、被别人抢先），运维不该把它读成故障。
 */
export type PersonaEvolutionCandidateStatus =
  | 'evolved'
  | 'pending_review'
  | 'rejected'
  | 'skipped'
  | 'retried'
  | 'dead_letter'
  | 'failed';

/** 一条候选的处理结果：既给 run 计数，也给事后排查 */
export interface PersonaEvolutionCandidateOutcome {
  status: PersonaEvolutionCandidateStatus;
  role_id: string;
  /** 处理前这条候选的投递次数（claim 时已经 +1） */
  attempt_count: number;
  /** 处理它的那次 run（同一批共享一个 run_id） */
  run_id?: string;
  /** 策略判定；走到评估那一步才有（claim 没拿到时为缺席） */
  decision?: PersonaEvolutionDecision;
  /** 判定所依据的输入快照 hash；走到算快照那一步就有 */
  input_snapshot_hash?: string;
  /** 判定所依据的父版本 */
  parent_version?: number;
  /** 演化写下的 Persona 版本；`evolved` 时才有 */
  persona_version?: number;
  /**
   * `skipped` 的原因（Phase 4-C 新增）：机器可读的那一列，用来聚合「这些角色都卡在哪」。
   *
   * 只有演练路径会产出它——真跑是先 claim 再处理，claim 不到即「这次没活」，不落结果行
   * （见 runtime/persona-evolution-job.ts 的文件头）。演练不 claim，因此「这条角色本来会不
   * 会被 claim」只能由计划本身回答，而这个字段就是那个答案。
   */
  skip_reason?: PersonaEvolutionSkipReason;
  /**
   * 失败时的规范化分类；跳过与成功时为 undefined。
   *
   * 它同时带着「落在六种情形里的哪一种」（`kind`）——run 的审计按情形计数（父版本冲突几次），
   * 而从 `code` 上分不出来：冲突与存储抖动共享同一个 `storage_error`。
   */
  failure?: PersonaEvolutionFailureClassification;
  /** 不构成失败但需要人看见的事实（复用了一次已有快照等） */
  warnings: string[];
}

/** 本次运行的可变选项 */
export interface PersonaEvolutionRunOptions {
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
  /** 本次的审核模式（覆盖 job 配置）。决定判定合格之后是写出新版本还是只记 pending_review */
  approval?: PersonaEvolutionApprovalMode;
  /**
   * 本次运行声明的策略版本。
   *
   * 它是一道**断言**而不是开关：与注入的策略实际版本不一致时 job 拒绝启动（抛错），且在
   * 开 run **之前**拒绝——审计里记下的版本必须就是真正判定用的那一个。
   */
  strategy_version?: string;
  /**
   * 只演练不落地：照常筛候选、照常算快照与判定，但不 claim、不改任何状态、不写 Persona。
   * 用来回答「按这套配置跑一次会发生什么」。
   */
  dryRun?: boolean;
}

/** 批次为什么停下来（与 Phase 1/2/3 三条通道同义） */
export type PersonaEvolutionStopReason =
  | 'no_work'
  | 'batch_size'
  | 'max_duration'
  | 'aborted'
  | 'worker_error';

export interface PersonaEvolutionRunResult {
  /** 本次运行的记录（已收尾） */
  run: MaintenanceRun;
  counts: MaintenanceRunCounts;
  stop_reason: PersonaEvolutionStopReason;
  /** 启动回收放回队列的条数（没做恢复时为 0） */
  restored_count: number;
  /** 逐条结果：run 计数之外的诊断面（判定、快照 hash、失败码、warnings） */
  outcomes: PersonaEvolutionCandidateOutcome[];
  /** 本次真正生效的策略版本；写进 run 审计与每条判定 */
  strategy_version: string;
  /** 本次真正生效的审核模式（运行选项覆盖之后的值） */
  approval: PersonaEvolutionApprovalMode;
  /** 本次是否只演练不落地 */
  dry_run: boolean;
  /** 外壳自身失败（读不动存储等）时的规范化原因；成功运行时为 undefined */
  worker_failure?: MaintenanceFailure;
}

/** 启动恢复的结果：被放回队列的候选 */
export interface PersonaEvolutionRestoreResult {
  count: number;
  /** 恢复出来的候选所属 role；按恢复顺序 */
  restored: Array<{ role_id: string }>;
}

/**
 * 独立 Persona 演化 job。
 *
 * `run` 是唯一入口：每次调用开一条 `persona_evolution` 的 maintenance run，跑完收尾。
 * 它**不**从在线 Driver、Context consumer、Feedback consumer、`scheduleBuffer()` 或
 * Skill Promotion 流程里被调用，也不调用它们中的任何一个——四条通道各自独立，靠调度器
 * 分别触发（计划 §12）。触发方是显式调用者：`job.run()`、外部 scheduler，或内部维护服务。
 */
export interface PersonaEvolutionJob {
  run(options?: PersonaEvolutionRunOptions): Promise<PersonaEvolutionRunResult>;

  /** 启动恢复：把租约过期仍停在 processing 的候选放回队列 */
  restoreExpired(options?: { now?: string; role_id?: string }): Promise<PersonaEvolutionRestoreResult>;
}

/**
 * job 的构造依赖。刻意只接**端口**（MemoryRepository / PersonaEvolutionStrategy /
 * MaintenanceRunStore），不接任何具体后端——三个维护组件的组合方式由组合根决定。
 */
export interface PersonaEvolutionJobOptions {
  /**
   * Agent 聚合、Persona 与演化状态的读写面（候选扫描、claim、条件写都在这里）。
   *
   * 候选是「哪些 role 要演化」，而 `listAgentIds()` 就是那个读口：两个适配器都已经把隐藏的
   * 市场池 Agent 排除在外（它只是技能的归属容器，不是会演化的角色），这条判据因此只有
   * 一处定义，job 不必自己再过滤一遍。
   */
  repository: MemoryRepository;
  /** 逐条判定的策略（版本与阈值都带着它） */
  strategy: PersonaEvolutionStrategy;
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
  approval?: PersonaEvolutionApprovalMode;
  /** 参考时刻（测试注入）；缺省取系统时间 */
  now?: () => string;
  /** run 的缺省批量上限 */
  batch_size?: number;
  /** run 的缺省墙钟上限 */
  max_duration_ms?: number;
  /** 缺省是否先做启动恢复；缺省 true */
  restore_expired?: boolean;
}
