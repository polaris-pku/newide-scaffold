import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import { ExecuteAgentHandler } from '../../src/coordinator/handlers/execute-agent-handler';
import type { AgentExecutionFacade } from '../../src/protocol/agent-execution';

describe('ExecuteAgentHandler', () => {
  const created = new Set<string>();

  afterEach(async () => {
    await Promise.all([...created].map((entry) => fs.rm(entry, { recursive: true, force: true })));
    created.clear();
  });

  it('runs through the B facade and preserves all cross-module evidence', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-execute-agent-'));
    created.add(workspace);
    const requests: unknown[] = [];
    const facade: AgentExecutionFacade = {
      async runAgent(input) {
        requests.push(input);
        return result(input.role_id);
      },
    };
    const handler = new ExecuteAgentHandler({ agentExecutionFacade: facade });

    const output = await handler.execute({
      task_id: 'task_execute',
      run_id: 'run_execute',
      role_id: 'implementer',
      instruction: 'Implement the requested change.',
      workspace_path: workspace,
      input_artifact_refs: [],
      context_policy: 'runtime-v1',
      schema_version: SCHEMA_VERSION,
    });

    expect(requests).toHaveLength(1);
    expect(output).toMatchObject({
      agent_id: 'implementer',
      context_pack_ref: 'context_pack_real',
      memory_buffer_ref: 'memory_buffer_real',
      session_id: 'session_real',
      artifact_refs: [expect.objectContaining({ artifact_id: 'artifact_real' })],
      diagnostics: expect.objectContaining({ context_pack_persisted: true }),
    });
  });

  it('rejects a completed B result that omits a required evidence reference', async () => {
    const facade: AgentExecutionFacade = {
      async runAgent(input) {
        const value = result(input.role_id);
        delete value.memory_buffer_ref;
        return value;
      },
    };
    const handler = new ExecuteAgentHandler({ agentExecutionFacade: facade });

    await expect(
      handler.execute({
        task_id: 'task_incomplete',
        run_id: 'run_incomplete',
        role_id: 'implementer',
        instruction: 'Implement.',
        input_artifact_refs: [],
        context_policy: 'runtime-v1',
        schema_version: SCHEMA_VERSION,
      }),
    ).rejects.toThrow('B execution evidence is incomplete: memory_buffer_ref');
  });
});

function result(roleId: string) {
  return {
    agent_run_id: 'agent_run_real',
    agent_id: roleId,
    role_id: roleId,
    context_pack_ref: 'context_pack_real',
    driver_run_result_id: 'driver_result_real',
    artifact_refs: [artifact()],
    transcript_ref: artifact('transcript_real', 'transcript'),
    session_id: 'session_real',
    response: 'done',
    tool_events: [],
    diagnostics: { driver_id: 'driver_real', context_pack_persisted: true },
    status: 'completed' as const,
    memory_buffer_ref: 'memory_buffer_real',
    created_at: '2026-07-18T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function artifact(
  artifactId = 'artifact_real',
  type: ArtifactRef['type'] = 'diff',
): ArtifactRef {
  return {
    artifact_id: artifactId,
    type,
    uri: `artifact://${type}/${artifactId}`,
    producer_id: 'driver_real',
    task_id: 'task_execute',
    content:
      type === 'transcript'
        ? undefined
        : {
            kind: 'text',
            content_ref: 'data:text/plain,export%20const%20ok%20%3D%20true%3B%0A',
            target_path: 'result.ts',
          },
    created_at: '2026-07-18T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}
