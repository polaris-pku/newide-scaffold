/**
 * MaintenanceRunStore 端口 — 维护 job 的运行记录存储
 *
 * 每个 worker/job 每次运行都开一条 run：谁（worker_id）在什么时候、按什么 job_type
 * 跑了一次，claim 到多少、完成多少、重试多少、死信多少、跳过多少，以及失败原因。
 * 它是**观测与审计**实体，不是业务事务边界——run 的成败不改变任何交付项的状态，
 * 交付项的状态也不回写 run（见 schemas.ts 的 MaintenanceRun 注释）。
 *
 * 契约语义：
 * - `start` 生成 `running` 的一条；`run_id` 由调用方给或由实现生成，重复的 run_id
 *   是错误（同一次运行被开了两遍），不静默覆盖。
 * - `finish` / `fail` 只能从 `running` 出发。**终态只写一次**：对已经收尾的 run
 *   再收尾返回 undefined，而不是把先到的结论覆盖掉。
 * - 计数按字段合并：调用方只报它知道的那些，其余保持不变量（缺省 0）。
 * - 记录不存在时 `get` 返回 undefined、`finish`/`fail` 返回 undefined——与交付端口
 *   「返回 undefined 表示这次什么都没做」是同一种约定。
 *
 * 三种后端（File / InMemory / PGlite+PostgreSQL）必须给出同一套行为，契约测试用
 * 同一矩阵跑三遍。
 */
import type {
  MaintenanceFailure,
  MaintenanceJobType,
  MaintenanceRun,
  MaintenanceRunCounts,
  MaintenanceRunStatus,
} from '../schemas';

/** 开一条 run 的输入 */
export interface StartMaintenanceRunInput {
  job_type: MaintenanceJobType;
  /** 执行者标识；写进记录，也用于「这台 worker 最近跑了什么」的过滤 */
  worker_id: string;
  /** 显式指定 run_id（测试注入用）；缺省由实现生成 */
  run_id?: string;
  /** 参考时刻（测试注入）；缺省取当前时间 */
  now?: string;
}

/**
 * 收尾一条 run 的输入。
 *
 * 计数是**部分**的：worker 只报它统计到的那些，其余保持 run 上已有的值
 * （新开的 run 初始全 0）。这样 Phase 1+ 的 worker 可以边处理边累加，
 * 不必为了收尾再拼一份完整计数。
 */
export interface FinishMaintenanceRunInput extends Partial<MaintenanceRunCounts> {
  /** 本次运行的最后一条错误（部分失败也允许带上） */
  last_error?: string;
  /** 参考时刻（测试注入）；缺省取当前时间 */
  now?: string;
}

/** run 的查询过滤（全部可选，缺省即全量） */
export interface MaintenanceRunQuery {
  job_type?: MaintenanceJobType;
  status?: MaintenanceRunStatus;
  worker_id?: string;
  /**
   * 最多返回多少条。结果按 `started_at`（再按 `run_id`）升序，因此 `limit`
   * 截取的是**最近**的那几条，而不是最早的那几条——观测关心的是刚发生了什么。
   */
  limit?: number;
}

export interface MaintenanceRunStore {
  /** 开一条 `running` 的 run；run_id 已存在时抛错（同一次运行不该被开两遍） */
  start(input: StartMaintenanceRunInput): Promise<MaintenanceRun>;

  /**
   * 正常收尾：`running` → `completed`，带上本次计数。
   *
   * 返回收尾后的记录；run 不存在或已是终态时返回 undefined。
   */
  finish(
    run_id: string,
    result: FinishMaintenanceRunInput,
  ): Promise<MaintenanceRun | undefined>;

  /**
   * 失败收尾：`running` → `failed`，带上规范化失败码、原因与已知计数。
   *
   * 与 `finish` 一样只从 `running` 出发；已在终态的 run 不被覆盖。
   */
  fail(
    run_id: string,
    error: MaintenanceFailure,
    result?: FinishMaintenanceRunInput,
  ): Promise<MaintenanceRun | undefined>;

  /** 读一条 run */
  get(run_id: string): Promise<MaintenanceRun | undefined>;

  /** 列出 run（按 started_at 升序；缺省全量） */
  list(query?: MaintenanceRunQuery): Promise<MaintenanceRun[]>;
}
