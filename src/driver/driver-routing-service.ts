/**
 * Role → Driver 路由领域服务（Role → Driver 配置接口）。
 *
 * 职责与核心逻辑：
 * - 把「读配置、算有效映射、算 revision、热更新、Run 快照」收敛到一处，RPC 层只做参数
 *   校验与错误映射，不碰文件；
 * - **Phase 1 只允许改 mapping**：`updateRouting` / `resetRouting` 不重建 profile、不重建
 *   runtime，只替换内存里的有效配置。因此 driver 句柄表在进程生命周期内稳定，运行中的
 *   Run 不可能因为一次保存而换掉底层进程装配；
 * - **Run 隔离**：Run 创建时 `freezeForRun(runId)` 复制一份当前投影，此后该 Run 的所有
 *   解析（task-loop、legacy run、Council 各席位、mailbox 投递）都走这一份。解析链固定为
 *   `Run snapshot → role mapping → default driver → runtime handle`，不会出现第一个席位用旧
 *   映射、第二个席位用新映射。冻结只发生一次，且**首次冻结前先与磁盘对齐**：多实例部署下本
 *   进程的 `currentConfig` 可能落后于磁盘，直接用就会把过期映射冻结进新 Run；
 * - **并发**：单进程内一个 update mutex 串行化写操作；跨进程靠 `.agent` 下的独占写锁
 *   （`mkdir` 原子创建）加 `expected_revision` 比较。**加锁后必须重新从磁盘 load 有效配置**，
 *   再比对 revision——只比内存里的 `currentConfig` 挡不住另一个 backend 实例：两个进程都
 *   持有 R1 时，后者会用过期 revision 覆盖前者的 R2；
 * - **部署锁定**：`NEWIDE_DRIVER` 是部署级锁定的 default driver。请求想改成别的 driver 一律
 *   在写文件前拒绝（`default_driver_locked`），因为写了也不会生效——loader 的 env 覆盖层
 *   永远赢。成功返回的 snapshot 一定来自「写完文件后重新 load 的」有效配置；
 * - 更新失败不改变内存配置、不影响在飞 Run。
 */
import path from 'node:path';

import type { DriverRuntimeHandle } from './contract';
import {
  projectDriverConfigForRun,
  resolveRoleDriver,
  type DriverConfig,
  type DriverConfigLayer,
  type DriverProfile,
  type PersistedDriverConfig,
} from './profile';
import {
  DriverRoutingFileStore,
  DriverRoutingFileError,
  DriverRoutingLockError,
  computeUiRoutingRevision,
  effectiveUiRoutingDocument,
  normalizeUiDriverRoutingDocument,
  type DriverRoutingLockOptions,
} from './driver-routing-file-store';
import { loadDriverConfig } from './profile-loader';
import {
  DRIVER_ROUTING_SCHEMA_VERSION,
  driverRoutingSnapshotSchema,
  type DriverRoutingDriver,
  type DriverRoutingRole,
  type DriverRoutingSnapshot,
  type UpdateDriverRoutingInput,
} from '../protocol/driver-routing';

/**
 * 本仓只能确认「档案已配置、runner 入口存在、凭据键齐备」，**无法确认 A 侧 agent CLI 是否
 * 安装**（启动命令来自 A 侧 `${AGENT_ID}_CLI_COMMAND` 或 adapter 默认值）。所以每个 driver
 * 的状态诚实降级为 `degraded` 并带上这个原因码，而不是写成可用。
 */
export const AGENT_CLI_READINESS_NOT_VERIFIABLE = 'AGENT_CLI_READINESS_NOT_VERIFIABLE';

/** 配置里有这个 driver 档案，但进程内没有它的 runtime 句柄（理论不可达，仍如实标注）。 */
export const DRIVER_RUNTIME_NOT_CONFIGURED = 'DRIVER_RUNTIME_NOT_CONFIGURED';

/** 一个 driver 的可选择性投影；测试可注入以构造「不可选择」场景。 */
export interface DriverRoutingDriverAvailability {
  selectable: boolean;
  status: 'configured' | 'degraded' | 'unavailable';
  reason_code?: string;
  limitations?: string[];
}

export type DriverRoutingErrorCode =
  | 'revision_mismatch'
  | 'driver_not_found'
  | 'driver_not_selectable'
  | 'default_driver_locked'
  | 'config_busy'
  | 'write_failed';

