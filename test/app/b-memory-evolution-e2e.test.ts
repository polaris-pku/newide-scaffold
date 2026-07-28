import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BMemoryBackendService,
} from '../../src/app/b-memory-backend-service';
import {
  BMemoryMaintenanceRunner,
  FileBMemoryMaintenanceEvidenceStore,
} from '../../src/app/b-memory-maintenance-runner';
import { DriverRuntimeAgentExecutionFacade } from '../../src/app/driver-runtime-agent-execution-facade';
import { SCHEMA_VERSION, nowTimestamp, type ArtifactRef } from '../../src/core';
import type {
  DriverCapabilities,
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle,
} from '../../src/driver';
import {
  InMemoryBufferRepository,
  InMemoryRepository,
  type EmbeddingProvider,
  type LlmClient,
  type ToolCallingClient,
} from '../../src/memory';
import { JsonRpcDispatcher } from '../../src/rpc/json-rpc-dispatcher';
import { MemoryRpcMethods } from '../../src/rpc/memory-methods';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('B memory evolution end to end', () => {
  it('feeds an automatically persisted Experience into the next A DriverContext', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-b-evolution-'));
    roots.push(root);
    const repository = new InMemoryRepository(alwaysRelevantEmbedding());
    const bufferRepository = new InMemoryBufferRepository();
    const driver = new CapturingDriver();
    const maintenance = new BMemoryMaintenanceRunner({
      repository,
      bufferRepository,
      llm: extractionLlm(),
      evidenceStore: new FileBMemoryMaintenanceEvidenceStore(path.join(root, 'maintenance')),
    });
    const facade = new DriverRuntimeAgentExecutionFacade({
      driver,
      repository,
      bufferRepository,
      llm: invokeDriverLlm(),
      memoryMaintenance: maintenance,
    });

    await facade.runAgent(request('task_001', 'Capture a reusable architecture lesson.'));
    await maintenance.waitForIdle();
    const firstEvidence = await maintenance.listEvidence('role_ts_engineer');
    expect(firstEvidence).toMatchObject([
      {
        kind: 'experience_extraction',
        status: 'completed',
        experiences: [expect.objectContaining({ content: 'Keep B behind public application ports.' })],
      },
    ]);

    await facade.runAgent(request('task_002', 'Apply the architecture lesson to the next task.'));
    await maintenance.waitForIdle();

    const secondContext = JSON.parse(driver.prompts[1]!.prompt) as {
      experiences: Array<{ content: string }>;
    };
    expect(secondContext.experiences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'Keep B behind public application ports.' }),
      ]),
    );
  });

  it('persists an explicitly promoted pending Skill and exposes it through memory RPC', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-b-pending-skill-'));
    roots.push(root);
    const repository = new InMemoryRepository(alwaysRelevantEmbedding());
    const bufferRepository = new InMemoryBufferRepository();
    const driver = new CapturingDriver();
    const maintenance = new BMemoryMaintenanceRunner({
      repository,
      bufferRepository,
      llm: extractionLlm(),
      evidenceStore: new FileBMemoryMaintenanceEvidenceStore(path.join(root, 'maintenance')),
    });
    const facade = new DriverRuntimeAgentExecutionFacade({
      driver,
      repository,
      bufferRepository,
      llm: invokeDriverLlm(),
      memoryMaintenance: maintenance,
    });

    await facade.runAgent(request('task_promote_001', 'Capture a reusable architecture lesson.'));
    await maintenance.waitForIdle();
    const [sourceExperience] = await repository.listExperiences('role_ts_engineer');
    expect(sourceExperience).toMatchObject({
      content: 'Keep B behind public application ports.',
      confidence: 0.99,
      promoted_to: undefined,
    });

    const promotion = await maintenance.promoteSkills({
      role_id: 'role_ts_engineer',
      requested_by: 'user',
    });
    expect(promotion).toMatchObject({
      status: 'completed',
      skills: [expect.objectContaining({ review_status: 'pending' })],
    });
    const [storedSkill] = await repository.listSkills('role_ts_engineer');
    const [storedExperience] = await repository.listExperiences('role_ts_engineer');
    expect(storedSkill).toMatchObject({
      review_status: 'pending',
      promoted_from: sourceExperience!.id,
    });
    expect(storedExperience).toMatchObject({
      id: sourceExperience!.id,
      promoted_to: storedSkill!.id,
    });

    const dispatcher = memoryDispatcher(
      new BMemoryBackendService(repository, maintenance),
    );
    await expect(
      dispatcher.dispatch({
        jsonrpc: '2.0',
        id: 1,
        method: 'memory.listExperiences',
        params: { role_id: 'role_ts_engineer' },
      }),
    ).resolves.toMatchObject({
      result: {
        experiences: [{ id: sourceExperience!.id, promoted_to: storedSkill!.id }],
      },
    });
    await expect(
      dispatcher.dispatch({
        jsonrpc: '2.0',
        id: 2,
        method: 'memory.listSkills',
        params: { role_id: 'role_ts_engineer' },
      }),
    ).resolves.toMatchObject({
      result: {
        skills: [{ id: storedSkill!.id, review_status: 'pending' }],
      },
    });

  });
});

