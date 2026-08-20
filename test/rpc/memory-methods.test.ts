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
    const marketSearchMemorySkills = vi.fn(async () => [marketSkill()]);
    const marketImportMemorySkill = vi.fn(
      async (roleId: string, sourceSkillId: string) => ({
        imported: { ...marketSkill(), id: 'skill_imported' },
        source: { ...marketSkill(), id: sourceSkillId },
        created: true,
      }),
    );
    const retireMemoryAgent = vi.fn(
      async (roleId: string, options: { reason?: string; replacement?: string }) => ({
        role_id: roleId,
        status: 'retired' as const,
        retired_at: '2026-07-21T00:00:00.000Z',
        retired_reason: (options.reason ?? 'manual') as
          | 'performance_degradation'
          | 'inactivity'
          | 'persona_drift'
          | 'manual'
          | 'split',
        asset_disposition: {
          skills_retained: 0,
          skills_discarded: 0,
          experiences_retained: 0,
          experiences_discarded: 0,
        },
      }),
    );
    const runRetirementScan = vi.fn(async (roleId?: string) => [
      scanResult({ role_id: roleId ?? 'role_ts_engineer' }),
    ]);
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
    
    const service = fakeService({
      promoteMemorySkills,
      marketSearchMemorySkills,
      marketImportMemorySkill,
      retireMemoryAgent,
      runRetirementScan,
      approveMemorySkill,
      rejectMemorySkill,
    });
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
    await session.handleLine(
      '{"jsonrpc":"2.0","id":10,"method":"memory.marketSearch","params":{"query":"typescript","top_k":5,"exclude_agent_id":"role_ts_engineer"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":11,"method":"memory.marketImport","params":{"role_id":"role_ts_engineer","source_skill_id":"skill_source"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":12,"method":"memory.retireAgent","params":{"role_id":"role_ts_engineer","reason":"performance_degradation","replacement":"seeded_slate"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":13,"method":"memory.retireAgent","params":{"role_id":"role_ts_engineer","reason":"bogus"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":14,"method":"memory.retirementScan","params":{}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":15,"method":"memory.retirementScan","params":{"role_id":"role_ts_engineer"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":16,"method":"memory.retirementScan","params":{"role_id":"","extra":true}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":17,"method":"memory.createAgent","params":{"role_id":"role_new","name":"New Agent","tags":["typescript"],"persona_seed":"Build TS services."}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":18,"method":"memory.createAgent","params":{"role_id":"role_new"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":19,"method":"memory.updateAgent","params":{"role_id":"role_ts_engineer","tags":["typescript","reviewer"]}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":20,"method":"memory.updateAgent","params":{"role_id":"role_ts_engineer"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":21,"method":"memory.deleteAgent","params":{"role_id":"role_ts_engineer","confirm":true}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":22,"method":"memory.deleteAgent","params":{"role_id":"role_ts_engineer","confirm":false}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":23,"method":"memory.createSkill","params":{"role_id":"role_ts_engineer","description":"TS patterns","content":"Define contracts.","tags":["typescript"]}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":24,"method":"memory.createSkill","params":{"role_id":"role_ts_engineer","description":"TS patterns"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":25,"method":"memory.updateSkill","params":{"role_id":"role_ts_engineer","skill_id":"skill_1","tags":["typescript","reviewer"]}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":26,"method":"memory.updateSkill","params":{"role_id":"role_ts_engineer","skill_id":"skill_1","market_status":"bogus"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":27,"method":"memory.publishSkillToMarket","params":{"role_id":"role_ts_engineer","skill_id":"skill_1"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":28,"method":"memory.deleteSkill","params":{"role_id":"role_ts_engineer","skill_id":"skill_1"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":29,"method":"memory.updateExperience","params":{"role_id":"role_ts_engineer","experience_id":"experience_1","confidence":0.9}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":30,"method":"memory.updateExperience","params":{"role_id":"role_ts_engineer","experience_id":"experience_1"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":31,"method":"memory.deleteExperience","params":{"role_id":"role_ts_engineer","experience_id":"experience_1"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":32,"method":"memory.updatePersona","params":{"role_id":"role_ts_engineer","summary":"New persona summary"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":33,"method":"memory.updatePersona","params":{"role_id":"role_ts_engineer"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":34,"method":"memory.regeneratePersona","params":{"role_id":"role_ts_engineer"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":35,"method":"memory.regeneratePersona","params":{"role_id":""}}',
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
                status: 'available',
              },
              regenerate_persona: { status: 'available' },
              create_agent: { status: 'available' },
              update_agent: { status: 'available' },
              delete_agent: { status: 'available' },
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
      { id: 10, result: { skills: [{ id: 'skill_market_1' }] } },
      { id: 11, result: { import: { imported: { id: 'skill_imported' }, created: true } } },
      {
        id: 12,
        result: {
          retire: {
            role_id: 'role_ts_engineer',
            status: 'retired',
            retired_reason: 'performance_degradation',
          },
        },
      },
      { id: 13, error: { code: -32602, message: 'Invalid params' } },
      { id: 14, result: { scans: [scanResult({ role_id: 'role_ts_engineer' })] } },
      { id: 15, result: { scans: [scanResult({ role_id: 'role_ts_engineer' })] } },
      { id: 16, error: { code: -32602, message: 'Invalid params' } },
      { id: 17, result: { agent: { role_id: 'role_ts_engineer' } } },
      { id: 18, error: { code: -32602, message: 'Invalid params' } },
      { id: 19, result: { agent: { role_id: 'role_ts_engineer' } } },
      { id: 20, error: { code: -32602, message: 'Invalid params' } },
      { id: 21, result: { deleted: true } },
      { id: 22, error: { code: -32602, message: 'Invalid params' } },
      { id: 23, result: { skill: { id: 'skill_1' } } },
      { id: 24, error: { code: -32602, message: 'Invalid params' } },
      { id: 25, result: { skill: { id: 'skill_1' } } },
      { id: 26, error: { code: -32602, message: 'Invalid params' } },
      { id: 27, result: { skill: { id: 'skill_1' } } },
      { id: 28, result: { deleted: true } },
      { id: 29, result: { experience: { id: 'experience_1' } } },
      { id: 30, error: { code: -32602, message: 'Invalid params' } },
      { id: 31, result: { deleted: true } },
      { id: 32, result: { persona: { version: 2 } } },
      { id: 33, error: { code: -32602, message: 'Invalid params' } },
      { id: 34, result: { persona: { version: 2 } } },
      { id: 35, error: { code: -32602, message: 'Invalid params' } },
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
    expect(marketSearchMemorySkills).toHaveBeenCalledWith({
      query: 'typescript',
      top_k: 5,
      exclude_agent_id: 'role_ts_engineer',
    });
    expect(marketImportMemorySkill).toHaveBeenCalledWith('role_ts_engineer', 'skill_source');
    expect(retireMemoryAgent).toHaveBeenCalledWith('role_ts_engineer', {
      reason: 'performance_degradation',
      replacement: 'seeded_slate',
    });
    expect(runRetirementScan).toHaveBeenCalledTimes(2);
    expect(runRetirementScan).toHaveBeenLastCalledWith('role_ts_engineer');
  });
});

