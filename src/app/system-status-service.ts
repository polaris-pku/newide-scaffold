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

export interface SystemStatusServiceOptions {
  package_name: string;
  package_version: string;
  build_commit: string;
  components: readonly ComponentStatusV1[];
  capabilities: readonly CapabilityStatusV1[];
  runtime_node_version?: string;
  generated_at?: string;
}

export interface ProductionSystemStatusInput {
  package_name: string;
  package_version: string;
  build_commit: string;
  coordination_durable: boolean;
  driver_provider_id: string;
  driver_provider_version?: string;
  b_repository_mode: string;
  b_embedding: BEmbeddingRuntimeInfo;
}

export class SystemStatusService {
  private readonly capabilitiesById = new Map<string, CapabilityStatusV1>();
  private readonly generatedAt: string;
  private readonly components: ComponentStatusV1[];
  private readonly versionSnapshot: SystemVersionV1;

  constructor(options: SystemStatusServiceOptions) {
    for (const item of options.capabilities) {
      if (this.capabilitiesById.has(item.capability_id)) {
        throw new Error(`Duplicate capability_id: ${item.capability_id}`);
      }
      if (item.status === 'available' && !item.provider) {
        throw new Error(`Available capability ${item.capability_id} must identify its provider`);
      }
      this.capabilitiesById.set(item.capability_id, cloneCapability(item));
    }
    this.components = [...options.components].sort(byComponentId).map(cloneComponent);
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
    const capabilities = this.listCapabilities();
    const operational = CORE_REQUIRED_CAPABILITY_IDS.every(
      (id) => this.capabilitiesById.get(id)?.status === 'available',
    );
    return {
      contract_version: SYSTEM_CONTRACT_VERSION,
      schema_version: SYSTEM_SCHEMA_VERSION,
      protocol_version: JSON_RPC_PROTOCOL_VERSION,
      service: {
        status: operational ? 'operational' : capabilities.length > 0 ? 'partial' : 'unavailable',
      },
      core_required_capabilities: [...CORE_REQUIRED_CAPABILITY_IDS],
      components: this.components.map(cloneComponent),
      capabilities,
      generated_at: this.generatedAt,
    };
  }

  capabilities(required: readonly string[] = []): SystemCapabilitiesV1 {
    for (const capabilityId of required) this.requireAvailable(capabilityId);
    return {
      contract_version: SYSTEM_CONTRACT_VERSION,
      capabilities: this.listCapabilities(),
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

  private listCapabilities(): CapabilityStatusV1[] {
    return [...this.capabilitiesById.values()].sort(byCapabilityId).map(cloneCapability);
  }

  private requireAvailable(capabilityId: string): void {
    const capability = this.capabilitiesById.get(capabilityId);
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
  const bRepository = provider('b-memory-repository', undefined, input.b_repository_mode);
  const bEmbedding = provider(
    input.b_embedding.provider,
    input.b_embedding.model,
    input.b_embedding.readiness,
  );
  const hashEmbedding = input.b_embedding.provider === 'HashEmbeddingProvider';

  return new SystemStatusService({
    package_name: input.package_name,
    package_version: input.package_version,
    build_commit: input.build_commit,
    components: [
      component(
        'coordination_store',
        input.coordination_durable ? 'ready' : 'degraded',
        coordination,
        input.coordination_durable ? undefined : 'NON_DURABLE_COORDINATION_STORE',
      ),
      component('driver_provider', 'degraded', driver, 'DRIVER_HANDSHAKE_UNAVAILABLE'),
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
      degraded('driver.execute', 'DRIVER_HANDSHAKE_UNAVAILABLE', driver),
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
