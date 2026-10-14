import { createHash, randomUUID } from 'node:crypto';
import type { BEmbeddingRuntimeInfo } from './production-b-runtime';
import {
  APPLICATION_ERROR_CONTRACT_VERSION,
  ApplicationError,
} from '../protocol/application-error';
import {
  CORE_REQUIRED_CAPABILITY_IDS,
  JSON_RPC_PROTOCOL_VERSION,
  KNOWN_CAPABILITY_IDS,
  SYSTEM_CONTRACT_VERSION,
  SYSTEM_SCHEMA_VERSION,
  type CapabilityStatusV1,
  type ComponentStatusV1,
  type SystemCapabilitiesV1,
  type SystemLivenessV1,
  type SystemReadinessV1,
  type SystemSchemaManifestV1,
  type SystemVersionV1,
} from '../protocol/system-status';

const SYSTEM_METHODS = [
  'system.ping',
  'system.liveness',
  'system.readiness',
  'system.capabilities',
  'system.version',
  'system.schema',
] as const;

/** 组件与能力的来源；给函数时**每次查询都重新取值**（driver 会随探测变化）。 */
type StatusSource<T> = readonly T[] | (() => readonly T[]);

export interface SystemStatusServiceOptions {
  package_name: string;
  package_version: string;
  build_commit: string;
  components: StatusSource<ComponentStatusV1>;
  capabilities: StatusSource<CapabilityStatusV1>;
  runtime_node_version?: string;
  generated_at?: string;
}

/** 一个 driver 的对外可见状态：与 `driver.getConfig.drivers[]` 同源，不重新推导。 */
export interface SystemStatusDriverStatus {
  driver_id: string;
  agent: string;
  /** `discovered` 表示它由 ACP 探测生成，`configured` 表示来自某层手工配置。 */
  source?: 'configured' | 'discovered';
  /** 后端明确计算的「是否可选择」；前端不要从 status / limitations 推断。 */
  selectable: boolean;
  status: 'configured' | 'degraded' | 'unavailable';
  reason_code?: string;
  /** 该 driver 的诚实限制措辞（已含探测证据行）。 */
  limitations?: readonly string[];
  display_name?: string;
  /** ACP 探测是否验证过它（探测通过 ≠ 能跑完一次 Run）。 */
  probe_verified?: boolean;
}

export interface ProductionSystemStatusInput {
  package_name: string;
  package_version: string;
  build_commit: string;
  coordination_durable: boolean;
  driver_provider_id: string;
  driver_provider_version?: string;
  /**
   * 已配置的 driver 档案。缺省表示「没有可配置能力」，输出与历史单 driver 一致。
   *
   * **已由 `driver_status` 取代**，保留是为了让不接 catalog 的装配（脚本、测试）逐字段不变。
   */
  driver_profiles?: readonly SystemStatusDriverProfile[];
  /**
   * 动态 driver 状态提供者：**每次查询都重新投影**，因此刷新后新增的 driver 立刻可见。
   *
   * 与 `driver.getConfig` 用同一份投影（`DriverRoutingService.driverProjection()`）是硬要求
   * ——两个出口各算各的，是前端最难查的那类不一致。
   */
  driver_status?: () => readonly SystemStatusDriverStatus[];
  b_repository_mode: string;
  b_embedding: BEmbeddingRuntimeInfo;
}

/** 一个已配置 driver 的对外可见事实。 */
export interface SystemStatusDriverProfile {
  /** 本仓 driver 标识（`DriverConfig` 的 key）。 */
  driver_id: string;
  /** 该 driver 使用的 A 侧 agent（`ACP_AGENT_ID`）。 */
  agent: string;
  /** 档案自己声明的已知限制，会一并并入 `driver.execute` 的 `limitations`。 */
  limitations?: readonly string[];
}

/**
 * 诚实降级措辞。
 *
 * 本仓能自足判定的是「档案已配置、runner 入口存在、凭据键齐备」；**本机是否装了该
 * agent CLI 判断不了**——启动命令来自 A 侧的 `${AGENT_ID}_CLI_COMMAND` 或 adapter
 * 默认值（如 `npx -y <pkg>`）。所以能力条目不能宣称「可用」，只能如实标注这一条
 * 未验证。前端文案与本常量同源，不允许各写各的。
 *
 * 只作用于**没有探测证据**的 driver：探测真的把 A 侧拉起来过时，这句话就不准确了，
 * 此时改用 {@link DRIVER_DISCOVERED_PROBE_PASSED}（见 `driverProbeEvidence`）。
 */
