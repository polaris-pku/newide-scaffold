/**
 * maintenance-run-lifecycle — 维护 run 的状态转移规则（纯函数）
 *
 * 与 delivery-lifecycle.ts 同一个用意：规则的「怎么变」只写一次，三个适配器
 * （File / InMemory / PGlite+PostgreSQL）只负责「怎么读写」。run 的形状比交付项
 * 简单——没有 claim、没有 lease，只有一条**终态写一次**的约束：
 *
 *   running --finish--> completed
 *      |
 *      +----fail-------> failed
 *
 * 收尾只从 `running` 出发：已经收尾的 run 再收尾返回 undefined，而不是把先到的
 * 结论覆盖掉。计数与审计都按字段合并，调用方只报它知道的那些——「没报」不等于「归零」，
 * 也不等于「清空」（见 `mergeMaintenanceRunAudit`）。
 *
 * 所有函数都接收显式的 `now`，不自己读时钟——测试因此不依赖真实时间。
 */
import { randomUUID } from 'node:crypto';
import type {
  MaintenanceFailure,
  MaintenanceRun,
  MaintenanceRunAudit,
  MaintenanceRunCounts,
  MaintenanceRunStatus,
} from '../schemas';
import type {
  FinishMaintenanceRunInput,
  MaintenanceRunQuery,
  StartMaintenanceRunInput,
} from '../ports/maintenance-run-store';

/** 新 run 的初始计数：六个出口全为 0，由 worker 边处理边累加 */
export const EMPTY_MAINTENANCE_RUN_COUNTS: MaintenanceRunCounts = {
  claimed_count: 0,
  completed_count: 0,
  retried_count: 0,
  dead_letter_count: 0,
  skipped_count: 0,
  failure_count: 0,
};

/** 生成一个 run_id；显式传入时以传入的为准（测试注入固定 id） */
export function createMaintenanceRunId(job_type: string): string {
  return `mr_${job_type}_${randomUUID()}`;
}

/** 开一条 running 的 run */
export function createMaintenanceRun(
  input: StartMaintenanceRunInput,
  now: string,
): MaintenanceRun {
  if (!input.worker_id) {
    throw new Error('Maintenance run requires a non-empty worker_id.');
  }
  const audit = mergeMaintenanceRunAudit(undefined, input.audit);
  return {
    run_id: input.run_id ?? createMaintenanceRunId(input.job_type),
    job_type: input.job_type,
    status: 'running',
    worker_id: input.worker_id,
    started_at: now,
    ...EMPTY_MAINTENANCE_RUN_COUNTS,
    ...(audit !== undefined ? { audit } : {}),
  };
}

/** 计数键的固定清单：合并只认这些键，run 上别的字段不可能被计数悄悄带进来 */
const COUNT_KEYS = Object.keys(EMPTY_MAINTENANCE_RUN_COUNTS) as Array<
  keyof MaintenanceRunCounts
>;

/**
 * 按字段合并计数：缺省的字段保持原值，不让「没报」被读成「归零」。
 *
 * 结果**只含六个计数字段**——从 EMPTY 起按 COUNT_KEYS 逐个填，而不是展开 base：
 * `base` 通常是一条完整的 MaintenanceRun，直接展开会把 status/run_id 一起带进来，
 * 收尾时 `...counts` 就会把刚定的终态覆盖回 running。
 */
export function mergeMaintenanceRunCounts(
  base: MaintenanceRunCounts,
  patch: Partial<MaintenanceRunCounts>,
): MaintenanceRunCounts {
  const next: MaintenanceRunCounts = { ...EMPTY_MAINTENANCE_RUN_COUNTS };
  for (const key of COUNT_KEYS) {
    next[key] = patch[key] ?? base[key];
  }
  return next;
}

/** 是否已是终态；终态不再接受任何收尾 */
export function isMaintenanceRunTerminal(status: MaintenanceRunStatus): boolean {
  return status !== 'running';
}

/**
 * 按字段合并审计：收尾时只补齐它知道的那些，缺席的字段保留 run 上已有的值。
 *
 * 与 `mergeMaintenanceRunCounts` 同一条规矩、同一个理由：**「没报」不等于「归零」**。开跑时
 * 记下的策略版本不该因为收尾只带逐候选摘要就被抹掉——恰恰相反，那一条正是 worker 中途死掉
 * 之后唯一还留在 run 上的事实。
 *
 * 覆盖是**顶层字段**级的，不递归合并内部对象：一份新的 `input_snapshot` 整块取代旧的（而不是
 * 两个 digest 逐键拼起来）。深层合并看着贴心，实际会让「这次报了什么」变得难以预料——读的人
 * 得先想一遍两边各有什么才敢读结果。要报的部分自己写全。
 *
 * 显式写成 `undefined` 的字段与缺席等价（都不覆盖）：`exactOptionalPropertyTypes` 下「清空
 * 一个字段」不是本函数的语义，三个适配器都照这一份规则走。
 *
 * 返回的是**深拷贝**：调用方（job 把自己边跑边攒的上下文交出来）之后还持有同一份嵌套数组与
 * 对象，不复制的话「写完再改自己那份」就等于改了记录。文件与数据库两条腿因为过了序列化天然
 * 没有这个耦合，内存那条腿靠这一份复制对齐——三条腿语义一致才谈得上契约。
 */
