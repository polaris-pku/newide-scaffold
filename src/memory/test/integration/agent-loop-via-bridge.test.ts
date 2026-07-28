/**
 * Agent Loop 集成测试 — 通过 DriverBridge 走 A 侧 Driver 管线
 *
 * 与 agent-loop-with-real-driver.test.ts 的关键区别：
 * - Driver 不再是 B 侧 DriverHandler（createLlmDriver 直接返回 DriverReturn）
 * - Driver 是 A 侧 DriverRuntimeHandle（CliDriverRuntime 返回 DriverRunResult）
 * - 必须经过 DriverBridge 转换才能接入 InvokeDriverTool
 *
 * 完整链路：
 *   Agent LLM (DeepSeek/LiteLLM)
 *   → tool-calling 决定调用 invoke_driver
 *     → InvokeDriverTool
 *       → DriverBridge.createHandler()
 *         → ① buildDriverPrompt: DriverTask → DriverPrompt
 *         → ② CliDriverRuntime.sendPrompt → CLI 执行
 *         → ③ DriverReturnConverter: DriverRunResult → DriverReturn
 *         → ④ enrichDriverReturn: 补充 bridge 元信息
 *       ← DriverReturn（六字段报告）
 *     → writeToBuffer
 *   → MemoryCycleResult
 *
 * 依赖：
 * - claude CLI 命令（本地测试用，无需 API key）
 * - DEEPSEEK_API_KEY（LiteLLMToolCallingClient 需要）
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { AgentManager } from '../../runtime/agent-manager';
import { InMemoryRepository } from '../../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../../adapters/in-memory-buffer-repository';
import { LiteLLMToolCallingClient } from '../../adapters/litellm-tool-calling-client';
import { InvokeDriverTool } from '../../runtime/tools/invoke-driver-tool';
import { DriverBridge } from '../../../driver/driver-bridge';
import { CliDriverRuntime } from '../drivers/cli-driver-runtime';
import type { AgentTaskRequest } from '../../agent-types';

// ──────────────────────────────────────────────
// 环境变量加载
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

/** 检查 CLI 工具是否可用 */
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

const kimiPath = 'C:\\Users\\13008\\.kimi-code\\bin\\kimi.exe';

