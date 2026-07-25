/**
 * 真实端到端集成测试：Agent → Driver(LLM) → Buffer落盘 → 提取(LLM) → PG入库 → BoardQuery → 第二轮载入经验
 *
 * 全链路使用真实组件：
 *   - 真实 Agent（AgentManager + LiteLLMToolCallingClient）
 *   - 真实 Driver（LLM 生成结构化 DriverReturn）
 *   - 真实文件系统 Buffer（FileBufferRepository → 临时 .agent_state 目录）
 *   - 真实 PostgreSQL + pgvector 存储
 *   - 真实 LLM 经验提取（LlmExperienceExtractor）
 *   - 真实向量嵌入（LiteLLMEmbeddingProvider）
 *   - 第二轮循环：Agent 通过 query_memory 载入第一轮的经验/技能
 *
 * 前置条件：
 *   - .env 中配置 MEMORY_PG_TEST_URL（PostgreSQL + pgvector）
 *   - .env 中配置 DEEPSEEK_API_KEY 或 OPENAI_API_KEY（Agent LLM + Driver LLM）
 *   - .env 中配置 EMBEDDING_API_KEY（向量嵌入，可选；缺省则用 OPENAI_API_KEY）
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { PgMemoryRepository } from '../../adapters/pg-memory-repository';
import { ensurePgMemorySchema } from '../../adapters/pg-memory-schema';
import { FileBufferRepository } from '../../adapters/file-buffer-repository';
import { LiteLLMEmbeddingProvider } from '../../adapters/litellm-embedding-provider';
import { LiteLLMClient } from '../../../litellm/contract';
import { HashEmbeddingProvider } from '../../adapters/hash-embedding-provider';
import { LiteLLMToolCallingClient } from '../../adapters/litellm-tool-calling-client';
import { LiteLLMClientAdapter } from '../../adapters/litellm-client-adapter';
import { LlmExperienceExtractor } from '../../adapters/llm-experience-extractor';
import { createAgentMemoryScope } from '../../adapters/agent-memory-scope';
import { RepositoryAgentBoardQuery } from '../../adapters/agent-board-query';
import { AgentManager } from '../../runtime/agent-manager';
import { InvokeDriverTool } from '../../runtime/tools/invoke-driver-tool';
import { ExperienceExtractorProcessor } from '../../runtime/experience-extractor-processor';
import { SkillPromotionProcessor } from '../../runtime/skill-promotion-processor';
import { ruleBasedSkillPromotion } from '../../services/skill-promotion';
import { DriverBridge } from '../../../driver/driver-bridge';
import { CliDriverRuntime } from '../drivers/cli-driver-runtime';
import type { BufferSnapshot } from '../../schemas';
import type { AgentTaskRequest } from '../../agent-types';
import type { BufferTriggerPolicy } from '../../ports/buffer-trigger-policy';
import type { PromotionTriggerPolicy } from '../../ports/promotion-trigger-policy';
import type { EmbeddingProvider } from '../../ports/embedding-provider';
import type {
  ToolCallingClient,
  ToolCallMessage,
  ToolDefinition,
  ToolCallResult,
} from '../../runtime/tool';

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
//  CLI 检测（优先 Kimi，其次 Claude）
// ═══════════════════════════════════════════

const kimiPath = 'C:\\Users\\13008\\.kimi-code\\bin\\kimi.exe';

function hasCli(cmd: string): boolean {
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

const deps = {
  kimiCli: existsSync(kimiPath),
  claudeCli: hasCli('claude'),
  llmKey: !!(
    process.env.DEEPSEEK_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY
  ),
};

const preferredCli = deps.kimiCli ? kimiPath : deps.claudeCli ? 'claude' : null;
const driverLabel = deps.kimiCli ? 'kimi' : deps.claudeCli ? 'claude' : 'none';

// ═══════════════════════════════════════════
//  条件跳过
// ═══════════════════════════════════════════

const pgTestUrl = process.env.MEMORY_PG_TEST_URL;
const hasLlmKey = !!(
  process.env.DEEPSEEK_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.ANTHROPIC_API_KEY
);
const hasEmbeddingKey = !!(
  process.env.EMBEDDING_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.DEEPSEEK_API_KEY
);

const canRun = pgTestUrl && hasLlmKey && preferredCli;
const suite = canRun ? describe : describe.skip;

if (!canRun) {
  const missing: string[] = [];
  if (!pgTestUrl) missing.push('MEMORY_PG_TEST_URL');
  if (!hasLlmKey) missing.push('DEEPSEEK_API_KEY / OPENAI_API_KEY');
  if (!preferredCli) missing.push('CLI (kimi / claude)');
  console.warn(`⚠ 缺少依赖: ${missing.join(', ')} — 真实端到端测试已跳过。`);
}

// ═══════════════════════════════════════════
//  测试策略
// ═══════════════════════════════════════════

const alwaysExtractPolicy: BufferTriggerPolicy = { shouldExtract: () => true };
const alwaysPromotePolicy: PromotionTriggerPolicy = { shouldPromote: () => true };

// ═══════════════════════════════════════════
//  包装 LLM Client —— 记录每轮 tool-calling 对话
// ═══════════════════════════════════════════

/**
 * 包装 ToolCallingClient，在每次 completeWithTools 前后打印完整对话。
 * 这样你能看到 Agent LLM 的系统提示、用户任务、每轮工具调用及结果。
 */
