/**
 * QueryMemoryTool — 顶层 Agent 的记忆检索工具
 *
 * 将 Agent 的记忆检索能力（检索过往经验和技能）暴露为 Tool，
 * 供顶层 Agent 的 LLM 在 tool-calling 循环中调用。
 *
 * 内部复用 retrieveMemoriesForTask 的 ReMe 检索流水线。
 */
import type { Tool } from '../tool';
import type { AgentMemoryScope } from '../../ports/agent-memory-scope';
import type { EmbeddingProvider } from '../../ports/embedding-provider';
import { retrieveMemoriesForTask } from '../../adapters/memory-retrieval';

export interface QueryMemoryInput {
  /** 检索关键词或自然语言查询 */
  query: string;
  /** 返回的最大条目数（默认 5） */
  top_k?: number;
  /** 最低相似度阈值 0-1（默认 0.5） */
  min_similarity?: number;
}

export interface QueryMemoryOutput {
  skills: Array<{ id: string; description: string; content: string }>;
  experiences: Array<{ id: string; description: string; content: string; confidence: number }>;
}

export class QueryMemoryTool implements Tool<QueryMemoryInput, QueryMemoryOutput> {
  readonly name = 'query_memory';
  readonly description =
    '检索 Agent 的经验和技能库，获取与当前任务相关的过往经验。' +
    '返回匹配到的技能和经验列表，包含完整的内容（content）供参考。';
  readonly inputSchema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '检索关键词或自然语言查询，描述你想寻找的记忆内容',
      },
      top_k: {
        type: 'number',
        description: '返回的最大条目数（默认 5）',
      },
      min_similarity: {
        type: 'number',
        description: '最低相似度阈值 0-1（默认 0.5），越高要求越严格',
      },
    },
    required: ['query'],
  };

  constructor(
    private readonly memory: AgentMemoryScope,
    private readonly embedding?: EmbeddingProvider,
  ) {}

  async execute(input: QueryMemoryInput): Promise<QueryMemoryOutput> {
    const result = await retrieveMemoriesForTask(
      this.memory,
      { task_query: input.query },
      {
        selection: {
          max_memory_items: input.top_k ?? 5,
          min_embedding_similarity: input.min_similarity ?? 0.5,
        },
        ...(this.embedding ? { embedding: this.embedding } : {}),
      },
    );

    return {
      skills: result.skills.map((s) => ({
        id: s.id,
        description: s.description,
        content: s.content,
      })),
      experiences: result.experiences.map((e) => ({
        id: e.id,
        description: e.description,
        content: e.content,
        confidence: e.confidence,
      })),
    };
  }
}
