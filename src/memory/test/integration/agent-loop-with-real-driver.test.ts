/**
 * Agent Loop 集成测试 — 使用真实 LLM Driver（CLI 模式）
 *
 * 与 agent-loop-integration.test.ts 的区别：
 * - Driver 不再是 mock，而是通过 createLlmDriver({ mode: 'cli' }) 调用本地 claude 命令
 * - 验证 Agent LLM 调用 invoke_driver → Claude 实际"执行" → 返回结构化 DriverReturn
 * - 完整链路：Agent LLM → 调用工具 → Driver（本地 Claude）→ 结构化报告 → 写 buffer
 *
 * 需要本地安装 claude 命令行工具（无需 API key）。
 * 无 claude 命令时自动跳过。
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentManager } from '../../runtime/agent-manager';
import { InMemoryRepository } from '../../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../../adapters/in-memory-buffer-repository';
import { LiteLLMToolCallingClient } from '../../adapters/litellm-tool-calling-client';
import { InvokeDriverTool } from '../../runtime/tools/invoke-driver-tool';
import { DriverBridge } from '../../../driver/driver-bridge';
import { CliDriverRuntime } from '../drivers/cli-driver-runtime';
import type { AgentTaskRequest } from '../../agent-types';

// ──────────────────────────────────────────────
// 环境检查
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// 环境变量加载（从 src/memory/.env 读取 DEEPSEEK_API_KEY）
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
}

loadEnv();

/** 检查 claude 命令行工具是否可用 */
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

const KIMI_PATH = 'C:\\Users\\13008\\.kimi-code\\bin\\kimi.exe';

const deps = {
  kimiCli: existsSync(KIMI_PATH),
  claudeCli: hasCli('claude'),
  deepseekKey: !!(process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY),
};

// ──────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────

describe('Agent loop with real LLM Driver (CLI)', () => {
  const missing: string[] = [];
  if (!deps.kimiCli && !deps.claudeCli) missing.push('kimi / claude CLI');
  if (!deps.deepseekKey) missing.push('DEEPSEEK_API_KEY / OPENAI_API_KEY');

  if (missing.length > 0) {
    console.warn(`⚠ 缺少依赖: ${missing.join(', ')} — real LLM driver test 已跳过。`);
  }

  /**
   * 端到端集成测试：
   *
   * 1. 顶层 Agent 使用 LiteLLMToolCallingClient（真实 LLM）
   * 2. Driver 使用 CliDriverRuntime + DriverBridge 调用本地 CLI（优先 kimi）
   * 3. Agent 收到任务后通过 tool-calling 循环自主决策
   * 4. LLM 应自然调用 invoke_driver 工具
   * 5. CLI Driver 收到子任务，返回结构化 DriverReturn
   * 6. Agent 看到 driver 返回 → 报告完成 → writeToBuffer
   */
  it.runIf((deps.kimiCli || deps.claudeCli) && deps.deepseekKey)(
    '应完成完整的 agent loop 周期：Agent LLM → invoke_driver → CLI Driver → writeToBuffer',
    async () => {
      // ── 1. 存储层 ──
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();

      // 临时工作目录，避免 CLI driver 生成的文件污染项目根
      const workspace = await mkdtemp(join(tmpdir(), 'agent-loop-driver-'));
      try {

      // ── 2. 顶层 Agent 的 LLM ──
      const llm = new LiteLLMToolCallingClient({
        taskName: 'memory-query',
      });

      // ── 3. 真实 CLI Driver（优先 kimi，回退 claude） ──
      let driverCallCount = 0;
      let lastDriverInstruction = '';

      const useKimi = deps.kimiCli;
      const cliDriver = new CliDriverRuntime({
        cliCommand: useKimi ? KIMI_PATH : 'claude',
        args: useKimi ? [] : ['--dangerously-skip-permissions'],
        promptArgs: useKimi ? ['-p'] : [],
        driverId: useKimi ? 'kimi-driver' : 'claude-driver',
        cwd: workspace,
      });
      const bridge = new DriverBridge({ driver: cliDriver });
      const driverHandler = bridge.createHandler();

      const driverTool = new InvokeDriverTool(async (task) => {
        driverCallCount++;
        lastDriverInstruction = task.instruction;
        return driverHandler(task);
      });

      // ── 4. 自定义 System Prompt ──
      const systemPrompt = [
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

      // ── 5. AgentManager ──
      const manager = await AgentManager.create(repository, bufferRepository, {
        tools: {
          llm,
          tools: [driverTool],
          systemPrompt,
          maxToolCalls: 10,
        },
      });

      await manager.createAgent({
        role_id: 'role_driver_cli_test',
        name: 'CLI Driver Test Agent',
        tags: [],
      });

      // ── 6. 提交任务 ──
      //     需要 Driver 分析代码并给出改进建议
      const task: AgentTaskRequest = {
        spec:
          'Write "Hello" to a file named hello.txt. ' +
          'Use invoke_driver to perform the work.',
        task_id: 'task_driver_cli_001',
        call_id: 'call_driver_cli_001',
        source_driver: 'test-driver',
      };

      const result = await manager.dispatchTask('role_driver_cli_test', task);

      // ── 7. 断言 ──

      // 7a. 任务状态
      expect(result.status).toBe('completed');
      expect(result.role_id).toBe('role_driver_cli_test');

      // 7b. LLM 实际调用了 invoke_driver
      expect(driverCallCount).toBeGreaterThanOrEqual(1);
      expect(lastDriverInstruction).toContain('hello');

      // 7c. MemoryCycleResult 的 agent_id 正确
      expect(result.cycle.agent_id).toBe('role_driver_cli_test');
      expect(result.cycle.buffer_snapshot.task_id).toBe('task_driver_cli_001');

      // 7d. Driver 返回了真实的结构化结果（非 mock 硬编码）
      const dr = result.cycle.buffer_snapshot.driver_return;
      expect(dr.summary).toBeTruthy();
      expect(dr.summary.length).toBeGreaterThan(10);
      expect(dr.artifacts).toBeDefined();
      expect(dr.decisions.length).toBeGreaterThanOrEqual(1);
      expect(dr.decisions[0]!.point).toBeTruthy();

      // 7e. 提取和晋升未被同步执行（由离线 Processor 处理）
      expect(result.cycle.extraction.result.experiences_created).toBe(0);
      expect(result.cycle.extraction.result.skills_promoted).toBe(0);

      // 7f. Buffer 中有一条 pending 记录
      const meta = await bufferRepository.getBufferMeta('role_driver_cli_test');
      expect(meta.pending_count).toBe(1);

      // 7g. Agent 已回到 sleeping 状态
      const agent = manager.getAgent('role_driver_cli_test')!;
      expect(agent.getState()).toBe('sleeping');
      expect(agent.hasPendingTask()).toBe(false);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
    180_000, // 超时：Agent LLM + CLI driver 两次调用，设 3 分钟
  );
});
