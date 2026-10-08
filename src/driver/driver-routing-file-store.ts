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
 * - 本文件不做配置语义校验（引用是否悬空、role 是否存在）——那是 loader 与 service 的事。
 */
import { createHash } from 'node:crypto';
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

/** `<projectRoot>/.agent/drivers.ui.local.yaml`。 */
export function uiDriverRoutingPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.agent', UI_DRIVER_ROUTING_FILE_NAME);
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
