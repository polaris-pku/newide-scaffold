/**
 * `.agent` 目录下的跨进程文件锁（driver routing 与 driver discovery 共用）。
 *
 * 职责与核心逻辑：
 * - 锁本身是一个**目录**：`mkdir` 在 Windows 与 POSIX 上都是原子的（已存在即 EEXIST），
 *   不需要额外依赖。持有者把 `{token, pid, created_at}` 写进 `owner.json`，于是
 *   「谁在持锁、是不是崩溃残留」都可判；
 * - 释放按 token 校验——本进程若因卡顿被别的进程当 stale 接管，简单 rmdir 会把**别人**的
 *   锁删掉，等于互斥失效；
 * - stale 接管用 `rename` 抢：只有一个进程能成功，而且被挪走的正是我们观察到的那一份旧锁，
 *   不会误删别人刚重建的新锁；
 * - 只提供互斥，不解释业务：拿不到锁抛 {@link AgentDirLockError}，由调用方映射成自己的
 *   可重试业务码（routing 映射成 `config_busy`，discovery 映射成 `DRIVER_DISCOVERY_LOCK_BUSY`）。
 *
 * 从 `driver-routing-file-store` 中抽出（语义逐字不变），使自动发现 profile 的写入能复用同
 * 一套 `.agent` 目录锁语义，而不是各写一份。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** 锁目录后缀；锁本身是一个目录，`mkdir` 的原子性就是互斥。 */
export const AGENT_DIR_LOCK_SUFFIX = '.lock';

/** 锁持有者文件名（锁目录内）。 */
const LOCK_OWNER_FILE_NAME = 'owner.json';

/** 默认等锁超时。超过就报错，让前端重试而不是挂住。 */
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
/** 默认重试间隔。 */
const DEFAULT_LOCK_RETRY_MS = 25;
/**
 * 默认 stale 阈值。
 *
 * 持有者进程已死时立刻可接管；这个阈值兜的是「进程没死但卡住」与「owner.json 没写成」的
 * 情况——没有它，一次崩溃就可能永久死锁。
 */
const DEFAULT_LOCK_STALE_MS = 30_000;

/** 获取跨进程独占锁失败（超时或无法创建）；调用方负责映射成业务错误。 */
export class AgentDirLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentDirLockError';
  }
}

/** 等锁参数；全部可调，测试用它把等待压到毫秒级。 */
export interface AgentDirLockOptions {
  /** 等锁总超时；默认 5000ms。 */
  timeoutMs?: number;
  /** 两次尝试之间的间隔；默认 25ms。 */
  retryMs?: number;
  /** 多久没动过视为崩溃残留、可被接管；默认 30000ms。 */
  staleMs?: number;
}

/** 已持有的锁。`release()` 幂等，且只在仍持有自己 token 时才真正删除。 */
export interface AgentDirLock {
  release(): void;
}

/** 锁目录内的持有者记录。 */
interface AgentDirLockOwner {
  token: string;
  pid: number;
}

/** `<filePath>.lock`。 */
export function agentDirLockPath(filePath: string): string {
  return `${filePath}${AGENT_DIR_LOCK_SUFFIX}`;
}

/**
 * 独占文件锁。
 *
 * 算法：
 * 1. `mkdir(lockPath)` —— 原子；EEXIST 表示别人持锁；
 * 2. 把 `{token, pid, created_at}` 写进锁目录的 `owner.json`，让持锁者可判、可清理；
 * 3. 拿不到就每 `retryMs` 重试一次，直到 `timeoutMs`；期间若发现锁是崩溃残留
 *    （持有者进程已死，或超过 `staleMs` 没动过）就接管；
 * 4. 超时抛 {@link AgentDirLockError}。
 *
 * 调用方必须在 `finally` 里 `release()`。
 */
export class AgentDirFileLock {
  readonly lockPath: string;

  constructor(lockPath: string) {
    this.lockPath = lockPath;
  }

  async acquire(options: AgentDirLockOptions = {}): Promise<AgentDirLock> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
    const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
    const token = randomUUID();
    const deadline = Date.now() + Math.max(0, timeoutMs);

    mkdirSync(path.dirname(this.lockPath), { recursive: true });

