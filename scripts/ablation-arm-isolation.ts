import path from 'node:path';
import { Pool } from 'pg';

export interface AblationArmIsolation {
  database_url: string;
  database_schema: string;
  state_root: string;
}

export interface AblationMaintenanceEvidence {
  maintenance_ref: string;
  status: string;
}

export async function prepareAblationArmIsolation(input: {
  experiment_root: string;
  arm: string;
  database_url: string;
}): Promise<AblationArmIsolation> {
  const databaseSchema = buildAblationSchemaName(input.experiment_root, input.arm);
  await ensureDatabaseExists(input.database_url);
  const pool = new Pool({
    connectionString: input.database_url,
    connectionTimeoutMillis: 10_000,
  });
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
    // No IF NOT EXISTS on purpose: a colliding schema name means the arm would
    // share state with an earlier run, which silently breaks isolation.
    await pool.query(`CREATE SCHEMA ${quoteIdentifier(databaseSchema)}`);
  } finally {
    await pool.end();
  }

  return {
    database_url: withSearchPath(input.database_url, databaseSchema),
    database_schema: databaseSchema,
    state_root: path.join(input.experiment_root, input.arm, 'state'),
  };
}

export function buildAblationSchemaName(experimentRoot: string, arm: string): string {
  const normalizedRoot = experimentRoot.replace(/[\\/]+$/g, '');
  const experiment = normalizedRoot.split(/[\\/]/).at(-1) ?? path.basename(path.resolve(experimentRoot));
  const normalized = `eval_${experiment}_${arm}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_');
  return normalized.slice(0, 63).replace(/_+$/g, '');
}

export function withSearchPath(databaseUrl: string, schema: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(`Invalid PostgreSQL schema name: ${schema}`);
  }
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-csearch_path=${schema},public`);
  return url.toString();
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

/** Create the target database (e.g. newide_b0) if it does not exist yet. */
async function ensureDatabaseExists(databaseUrl: string): Promise<void> {
  const probe = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    max: 1,
  });
  try {
    await probe.query('SELECT 1');
    return;
  } catch (error) {
    // 3D000 = invalid_catalog_name (database does not exist)
    if ((error as { code?: string }).code !== '3D000') throw error;
  } finally {
    await probe.end();
  }

  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!/^[a-z_][a-z0-9_]*$/.test(databaseName)) {
    throw new Error(`Refusing to auto-create database with unexpected name: ${databaseName}`);
  }
  url.pathname = '/postgres';
  url.search = '';
  const admin = new Pool({
    connectionString: url.toString(),
    connectionTimeoutMillis: 10_000,
    max: 1,
  });
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } catch (error) {
    // 42P04 = duplicate_database (lost a race with a parallel arm; fine)
    if ((error as { code?: string }).code !== '42P04') throw error;
  } finally {
    await admin.end();
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
