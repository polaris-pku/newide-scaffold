import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { SweEvoInstance } from './types';

export async function loadDataset(jsonlPath: string): Promise<SweEvoInstance[]> {
  const rows: SweEvoInstance[] = [];
  const stream = createReadStream(jsonlPath, { encoding: 'utf-8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    rows.push(JSON.parse(trimmed) as SweEvoInstance);
  }

  return rows;
}

export function indexDatasetById(instances: SweEvoInstance[]): Map<string, SweEvoInstance> {
  return new Map(instances.map((instance) => [instance.instance_id, instance]));
}

export function getInstanceOrThrow(
  instances: Map<string, SweEvoInstance>,
  instanceId: string,
): SweEvoInstance {
  const instance = instances.get(instanceId);
  if (!instance) {
    throw new Error(`Instance not found in dataset: ${instanceId}`);
  }
  return instance;
}
