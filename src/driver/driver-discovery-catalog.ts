/**
 * Driver 自动发现目录（driver 自动发现 / 领域层）。
 *
 * 职责与核心逻辑：
 * - 把「**探测事实**」收敛成一处：每个 agent 的 ACP 探测结论、连接类型、探测时间与执行
 *   事实（runtime 是否注册成功）。它是探测、配置、runtime 与 routing 的唯一汇合点——
 *   前端看到的 `driver.getConfig.drivers[]` 与 `system.capabilities` 里每个 driver 的
 *   状态都必须来自这一份投影，不允许各算各的；
 * - **三类事实分权**：配置事实（`drivers.yaml` 里的 profile）永不被探测事实覆盖；探测事实
 *   只回答「本机是否真的能拉起这个 agent」；执行事实（runtime 注册结果）由 registry 回报，
 *   前端不能自行推断。因此合并时**配置 driver_id 恒赢**，探测只作为可用性与展示证据；
 * - **稳定身份**：没有配置 profile 的 agent 由 {@link driverIdForDiscoveredAgent} 生成 id，
 *   只由 agentId 决定。不用数组下标、显示名、启动命令或探测时间——那些都会让同一个 agent
 *   在不同轮次拿到不同 id，进而让 UI routing 的引用悬空；
 * - **历史保留**：本轮没再探测到的 driver 不删除，只降级为 `stale`（保留 profile 与 id），
 *   这样已有 UI routing 不会变成悬空引用；下一轮重新发现即恢复；
 * - **串行化**：`mergeProbe` 整体替换某个 agent 的发现事实，并发 refresh 不能产生「旧 probe
 *   覆盖新 probe」的半状态，所以所有写入都排在同一条 promise 链上。
 *
 * 本模块是纯领域逻辑：不读文件、不 spawn、不碰 registry（那些由 `driver-discovery-service`
 * 编排），因此可以用纯单元测试钉住合并规则。
 */
import { createHash } from 'node:crypto';

import type { DriverProbeResult } from './driver-probe-service';
import type { DriverProfile } from './profile';

/** 发现快照的协议版本。 */
export const DRIVER_DISCOVERY_SCHEMA_VERSION = 'driver-discovery.v1' as const;

/** 自动生成 driver id 的前缀；UI 与日志据此区分「探测到的」与「配到过」的 driver。 */
export const DISCOVERED_DRIVER_ID_PREFIX = 'discovered:';

/** 本轮探测没有再次发现它：保留 profile 与 id，但不可选择。 */
export const DRIVER_DISCOVERY_STALE = 'DRIVER_DISCOVERY_STALE';
/** 探测到了，但连接类型（如 `pty`）不在当前执行链支持范围内。 */
export const DRIVER_CONNECTION_TYPE_UNSUPPORTED = 'DRIVER_CONNECTION_TYPE_UNSUPPORTED';
/** runtime 构造失败（runner 目录/入口/凭据之外的通用失败）。 */
export const DRIVER_RUNTIME_REGISTRATION_FAILED = 'DRIVER_RUNTIME_REGISTRATION_FAILED';
/** runtime 构造失败：档案声明的凭据键缺失。 */
export const DRIVER_REQUIRED_CREDENTIAL_MISSING = 'DRIVER_REQUIRED_CREDENTIAL_MISSING';
/** runtime 构造失败：runner 入口或目录缺失。 */
export const DRIVER_RUNNER_ENTRY_MISSING = 'DRIVER_RUNNER_ENTRY_MISSING';
/** ACP 探针模块不存在（runner 没构建 probe）。 */
export const DRIVER_DISCOVERY_PROBE_UNAVAILABLE = 'DRIVER_DISCOVERY_PROBE_UNAVAILABLE';
/** ACP 探针存在但执行失败。 */
export const DRIVER_DISCOVERY_PROBE_FAILED = 'DRIVER_DISCOVERY_PROBE_FAILED';
/** 自动发现结果落盘失败。 */
export const DRIVER_DISCOVERY_PERSIST_FAILED = 'DRIVER_DISCOVERY_PERSIST_FAILED';
/** 另一个进程正在写自动发现文件。 */
export const DRIVER_DISCOVERY_LOCK_BUSY = 'DRIVER_DISCOVERY_LOCK_BUSY';

