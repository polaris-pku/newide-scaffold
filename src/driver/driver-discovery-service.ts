/**
 * Driver 自动发现的编排（driver 自动发现 / 服务层）。
 *
 * 职责与核心逻辑：
 * - 把「探测 → 合并进 catalog → 落盘自动 profile 与 state → 注册 runtime」这四步收敛成一次
 *   刷新，并保证**顺序与互斥**：catalog 的合并是整体替换，落盘与注册都必须在合并之后，
 *   否则会写出「profile 里有、runtime 里没有」的半状态；
 * - **一次刷新只探测一轮**：并发 `refresh` 共用同一个在飞 promise。前端连点两次刷新不该让
 *   ACP 起两批探测子进程，更不该出现「后到的那轮用更旧的探测结果覆盖」；
 * - **失败分流**（§10 / §9.2）：
 *   - 启动时探测失败不阻塞后端：记原因码、保留历史 driver（降级为 stale）、照常落盘；
 *   - `refresh` 是显式调用，探测失败要**抛回**给 RPC 映射成 `DRIVER_PROBE_*`，但 catalog 里的
 *     旧记录仍然保留（`markProbeFailure` 只改结论，不删记录）；
 *   - runtime 注册失败不影响整轮成功：那只是某个 driver 不可选择，写进记录即可；
 * - **落盘失败是显式错误**：自动 profile 写不进去意味着「重启后这个 driver 会消失」，不能
 *   静默吞掉——抛稳定的 {@link DriverDiscoveryFileError}，由 RPC 转成不含路径的错误码；
 * - **registry 是后注入的**：生产里 registry 必须先读到「含自动 profile 的配置」才建得起来，
 *   而那一步又在第一次探测与落盘之后。所以服务先能探测、能落盘，注册在 registry 就绪后接上。
 */
import {
  createDriverDiscoveryCatalog,
  DRIVER_CONNECTION_TYPE_UNSUPPORTED,
  DRIVER_DISCOVERY_PROBE_FAILED,
  DRIVER_DISCOVERY_PROBE_UNAVAILABLE,
  type DriverDiscoveryCatalog,
  type DriverDiscoverySnapshot,
} from './driver-discovery-catalog';
import {
  DETECTED_DRIVER_PROFILES_VERSION,
  DriverDiscoveryFileStore,
  type DriverDiscoveryStateDocument,
} from './driver-discovery-file-store';
import {
  DriverProbeUnavailableError,
  type DriverProbeOptions,
  type DriverProbeService,
} from './driver-probe-service';
import type { DriverRegistry } from './driver-registry';
import type { DriverProfile } from './profile';

/** 本轮刷新里 registry 需要提供的面：只够注册与回报结果，不给它查询/关闭别的路径。 */
export type DriverDiscoveryRegistryPort = Pick<
  DriverRegistry,
  'registerDiscovered' | 'hasRuntime' | 'failureOf'
>;

export interface DriverDiscoveryServiceOptions {
  /** 项目根：决定 `<projectRoot>/.agent/drivers.detected.local.yaml`。 */
  projectRoot: string;
  /** state root：决定 `<stateRoot>/driver-discovery.json`。 */
  stateRoot: string;
  /** ACP 探测服务；探测不可用时整个发现过程降级，但不阻塞启动。 */
  probe: DriverProbeService;
  /** 已配置档案的只读投影（用于「配置身份优先」的合并判定）。 */
  configuredProfiles: () => readonly { driver_id: string; agent: string }[];
  /** 发现事实的唯一出口。 */
  catalog: DriverDiscoveryCatalog;
  /** 自动 profile 与 state 的落点。 */
  store: DriverDiscoveryFileStore;
  /** 诊断出口；缺省写 stderr。 */
  onWarning?: (message: string) => void;
}