class LoggingToolCallingClient implements ToolCallingClient {
  private round = 0;
  constructor(
    private readonly inner: ToolCallingClient,
    private readonly label: string,
  ) {}

  async completeWithTools(input: {
    messages: ToolCallMessage[];
    tools: ToolDefinition[];
    tool_choice?: 'auto' | 'none';
  }): Promise<ToolCallResult> {
    this.round++;
    const tag = `[${this.label} Round ${this.round}]`;

    // 打印系统提示（仅首轮）
    if (this.round === 1) {
      const sysMsg = input.messages.find((m) => m.role === 'system');
      if (sysMsg) {
        console.log(`\n${'═'.repeat(70)}`);
        console.log(`${tag} 系统提示 (system prompt):`);
        console.log(`${'─'.repeat(70)}`);
        console.log(sysMsg.content);
        console.log(`${'═'.repeat(70)}`);
      }
    }

    // 打印本轮输入消息
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`${tag} 输入消息 (${input.messages.length} 条):`);
    for (const msg of input.messages) {
      if (msg.role === 'system') continue; // 已经打印过
      const preview = (msg.content ?? '').slice(0, 300);
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        console.log(`  [${msg.role}] ${preview || '(tool_calls)'}`);
        for (const tc of msg.tool_calls) {
          console.log(`    🔧 call: ${tc.function.name}(${tc.function.arguments.slice(0, 200)})`);
        }
      } else if (msg.role === 'tool') {
        console.log(`  [tool result ${msg.tool_call_id}] ${(msg.content ?? '').slice(0, 300)}`);
      } else {
        console.log(`  [${msg.role}] ${preview}`);
      }
    }

    // 打印可用工具
    if (this.round === 1) {
      console.log(`\n${tag} 可用工具 (${input.tools.length} 个):`);
      for (const t of input.tools) {
        console.log(`  - ${t.function.name}: ${t.function.description.slice(0, 80)}...`);
      }
    }

    // 调用真实 LLM
    const result = await this.inner.completeWithTools(input);

    // 打印 LLM 回复
    console.log(`\n${tag} LLM 回复:`);
    if (result.content) {
      console.log(`  📝 text: ${result.content.slice(0, 500)}`);
    }
    if (result.tool_calls && result.tool_calls.length > 0) {
      for (const tc of result.tool_calls) {
        console.log(`  🔧 tool_call: ${tc.function.name}(${tc.function.arguments.slice(0, 300)})`);
      }
    } else {
      console.log(`  (无 tool_call — Agent 可能认为任务已完成)`);
    }
    console.log(`${'─'.repeat(70)}`);

    return result;
  }
}

// ═══════════════════════════════════════════
//  创建真实 Driver（CliDriverRuntime + DriverBridge）
// ═══════════════════════════════════════════