/** JSON-RPC 错误 data 的结构化内容；绝不承载 secret。 */
export interface DriverRoutingErrorData {
  reason: DriverRoutingErrorCode;
  current_revision?: string;
  field?: string;
  driver_id?: string;
  /** `default_driver_locked` 时被 `NEWIDE_DRIVER` 锁定的 driver id。 */
  locked_driver_id?: string;
  reason_code?: string;
  limitations?: string[];
  /** 写入/加锁失败的路径类别（不含绝对路径细节）。 */
  path_category?: string;
  /** 系统错误摘要（只含错误码或我们自己的文案）。 */
  error_summary?: string;
}

export class DriverRoutingError extends Error {
  readonly data: DriverRoutingErrorData;

  constructor(
    readonly code: DriverRoutingErrorCode,
    message: string,
    data: DriverRoutingErrorData,
  ) {
    super(message);
    this.name = 'DriverRoutingError';
    this.data = data;
  }
}

/**
 * 服务真正需要的 runtime 句柄表；`DriverRegistry` 结构上满足它。
 *
 * 刻意只留两个方法：service 不需要 shutdown / 静态 resolveForRole——mapping 由它自己按
 * 「快照优先」解析，避免 registry 内部那份启动期静态配置成为第二真相源。
 */
export interface DriverRuntimeRegistry {
  listDriverIds(): string[];
  get(driverId: string): DriverRuntimeHandle;
}

export interface DriverRoutingServiceOptions {
  /** 项目根：决定 `<projectRoot>/.agent/drivers.ui.local.yaml`。 */
  projectRoot: string;
  /** runtime 句柄表。Phase 1 不在更新时重建。 */
  registry: DriverRuntimeRegistry;
  /** 环境变量；默认 `process.env`（`NEWIDE_DRIVER` / `ACP_AGENT_ID` 覆盖仍生效）。 */
  env?: NodeJS.ProcessEnv;
  /** 家目录；默认 `os.homedir()`。测试注入以避开真实 HOME。 */
  homeDir?: string;
  /**
   * 「当前 B 侧可协作 role」提供者（active、非 retired、非 council_only）。
   *
   * 后端不维护静态 role 白名单；缺省时目录视为查不到，所有显式 role 都落 orphan_roles。
   */
  knownRoleIds?: () => Promise<readonly string[]>;
  /** 覆盖默认的可选择性投影（测试缝）。 */
  availabilityOf?: (driverId: string, profile: DriverProfile) => DriverRoutingDriverAvailability;
  /**
   * 跨进程写锁的等待参数；缺省 5s 超时 / 25ms 重试 / 30s stale。
   *
   * 测试用它把等待压到毫秒级，避免一条「等锁超时」用例真的挂 5 秒。
   */
  lock?: DriverRoutingLockOptions;
}

/** 只暴露 Run 冻结所需的端口，供 `NewideBackendService` 注入。 */
export interface RunDriverRoutingPort {
  freezeForRun(runId: string): PersistedDriverConfig;
}

/**
 * 对外的 driver routing 端口。
 *
 * `NewideBackendService` 只用 `freezeForRun`；RPC 组装点还需要读写三项。做成接口而不是
 * 直接依赖 `DriverRoutingService` 类，是为了让测试可以只桩出用到的方法。
 */
export interface DriverRoutingPort extends RunDriverRoutingPort {
  getSnapshot(): Promise<DriverRoutingSnapshot>;
  updateRouting(input: UpdateDriverRoutingInput): Promise<DriverRoutingSnapshot>;
  resetRouting(expectedRevision: string): Promise<DriverRoutingSnapshot>;
}

export class DriverRoutingService implements DriverRoutingPort {
  private readonly projectRoot: string;
  private readonly registry: DriverRuntimeRegistry;
  private readonly fileStore: DriverRoutingFileStore;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly homeDir: string | undefined;
  private readonly knownRoleIds: (() => Promise<readonly string[]>) | undefined;
  private readonly availabilityOf: (
    driverId: string,
    profile: DriverProfile,
  ) => DriverRoutingDriverAvailability;
  private readonly lockOptions: DriverRoutingLockOptions;
  /** 当前有效配置（含 UI 覆盖层）；每次成功写入或 reset 后整体替换。 */
  private currentConfig: DriverConfig;
  /** Run 创建时冻结的 routing 投影；一个 run_id 一条，进程内不可变。 */
  private readonly runSnapshots = new Map<string, PersistedDriverConfig>();
  /** 单进程内的写操作串行化。 */
  private updateChain: Promise<unknown> = Promise.resolve();