export interface DriverDiscoveryService {
  /** 启动时序里的那一次探测（非 force）；失败只降级，不抛。 */
  startup(): Promise<DriverDiscoverySnapshot>;
  /**
   * 显式刷新（`driver.refresh`）。
   *
   * 探测与落盘失败会抛（由 RPC 映射成稳定错误码），runtime 注册失败不会。
   */
  refresh(options?: DriverProbeOptions): Promise<DriverDiscoverySnapshot>;
  snapshot(): DriverDiscoverySnapshot;
  catalog(): DriverDiscoveryCatalog;
  /**
   * 把当前自动发现 profile 注册进已接入的 registry（幂等）。
   *
   * 装配时必须单独调一次：registry 只能在「自动 profile 已落盘」之后才建得起来，而
   * `startup()` 发生在它之前。重复调用不会多造 runtime（registry 的注册本身幂等）。
   */
  syncRuntimes(): void;
  /** 自动发现 profile（最小档案）；组装点据此决定哪些 driver 走动态注册。 */
  discoveredProfiles(): Record<string, DriverProfile>;
}

/** 服务 + registry 的接入口：只有组装点用得到。 */
export interface DriverDiscoveryHostService extends DriverDiscoveryService {
  attachRegistry(registry: DriverDiscoveryRegistryPort): void;
}

export interface DriverDiscoveryRuntimeOptions {
  projectRoot: string;
  stateRoot: string;
  probe: DriverProbeService;
  configuredProfiles: () => readonly { driver_id: string; agent: string }[];
  /** 等锁参数；测试用它把等待压到毫秒级。 */
  lock?: { timeoutMs?: number; retryMs?: number; staleMs?: number };
  /** 注入时钟（测试用）。 */
  now?: () => Date;
  /** 诊断出口；缺省写 stderr。 */
  onWarning?: (message: string) => void;
}

export interface DriverDiscoveryRuntime {
  service: DriverDiscoveryHostService;
  store: DriverDiscoveryFileStore;
}

/**
 * 建好发现服务，并把历史记录读进 catalog。
 *
 * 历史读取是**同步且容错**的：profile 或 state 文件坏了都只是「没有历史发现结果」，原因写进
 * 诊断出口——一份可重建的缓存文件不该拦住后端启动。
 */
export function createDriverDiscoveryRuntime(
  options: DriverDiscoveryRuntimeOptions,
): DriverDiscoveryRuntime {
  const store = new DriverDiscoveryFileStore({
    projectRoot: options.projectRoot,
    stateRoot: options.stateRoot,
    ...(options.lock ? { lock: options.lock } : {}),
  });
  const warn = options.onWarning ?? warnToStderr;

  const stateRead = store.readStateSafely();
  if (stateRead.error) {
    warn(`[driver-discovery] ignoring previous discovery state: ${stateRead.error}`);
  }
  const profilesRead = store.readProfilesSafely();
  if (profilesRead.error) {
    warn(`[driver-discovery] ignoring auto-discovered driver profiles: ${profilesRead.error}`);
  }

  const catalog = createDriverDiscoveryCatalog({
    configuredProfiles: options.configuredProfiles,
    ...(options.now ? { now: options.now } : {}),
    ...(stateRead.state
      ? {
          initialRecords: stateRead.state.drivers,
          initialProbeStatus: stateRead.state.probe_status,
        }
      : {}),
  });

  const service = createDriverDiscoveryService({
    projectRoot: options.projectRoot,
    stateRoot: options.stateRoot,
    probe: options.probe,
    configuredProfiles: options.configuredProfiles,
    catalog,
    store,
    onWarning: warn,
  });

  return { service, store };
}

