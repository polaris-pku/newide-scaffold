import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  collectLegacyCouncilInventory,
  sha256Json,
} from './council-legacy-agent-data';

interface ExportRecord {
  schema_version: 'newide.council-legacy-export.v1';
  exported_at: string;
  source_agent_id: string;
  record_type: 'agent' | 'persona' | 'skill' | 'experience';
  record_id: string;
  sha256: string;
  payload: unknown;
}

const inventory = await collectLegacyCouncilInventory();
const records = inventory.agents.flatMap((snapshot): ExportRecord[] => {
  const common = {
    schema_version: 'newide.council-legacy-export.v1' as const,
    exported_at: inventory.generated_at,
    source_agent_id: snapshot.agent.role_id,
  };
  return [
    exportRecord(common, 'agent', snapshot.agent.role_id, snapshot.summary),
    exportRecord(
      common,
      'persona',
      `${snapshot.agent.role_id}:persona:${String(snapshot.agent.persona.version)}`,
      snapshot.agent.persona,
    ),
    ...snapshot.skills.map((skill) => exportRecord(common, 'skill', skill.id, skill)),
    ...snapshot.experiences.map((experience) =>
      exportRecord(common, 'experience', experience.id, experience),
    ),
  ];
});
const outputPath = path.resolve(
  readOutputPath(process.argv.slice(2)) ??
    path.join(
      '.newide',
      'migrations',
      'council-legacy',
      `export-${fileTimestamp(inventory.generated_at)}.jsonl`,
    ),
);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(
  outputPath,
  records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''),
  'utf-8',
);

console.log(`Council legacy export: ${outputPath}`);
console.log(`records exported: ${String(records.length)}`);
console.log('No database records were updated or deleted.');

function exportRecord(
  common: Pick<ExportRecord, 'schema_version' | 'exported_at' | 'source_agent_id'>,
  recordType: ExportRecord['record_type'],
  recordId: string,
  payload: unknown,
): ExportRecord {
  return {
    ...common,
    record_type: recordType,
    record_id: recordId,
    sha256: sha256Json(payload),
    payload,
  };
}

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