export const DRIVER_CONFIGURED_CLI_UNVERIFIED =
  'driver 已配置且凭据齐备；agent CLI 是否就绪未验证';

/** 不可选择的 driver 在能力文案里的措辞；带具体原因码，前端不必猜。 */
export const DRIVER_NOT_SELECTABLE_WORDING = '当前不可选择';

/** 构造一个 driver 的状态投影；组装点把 routing 快照与 catalog 证据映射成它。 */
export function systemStatusDriverStatus(input: {
  driver_id: string;
  agent: string;
  selectable: boolean;
  status: 'configured' | 'degraded' | 'unavailable';
  reason_code?: string;
  limitations?: readonly string[];
  display_name?: string;
  source?: 'configured' | 'discovered';
  probe_verified?: boolean;
}): SystemStatusDriverStatus {
  return {
    driver_id: input.driver_id,
    agent: input.agent,
    selectable: input.selectable,
    status: input.status,
    ...(input.source ? { source: input.source } : {}),
    ...(input.reason_code ? { reason_code: input.reason_code } : {}),
    ...(input.limitations && input.limitations.length > 0
      ? { limitations: [...input.limitations] }
      : {}),
    ...(input.display_name ? { display_name: input.display_name } : {}),
    ...(input.probe_verified === undefined ? {} : { probe_verified: input.probe_verified }),
  };
}

export class SystemStatusService {
  private readonly componentSource: StatusSource<ComponentStatusV1>;
  private readonly capabilitySource: StatusSource<CapabilityStatusV1>;
  /**
   * 静态来源（数组）在构造期就算好并校验一次，行为与改造前逐字一致；
   * 动态来源（函数）每次查询重算，于是「刷新出来的新 driver」立刻出现在能力里。
   */
  private readonly staticProjection: StatusProjection | undefined;
  private readonly generatedAt: string;
  private readonly versionSnapshot: SystemVersionV1;

  constructor(options: SystemStatusServiceOptions) {
    this.componentSource = options.components;
    this.capabilitySource = options.capabilities;
    this.staticProjection =
      typeof options.components === 'function' || typeof options.capabilities === 'function'
        ? undefined
        : projectStatus(
            options.components as readonly ComponentStatusV1[],
            options.capabilities as readonly CapabilityStatusV1[],
          );
    this.generatedAt = options.generated_at ?? new Date().toISOString();
    this.versionSnapshot = {
      contract_version: SYSTEM_CONTRACT_VERSION,
      package_name: options.package_name,
      package_version: options.package_version,
      protocol_version: JSON_RPC_PROTOCOL_VERSION,
      schema_version: SYSTEM_SCHEMA_VERSION,
      build_commit: options.build_commit,
      runtime_node_version: options.runtime_node_version ?? process.version,
    };
  }

  liveness(): SystemLivenessV1 {
    return {
      contract_version: SYSTEM_CONTRACT_VERSION,
      status: 'alive',
      generated_at: this.generatedAt,
    };
  }

  readiness(): SystemReadinessV1 {
    const projection = this.project();
    const capabilities = this.listCapabilities(projection);
    const operational = CORE_REQUIRED_CAPABILITY_IDS.every(
      (id) => projection.capabilitiesById.get(id)?.status === 'available',
    );
    return {
      contract_version: SYSTEM_CONTRACT_VERSION,
      schema_version: SYSTEM_SCHEMA_VERSION,
      protocol_version: JSON_RPC_PROTOCOL_VERSION,
      service: {
        status: operational ? 'operational' : capabilities.length > 0 ? 'partial' : 'unavailable',
      },
      core_required_capabilities: [...CORE_REQUIRED_CAPABILITY_IDS],
      components: projection.components.map(cloneComponent),
      capabilities,
      generated_at: this.generatedAt,
    };
  }

  capabilities(required: readonly string[] = []): SystemCapabilitiesV1 {
    const projection = this.project();
    for (const capabilityId of required) this.requireAvailable(projection, capabilityId);
    return {
      contract_version: SYSTEM_CONTRACT_VERSION,
      capabilities: this.listCapabilities(projection),
      generated_at: this.generatedAt,
    };
  }

  version(): SystemVersionV1 {
    return { ...this.versionSnapshot };
  }

