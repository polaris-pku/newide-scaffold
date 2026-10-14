/**
 * Driver 自动发现结果的持久化（driver 自动发现 / 适配层）。
 *
 * 职责与核心逻辑：
 * - 维护两个文件，**职责分开**：
 *   1. `<projectRoot>/.agent/drivers.detected.local.yaml` —— 只存**可重建的最小 profile**
 *      （`agent` + `description`），供 `profile-loader` 当作一层配置加载，使探测到的 driver
 *      在后端重启后依然出现在 `driver.getConfig` 里；
 *   2. `<stateRoot>/driver-discovery.json` —— 存**证据**：探测时间、连接类型、provenance、
 *      结论与失败原因。它是诊断用的，不参与 routing revision。
 * - 两个文件都是「临时文件 → fsync → rename」的原子替换（`atomic-file-write`），写入前
 *   先取 `.agent` 目录下的跨进程锁（与 UI routing 同一套语义），避免两个 backend 实例
 *   各写一半；
 * - **绝不写入敏感或不可重建的东西**：profile 文件里没有启动命令、参数、环境变量或凭据；
 *   错误信息与 state 文件里没有绝对路径。理由是这两个文件会被前端间接看到（routing 快照、
 *   discovery 错误码），而 `DriverProbe.launch` 描述的是 A 侧启动细节，不属于 B 侧事实；
 * - **损坏即退化，不阻塞启动**：YAML/JSON 坏了就当作「没有历史发现结果」，把原因摘要交给
 *   调用方记录，而不是让整个后端起不来。文件不存在本身是合法状态（首次运行）。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

import { AgentDirFileLock, AgentDirLockError, agentDirLockPath } from './agent-dir-lock';
import { describeError, writeFileAtomic } from './atomic-file-write';
import {
  DRIVER_DISCOVERY_LOCK_BUSY,
  DRIVER_DISCOVERY_SCHEMA_VERSION,
  type DriverDiscoveryRecord,
  type DriverProbeStatus,
} from './driver-discovery-catalog';
import type { DriverProfile } from './profile';

/** 自动发现 profile 文件名（项目 `.agent` 目录内）。 */
export const DETECTED_DRIVER_PROFILES_FILE_NAME = 'drivers.detected.local.yaml';

/** 发现状态文件名（state root 内）。 */
export const DRIVER_DISCOVERY_STATE_FILE_NAME = 'driver-discovery.json';

/** 自动发现 profile 文件的版本；与 `DriverConfigLayer.version` 同一编号空间。 */
export const DETECTED_DRIVER_PROFILES_VERSION = 1;

/**
 * 自动发现层允许出现的字段。
 *
 * 刻意比 {@link DriverProfile} 窄得多：自动文件是**机器生成**的，用户手工写的运行参数、环境
 * 变量与凭据声明的归属地是 `drivers.yaml`，不是这里。多一个键就判损坏（见文件头「损坏即退化」）。
 */
const detectedDriverProfileSchema = z
  .object({
    agent: z.string().min(1),
    description: z.string().min(1).optional(),
  })
  .strict();

const detectedDriverProfilesSchema = z
  .object({
    version: z.number().int().positive().optional(),
    drivers: z.record(z.string().min(1), detectedDriverProfileSchema),
  })
  .strict();

/** 自动发现 profile 文件的解析结果。 */
export interface DetectedDriverProfilesDocument {
  version: number;
  drivers: Record<string, DriverProfile>;
}

