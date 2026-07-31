import { z } from 'zod';

export const SYSTEM_CONTRACT_VERSION = 'newide.system.v1' as const;
export const SYSTEM_SCHEMA_VERSION = 'newide.system.v1' as const;
export const JSON_RPC_PROTOCOL_VERSION = '0.1.0' as const;

export const CORE_REQUIRED_CAPABILITY_IDS = [
  'coordination.persist',
  'driver.execute',
  'driver.workspace',
  'agent.read',
  'artifact.result_bundle',
] as const;

export const OPTIONAL_CAPABILITY_IDS = [
  'driver.session.continue',
  'driver.audit',
  'memory.semantic_retrieval',
  'market.competition',
  'council.execute',
  'checkpoint.resume',
  'mailbox.collaboration',
  'gate.verify',
  'skill.governance',
  'browser.gateway',
] as const;

export const KNOWN_CAPABILITY_IDS = [
  ...CORE_REQUIRED_CAPABILITY_IDS,
  ...OPTIONAL_CAPABILITY_IDS,
] as const;

export const serviceStatusSchema = z.enum(['operational', 'partial', 'unavailable']);
export const componentStatusSchema = z.enum(['ready', 'degraded', 'unavailable']);
export const capabilityAvailabilitySchema = z.enum(['available', 'degraded', 'unavailable']);

export const providerIdentitySchema = z
  .object({
    provider_id: z.string().min(1),
    version: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
  })
  .strict();

export const capabilityStatusV1Schema = z
  .object({
    capability_id: z.string().min(1),
    status: capabilityAvailabilitySchema,
    provider: providerIdentitySchema.optional(),
    reason_code: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    limitations: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const componentStatusV1Schema = z
  .object({
    component_id: z.string().min(1),
    status: componentStatusSchema,
    provider: providerIdentitySchema.optional(),
    reason_code: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const systemLivenessV1Schema = z
  .object({
    contract_version: z.literal(SYSTEM_CONTRACT_VERSION),
    status: z.literal('alive'),
    generated_at: z.string().datetime(),
  })
  .strict();

export const systemCapabilitiesV1Schema = z
  .object({
    contract_version: z.literal(SYSTEM_CONTRACT_VERSION),
    capabilities: z.array(capabilityStatusV1Schema),
    generated_at: z.string().datetime(),
  })
  .strict();

export const systemReadinessV1Schema = z
  .object({
    contract_version: z.literal(SYSTEM_CONTRACT_VERSION),
    schema_version: z.literal(SYSTEM_SCHEMA_VERSION),
    protocol_version: z.literal(JSON_RPC_PROTOCOL_VERSION),
    service: z.object({ status: serviceStatusSchema }).strict(),
    core_required_capabilities: z.array(z.string().min(1)),
    components: z.array(componentStatusV1Schema),
    capabilities: z.array(capabilityStatusV1Schema),
    generated_at: z.string().datetime(),
  })
  .strict();

export const systemVersionV1Schema = z
  .object({
    contract_version: z.literal(SYSTEM_CONTRACT_VERSION),
    package_name: z.string().min(1),
    package_version: z.string().min(1),
    protocol_version: z.literal(JSON_RPC_PROTOCOL_VERSION),
    schema_version: z.literal(SYSTEM_SCHEMA_VERSION),
    build_commit: z.string().min(1),
    runtime_node_version: z.string().min(1),
  })
  .strict();

export const systemSchemaManifestV1Schema = z
  .object({
    contract_version: z.literal(SYSTEM_CONTRACT_VERSION),
    schema_id: z.literal('newide.system'),
    schema_version: z.literal(SYSTEM_SCHEMA_VERSION),
    protocol_version: z.literal(JSON_RPC_PROTOCOL_VERSION),
    methods: z.array(z.string().min(1)),
    capability_ids: z.array(z.string().min(1)),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export type ComponentStatusV1 = z.infer<typeof componentStatusV1Schema>;
export type CapabilityStatusV1 = z.infer<typeof capabilityStatusV1Schema>;
export type SystemLivenessV1 = z.infer<typeof systemLivenessV1Schema>;
export type SystemCapabilitiesV1 = z.infer<typeof systemCapabilitiesV1Schema>;
export type SystemReadinessV1 = z.infer<typeof systemReadinessV1Schema>;
export type SystemVersionV1 = z.infer<typeof systemVersionV1Schema>;
export type SystemSchemaManifestV1 = z.infer<typeof systemSchemaManifestV1Schema>;
