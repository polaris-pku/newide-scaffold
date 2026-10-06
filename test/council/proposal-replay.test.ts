import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../src/core';
import {
  applyCouncilProposalReplay,
  COUNCIL_REPLAY_ENV,
  loadCouncilProposalReplay,
  readCouncilProposalReplayDir,
} from '../../src/council';
import { readArtifactBytes } from '../../src/coordinator/artifact-content';

describe('Council proposal replay', () => {
  it('rebuilds proposals and their staged files from a frozen pack', async () => {
    const pack = await writeFrozenPack({
      plans: { artifact_alpha: 'alpha plan\n', artifact_beta: 'beta plan\n' },
    });

    const replay = await loadCouncilProposalReplay(pack);

    expect(replay.source_dir).toBe(path.resolve(pack));
    expect(replay.proposals.map((proposal) => proposal.proposal_id)).toEqual([
      'proposal_a',
      'proposal_b',
    ]);
    expect(replay.candidate_artifacts.map((artifact) => artifact.artifact_id)).toEqual([
      'artifact_alpha',
      'artifact_beta',
    ]);
    expect(
      replay.candidate_artifacts.every(
        (artifact) => artifact.content?.target_path === 'council-plan.md',
      ),
    ).toBe(true);
    expect(replay.candidate_artifacts.every((artifact) => artifact.producer_id !== '')).toBe(true);
    await expect(readArtifactBytes(replay.candidate_artifacts[0]!)).resolves.toEqual(
      Buffer.from('alpha plan\n', 'utf-8'),
    );
  });

  it('keeps the rest of the Council request verbatim', async () => {
    const pack = await writeFrozenPack({ plans: { artifact_alpha: 'alpha plan\n' } });
    const request = {
      run_id: 'run_replay',
      task_id: 'task_replay',
      trigger: 'user_choice' as const,
      decision_mode: 'advisory' as const,
      question: 'Produce the final artifact.',
      workspace_path: '/workspace/task',
      proposals: [],
      schema_version: SCHEMA_VERSION,
    };

    const replayed = await applyCouncilProposalReplay(request, pack);

    expect(replayed.question).toBe(request.question);
    expect(replayed.workspace_path).toBe(request.workspace_path);
    expect(replayed.run_id).toBe(request.run_id);
    expect(replayed.task_id).toBe(request.task_id);
    expect(replayed.decision_mode).toBe('advisory');
    expect(replayed.schema_version).toBe(SCHEMA_VERSION);
    expect(replayed.proposals).toHaveLength(1);
    expect(replayed.candidate_artifacts).toHaveLength(1);
  });

  it('refuses a proposal without agent_id instead of regenerating it', async () => {
    const pack = await writeFrozenPack({
      plans: { artifact_alpha: 'alpha plan\n' },
      omitAgentId: true,
    });

    await expect(loadCouncilProposalReplay(pack)).rejects.toThrow('agent_id');
  });

  it('refuses an artifact with no staged file', async () => {
    const pack = await writeFrozenPack({ plans: { artifact_alpha: 'alpha plan\n' } });
    await fs.rm(path.join(pack, 'inputs'), { recursive: true, force: true });

    await expect(loadCouncilProposalReplay(pack)).rejects.toThrow('no staged file');
  });

  it('refuses an artifact with more than one staged file instead of guessing', async () => {
    const pack = await writeFrozenPack({ plans: { artifact_alpha: 'alpha plan\n' } });
    await fs.writeFile(
      path.join(pack, 'inputs', 'artifact_alpha', 'notes.md'),
      'extra\n',
      'utf-8',
    );

    await expect(loadCouncilProposalReplay(pack)).rejects.toThrow('staged files');
  });

  it('refuses a pack without proposals.json', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-council-replay-empty-'));

    await expect(loadCouncilProposalReplay(empty)).rejects.toThrow('not found');
  });

  it('reads the replay directory from the environment', () => {
    expect(readCouncilProposalReplayDir({})).toBeUndefined();
    expect(readCouncilProposalReplayDir({ [COUNCIL_REPLAY_ENV]: '   ' })).toBeUndefined();
    expect(readCouncilProposalReplayDir({ [COUNCIL_REPLAY_ENV]: ' /tmp/pack ' })).toBe('/tmp/pack');
  });
});

/** 冻结包形状与真实 synthesizer pack 一致：proposals.json + inputs/<id>/<target>。 */
async function writeFrozenPack(input: {
  plans: Record<string, string>;
  omitAgentId?: boolean;
}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-council-replay-'));
  const proposals = Object.keys(input.plans).map((artifactId, index) => ({
    proposal_id: ['proposal_a', 'proposal_b'][index] ?? `proposal_${String(index)}`,
    run_id: 'run_frozen',
    task_id: 'task_frozen',
    ...(input.omitAgentId ? {} : { agent_id: index === 0 ? 'agent_backend' : 'agent_frontend' }),
    artifact_refs: [artifactId],
    summary: `summary for ${artifactId}`,
    claims: [],
    affected_paths: [],
    assumptions: [],
    known_risks: [],
    completion_evidence: [],
    created_at: '2026-10-04T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  }));
  await fs.writeFile(
    path.join(root, 'proposals.json'),
    JSON.stringify(proposals, null, 2),
    'utf-8',
  );
  for (const [artifactId, body] of Object.entries(input.plans)) {
    const dir = path.join(root, 'inputs', artifactId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'council-plan.md'), body, 'utf-8');
  }
  return root;
}