  schema(): SystemSchemaManifestV1 {
    const stable = {
      schema_id: 'newide.system' as const,
      schema_version: SYSTEM_SCHEMA_VERSION,
      protocol_version: JSON_RPC_PROTOCOL_VERSION,
      methods: [...SYSTEM_METHODS],
      capability_ids: [...KNOWN_CAPABILITY_IDS],
    };
    return {
      contract_version: SYSTEM_CONTRACT_VERSION,
      ...stable,
      sha256: createHash('sha256').update(JSON.stringify(stable)).digest('hex'),
    };
  }

  private project(): StatusProjection {
    if (this.staticProjection) return this.staticProjection;
    return projectStatus(resolveStatusSource(this.componentSource), resolveStatusSource(this.capabilitySource));
  }

  private listCapabilities(projection: StatusProjection): CapabilityStatusV1[] {
    return [...projection.capabilitiesById.values()].sort(byCapabilityId).map(cloneCapability);
  }

  private requireAvailable(projection: StatusProjection, capabilityId: string): void {
    const capability = projection.capabilitiesById.get(capabilityId);
    if (capability?.status === 'available') return;
    throw new ApplicationError({
      contract_version: APPLICATION_ERROR_CONTRACT_VERSION,
      error_code: 'CAPABILITY_UNAVAILABLE',
      category: 'capability',
      retryable: false,
      request_id: randomUUID(),
      capability_id: capabilityId,
      allowed_actions: [],
      details: {
        status: capability?.status ?? 'unknown',
        ...(capability?.reason_code ? { reason_code: capability.reason_code } : {}),
      },
    });
  }
}

/** 一次投影的结果：校验过的组件表与能力表。 */
interface StatusProjection {
  components: ComponentStatusV1[];
  capabilitiesById: Map<string, CapabilityStatusV1>;
}

function resolveStatusSource<T>(source: StatusSource<T>): readonly T[] {
  return typeof source === 'function' ? source() : source;
}

/**
 * 校验并归一化一份投影。
 *
 * 校验放在这里而不是构造函数里，是因为动态来源每次都会给出一份新数据——「同一个能力
 * id 出现两次」「说 available 却没有 provider」在任何一次投影里都是错误，而不只是启动时。
 */
function projectStatus(
  components: readonly ComponentStatusV1[],
  capabilities: readonly CapabilityStatusV1[],
): StatusProjection {
  const capabilitiesById = new Map<string, CapabilityStatusV1>();
  for (const item of capabilities) {
    if (capabilitiesById.has(item.capability_id)) {
      throw new Error(`Duplicate capability_id: ${item.capability_id}`);
    }
    if (item.status === 'available' && !item.provider) {
      throw new Error(`Available capability ${item.capability_id} must identify its provider`);
    }
    capabilitiesById.set(item.capability_id, cloneCapability(item));
  }
  return {
    components: [...components].sort(byComponentId).map(cloneComponent),
    capabilitiesById,
  };
}

