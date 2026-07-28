import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import { runIntegrationV0Flow } from '../../src/coordinator/integration-v0-flow';
import { SynthesisAgentCouncilProvider } from '../../src/council';
import type {
  AgentExecutionFacade,
  AgentExecutionRequest,
} from '../../src/protocol/agent-execution';

describe('Council end-to-end coordinator slice', () => {
  const created = new Set<string>();

  afterEach(async () => {
    await Promise.all([...created].map((entry) => fs.rm(entry, { recursive: true, force: true })));
    created.clear();
  });

  it('isolates candidates and delivers only the hashed CouncilResult artifact', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-council-e2e-'));
    created.add(root);
    const workspace = path.join(root, 'workspace');
    const councilRoot = path.join(root, '.newide', 'council');
    const runsRoot = path.join(root, '.newide', 'runs');
    const worktreeRoot = path.join(root, '.newide', 'worktrees');
    await fs.mkdir(workspace, { recursive: true });
    const requests: AgentExecutionRequest[] = [];
    const facade = createCouncilFacade(requests);

    const result = await runIntegrationV0Flow({
      driverPrompt: 'Create the final TypeScript implementation.',
      workspacePath: workspace,
      enableCouncil: true,
      agentExecutionFacade: facade,
      councilProvider: new SynthesisAgentCouncilProvider({
        agentExecutionFacade: facade,
        councilRoot,
      }),
      councilRoot,
      runsRoot,
      worktreePath: worktreeRoot,
    });

    expect(result.summary.status).toBe('completed');
    expect(requests.map((request) => request.role_id)).toEqual([
      'role_ts_engineer',
      'proposer_a',
      'proposer_b',
      'reviewer',
      'synthesizer',
    ]);
    expect(requests[0]?.workspace_path).toBe(
      path.join(councilRoot, result.run_id, 'primary'),
    );
    expect(await fs.readdir(workspace)).toEqual(['final.ts']);
    const delivered = await fs.readFile(path.join(workspace, 'final.ts'));
    const deliveredSha = createHash('sha256').update(delivered).digest('hex');
    expect(result.selection_result.council_result).toMatchObject({
      quality: 'verified',
      final_artifact_ref: 'artifact_synthesizer',
      final_artifact_sha256: deliveredSha,
      warnings: [],
      unmet_criteria: [],
    });
    expect(result.frontend_snapshot.council?.result).toEqual(
      result.selection_result.council_result,
    );
    await expect(
      fs.readFile(path.join(runsRoot, result.run_id, 'council', 'result.json'), 'utf-8'),
    ).resolves.toContain(deliveredSha);
  });
});

function createCouncilFacade(requests: AgentExecutionRequest[]): AgentExecutionFacade {
  return {
    async runAgent(input) {
      requests.push(input);
      const artifacts =
        input.role_id === 'reviewer'
          ? []
          : [
              artifact(
                `artifact_${input.role_id}`,
                input.role_id === 'synthesizer' ? 'final.ts' : `${input.role_id}.ts`,
                input.role_id === 'synthesizer'
                  ? 'export const finalValue = 42;\n'
                  : `export const candidate = '${input.role_id}';\n`,
              ),
            ];
      return {
        agent_run_id: `agent_run_${input.role_id}`,
        agent_id: input.role_id,
        role_id: input.role_id,
        context_pack_ref: `context_pack_${input.role_id}`,
        driver_run_result_id: `driver_result_${input.role_id}`,
        artifact_refs: artifacts,
        transcript_ref: transcript(input.role_id),
        session_id: `session_${input.role_id}`,
        response:
          input.role_id === 'reviewer'
            ? structuredReviews(input.instruction)
            : `${input.role_id} completed`,
        tool_events: [],
        diagnostics: {
          driver_id: `driver_${input.role_id}`,
          duration_ms: 1,
          context_pack_persisted: true,
        },
        status: 'completed',
        memory_buffer_ref: `memory_buffer_${input.role_id}`,
        created_at: '2026-07-18T00:00:00.000Z',
        schema_version: SCHEMA_VERSION,
      };
    },
  };
}

function structuredReviews(instruction: string): string {
  const ids = instruction
    .match(/Proposal ids: ([^.]+)\./)?.[1]
    ?.split(', ')
    .filter(Boolean) ?? [];
  return JSON.stringify({
    reviews: ids.map((proposalId) => ({
      proposal_id: proposalId,
      verdict: 'approve',
      reason: 'Verified candidate.',
      unmet_criteria: [],
      evidence_refs: [`evidence_${proposalId}`],
    })),
  });
}

function artifact(id: string, targetPath: string, body: string): ArtifactRef {
  return {
    artifact_id: id,
    type: 'diff',
    uri: `artifact://diff/${id}`,
    producer_id: id.replace('artifact_', ''),
    task_id: 'task_council',
    content: {
      kind: 'text',
      content_ref: `data:text/plain,${encodeURIComponent(body)}`,
      target_path: targetPath,
      media_type: 'text/typescript',
    },
    created_at: '2026-07-18T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function transcript(roleId: string): ArtifactRef {
  return {
    artifact_id: `transcript_${roleId}`,
    type: 'transcript',
    uri: `artifact://transcript/${roleId}`,
    producer_id: roleId,
    task_id: 'task_council',
    created_at: '2026-07-18T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}