/** 发现状态文件的形状。字段全部是**非敏感证据**：无命令、无参数、无环境变量、无路径。 */
export const driverDiscoveryStateDocumentSchema = z
  .object({
    schema_version: z.literal(DRIVER_DISCOVERY_SCHEMA_VERSION),
    generated_at: z.string().min(1),
    probe_status: z.enum(['ready', 'failed', 'unavailable', 'stale']),
    drivers: z.array(
      z
        .object({
          driver_id: z.string().min(1),
          agent_id: z.string().min(1),
          display_name: z.string().min(1).optional(),
          connection_type: z.enum(['acp', 'pty']),
          provenance: z.string().min(1).optional(),
          probed_at: z.string().min(1).optional(),
          agent_version: z.string().min(1).optional(),
          source: z.enum(['configured', 'discovered']),
          status: z.enum(['ready', 'stale', 'failed', 'unsupported']),
          reason_code: z.string().min(1).optional(),
          runtime_registered: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export interface DriverDiscoveryStateDocument {
  schema_version: typeof DRIVER_DISCOVERY_SCHEMA_VERSION;
  generated_at: string;
  probe_status: DriverProbeStatus;
  drivers: DriverDiscoveryRecord[];
}

/** 发现结果持久化的失败。`reason` 是稳定业务码，`message` 不含绝对路径与 secret。 */
export class DriverDiscoveryFileError extends Error {
  constructor(
    readonly reason: 'write_failed' | 'read_failed' | 'lock_busy',
    readonly reason_code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DriverDiscoveryFileError';
  }
}

export interface DriverDiscoveryFileStoreOptions {
  /** 项目根：决定 `<projectRoot>/.agent/drivers.detected.local.yaml`。 */
  projectRoot: string;
  /** state root：决定 `<stateRoot>/driver-discovery.json`。 */
  stateRoot: string;
  /** 等锁参数；测试用它把等待压到毫秒级。 */
  lock?: { timeoutMs?: number; retryMs?: number; staleMs?: number };
}

/** 只保留**文件名**：错误要能被前端安全展示，不能带绝对路径。 */
function baseName(filePath: string): string {
  return path.basename(filePath);
}

export function detectedDriverProfilesPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.agent', DETECTED_DRIVER_PROFILES_FILE_NAME);
}

export function driverDiscoveryStatePath(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), DRIVER_DISCOVERY_STATE_FILE_NAME);
}

/** 写盘文本：一段说明注释 + 规范化 YAML。排序使文件 diff 稳定。 */
export function serializeDetectedDriverProfiles(doc: DetectedDriverProfilesDocument): string {
  const header = [
    '# 本文件由 NewIDE 后端在 driver 探测后自动生成，请勿手工编辑。',
    '# 它只记录「探测到的 agent」，可随时被下一轮探测重建。',
    '# 要固定某个 driver 的启动方式、凭据或能力声明，请写 drivers.yaml / drivers.local.yaml。',
    '',
  ].join('\n');
  const drivers: Record<string, DriverProfile> = {};
  for (const driverId of Object.keys(doc.drivers).sort(compareCodeUnits)) {
    const profile = doc.drivers[driverId];
    if (profile) drivers[driverId] = profile;
  }
  return `${header}${stringifyYaml({ version: doc.version, drivers }, { lineWidth: 0 })}`;
}

/** 解析自动发现 profile 文件；结构非法时抛 {@link DriverDiscoveryFileError}。 */
export function parseDetectedDriverProfiles(
  content: string,
  filePath: string,
): DetectedDriverProfilesDocument {
  const name = baseName(filePath);
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch {
    throw readFailed(`Auto-discovered driver profile file is not valid YAML: ${name}`);
  }
  const parsed = detectedDriverProfilesSchema.safeParse(raw);
  if (!parsed.success) {
    // 只报「哪个文件的哪个字段」，不回显内容——文件里可能有用户手抄进去的东西。
    const field = parsed.error.issues[0]?.path.join('.') || '<root>';
    throw readFailed(`Auto-discovered driver profile file has an unexpected shape: ${name} (${field})`);
  }
  return {
    version: parsed.data.version ?? DETECTED_DRIVER_PROFILES_VERSION,
    drivers: { ...parsed.data.drivers },
  };
}

/** 解析发现状态文件；结构非法时抛 {@link DriverDiscoveryFileError}。 */
export function parseDriverDiscoveryState(
  content: string,
  filePath: string,
): DriverDiscoveryStateDocument {
  const name = baseName(filePath);
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw readFailed(`Driver discovery state is not valid JSON: ${name}`);
  }
  const parsed = driverDiscoveryStateDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') || '<root>';
    throw readFailed(`Driver discovery state has an unexpected shape: ${name} (${field})`);
  }
  return parsed.data as DriverDiscoveryStateDocument;
}

function readFailed(message: string): DriverDiscoveryFileError {
  return new DriverDiscoveryFileError('read_failed', 'DRIVER_DISCOVERY_STATE_UNREADABLE', message);
}