export function createDriverDiscoveryService(
  options: DriverDiscoveryServiceOptions,
): DriverDiscoveryHostService {
  const warn = options.onWarning ?? warnToStderr;
  let registry: DriverDiscoveryRegistryPort | undefined;
  /** 在飞的那一轮；并发刷新共用它（一次刷新只探测一轮）。 */
  let inFlight: Promise<DriverDiscoverySnapshot> | undefined;

  /** 把 catalog 的发现事实写进 profile 文件与 state 文件。 */
  async function persist(snapshot: DriverDiscoverySnapshot): Promise<void> {
    const lock = await options.store.acquireLock();
    try {
      const profiles = options.catalog.discoveredProfiles();
      // 一个自动 profile 都没有、文件也不存在时就不建这个文件：`.agent` 目录是用户可见的，
      // 「什么都没发现」不该在别人的检出里留下一个空文件。
      if (Object.keys(profiles).length > 0 || options.store.exists()) {
        options.store.writeProfiles({
          version: DETECTED_DRIVER_PROFILES_VERSION,
          drivers: profiles,
        });
      }
      const state: DriverDiscoveryStateDocument = {
        schema_version: snapshot.schema_version,
        generated_at: snapshot.generated_at,
        probe_status: snapshot.probe_status,
        drivers: snapshot.drivers,
      };
      options.store.writeState(state);
    } finally {
      lock.release();
    }
  }

  /** 把自动发现 profile 逐一注册进 registry，并把执行事实回报给 catalog。 */
  function registerRuntimes(): void {
    if (!registry) return;
    for (const [driverId, profile] of Object.entries(options.catalog.discoveredProfiles())) {
      const record = options.catalog.recordOf(driverId);
      // 连接类型不支持就不必尝试：registry 会以同一个原因码拒绝，这里先一步省掉装配尝试。
      if (record?.status === 'unsupported') {
        options.catalog.recordRuntimeFailure(driverId, DRIVER_CONNECTION_TYPE_UNSUPPORTED);
        continue;
      }
      const result = registry.registerDiscovered(driverId, profile, {
        ...(record ? { connection_type: record.connection_type } : {}),
      });
      if (result.ok) options.catalog.recordRuntimeRegistered(driverId);
      else options.catalog.recordRuntimeFailure(driverId, result.reason_code);
    }
    // 配置 driver 的 runtime 由 registry 自己装配，这里只把那一格事实**记真**：state 里的
    // `runtime_registered` 若对手工 driver 恒为 false，就是一条与进程现状相反的记录。
    for (const { driver_id: driverId } of options.configuredProfiles()) {
      if (options.catalog.recordOf(driverId)?.source !== 'configured') continue;
      if (registry.hasRuntime(driverId)) options.catalog.recordRuntimeRegistered(driverId);
    }
  }

  async function run(round: {
    probe?: DriverProbeOptions;
    throwOnProbeFailure: boolean;
    throwOnPersistFailure: boolean;
  }): Promise<DriverDiscoverySnapshot> {
    let probeError: unknown;
    try {
      const result = await options.probe.probe(round.probe);
      await options.catalog.mergeProbe(result);
    } catch (error) {
      probeError = error;
      const reasonCode =
        error instanceof DriverProbeUnavailableError
          ? DRIVER_DISCOVERY_PROBE_UNAVAILABLE
          : DRIVER_DISCOVERY_PROBE_FAILED;
      // 只改结论，不删记录：历史 driver 仍在，只是不可选择。
      options.catalog.markProbeFailure(reasonCode);
      warn(
        `[driver-discovery] ACP driver probe failed (${reasonCode}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    registerRuntimes();
    const snapshot = options.catalog.current();

    try {
      await persist(snapshot);
    } catch (error) {
      if (round.throwOnPersistFailure) throw error;
      warn(
        `[driver-discovery] failed to persist discovery results: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (probeError !== undefined && round.throwOnProbeFailure) throw probeError;
    return snapshot;
  }

  return {
    startup: () => run({ throwOnProbeFailure: false, throwOnPersistFailure: false }),

    refresh: (probeOptions?: DriverProbeOptions) => {
      if (inFlight) return inFlight;
      const pending = run({
        ...(probeOptions ? { probe: probeOptions } : {}),
        throwOnProbeFailure: true,
        throwOnPersistFailure: true,
      }).finally(() => {
        inFlight = undefined;
      });
      inFlight = pending;
      return pending;
    },

    snapshot: () => options.catalog.current(),
    catalog: () => options.catalog,
    syncRuntimes: registerRuntimes,
    discoveredProfiles: () => options.catalog.discoveredProfiles(),
    attachRegistry: (next: DriverDiscoveryRegistryPort) => {
      registry = next;
    },
  };
}

function warnToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}
