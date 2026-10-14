/**
 * 原子文件替换（driver 配置持久化的共用底座）。
 *
 * 职责与核心逻辑：
 * - 「临时文件 → fsync → rename」三步，任何一步失败都抛 {@link AtomicFileWriteError}，
 *   并尽力清掉临时文件，绝不留下半截目标文件；
 * - `fsync` 是必要的一步：只 rename 不 fsync 时，掉电可能留下「名字换了、内容还是空的」；
 * - 只描述**阶段与系统错误码**，不拼接调用方的业务文案——这样上层可以在不改变错误语义的
 *   前提下，把消息映射成自己的稳定业务码（driver routing 与 driver discovery 就这么用）。
 *
 * 从 `driver-routing-file-store` 中抽出（行为逐字不变），供自动发现 profile 的持久化复用：
 * 两处写的是同一个 `.agent` 目录下的文件，「原子替换」这件事不该有两份实现。
 */
import { closeSync, mkdirSync, openSync, fsyncSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 写入失败的阶段。 */
export type AtomicFileWriteStage = 'stage' | 'replace';

/** 原子替换失败。`code` 是系统错误码（如 `EACCES`），没有时为 undefined。 */
export class AtomicFileWriteError extends Error {
  constructor(
    readonly stage: AtomicFileWriteStage,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'AtomicFileWriteError';
  }
}

/**
 * 原子地把 `content` 写到 `filePath`（覆盖写）。
 *
 * 目标目录不存在时先递归创建——配置目录不必由调用方预先准备。
 */
export function writeFileAtomic(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;

  try {
    writeFileSync(tmpPath, content, { encoding: 'utf-8', flag: 'wx' });
    const fd = openSync(tmpPath, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (cause) {
    removeQuietly(tmpPath);
    throw new AtomicFileWriteError('stage', errorCodeOf(cause), describeError(cause));
  }

  try {
    renameSync(tmpPath, filePath);
  } catch (cause) {
    removeQuietly(tmpPath);
    throw new AtomicFileWriteError('replace', errorCodeOf(cause), describeError(cause));
  }
}

/** 只返回摘要：系统错误码，或错误类的名字。绝不带上可能含 secret 的内容。 */
export function describeError(cause: unknown): string {
  const code = errorCodeOf(cause);
  if (code !== undefined) return code;
  return cause instanceof Error ? cause.name : 'unknown error';
}

/** 系统错误码，如 `EEXIST` / `ESRCH`；没有就返回 undefined。 */
export function errorCodeOf(error: unknown): string | undefined {
  if (error && typeof error === 'object') {
    const code = Reflect.get(error, 'code');
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return undefined;
}

function removeQuietly(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // 临时文件清理失败不影响主错误。
  }
}