export function createProductionSystemStatusService(
  input: ProductionSystemStatusInput,
): SystemStatusService {
  const coordination = provider(
    'sqlite-coordination-store',
    undefined,
    input.coordination_durable ? 'durable-file' : 'in-memory',
  );
  const driver = provider(
    input.driver_provider_id,
    input.driver_provider_version,
    'external-command',
  );
  const driverProfiles = input.driver_profiles ?? [];
  const bRepository = provider('b-memory-repository', undefined, input.b_repository_mode);
  const bEmbedding = provider(
    input.b_embedding.provider,
    input.b_embedding.model,
    input.b_embedding.readiness,
  );
  const hashEmbedding = input.b_embedding.provider === 'HashEmbeddingProvider';

  /**
   * 组件与能力都从**一份 driver 状态**推出来。
   *
   * 抽成「接收 driver 状态 → 整份投影」的纯函数，是为了让静态装配（`driver_profiles`）与
   * 动态装配（`driver_status`）走完全相同的代码：两条路径各写一遍文案，正是这个文件过去
   * 「探测结果被固定措辞覆盖」的成因。
   */
  const project = (driverStatuses: readonly SystemStatusDriverStatus[]): {
    components: ComponentStatusV1[];
    capabilities: CapabilityStatusV1[];
  } => ({
    components: [
      component(
        'coordination_store',
        input.coordination_durable ? 'ready' : 'degraded',
        coordination,
        input.coordination_durable ? undefined : 'NON_DURABLE_COORDINATION_STORE',
      ),
      component('driver_provider', 'degraded', driver, 'DRIVER_HANDSHAKE_UNAVAILABLE'),
      ...driverStatuses.map(driverComponent),
      component('b_repository', 'ready', bRepository),
      component(
        'b_embedding',
        hashEmbedding ? 'degraded' : 'ready',
        bEmbedding,
        hashEmbedding ? 'NON_SEMANTIC_EMBEDDING' : undefined,
      ),
      component('b_agent_runtime', 'ready', provider('b-agent-runtime', undefined, 'public-ports')),
      component('gate_provider', 'unavailable', undefined, 'VERIFIED_GATE_NOT_WIRED'),
    ],
    capabilities: [
      input.coordination_durable
        ? available('coordination.persist', coordination)
        : unavailable('coordination.persist', 'NON_DURABLE_COORDINATION_STORE', coordination),
      // 一个 driver 都没有时保持历史输出逐字段不变（不加 limitations）。
      ...(driverStatuses.length > 0
        ? [
            {
              ...degraded('driver.execute', 'DRIVER_HANDSHAKE_UNAVAILABLE', driver),
              limitations: driverLimitations(driverStatuses),
            },
          ]
        : [degraded('driver.execute', 'DRIVER_HANDSHAKE_UNAVAILABLE', driver)]),
      unavailable('driver.workspace', 'PER_REQUEST_WORKSPACE_NOT_CONFIRMED', driver),
      available('agent.read', bRepository),
      available(
        'artifact.result_bundle',
        provider('file-run-output-writer', undefined, 'persisted-files'),
      ),
      unavailable('driver.session.continue', 'DRIVER_SESSION_HANDSHAKE_UNAVAILABLE'),
      unavailable('driver.audit', 'DRIVER_AUDIT_QUERY_NOT_PUBLISHED'),
      degraded('memory.semantic_retrieval', 'END_TO_END_RETRIEVAL_NOT_VERIFIED', bEmbedding),
      unavailable('market.competition', 'REAL_COMPETITION_EVALUATOR_NOT_WIRED'),
      {
        ...degraded(
          'council.execute',
          'COUNCIL_IDENTITY_AND_SESSION_NOT_CLOSED',
          provider('synthesis-agent-council-v0', undefined, 'production-wired'),
        ),
        limitations: [
          'Council roles still map to persisted role identities.',
          'Driver Session continuation is not handshaken.',
        ],
      },
      unavailable('checkpoint.resume', 'EXACT_RESUME_NOT_CLOSED'),
      unavailable('mailbox.collaboration', 'MAILBOX_TASK_LOOP_NOT_CLOSED'),
      unavailable('gate.verify', 'VERIFIED_GATE_NOT_WIRED'),
      unavailable('skill.governance', 'B_GOVERNANCE_PORT_NOT_AVAILABLE'),
      unavailable('browser.gateway', 'PRODUCTION_BROWSER_GATEWAY_NOT_AVAILABLE'),
    ],
  });

  const staticStatuses = driverProfiles.map((profile) =>
    systemStatusDriverStatus({
      driver_id: profile.driver_id,
      agent: profile.agent,
      // 没有 catalog 时只能诚实降级：档案已配置、凭据未知、CLI 未验证。
      selectable: true,
      status: 'degraded',
      ...(profile.limitations ? { limitations: profile.limitations } : {}),
    }),
  );
  const staticProjection = input.driver_status ? undefined : project(staticStatuses);

  return new SystemStatusService({
    package_name: input.package_name,
    package_version: input.package_version,
    build_commit: input.build_commit,
    // 动态来源每次查询重新投影：刷新后新增的 driver 必须在 capabilities 里立刻可见，
    // 否则前端会把「探测到了但系统状态里没有」读成不可用。
    components: staticProjection
      ? staticProjection.components
      : () => project(input.driver_status!()).components,
    capabilities: staticProjection
      ? staticProjection.capabilities
      : () => project(input.driver_status!()).capabilities,
  });
}

/** 一个 driver 一个组件：`selectable=false` 必须带上**具体**原因码。 */
function driverComponent(status: SystemStatusDriverStatus): ComponentStatusV1 {
  return component(
    `driver:${status.driver_id}`,
    status.selectable ? 'degraded' : 'unavailable',
    provider(
      status.agent,
      undefined,
      status.source === 'discovered' ? 'acp-probed' : 'configured-credentials-complete',
    ),
    status.selectable
      ? 'AGENT_CLI_READINESS_NOT_VERIFIABLE'
      : (status.reason_code ?? 'DRIVER_NOT_SELECTABLE'),
  );
}

