/**
 * createAgentRuntime — 生产级 Agent Runtime 启动工厂
 *
 * 提供一条命令即可创建完整生产级 AgentManager 的工厂函数。
 * 根据配置选择存储实现（PgMemoryRepository / FileBufferRepository / InMemory）。
 * 注入顶层 LLM 与可选的 driver handler 等外部工具。
 *
 * ## 使用示例
 *
 * ```ts
 * const manager = createAgentRuntime({
 *   storage: {
 *     pg: { connectionString: 'postgresql://...' },
 *     agentStateRoot: '/path/to/agent-state',
 *   },
 *   llm: deepseekClient,
 *   tools: {
 *     driver: async (task) => { return { summary: '...', artifacts: [], decisions: [], blockers: [], referenced_experiences: [], assumptions: [] }; },
 *   },
 * });
 * ```
 *
 * 然后在 createAgent 后：
 * ```
 * await manager.createAgent({ role_id: 'role_dev', name: 'Developer' });
 * ```
 */
import { Pool } from 'pg';
import { AgentManager } from './agent-manager';
import type { AgentManagerOptions } from './agent-manager';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { PgMemoryRepository } from '../adapters/pg-memory-repository';
import { FileBufferRepository } from '../adapters/file-buffer-repository';
import { InvokeDriverTool, type DriverHandler } from './tools/invoke-driver-tool';
import type { MemoryRepository } from '../ports/memory-repository';
import type { BufferRepository } from '../ports/buffer-repository';
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type { ToolCallingClient } from './tool';
import type { Tool } from './tool';

// ──────────────────────────────────────────────
// 配置类型
// ──────────────────────────────────────────────

export interface PgPoolConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  max?: number;
}

export interface AgentRuntimeConfig {
  /** 存储配置 */
  storage?: {
    /** 提供则使用 PgMemoryRepository；不提供则使用 InMemoryRepository */
    pg?: PgPoolConfig;
    /** 提供则使用 FileBufferRepository（存储路径）；不提供则使用 InMemoryBufferRepository */
    agentStateRoot?: string;
  };
  /** 自定义 EmbeddingProvider（默认使用 HashEmbeddingProvider） */
  embedding?: EmbeddingProvider;
  /** 顶层 Agent 的 LLM（需支持 tool-calling） */
  llm: ToolCallingClient;
  /** 顶层 Agent 的系统提示词（可选覆盖） */
  systemPrompt?: string;
  /** 工具配置 */
  tools?: {
    /** 可选的 driver handler，包装为 InvokeDriverTool 注册 */
    driver?: DriverHandler;
    /** 额外的自定义工具（如 request_council 等） */
    additional?: Tool[];
  };
}

// ──────────────────────────────────────────────
// 工厂函数
// ──────────────────────────────────────────────

/**
 * 创建生产级 Agent Runtime。
 *
 * 根据配置自动选择存储实现，注入内置工具（QueryMemoryTool）
 * 和外部工具（InvokeDriverTool 等），返回一个配置好的 AgentManager。
 */
export async function createAgentRuntime(config: AgentRuntimeConfig): Promise<AgentManager> {
  // 1. 选择存储实现
  const repository = createMemoryRepository(config.storage, config.embedding);
  const bufferRepository = createBufferRepository(config.storage);

  // 2. 构建工具列表
  const tools: Tool[] = [];

  // 内置：QueryMemoryTool（依赖 repository，但在 createAgent 时才绑定 scope）
  // 注意：QueryMemoryTool 需要 AgentMemoryScope，而 scope 在 createAgent 时创建。
  // 这里我们不能直接 new QueryMemoryTool()，因为还没有 scope。
  // 解决方案：使用工厂模式，在 createAgent 时懒初始化。
  // 当前简化方案：AgentToolConfig 允许外部传入完整 tools 列表
  // 确实需要懒绑定 scope 的话，见下方 createWellKnownTools()

  // 外部注入工具
  if (config.tools?.driver) {
    tools.push(new InvokeDriverTool(config.tools.driver));
  }

  if (config.tools?.additional) {
    for (const tool of config.tools.additional) {
      tools.push(tool);
    }
  }

  // 3. 构建 AgentManagerOptions
  const managerOptions: AgentManagerOptions = {
    tools: {
      llm: config.llm,
      tools,
      ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    },
    ...(config.embedding ? { embedding: config.embedding } : {}),
  };

  // 4. 返回 AgentManager（async create 自动加载所有已注册 Agent）
  return AgentManager.create(repository, bufferRepository, managerOptions);
}

// ──────────────────────────────────────────────
// 内部工厂
// ──────────────────────────────────────────────

function createMemoryRepository(
  storage?: AgentRuntimeConfig['storage'],
  embedding?: EmbeddingProvider,
): MemoryRepository {
  if (storage?.pg) {
    const pool = new Pool({
      connectionString: storage.pg.connectionString,
      host: storage.pg.host,
      port: storage.pg.port,
      database: storage.pg.database,
      user: storage.pg.user,
      password: storage.pg.password,
      max: storage.pg.max ?? 10,
    });
    return new PgMemoryRepository({ pool, ...(embedding ? { embedding } : {}) });
  }
  return new InMemoryRepository(embedding);
}

function createBufferRepository(storage?: AgentRuntimeConfig['storage']): BufferRepository {
  if (storage?.agentStateRoot) {
    return new FileBufferRepository({ agentStateRoot: storage.agentStateRoot });
  }
  return new InMemoryBufferRepository();
}

// ──────────────────────────────────────────────
// 已知工具工厂（需要 AgentMemoryScope）
// ──────────────────────────────────────────────

/**
 * 创建顶层 Agent 的"已知"工具集。
 * 这些工具需要 AgentMemoryScope，应在 createAgent 时传入。
 *
 * 使用方式：
 * ```ts
 * const tools = createWellKnownTools(memory);
 * // 然后构造 AgentToolConfig
 * ```
 */
export { QueryMemoryTool } from './tools/query-memory-tool';
export { InvokeDriverTool } from './tools/invoke-driver-tool';
