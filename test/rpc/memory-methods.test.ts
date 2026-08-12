import { describe, expect, it, vi } from 'vitest';
import { JsonRpcDispatcher, JsonRpcLineSession } from '../../src/rpc/json-rpc-dispatcher';
import { MemoryRpcMethods, type MemoryMethodsService } from '../../src/rpc/memory-methods';

describe('MemoryRpcMethods', () => {
  it('exposes B Agent, Experience, Skill, evidence, and promotion methods', async () => {
    const output: string[] = [];
    const promoteMemorySkills = vi.fn(async (roleId: string, requestedBy: string) => ({
      ...maintenance(),
      role_id: roleId,
      requested_by: requestedBy,
    }));
    const approveMemorySkill = vi.fn(async () => ({
      id: 'skill_1',
      review_status: 'approved',
      reviewed_by: 'reviewer',
    }) as never);
    const rejectMemorySkill = vi.fn(async () => ({
      id: 'skill_2',
      review_status: 'rejected',
      reviewed_by: 'reviewer',
    }) as never);
    const service = fakeService({ promoteMemorySkills, approveMemorySkill, rejectMemorySkill });
    const dispatcher = new JsonRpcDispatcher();
    new MemoryRpcMethods(service).register(dispatcher);
    const session = new JsonRpcLineSession(dispatcher, (line) => output.push(line));

    await session.handleLine(
      '{"jsonrpc":"2.0","id":0,"method":"memory.getCapabilities","params":{}}',
    );
    await session.handleLine('{"jsonrpc":"2.0","id":1,"method":"memory.listAgents","params":{}}');
    await session.handleLine(
      '{"jsonrpc":"2.0","id":2,"method":"memory.getAgent","params":{"role_id":"role_ts_engineer"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":3,"method":"memory.listExperiences","params":{"role_id":"role_ts_engineer"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":4,"method":"memory.listSkills","params":{"role_id":"role_ts_engineer"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":5,"method":"memory.listMaintenance","params":{"role_id":"role_ts_engineer"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":6,"method":"memory.promoteSkills","params":{"role_id":"role_ts_engineer","requested_by":"user"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":7,"method":"memory.approveSkill","params":{"role_id":"role_ts_engineer","skill_id":"skill_1","reviewed_by":"reviewer"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":8,"method":"memory.rejectSkill","params":{"role_id":"role_ts_engineer","skill_id":"skill_2","reviewed_by":"reviewer"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":9,"method":"memory.listSkills","params":{"role_id":"role_ts_engineer","extra":true}}',
    );

    expect(output.map((line) => JSON.parse(line))).toMatchObject([
      {
        id: 0,
        result: {
          capabilities: {
            embedding: { provider: 'test', model: 'test-embedding', dimensions: 4 },
            operations: {
              list_experiences: { status: 'available' },
              approve_skill: {
                status: 'available',
              },
              update_persona: {
                status: 'unavailable',
                reason: expect.any(String),
              },
            },
          },
        },
      },
      { id: 1, result: { agents: [{ role_id: 'role_ts_engineer' }] } },
      { id: 2, result: { agent: { role_id: 'role_ts_engineer' } } },
      { id: 3, result: { experiences: [{ id: 'experience_1' }] } },
      { id: 4, result: { skills: [{ id: 'skill_1' }] } },
      { id: 5, result: { maintenance: [{ maintenance_ref: 'b_maintenance_1' }] } },
      { id: 6, result: { maintenance: { requested_by: 'user' } } },
      { id: 7, result: { skill: { id: 'skill_1', review_status: 'approved' } } },
      { id: 8, result: { skill: { id: 'skill_2', review_status: 'rejected' } } },
      { id: 9, error: { code: -32602, message: 'Invalid params' } },
    ]);
    expect(promoteMemorySkills).toHaveBeenCalledWith('role_ts_engineer', 'user');
    expect(approveMemorySkill).toHaveBeenCalledWith(
      'role_ts_engineer',
      'skill_1',
      'reviewer',
    );
    expect(rejectMemorySkill).toHaveBeenCalledWith(
      'role_ts_engineer',
      'skill_2',
      'reviewer',
    );
  });
});

function fakeService(overrides: Partial<MemoryMethodsService> = {}): MemoryMethodsService {
  return {
    getMemoryCapabilities: () => ({
      schema_version: 'newide.b-memory-capabilities.v1',
      embedding: {
        provider: 'test',
        model: 'test-embedding',
        dimensions: 4,
        readiness: 'verified',
      },
      operations: {
        list_agents: { status: 'available' },
        get_agent_persona: { status: 'available' },
        list_experiences: { status: 'available' },
        list_skills: { status: 'available' },
        list_maintenance: { status: 'available' },
        promote_skills: { status: 'available' },
        approve_skill: { status: 'available' },
        reject_skill: { status: 'available' },
        update_persona: { status: 'unavailable', reason: 'not exposed' },
      },
    }),
    listMemoryAgents: async () => [
      {
        role_id: 'role_ts_engineer',
        name: 'TypeScript Engineer',
        status: 'active',
        tags: ['typescript'],
        skill_count: 1,
        experience_count: 1,
        persona_summary: 'Build TypeScript services.',
      },
    ],
    getMemoryAgent: async () => ({
      role_id: 'role_ts_engineer',
      name: 'TypeScript Engineer',
      status: 'active',
      tags: ['typescript'],
      skill_count: 1,
      experience_count: 1,
      persona: {} as never,
      metrics: {} as never,
      created_at: '2026-07-21T00:00:00.000Z',
    }),
    listMemorySkills: async () => [{ id: 'skill_1' } as never],
    listMemoryExperiences: async () => [{ id: 'experience_1' } as never],
    listMemoryMaintenance: async () => [maintenance()],
    promoteMemorySkills: async () => maintenance(),
    approveMemorySkill: async () => ({ id: 'skill_1' } as never),
    rejectMemorySkill: async () => ({ id: 'skill_1' } as never),
    ...overrides,
  };
}

function maintenance() {
  return {
    maintenance_ref: 'b_maintenance_1',
    kind: 'experience_extraction' as const,
    status: 'completed' as const,
    role_id: 'role_ts_engineer',
    experiences: [],
    skills: [],
    warnings: [],
    created_at: '2026-07-21T00:00:00.000Z',
    completed_at: '2026-07-21T00:00:01.000Z',
    schema_version: 'v0',
  };
}
