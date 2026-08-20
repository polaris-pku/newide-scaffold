/** memory.* JSON-RPC methods backed by B's public board and application maintenance services. */
import { z } from 'zod';
import type { BMemoryMaintenanceEvidence } from '../app/b-memory-maintenance-runner';
import type { AgentMetaPatch, BMemoryCapabilities } from '../app/b-memory-backend-service';
import type { ReviewedSkill } from '../app/b-public-capabilities';
import type {
  AgentBoardAgentView,
  AgentBoardListItem,
  AgentHandle,
  CreateAgentSpec,
  CreateSkillInput,
  ExperienceView,
  ExperienceWritePatch,
  MarketImportResult,
  MarketSearchQuery,
  PersonaDef,
  PersonaPatch,
  RetireOptions,
  RetireResult,
  RetirementScanResult,
  SkillView,
  SkillWritePatch,
  UserRating,
  UserRatingResult,
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
  /** 显式创建 Agent（memory.createAgent） */
  createMemoryAgent(spec: CreateAgentSpec): Promise<AgentHandle>;
  /** 更新 Agent 元数据（名称 / 标签） */
  updateMemoryAgent(roleId: string, patch: AgentMetaPatch): Promise<AgentHandle>;
  /** 硬删除 Agent（需 confirm: true，且 Agent 已 retired） */
  deleteMemoryAgent(roleId: string): Promise<void>;
  /** 手动创建 Skill（memory.createSkill） */
  createMemorySkill(input: CreateSkillInput): Promise<SkillView>;
  /** PATCH 更新 Skill（memory.updateSkill） */
  updateMemorySkill(
    roleId: string,
    skillId: string,
    patch: SkillWritePatch,
  ): Promise<SkillView>;
  /** 删除 Skill（memory.deleteSkill） */
  deleteMemorySkill(roleId: string, skillId: string): Promise<void>;
  /** 技能上架市场（memory.publishSkillToMarket） */
  publishMemorySkillToMarket(roleId: string, skillId: string): Promise<SkillView>;
  /** PATCH 更新 Experience（memory.updateExperience） */
  updateMemoryExperience(
    roleId: string,
    experienceId: string,
    patch: ExperienceWritePatch,
  ): Promise<ExperienceView>;
  /** 删除 Experience（memory.deleteExperience） */
  deleteMemoryExperience(roleId: string, experienceId: string): Promise<void>;
  /** PATCH 更新 Persona（memory.updatePersona） */
  updateMemoryPersona(roleId: string, patch: PersonaPatch): Promise<PersonaDef>;
  /** 按需重新生成 Persona（memory.regeneratePersona） */
  regenerateMemoryPersona(roleId: string): Promise<PersonaDef>;
  /** 用户评分（memory.rateTask） */
  rateMemoryTask(
    roleId: string,
    taskId: string,
    rating: UserRating,
    note?: string,
  ): Promise<UserRatingResult>;
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
const createAgentParamsSchema = z
  .object({
    role_id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    tags: z.array(z.string().trim().min(1)).optional(),
    persona_seed: z.string().trim().min(1).optional(),
    constraints: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();
const updateAgentParamsSchema = z
  .object({
    role_id: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.tags !== undefined, {
    message: 'At least one of name or tags is required',
  });
const deleteAgentParamsSchema = z
  .object({
    role_id: z.string().trim().min(1),
    confirm: z.literal(true),
  })
  .strict();
const createSkillParamsSchema = z
  .object({
    role_id: z.string().trim().min(1),
    description: z.string().trim().min(1),
    content: z.string().trim().min(1),
    tags: z.array(z.string().trim().min(1)).optional(),
    version: z.string().trim().min(1).optional(),
  })
  .strict();
const skillRefParamsSchema = z
  .object({
    role_id: z.string().trim().min(1),
    skill_id: z.string().trim().min(1),
  })
  .strict();
const updateSkillParamsSchema = z
  .object({
    role_id: z.string().trim().min(1),
    skill_id: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    content: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    market_status: z.enum(['available', 'superseded']).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.description !== undefined ||
      value.content !== undefined ||
      value.tags !== undefined ||
      value.market_status !== undefined,
    { message: 'At least one updatable field is required' },
  );
const experienceRefParamsSchema = z
  .object({
    role_id: z.string().trim().min(1),
    experience_id: z.string().trim().min(1),
  })
  .strict();
const updateExperienceParamsSchema = z
  .object({
    role_id: z.string().trim().min(1),
    experience_id: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    content: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.description !== undefined ||
      value.content !== undefined ||
      value.tags !== undefined ||
      value.confidence !== undefined,
    { message: 'At least one updatable field is required' },
  );
const updatePersonaParamsSchema = z
  .object({
    role_id: z.string().trim().min(1),
    summary: z.string().optional(),
    skills_overview: z.string().optional(),
    experience_coverage: z.string().optional(),
    recent_performance: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.summary !== undefined ||
      value.skills_overview !== undefined ||
      value.experience_coverage !== undefined ||
      value.recent_performance !== undefined ||
      value.notes !== undefined,
    { message: 'At least one persona field is required' },
  );
const rateTaskParamsSchema = z
  .object({
    role_id: z.string().trim().min(1),
    task_id: z.string().trim().min(1),
    rating: z.enum(['resolved', 'partially_resolved', 'unresolved', 'not_rated']),
    note: z.string().trim().min(1).optional(),
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
    dispatcher.register('memory.createAgent', async (params) => {
      const parsed = parseParams(createAgentParamsSchema, params);
      await this.service.createMemoryAgent({
        role_id: parsed.role_id,
        name: parsed.name,
        ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
        ...(parsed.persona_seed !== undefined ? { persona_seed: parsed.persona_seed } : {}),
        ...(parsed.constraints !== undefined ? { constraints: parsed.constraints } : {}),
      });
      const agent = await this.service.getMemoryAgent(parsed.role_id);
      return { agent };
    });
    dispatcher.register('memory.updateAgent', async (params) => {
      const parsed = parseParams(updateAgentParamsSchema, params);
      await this.service.updateMemoryAgent(parsed.role_id, {
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
      });
      const agent = await this.service.getMemoryAgent(parsed.role_id);
      return { agent };
    });
    dispatcher.register('memory.deleteAgent', async (params) => {
      const parsed = parseParams(deleteAgentParamsSchema, params);
      await this.service.deleteMemoryAgent(parsed.role_id);
      return { deleted: true };
    });
    dispatcher.register('memory.createSkill', async (params) => {
      const parsed = parseParams(createSkillParamsSchema, params);
      const skill = await this.service.createMemorySkill({
        role_id: parsed.role_id,
        description: parsed.description,
        content: parsed.content,
        ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
        ...(parsed.version !== undefined ? { version: parsed.version } : {}),
      });
      return { skill };
    });
    dispatcher.register('memory.updateSkill', async (params) => {
      const parsed = parseParams(updateSkillParamsSchema, params);
      const skill = await this.service.updateMemorySkill(parsed.role_id, parsed.skill_id, {
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        ...(parsed.content !== undefined ? { content: parsed.content } : {}),
        ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
        ...(parsed.market_status !== undefined ? { market_status: parsed.market_status } : {}),
      });
      return { skill };
    });
    dispatcher.register('memory.deleteSkill', async (params) => {
      const parsed = parseParams(skillRefParamsSchema, params);
      await this.service.deleteMemorySkill(parsed.role_id, parsed.skill_id);
      return { deleted: true };
    });
    dispatcher.register('memory.publishSkillToMarket', async (params) => {
      const parsed = parseParams(skillRefParamsSchema, params);
      const skill = await this.service.publishMemorySkillToMarket(
        parsed.role_id,
        parsed.skill_id,
      );
      return { skill };
    });
    dispatcher.register('memory.updateExperience', async (params) => {
      const parsed = parseParams(updateExperienceParamsSchema, params);
      const experience = await this.service.updateMemoryExperience(
        parsed.role_id,
        parsed.experience_id,
        {
          ...(parsed.description !== undefined ? { description: parsed.description } : {}),
          ...(parsed.content !== undefined ? { content: parsed.content } : {}),
          ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
          ...(parsed.confidence !== undefined ? { confidence: parsed.confidence } : {}),
        },
      );
      return { experience };
    });
    dispatcher.register('memory.deleteExperience', async (params) => {
      const parsed = parseParams(experienceRefParamsSchema, params);
      await this.service.deleteMemoryExperience(parsed.role_id, parsed.experience_id);
      return { deleted: true };
    });
    dispatcher.register('memory.updatePersona', async (params) => {
      const parsed = parseParams(updatePersonaParamsSchema, params);
      const persona = await this.service.updateMemoryPersona(parsed.role_id, {
        ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
        ...(parsed.skills_overview !== undefined
          ? { skills_overview: parsed.skills_overview }
          : {}),
        ...(parsed.experience_coverage !== undefined
          ? { experience_coverage: parsed.experience_coverage }
          : {}),
        ...(parsed.recent_performance !== undefined
          ? { recent_performance: parsed.recent_performance }
          : {}),
        ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
      });
      return { persona };
    });
    dispatcher.register('memory.regeneratePersona', async (params) => {
      const parsed = parseParams(roleParamsSchema, params);
      const persona = await this.service.regenerateMemoryPersona(parsed.role_id);
      return { persona };
    });
    dispatcher.register('memory.rateTask', async (params) => {
      const parsed = parseParams(rateTaskParamsSchema, params);
      const result = await this.service.rateMemoryTask(
        parsed.role_id,
        parsed.task_id,
        parsed.rating,
        parsed.note,
      );
      return { rating: result };
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