function fakeService(overrides: Partial<MemoryMethodsService> = {}): MemoryMethodsService {
  return {
    getMemoryCapabilities: () => ({
      schema_version: 'newide.b-memory-capabilities.v1',
      skill_review: { mode: 'manual' },
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
        update_persona: { status: 'available' },
        regenerate_persona: { status: 'available' },
        market_search: { status: 'available' },
        market_import: { status: 'available' },
        retire_agent: { status: 'available' },
        retirement_scan: { status: 'available' },
        create_agent: { status: 'available' },
        update_agent: { status: 'available' },
        delete_agent: { status: 'available' },
        create_skill: { status: 'available' },
        update_skill: { status: 'available' },
        delete_skill: { status: 'available' },
        publish_skill: { status: 'available' },
        update_experience: { status: 'available' },
        delete_experience: { status: 'available' },
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
    marketSearchMemorySkills: async () => [marketSkill()],
    marketImportMemorySkill: async () => ({
      imported: marketSkill(),
      source: marketSkill(),
      created: true,
    }),
    retireMemoryAgent: async () => ({
      role_id: 'role_ts_engineer',
      status: 'retired',
      retired_at: '2026-07-21T00:00:00.000Z',
      retired_reason: 'manual',
      asset_disposition: {
        skills_retained: 0,
        skills_discarded: 0,
        experiences_retained: 0,
        experiences_discarded: 0,
      },
    }),
    runRetirementScan: async () => [scanResult()],
    approveMemorySkill: async () => ({ id: 'skill_1' } as never),
    rejectMemorySkill: async () => ({ id: 'skill_1' } as never),
    createMemoryAgent: async (spec) => ({
      role_id: spec.role_id,
      name: spec.name,
      status: 'created',
      skill_count: 0,
      experience_count: 0,
      persona: {} as never,
      metric: {} as never,
      created_at: '2026-07-21T00:00:00.000Z',
      owned_skills: [],
      owned_exps: [],
    }),
    updateMemoryAgent: async (roleId) => ({
      role_id: roleId,
      name: 'TypeScript Engineer',
      status: 'active',
      skill_count: 1,
      experience_count: 1,
      persona: {} as never,
      metric: {} as never,
      created_at: '2026-07-21T00:00:00.000Z',
      owned_skills: [],
      owned_exps: [],
    }),
    deleteMemoryAgent: async () => undefined,
    createMemorySkill: async () => ({ id: 'skill_1' } as never),
    updateMemorySkill: async () => ({ id: 'skill_1' } as never),
    deleteMemorySkill: async () => undefined,
    publishMemorySkillToMarket: async () => ({ id: 'skill_1' } as never),
    updateMemoryExperience: async () => ({ id: 'experience_1' } as never),
    deleteMemoryExperience: async () => undefined,
    updateMemoryPersona: async () => ({
      role_id: 'role_ts_engineer',
      version: 2,
      summary: 'New persona summary',
      skills_overview: '',
      experience_coverage: '',
      recent_performance: '',
      notes: '',
      generated_at: '2026-07-21T00:00:00.000Z',
    }),
    regenerateMemoryPersona: async () => ({
      role_id: 'role_ts_engineer',
      version: 2,
      summary: 'Regenerated',
      skills_overview: '',
      experience_coverage: '',
      recent_performance: '',
      notes: '',
      generated_at: '2026-07-21T00:00:00.000Z',
    }),
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

function marketSkill() {
  return {
    id: 'skill_market_1',
    description: 'TypeScript service patterns',
    description_embedding: [0.1, 0.2, 0.3, 0.4],
    content: 'Define explicit contracts and tests.',
    version: '1.0.0',
    review_status: 'approved' as const,
    tags: ['typescript'],
    promoted_at: '2026-07-21T00:00:00.000Z',
    agent_id: 'role_ts_engineer',
    created_at: '2026-07-21T00:00:00.000Z',
    updated_at: '2026-07-21T00:00:00.000Z',
  };
}

function scanResult(overrides: { role_id?: string; action?: 'retire' | 'warn' | 'keep' } = {}) {
  return {
    scan_id: 'scan_1',
    role_id: overrides.role_id ?? 'role_ts_engineer',
    scanned_at: '2026-07-21T00:00:00.000Z',
    action: overrides.action ?? 'keep',
    confidence: 0.9,
    reasons: ['Statistical signals are healthy.'],
    layers: [
      {
        layer: 'statistical' as const,
        action: (overrides.action ?? 'keep') as 'retire' | 'warn' | 'keep',
        confidence: 0.9,
        reasons: ['Statistical signals are healthy.'],
      },
    ],
  };
}
