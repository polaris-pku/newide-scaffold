import {
  createProductionBackendService,
  startBackendRpcServer,
} from '../../src/app/backend-rpc-stdio';
import {
  InMemoryBufferRepository,
  InMemoryMemoryDeliveryRepository,
  InMemoryRepository,
  type LlmClient,
  type ToolCallingClient,
} from '../../src/memory';
import path from 'node:path';

const service = await createProductionBackendService(process.env, {
  agentLlm: deterministicInvokeDriverLlm(),
  memoryLlm: deterministicMaintenanceLlm(),
  bRuntime: {
    repository: new InMemoryRepository(),
    bufferRepository: new InMemoryBufferRepository(),
    // 生产路径只交付上下文；没有交付存储时 scheduleBuffer 会明确报 failed
    deliveryRepository: new InMemoryMemoryDeliveryRepository(),
    app_state_root: process.env.NEWIDE_B_APP_STATE_ROOT ?? path.join(process.cwd(), '.newide'),
    market_agent_ids: ['role_fullstack_engineer', 'role_ts_engineer'],
    close: async () => undefined,
  },
});

const server = startBackendRpcServer({
  input: process.stdin,
  writeLine: (line) => process.stdout.write(`${line}\n`),
  service,
  logError: (message) => process.stderr.write(`${message}\n`),
});
await server.closed;

function deterministicInvokeDriverLlm(): ToolCallingClient {
  let sequence = 0;
  return {
    async completeWithTools(input) {
      const lastMessage = input.messages.at(-1);
      if (lastMessage?.role === 'tool') {
        return { content: 'Task completed. [done]', tool_calls: undefined };
      }

      const userMessage = [...input.messages].reverse().find((message) => message.role === 'user');
      sequence += 1;
      return {
        content: null,
        tool_calls: [
          {
            id: `task_rpc_tool_call_${String(sequence)}`,
            type: 'function',
            function: {
              name: 'invoke_driver',
              arguments: JSON.stringify({
                instruction: userMessage?.content?.replace(/^Task:\s*/, '') ?? 'Execute task.',
              }),
            },
          },
        ],
      };
    },
  };
}

function deterministicMaintenanceLlm(): LlmClient {
  return {
    async complete(input) {
      const userMessage = input.messages.find((message) => message.role === 'user')?.content ?? '';
      // 上下文清理问的是另一件事：答成提取结果只会让清理静默降级。
      if (userMessage.includes('## Raw Agent Context')) {
        return JSON.stringify({
          thinking_trace: 'RPC fixture top-level reasoning.',
          planning_trace: 'RPC fixture execution plan.',
        });
      }
      return JSON.stringify({
        experiences: [
          {
            description: 'Child-process execution lesson',
            content: 'Use durable task events and explicit application ports.',
            type: 'positive',
            confidence: 0.99,
            tags: ['rpc'],
          },
        ],
      });
    },
  };
}
