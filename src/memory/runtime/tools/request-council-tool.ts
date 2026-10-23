import type { Tool } from '../tool';

export interface RequestCouncilInput {
  reason?: string;
}

export interface RequestCouncilResult {
  requested: true;
  reason?: string;
}

/**
 * Explicit escalation capability for the top-level Agent.
 *
 * The production facade supplies the handler and enforces the per-run gate.
 * Keeping this as a normal tool makes the request visible in the Agent trace
 * and gives the Coordinator a durable, typed handoff instead of parsing text.
 */
export class RequestCouncilTool implements Tool<RequestCouncilInput, RequestCouncilResult> {
  readonly name = 'invoke_council';
  readonly description =
    '请求将当前 Solo 任务升级到 Council。仅在任务需要多方案比较、独立评审或高风险决策时调用。';
  readonly inputSchema = {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: '说明为什么当前任务需要 Council 介入',
      },
    },
    required: [],
  };

  constructor(
    private readonly handler: (input: RequestCouncilInput) => Promise<RequestCouncilResult>,
  ) {}

  execute(input: RequestCouncilInput): Promise<RequestCouncilResult> {
    return this.handler(input);
  }
}
