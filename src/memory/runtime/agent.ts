/**
 * Agent 运行时（员工）
 *
 * 持有 AgentMemoryScope，通过 LLM tool-calling 执行任务。
 *
 * ## 执行模式
 *
 * Tool-calling 模式 — Agent 的 LLM 自主调用工具（query_memory / invoke_driver 等），
 * 通过 `executeTask()` 触发内部自循环，直至任务完成。
 *
 * ## 构造方式
 *
 * ```ts
 * const agent = new Agent(memory, { llm, tools: [...] });
 * ```
 */
import type { AgentHandle, DriverReturn, AgentStatus } from '../schemas';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { AgentLoopState, AgentTaskRequest } from '../agent-types';
import type { MemoryCycleResult } from '../types';
import type { CompetitionClaimEvaluator } from '../ports/competition-claim-evaluator';
import type { AgentCompetitionClaim } from '../competition-types';
import { createMockCompetitionClaimEvaluator } from '../adapters/mock-competition-claim-evaluator';
import { ToolRegistry, type Tool, type ToolCallMessage, type ToolCallingClient } from './tool';
import { createId, nowTimestamp } from '../../core';
import { writePendingBuffer } from '../services/buffer-writer';
import { buildAgentSystemPrompt } from '../prompts/agent-system-prompt';

// ──────────────────────────────────────────────
// Tool-calling 配置
// ──────────────────────────────────────────────

/**
 * Agent 的 tool-calling 模式配置。
 * 提供此配置时，Agent 将使用 LLM tool-calling 替代固定 pipeline。
 */
export interface AgentToolConfig {
  /** 顶层 Agent 的 LLM（需支持 tool-calling） */
  llm: ToolCallingClient;
  /** 注册的工具列表（如 QueryMemoryTool、InvokeDriverTool 等） */
  tools: Tool[];
  /** 顶层 Agent 的系统提示词 */
  systemPrompt?: string;
  /** 单次任务最大 tool-calling 轮次（防死循环，默认 20） */
  maxToolCalls?: number;
}

// ──────────────────────────────────────────────
// Agent 类
// ──────────────────────────────────────────────

export class Agent {
  private state: AgentLoopState = 'idle';
  private readonly toolConfig: AgentToolConfig | undefined;
  private readonly toolRegistry: ToolRegistry | undefined;
  private readonly evaluator: CompetitionClaimEvaluator;

  // ── 持久循环状态（跨 tick 存活） ──
  /** 当前处理的 task；null 表示空闲 */
  private currentTask: AgentTaskRequest | null = null;
  /** 跨 tick 累积的 tool-calling 对话消息 */
  private loopMessages: ToolCallMessage[] | null = null;
  /** 最后一次 invoke_driver 的返回（写入 buffer 时需要） */
  private lastDriverReturn: DriverReturn | undefined;
  /** 已执行轮次（防死循环） */
  private loopRound: number = 0;
  /** 任务完成后的 cycle 结果，供 runOnce 包装使用 */
  private lastCycleResult: MemoryCycleResult | null = null;

  constructor(
    private readonly memory: AgentMemoryScope,
    toolConfig: AgentToolConfig,
    evaluator?: CompetitionClaimEvaluator,
  ) {
    this.toolConfig = toolConfig;
    this.toolRegistry = new ToolRegistry(toolConfig.tools);
    this.evaluator = evaluator ?? createMockCompetitionClaimEvaluator('participate');
  }

  get role_id(): string {
    return this.memory.role_id;
  }

  getState(): AgentLoopState {
    return this.state;
  }

  getHandle(): Promise<AgentHandle> {
    return this.memory.getAgent();
  }

  /** 是否有待处理的任务 */
  hasPendingTask(): boolean {
    return this.currentTask !== null;
  }

  /**
   * 根据任务机会生成参选声明。
   *
   * 流程：
   * 1. 检查 Agent 可用状态（draining/retired/stopped → unavailable）
   * 2. 调用 CompetitionClaimEvaluator 做简单自评（participate/decline）
   * 3. 返回声明（不含详细竞标信息，待与 bid 模块对齐后补充）
   *
   * 约束：
   * - 不写 Buffer、不创建 Experience、不进入任务执行状态
   * - 不改变 Agent 的 state（保持当前 idle/sleeping/running 状态）
   * - running 的 Agent 仍会参与自评，但标记 busy: true
   */
  async createCompetitionClaim(task: AgentTaskRequest): Promise<AgentCompetitionClaim> {
    const role_id = this.memory.role_id;
    const agentHandle = await this.memory.getAgent();
    const agent_status: AgentStatus = agentHandle.status;
    const loop_state = this.state;
    const now = nowTimestamp();

    // 不可用状态 → 直接返回 unavailable
    if (agent_status === 'draining' || agent_status === 'retired' || loop_state === 'stopped') {
      return {
        role_id,
        decision: 'unavailable',
        availability: { agent_status, loop_state: this.state },
        generated_at: now,
      };
    }

    try {
      // 调用 evaluator 做简单自评（当前只返回 decision，详细字段待 bid 模块对齐）
      const content = await this.evaluator.evaluate({ task });

      return {
        role_id,
        ...content,
        availability: {
          agent_status,
          loop_state: this.state,
          ...(loop_state === 'running' ? { busy: true } : {}),
        },
        generated_at: now,
      };
    } catch {
      return {
        role_id,
        decision: 'error',
        availability: {
          agent_status,
          loop_state: this.state,
          ...(loop_state === 'running' ? { busy: true } : {}),
        },
        generated_at: now,
      };
    }
  }

