import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import {
  AGENT_EXECUTION_STATUSES,
  type AgentExecutionFacade,
  type AgentExecutionRequest,
  type AgentExecutionResult,
} from '../../src/protocol/agent-execution';

describe('AgentExecutionFacade contract', () => {
  it('exports the stable agent execution status vocabulary', () => {
    expect(AGENT_EXECUTION_STATUSES).toEqual(['completed', 'failed', 'cancelled', 'interrupted']);
  });

  it('keeps task and run identity supplied by the coordinator', async () => {
    const requests: AgentExecutionRequest[] = [];
    const facade: AgentExecutionFacade = {
      async runAgent(input) {
        requests.push(input);
        return createAgentExecutionResult(input);
      },
    };
    const request: AgentExecutionRequest = {
      task_id: 'task_001',
      run_id: 'run_001',
      role_id: 'proposer_a',
      instruction: 'Produce a candidate implementation.',
      workspace_path: process.cwd(),
      session_id: 'session_existing',
      input_artifact_refs: ['artifact_context_001'],
      context_policy: 'default',
      schema_version: SCHEMA_VERSION,
    };

    const result = await facade.runAgent(request);

    expect(requests).toEqual([request]);
    expect(result).toEqual(createAgentExecutionResult(request));
  });
});

function createAgentExecutionResult(input: AgentExecutionRequest): AgentExecutionResult {
  return {
    agent_run_id: 'agent_run_001',
    role_id: input.role_id,
    context_pack_ref: 'context_pack_001',
    driver_run_result_id: 'driver_result_001',
    artifact_refs: [createArtifact('artifact_candidate_001')],
    transcript_ref: createArtifact('artifact_transcript_001', 'transcript'),
    session_id: input.session_id ?? 'session_001',
    response: 'Produced a candidate implementation.',
    tool_events: [],
    diagnostics: { driver_id: 'driver_001' },
    status: 'completed',
    memory_buffer_ref: 'memory_buffer_001',
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function createArtifact(artifactId: string, type: ArtifactRef['type'] = 'patch'): ArtifactRef {
  return {
    artifact_id: artifactId,
    type,
    uri: `artifact://${type}/${artifactId}`,
    producer_id: 'driver_001',
    task_id: 'task_001',
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}