  constructor(options: DriverRoutingServiceOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.registry = options.registry;
    this.fileStore = new DriverRoutingFileStore(this.projectRoot);
    this.env = options.env;
    this.homeDir = options.homeDir;
    this.knownRoleIds = options.knownRoleIds;
    this.availabilityOf = options.availabilityOf ?? defaultDriverAvailability;
    this.lockOptions = options.lock ?? {};
    this.currentConfig = this.loadConfig();
  }

  /** 完整查询快照（`driver.getConfig`）。 */
  async getSnapshot(): Promise<DriverRoutingSnapshot> {
    // 多实例部署下，另一个 backend 可能刚写过：先与磁盘对齐。否则本实例会永远返回过期
    // revision，前端的每一次保存都必然撞 conflict（唯一的补救是冲突错误里的 current_revision）。
    this.refreshConfigFromDisk();
    // 固定一份配置引用：role 目录查询是异步的，不能让它 await 到一半时被一次 update 换掉
    // 底层配置，否则会返回「旧 role 列表 + 新 revision」的混合体。
    const config = this.currentConfig;
    const { roles, orphan_roles } = await this.projectRoles(config);
    const snapshot: DriverRoutingSnapshot = {
      schema_version: DRIVER_ROUTING_SCHEMA_VERSION,
      revision: revisionOf(config),
      scope: 'project',
      default_driver: config.default_driver,
      drivers: Object.keys(config.drivers)
        .sort(compareCodeUnits)
        .map((driverId) => this.projectDriver(config, driverId)),
      roles,
      orphan_roles,
    };
    // 出口再走一次 strict schema：任何多余的敏感字段都不可能从这里漏出去。
    return driverRoutingSnapshotSchema.parse(snapshot);
  }

  /** 当前 revision；下一次 update/reset 的 `expected_revision` 必须等于它。 */
  currentRevision(): string {
    return revisionOf(this.currentConfig);
  }

  /**
   * 把 `currentConfig` 投影成可冻结进 Run 的形式。
   *
   * 这是**纯内存投影，不读盘**，所以不对外暴露：脱离磁盘对齐地使用它会拿到一份可能落后的
   * 投影，而「冻结进 Run 的 mapping 与实际生效的 mapping 不一致」是个不会报错的静默故障。
   * 磁盘对齐的唯一入口是 {@link freezeForRun}。
   */
  private snapshotForRun(): PersistedDriverConfig {
    return projectDriverConfigForRun(this.currentConfig);
  }

  /**
   * 冻结一个 Run 的 routing 投影。
   *
   * 同一 run_id 只冻结一次：就算之后配置又变了，这个 Run 后续的所有解析仍拿到同一份。
   *
   * 首次冻结前**必须先与磁盘对齐**：多个 backend 共享同一个 projectRoot 时，另一个实例可能
   * 刚写过配置，而本进程的 `currentConfig` 停在构造时读到的那一份。不刷新就会把过期 mapping
   * 冻结进新 Run，该 Run 全程用错 driver，而且没有任何错误会浮到前端。已冻结的 run_id 直接
   * 返回原快照——那一份已经代表创建瞬间的有效配置，不该被后来的变化重写。
   */
  freezeForRun(runId: string): PersistedDriverConfig {
    const existing = this.runSnapshots.get(runId);
    if (existing) return existing;

    this.refreshConfigFromDisk();

    const snapshot = this.snapshotForRun();
    this.runSnapshots.set(runId, snapshot);
    return snapshot;
  }

  /** 某个 Run 冻结的 routing 投影；未冻结（老 Run / 本进程外创建）返回 undefined。 */
  snapshotOfRun(runId: string): PersistedDriverConfig | undefined {
    return this.runSnapshots.get(runId);
  }

