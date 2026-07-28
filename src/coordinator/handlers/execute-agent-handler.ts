import { promises as fs } from 'node:fs';
import type {
  AgentExecutionFacade,
  AgentExecutionOptions,
  AgentExecutionRequest,
  AgentExecutionResult,
} from '../../protocol/agent-execution';

export interface ExecuteAgentHandlerOptions {
  agentExecutionFacade: AgentExecutionFacade;
}

export class ExecuteAgentHandler {
  constructor(private readonly options: ExecuteAgentHandlerOptions) {}

  async execute(
    input: AgentExecutionRequest,
    options?: AgentExecutionOptions,
  ): Promise<AgentExecutionResult> {
    if (input.workspace_path) await fs.mkdir(input.workspace_path, { recursive: true });
    const result = await this.options.agentExecutionFacade.runAgent(input, options);
    assertEvidence(result);
    return result;
  }
}

function assertEvidence(result: AgentExecutionResult): void {
  const required: Array<[string, unknown]> = [
    ['agent_id', result.agent_id],
    ['context_pack_ref', result.context_pack_ref],
    ['memory_buffer_ref', result.memory_buffer_ref],
    ['session_id', result.session_id],
    ['driver_run_result_id', result.driver_run_result_id],
    ['transcript_ref', result.transcript_ref?.artifact_id],
  ];
  const missing = required.find(([, value]) => typeof value !== 'string' || value.length === 0);
  if (missing) throw new Error(`B execution evidence is incomplete: ${missing[0]}`);
}