/** 检查文件是否存在（绕过 PATH 限制） */
function fileExists(filePath: string): boolean {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

const deps = {
  claudeCli: hasCli('claude'),
  kimiCli: fileExists(kimiPath),
  deepseekKey: !!(process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY),
};

// 优先用 Kimi Code，其次 Claude
const kimiCmd = kimiPath;
const preferredCli = deps.kimiCli ? kimiCmd : deps.claudeCli ? 'claude' : null;

// ──────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────

describe('Agent loop via DriverBridge (A-side driver → Bridge → B-side tool)', () => {
  const missing: string[] = [];
  if (!preferredCli) missing.push('CLI (claude / kimi)');
  if (!deps.deepseekKey) missing.push('DEEPSEEK_API_KEY / OPENAI_API_KEY');

  if (missing.length > 0) {
    console.warn(`⚠ 缺少依赖: ${missing.join(', ')} — Bridge 集成测试已跳过。`);
  }

  // 临时工作目录：避免 AI driver 生成的文件污染项目根目录
  const tempDir = mkdtempSync(join(tmpdir(), 'newide-bridge-test-'));
  const originalAcpWorkspace = process.env.ACP_WORKSPACE;
  process.env.ACP_WORKSPACE = tempDir;

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalAcpWorkspace) {
      process.env.ACP_WORKSPACE = originalAcpWorkspace;
    } else {
      delete process.env.ACP_WORKSPACE;
    }
  });

  /**
   * 端到端集成测试 — 完整 Bridge 管线
   *
   * 验证：
   * 1. Agent LLM 通过 tool-calling 调用 invoke_driver
   * 2. DriverBridge 正确构建 DriverPrompt（含格式指令）
   * 3. CliDriverRuntime 通过 sendPrompt 调用本地 CLI
   * 4. DriverReturnConverter 将 DriverRunResult 转换为 DriverReturn
   *    （优先从 transcript 解析结构化报告，降级为元数据构造）
   * 5. enrichDriverReturn 补充 bridge 元信息
   * 6. writeToBuffer 持久化结果
   */
  it.runIf(!!preferredCli && deps.deepseekKey)(
    '应完成完整 Bridge 管线：Agent LLM → InvokeDriverTool → DriverBridge → CLI Driver → DriverReturnConverter → writeToBuffer',
    async () => {
      // ── 1. 存储层 ──
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();

      // ── 2. 顶层 Agent 的 LLM ──
      const llm = new LiteLLMToolCallingClient({
        taskName: 'memory-query',
      });

      // ── 3. A 侧 Driver（CLI） + DriverBridge ──
      let driverCallCount = 0;
      let lastDriverInstruction = '';

      const cliDriver = new CliDriverRuntime({
        cliCommand: preferredCli!,
        args: preferredCli!.includes('kimi') ? [] : ['--dangerously-skip-permissions'],
        promptArgs: preferredCli!.includes('kimi') ? ['-p'] : [],
        driverId: preferredCli!.includes('kimi') ? 'kimi-driver' : 'cli-driver',
        cwd: tempDir,
      });

      const bridge = new DriverBridge({ driver: cliDriver });

      const driverTool = new InvokeDriverTool(async (task) => {
        driverCallCount++;
        lastDriverInstruction = task.instruction;
        return bridge.invokeDriver(task);
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
        role_id: 'role_bridge_test',
        name: 'DriverBridge Test Agent',
        tags: [],
      });

      // ── 6. 提交任务 ──
      const task: AgentTaskRequest = {
        spec:
          'Analyze the following code snippet and suggest improvements. ' +
          'Use invoke_driver to perform the analysis.\n\n' +
          '```\n' +
          'function greet(name) {\n' +
          '  return "Hello, " + name;\n' +
          '}\n' +
          '```',
        task_id: 'task_bridge_001',
        call_id: 'call_bridge_001',
        source_driver: 'test-driver',
      };

      const result = await manager.dispatchTask('role_bridge_test', task);

      // ── 7. 断言 ──

      // 7a. 任务状态
      expect(result.status).toBe('completed');
      expect(result.role_id).toBe('role_bridge_test');

      // 7b. LLM 实际调用了 invoke_driver
      expect(driverCallCount).toBeGreaterThanOrEqual(1);
      expect(lastDriverInstruction).toContain('greet');

      // 7c. MemoryCycleResult 的 agent_id 正确
      expect(result.cycle.agent_id).toBe('role_bridge_test');
      expect(result.cycle.buffer_snapshot.task_id).toBe('task_bridge_001');

      // 7d. Driver 返回了真实的结构化结果
      //     Bridge 管线保证 DriverReturn 即使降级也包含 summary
      const dr = result.cycle.buffer_snapshot.driver_return;
      expect(dr.summary).toBeTruthy();
      expect(dr.summary.length).toBeGreaterThan(10);

      // 7e. artifacts 存在即可（降级构造可能为空，但定义存在）
      expect(dr.artifacts).toBeDefined();

      // 7f. decisions 至少包含从 tool_events 推导的决策
      //     （constructDriverReturnFromResult 从 tool_events 生成基本决策链）
      expect(dr.decisions.length).toBeGreaterThanOrEqual(1);

      // 7g. summary 应包含 driver_id 标识
      //     （constructDriverReturnFromResult 从 DriverRunResult 拼接的 summary 中包含 driver_id）
      const driverIdLabel = preferredCli!.includes('kimi') ? 'kimi-driver' : 'cli-driver';
      expect(dr.summary).toContain(driverIdLabel);

      // 7h. 提取和晋升未被同步执行（由离线 Processor 处理）
      expect(result.cycle.extraction.result.experiences_created).toBe(0);
      expect(result.cycle.extraction.result.skills_promoted).toBe(0);

      // 7i. Buffer 中有一条 pending 记录
      const meta = await bufferRepository.getBufferMeta('role_bridge_test');
      expect(meta.pending_count).toBe(1);

      // 7j. Agent 已回到 sleeping 状态
      const agent = manager.getAgent('role_bridge_test')!;
      expect(agent.getState()).toBe('sleeping');
      expect(agent.hasPendingTask()).toBe(false);
    },
    300_000, // 超时：Agent LLM + Claude CLI 多次调用，设 5 分钟
  );
});
