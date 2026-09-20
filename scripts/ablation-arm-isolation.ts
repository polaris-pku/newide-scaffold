/**
 * 消融臂隔离：每个臂一套独立的本地记忆数据目录。
 *
 * 隔离单元是 PGlite 数据目录（而不是共享 Postgres 服务器上的 schema）：每臂拿到
 * `<experiment_root>/<arm>/pglite` 与 `<experiment_root>/<arm>/state`，臂之间不共享
 * 任何记忆状态，因此也不需要外部 Postgres。
 *
 * 目录已存在时默认直接报错，避免某个臂静默复用上一次实验留下的记忆；
 * 确实要续跑同一个臂时，显式设置 NEWIDE_ABLATION_ALLOW_EXISTING_MEMORY=1。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface AblationArmIsolation {
  pglite_data_dir: string;
  state_root: string;
}

export interface AblationMaintenanceEvidence {
  maintenance_ref: string;
  status: string;
}

export async function prepareAblationArmIsolation(input: {
  experiment_root: string;
  arm: string;
}): Promise<AblationArmIsolation> {
  const armRoot = path.join(input.experiment_root, input.arm);
  const pgliteDataDir = path.join(armRoot, 'pglite');
  if (await pathExists(pgliteDataDir)) {
    if (!allowExistingMemory()) {
      throw new Error(
        `Ablation arm "${input.arm}" already has memory at ${pgliteDataDir}. ` +
          'Remove it for a clean arm, or set NEWIDE_ABLATION_ALLOW_EXISTING_MEMORY=1 to resume.',
      );
    }
  } else {
    await fs.mkdir(pgliteDataDir, { recursive: true });
  }

  return {
    pglite_data_dir: pgliteDataDir,
    state_root: path.join(armRoot, 'state'),
  };
}

/** 旧名 NEWIDE_ABLATION_ALLOW_EXISTING_SCHEMA 来自 Postgres-schema 时代，继续认。 */
function allowExistingMemory(): boolean {
  const value =
    process.env.NEWIDE_ABLATION_ALLOW_EXISTING_MEMORY ??
    process.env.NEWIDE_ABLATION_ALLOW_EXISTING_SCHEMA;
  return value === '1' || value === 'true';
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function waitForRunMaintenance(
  request: <T>(method: string, params: unknown) => Promise<T>,
  runId: string,
  timeoutMs: number,
): Promise<AblationMaintenanceEvidence> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await request<{ maintenance?: unknown }>('memory.listMaintenance', {});
    const maintenance = Array.isArray(result.maintenance)
      ? result.maintenance.find(
          (item): item is AblationMaintenanceEvidence & { run_id: string } =>
            typeof item === 'object' &&
            item !== null &&
            (item as { run_id?: unknown }).run_id === runId &&
            typeof (item as { maintenance_ref?: unknown }).maintenance_ref === 'string' &&
            typeof (item as { status?: unknown }).status === 'string',
        )
      : undefined;
    if (maintenance && ['completed', 'skipped', 'failed'].includes(maintenance.status)) {
      return maintenance;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Memory maintenance for run ${runId} did not finish within ${String(timeoutMs)}ms`,
  );
}
