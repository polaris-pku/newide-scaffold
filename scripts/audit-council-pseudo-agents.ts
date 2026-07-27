import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  collectLegacyCouncilInventory,
  sha256Json,
  timeRange,
} from './council-legacy-agent-data';

const inventory = await collectLegacyCouncilInventory();
const report = {
  schema_version: inventory.schema_version,
  generated_at: inventory.generated_at,
  known_legacy_agent_ids: inventory.known_legacy_agent_ids,
  absent_agent_ids: inventory.absent_agent_ids,
  same_id_non_legacy_agents: inventory.same_id_non_legacy_agents,
  agents: inventory.agents.map((snapshot) => ({
    role_id: snapshot.agent.role_id,
    name: snapshot.agent.name,
    status: snapshot.agent.status,
    tags: snapshot.agent.tags,
    persona_version: snapshot.agent.persona.version,
    skill_count: snapshot.skills.length,
    experience_count: snapshot.experiences.length,
    skill_time_range: timeRange(snapshot.skills),
    experience_time_range: timeRange(snapshot.experiences),
    persona_sha256: sha256Json(snapshot.agent.persona),
    skills_sha256: sha256Json(snapshot.skills),
    experiences_sha256: sha256Json(snapshot.experiences),
  })),
};
const outputPath = path.resolve(
  readOutputPath(process.argv.slice(2)) ??
    path.join(
      '.newide',
      'migrations',
      'council-legacy',
      `inventory-${fileTimestamp(inventory.generated_at)}.json`,
    ),
);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(report, null, 2), 'utf-8');

console.log(`Council legacy inventory: ${outputPath}`);
console.log(`legacy agents found: ${String(report.agents.length)}`);
console.log(`legacy agents absent: ${String(report.absent_agent_ids.length)}`);
console.log(`same-id non-legacy agents preserved: ${String(report.same_id_non_legacy_agents.length)}`);

function readOutputPath(args: string[]): string | undefined {
  const index = args.indexOf('--out');
  if (index === -1) return undefined;
  const value = args[index + 1]?.trim();
  if (!value) throw new Error('--out requires a file path');
  return value;
}

function fileTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, '-');
}

