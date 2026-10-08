/**
 * UI 专用 driver routing 覆盖文件的持久化（Role → Driver 配置接口）。
 *
 * 职责与核心逻辑：
 * - 维护项目级 `<projectRoot>/.agent/drivers.ui.local.yaml`：**只**由后端 `driver.*` RPC
 *   写入，只承载 `default_driver` 与 `roles` 两项 role routing 覆盖。它不改写
 *   `drivers.yaml` / `drivers.local.yaml`，从而把「项目共享档案」「部署手工覆盖」
 *   「前端编辑的 routing」三件事分开；
 * - revision 是「规范化路由文档」的 sha256：`{version, default_driver, roles}`，roles 按
 *   code unit 排序、字段顺序固定、不含时间戳/绝对路径/随机数。因此同一个路由状态在任何
 *   进程、任何机器上都得到同一个 revision，多窗口并发编辑才有可比的冲突判据；
 * - 落盘是 临时文件 → fsync → rename 的原子替换。Windows 下 rename 失败（文件被占用、
 *   权限不足）向上抛，由 service 统一转成 `DRIVER_CONFIG_WRITE_FAILED`，绝不静默吞掉，
 *   也绝不先改内存再写文件；
 * - 跨进程写互斥靠 `<file>.lock` —— 一个由 `mkdir` 独占创建的**目录**。`mkdir` 在
 *   Windows 与 POSIX 上都是原子的（已存在即 EEXIST），不需要额外依赖；持有者把
 *   `{token, pid, created_at}` 写进 `owner.json`，于是「谁在持锁、是不是崩溃残留」都可判。
 *   释放按 token 校验，stale 接管用 `rename` 抢（只有一个进程能成功，且不会误删别人刚
 *   重建的新锁）；
 * - 本文件不做配置语义校验（引用是否悬空、role 是否存在）——那是 loader 与 service 的事。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { DriverConfig } from './profile';

/** UI routing 覆盖文件名（项目 `.agent` 目录内）。 */
export const UI_DRIVER_ROUTING_FILE_NAME = 'drivers.ui.local.yaml';

/** 跨进程写锁的目录名后缀；锁本身是一个目录，`mkdir` 的原子性就是互斥。 */
export const UI_DRIVER_ROUTING_LOCK_SUFFIX = '.lock';

/** 锁持有者文件名（锁目录内）。 */
const LOCK_OWNER_FILE_NAME = 'owner.json';

/** 默认等锁超时。超过就报 `config_busy`，让前端重试而不是挂住。 */
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

/** UI routing 文档版本；与 `DriverConfigLayer.version` 同一编号空间。 */
export const UI_DRIVER_ROUTING_VERSION = 1;

/**
 * 规范化之后的路由文档。
 *
 * 这是 revision 的输入，也是写盘内容的形状：`roles` 永远存在（可能为空对象），字段顺序
 * 固定为 version → default_driver → roles，保证 `JSON.stringify` 结果稳定。
 */
export interface UiDriverRoutingDocument {
  version: number;
  default_driver: string;
  roles: Record<string, string>;
}

/**
 * UI 覆盖文件的一层内容。
 *
 * 三个字段全部可缺省，与 `DriverConfigLayer` 的语义一致：一层只声明它要覆盖的部分。
 * 本仓 API 写出的文件一定同时含 `default_driver` 与 `roles`，但手工文件可以只写 roles。
 */
export interface UiDriverRoutingLayer {
  version?: number;
  default_driver?: string;
  roles?: Record<string, string>;
}

/** 写盘失败；携带一个**不含 secret** 的原因摘要。 */
export class DriverRoutingFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverRoutingFileError';
  }
}

/** 获取跨进程写锁失败（超时或无法创建）；调用方负责映射成业务错误。 */
export class DriverRoutingLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverRoutingLockError';
  }
}

/** 等锁参数；全部可调，测试用它把等待压到毫秒级。 */
export interface DriverRoutingLockOptions {
  /** 等锁总超时；默认 5000ms。 */
  timeoutMs?: number;
  /** 两次尝试之间的间隔；默认 25ms。 */
  retryMs?: number;
  /** 多久没动过视为崩溃残留、可被接管；默认 30000ms。 */
  staleMs?: number;
}

