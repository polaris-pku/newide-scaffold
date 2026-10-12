/**
 * FileMaintenanceRunStore — MaintenanceRunStore 文件持久化适配器
 *
 * 每条 run 一个文件：`{root}/{run_id}.json`。与 FileMemoryDeliveryRepository 同样的
 * 落地方式——**唯一临时文件 + rename**，因此任何时刻磁盘上要么是旧的完整记录、
 * 要么是新的完整记录，不存在半完成状态；进程在写的中途消失，读到的是上一条完整快照。
 *
 * run 由**一个** worker 写：同一次运行不会有两个进程同时收尾它。所以这里用不上
 * 交付侧的跨进程独占锁——同进程内按 run_id 串行即可挡住「同一次 run 的两次收尾」，
 * 跨进程的重复由 run_id 唯一性挡在 `start` 那一步（文件已存在即报错）。
 *
 * 结构化审计（`MaintenanceRun.audit`）随整条记录一起落在这个文件里，不需要额外的列或文件：
 * 它只按 `run_id` 读回、从不参与过滤或排序，因此没有理由把它拆出去——拆开只会多出一处
 * 「记录写了、审计没写」的可能。读回时由 `MaintenanceRunSchema` 解析，旧文件里没有这个键
 * 就是缺席，不是空对象。
 */
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { nowTimestamp } from '../../core';
import { MaintenanceRunSchema, type MaintenanceFailure, type MaintenanceRun } from '../schemas';
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

export interface FileMaintenanceRunStoreOptions {
  /** run 记录目录（应用状态目录下，非工作区） */
  root: string;
}

export class FileMaintenanceRunStore implements MaintenanceRunStore {
  private readonly root: string;
  /** 按 run_id 串行的临界区链尾 */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: FileMaintenanceRunStoreOptions) {
    this.root = options.root;
  }

  async start(input: StartMaintenanceRunInput): Promise<MaintenanceRun> {
    const run = createMaintenanceRun(input, input.now ?? nowTimestamp());
    await mkdir(this.root, { recursive: true });
    // 独占创建：run_id 已存在即 EEXIST，说明这次运行已经被开过了
    const created = await createExclusively(this.filePath(run.run_id), serialize(run));
    if (!created) throw new Error(`Maintenance run already exists: ${run.run_id}`);
    return run;
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
    return readRun(this.filePath(run_id));
  }

  async list(query: MaintenanceRunQuery = {}): Promise<MaintenanceRun[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      // 还没开过任何 run：目录不存在按「没有记录」处理，与交付侧的懒初始化一致
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const runs: MaintenanceRun[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      const run = await readRun(join(this.root, entry));
      if (run) runs.push(run);
    }
    return selectMaintenanceRuns(runs, query);
  }

  private settle(
    run_id: string,
    apply: (run: MaintenanceRun, now: string) => MaintenanceRun | undefined,
    now: string | undefined,
  ): Promise<MaintenanceRun | undefined> {
    const previous = this.locks.get(run_id) ?? Promise.resolve();
    const run = previous.then(async () => {
      const current = await readRun(this.filePath(run_id));
      if (!current) return undefined;
      const next = apply(current, now ?? nowTimestamp());
      if (!next) return undefined;
      await writeJsonAtomic(this.filePath(run_id), next);
      return next;
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

  private filePath(run_id: string): string {
    assertSafeRunId(run_id);
    return join(this.root, `${run_id}.json`);
  }
}

/** run_id 会拼进文件路径；带分隔符的 id 会写到目录之外 */
function assertSafeRunId(run_id: string): void {
  if (!run_id || run_id.includes('/') || run_id.includes('\\') || run_id.includes('..')) {
    throw new Error(`Invalid maintenance run id: ${run_id}`);
  }
}

function serialize(run: MaintenanceRun): string {
  return `${JSON.stringify(run, null, 2)}\n`;
}

/** 读一条 run；文件不存在或内容不可解析时返回 undefined（损坏记录不拦住列表） */
async function readRun(filePath: string): Promise<MaintenanceRun | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return MaintenanceRunSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** `open(..., 'wx')` 独占创建：已存在即 EEXIST，返回 false 表示这次没写 */
async function createExclusively(filePath: string, payload: string): Promise<boolean> {
  try {
    const handle = await open(filePath, 'wx');
    try {
      await handle.writeFile(payload, 'utf8');
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** 原子替换：写唯一临时文件后 rename，同目录才能保证 rename 是原子替换 */
async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    await rename(tmpPath, filePath);
  } catch {
    await unlink(filePath).catch(() => undefined);
    await rename(tmpPath, filePath);
  }
}
