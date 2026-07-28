import path from 'node:path';
import { Pool } from 'pg';
import {
  FileBufferRepository,
  PgMemoryRepository,
  type BufferRepository,
  type MemoryRepository,
} from '../memory';

const MARKET_AGENT_CATALOG = [
  {
    role_id: 'role_fullstack_engineer',
    name: 'Full-stack Engineer',
    tags: ['market_eligible', 'fullstack'],
    persona_seed: 'Build coherent product features across backend and frontend boundaries.',
  },
  {
    role_id: 'role_ts_engineer',
    name: 'TypeScript Engineer',
    tags: ['market_eligible', 'typescript'],
    persona_seed: 'Build reliable TypeScript services with explicit contracts and tests.',
  },
] as const;

const COUNCIL_AGENT_CATALOG = [
  { role_id: 'proposer_a', name: 'Council Proposer A' },
  { role_id: 'proposer_b', name: 'Council Proposer B' },
  { role_id: 'reviewer', name: 'Council Reviewer' },
  { role_id: 'synthesizer', name: 'Council Synthesizer' },
] as const;

export interface BMemoryStorage {
  readonly repository: MemoryRepository;
  close(): Promise<void>;
}

export interface BackendBRuntime {
  readonly repository: MemoryRepository;
  readonly bufferRepository: BufferRepository;
  readonly app_state_root: string;
  readonly market_agent_ids: readonly string[];
  close(): Promise<void>;
}

export interface ProductionBRuntimeFactoryOptions {
  repoRoot?: string;
  appStateRoot?: string;
  createPool?: (databaseUrl: string) => Pool;
  /** Test or host-owned storage injection. Production uses PostgreSQL by default. */
  storage?: BMemoryStorage;
}

/**
 * Application composition root for B's public runtime contracts.
 * B owns its repository and buffer implementations; this module owns lifecycle and configuration.
 */
export async function createProductionBRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: ProductionBRuntimeFactoryOptions = {},
): Promise<BackendBRuntime> {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const appStateRoot = path.resolve(repoRoot, options.appStateRoot ?? '.newide');
  let storage: BMemoryStorage | undefined;

  if (!options.storage && !env.NEWIDE_B_DATABASE_URL?.trim()) {
    throw new Error('NEWIDE_B_DATABASE_URL is required for the production B runtime');
  }

  try {
    storage = options.storage ?? (await createPostgresStorage(env, options));
    const bufferRepository = new FileBufferRepository({
      agentStateRoot: path.join(appStateRoot, 'b', 'agent-state'),
    });
    await seedCatalog(storage.repository, bufferRepository);
    return {
      repository: storage.repository,
      bufferRepository,
      app_state_root: appStateRoot,
      market_agent_ids: MARKET_AGENT_CATALOG.map((agent) => agent.role_id),
      close: onceAsync(() => storage!.close()),
    };
  } catch {
    await storage?.close().catch(() => undefined);
    throw new Error('Production B runtime readiness check failed');
  }
}

async function createPostgresStorage(
  env: NodeJS.ProcessEnv,
  options: ProductionBRuntimeFactoryOptions,
): Promise<BMemoryStorage> {
  const databaseUrl = env.NEWIDE_B_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('NEWIDE_B_DATABASE_URL is required for the production B runtime');
  }

  const pool =
    options.createPool?.(databaseUrl) ??
    new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  const close = onceAsync(() => pool.end());
  try {
    const repository = new PgMemoryRepository({ pool });
    await repository.listAgentIds();
    return { repository, close };
  } catch {
    await close().catch(() => undefined);
    throw new Error('PostgreSQL B memory storage readiness check failed');
  }
}

async function seedCatalog(
  repository: MemoryRepository,
  bufferRepository: BufferRepository,
): Promise<void> {
  const existing = new Set(await repository.listAgentIds());
  for (const agent of MARKET_AGENT_CATALOG) {
    if (!existing.has(agent.role_id)) {
      await repository.initializeAgent({
        role_id: agent.role_id,
        name: agent.name,
        tags: [...agent.tags],
        persona_seed: agent.persona_seed,
      });
      existing.add(agent.role_id);
    }
  }
  for (const agent of COUNCIL_AGENT_CATALOG) {
    if (!existing.has(agent.role_id)) {
      await repository.initializeAgent({
        role_id: agent.role_id,
        name: agent.name,
        tags: ['council_only'],
        persona_seed: `${agent.name} participates only in isolated Council execution.`,
      });
      existing.add(agent.role_id);
    }
  }

  for (const roleId of [...existing].sort(compareCodeUnits)) {
    await bufferRepository.ensureAgent(roleId);
  }
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function onceAsync<T>(operation: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= Promise.resolve().then(operation));
}
