/**
 * AgentLoopObserver — Agent 自循环的可选观测端口。
 *
 * 定义顶层 Agent 在 tool-calling 循环中的观测点：每次 LLM 轮次的开始/结束/异常，
 * 以及每个工具调用的开始/结束（含参数与结果）。全部回调可选、默认不调用，
 * 因此不配置 observer 时零行为变化。Memory 模块只定义端口，
 * 由应用层（如 DriverRuntimeAgentExecutionFacade）实现并转发到轨迹系统。
 */
import type { LlmUsage, ToolCallMessage } from './tool';

/** 一次 LLM 轮次开始。 */
export interface AgentLlmTurnStartEvent {
  /** 轮次序号（从 1 开始） */
  round: number;
  /** 调用 LLM 时的消息条数 */
  messageCount: number;
}

/** 一次 LLM 轮次正常结束。 */
export interface AgentLlmTurnEndEvent {
  round: number;
  content: string | null;
  /** 该轮次 LLM 请求的工具调用数量 */
  toolCallCount: number;
  /** 可选用量统计（token / 上下文占用），来自 LLM 响应。 */
  usage?: LlmUsage;
}

/** 一次 LLM 轮次抛出异常。 */
export interface AgentLlmTurnErrorEvent {
  round: number;
  error: unknown;
}

/** 一个工具调用开始执行。 */
export interface AgentToolCallStartEvent {
  round: number;
  tool_call_id: string;
  tool_name: string;
  /** LLM 返回的原始 JSON 参数字符串 */
  arguments: string;
  /** 当前对话消息（含本轮的 assistant tool_calls 消息） */
  messages: ToolCallMessage[];
}

/** 一个工具调用执行结束（成功或失败）。 */
export interface AgentToolCallEndEvent {
  round: number;
  tool_call_id: string;
  tool_name: string;
  ok: boolean;
  /** 执行成功时的工具返回 */
  result?: unknown;
  /** 执行失败（含未知工具、参数解析失败）时的错误信息 */
  error?: string;
}

/** Agent 自循环观测端口：所有回调可选，未实现即忽略。 */
export interface AgentLoopObserver {
  onLlmTurnStart?(event: AgentLlmTurnStartEvent): void;
  onLlmTurnEnd?(event: AgentLlmTurnEndEvent): void;
  onLlmTurnError?(event: AgentLlmTurnErrorEvent): void;
  onToolCallStart?(event: AgentToolCallStartEvent): void;
  onToolCallEnd?(event: AgentToolCallEndEvent): void;
}