  // ────────────────────────────────────────────
  // 自驱循环（内部自循环，不可外部逐 tick 驱动）
  // ────────────────────────────────────────────

  /**
   * Agent 自驱执行循环。
   *
   * 接任务后自主重复 LLM 调用 → 工具执行 → 完成判断，直至任务完成或达到上限。
   * 外部只需 await executeTask() 等待结果，无需逐 tick 驱动。
   */
  private async runLoop(): Promise<void> {
    while (this.state === 'running') {
      const shouldStop = await this.runOneRound();
      if (shouldStop) break;
    }
  }

  /**
   * 单轮 LLM 交互：一次 LLM 调用 → 解析回复 → 执行工具 → 积累 messages。
   *
   * @returns true 表示循环应停止（完成任务/达到上限/无任务），false 表示继续下一轮
   */
  private async runOneRound(): Promise<boolean> {
    // 没有任务 → stop
    if (!this.currentTask) {
      return true;
    }

    // 仅 tool-calling 模式支持循环
    if (!this.toolConfig || !this.toolRegistry || !this.loopMessages) {
      return true;
    }

    // 检查最大轮次
    const maxCalls = this.toolConfig.maxToolCalls ?? 20;
    if (this.loopRound >= maxCalls) {
      await this.finalizeLoop();
      return true;
    }

    // 单步：一次 LLM 调用
    const response = await this.toolConfig.llm.completeWithTools({
      messages: this.loopMessages,
      tools: this.toolRegistry.toToolDefinitions(),
      tool_choice: 'auto',
    });

    this.loopRound++;

    if (response.tool_calls && response.tool_calls.length > 0) {
      // LLM 调用了工具 → 执行并将结果加入 messages
      const assistantMsg: ToolCallMessage = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.tool_calls,
      };
      this.loopMessages.push(assistantMsg);

      for (const toolCall of response.tool_calls) {
        const tool = this.toolRegistry.get(toolCall.function.name);
        if (!tool) {
          this.loopMessages.push({
            role: 'tool',
            content: `Error: unknown tool "${toolCall.function.name}"`,
            tool_call_id: toolCall.id,
          });
          continue;
        }

        try {
          const args = JSON.parse(toolCall.function.arguments);
          const result = await tool.execute(args);

          // 记录最后一次 invoke_driver 的返回
          if (tool.name === 'invoke_driver') {
            this.lastDriverReturn = result as DriverReturn;
          }

          const content =
            typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);

          this.loopMessages.push({
            role: 'tool',
            content,
            tool_call_id: toolCall.id,
          });
        } catch (error) {
          this.loopMessages.push({
            role: 'tool',
            content: `Error executing ${tool.name}: ${error instanceof Error ? error.message : String(error)}`,
            tool_call_id: toolCall.id,
          });
        }
      }
    } else {
      // LLM 返回文本（没有 tool_call）
      this.loopMessages.push({
        role: 'assistant',
        content: response.content,
      });

      // 检查 LLM 是否表示任务完成
      if (response.content && this.isTaskComplete(response.content)) {
        await this.finalizeLoop();
        return true;
      }
    }

    return false; // 继续循环
  }

  /**
   * 将任务派发给 Agent，由 Agent 自行通过自循环处理。
   *
   * @throws 如果 Agent 已有正在运行的任务
   */
  private async assignTask(task: AgentTaskRequest): Promise<void> {
    if (this.currentTask) {
      throw new Error(
        `Agent ${this.memory.role_id} already has a running task (${this.currentTask.task_id}). ` +
          'Stop or wait for completion before assigning a new task.',
      );
    }

    this.currentTask = task;
    this.state = 'running';
    this.lastDriverReturn = undefined;
    this.loopRound = 0;
    this.lastCycleResult = null;

    if (this.toolConfig && this.toolRegistry) {
      // Tool-calling 模式：构建初始 messages
      const systemPromptContent =
        this.toolConfig.systemPrompt ??
        (await buildAgentSystemPrompt(this.memory, this.toolRegistry.toToolDefinitions()));

      this.loopMessages = [
        {
          role: 'system',
          content: systemPromptContent,
        },
        {
          role: 'user',
          content: `Task: ${task.spec}`,
        },
      ];
    } else {
      // Pipeline 模式不使用 loopMessages（已废弃）
      this.loopMessages = null;
    }
  }

  /**
   * 单轮任务同步执行入口（向后兼容）。
   *
   * - 配置了 toolConfig 时 → Tool-calling 模式（LLM 自主决策，内部自循环直至完成）
   */
  async runOnce(task: AgentTaskRequest): Promise<MemoryCycleResult> {
    return this.executeTask(task);
  }

  /**
   * Agent 自驱执行入口。
   *
   * Agent 内部自循环（LLM 自主决策 → 工具调用 → buffer 写入），
   * **不含经验提取和技能晋升**（由离线 Processor 处理）。
   *
   * 流程：
   * ```
   * assignTask → runLoop (LLM 交互 × N) → writeToBuffer → 完成
   * ```
   */
  async executeTask(task: AgentTaskRequest): Promise<MemoryCycleResult> {
    this.state = 'running';
    let assigned = false;
    try {
      await this.assignTask(task);
      assigned = true;
      await this.runLoop();

      const result = this.lastCycleResult;
      if (!result) {
        await this.finalizeLoop();
        return this.lastCycleResult!;
      }
      return result;
    } finally {
      this.state = 'sleeping';
      // Failure / throw paths skip finalizeLoop; without this, currentTask
      // stays set, hasPendingTask() remains true, and a shared backend
      // reports B_BLOCKED for every later instance.
      if (assigned) {
        this.clearLoopState();
      }
    }
  }

  // ────────────────────────────────────────────
  // 内部方法
  // ────────────────────────────────────────────

  /**
   * 完成当前任务：写入 buffer → 清理状态。
   */
  private async finalizeLoop(): Promise<void> {
    if (!this.currentTask) return;

    const result = await this.writeToBuffer(
      this.currentTask,
      this.currentTask.task_id ?? createId('task'),
      this.currentTask.call_id ?? createId('call'),
      this.lastDriverReturn,
    );

    this.lastCycleResult = result;
    this.clearLoopState();
    this.state = 'sleeping';
  }

  /**
   * 清理持久循环状态（不改变 state）。
   */
  private clearLoopState(): void {
    this.currentTask = null;
    this.loopMessages = null;
    this.lastDriverReturn = undefined;
    this.loopRound = 0;
  }

  /**
   * 检查 LLM 回复是否表示任务已完成。
   * 简单的启发式检查，后续可优化为 LLM 判断。
   */
  private isTaskComplete(content: string): boolean {
    const lower = content.toLowerCase();
    const finishIndicators = [
      'task complete',
      'task completed',
      'all done',
      'finished',
      '[done]',
      '任务完成',
      '已完成',
    ];
    return finishIndicators.some((indicator) => lower.includes(indicator));
  }

  /**
   * 写入 pending buffer，不做提取和晋升。
   *
   * 经验提取和技能晋升游离于 Agent 执行循环之外，由后续的 BufferProcessor
   * 异步处理，确保 Agent 的在线路径不被后处理阻塞。
   */
  private async writeToBuffer(
    task: AgentTaskRequest,
    task_id: string,
    call_id: string,
    lastDriverReturn: DriverReturn | undefined,
  ): Promise<MemoryCycleResult> {
    const persona = await this.memory.getPersona();
    const skills_before = await this.memory.listSkills();

    // 如果 LLM 没有调用 invoke_driver，构造一个占位 DriverReturn
    const driverReturn: DriverReturn = lastDriverReturn ?? {
      artifacts: [],
      summary: 'Task completed by top-level agent without driver invocation.',
      decisions: [],
      blockers: [],
      referenced_experiences: [],
      assumptions: [],
    };

    // 写入 pending buffer（仅存储，不处理）
    const ingested = await writePendingBuffer(
      this.memory,
      {
        task_id,
        task_description: task.spec,
        driver_return: driverReturn,
        source_task_id: task_id,
        source_driver: 'tool-calling-agent',
        received_at: nowTimestamp(),
        retry_count: 0,
        extraction_status: 'pending',
      },
      undefined,
    );

    return {
      agent_id: this.memory.role_id,
      persona,
      skills_before,
      retrieval: { skills: [], experiences: [] },
      driver_context: {
        task_instruction: task.spec,
        skills: [],
        experiences: [],
      },
      buffer_snapshot: ingested.snapshot,
      buffer_seq: ingested.seq,
      // 提取和晋升由离线 BufferProcessor 处理，这里返回空值
      extraction: {
        experiences: [],
        result: {
          experiences_created: 0,
          experiences_updated: 0,
          negative_experiences: 0,
          skills_promoted: 0,
        },
      },
      promotion: {
        check: {
          eligible: false,
          auto_approved: false,
          reasons: [],
          blocking_rules: ['extraction and promotion are handled offline'],
        },
      },
    };
  }
}
