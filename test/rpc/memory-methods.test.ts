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
    const service = fakeService({
      promoteMemorySkills,
      marketSearchMemorySkills,
      marketImportMemorySkill,
      retireMemoryAgent,
      runRetirementScan,
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
      '{"jsonrpc":"2.0","id":7,"method":"memory.listSkills","params":{"role_id":"role_ts_engineer","extra":true}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":8,"method":"memory.marketSearch","params":{"query":"typescript","top_k":5,"exclude_agent_id":"role_ts_engineer"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":9,"method":"memory.marketImport","params":{"role_id":"role_ts_engineer","source_skill_id":"skill_source"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":10,"method":"memory.retireAgent","params":{"role_id":"role_ts_engineer","reason":"performance_degradation","replacement":"seeded_slate"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":11,"method":"memory.retireAgent","params":{"role_id":"role_ts_engineer","reason":"bogus"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":12,"method":"memory.retirementScan","params":{}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":13,"method":"memory.retirementScan","params":{"role_id":"role_ts_engineer"}}',
    );
    await session.handleLine(
      '{"jsonrpc":"2.0","id":14,"method":"memory.retirementScan","params":{"role_id":"","extra":true}}',
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
                status: 'unavailable',
                reason: expect.any(String),
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
      { id: 7, error: { code: -32602, message: 'Invalid params' } },
      { id: 8, result: { skills: [{ id: 'skill_market_1' }] } },
      { id: 9, result: { import: { imported: { id: 'skill_imported' }, created: true } } },
      {
        id: 10,
        result: {
          retire: {
            role_id: 'role_ts_engineer',
            status: 'retired',
            retired_reason: 'performance_degradation',
          },
        },
      },
      { id: 11, error: { code: -32602, message: 'Invalid params' } },
      { id: 12, result: { scans: [scanResult({ role_id: 'role_ts_engineer' })] } },
      { id: 13, result: { scans: [scanResult({ role_id: 'role_ts_engineer' })] } },
      { id: 14, error: { code: -32602, message: 'Invalid params' } },
    ]);
    expect(promoteMemorySkills).toHaveBeenCalledWith('role_ts_engineer', 'user');
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
        approve_skill: { status: 'unavailable', reason: 'not exposed' },
        reject_skill: { status: 'unavailable', reason: 'not exposed' },
        update_persona: { status: 'unavailable', reason: 'not exposed' },
        market_search: { status: 'available' },
        market_import: { status: 'available' },
        retire_agent: { status: 'available' },
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
