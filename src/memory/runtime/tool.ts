/**
 * Tool 抽象层
 *
 * 定义顶层 Agent 可使用的工具接口（Tool），以及工具注册表（ToolRegistry）。
 * 工具是插件式的：memory 模块提供 QueryMemoryTool 作为内置工具，
 * InvokeDriverTool 作为插槽，由外部模块注入具体的 driver handler。
 *
 * 同时定义 tool-calling 所需的 LLM 通信类型（ToolCallMessage、ToolDefinition），
 * 以及扩展的 ToolCallingClient 接口（在 LlmClient 之上增加 tool-calling 能力）。
 */
// ──────────────────────────────────────────────
// Tool 通用接口
// ──────────────────────────────────────────────

export interface Tool<TInput = unknown, TOutput = unknown> {
  /** 工具唯一标识，LLM 通过此 name 调用 */
  readonly name: string;
  /** 工具描述，LLM 理解何时/为何调用 */
  readonly description: string;
  /** JSON Schema 格式的输入参数定义 */
  readonly inputSchema: Record<string, unknown>;
  /** 执行工具逻辑 */
  execute(input: TInput): Promise<TOutput>;
}

// ──────────────────────────────────────────────
// LLM Tool-calling 类型
// ──────────────────────────────────────────────

/** 支持 tool-calling 的消息角色 */
export type ToolCallRole = 'system' | 'user' | 'assistant' | 'tool';

/** 支持 tool-calling 的消息 */
export interface ToolCallMessage {
  role: ToolCallRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** LLM 返回的 tool_call */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/** 注册给 LLM 的工具定义（OpenAI function-calling 格式） */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * 一次 LLM 调用的 token / 上下文用量（可选）。实现方（LLM adapter）能拿到
 * usage 统计时就填，拿不到则为 undefined；轨迹诊断层用它在回放时画上下文
 * 用量曲线并报警（>70% 上下文爆掉风险）。
 */
export interface LlmUsage {
  /** 本轮请求 token 数（输入）。 */
  tokens_in?: number;
  /** 本轮响应 token 数（输出）。 */
  tokens_out?: number;
  /** 当前上下文窗口已用 token 数。 */
  context_size?: number;
  /** 当前上下文窗口上限 token 数。 */
  context_limit?: number;
  /** 已用比例 0..100；缺省时按 context_size / context_limit 推算。 */
  context_pct?: number;
}

/** Tool-calling 调用的返回 */
export interface ToolCallResult {
  content: string | null;
  tool_calls: ToolCall[] | undefined;
  /** 可选用量统计，用于轨迹的上下文用量曲线。 */
  usage?: LlmUsage;
}

/**
 * 支持 tool-calling 的 LLM 客户端接口。
 * 在基础的 LlmClient 之上扩展了工具调用能力。
 * 实现此接口的 adapter 需要支持 tools 参数与 tool_calls 响应。
 */
export interface ToolCallingClient {
  /**
   * 发送消息给 LLM，附带可用工具定义。
   * LLM 可以选择回复文本或调用工具。
   */
  completeWithTools(input: {
    messages: ToolCallMessage[];
    tools: ToolDefinition[];
    tool_choice?: 'auto' | 'none';
  }): Promise<ToolCallResult>;
}

// ──────────────────────────────────────────────
// ToolRegistry
// ──────────────────────────────────────────────

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools?: Tool[]) {
    if (tools) {
      for (const tool of tools) {
        this.register(tool);
      }
    }
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** 将所有注册的工具转换为 LLM function-calling 格式 */
  toToolDefinitions(): ToolDefinition[] {
    return this.list().map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }));
  }
}