    for (;;) {
      if (this.tryCreateLock(token)) {
        return { release: () => this.releaseLock(token) };
      }
      // 手里这份是不是崩溃残留？能接管就立刻重试，不必等满超时。
      if (this.tryStealStaleLock(staleMs)) continue;
      if (Date.now() >= deadline) {
        throw new AgentDirLockError(
          `Timed out after ${String(timeoutMs)}ms waiting for the agent directory write lock`,
        );
      }
      await sleep(retryMs);
    }
  }

  /** `mkdir` 成功即持有锁；随后写 owner。任何一步失败都不留半截锁。 */
  private tryCreateLock(token: string): boolean {
    try {
      mkdirSync(this.lockPath);
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) return false;
      throw new AgentDirLockError(`Failed to create agent directory lock (${describeError(error)})`);
    }
    try {
      writeFileSync(
        path.join(this.lockPath, LOCK_OWNER_FILE_NAME),
        JSON.stringify({ token, pid: process.pid, created_at: new Date().toISOString() }),
        { encoding: 'utf-8', flag: 'wx' },
      );
      return true;
    } catch (error) {
      // 目录建了但主人没记上：清掉，别让别人对着一个没有主人的锁空等。
      removePathQuietly(this.lockPath);
      throw new AgentDirLockError(
        `Failed to record agent directory lock owner (${describeError(error)})`,
      );
    }
  }

  /**
   * 释放锁。
   *
   * 只在 `owner.json` 的 token 仍等于自己时才删。
   */
  private releaseLock(token: string): void {
    const owner = this.readLockOwner();
    if (owner && owner.token !== token) return;
    removePathQuietly(this.lockPath);
  }

  private readLockOwner(): AgentDirLockOwner | undefined {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(path.join(this.lockPath, LOCK_OWNER_FILE_NAME), 'utf-8'),
      );
      if (!parsed || typeof parsed !== 'object') return undefined;
      const token = Reflect.get(parsed, 'token');
      if (typeof token !== 'string' || token.length === 0) return undefined;
      const pid = Reflect.get(parsed, 'pid');
      return { token, pid: typeof pid === 'number' ? pid : -1 };
    } catch {
      return undefined;
    }
  }

  /**
   * 接管崩溃残留的锁。
   *
   * 用 `rename` 而不是 `rmdir` 抢：rename 的原子性保证只有一个进程能把它挪走。返回 true 表示
   * 「可以立刻重试 mkdir」。
   */
  private tryStealStaleLock(staleMs: number): boolean {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.lockPath).mtimeMs;
    } catch {
      // 锁在这两次尝试之间被释放了：直接重试 mkdir。
      return true;
    }

    const owner = this.readLockOwner();
    const deadOwner = owner !== undefined && owner.pid > 0 && !isProcessAlive(owner.pid);
    const tooOld = Date.now() - mtimeMs > staleMs;
    if (!deadOwner && !tooOld) return false;

    const stolen = `${this.lockPath}.stale-${randomUUID()}`;
    try {
      renameSync(this.lockPath, stolen);
    } catch {
      return false;
    }
    removePathQuietly(stolen);
    return true;
  }
}

/** 递归删除（锁目录 / 被挪走的 stale 锁）；失败不影响主流程。 */
function removePathQuietly(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // 清理失败时下一次 stale 判定仍会把它接管掉。
  }
}

/** 只返回摘要：系统错误，绝不带上可能含 secret 的内容。 */
function describeError(cause: unknown): string {
  const code = errorCodeOf(cause);
  if (code !== undefined) return code;
  return cause instanceof Error ? cause.name : 'unknown error';
}

/** 系统错误码，如 `EEXIST` / `ESRCH`；没有就返回 undefined。 */
function errorCodeOf(error: unknown): string | undefined {
  if (error && typeof error === 'object') {
    const code = Reflect.get(error, 'code');
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return undefined;
}

function isErrorCode(error: unknown, expected: string): boolean {
  return errorCodeOf(error) === expected;
}

/**
 * 持有者进程是否还活着。
 *
 * `ESRCH` = 不存在（已死）；`EPERM` = 存在但当前用户无权发信号（活着）。只有 ESRCH 才算死，
 * 否则会把别的用户的活进程误判成残留。
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorCode(error, 'ESRCH');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