/** 已持有的锁。`release()` 幂等，且只在仍持有自己 token 时才真正删除。 */
export interface DriverRoutingLock {
  release(): void;
}

/** 锁目录内的持有者记录。 */
interface DriverRoutingLockOwner {
  token: string;
  pid: number;
}

/** `<projectRoot>/.agent/drivers.ui.local.yaml`。 */
export function uiDriverRoutingPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.agent', UI_DRIVER_ROUTING_FILE_NAME);
}

/** `<projectRoot>/.agent/drivers.ui.local.yaml.lock`（跨进程写锁目录）。 */
export function uiDriverRoutingLockPath(projectRoot: string): string {
  return `${uiDriverRoutingPath(projectRoot)}${UI_DRIVER_ROUTING_LOCK_SUFFIX}`;
}

/**
 * 把一份「想要的 routing」规范化成稳定文档。
 *
 * 规范化两件事，顺序固定：
 * 1. 删除值等于 `default_driver` 的 role key——那是冗余，「跟着默认走」不需要显式写；
 * 2. 按 code unit 排序 role key——使 revision 与文件 diff 都不受调用方顺序影响。
 */
export function normalizeUiDriverRoutingDocument(input: {
  default_driver: string;
  roles?: Readonly<Record<string, string>> | undefined;
}): UiDriverRoutingDocument {
  const roles: Record<string, string> = {};
  for (const roleId of Object.keys(input.roles ?? {}).sort(compareCodeUnits)) {
    const driverId = (input.roles ?? {})[roleId];
    if (driverId === undefined) continue;
    if (driverId === input.default_driver) continue;
    roles[roleId] = driverId;
  }
  return {
    version: UI_DRIVER_ROUTING_VERSION,
    default_driver: input.default_driver,
    roles,
  };
}

/**
 * 有效配置对应的规范化 routing 文档。
 *
 * 用它算 revision，而不是用文件字节：文件可能不存在（全靠下层配置），也可能因为手工编辑
 * 与有效状态不一致。revision 描述的是**当前生效的 routing 状态**，这样 `getConfig` 返回的
 * revision 与客户端下次 update 提交的 mapping 才一一对应，reset 也仍有 revision 保护。
 */
export function effectiveUiRoutingDocument(config: DriverConfig): UiDriverRoutingDocument {
  return normalizeUiDriverRoutingDocument({
    default_driver: config.default_driver,
    roles: config.roles,
  });
}

/** 稳定 JSON：字段顺序固定 + roles 已排序。 */
export function serializeUiRoutingDocumentForRevision(doc: UiDriverRoutingDocument): string {
  return JSON.stringify({
    version: doc.version,
    default_driver: doc.default_driver,
    roles: sortKeys(doc.roles),
  });
}

/** `sha256:<hex>`；内容相同则 revision 相同。 */
export function computeUiRoutingRevision(doc: UiDriverRoutingDocument): string {
  const digest = createHash('sha256')
    .update(serializeUiRoutingDocumentForRevision(doc))
    .digest('hex');
  return `sha256:${digest}`;
}

/** 写盘文本：一段说明注释 + 规范化 YAML。 */
export function serializeUiDriverRoutingFile(doc: UiDriverRoutingDocument): string {
  const header = [
    '# 本文件由 NewIDE 后端 driver.* JSON-RPC 维护，请勿手工编辑。',
    '# reset 会删除本文件并回到下层 drivers.yaml / drivers.local.yaml 的配置。',
    '',
  ].join('\n');
  const body = stringifyYaml(
    {
      version: doc.version,
      default_driver: doc.default_driver,
      roles: sortKeys(doc.roles),
    },
    { lineWidth: 0 },
  );
  return `${header}${body}`;
}