export function createUnavailableSystemStatusService(): SystemStatusService {
  return new SystemStatusService({
    package_name: 'newide-bcd',
    package_version: '0.1.0',
    build_commit: 'dev',
    components: [
      component(
        'application_composition',
        'unavailable',
        undefined,
        'APPLICATION_COMPOSITION_NOT_CONFIGURED',
      ),
    ],
    capabilities: KNOWN_CAPABILITY_IDS.map((id) =>
      unavailable(id, 'CAPABILITY_NOT_CONFIGURED'),
    ),
  });
}

type Provider = NonNullable<CapabilityStatusV1['provider']>;

/**
 * `driver.execute` 的 limitations：逐 driver 列出「现在能到哪一步」，再并入各 driver 的
 * 限制措辞（含探测证据行）。
 *
 * 逐条带 driver_id 与 agent，是为了让前端能指出**具体哪一个** driver 不可用，而不是笼统地
 * 说「driver 未就绪」。三种情形：
 * - 可选择且**没有***探测证据：沿用「已配置且凭据齐备；agent CLI 是否就绪未验证」；
 * - 可选择且探测通过：不再重复那句（探测已经把它拉起来过），证据行由 routing 投影带进来；
 * - 不可选择：带上具体原因码——前端据此区分「本轮没再发现」「连接类型不支持」「runtime 起不来」。
 */
function driverLimitations(drivers: readonly SystemStatusDriverStatus[]): string[] {
  return [
    ...drivers.flatMap((driver) => {
      const label = `driver "${driver.driver_id}"（agent: ${driver.agent}）`;
      if (!driver.selectable) {
        const reason = driver.reason_code ? `（${driver.reason_code}）` : '';
        return [`${label}: ${DRIVER_NOT_SELECTABLE_WORDING}${reason}`];
      }
      return driver.probe_verified ? [] : [`${label}: ${DRIVER_CONFIGURED_CLI_UNVERIFIED}`];
    }),
    ...drivers.flatMap((driver) => driver.limitations ?? []),
  ];
}

function provider(providerId: string, version?: string, mode?: string): Provider {
  return {
    provider_id: providerId,
    ...(version ? { version } : {}),
    ...(mode ? { mode } : {}),
  };
}

function component(
  componentId: string,
  status: ComponentStatusV1['status'],
  providerIdentity?: Provider,
  reasonCode?: string,
): ComponentStatusV1 {
  return {
    component_id: componentId,
    status,
    ...(providerIdentity ? { provider: providerIdentity } : {}),
    ...(reasonCode ? { reason_code: reasonCode } : {}),
  };
}

function available(capabilityId: string, providerIdentity: Provider): CapabilityStatusV1 {
  return { capability_id: capabilityId, status: 'available', provider: providerIdentity };
}

function degraded(
  capabilityId: string,
  reasonCode: string,
  providerIdentity: Provider,
): CapabilityStatusV1 {
  return {
    capability_id: capabilityId,
    status: 'degraded',
    provider: providerIdentity,
    reason_code: reasonCode,
  };
}

function unavailable(
  capabilityId: string,
  reasonCode: string,
  providerIdentity?: Provider,
): CapabilityStatusV1 {
  return {
    capability_id: capabilityId,
    status: 'unavailable',
    ...(providerIdentity ? { provider: providerIdentity } : {}),
    reason_code: reasonCode,
  };
}

function cloneCapability(item: CapabilityStatusV1): CapabilityStatusV1 {
  return {
    ...item,
    ...(item.provider ? { provider: { ...item.provider } } : {}),
    ...(item.limitations ? { limitations: [...item.limitations] } : {}),
  };
}

function cloneComponent(item: ComponentStatusV1): ComponentStatusV1 {
  return { ...item, ...(item.provider ? { provider: { ...item.provider } } : {}) };
}

function byCapabilityId(left: CapabilityStatusV1, right: CapabilityStatusV1): number {
  return compareCodeUnits(left.capability_id, right.capability_id);
}

function byComponentId(left: ComponentStatusV1, right: ComponentStatusV1): number {
  return compareCodeUnits(left.component_id, right.component_id);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