/** ACP 探针报出的连接类型。 */
export type DriverConnectionType = 'acp' | 'pty';

/** 一轮探测的整体结论。 */
export type DriverProbeStatus = 'ready' | 'failed' | 'unavailable' | 'stale';

/** 单个 driver 的发现结论。 */
export type DriverDiscoveryStatus = 'ready' | 'stale' | 'failed' | 'unsupported';

/** 一个已配置档案的最小投影：用于「配置身份优先」的合并判定。 */
export interface DriverDiscoveryConfiguredProfile {
  driver_id: string;
  agent: string;
}

/** 一个 driver 的发现记录：探测事实 + 执行事实。 */
export interface DriverDiscoveryRecord {
  driver_id: string;
  /** A 侧 agent 标识（`ACP_AGENT_ID`）。 */
  agent_id: string;
  display_name?: string;
  connection_type: DriverConnectionType;
  provenance?: string;
  probed_at?: string;
  /** A 侧自报的版本（探针 initialize 阶段拿到时才有）。 */
  agent_version?: string;
  /**
   * 这个 id 的来源：`configured` 表示它来自某层配置，`discovered` 表示由 agentId 自动生成。
   *
   * 分开是必要的——只有自动发现的那批才需要写进自动 profile 文件，也才在「本轮未再发现」
   * 时降级为 stale；配置 driver 不该因为一次探测失败而变得不可选。
   */
  source: 'configured' | 'discovered';
  status: DriverDiscoveryStatus;
  reason_code?: string;
  /** 执行事实：该 driver 的 runtime 是否已注册成功。 */
  runtime_registered: boolean;
}

/** 发现快照（可序列化、可落盘、可给前端）。 */
export interface DriverDiscoverySnapshot {
  schema_version: typeof DRIVER_DISCOVERY_SCHEMA_VERSION;
  generated_at: string;
  probe_status: DriverProbeStatus;
  drivers: DriverDiscoveryRecord[];
}

/** 一个 driver 的执行事实。 */
export interface DriverRuntimeDiscoveryStatus {
  registered: boolean;
  reason_code?: string;
}

export interface DriverDiscoveryCatalogOptions {
  /** 已配置档案的只读投影（每次调用时重新取值，配置热更新后立即生效）。 */
  configuredProfiles: () => readonly DriverDiscoveryConfiguredProfile[];
  /**
   * 连接类型在当前执行链是否可执行。
   *
   * 缺省只支持 `acp`——`pty` 需要另一套执行链，探针成功不代表本仓能跑。
   */
  supportsConnectionType?: (type: DriverConnectionType) => boolean;
  /** 注入时钟（测试用）。 */
  now?: () => Date;
  /** 上一轮（含历史持久化）的发现记录，用作 stale 判定与 profile 保留的基线。 */
  initialRecords?: readonly DriverDiscoveryRecord[];
  initialProbeStatus?: DriverProbeStatus;
}

export interface DriverDiscoveryCatalog {
  /** 当前快照（深拷贝，调用方改不坏内部状态）。 */
  current(): DriverDiscoverySnapshot;
  /** 合并一轮探测结果，返回合并后的快照。 */
  mergeProbe(result: DriverProbeResult): Promise<DriverDiscoverySnapshot>;
  /** 探测整体失败：不删除历史记录，只把自动发现的那些降级为 stale。 */
  markProbeFailure(reasonCode: string): DriverDiscoverySnapshot;
  /** 记录一次 runtime 注册失败（执行事实）。 */
  recordRuntimeFailure(driverId: string, reasonCode: string): void;
  /** 记录一次 runtime 注册成功（执行事实）。 */
  recordRuntimeRegistered(driverId: string): void;
  runtimeStatus(driverId: string): DriverRuntimeDiscoveryStatus;
  recordOf(driverId: string): DriverDiscoveryRecord | undefined;
  /** 自动发现的 driver id（含 stale 的）。 */
  discoveredDriverIds(): string[];
  /**
   * 自动发现 profile（最小档案：只有 `agent` 与 `description`）。
   *
   * stale 的也保留——它们是 UI routing 可能引用到的 id，删掉会让引用悬空。探测事实里的
   * 启动命令、参数、环境变量与凭据一律不落进 profile。
   */
  discoveredProfiles(): Record<string, DriverProfile>;
}