/** 解析 UI routing 覆盖文件内容；结构非法时抛 {@link DriverRoutingFileError}。 */
export function parseUiDriverRoutingLayer(
  content: string,
  filePath: string,
): UiDriverRoutingLayer {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch {
    throw new DriverRoutingFileError(`UI driver routing file is not valid YAML: ${filePath}`);
  }
  const record = isRecord(raw) ? raw : undefined;
  if (!record) {
    throw new DriverRoutingFileError(`UI driver routing file must be a mapping: ${filePath}`);
  }
  const version = record.version;
  if (version !== undefined && (typeof version !== 'number' || !Number.isInteger(version))) {
    throw new DriverRoutingFileError(`UI driver routing file has invalid version: ${filePath}`);
  }
  const defaultDriver = record.default_driver;
  if (defaultDriver !== undefined && typeof defaultDriver !== 'string') {
    throw new DriverRoutingFileError(
      `UI driver routing file has invalid default_driver: ${filePath}`,
    );
  }
  const rawRoles = record.roles;
  let roles: Record<string, string> | undefined;
  if (rawRoles !== undefined) {
    if (!isRecord(rawRoles)) {
      throw new DriverRoutingFileError(`UI driver routing file has invalid roles: ${filePath}`);
    }
    roles = {};
    for (const [roleId, driverId] of Object.entries(rawRoles)) {
      if (typeof driverId !== 'string') {
        throw new DriverRoutingFileError(
          `UI driver routing file roles.${roleId} must be a driver id: ${filePath}`,
        );
      }
      roles[roleId] = driverId;
    }
  }
  return {
    ...(version === undefined ? {} : { version }),
    ...(defaultDriver === undefined ? {} : { default_driver: defaultDriver }),
    ...(roles === undefined ? {} : { roles }),
  };
}

/**
 * UI routing 覆盖文件的读写口。
 *
 * 生产只用 `readRaw` / `writeAtomic` / `remove` / `exists`；`writeAtomic` 的原子性由
 * 临时文件 + fsync + rename 保证，调用方拿到的成功即「盘上是完整的新内容」。
 */
export class DriverRoutingFileStore {
  readonly filePath: string;
  /** 跨进程写锁的目录路径。 */
  readonly lockPath: string;

  constructor(projectRoot: string) {
    const resolvedRoot = path.resolve(projectRoot);
    const expectedDir = path.join(resolvedRoot, '.agent');
    const resolved = path.join(expectedDir, UI_DRIVER_ROUTING_FILE_NAME);
    // 目标路径完全由 projectRoot 推出，没有任何调用方可控的路径片段；这里再断言一次，
    // 使「写到 .agent 目录之外」在结构上不可能发生。
    if (path.dirname(resolved) !== expectedDir) {
      throw new DriverRoutingFileError(`Refusing to use UI routing path outside .agent: ${resolved}`);
    }
    this.filePath = resolved;
    this.lockPath = `${resolved}${UI_DRIVER_ROUTING_LOCK_SUFFIX}`;
  }

  /**
   * 获取跨进程独占写锁。
   *
   * 算法：
   * 1. `mkdir(lockPath)` —— 原子；EEXIST 表示别人持锁；
   * 2. 把 `{token, pid, created_at}` 写进锁目录的 `owner.json`，让持锁者可判、可清理；
   * 3. 拿不到就每 `retryMs` 重试一次，直到 `timeoutMs`；期间若发现锁是崩溃残留
   *    （持有者进程已死，或超过 `staleMs` 没动过）就接管；
   * 4. 超时抛 {@link DriverRoutingLockError}，由 service 转成可重试的 `config_busy`。
   *
   * 调用方必须在 `finally` 里 `release()`。
   */
  async acquireLock(options: DriverRoutingLockOptions = {}): Promise<DriverRoutingLock> {
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
        throw new DriverRoutingLockError(
          `Timed out after ${String(timeoutMs)}ms waiting for the driver routing write lock`,
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
      throw new DriverRoutingLockError(
        `Failed to create driver routing lock (${describeError(error)})`,
      );
    }
    try {
      writeFileSync(
        this.lockOwnerPath(),
        JSON.stringify({ token, pid: process.pid, created_at: new Date().toISOString() }),
        { encoding: 'utf-8', flag: 'wx' },
      );
      return true;
    } catch (error) {
      // 目录建了但主人没记上：清掉，别让别人对着一个没有主人的锁空等。
      removePathQuietly(this.lockPath);
      throw new DriverRoutingLockError(
        `Failed to record driver routing lock owner (${describeError(error)})`,
      );
    }
  }