  /**
   * 解析 role 到 runtime handle。
   *
   * `runSnapshot` 给出时**只用它**，绝不回读全局当前配置——这就是「旧 Run 不被污染」。
   */
  resolveForRole(
    roleId: string,
    runSnapshot?: PersistedDriverConfig,
  ): { driver_id: string; profile: DriverProfile; handle: DriverRuntimeHandle } {
    const config = runSnapshot ? configFromRunSnapshot(runSnapshot) : this.currentConfig;
    const resolved = resolveRoleDriver(config, roleId);
    return { ...resolved, handle: this.registry.get(resolved.driver_id) };
  }

  /** 按 Run 与 role 解析：优先用该 Run 冻结的投影。 */
  resolveForRunRole(
    runId: string | undefined,
    roleId: string,
  ): { driver_id: string; profile: DriverProfile; handle: DriverRuntimeHandle } {
    const snapshot = runId ? this.runSnapshots.get(runId) : undefined;
    return this.resolveForRole(roleId, snapshot);
  }

  /**
   * 原子更新整个 routing mapping（`driver.updateRouting`）。
   *
   * 临界区（进程内 mutex + 跨进程文件锁）内顺序：
   * 1. **重新从磁盘 load** 有效配置——另一个 backend 实例可能刚写过，内存里的 revision 不作数；
   * 2. 以磁盘 revision 比对 `expected_revision`（CAS：不一致就 conflict，绝不覆盖）；
   * 3. 校验 `NEWIDE_DRIVER` 部署锁定、引用存在、可选择性；
   * 4. 规范化 → **不落盘预校验** → 原子写入 → 重新 load → 替换内存；
   * 5. `finally` 释放锁。
   *
   * 任何一步失败都不写文件、不用被拒的请求改内存（内存只被刷新成磁盘真相）。
   */
  async updateRouting(input: UpdateDriverRoutingInput): Promise<DriverRoutingSnapshot> {
    return this.withUpdateLock(async () => {
      await this.withFileLock(() => {
        // 第 1 步：以磁盘为准。顺带把内存里可能已经过期的配置刷新成磁盘真相。
        const diskConfig = this.loadConfigSafely();
        this.currentConfig = diskConfig;

        // 第 2 步：CAS。用磁盘 revision，而不是内存 revision。
        this.assertRevision(input.expected_revision, diskConfig);

        // 第 3 步：部署锁定——写了也不生效，所以必须在写文件前拒绝。
        const defaultDriver = input.default_driver;
        const lockedDriver = this.lockedDefaultDriver();
        if (lockedDriver !== undefined && defaultDriver !== lockedDriver) {
          throw defaultDriverLocked(lockedDriver, defaultDriver);
        }

        const defaultProfile = diskConfig.drivers[defaultDriver];
        if (!defaultProfile) {
          throw driverNotFound('default_driver', defaultDriver);
        }
        this.assertSelectable('default_driver', defaultDriver, defaultProfile);

        for (const [roleId, driverId] of Object.entries(input.roles)) {
          const profile = diskConfig.drivers[driverId];
          if (!profile) {
            throw driverNotFound(`roles.${roleId}`, driverId);
          }
          this.assertSelectable(`roles.${roleId}`, driverId, profile);
        }

        const document = normalizeUiDriverRoutingDocument({
          default_driver: defaultDriver,
          roles: input.roles,
        });
        const layer: DriverConfigLayer = {
          version: document.version,
          default_driver: document.default_driver,
          roles: { ...document.roles },
        };
        // 第 4 步：落盘前先按「新层生效」合成一次。引用悬空在这里就被挡下，旧文件天然完整。
        // 显式校验已经覆盖了文档列出的每一种用户错误，这条只是兜底——真触发时也只报写入
        // 失败，不让一个裸的内部错误穿过 RPC 边界。
        this.loadConfigSafely({ [this.fileStore.filePath]: layer });

        const previousRaw = this.fileStore.readRaw();
        try {
          this.fileStore.writeAtomic(document);
        } catch (error) {
          throw this.writeFailed(error);
        }
        try {
          this.currentConfig = this.loadConfig();
        } catch (error) {
          this.restorePrevious(previousRaw);
          throw this.writeFailed(error);
        }
      });
      // 第 5 步：快照在锁外构建——`projectRoles` 要查 Agent 目录（生产是 PostgreSQL），
      // 不该占着跨进程写锁。此时 `currentConfig` 已经是第 4 步重新加载后的有效配置。
      return this.getSnapshot();
    });
  }