function memoryDispatcher(service: BMemoryBackendService): JsonRpcDispatcher {
  const dispatcher = new JsonRpcDispatcher();
  new MemoryRpcMethods({
    listMemoryAgents: () => service.listAgents(),
    getMemoryAgent: (roleId) => service.getAgent(roleId),
    listMemorySkills: (roleId) => service.listSkills(roleId),
    listMemoryExperiences: (roleId) => service.listExperiences(roleId),
    listMemoryMaintenance: (roleId) => service.listMaintenance(roleId),
    promoteMemorySkills: (roleId, requestedBy) => service.promoteSkills(roleId, requestedBy),
  }).register(dispatcher);
  return dispatcher;
}

function request(taskId: string, instruction: string) {
  return {
    task_id: taskId,
    run_id: `run_${taskId}`,
    role_id: 'role_ts_engineer',
    instruction,
    input_artifact_refs: [],
    context_policy: 'default',
    schema_version: SCHEMA_VERSION,
  };
}

class CapturingDriver implements DriverRuntimeHandle {
  readonly driver_id = 'capturing-driver';
  readonly session_id = 'capturing-session';
  readonly capabilities: DriverCapabilities = {
    supports_acp_extension: false,
    supports_structured_output: true,
    supports_session_load: false,
    supports_tool_events: true,
    supports_permission_events: false,
  };
  readonly prompts: DriverPrompt[] = [];

  async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    this.prompts.push(input);
    const createdAt = nowTimestamp();
    return {
      driver_run_result_id: `driver_result_${String(this.prompts.length)}`,
      session_id: this.session_id,
      status: 'succeeded',
      response: 'Completed.',
      artifacts: [],
      transcript_ref: artifact('transcript', input.task_id, createdAt),
      tool_events: [],
      diagnostics: { driver_id: this.driver_id, duration_ms: 1, notes: [] },
      created_at: createdAt,
      schema_version: SCHEMA_VERSION,
    };
  }

  async interrupt(): Promise<void> {}

  async collectTranscript(taskId = 'task'): Promise<ArtifactRef> {
    return artifact('transcript', taskId, nowTimestamp());
  }
}

function artifact(type: ArtifactRef['type'], taskId: string, createdAt: string): ArtifactRef {
  return {
    artifact_id: randomUUID(),
    type,
    uri: `artifact://${type}/${taskId}`,
    producer_id: 'capturing-driver',
    task_id: taskId,
    created_at: createdAt,
    schema_version: SCHEMA_VERSION,
  };
}

function invokeDriverLlm(): ToolCallingClient {
  let calls = 0;
  return {
    async completeWithTools(input) {
      const last = input.messages.at(-1);
      if (last?.role === 'tool') return { content: 'Task completed. [done]' };
      calls += 1;
      return {
        content: null,
        tool_calls: [
          {
            id: `call_${String(calls)}`,
            type: 'function',
            function: {
              name: 'invoke_driver',
              arguments: JSON.stringify({ instruction: 'Execute the task.' }),
            },
          },
        ],
      };
    },
  };
}

function extractionLlm(): LlmClient {
  return {
    async complete() {
      return JSON.stringify({
        experiences: [
          {
            description: 'Keep B behind public ports',
            content: 'Keep B behind public application ports.',
            type: 'positive',
            confidence: 0.99,
            tags: ['architecture'],
          },
        ],
      });
    },
  };
}

function alwaysRelevantEmbedding(): EmbeddingProvider {
  return {
    dimensions: 4,
    async embed() {
      return [1, 0, 0, 0];
    },
    cosineSimilarity() {
      return 1;
    },
  };
}