/**
 * 由 agentId 推出**稳定**的自动 driver id：`discovered:<规范化 agentId>-<short-hash>`。
 *
 * - 规范化只保留 ASCII 小写字母数字，其余折叠成单个 `-`，首尾分隔符去掉（显示名不会参与，
 *   于是改显示名不影响 id）；
 * - short-hash 取原始 agentId 的 sha256 前 8 位十六进制——规范化会撞名（`Goose CLI` 与
 *   `goose-cli`），哈希后缀保证不同 agentId 仍得到不同 id；
 * - 同一个 agentId 在任何进程、任何轮次都得到同一个 id。
 */
export function driverIdForDiscoveredAgent(agentId: string): string {
  const normalized = normalizeAgentId(agentId);
  const digest = createHash('sha256').update(agentId).digest('hex').slice(0, 8);
  return `${DISCOVERED_DRIVER_ID_PREFIX}${normalized}-${digest}`;
}

export function createDriverDiscoveryCatalog(
  options: DriverDiscoveryCatalogOptions,
): DriverDiscoveryCatalog {
  const now = options.now ?? (() => new Date());
  const supportsConnectionType = options.supportsConnectionType ?? ((type) => type === 'acp');

  let records = new Map<string, DriverDiscoveryRecord>(
    (options.initialRecords ?? []).map((record) => [record.driver_id, cloneRecord(record)]),
  );
  let probeStatus: DriverProbeStatus = options.initialProbeStatus ?? 'stale';
  const runtimeStates = new Map<string, DriverRuntimeDiscoveryStatus>();
  /** 串行化写入：并发 refresh 不允许出现「旧 probe 覆盖新 probe」。 */
  let chain: Promise<unknown> = Promise.resolve();

  function merge(result: DriverProbeResult): DriverDiscoverySnapshot {
    const configuredByAgent = configuredDriverIdsByAgent();
    const seenAgents = new Set<string>();
    const next = new Map<string, DriverDiscoveryRecord>();

    for (const probe of result.drivers) {
      seenAgents.add(probe.agentId);
      const configuredId = configuredByAgent.get(probe.agentId);
      const driverId = configuredId ?? driverIdForDiscoveredAgent(probe.agentId);
      const runtime = runtimeStates.get(driverId);
      const supported = supportsConnectionType(probe.connectionType);
      const agentVersion = probe.initialize?.agentVersion;

      next.set(driverId, {
        driver_id: driverId,
        agent_id: probe.agentId,
        display_name: probe.displayName,
        connection_type: probe.connectionType,
        provenance: probe.provenance,
        probed_at: probe.probedAt,
        ...(agentVersion ? { agent_version: agentVersion } : {}),
        source: configuredId ? 'configured' : 'discovered',
        // 探测结论只描述「本机能否拉起它」；runtime 注册与否是另一条事实。
        ...(supported
          ? { status: 'ready' as const }
          : { status: 'unsupported' as const, reason_code: DRIVER_CONNECTION_TYPE_UNSUPPORTED }),
        runtime_registered: runtime?.registered ?? false,
      });
    }

    // 本轮没再发现的旧记录：保留 profile 与 id，标 stale。删除会让 UI routing 悬空。
    for (const [driverId, record] of records) {
      if (next.has(driverId) || seenAgents.has(record.agent_id)) continue;
      next.set(driverId, {
        ...cloneRecord(record),
        status: 'stale',
        reason_code: DRIVER_DISCOVERY_STALE,
      });
    }

    records = next;
    probeStatus = 'ready';
    return snapshot();
  }

  function snapshot(): DriverDiscoverySnapshot {
    return {
      schema_version: DRIVER_DISCOVERY_SCHEMA_VERSION,
      generated_at: now().toISOString(),
      probe_status: probeStatus,
      drivers: [...records.values()]
        .sort((left, right) => compareCodeUnits(left.driver_id, right.driver_id))
        .map(cloneRecord),
    };
  }

  /** agentId → 配置 driver_id。多个配置档案共用同一 agent 时取 code unit 最小的那个，结果稳定。 */
  function configuredDriverIdsByAgent(): Map<string, string> {
    const map = new Map<string, string>();
    for (const profile of [...options.configuredProfiles()].sort((left, right) =>
      compareCodeUnits(left.driver_id, right.driver_id),
    )) {
      if (!map.has(profile.agent)) map.set(profile.agent, profile.driver_id);
    }
    return map;
  }

  /** 把一次写入排到链尾；链本身的失败不影响后续调用。 */
  function enqueue<T>(operation: () => T): Promise<T> {
    const run = chain.then(operation, operation);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    current: snapshot,

    mergeProbe: (result) => enqueue(() => merge(result)),

    markProbeFailure: (reasonCode) => {
      probeStatus =
        reasonCode === DRIVER_DISCOVERY_PROBE_UNAVAILABLE ? 'unavailable' : 'failed';
      // 配置 driver 的存在性不依赖探测：探测失败不该让一个手工配好的 driver 变成不可选。
      for (const [driverId, record] of records) {
        if (record.source !== 'discovered') continue;
        records.set(driverId, {
          ...record,
          status: 'stale',
          reason_code: DRIVER_DISCOVERY_STALE,
        });
      }
      return snapshot();
    },

    recordRuntimeFailure: (driverId, reasonCode) => {
      runtimeStates.set(driverId, { registered: false, reason_code: reasonCode });
      const record = records.get(driverId);
      if (!record) return;
      // stale / unsupported 是**发现事实**，不能被一条执行事实改写成 failed：一个「本轮没再探测到」
      // 的 driver 即便 runtime 也起不来，前端该看到的仍是「它本轮没出现」这个更上游的原因。
      if (record.status === 'stale' || record.status === 'unsupported') {
        records.set(driverId, { ...record, runtime_registered: false });
        return;
      }
      records.set(driverId, {
        ...record,
        status: 'failed',
        reason_code: reasonCode,
        runtime_registered: false,
      });
    },

    recordRuntimeRegistered: (driverId) => {
      runtimeStates.set(driverId, { registered: true });
      const record = records.get(driverId);
      if (!record) return;
      // 注册成功抹掉的是「注册失败」这一条；stale / unsupported 是发现事实，不能因为进程里
      // 还留着旧 runtime 就被改写成 ready。
      if (record.status === 'failed') {
        const { reason_code: _registrationFailure, ...rest } = record;
        records.set(driverId, { ...rest, status: 'ready', runtime_registered: true });
        return;
      }
      records.set(driverId, { ...record, runtime_registered: true });
    },

    runtimeStatus: (driverId) => ({ ...(runtimeStates.get(driverId) ?? { registered: false }) }),

    recordOf: (driverId) => {
      const record = records.get(driverId);
      return record ? cloneRecord(record) : undefined;
    },

    discoveredDriverIds: () =>
      [...records.values()]
        .filter((record) => record.source === 'discovered')
        .map((record) => record.driver_id)
        .sort(compareCodeUnits),

    discoveredProfiles: () => {
      const profiles: Record<string, DriverProfile> = {};
      for (const record of records.values()) {
        if (record.source !== 'discovered') continue;
        profiles[record.driver_id] = {
          agent: record.agent_id,
          ...(record.display_name ? { description: record.display_name } : {}),
        };
      }
      return profiles;
    },
  };
}

/** 只保留 ASCII 小写字母数字，其余折叠成单个 `-`；全空时退化成 `agent`。 */
function normalizeAgentId(agentId: string): string {
  const folded = agentId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return folded.length > 0 ? folded : 'agent';
}

function cloneRecord(record: DriverDiscoveryRecord): DriverDiscoveryRecord {
  return { ...record };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
