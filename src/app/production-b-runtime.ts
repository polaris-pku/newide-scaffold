import path from 'node:path';
import { Pool } from 'pg';
import { LiteLLMClient } from '../litellm';
import {
  FileBufferRepository,
  HashEmbeddingProvider,
  LiteLLMEmbeddingProvider,
  PgMemoryRepository,
  type BufferRepository,
  type EmbeddingProvider,
  type MemoryRepository,
} from '../memory';

/** HashEmbeddingProvider 的原生维度，与库中既有 vector(32) 一致。 */
const HASH_EMBEDDING_DIMENSIONS = 32;

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
  {
    role_id: 'role_code_reviewer',
    name: 'Code Reviewer',
    tags: ['market_eligible', 'reviewer'],
    persona_seed:
      'Critically review proposed solutions for correctness, edge cases, and test coverage.',
  },
  {
    role_id: 'role_synthesis_engineer',
    name: 'Synthesis Engineer',
    tags: ['market_eligible', 'synthesis'],
    persona_seed: 'Synthesize the strongest final answer from proposals and reviews.',
  },
] as const;

export interface BMemoryStorage {
  readonly repository: MemoryRepository;
  readonly embedding?: EmbeddingProvider;
  readonly embedding_info?: BEmbeddingRuntimeInfo;
  close(): Promise<void>;
}

export interface BEmbeddingRuntimeInfo {
  readonly provider: string;
  readonly task?: string;
  readonly model?: string;
  readonly dimensions?: number;
  readonly readiness: 'verified' | 'host_managed';
}

export interface BackendBRuntime {
  readonly repository: MemoryRepository;
  readonly bufferRepository: BufferRepository;
  readonly embedding?: EmbeddingProvider;
  readonly app_state_root: string;
  readonly market_agent_ids: readonly string[];
  readonly embedding_info: BEmbeddingRuntimeInfo;
  close(): Promise<void>;
}

export interface ProductionBRuntimeFactoryOptions {
  repoRoot?: string;
  appStateRoot?: string;
  createPool?: (databaseUrl: string) => Pool;
  /** Host-owned semantic embedding injection. Production defaults to LiteLLM. */
  embedding?: EmbeddingProvider;
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
      ...(storage.embedding ? { embedding: storage.embedding } : {}),
      app_state_root: appStateRoot,
      market_agent_ids: MARKET_AGENT_CATALOG.map((agent) => agent.role_id),
      embedding_info: storage.embedding_info ?? {
        provider: 'host-managed repository',
        readiness: 'host_managed',
      },
      close: onceAsync(() => storage!.close()),
    };
  } catch (error) {
    await storage?.close().catch(() => undefined);
    throw operationalError('Production B runtime readiness check failed', error);
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
    const embedding = resolveProductionEmbedding(env, options);
    await verifyEmbeddingReadiness(embedding.provider);
    const repository = new PgMemoryRepository({ pool, embedding: embedding.provider });
    await repository.listAgentIds();
    return {
      repository,
      embedding: embedding.provider,
      close,
      embedding_info: embedding.info,
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw operationalError(
      'PostgreSQL B memory storage readiness check failed',
      error,
      databaseUrl,
    );
  }
}

function resolveProductionEmbedding(
  env: NodeJS.ProcessEnv,
  options: ProductionBRuntimeFactoryOptions,
): { provider: EmbeddingProvider; info: BEmbeddingRuntimeInfo } {
  if (options.embedding) {
    return {
      provider: options.embedding,
      info: {
        provider: 'host-injected EmbeddingProvider',
        dimensions: options.embedding.dimensions,
        readiness: 'verified',
      },
    };
  }

  // NEWIDE_B_EMBEDDING_PROVIDER=hash：确定性哈希向量，不调用任何外部 embedding 服务。
  // 用途是本地跑通协调链路（checkpoint / resume / 多 agent），此时语义检索质量无关紧要。
  // 注意维度必须与库中 description_embedding vector(N) 一致，否则写入会被 pgvector 拒绝。
  if (env.NEWIDE_B_EMBEDDING_PROVIDER?.trim() === 'hash') {
    const dimensions = readEmbeddingDimensions(env, HASH_EMBEDDING_DIMENSIONS);
    return {
      provider: new HashEmbeddingProvider(dimensions),
      info: {
        provider: 'HashEmbeddingProvider',
        dimensions,
        readiness: 'verified',
      },
    };
  }

  const configuredDir = env.NEWIDE_LITELLM_CONFIG_DIR?.trim();
  const configDir = configuredDir
    ? path.resolve(options.repoRoot ?? process.cwd(), configuredDir)
    : undefined;
  const client = new LiteLLMClient().loadConfig(configDir);
  const route = client.modelPool.resolve('embed');
  const dimensions = readEmbeddingDimensions(env, client.dimensions);
  return {
    provider: new LiteLLMEmbeddingProvider(client, dimensions),
    info: {
      provider: `LiteLLM:${route.provider}`,
      task: 'embed',
      model: route.model,
      dimensions,
      readiness: 'verified',
    },
  };
}

async function verifyEmbeddingReadiness(provider: EmbeddingProvider): Promise<void> {
  const vector = await provider.embed('newIDE B memory readiness probe');
  if (vector.length !== provider.dimensions) {
    throw new Error(
      `Embedding dimension mismatch: configured ${String(provider.dimensions)}, received ${String(vector.length)}`,
    );
  }
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Embedding readiness probe returned an invalid vector');
  }
}

function readEmbeddingDimensions(env: NodeJS.ProcessEnv, fallback: number): number {
  const raw = env.NEWIDE_B_EMBEDDING_DIMENSIONS?.trim() ?? env.EMBEDDING_DIMENSIONS?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('NEWIDE_B_EMBEDDING_DIMENSIONS must be a positive integer');
  }
  return parsed;
}

function operationalError(prefix: string, error: unknown, secret?: string): Error {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const safeMessage = secret ? rawMessage.replaceAll(secret, '[REDACTED]') : rawMessage;
  return new Error(`${prefix}: ${safeMessage}`, { cause: error });
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