export function mergeMaintenanceRunAudit(
  base: MaintenanceRunAudit | undefined,
  patch: MaintenanceRunAudit | undefined,
): MaintenanceRunAudit | undefined {
  const merged: Record<string, unknown> = { ...base, ...patch };
  const present = Object.entries(merged).filter(([, value]) => value !== undefined);
  if (present.length === 0) return undefined;
  return structuredClone(Object.fromEntries(present)) as MaintenanceRunAudit;
}

function settle(
  run: MaintenanceRun,
  status: 'completed' | 'failed',
  result: FinishMaintenanceRunInput,
  now: string,
  lastError: string | undefined,
): MaintenanceRun | undefined {
  if (isMaintenanceRunTerminal(run.status)) return undefined;
  const counts = mergeMaintenanceRunCounts(run, result);
  const audit = mergeMaintenanceRunAudit(run.audit, result.audit);
  // 终态字段放在展开之后：即便计数合并哪天多带了别的键，也覆盖不了这次收尾的结论
  const finished: MaintenanceRun = {
    run_id: run.run_id,
    job_type: run.job_type,
    worker_id: run.worker_id,
    started_at: run.started_at,
    ...counts,
    ...(audit !== undefined ? { audit } : {}),
    status,
    finished_at: now,
  };
  if (lastError !== undefined) finished.last_error = lastError;
  return finished;
}

/** 正常收尾：running → completed（终态只写一次） */
export function completeMaintenanceRun(
  run: MaintenanceRun,
  result: FinishMaintenanceRunInput,
  now: string,
): MaintenanceRun | undefined {
  return settle(run, 'completed', result, now, result.last_error);
}

/**
 * 失败收尾：running → failed。
 *
 * 失败原因以规范化 code + message 记录；`result` 里的计数照样合并——一次失败的 run
 * 也可能已经处理成功了前几条，「失败」说的是这次运行，不是它碰过的每一条。
 */
export function failMaintenanceRun(
  run: MaintenanceRun,
  error: MaintenanceFailure,
  result: FinishMaintenanceRunInput,
  now: string,
): MaintenanceRun | undefined {
  return settle(run, 'failed', result, now, `${error.code}: ${error.message}`);
}

/** run 的排序：先按开始时刻，再按 run_id——同一毫秒开的两个 run 也要有序 */
export function compareMaintenanceRuns(left: MaintenanceRun, right: MaintenanceRun): number {
  if (left.started_at !== right.started_at) {
    return left.started_at < right.started_at ? -1 : 1;
  }
  return left.run_id.localeCompare(right.run_id);
}

/**
 * 过滤 + 排序 + 截断。
 *
 * 排序固定升序（时间顺序），`limit` 因此截取的是**最近**的几条：调用方要看的是
 * 刚发生了什么，而不是最早那条。三个适配器共用一个实现，免得各自解释一遍
 * 「最近的 N 条」是什么意思。
 */
export function selectMaintenanceRuns(
  runs: MaintenanceRun[],
  query: MaintenanceRunQuery = {},
): MaintenanceRun[] {
  const filtered = runs.filter((run) => {
    if (query.job_type !== undefined && run.job_type !== query.job_type) return false;
    if (query.status !== undefined && run.status !== query.status) return false;
    if (query.worker_id !== undefined && run.worker_id !== query.worker_id) return false;
    return true;
  });
  filtered.sort(compareMaintenanceRuns);
  return applyMaintenanceRunLimit(filtered, query.limit);
}

/**
 * 截取最近 `limit` 条（输入必须已按时间升序）。
 *
 * 单独暴露给数据库适配器：它把过滤与排序交给 SQL（那是索引的用武之地），只把
 * 「最近的 N 条」这一步拿回来共享，免得两处对 limit 有各自的解释。
 */
export function applyMaintenanceRunLimit(
  runs: MaintenanceRun[],
  limit: number | undefined,
): MaintenanceRun[] {
  if (limit === undefined) return runs;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('Maintenance run query limit must be a non-negative integer.');
  }
  return runs.slice(Math.max(0, runs.length - limit));
}