/**
 * 自动发现 profile 与发现状态的读写口。
 *
 * 生产用 `readProfilesSafely` / `readStateSafely` 读（损坏即退化），`writeAll` 一次落两个文件
 * （先 profile 再 state，中途失败时至少 profile 已可用）。
 */
export class DriverDiscoveryFileStore {
  readonly profilesPath: string;
  readonly statePath: string;
  readonly lockPath: string;
  private readonly lock: AgentDirFileLock;
  private readonly lockOptions: { timeoutMs?: number; retryMs?: number; staleMs?: number };

  constructor(options: DriverDiscoveryFileStoreOptions) {
    this.profilesPath = detectedDriverProfilesPath(options.projectRoot);
    this.statePath = driverDiscoveryStatePath(options.stateRoot);
    this.lockPath = agentDirLockPath(this.profilesPath);
    this.lock = new AgentDirFileLock(this.lockPath);
    this.lockOptions = options.lock ?? {};
  }

  /** 跨进程写锁；拿不到时抛 `lock_busy`（可重试），由调用方映射成稳定 RPC 错误。 */
  async acquireLock(): Promise<{ release(): void }> {
    try {
      return await this.lock.acquire(this.lockOptions);
    } catch (error) {
      const summary = error instanceof AgentDirLockError ? 'timed out' : describeError(error);
      throw new DriverDiscoveryFileError(
        'lock_busy',
        DRIVER_DISCOVERY_LOCK_BUSY,
        `Driver discovery file is being written by another writer (${summary})`,
      );
    }
  }

  /** profile 文件是否存在。 */
  exists(): boolean {
    return existsSync(this.profilesPath);
  }

  /**
   * 读自动发现 profile。文件不存在 → 空结果；损坏 → 空结果 + `error`（不抛）。
   *
   * 「损坏即退化」是刻意的：自动 profile 是**可重建**的，为一份坏文件让后端起不来不划算。
   */
  readProfilesSafely(): { profiles: DetectedDriverProfilesDocument; error?: string } {
    const empty: DetectedDriverProfilesDocument = {
      version: DETECTED_DRIVER_PROFILES_VERSION,
      drivers: {},
    };
    if (!existsSync(this.profilesPath)) return { profiles: empty };
    try {
      return { profiles: parseDetectedDriverProfiles(this.readText(this.profilesPath), this.profilesPath) };
    } catch (error) {
      return {
        profiles: empty,
        error: error instanceof Error ? error.message : describeError(error),
      };
    }
  }

  /** 读发现状态。文件不存在 → undefined；损坏 → undefined + `error`（不抛）。 */
  readStateSafely(): { state?: DriverDiscoveryStateDocument; error?: string } {
    if (!existsSync(this.statePath)) return {};
    try {
      return { state: parseDriverDiscoveryState(this.readText(this.statePath), this.statePath) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : describeError(error) };
    }
  }

  /** 写自动发现 profile（原子替换）。 */
  writeProfiles(doc: DetectedDriverProfilesDocument): void {
    this.writeText(this.profilesPath, serializeDetectedDriverProfiles(doc));
  }

  /** 写发现状态（原子替换）。 */
  writeState(state: DriverDiscoveryStateDocument): void {
    this.writeText(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  /** 删除自动发现 profile 文件；不存在时是空操作。 */
  removeProfiles(): void {
    try {
      rmSync(this.profilesPath, { force: true });
    } catch (cause) {
      throw new DriverDiscoveryFileError(
        'write_failed',
        'DRIVER_DISCOVERY_PERSIST_FAILED',
        `Failed to remove auto-discovered driver profiles (${describeError(cause)})`,
      );
    }
  }

  private readText(filePath: string): string {
    try {
      return readFileSync(filePath, 'utf-8');
    } catch (cause) {
      throw new DriverDiscoveryFileError(
        'read_failed',
        'DRIVER_DISCOVERY_STATE_UNREADABLE',
        `Failed to read ${baseName(filePath)} (${describeError(cause)})`,
      );
    }
  }

  private writeText(filePath: string, content: string): void {
    try {
      writeFileAtomic(filePath, content);
    } catch (cause) {
      throw new DriverDiscoveryFileError(
        'write_failed',
        'DRIVER_DISCOVERY_PERSIST_FAILED',
        `Failed to stage ${baseName(filePath)} (${describeError(cause)})`,
      );
    }
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
