/**
 * InMemoryMaintenanceRunStore — MaintenanceRunStore 内存适配器
 *
 * 与 File / Pg 适配器共用 services/maintenance-run-lifecycle.ts 的转移规则，
 * 语义完全一致；仅用于单元测试与明确的内存实验入口——**生产能力不能只存内存**，
 * 所以它不假装持久化，测试里也会主动丢弃实例来模拟重启（见契约测试）。
 *
 * 并发隔离：同一 run_id 上的「读—判断—写」按 promise 链串行，保证终态只写一次。
 */
import { nowTimestamp } from '../../core';
import type { MaintenanceFailure, MaintenanceRun } from '../schemas';
import {
  completeMaintenanceRun,
  createMaintenanceRun,
  failMaintenanceRun,
  selectMaintenanceRuns,
} from '../services/maintenance-run-lifecycle';
import type {
  FinishMaintenanceRunInput,
  MaintenanceRunQuery,
  MaintenanceRunStore,
  StartMaintenanceRunInput,
} from '../ports/maintenance-run-store';

export class InMemoryMaintenanceRunStore implements MaintenanceRunStore {
  private readonly runs = new Map<string, MaintenanceRun>();
  /** 按 run_id 串行的临界区链尾 */
  private readonly locks = new Map<string, Promise<unknown>>();

  async start(input: StartMaintenanceRunInput): Promise<MaintenanceRun> {
    const run = createMaintenanceRun(input, input.now ?? nowTimestamp());
    if (this.runs.has(run.run_id)) {
      throw new Error(`Maintenance run already exists: ${run.run_id}`);
    }
    this.runs.set(run.run_id, run);
    return { ...run };
  }

  finish(
    run_id: string,
    result: FinishMaintenanceRunInput,
  ): Promise<MaintenanceRun | undefined> {
    return this.settle(run_id, (run, now) => completeMaintenanceRun(run, result, now), result.now);
  }

  fail(
    run_id: string,
    error: MaintenanceFailure,
    result: FinishMaintenanceRunInput = {},
  ): Promise<MaintenanceRun | undefined> {
    return this.settle(run_id, (run, now) => failMaintenanceRun(run, error, result, now), result.now);
  }

  async get(run_id: string): Promise<MaintenanceRun | undefined> {
    const run = this.runs.get(run_id);
    return run ? { ...run } : undefined;
  }

  async list(query: MaintenanceRunQuery = {}): Promise<MaintenanceRun[]> {
    return selectMaintenanceRuns([...this.runs.values()], query).map((run) => ({ ...run }));
  }

  /** 在 run 自己的临界区里重新读一遍再判断，重复收尾不会各自基于陈旧快照写回 */
  private settle(
    run_id: string,
    apply: (run: MaintenanceRun, now: string) => MaintenanceRun | undefined,
    now: string | undefined,
  ): Promise<MaintenanceRun | undefined> {
    const previous = this.locks.get(run_id) ?? Promise.resolve();
    const run = previous.then(async () => {
      const current = this.runs.get(run_id);
      if (!current) return undefined;
      const next = apply(current, now ?? nowTimestamp());
      if (!next) return undefined;
      this.runs.set(run_id, next);
      return { ...next };
    });
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(run_id, settled);
    void settled.then(() => {
      if (this.locks.get(run_id) === settled) this.locks.delete(run_id);
    });
    return run;
  }
}