  /**
   * 删除 UI 覆盖文件，回到下层手工配置（`driver.resetRouting`）。
   *
   * 走同一套临界区与 CAS：reset 也是一个写操作，不能把另一个 backend 实例刚写的配置无声
   * 抹掉。返回的 snapshot 来自删除后重新 load 的有效配置（因此仍反映 `NEWIDE_DRIVER` 覆盖）。
   */
  async resetRouting(expectedRevision: string): Promise<DriverRoutingSnapshot> {
    return this.withUpdateLock(async () => {
      await this.withFileLock(() => {
        const diskConfig = this.loadConfigSafely();
        this.currentConfig = diskConfig;
        this.assertRevision(expectedRevision, diskConfig);

        // 预校验「层被移除后」的配置是否仍然合法。
        this.loadConfigSafely({ [this.fileStore.filePath]: undefined });

        const previousRaw = this.fileStore.readRaw();
        if (previousRaw !== undefined) {
          try {
            this.fileStore.remove();
          } catch (error) {
            throw this.writeFailed(error);
          }
        }
        try {
          this.currentConfig = this.loadConfig();
        } catch (error) {
          this.restorePrevious(previousRaw);
          throw this.writeFailed(error);
        }
      });
      return this.getSnapshot();
    });
  }

  private assertRevision(
    expectedRevision: string,
    config: DriverConfig = this.currentConfig,
  ): void {
    const current = revisionOf(config);
    if (expectedRevision === current) return;
    throw new DriverRoutingError(
      'revision_mismatch',
      'Driver routing revision does not match the current configuration',
      { reason: 'revision_mismatch', current_revision: current },
    );
  }

  private assertSelectable(field: string, driverId: string, profile: DriverProfile): void {
    const availability = this.projectAvailability(driverId, profile);
    const hasRuntime = this.registry.listDriverIds().includes(driverId);
    // 与 `projectDriver` 同一判据：投影说「不可选择」的 driver，update 也必须拒绝，
    // 否则会出现「前端看到不可选、却保存成功、执行时才炸」的分叉。
    if (hasRuntime && availability.selectable) return;
    const reasonCode = hasRuntime
      ? availability.reason_code
      : DRIVER_RUNTIME_NOT_CONFIGURED;
    throw new DriverRoutingError(
      'driver_not_selectable',
      `Driver "${driverId}" is not selectable`,
      {
        reason: 'driver_not_selectable',
        field,
        driver_id: driverId,
        ...(reasonCode ? { reason_code: reasonCode } : {}),
        ...(availability.limitations ? { limitations: [...availability.limitations] } : {}),
      },
    );
  }

  private writeFailed(error: unknown): DriverRoutingError {
    // 只暴露路径类别与系统错误摘要：message 是我们自己写的文案，可能带环境变量名之外的
    // 系统错误码，但不含 secret 值。
    const summary =
      error instanceof DriverRoutingFileError
        ? error.message
        : error instanceof Error
          ? error.name
          : 'unknown error';
    return new DriverRoutingError(
      'write_failed',
      'Failed to persist driver routing configuration',
      { reason: 'write_failed', path_category: 'project_agent_dir', error_summary: summary },
    );
  }

  /** 把文件恢复成写入前的样子（内容或缺失）；恢复失败不再抛，避免掩盖主错误。 */
  private restorePrevious(previousRaw: string | undefined): void {
    try {
      if (previousRaw === undefined) this.fileStore.remove();
      else this.fileStore.writeTextAtomic(previousRaw);
    } catch {
      // 恢复失败时内存配置没有被替换，盘上仍是新内容——下一次 getConfig 会如实反映它。
    }
  }

  /**
   * 加载有效配置。
   *
   * `env` 显式取自 {@link routingEnv}，与 {@link lockedDefaultDriver} 同源：判断「默认 driver
   * 是否被部署锁定」和「实际生效的默认 driver 是什么」绝不能读两份不同的环境。
   */
  private loadConfig(
    overrides?: Readonly<Record<string, DriverConfigLayer | undefined>>,
  ): DriverConfig {
    return loadDriverConfig({
      projectRoot: this.projectRoot,
      env: this.routingEnv(),
      ...(this.homeDir ? { homeDir: this.homeDir } : {}),
      ...(overrides ? { layerOverrides: overrides } : {}),
    });
  }

