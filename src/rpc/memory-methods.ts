/** memory.* JSON-RPC methods backed by B's public board and application maintenance services. */
import { z } from 'zod';
import type { BMemoryMaintenanceEvidence } from '../app/b-memory-maintenance-runner';
import type { BMemoryCapabilities } from '../app/b-memory-backend-service';
import type { ReviewedSkill } from '../app/b-public-capabilities';
import type {
  AgentBoardAgentView,
  AgentBoardListItem,
  ExperienceView,
  MarketImportResult,
  MarketSearchQuery,
  RetireOptions,
  RetireResult,
  RetirementScanResult,
  SkillView,
} from '../memory';
import { RetiredReasonSchema, type SkillRecord } from '../memory/schemas';
import { JsonRpcMethodError, type JsonRpcDispatcher } from './json-rpc-dispatcher';
import { JSON_RPC_ERROR_CODES } from './json-rpc-line-protocol';

export interface MemoryMethodsService {
  getMemoryCapabilities(): BMemoryCapabilities;
  listMemoryAgents(): Promise<AgentBoardListItem[]>;
  getMemoryAgent(roleId: string): Promise<AgentBoardAgentView>;
  listMemorySkills(roleId: string): Promise<SkillView[]>;
  listMemoryExperiences(roleId: string): Promise<ExperienceView[]>;
  listMemoryMaintenance(roleId?: string): Promise<BMemoryMaintenanceEvidence[]>;
  promoteMemorySkills(roleId: string, requestedBy: string): Promise<BMemoryMaintenanceEvidence>;
  /** 技能市场检索（Spec §6.2 skill.market_search） */
  marketSearchMemorySkills(query: MarketSearchQuery): Promise<SkillRecord[]>;
  /** 技能市场引入（Spec §6.2 skill.market_import） */
  marketImportMemorySkill(roleId: string, sourceSkillId: string): Promise<MarketImportResult>;
  /** Agent 退休（week3 RFC §12） */
  retireMemoryAgent(roleId: string, options: RetireOptions): Promise<RetireResult>;
  /** 三重门控退休检测（week3 RFC §8.2）：只产出建议，不自动退休 */
  runRetirementScan(roleId?: string): Promise<RetirementScanResult[]>;
  approveMemorySkill(roleId: string, skillId: string, reviewedBy: string): Promise<ReviewedSkill>;
  rejectMemorySkill(roleId: string, skillId: string, reviewedBy: string): Promise<ReviewedSkill>;
}

const emptyParamsSchema = z.object({}).strict();
const roleParamsSchema = z.object({ role_id: z.string().trim().min(1) }).strict();
const optionalRoleParamsSchema = z
  .object({ role_id: z.string().trim().min(1).optional() })
  .strict();
const promoteParamsSchema = z
  .object({
    role_id: z.string().trim().min(1),
    requested_by: z.string().trim().min(1).default('user'),
  })
  .strict();
const marketSearchParamsSchema = z
  .object({
    query: z.string().trim().min(1),
    top_k: z.number().int().positive().optional(),
    min_similarity: z.number().min(0).max(1).optional(),
    exclude_agent_id: z.string().trim().min(1).optional(),
  })
  .strict();
const marketImportParamsSchema = z
  .object({
    role_id: z.string().trim().min(1),
    source_skill_id: z.string().trim().min(1),
  })
  .strict();
const retireAgentParamsSchema = z
  .object({
    role_id: z.string().trim().min(1),
    reason: RetiredReasonSchema.optional(),
    replacement: z.enum(['clean_slate', 'seeded_slate', 'none']).optional(),
  })
  .strict();
const retirementScanParamsSchema = z
  .object({ role_id: z.string().trim().min(1).optional() })
  .strict();
const reviewParamsSchema = z
  .object({
    role_id: z.string().trim().min(1),
    skill_id: z.string().trim().min(1),
    reviewed_by: z.string().trim().min(1).default('user'),
  })
  .strict();

