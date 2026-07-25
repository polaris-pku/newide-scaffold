/**
 * 端到端集成测试：FileBuffer → 提取 → PG 入库 → BoardQuery → 向量检索
 *
 * 完整验证链路：
 *   1. FileBufferRepository 将 buffer 落盘到 .agent_state/ 文件夹
 *   2. RuleBasedExperienceExtractor 从 buffer 提取经验
 *   3. PgMemoryRepository 将经验持久化到 PostgreSQL
 *   4. RepositoryAgentBoardQuery 正确查询 Agent / Experience
 *   5. EmbeddingProvider 向量检索验证语义搜索
 *
 * 前置条件：
 *   - .env 中配置 MEMORY_PG_TEST_URL（PostgreSQL + pgvector）
 *   - .env 中配置 EMBEDDING_API_KEY（用于向量检索步骤）
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { PgMemoryRepository } from '../../adapters/pg-memory-repository';
import { ensurePgMemorySchema } from '../../adapters/pg-memory-schema';
import { FileBufferRepository } from '../../adapters/file-buffer-repository';
import { HashEmbeddingProvider } from '../../adapters/hash-embedding-provider';
import { LiteLLMEmbeddingProvider } from '../../adapters/litellm-embedding-provider';
import { LiteLLMClient } from '../../../litellm/contract';
import { RuleBasedExperienceExtractor } from '../../adapters/rule-based-experience-extractor';
import { createAgentMemoryScope } from '../../adapters/agent-memory-scope';
import { RepositoryAgentBoardQuery } from '../../adapters/agent-board-query';
import { ingestTaskBuffer, processPendingBuffer } from '../../services/memory-cycle';
import { nowTimestamp } from '../../../core';
import type {
  BufferSnapshot,
  AgentContextSnapshot,
  DriverReturn,
  ExperienceRecord,
} from '../../schemas';
import type { AgentTaskRequest } from '../../agent-types';

// ═══════════════════════════════════════════
//  .env 加载
// ═══════════════════════════════════════════

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
}
loadEnv();

// ═══════════════════════════════════════════
//  条件跳过
// ═══════════════════════════════════════════

const pgTestUrl = process.env.MEMORY_PG_TEST_URL;
const hasEmbeddingKey = !!(
  process.env.EMBEDDING_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.DEEPSEEK_API_KEY
);

const suitePg = pgTestUrl ? describe : describe.skip;
const suiteFull = pgTestUrl && hasEmbeddingKey ? describe : describe.skip;

// ═══════════════════════════════════════════
//  测试数据工厂
// ═══════════════════════════════════════════

const ROLE_ID = 'e2e-test-agent';

const TASK: AgentTaskRequest = {
  spec: '实现一个文件上传功能，支持拖拽和点击上传',
  task_id: 'task-e2e-001',
  call_id: 'call-e2e-001',
  source_driver: 'code-driver',
};

const DRIVER_RETURN: DriverReturn = {
  artifacts: [],
  summary: '成功实现文件上传功能，使用 multer 中间件处理 multipart/form-data',
  decisions: [
    {
      point: '存储方案',
      chosen: '本地文件系统',
      options: ['本地文件系统', 'S3', 'OSS'],
      reason: '项目初期规模小，本地存储足够',
    },
    {
      point: '上传库',
      chosen: 'multer',
      options: ['multer', 'formidable', 'busboy'],
      reason: 'multer 生态成熟，Express 集成简单',
    },
  ],
  blockers: [
    {
      blocker: '文件大小限制配置不生效',
      resolved: true,
      resolution: '需要在 multer 配置中同时设置 limits.fileSize 和 nginx client_max_body_size',
      attempts: ['修改 multer 配置', '检查 nginx 配置'],
    },
  ],
  assumptions: [
    {
      assumption: '单文件最大 10MB 足够业务需求',
      risk_if_wrong: '需要调整限制并增加分片上传逻辑',
    },
  ],
  referenced_experiences: [],
};

const AGENT_CONTEXT = {
  snapshot_id: crypto.randomUUID(),
  source_task_id: TASK.task_id!,
  agent_id: ROLE_ID,
  thinking_trace: '先确认存储方案，再实现上传接口，最后处理边界情况',
  planning_trace: '分步实施：1.存储方案选型 2.上传接口实现 3.边界处理',
  driver_calls: [
    {
      call_id: 'call-e2e-001',
      driver_id: 'code-driver',
      driver_return_ref: 'report_1.json',
    },
  ],
  cleaned_at: nowTimestamp(),
  original_token_count: 1000,
  cleaned_token_count: 500,
  compression_ratio: 0.5,
};

// ═══════════════════════════════════════════
//  Test Suite 1: 纯 PG 链路（无需 Embedding Key）
// ═══════════════════════════════════════════

suitePg('E2E: FileBuffer → 提取 → PG 入库 → BoardQuery', () => {
  let pool: Pool;
  let repository: PgMemoryRepository;
  let bufferRepo: FileBufferRepository;
  let tempDir: string;
  let boardQuery: RepositoryAgentBoardQuery;

  beforeAll(async () => {
    // 1. 创建临时 .agent_state 文件夹
    tempDir = await mkdtemp(join(tmpdir(), 'memory-e2e-'));

    console.log(`\n📁 临时状态目录: ${tempDir}`);

    // 2. 连接 PG，建表（使用 HashEmbeddingProvider 确保写入维度与 schema 一致）
    pool = new Pool({ connectionString: pgTestUrl });
    const hashEmbedding = new HashEmbeddingProvider(1024);
    repository = new PgMemoryRepository({ pool, embedding: hashEmbedding });
    await ensurePgMemorySchema(pool, hashEmbedding.dimensions);

    // 3. 创建 FileBufferRepository
    bufferRepo = new FileBufferRepository({ agentStateRoot: tempDir });

    // 4. 初始化 Agent
    await repository.initializeAgent({
      role_id: ROLE_ID,
      name: 'E2E 测试 Agent',
      tags: ['e2e', 'test', 'file-upload'],
      persona_seed: '一个专注于文件处理的开发 Agent',
    });

    // 5. 创建 BoardQuery facade
    boardQuery = new RepositoryAgentBoardQuery(repository);

    console.log('✅ Agent 已注册，PG schema 已就绪');
  });

  afterAll(async () => {
    // 清理 PG 数据
    await pool.query('DELETE FROM memory_experiences WHERE role_id = $1', [ROLE_ID]);
    await pool.query('DELETE FROM memory_skills WHERE role_id = $1', [ROLE_ID]);
    await pool.query('DELETE FROM memory_agents WHERE role_id = $1', [ROLE_ID]);
    await pool.end();

    // 清理临时目录
    await rm(tempDir, { recursive: true, force: true });
    console.log('🧹 已清理临时目录和 PG 数据');
  });

  // ─────────────────────────────────────
  //  Step 1: Buffer 落盘到文件系统
  // ─────────────────────────────────────

  it('Step 1: ingestTaskBuffer 将报告写入文件 buffer', async () => {
    const memory = createAgentMemoryScope(repository, bufferRepo, ROLE_ID);

    const { seq, snapshot } = await ingestTaskBuffer(memory, {
      task: TASK,
      task_id: TASK.task_id!,
      call_id: TASK.call_id!,
      source_driver: TASK.source_driver!,
      driver_return: DRIVER_RETURN,
      agentContext: AGENT_CONTEXT,
    });

    console.log(`\n📝 Buffer 已写入: seq=${seq}`);
    console.log(`   task_description: ${snapshot.task_description}`);
    console.log(`   source_driver: ${snapshot.source_driver}`);

    expect(seq).toBe(1);
    expect(snapshot.extraction_status).toBe('pending');

    // 验证文件确实落盘
    const bufferDir = join(tempDir, ROLE_ID, 'buffer');
    const pendingFiles = await readdir(join(bufferDir, 'pending'));
    console.log(`📂 pending/ 文件: [${pendingFiles.join(', ')}]`);
    expect(pendingFiles).toContain('report_1.json');
    expect(pendingFiles).toContain('context_1.json');

    // 验证 meta
    const meta = await memory.getBufferMeta();
    console.log(`📊 buffer_meta: pending=${meta.pending_count}, cursor=${meta.cursor}`);
    expect(meta.pending_count).toBe(1);
    expect(meta.cursor).toBe(1);

    // 读取落盘文件内容，打印关键字段
    const reportRaw = await readFile(join(bufferDir, 'pending', 'report_1.json'), 'utf-8');
    const report = JSON.parse(reportRaw) as BufferSnapshot;
    console.log(`📄 report_1.json summary: ${report.driver_return.summary}`);

    const contextRaw = await readFile(join(bufferDir, 'pending', 'context_1.json'), 'utf-8');
    const context = JSON.parse(contextRaw) as AgentContextSnapshot;
    console.log(`📄 context_1.json thinking: ${context.thinking_trace}`);
  });

  // ─────────────────────────────────────
  //  Step 2: 提取经验并入库
  // ─────────────────────────────────────

  it('Step 2: extractBuffer 提取经验并保存到 PG', async () => {
    const memory = createAgentMemoryScope(repository, bufferRepo, ROLE_ID);
    const extractor = new RuleBasedExperienceExtractor();

    // 读取 pending buffer
    const pending = await memory.getPendingBuffer(1);
    expect(pending).toBeDefined();

    // 提取
    const output = await extractor.extract(pending!.snapshot, pending!.agentContext);
    console.log(`\n🧠 提取结果: ${output.experiences.length} 条经验`);
    console.log(`   正经验: ${output.result.experiences_created}`);
    console.log(`   负经验: ${output.result.negative_experiences}`);

    for (const exp of output.experiences) {
      console.log(`\n   📌 [${exp.type}] ${exp.description}`);
      console.log(`      confidence: ${exp.confidence}`);
      console.log(`      tags: [${exp.tags.join(', ')}]`);
      console.log(`      content: ${exp.content.slice(0, 80)}...`);
    }

    // 保存到 PG
    for (const exp of output.experiences) {
      await memory.saveExperience(exp);
    }

    // 标记 buffer 已处理
    await memory.markBufferProcessed(1);

    // 验证 PG 中有记录
    const savedExperiences = await memory.listExperiences();
    console.log(`\n💾 PG 中已存储 ${savedExperiences.length} 条经验`);
    expect(savedExperiences.length).toBe(output.experiences.length);

    // 验证 buffer 状态
    const meta = await memory.getBufferMeta();
    console.log(`📊 buffer_meta: pending=${meta.pending_count}, processed=${meta.total_processed}`);
    expect(meta.pending_count).toBe(0);
    expect(meta.total_processed).toBe(1);

    // 验证 pending 目录已空，processed 有文件
    const bufferDir = join(tempDir, ROLE_ID, 'buffer');
    const pendingFiles = await readdir(join(bufferDir, 'pending'));
    const processedFiles = await readdir(join(bufferDir, 'processed'));
    console.log(`📂 pending/: [${pendingFiles.join(', ')}] (应为空)`);
    console.log(`📂 processed/: [${processedFiles.join(', ')}]`);
    expect(processedFiles).toContain('report_1.json');
  });

  // ─────────────────────────────────────
  //  Step 3: BoardQuery 查询验证
  // ─────────────────────────────────────

  it('Step 3: RepositoryAgentBoardQuery 正确返回数据', async () => {
    // listAgents
    const agents = await boardQuery.listAgents();
    console.log(`\n👥 listAgents(): ${agents.length} 个 Agent`);
    for (const agent of agents) {
      console.log(`   - ${agent.role_id} (${agent.name})`);
      console.log(`     skills: ${agent.skill_count}, experiences: ${agent.experience_count}`);
      console.log(`     persona: ${agent.persona_summary}`);
    }
    expect(agents.length).toBeGreaterThanOrEqual(1);
    const myAgent = agents.find((a) => a.role_id === ROLE_ID);
    expect(myAgent).toBeDefined();
    expect(myAgent!.experience_count).toBeGreaterThanOrEqual(1);

    // getAgent
    const detail = await boardQuery.getAgent(ROLE_ID);
    console.log(`\n🔍 getAgent("${ROLE_ID}"):`, {
      name: detail.name,
      status: detail.status,
      skills: detail.skill_count,
      experiences: detail.experience_count,
      persona_summary: detail.persona.summary,
    });
    expect(detail.role_id).toBe(ROLE_ID);
    expect(detail.experience_count).toBeGreaterThanOrEqual(1);

    // listExperiences
    const experiences = await boardQuery.listExperiences(ROLE_ID);
    console.log(`\n📋 listExperiences("${ROLE_ID}"): ${experiences.length} 条`);
    for (const exp of experiences) {
      console.log(`   - [${exp.type}] ${exp.description} (confidence: ${exp.confidence})`);
      // ExperienceView 不应包含 embedding
      expect(exp).not.toHaveProperty('description_embedding');
    }
    expect(experiences.length).toBeGreaterThanOrEqual(1);

    // listSkills (初始应为空)
    const skills = await boardQuery.listSkills(ROLE_ID);
    console.log(`\n🔧 listSkills("${ROLE_ID}"): ${skills.length} 条 (初始应为空)`);
    expect(skills.length).toBe(0);
  });

  // ─────────────────────────────────────
  //  Step 4: processPendingBuffer 完整流程
  // ─────────────────────────────────────

  it('Step 4: processPendingBuffer 提取+入库+标记 processed 一步完成', async () => {
    const memory = createAgentMemoryScope(repository, bufferRepo, ROLE_ID);

    // 先写入第二条 buffer
    const { seq } = await ingestTaskBuffer(memory, {
      task: { ...TASK, spec: '优化数据库查询性能，添加索引', task_id: 'task-e2e-002' },
      task_id: 'task-e2e-002',
      call_id: 'call-e2e-002',
      source_driver: 'perf-driver',
      driver_return: {
        artifacts: [],
        summary: '分析慢查询日志，为 users 表添加 email 索引，查询时间从 2s 降到 50ms',
        decisions: [
          {
            point: '索引策略',
            chosen: 'B-tree 索引',
            options: ['B-tree 索引', 'Hash 索引', '复合索引'],
            reason: 'email 查询为等值查询，B-tree 效率最高',
          },
        ],
        blockers: [],
        assumptions: [
          {
            assumption: '写入性能影响可接受',
            risk_if_wrong: '需要评估写入频率，考虑异步索引更新',
          },
        ],
        referenced_experiences: [],
      },
    });

    expect(seq).toBe(2);
    console.log(`\n📝 第二条 buffer 已写入: seq=${seq}`);

    // 使用 processPendingBuffer 一步完成提取+入库+标记
    const extractor = new RuleBasedExperienceExtractor();
    const result = await processPendingBuffer(memory, seq, {
      task: TASK,
      extractor,
      promote: async (_memory, _task, _exps) => ({
        check: {
          eligible: false,
          auto_approved: false,
          reasons: [] as string[],
          blocking_rules: ['test'],
        },
      }),
    });

    console.log(`\n⚡ processPendingBuffer 结果:`);
    console.log(`   提取经验: ${result.extraction.experiences.length} 条`);
    console.log(`   正经验: ${result.extraction.result.experiences_created}`);
    console.log(`   负经验: ${result.extraction.result.negative_experiences}`);

    // 验证 PG 中经验总数
    const allExperiences = await memory.listExperiences();
    console.log(`\n💾 PG 中总经验数: ${allExperiences.length} (应 ≥ 2)`);
    expect(allExperiences.length).toBeGreaterThanOrEqual(2);

    // 验证 buffer 状态
    const meta = await memory.getBufferMeta();
    console.log(`📊 buffer_meta: pending=${meta.pending_count}, processed=${meta.total_processed}`);
    expect(meta.pending_count).toBe(0);
    expect(meta.total_processed).toBe(2);
  });
});

// ═══════════════════════════════════════════
//  Test Suite 2: 向量检索（需要 Embedding Key）
// ═══════════════════════════════════════════

suiteFull('E2E: 向量检索验证 (PG + Embedding)', () => {
  let pool: Pool;
  let repository: PgMemoryRepository;
  let bufferRepo: FileBufferRepository;
  let tempDir: string;
  let embedding: LiteLLMEmbeddingProvider;
  const testExperiences: ExperienceRecord[] = [];

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'memory-e2e-vec-'));
    pool = new Pool({ connectionString: pgTestUrl });
    const embedClient = new LiteLLMClient().loadConfig();
    embedding = new LiteLLMEmbeddingProvider(embedClient);
    repository = new PgMemoryRepository({ pool, embedding });
    bufferRepo = new FileBufferRepository({ agentStateRoot: tempDir });

    await ensurePgMemorySchema(pool, embedding.dimensions);
    await repository.initializeAgent({
      role_id: ROLE_ID,
      name: 'E2E 向量检索 Agent',
      tags: ['e2e', 'vector-search'],
    });

    // 预置几条带真实 embedding 的经验
    const sampleData = [
      {
        description: '使用 multer 处理文件上传',
        content: '通过 multer 中间件实现 Express 文件上传，配置 storage 控制文件名和路径',
        type: 'positive' as const,
        tags: ['file-upload', 'multer', 'express'],
      },
      {
        description: 'PostgreSQL 连接池配置优化',
        content: '使用 pg Pool 设置 max=20, idleTimeoutMillis=30000 避免连接泄漏',
        type: 'positive' as const,
        tags: ['postgresql', 'connection-pool', 'optimization'],
      },
      {
        description: '文件大小限制不生效的排查经验',
        content: 'nginx client_max_body_size 和 multer limits.fileSize 需要同时配置',
        type: 'negative' as const,
        tags: ['nginx', 'file-upload', 'debugging'],
      },
    ];

    console.log('\n🔄 预置带真实 embedding 的经验...');
    for (const data of sampleData) {
      const vec = await embedding.embed(data.description);
      console.log(`   📌 "${data.description}" → embedding dim=${vec.length}`);

      const exp: ExperienceRecord = {
        id: crypto.randomUUID(),
        description: data.description,
        description_embedding: vec,
        content: data.content,
        confidence: 0.92,
        tags: data.tags,
        agent_id: ROLE_ID,
        linked_negative_exp: undefined,
        promoted_to: undefined,
        assumptions: undefined,
        confidence_history: [{ value: 0.92, updated_at: nowTimestamp(), reason: 'e2e seed' }],
        referenced_count: 0,
        last_referenced_at: undefined,
        source_task_id: 'task-e2e-vec',
        source_driver: 'e2e-setup',
        source_user_rating: undefined,
        type: data.type,
        created_at: nowTimestamp(),
        updated_at: nowTimestamp(),
      };

      await repository.saveExperience(ROLE_ID, exp);
      testExperiences.push(exp);
    }
    console.log('✅ 预置完成');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM memory_experiences WHERE role_id = $1', [ROLE_ID]);
    await pool.query('DELETE FROM memory_agents WHERE role_id = $1', [ROLE_ID]);
    await pool.end();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('searchExperiences 按语义相似度排序', async () => {
    const memory = createAgentMemoryScope(repository, bufferRepo, ROLE_ID);

    // 查询: "文件上传怎么实现" — 应该最匹配 "使用 multer 处理文件上传"
    const queryVec = await embedding.embed('文件上传怎么实现');
    console.log(`\n🔍 查询: "文件上传怎么实现"`);
    console.log(`   embedding dim: ${queryVec.length}`);

    const results = await memory.searchExperiences({
      query_embedding: queryVec,
      top_k: 10,
      min_similarity: 0.3,
      min_confidence: 0.5,
    });

    console.log(`\n📋 检索结果 (${results.length} 条):`);
    for (const exp of results) {
      console.log(`   - [${exp.type}] ${exp.description}`);
    }

    expect(results.length).toBeGreaterThanOrEqual(1);
    // 第一条应该是文件上传相关的
    expect(results[0]!.description).toContain('multer');
  });

  it('searchExperiences 区分正负经验', async () => {
    const memory = createAgentMemoryScope(repository, bufferRepo, ROLE_ID);

    const queryVec = await embedding.embed('nginx 配置问题');
    const results = await memory.searchExperiences({
      query_embedding: queryVec,
      top_k: 10,
      min_similarity: 0.3,
      min_confidence: 0.2,
    });

    console.log(`\n🔍 查询: "nginx 配置问题"`);
    console.log(`📋 检索结果 (${results.length} 条):`);
    for (const exp of results) {
      console.log(`   - [${exp.type}] ${exp.description} (confidence: ${exp.confidence})`);
    }

    // 应该包含 nginx 相关的负经验
    const nginxExp = results.find((e) => e.description.includes('nginx'));
    expect(nginxExp).toBeDefined();
    expect(nginxExp!.type).toBe('negative');
  });

  it('listExperiences 返回全部经验', async () => {
    const memory = createAgentMemoryScope(repository, bufferRepo, ROLE_ID);
    const all = await memory.listExperiences();
    console.log(`\n📋 listExperiences(): ${all.length} 条`);
    for (const exp of all) {
      console.log(`   - [${exp.type}] ${exp.description} (confidence: ${exp.confidence})`);
    }
    expect(all.length).toBe(testExperiences.length);
  });
});