  /**
   * 读磁盘配置；读不出来（文件被占位成目录、YAML 坏了）时按「无法安全持久化」处理。
   *
   * 这类失败发生在临界区开头，走 `write_failed` 而不是裸的内部错误——调用方拿到的是稳定
   * 业务码，且锁一定会释放。
   */
  private loadConfigSafely(
    overrides?: Readonly<Record<string, DriverConfigLayer | undefined>>,
  ): DriverConfig {
    try {
      return this.loadConfig(overrides);
    } catch (error) {
      throw this.writeFailed(error);
    }
  }

  /**
   * 磁盘 revision 与内存不一致时，把内存换成磁盘那一份。
   *
   * 全程同步（`loadConfig` 是同步的），因此不可能与同进程的一次 update 交错；磁盘又是唯一
   * 真相，所以这个方向的刷新只会让内存变新，不会写回更旧的配置。
   * 读盘失败时保留内存配置：一次查询不该因为别人的文件坏了而失败。
   */
  private refreshConfigFromDisk(): void {
    try {
      const diskConfig = this.loadConfig();
      if (revisionOf(diskConfig) !== revisionOf(this.currentConfig)) {
        this.currentConfig = diskConfig;
      }
    } catch {
      // 磁盘暂时读不出来：沿用内存里的配置，下一次写操作会带着明确错误再报。
    }
  }

  /** loader 真正会读的那份 env；服务缺省 `process.env`，与 loader 的缺省一致。 */
  private routingEnv(): NodeJS.ProcessEnv {
    return this.env ?? process.env;
  }

  /**
   * 部署级锁定的 default driver（`NEWIDE_DRIVER`）。
   *
   * 语义：前端不能改它。更新请求写了别的值一律拒绝，因为 loader 的 env 覆盖层排在 UI 层
   * 之后——文件写得再对，重新加载后的有效值仍是 env 那个。
   */
  private lockedDefaultDriver(): string | undefined {
    const locked = this.routingEnv().NEWIDE_DRIVER?.trim();
    return locked ? locked : undefined;
  }

  /**
   * 跨进程临界区。
   *
   * 先拿 `.agent` 下的独占锁，再执行操作，`finally` 释放。等不到锁时抛 `config_busy`
   * （可重试），而不是 `write_failed`——不是写坏了，是另一个实例正在写。
   */
  private async withFileLock<T>(operation: () => Promise<T> | T): Promise<T> {
    let lock;
    try {
      lock = await this.fileStore.acquireLock(this.lockOptions);
    } catch (error) {
      throw this.configBusy(error);
    }
    try {
      return await operation();
    } finally {
      lock.release();
    }
  }

  private configBusy(error: unknown): DriverRoutingError {
    const summary =
      error instanceof DriverRoutingLockError
        ? error.message
        : error instanceof Error
          ? error.name
          : 'unknown error';
    return new DriverRoutingError(
      'config_busy',
      'Driver routing configuration is being updated by another writer',
      {
        reason: 'config_busy',
        path_category: 'project_agent_dir',
        error_summary: summary,
      },
    );
  }

  private projectDriver(config: DriverConfig, driverId: string): DriverRoutingDriver {
    const profile = config.drivers[driverId];
    if (!profile) {
      throw new DriverRoutingError('driver_not_found', `Unknown driver "${driverId}"`, {
        reason: 'driver_not_found',
        driver_id: driverId,
      });
    }
    const hasRuntime = this.registry.listDriverIds().includes(driverId);
    const availability = this.projectAvailability(driverId, profile);
    const selectable = hasRuntime && availability.selectable;
    const capabilities = {
      driver_id: driverId,
      agent: profile.agent,
      ...(profile.description ? { description: profile.description } : {}),
    };
    if (!hasRuntime) {
      return {
        ...capabilities,
        selectable: false,
        status: 'unavailable',
        reason_code: DRIVER_RUNTIME_NOT_CONFIGURED,
        ...(availability.limitations ? { limitations: [...availability.limitations] } : {}),
      };
    }
    return {
      ...capabilities,
      selectable,
      status: selectable ? availability.status : 'unavailable',
      ...(availability.reason_code ? { reason_code: availability.reason_code } : {}),
      ...(availability.limitations ? { limitations: [...availability.limitations] } : {}),
    };
  }

