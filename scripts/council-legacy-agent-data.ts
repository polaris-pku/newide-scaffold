import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import {
  PgMemoryRepository,
  RepositoryAgentBoardQuery,
  type AgentBoardAgentView,
  type AgentBoardListItem,
  type EmbeddingProvider,
  type ExperienceView,
  type SkillView,
} from '../src/memory';
import {
  LEGACY_COUNCIL_AGENT_IDS,
  isLegacyCouncilPseudoAgent,
} from '../src/app/council-legacy-agent-filter';

export interface LegacyCouncilAgentSnapshot {
  summary: AgentBoardListItem;
  agent: AgentBoardAgentView;
  skills: SkillView[];
  experiences: ExperienceView[];
}

export interface LegacyCouncilInventory {
  schema_version: 'newide.council-legacy-inventory.v1';
  generated_at: string;
  known_legacy_agent_ids: readonly string[];
  absent_agent_ids: string[];
  same_id_non_legacy_agents: Array<{ role_id: string; tags: string[] | undefined }>;
  agents: LegacyCouncilAgentSnapshot[];
}

const readOnlyEmbedding: EmbeddingProvider = {
  dimensions: 1,
  async embed() {
    throw new Error('Read-only Council legacy audit must not invoke embeddings');
  },
};

export async function collectLegacyCouncilInventory(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LegacyCouncilInventory> {
  const databaseUrl = env.NEWIDE_B_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('NEWIDE_B_DATABASE_URL is required for Council legacy audit');
  }
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  try {
    const repository = new PgMemoryRepository({ pool, embedding: readOnlyEmbedding });
    const board = new RepositoryAgentBoardQuery(repository);
    const listed = await board.listAgents();
    const byId = new Map(listed.map((agent) => [agent.role_id, agent] as const));
    const absentAgentIds: string[] = [];
    const sameIdNonLegacyAgents: Array<{
      role_id: string;
      tags: string[] | undefined;
    }> = [];
    const agents: LegacyCouncilAgentSnapshot[] = [];

    for (const roleId of LEGACY_COUNCIL_AGENT_IDS) {
      const summary = byId.get(roleId);
      if (!summary) {
        absentAgentIds.push(roleId);
        continue;
      }
      if (!isLegacyCouncilPseudoAgent(summary)) {
        sameIdNonLegacyAgents.push({ role_id: roleId, tags: summary.tags });
        continue;
      }
      const [agent, skills, experiences] = await Promise.all([
        board.getAgent(roleId),
        board.listSkills(roleId),
        board.listExperiences(roleId),
      ]);
      agents.push({
        summary,
        agent,
        skills: [...skills].sort((left, right) => compareCodeUnits(left.id, right.id)),
        experiences: [...experiences].sort((left, right) =>
          compareCodeUnits(left.id, right.id),
        ),
      });
    }

    return {
      schema_version: 'newide.council-legacy-inventory.v1',
      generated_at: new Date().toISOString(),
      known_legacy_agent_ids: LEGACY_COUNCIL_AGENT_IDS,
      absent_agent_ids: absentAgentIds,
      same_id_non_legacy_agents: sameIdNonLegacyAgents,
      agents,
    };
  } finally {
    await pool.end();
  }
}

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function timeRange(
  records: readonly { created_at: string; updated_at?: string }[],
): { earliest: string; latest: string } | undefined {
  const timestamps = records.flatMap((record) => [
    record.created_at,
    ...(record.updated_at ? [record.updated_at] : []),
  ]);
  if (timestamps.length === 0) return undefined;
  return {
    earliest: [...timestamps].sort(compareCodeUnits)[0]!,
    latest: [...timestamps].sort(compareCodeUnits).at(-1)!,
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, child]) => [key, sortObjectKeys(child)]),
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

