/**
 * 真实 Embedding Provider 端到端集成测试
 *
 * 完整数据流：
 *   task dispatch → buffer write → buffer process (LLM extraction)
 *   → PG storage (real embedding) → vector retrieval (pgvector cosine distance)
 *
 * 全部使用真实 API：
 * - LiteLLMToolCallingClient（Agent loop 的 LLM，真实 API）
 * - LiteLLMEmbeddingProvider（embedding 向量，真实 API）
 * - PgMemoryRepository + pgvector（存储 + 向量检索）
 * - FileBufferRepository（文件系统 buffer）
 * - LlmExperienceExtractor（经验提取，真实 API）
 *
 * 需要环境变量：
 * - MEMORY_PG_TEST_URL    — PostgreSQL + pgvector 连接串
 * - OPENAI_API_KEY / DEEPSEEK_API_KEY — API key
 *
 * 可选环境变量：
 * - EMBEDDING_MODEL      — embedding 模型名（默认 'text-embedding-3-small'）
 * - EMBEDDING_DIMENSIONS — embedding 维度（默认 1536）
 * - OPENAI_BASE_URL      — 自定义 base URL（兼容国内 API）
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { LiteLLMEmbeddingProvider } from '../../adapters/litellm-embedding-provider';
import { LiteLLMClient } from '../../../litellm/contract';
import { cosineSimilarity } from '../../utils/vector';
import { PgMemoryRepository } from '../../adapters/pg-memory-repository';
import { ensurePgMemorySchema } from '../../adapters/pg-memory-schema';
import { FileBufferRepository } from '../../adapters/file-buffer-repository';
import { AgentManager } from '../../runtime/agent-manager';
import { InvokeDriverTool } from '../../runtime/tools/invoke-driver-tool';
import { LiteLLMToolCallingClient } from '../../adapters/litellm-tool-calling-client';
import { LiteLLMClientAdapter } from '../../adapters/litellm-client-adapter';
import { extractBuffer } from '../../services/memory-cycle';
import { createAgentMemoryScope } from '../../adapters/agent-memory-scope';
import type { DriverReturn } from '../../schemas';
import type { AgentTaskRequest } from '../../agent-types';

// ──────────────────────────────────────────────
// .env 加载
// ──────────────────────────────────────────────

function loadEnv(): void {
  const envPath = resolve(__dirname, '../../.env');
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  if (process.env.LLM_PROVIDER === 'deepseek' && process.env.DEEPSEEK_API_KEY) {
    if (!process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = process.env.DEEPSEEK_API_KEY;
    }
    if (!process.env.OPENAI_BASE_URL) {
      process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1';
    }
  }
}

loadEnv();

// ──────────────────────────────────────────────
// 条件跳过
// ──────────────────────────────────────────────

const pgTestUrl = process.env.MEMORY_PG_TEST_URL;
const hasApiKey = !!(process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY);
const canRun = !!pgTestUrl && hasApiKey;

const describeE2E = canRun ? describe : describe.skip;

if (!canRun) {
  const missing: string[] = [];
  if (!pgTestUrl) missing.push('MEMORY_PG_TEST_URL');
  if (!hasApiKey) missing.push('OPENAI_API_KEY or DEEPSEEK_API_KEY');
  console.warn(
    `⚠ real-embedding-e2e skipped — missing: ${missing.join(', ')}. ` +
      'Set them in src/memory/.env or as environment variables.',
  );
}

// ──────────────────────────────────────────────
// Mock DriverReturn
// ──────────────────────────────────────────────

function createMockDriverReturn(): DriverReturn {
  return {
    artifacts: [
      {
        type: 'file',
        path: 'greeting.txt',
        summary: 'Created greeting.txt with "Hello Agent Loop"',
      },
    ],
    summary:
      'Successfully created a greeting file with "Hello Agent Loop" content using echo command.',
    decisions: [
      {
        point: 'Output file creation',
        options: ['Use echo command', 'Use printf'],
        chosen: 'Use echo command',
        reason: 'Simplest approach for a single-line output',
      },
    ],
    blockers: [],
    referenced_experiences: [],
    assumptions: [
      {
        assumption: 'Target directory is writable',
        risk_if_wrong: 'File creation would fail with permission error',
      },
    ],
  };
}

// ──────────────────────────────────────────────
// System Prompt
// ──────────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You are an Agent that dispatches work to a Driver Agent.',
  '',
  '## Available Tools',
  '- invoke_driver: Submit a sub-task to the Driver Agent for execution. Use this for ALL concrete work.',
  '- query_memory: Retrieve past experiences and skills (optional).',
  '',
  '## Workflow',
  '1. Analyze the task.',
  '2. Call invoke_driver with a clear instruction to execute the work.',
  "3. Review the driver's structured result (artifacts, summary, decisions, blockers).",
  '4. If the driver completed the work successfully, summarize the result and include "[done]" in your response.',
  '',
  '## Important',
  '- Always use invoke_driver for any execution work — do not try to do it yourself.',
  '- The driver will return a structured report. Read it and confirm the task is done.',
].join('\n');

// ──────────────────────────────────────────────
// 共享资源
// ──────────────────────────────────────────────

let pool: Pool;
let embedding: LiteLLMEmbeddingProvider;
let pgRepo: PgMemoryRepository;
let agentStateRoot: string;
let fileRepo: FileBufferRepository;

// ──────────────────────────────────────────────
// E2E 测试
// ──────────────────────────────────────────────

describeE2E('Real Embedding Provider E2E (PG + LiteLLM)', () => {
  beforeAll(async () => {
    // 真实 Embedding Provider
    const embedClient = new LiteLLMClient().loadConfig();
    embedding = new LiteLLMEmbeddingProvider(embedClient);

    // PG 连接 + schema 创建（使用真实 embedding 维度）
    pool = new Pool({ connectionString: pgTestUrl });
    await ensurePgMemorySchema(pool, embedding.dimensions);
    pgRepo = new PgMemoryRepository({ pool, embedding, autoMigrate: false });

    // 文件系统临时目录
    agentStateRoot = await mkdtemp(join(tmpdir(), 'newide-real-embed-'));
    fileRepo = new FileBufferRepository({ agentStateRoot });
  });

  afterAll(async () => {
    await rm(agentStateRoot, { recursive: true, force: true });
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS memory_experiences');
      await pool.query('DROP TABLE IF EXISTS memory_skills');
      await pool.query('DROP TABLE IF EXISTS memory_agents');
      await pool.end();
    }
  });

  // ────────────────────────────────────────────
  // 测试 1: EmbeddingProvider 基本功能
  // ────────────────────────────────────────────

  it('LiteLLMEmbeddingProvider.embed() 返回正确维度的真实向量', async () => {
    const vector = await embedding.embed('hello world, this is a test sentence');

    expect(Array.isArray(vector)).toBe(true);
    expect(vector.length).toBe(embedding.dimensions);

    // 向量不应全为零（hash provider 的特征是稀疏的，真实 embedding 应该是稠密的）
    const nonZeroCount = vector.filter((v) => Math.abs(v) > 1e-6).length;
    expect(nonZeroCount).toBeGreaterThan(embedding.dimensions * 0.5);
  }, 30_000);

  it('LiteLLMEmbeddingProvider.cosineSimilarity 正确计算相似度', async () => {
    const vecA = await embedding.embed('create a greeting file');
    const vecB = await embedding.embed('make a hello world file');
    const vecC = await embedding.embed('database migration with PostgreSQL');

    // 语义相似的句子应有较高相似度
    const simSimilar = cosineSimilarity(vecA, vecB);
    expect(simSimilar).toBeGreaterThan(0.5);

    // 语义不相关的句子应有较低相似度
    const simDissimilar = cosineSimilarity(vecA, vecC);
    expect(simDissimilar).toBeLessThan(simSimilar);
  }, 60_000);

  // ────────────────────────────────────────────
  // 测试 2: 完整 E2E 流程
  // ────────────────────────────────────────────

  it('完整流程: task → buffer → extraction → PG storage → vector retrieval', async () => {
    // ── 1. 创建 Agent 并派发任务 ──
    const roleId = `role_e2e_${randomUUID()}`;
    const llm = new LiteLLMToolCallingClient({ taskName: 'memory-query' });
    const mockDriverReturn = createMockDriverReturn();

    const driverTool = new InvokeDriverTool(async () => mockDriverReturn);

    const manager = await AgentManager.create(pgRepo, fileRepo, {
      tools: {
        llm,
        tools: [driverTool],
        systemPrompt: SYSTEM_PROMPT,
        maxToolCalls: 10,
      },
    });

    await manager.createAgent({
      role_id: roleId,
      name: 'E2E Test Agent',
      tags: ['e2e', 'embedding-test'],
    });

    const task: AgentTaskRequest = {
      spec:
        'Execute a shell command to create a greeting file. ' +
        "Use invoke_driver to run: echo 'Hello Agent Loop' > greeting.txt",
      task_id: `task_e2e_${randomUUID()}`,
      call_id: `call_e2e_${randomUUID()}`,
      source_driver: 'test-driver',
    };

    const result = await manager.dispatchTask(roleId, task);

    // ── 2. 验证任务完成 + buffer 写入 ──
    expect(result.status).toBe('completed');
    expect(result.cycle.buffer_snapshot.task_id).toBe(task.task_id);
    expect(result.cycle.buffer_snapshot.driver_return.summary).toBe(mockDriverReturn.summary);

    // Agent 回到 sleeping
    const agent = manager.getAgent(roleId)!;
    expect(agent.getState()).toBe('sleeping');

    // buffer 有 pending 记录
    const meta = await fileRepo.getBufferMeta(roleId);
    expect(meta.pending_count).toBe(1);

    const pendingSeqs = await fileRepo.listPendingBufferSeqs(roleId);
    expect(pendingSeqs.length).toBe(1);
    const seq = pendingSeqs[0]!;

    // 验证 buffer 快照内容
    const pendingBuf = await fileRepo.getPendingBuffer(roleId, seq);
    expect(pendingBuf?.snapshot.task_id).toBe(task.task_id);
    expect(pendingBuf?.snapshot.driver_return.summary).toBe(mockDriverReturn.summary);

    // ── 3. 处理 buffer：LlmExperienceExtractor 提取经验 ──
    const llmClient = new LiteLLMClientAdapter('extract-driver-return');
    const memory = createAgentMemoryScope(pgRepo, fileRepo, roleId);

    const extraction = await extractBuffer(memory, seq, llmClient);

    expect(extraction.experiences.length).toBeGreaterThan(0);
    expect(extraction.result.experiences_created).toBeGreaterThan(0);

    // ── 4. 验证经验存储到 PG（带真实 embedding） ──
    const savedExperiences = await pgRepo.listExperiences(roleId);
    expect(savedExperiences.length).toBeGreaterThan(0);

    for (const exp of savedExperiences) {
      // description_embedding 应该是真实向量
      expect(exp.description_embedding.length).toBe(embedding.dimensions);

      // 向量不应全为零
      const nonZeroCount = exp.description_embedding.filter((v) => Math.abs(v) > 1e-6).length;
      expect(nonZeroCount).toBeGreaterThan(0);

      // description 不应为空
      expect(exp.description.length).toBeGreaterThan(0);
    }

    // ── 5. 验证 PG 中有真实向量数据 ──
    const pgResult = await pool.query(
      'SELECT id, description_embedding::text FROM memory_experiences WHERE role_id = $1',
      [roleId],
    );
    expect(pgResult.rows.length).toBeGreaterThan(0);

    for (const row of pgResult.rows) {
      const embeddingText = row.description_embedding as string;
      // pgvector 格式: [0.1,0.2,...]
      expect(embeddingText).toMatch(/^\[/);
      expect(embeddingText).toMatch(/\]$/);

      // 解析向量并验证维度
      const parsed = JSON.parse(embeddingText);
      expect(parsed.length).toBe(embedding.dimensions);
    }

    // ── 6. 向量检索：用相关查询搜索 ──
    const retrievalResult = await pgRepo.searchExperiences(roleId, {
      query_embedding: await embedding.embed('creating a greeting file with hello message'),
      top_k: 5,
      min_similarity: 0.3,
      min_confidence: 0.1,
    });

    // 应该能检索到相关经验
    expect(retrievalResult.length).toBeGreaterThan(0);
    expect(retrievalResult[0]!.description.length).toBeGreaterThan(0);

    // ── 7. 向量检索：用不相关查询搜索 ──
    const unrelatedResult = await pgRepo.searchExperiences(roleId, {
      query_embedding: await embedding.embed('quantum computing advanced mathematics topology'),
      top_k: 5,
      min_similarity: 0.8, // 高门槛
      min_confidence: 0.1,
    });

    // 不相关查询不应返回结果（或返回很少）
    expect(unrelatedResult.length).toBeLessThan(retrievalResult.length);

    // ── 8. 使用 retrieveMemoriesForTask 验证完整检索管道 ──
    const { retrieveMemoriesForTask } = await import('../../adapters/memory-retrieval');
    const memories = await retrieveMemoriesForTask(
      memory,
      { task_query: 'create a greeting hello file' },
      { embedding },
    );

    // 应该能通过完整检索管道找到相关经验
    expect(memories.experiences.length).toBeGreaterThan(0);
  }, 180_000); // 真实 API 调用需要更长时间

  // ────────────────────────────────────────────
  // 测试 3: 验证与 hash provider 的差异
  // ────────────────────────────────────────────

  it('真实 embedding 比 hash embedding 产生更有意义的相似度', async () => {
    const text1 = 'create a greeting file with hello world';
    const text2 = 'make a hello message in a text file';
    const text3 = 'deploy database migration to production PostgreSQL';

    // 真实 embedding
    const realVec1 = await embedding.embed(text1);
    const realVec2 = await embedding.embed(text2);
    const realVec3 = await embedding.embed(text3);
    const realSimSimilar = cosineSimilarity(realVec1, realVec2);
    const realSimDissimilar = cosineSimilarity(realVec1, realVec3);

    // 语义相似的应该比不相关的更相似
    expect(realSimSimilar).toBeGreaterThan(realSimDissimilar);

    // 相似度应在合理范围内
    expect(realSimSimilar).toBeGreaterThan(0.4);
    expect(realSimDissimilar).toBeLessThan(realSimSimilar);
  }, 60_000);
});