  private projectAvailability(
    driverId: string,
    profile: DriverProfile,
  ): DriverRoutingDriverAvailability {
    return this.availabilityOf(driverId, profile);
  }

  private async projectRoles(config: DriverConfig): Promise<{
    roles: DriverRoutingRole[];
    orphan_roles: DriverRoutingRole[];
  }> {
    const configured = Object.keys(config.roles ?? {});
    let known: readonly string[] = [];
    if (this.knownRoleIds) {
      try {
        known = await this.knownRoleIds();
      } catch {
        // 目录查询失败不等于「没有 role」：退化成只报显式配置的那些，并使 known_role 为 false。
        known = [];
      }
    }
    const knownSet = new Set(known);
    const all = [...new Set([...known, ...configured])].sort(compareCodeUnits);

    const roles: DriverRoutingRole[] = [];
    const orphanRoles: DriverRoutingRole[] = [];
    for (const roleId of all) {
      const explicit = config.roles?.[roleId];
      const row: DriverRoutingRole = {
        role_id: roleId,
        driver_id: explicit ?? config.default_driver,
        effective_driver_id: explicit ?? config.default_driver,
        source: explicit ? 'role_override' : 'default',
        known_role: knownSet.has(roleId),
      };
      roles.push(row);
      // 显式映射但不在当前目录里的 role 同时进 orphan_roles，保留其原 driver id。
      if (explicit !== undefined && !knownSet.has(roleId)) orphanRoles.push(row);
    }
    return { roles, orphan_roles: orphanRoles };
  }

  private withUpdateLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.updateChain.then(operation, operation);
    this.updateChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** 有效配置 → revision。 */
function revisionOf(config: DriverConfig): string {
  return computeUiRoutingRevision(effectiveUiRoutingDocument(config));
}

/** 默认投影：档案已配置且 runtime 已构造 → 可选择，但 CLI 就绪情况本仓验证不了。 */
function defaultDriverAvailability(
  _driverId: string,
  profile: DriverProfile,
): DriverRoutingDriverAvailability {
  const limitations = profile.limitations ? [...profile.limitations] : undefined;
  return {
    selectable: true,
    status: 'degraded',
    reason_code: AGENT_CLI_READINESS_NOT_VERIFIABLE,
    ...(limitations ? { limitations } : {}),
  };
}

function driverNotFound(field: string, driverId: string): DriverRoutingError {
  return new DriverRoutingError('driver_not_found', `Unknown driver "${driverId}"`, {
    reason: 'driver_not_found',
    field,
    driver_id: driverId,
  });
}

/**
 * `NEWIDE_DRIVER` 锁定了 default driver，而请求想改成别的。
 *
 * `driver_id` 是请求值、`locked_driver_id` 是部署锁定值：前端要能一眼看出「你选了 X，但本
 * 部署锁在 Y」，而不是笼统的「冲突」。
 */
function defaultDriverLocked(
  lockedDriverId: string,
  requestedDriverId: string,
): DriverRoutingError {
  return new DriverRoutingError(
    'default_driver_locked',
    `default_driver is locked to "${lockedDriverId}" by NEWIDE_DRIVER`,
    {
      reason: 'default_driver_locked',
      field: 'default_driver',
      driver_id: requestedDriverId,
      locked_driver_id: lockedDriverId,
    },
  );
}

/**
 * 把冻结的 Run 投影还原成 `resolveRoleDriver` 看得懂的配置形状。
 *
 * 只需要 `default_driver` / `drivers` / `roles`：档案的运行时装配由 registry 承担，
 * 快照里只留审计与回显需要的三个字段（见 `projectDriverConfigForRun`）。
 */
function configFromRunSnapshot(snapshot: PersistedDriverConfig): DriverConfig {
  return {
    default_driver: snapshot.default_driver,
    drivers: Object.fromEntries(
      Object.entries(snapshot.drivers).map(([driverId, agent]) => [driverId, { agent }]),
    ),
    ...(snapshot.roles ? { roles: { ...snapshot.roles } } : {}),
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
