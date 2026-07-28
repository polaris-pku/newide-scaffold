/** memory.* JSON-RPC methods backed by B's public board and application maintenance services. */
import { z } from 'zod';
import type { BMemoryMaintenanceEvidence } from '../app/b-memory-maintenance-runner';
import type {
  AgentBoardAgentView,
  AgentBoardListItem,
  ExperienceView,
  SkillView,
} from '../memory';
import { JsonRpcMethodError, type JsonRpcDispatcher } from './json-rpc-dispatcher';
import { JSON_RPC_ERROR_CODES } from './json-rpc-line-protocol';

export interface MemoryMethodsService {
  listMemoryAgents(): Promise<AgentBoardListItem[]>;
  getMemoryAgent(roleId: string): Promise<AgentBoardAgentView>;
  listMemorySkills(roleId: string): Promise<SkillView[]>;
  listMemoryExperiences(roleId: string): Promise<ExperienceView[]>;
  listMemoryMaintenance(roleId?: string): Promise<BMemoryMaintenanceEvidence[]>;
  promoteMemorySkills(roleId: string, requestedBy: string): Promise<BMemoryMaintenanceEvidence>;
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

export class MemoryRpcMethods {
  constructor(private readonly service: MemoryMethodsService) {}

  register(dispatcher: JsonRpcDispatcher): void {
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
  }
}

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new JsonRpcMethodError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params');
  }
  return parsed.data;
}