/**
 * 创建真实 CLI Driver + DriverBridge + 日志包装。
 * 使用 CliDriverRuntime 调用本地 CLI（Kimi/Claude），通过 DriverBridge 转换为 DriverReturn。
 */
function createRealDriver(label: string, cwd: string): InvokeDriverTool {
  const isKimi = preferredCli!.includes('kimi');

  const cliDriver = new CliDriverRuntime({
    cliCommand: preferredCli!,
    args: isKimi ? [] : ['--dangerously-skip-permissions'],
    promptArgs: isKimi ? ['-p'] : [],
    driverId: isKimi ? 'kimi-driver' : 'claude-driver',
    cwd,
  });

  const bridge = new DriverBridge({ driver: cliDriver });

  return new InvokeDriverTool(async (task) => {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`🚗 [${label}] 真实 CLI Driver (${driverLabel}) 收到任务:`);
    console.log(`${'─'.repeat(70)}`);
    console.log(`  instruction: ${task.instruction}`);
    if (task.context?.skills?.length) {
      console.log(`  skills (${task.context.skills.length}):`);
      for (const s of task.context.skills) {
        console.log(`    - ${s.slice(0, 120)}`);
      }
    } else {
      console.log(`  skills: (无)`);
    }
    if (task.context?.experiences?.length) {
      console.log(`  experiences (${task.context.experiences.length}):`);
      for (const e of task.context.experiences) {
        console.log(`    - ${e.slice(0, 120)}`);
      }
    } else {
      console.log(`  experiences: (无)`);
    }

    console.log(`\n  ⏳ 调用 ${driverLabel} CLI Driver...`);
    const result = await bridge.invokeDriver(task);

    console.log(`\n  📤 Driver (${driverLabel}) 返回:`);
    console.log(`    summary: ${result.summary}`);
    console.log(`    artifacts (${result.artifacts.length}):`);
    for (const a of result.artifacts) {
      console.log(`      - [${a.type}] ${a.path}: ${a.summary}`);
    }
    console.log(`    decisions (${result.decisions.length}):`);
    for (const d of result.decisions) {
      console.log(`      - ${d.point}: chose "${d.chosen}" (reason: ${d.reason})`);
    }
    console.log(`    blockers (${result.blockers.length}):`);
    for (const b of result.blockers) {
      console.log(`      - ${b.blocker} → ${b.resolution} (resolved: ${b.resolved})`);
    }
    console.log(`    assumptions (${result.assumptions.length}):`);
    for (const a of result.assumptions) {
      console.log(`      - ${a.assumption} (risk: ${a.risk_if_wrong})`);
    }
    console.log(`    referenced_experiences (${result.referenced_experiences.length}):`);
    for (const r of result.referenced_experiences) {
      console.log(
        `      - ${r.experience_id}: applied=${r.applied}, effectiveness=${r.effectiveness}`,
      );
    }
    console.log(`${'═'.repeat(70)}`);

    return result;
  });
}

// ═══════════════════════════════════════════
//  测试
// ═══════════════════════════════════════════