export class MemoryRpcMethods {
  constructor(private readonly service: MemoryMethodsService) {}

  register(dispatcher: JsonRpcDispatcher): void {
    dispatcher.register('memory.getCapabilities', (params) => {
      parseParams(emptyParamsSchema, params ?? {});
      return { capabilities: this.service.getMemoryCapabilities() };
    });
    dispatcher.register('memory.listAgents', (params) => {
      parseParams(emptyParamsSchema, params ?? {});
      return this.service.listMemoryAgents().then((agents) => ({ agents }));
    });
    dispatcher.register('memory.getAgent', (params) => {
      const parsed = parseParams(roleParamsSchema, params);
      return this.service.getMemoryAgent(parsed.role_id).then((agent) => ({ agent }));
    });
    dispatcher.register('memory.listSkills', (params) => {
      const parsed = parseParams(roleParamsSchema, params);
      return this.service.listMemorySkills(parsed.role_id).then((skills) => ({ skills }));
    });
    dispatcher.register('memory.listExperiences', (params) => {
      const parsed = parseParams(roleParamsSchema, params);
      return this.service
        .listMemoryExperiences(parsed.role_id)
        .then((experiences) => ({ experiences }));
    });
    dispatcher.register('memory.listMaintenance', (params) => {
      const parsed = parseParams(optionalRoleParamsSchema, params ?? {});
      return this.service
        .listMemoryMaintenance(parsed.role_id)
        .then((maintenance) => ({ maintenance }));
    });
    dispatcher.register('memory.promoteSkills', (params) => {
      const parsed = parseParams(promoteParamsSchema, params);
      return this.service
        .promoteMemorySkills(parsed.role_id, parsed.requested_by)
        .then((maintenance) => ({ maintenance }));
    });
    dispatcher.register('memory.marketSearch', (params) => {
      const parsed = parseParams(marketSearchParamsSchema, params ?? {});
      return this.service
        .marketSearchMemorySkills({
          query: parsed.query,
          ...(parsed.top_k !== undefined ? { top_k: parsed.top_k } : {}),
          ...(parsed.min_similarity !== undefined
            ? { min_similarity: parsed.min_similarity }
            : {}),
          ...(parsed.exclude_agent_id !== undefined
            ? { exclude_agent_id: parsed.exclude_agent_id }
            : {}),
        })
        .then((skills) => ({ skills }));
    });
    dispatcher.register('memory.marketImport', (params) => {
      const parsed = parseParams(marketImportParamsSchema, params);
      return this.service
        .marketImportMemorySkill(parsed.role_id, parsed.source_skill_id)
        .then((result) => ({ import: result }));
    });
    dispatcher.register('memory.retireAgent', (params) => {
      const parsed = parseParams(retireAgentParamsSchema, params);
      return this.service
        .retireMemoryAgent(parsed.role_id, {
          ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
          ...(parsed.replacement !== undefined ? { replacement: parsed.replacement } : {}),
        })
        .then((result) => ({ retire: result }));
    });
    dispatcher.register('memory.retirementScan', (params) => {
      const parsed = parseParams(retirementScanParamsSchema, params ?? {});
      return this.service
        .runRetirementScan(parsed.role_id)
        .then((scans) => ({ scans }));
    });
    dispatcher.register('memory.approveSkill', (params) => {
      const parsed = parseParams(reviewParamsSchema, params);
      return this.service
        .approveMemorySkill(parsed.role_id, parsed.skill_id, parsed.reviewed_by)
        .then((skill) => ({ skill }));
    });
    dispatcher.register('memory.rejectSkill', (params) => {
      const parsed = parseParams(reviewParamsSchema, params);
      return this.service
        .rejectMemorySkill(parsed.role_id, parsed.skill_id, parsed.reviewed_by)
        .then((skill) => ({ skill }));
    });
  }
}

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new JsonRpcMethodError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params');
  }
  return parsed.data;
}