  /**
   * 释放锁。
   *
   * 只在 `owner.json` 的 token 仍等于自己时才删：本进程若因卡顿被别的进程当 stale 接管，
   * 简单 rmdir 会把**别人**的锁删掉，等于互斥失效。
   */
  private releaseLock(token: string): void {
    const owner = this.readLockOwner();
    if (owner && owner.token !== token) return;
    removePathQuietly(this.lockPath);
  }

  private lockOwnerPath(): string {
    return path.join(this.lockPath, LOCK_OWNER_FILE_NAME);
  }

  private readLockOwner(): DriverRoutingLockOwner | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.lockOwnerPath(), 'utf-8'));
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
   * 用 `rename` 而不是 `rmdir` 抢：rename 的原子性保证只有一个进程能把它挪走，而且被挪走的
   * 正是我们观察到的那一份旧锁——不会误删别人刚重建的新锁。返回 true 表示「可以立刻重试
   * mkdir」。
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

  exists(): boolean {
    return isRegularFile(this.filePath);
  }

  /** 原始文本；文件不存在（或路径不是普通文件）返回 undefined。 */
  readRaw(): string | undefined {
    if (!isRegularFile(this.filePath)) return undefined;
    try {
      return readFileSync(this.filePath, 'utf-8');
    } catch (cause) {
      throw new DriverRoutingFileError(
        `Failed to read UI driver routing file (${describeError(cause)})`,
      );
    }
  }

  /** 解析后的层内容；文件不存在返回 undefined。 */
  read(): UiDriverRoutingLayer | undefined {
    const raw = this.readRaw();
    return raw === undefined ? undefined : parseUiDriverRoutingLayer(raw, this.filePath);
  }

  /**
   * 原子替换。
   *
   * 顺序：写 `*.tmp-<nonce>`（独占创建，避免撞名）→ fsync → rename 覆盖。任何一步失败都
   * 抛 {@link DriverRoutingFileError}，并尽力清掉临时文件，不留下半截目标文件。
   */
  writeAtomic(doc: UiDriverRoutingDocument): void {
    this.writeTextAtomic(serializeUiDriverRoutingFile(doc));
  }

  /** 原子写入任意文本；用于写入失败后把文件恢复成原字节。 */
  writeTextAtomic(content: string): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
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
      throw new DriverRoutingFileError(
        `Failed to stage UI driver routing file (${describeError(cause)})`,
      );
    }

    try {
      renameSync(tmpPath, this.filePath);
    } catch (cause) {
      removeQuietly(tmpPath);
      throw new DriverRoutingFileError(
        `Failed to replace UI driver routing file (${describeError(cause)})`,
      );
    }
  }

  /** 删除覆盖文件；不存在时是空操作。 */
  remove(): void {
    try {
      rmSync(this.filePath, { force: true });
    } catch (cause) {
      throw new DriverRoutingFileError(
        `Failed to remove UI driver routing file (${describeError(cause)})`,
      );
    }
  }
}

/** 只返回摘要：路径类别 + 系统错误，绝不带上可能含 secret 的内容。 */
function describeError(cause: unknown): string {
  if (cause && typeof cause === 'object') {
    const code = Reflect.get(cause, 'code');
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return cause instanceof Error ? cause.name : 'unknown error';
}

function removeQuietly(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // 临时文件清理失败不影响主错误。
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

/** 目标路径是否是**普通文件**。目录/符号链接等一律视为「没有这份覆盖」。 */
function isRegularFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function sortKeys(roles: Readonly<Record<string, string>>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(roles).sort(compareCodeUnits)) {
    const value = roles[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}

/** 按 code unit（即 `<` 比较，不依赖 locale）排序，跨机器结果一致。 */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