suite('E2E 真实 Agent 循环 (Agent → Driver → Buffer → Extract → PG → 第二轮)', () => {
  const ROLE_ID = 'real-e2e-agent';

  let pool: Pool;
  let repository: PgMemoryRepository;
  let bufferRepo: FileBufferRepository;
  let embedding: EmbeddingProvider;
  let manager: AgentManager;
  let extractorProcessor: ExperienceExtractorProcessor;
  let promotionProcessor: SkillPromotionProcessor;
  let boardQuery: RepositoryAgentBoardQuery;
  let tempDir: string;

  let cycle1Result: Awaited<ReturnType<AgentManager['dispatchTask']>>;
  let cycle2Result: Awaited<ReturnType<AgentManager['dispatchTask']>>;

  // ─────────────────────────────────────
  //  Setup
  // ─────────────────────────────────────

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'real-e2e-'));
    console.log(`\n📁 临时 .agent_state 目录: ${tempDir}`);

    pool = new Pool({ connectionString: pgTestUrl });
    const embedClient = new LiteLLMClient().loadConfig();
    embedding = hasEmbeddingKey
      ? new LiteLLMEmbeddingProvider(embedClient)
      : new HashEmbeddingProvider();
    console.log(`🔌 PG 连接: ${pgTestUrl}`);
    console.log(
      `📐 Embedding 维度: ${embedding.dimensions} (${hasEmbeddingKey ? 'LiteLLM' : 'Hash fallback'})`,
    );

    // 先清理上次残留数据
    await pool.query('DELETE FROM memory_experiences WHERE role_id = $1', [ROLE_ID]);
    await pool.query('DELETE FROM memory_skills WHERE role_id = $1', [ROLE_ID]);
    await pool.query('DELETE FROM memory_agents WHERE role_id = $1', [ROLE_ID]);

    await ensurePgMemorySchema(pool, embedding.dimensions);
    console.log(`✅ PG schema 已就绪`);

    repository = new PgMemoryRepository({ pool, embedding });
    bufferRepo = new FileBufferRepository({ agentStateRoot: tempDir });

    // 真实 LLM —— 包装为 LoggingToolCallingClient 记录对话
    const rawLlm = new LiteLLMToolCallingClient();
    const llm = new LoggingToolCallingClient(rawLlm, 'Cycle1');
    const llmClient = new LiteLLMClientAdapter();

    // 真实 CLI Driver（Kimi/Claude via DriverBridge）
    console.log(`🚗 Driver: ${driverLabel} (${preferredCli})`);
    console.log(`📁 Workspace: ${tempDir}`);
    process.env.ACP_WORKSPACE = tempDir;
    const driverTool = createRealDriver('Cycle1', tempDir);

    // AgentManager
    manager = await AgentManager.create(repository, bufferRepo, {
      tools: { llm, tools: [driverTool] },
      embedding,
    });

    // 提取器（LLM 版）
    const experienceExtractor = new LlmExperienceExtractor(llmClient);
    extractorProcessor = new ExperienceExtractorProcessor(alwaysExtractPolicy, experienceExtractor);

    // 晋升器
    promotionProcessor = new SkillPromotionProcessor(alwaysPromotePolicy, ruleBasedSkillPromotion);

    // BoardQuery
    boardQuery = new RepositoryAgentBoardQuery(repository);

    // 注册 Agent
    const handle = await manager.createAgent({
      role_id: ROLE_ID,
      name: 'Real E2E Agent',
      tags: ['e2e', 'real-llm', 'full-cycle'],
      persona_seed: '一个专注于代码实现的开发 Agent，善于编写高质量代码并总结经验',
    });
    console.log(`\n✅ Agent 已注册:`);
    console.log(`   role_id: ${handle.role_id}`);
    console.log(`   name: ${handle.name}`);
    console.log(`   status: ${handle.status}`);
  }, 120_000);

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM memory_experiences WHERE role_id = $1', [ROLE_ID]);
      await pool.query('DELETE FROM memory_skills WHERE role_id = $1', [ROLE_ID]);
      await pool.query('DELETE FROM memory_agents WHERE role_id = $1', [ROLE_ID]);
      await pool.end();
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    delete process.env.ACP_WORKSPACE;
    console.log('\n🧹 已清理临时目录和 PG 数据');
  });

  // ═══════════════════════════════════════
  //  Cycle 1
  // ═══════════════════════════════════════

  it('Cycle 1: Agent 通过真实 LLM tool-calling 执行任务', async () => {
    const task: AgentTaskRequest = {
      spec: '实现一个 JWT 认证中间件，支持 token 刷新和黑名单机制。请先查询记忆中是否有相关经验，然后调用 Driver 完成实现。',
      task_id: 'task-real-001',
      source_driver: 'code-driver',
    };

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`🚀 Cycle 1: Agent 开始执行任务`);
    console.log(`${'─'.repeat(70)}`);
    console.log(`  task_id: ${task.task_id}`);
    console.log(`  spec: ${task.spec}`);
    console.log(`${'═'.repeat(70)}`);

    cycle1Result = await manager.dispatchTask(ROLE_ID, task);

    // 打印完整 Cycle 结果
    const dr = cycle1Result.cycle.buffer_snapshot.driver_return;
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📊 Cycle 1 执行结果`);
    console.log(`${'─'.repeat(70)}`);
    console.log(`  status: ${cycle1Result.status}`);
    console.log(`  buffer_seq: ${cycle1Result.cycle.buffer_seq}`);
    console.log(`  Agent state: ${manager.getAgent(ROLE_ID)?.getState()}`);
    console.log(`\n  DriverReturn (写入 buffer 的6字段报告):`);
    console.log(`    summary: ${dr.summary}`);
    console.log(`    artifacts (${dr.artifacts.length}):`);
    for (const a of dr.artifacts) {
      console.log(`      - [${a.type}] ${a.path}: ${a.summary}`);
    }
    console.log(`    decisions (${dr.decisions.length}):`);
    for (const d of dr.decisions) {
      console.log(`      - ${d.point}: "${d.chosen}" (from: ${d.options.join(' | ')})`);
      console.log(`        reason: ${d.reason}`);
    }
    console.log(`    blockers (${dr.blockers.length}):`);
    for (const b of dr.blockers) {
      console.log(`      - ${b.blocker}`);
      console.log(`        attempts: ${b.attempts.join(' → ')}`);
      console.log(`        resolution: ${b.resolution} (resolved: ${b.resolved})`);
    }
    console.log(`    assumptions (${dr.assumptions.length}):`);
    for (const a of dr.assumptions) {
      console.log(`      - ${a.assumption}`);
      console.log(`        risk_if_wrong: ${a.risk_if_wrong}`);
    }
    console.log(`    referenced_experiences (${dr.referenced_experiences.length}):`);
    for (const r of dr.referenced_experiences) {
      console.log(
        `      - ${r.experience_id}: applied=${r.applied}, effectiveness=${r.effectiveness}, note=${r.note}`,
      );
    }
    console.log(`${'═'.repeat(70)}`);

    expect(cycle1Result.status).not.toBe('blocked');
    expect(cycle1Result.cycle.buffer_seq).toBeGreaterThan(0);
  }, 900_000);

  it('Cycle 1: 验证 buffer 文件落盘', async () => {
    const bufferDir = join(tempDir, ROLE_ID, 'buffer');
    const pendingFiles = await readdir(join(bufferDir, 'pending'));

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📂 Buffer 文件落盘验证`);
    console.log(`${'─'.repeat(70)}`);
    console.log(`  目录: ${bufferDir}`);
    console.log(`  pending/ 文件: [${pendingFiles.join(', ')}]`);

    // 读取并打印完整 buffer 内容
    const reportFile = pendingFiles.find((f) => f.startsWith('report_'));
    if (reportFile) {
      const raw = await readFile(join(bufferDir, 'pending', reportFile), 'utf-8');
      const snapshot = JSON.parse(raw) as BufferSnapshot;
      console.log(`\n  📄 ${reportFile} (BufferSnapshot):`);
      console.log(`    task_id: ${snapshot.task_id}`);
      console.log(`    task_description: ${snapshot.task_description}`);
      console.log(`    source_driver: ${snapshot.source_driver}`);
      console.log(`    received_at: ${snapshot.received_at}`);
      console.log(`    retry_count: ${snapshot.retry_count}`);
      console.log(`    extraction_status: ${snapshot.extraction_status}`);
      console.log(`    driver_return.summary: ${snapshot.driver_return.summary}`);
      console.log(`    driver_return.decisions: ${snapshot.driver_return.decisions.length} 条`);
      console.log(`    driver_return.blockers: ${snapshot.driver_return.blockers.length} 条`);
    }

    // 读取 meta
    const metaFile = join(bufferDir, 'buffer_meta.json');
    if (existsSync(metaFile)) {
      const metaRaw = await readFile(metaFile, 'utf-8');
      console.log(`\n  📊 buffer_meta.json: ${metaRaw}`);
    }
    console.log(`${'═'.repeat(70)}`);

    expect(pendingFiles.length).toBeGreaterThan(0);
    expect(pendingFiles).toContain('report_1.json');
  });

  it('Cycle 1: LlmExperienceExtractor 从 buffer 提取经验', async () => {
    const memory = createAgentMemoryScope(repository, bufferRepo, ROLE_ID);

    // 读取 pending buffer 原始数据作为提取输入
    const pendingSeqs = await memory.listPendingBufferSeqs();
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`🧠 经验提取 (LLM)`);
    console.log(`${'─'.repeat(70)}`);
    console.log(`  Pending buffer seqs: [${pendingSeqs.join(', ')}]`);

    // 打印提取器的输入
    for (const seq of pendingSeqs) {
      const pending = await memory.getPendingBuffer(seq);
      if (pending) {
        console.log(`\n  📥 提取输入 (BufferSnapshot seq=${seq}):`);
        console.log(`    task_description: ${pending.snapshot.task_description}`);
        console.log(`    driver_return.summary: ${pending.snapshot.driver_return.summary}`);
        console.log(
          `    driver_return.decisions: ${JSON.stringify(pending.snapshot.driver_return.decisions, null, 2).slice(0, 500)}`,
        );
        console.log(
          `    driver_return.blockers: ${JSON.stringify(pending.snapshot.driver_return.blockers, null, 2).slice(0, 300)}`,
        );
      }
    }

    // 执行提取
    console.log(`\n  ⏳ 调用 LlmExperienceExtractor.extract()...`);
    const extractResults = await extractorProcessor.extractAll(memory);

    // 打印提取结果
    let totalExperiences = 0;
    for (const result of extractResults) {
      totalExperiences += result.extraction.experiences.length;
      console.log(`\n  📤 提取输出 (${result.extraction.experiences.length} 条经验):`);
      console.log(
        `    stats: created=${result.extraction.result.experiences_created}, negative=${result.extraction.result.negative_experiences}`,
      );
      for (const exp of result.extraction.experiences) {
        console.log(`\n    ┌─ [${exp.type}] ${exp.description}`);
        console.log(`    │  id: ${exp.id}`);
        console.log(`    │  confidence: ${exp.confidence}`);
        console.log(`    │  tags: [${exp.tags.join(', ')}]`);
        console.log(`    │  content: ${exp.content.slice(0, 150)}...`);
        console.log(`    │  source_task_id: ${exp.source_task_id}`);
        console.log(`    │  source_driver: ${exp.source_driver}`);
        console.log(`    └─`);
      }
    }
    console.log(`\n  💾 总计提取 ${totalExperiences} 条经验`);
    console.log(`${'═'.repeat(70)}`);

    expect(totalExperiences).toBeGreaterThan(0);

    // 验证 buffer 已 processed
    const pendingAfter = await memory.listPendingBufferSeqs();
    const processedDir = join(tempDir, ROLE_ID, 'buffer', 'processed');
    const processedFiles = existsSync(processedDir) ? await readdir(processedDir) : [];
    console.log(`\n  提取后 pending: [${pendingAfter.join(', ')}] (应为空)`);
    console.log(`  processed/: [${processedFiles.join(', ')}]`);
    expect(pendingAfter.length).toBe(0);
    expect(processedFiles.length).toBeGreaterThan(0);
  }, 120_000);

  it('Cycle 1: PG 入库验证 + BoardQuery 查询', async () => {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`💾 PG 入库 & BoardQuery 查询`);
    console.log(`${'─'.repeat(70)}`);

    // listAgents
    const agents = await boardQuery.listAgents();
    console.log(`\n  👥 boardQuery.listAgents(): ${agents.length} 个`);
    for (const a of agents) {
      console.log(
        `    - ${a.role_id} (${a.name}): skills=${a.skill_count}, experiences=${a.experience_count}`,
      );
      console.log(`      persona: ${a.persona_summary}`);
    }

    const myAgent = agents.find((a) => a.role_id === ROLE_ID);
    expect(myAgent).toBeDefined();
    expect(myAgent!.experience_count).toBeGreaterThan(0);

    // getAgent
    const detail = await boardQuery.getAgent(ROLE_ID);
    console.log(`\n  🔍 boardQuery.getAgent("${ROLE_ID}"):`);
    console.log(`    role_id: ${detail.role_id}`);
    console.log(`    name: ${detail.name}`);
    console.log(`    status: ${detail.status}`);
    console.log(`    experience_count: ${detail.experience_count}`);
    console.log(`    skill_count: ${detail.skill_count}`);
    console.log(`    persona.summary: ${detail.persona.summary}`);
    console.log(`    persona.skills_overview: ${detail.persona.skills_overview}`);
    console.log(`    persona.experience_coverage: ${detail.persona.experience_coverage}`);

    // listExperiences
    const experiences = await boardQuery.listExperiences(ROLE_ID);
    console.log(`\n  📋 boardQuery.listExperiences("${ROLE_ID}"): ${experiences.length} 条`);
    for (const exp of experiences) {
      console.log(`    ┌─ [${exp.type}] ${exp.description}`);
      console.log(`    │  id: ${exp.id}`);
      console.log(`    │  confidence: ${exp.confidence}`);
      console.log(`    │  tags: [${exp.tags.join(', ')}]`);
      console.log(`    │  content: ${exp.content.slice(0, 120)}...`);
      console.log(`    │  has_embedding: ${'description_embedding' in exp}`);
      console.log(`    └─`);
      expect(exp).not.toHaveProperty('description_embedding');
    }

    // listSkills（初始应为空）
    const skills = await boardQuery.listSkills(ROLE_ID);
    console.log(`\n  🔧 boardQuery.listSkills("${ROLE_ID}"): ${skills.length} 条`);
    console.log(`${'═'.repeat(70)}`);

    expect(experiences.length).toBeGreaterThan(0);
  });

  it('Cycle 1: SkillPromotionProcessor 晋升经验为技能', async () => {
    const memory = createAgentMemoryScope(repository, bufferRepo, ROLE_ID);
    const experiences = await memory.listExperiences();

    const eligible = experiences.filter(
      (e) => e.type === 'positive' && e.confidence > 0.95 && !e.promoted_to,
    );

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`🏆 技能晋升`);
    console.log(`${'─'.repeat(70)}`);
    console.log(`  总经验: ${experiences.length} 条`);
    console.log(`  晋升条件: type=positive, confidence > 0.95, !promoted_to`);
    console.log(`  符合条件: ${eligible.length} 条`);
    for (const e of experiences) {
      const marker =
        e.type === 'positive' && e.confidence > 0.95 && !e.promoted_to ? '✅ eligible' : '⬜ skip';
      console.log(`    ${marker} [${e.type}] ${e.description} (confidence: ${e.confidence})`);
    }

    const outcomes = await promotionProcessor.promoteAll(memory);
    console.log(`\n  📤 晋升结果: ${outcomes.length} 条`);
    for (const outcome of outcomes) {
      console.log(`    - eligible: ${outcome.check.eligible}`);
      console.log(`      reasons: ${outcome.check.reasons.join('; ')}`);
      if (outcome.skill) {
        console.log(`      skill.id: ${outcome.skill.id}`);
        console.log(`      skill.description: ${outcome.skill.description}`);
        console.log(`      skill.version: ${outcome.skill.version}`);
        console.log(`      skill.review_status: ${outcome.skill.review_status}`);
      }
    }

    const skills = await memory.listSkills();
    console.log(`\n  🔧 PG 中技能总数: ${skills.length}`);
    console.log(`${'═'.repeat(70)}`);
  }, 180_000);

  // ═══════════════════════════════════════
  //  Cycle 2
  // ═══════════════════════════════════════

  it('Cycle 2: 新 Agent 实例执行第二轮任务，载入第一轮经验', async () => {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`🔄 Cycle 2: 创建新 AgentManager（同一 PG + buffer 目录）`);
    console.log(`${'─'.repeat(70)}`);

    // 新 LLM client（带日志）
    const rawLlm2 = new LiteLLMToolCallingClient();
    const llm2 = new LoggingToolCallingClient(rawLlm2, 'Cycle2');

    // 新 Driver（真实 CLI Driver，复用同一临时目录）
    const driverTool2 = createRealDriver('Cycle2', tempDir);

    // 新 Manager（同一 repository + bufferRepo → PG 数据保留）
    const manager2 = await AgentManager.create(repository, bufferRepo, {
      tools: { llm: llm2, tools: [driverTool2] },
      embedding,
    });
    console.log(`  ✅ 新 AgentManager 已创建，加载了已有 Agent: ${ROLE_ID}`);

    // 验证 Agent 已从 PG 加载
    const agent = manager2.getAgent(ROLE_ID);
    console.log(`  Agent loaded: ${!!agent}, state: ${agent?.getState()}`);

    const task: AgentTaskRequest = {
      spec: '实现一个基于 JWT 的 API 权限控制系统，需要支持角色级别的访问控制。请先查询记忆中关于 JWT 认证的经验，参考已有经验来优化实现方案。',
      task_id: 'task-real-002',
      source_driver: 'code-driver',
    };

    console.log(`\n  🚀 开始执行...`);
    console.log(`  task_id: ${task.task_id}`);
    console.log(`  spec: ${task.spec}`);

    cycle2Result = await manager2.dispatchTask(ROLE_ID, task);

    const dr2 = cycle2Result.cycle.buffer_snapshot.driver_return;
    console.log(`\n  📊 Cycle 2 结果:`);
    console.log(`    status: ${cycle2Result.status}`);
    console.log(`    buffer_seq: ${cycle2Result.cycle.buffer_seq}`);
    console.log(`    driver_summary: ${dr2.summary}`);
    console.log(`    decisions: ${dr2.decisions.length}, blockers: ${dr2.blockers.length}`);
    console.log(`    referenced_experiences: ${dr2.referenced_experiences.length}`);
    console.log(`    Agent state: ${manager2.getAgent(ROLE_ID)?.getState()}`);
    console.log(`${'═'.repeat(70)}`);

    expect(cycle2Result.status).not.toBe('blocked');
    expect(cycle2Result.cycle.buffer_seq).toBeGreaterThan(0);
    expect(manager2.getAgent(ROLE_ID)?.getState()).toBe('sleeping');
  }, 900_000);

  it('Cycle 2: 提取第二轮经验，PG 中应有两轮累积', async () => {
    const memory = createAgentMemoryScope(repository, bufferRepo, ROLE_ID);

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`🧠 Cycle 2 经验提取`);
    console.log(`${'─'.repeat(70)}`);

    const extractResults = await extractorProcessor.extractAll(memory);
    let newExperiences = 0;
    for (const result of extractResults) {
      newExperiences += result.extraction.experiences.length;
      for (const exp of result.extraction.experiences) {
        console.log(
          `  📤 新经验: [${exp.type}] ${exp.description} (confidence: ${exp.confidence})`,
        );
        console.log(`     content: ${exp.content.slice(0, 120)}...`);
      }
    }
    console.log(`\n  💾 Cycle 2 新增: ${newExperiences} 条经验`);

    const allExperiences = await memory.listExperiences();
    console.log(`  💾 PG 中总经验数: ${allExperiences.length} (两轮累积)`);
    for (const exp of allExperiences) {
      console.log(`    - [${exp.type}] ${exp.description} (confidence: ${exp.confidence})`);
    }

    const finalAgent = await boardQuery.getAgent(ROLE_ID);
    console.log(`\n  📊 最终 Agent 状态:`);
    console.log(`    experiences: ${finalAgent.experience_count}`);
    console.log(`    skills: ${finalAgent.skill_count}`);
    console.log(`    persona: ${finalAgent.persona.summary}`);

    const finalSkills = await boardQuery.listSkills(ROLE_ID);
    console.log(`\n  🔧 最终技能列表 (${finalSkills.length} 条):`);
    for (const skill of finalSkills) {
      console.log(`    - ${skill.description} (version: ${skill.version})`);
    }
    console.log(`${'═'.repeat(70)}`);

    expect(allExperiences.length).toBeGreaterThanOrEqual(2);
    expect(finalAgent.experience_count).toBeGreaterThanOrEqual(2);
  }, 300_000);
});
