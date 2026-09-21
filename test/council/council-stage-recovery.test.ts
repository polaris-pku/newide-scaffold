import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
} from '../../src/protocol/agent-execution';
import type { CouncilLifecycleEvent, CouncilRoundInput } from '../../src/council';
import { SynthesisAgentCouncilProvider } from '../../src/council/providers/synthesis-agent-provider';
import {
  prepareCouncilWorkspace,
  stageCouncilArtifacts,
} from '../../src/council/council-workspace';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'council-recovery-'));
  roots.push(value);
  return value;
}
const input: CouncilRoundInput = {
  run_id: 'run_recovery',
  task_id: 'task_recovery',
  trigger: 'manual',
  decision_mode: 'advisory',
  question: 'Fix a bug',
  proposals: [],
  schema_version: SCHEMA_VERSION,
  participants: [
    { participant_id: 'p0', agent_id: 'author', seat: 'proposer', seat_index: 0 },
    { participant_id: 'p1', agent_id: 'peer', seat: 'proposer', seat_index: 1 },
    { participant_id: 'r0', agent_id: 'reviewer', seat: 'reviewer', seat_index: 0 },
    { participant_id: 's0', agent_id: 'lead', seat: 'synthesizer', seat_index: 0 },
  ],
};
function artifact(name: string, body = '# Plan'): ArtifactRef {
  return {
    artifact_id: `artifact_${name.replaceAll('.', '_')}`,
    type: 'file',
    uri: 'artifact://test',
    producer_id: 'test',
    task_id: input.task_id,
    content: {
      kind: 'text',
      content_ref: `data:text/plain,${encodeURIComponent(body)}`,
      target_path: name,
    },
    created_at: '2026-09-19T00:00:00Z',
    schema_version: SCHEMA_VERSION,
  };
}
function completed(request: AgentExecutionRequest): AgentExecutionResult {
  return {
    agent_run_id: `agent_${request.role_id}`,
    role_id: request.role_id,
    agent_id: request.role_id,
    context_pack_ref: 'ctx',
    driver_run_result_id: `driver_${request.run_id}`,
    artifact_refs:
      request.council_seat === 'reviewer'
        ? []
        : [
            {
              ...artifact(
                request.council_seat === 'synthesizer' ? 'final-plan.md' : 'council-plan.md',
              ),
              artifact_id: `artifact_${request.role_id}`,
            },
          ],
    transcript_ref: artifact('transcript.txt'),
    session_id: request.session_id ?? `session_${request.role_id}`,
    response:
      request.council_seat === 'reviewer'
        ? reviews(request)
        : 'Choose a bounded fix because it preserves compatibility.',
    tool_events: [],
    diagnostics: {},
    status: 'completed',
    created_at: '2026-09-19T00:00:00Z',
    schema_version: SCHEMA_VERSION,
  };
}
function reviews(request: AgentExecutionRequest) {
  const ids = [...new Set(request.instruction.match(/proposal_[a-z0-9-]+/g) ?? [])];
  return JSON.stringify({
    reviews: ids.map((id) => ({
      proposal_id: id,
      verdict: 'approve',
      reason: 'The plan covers the defect.',
      unmet_criteria: [],
      evidence_refs: [],
    })),
  });
}

describe('Council bounded recovery', () => {
  it('collects all workspace changes across a synthesis continuation', async () => {
    let attempts = 0;
    const provider = new SynthesisAgentCouncilProvider({
      councilRoot: await root(),
      agentExecutionFacade: {
        async runAgent(request) {
          const result = completed(request);
          if (request.role_id !== 'lead') return result;
          attempts += 1;
          if (attempts === 1) {
            await fs.writeFile(path.join(request.workspace_path!, 'first.ts'), 'first');
            return { ...result, status: 'interrupted', artifact_refs: [] };
          }
          await fs.writeFile(path.join(request.workspace_path!, 'second.ts'), 'second');
          return { ...result, artifact_refs: [artifact('second.ts', 'second')] };
        },
      },
    });
    const result = await provider.runCouncilRound(input);
    const selected = result.generated_artifact_refs.filter((artifact) =>
      result.selected_artifact_refs.includes(artifact.artifact_id),
    );
    expect(selected.map((artifact) => artifact.content?.target_path).sort()).toEqual([
      'first.ts',
      'second.ts',
    ]);
    expect(attempts).toBe(2);
  });
  it('copies a nested project rather than checking out its parent repository', async () => {
    const parent = await root();
    const target = path.join(await root(), 'participant');
    execFileSync('git', ['init', parent]);
    await fs.writeFile(path.join(parent, 'outer.txt'), 'unrelated parent project');
    execFileSync('git', ['-C', parent, 'add', 'outer.txt']);
    execFileSync('git', [
      '-C',
      parent,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture',
    ]);
    const source = path.join(parent, '.newide', 'nested-project');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'clamp.cjs'), 'original task file');
    await prepareCouncilWorkspace(source, target);
    expect(await fs.readFile(path.join(target, 'clamp.cjs'), 'utf8')).toBe('original task file');
    expect(await fs.readdir(target)).not.toContain('outer.txt');
  });
  it('preserves dirty tracked, untracked, and deleted task inputs in a Git worktree', async () => {
    const source = await root();
    const target = path.join(await root(), 'participant');
    execFileSync('git', ['init', source]);
    await fs.writeFile(path.join(source, 'tracked.txt'), 'committed');
    await fs.writeFile(path.join(source, 'deleted.txt'), 'remove me');
    execFileSync('git', ['-C', source, 'add', 'tracked.txt', 'deleted.txt']);
    execFileSync('git', [
      '-C',
      source,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture',
    ]);
    await fs.writeFile(path.join(source, 'tracked.txt'), 'task-local change');
    await fs.rm(path.join(source, 'deleted.txt'));
    await fs.writeFile(path.join(source, 'untracked.txt'), 'new task input');

    await prepareCouncilWorkspace(source, target);

    expect(await fs.readFile(path.join(target, 'tracked.txt'), 'utf8')).toBe('task-local change');
    expect(await fs.readFile(path.join(target, 'untracked.txt'), 'utf8')).toBe('new task input');
    await expect(fs.access(path.join(target, 'deleted.txt'))).rejects.toThrow();
  });
  it('stops inactivity monitoring when the Driver finishes, allowing report processing', async () => {
    let calls = 0;
    const provider = new SynthesisAgentCouncilProvider({
      councilRoot: await root(),
      roleInactivityTimeoutMs: 10,
      agentExecutionFacade: {
        async runAgent(request, options) {
          calls += 1;
          options?.onDriverEvent?.({
            schema_version: 'driver-event.v1',
            event_type: 'driver.turn_started',
            session_id: `session_${request.role_id}`,
          });
          options?.onDriverEvent?.({
            schema_version: 'driver-event.v1',
            event_type: 'driver.turn_completed',
            session_id: `session_${request.role_id}`,
          });
          await new Promise((resolve) => setTimeout(resolve, 30));
          options?.signal?.throwIfAborted();
          return completed(request);
        },
      },
    });
    const result = await provider.runCouncilRound(input, { artifact_mode: 'plan' });
    expect(calls).toBe(4);
    expect(result.diagnostic_refs).toBeUndefined();
  });
  it('retries a transient role failure once in its existing Session and workspace', async () => {
    const requests: AgentExecutionRequest[] = [];
    const events: CouncilLifecycleEvent[] = [];
    const provider = new SynthesisAgentCouncilProvider({
      councilRoot: await root(),
      agentExecutionFacade: {
        async runAgent(request) {
          requests.push(request);
          if (
            request.role_id === 'author' &&
            requests.filter((item) => item.role_id === 'author').length === 1
          ) {
            await fs.writeFile(path.join(request.workspace_path!, 'progress.txt'), 'keep');
            return {
              ...completed(request),
              status: 'failed',
              diagnostics: {
                driver_attempts: 1,
                driver_error: { code: 'TRANSIENT', message: 'connection lost', retryable: true },
              },
            };
          }
          if (request.role_id === 'author')
            expect(
              await fs.readFile(path.join(request.workspace_path!, 'progress.txt'), 'utf8'),
            ).toBe('keep');
          return completed(request);
        },
      },
    });
    const result = await provider.runCouncilRound(input, {
      artifact_mode: 'plan',
      onLifecycleEvent: (event) => {
        events.push(event);
      },
    });
    const attempts = requests.filter((request) => request.role_id === 'author');
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({
      session_id: 'session_author',
      workspace_path: attempts[0]!.workspace_path,
    });
    expect(attempts[1]!.run_id).not.toBe(attempts[0]!.run_id);
    expect(result.proposals).toHaveLength(2);
    const failure = events.find((event) => event.type === 'council.role.failed')!;
    expect(failure.payload).toMatchObject({
      phase: 'proposal',
      attempt: 1,
      will_retry: true,
      council_run_id: result.council_run_id,
    });
    expect(
      events.some(
        (event) =>
          event.type === 'council.phase.started' &&
          event.payload.phase_id === failure.payload.phase_id,
      ),
    ).toBe(true);
  });

  it.each([
    { retryable: true, driver_attempts: 1, expected: 2 },
    { retryable: false, driver_attempts: 1, expected: 1 },
    { retryable: true, driver_attempts: 2, expected: 1 },
  ])(
    'bounds synthesis calls with $retryable / $driver_attempts',
    async ({ retryable, driver_attempts, expected }) => {
      let calls = 0;
      const provider = new SynthesisAgentCouncilProvider({
        councilRoot: await root(),
        agentExecutionFacade: {
          async runAgent(request) {
            if (request.role_id !== 'lead') return completed(request);
            calls += 1;
            return {
              ...completed(request),
              status: 'failed',
              diagnostics: {
                driver_attempts,
                driver_error: { code: 'TRANSPORT', message: 'lost', retryable },
              },
            };
          },
        },
      });
      const result = await provider.runCouncilRound(input, { artifact_mode: 'plan' });
      expect(calls).toBe(expected);
      expect(result.selected_artifact_refs).toEqual([]);
      expect(result.proposals).toHaveLength(2);
    },
  );

  it('reads structured reviews from a file while preserving the six-field response', async () => {
    const workspace = await root();
    const source = path.join(workspace, 'source');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'private-source.txt'), 'source code');
    const provider = new SynthesisAgentCouncilProvider({
      councilRoot: path.join(workspace, 'council'),
      agentExecutionFacade: {
        async runAgent(request) {
          const result = completed(request);
          if (request.council_seat === 'reviewer') {
            expect(await fs.readdir(request.workspace_path!)).not.toContain('private-source.txt');
            const manifest = JSON.parse(
              await fs.readFile(path.join(request.workspace_path!, 'proposals.json'), 'utf8'),
            );
            expect(manifest.proposals).toHaveLength(2);
            expect(manifest.proposals[0].files[0].path).toContain('inputs/');
            return {
              ...result,
              artifact_refs: [artifact('reviews.json', reviews(request))],
              response:
                '{"summary":"Review saved","artifacts":[],"decisions":[],"blockers":[],"referenced_experiences":[],"assumptions":[]}',
            };
          }
          return result;
        },
      },
    });
    const result = await provider.runCouncilRound(
      { ...input, workspace_path: source },
      { artifact_mode: 'plan' },
    );
    expect(result.reviews.map((review) => review.verdict)).toEqual(['approve', 'approve']);
    expect(result.diagnostic_refs).toBeUndefined();
    expect(result.decision.reason).toContain('preserves compatibility');
  });

  it('repairs an incomplete review once using the same reviewer Session', async () => {
    const requests: AgentExecutionRequest[] = [];
    const provider = new SynthesisAgentCouncilProvider({
      councilRoot: await root(),
      agentExecutionFacade: {
        async runAgent(request) {
          const result = completed(request);
          if (request.council_seat !== 'reviewer') return result;
          requests.push(request);
          return requests.length === 1 ? { ...result, response: '{"reviews":[]}' } : result;
        },
      },
    });
    const result = await provider.runCouncilRound(input, { artifact_mode: 'plan' });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.session_id).toBe('session_reviewer');
    expect(result.reviews.every((review) => review.verdict === 'approve')).toBe(true);
  });

  it('retains a valid Plan and audits unrelated product artifacts without delivering them', async () => {
    const provider = new SynthesisAgentCouncilProvider({
      councilRoot: await root(),
      agentExecutionFacade: {
        async runAgent(request) {
          const result = completed(request);
          return request.role_id === 'author'
            ? {
                ...result,
                artifact_refs: [...result.artifact_refs, artifact('accidental.py', 'bad')],
              }
            : result;
        },
      },
    });
    const result = await provider.runCouncilRound(input, { artifact_mode: 'plan' });
    expect(result.proposals).toHaveLength(2);
    expect(
      result.generated_artifact_refs.some((ref) => ref.content?.target_path === 'accidental.py'),
    ).toBe(false);
    expect(result.diagnostic_refs?.join(' ')).toContain('accidental.py');
  });

  it('keeps an unreadable staged candidate from discarding other participant results', async () => {
    const provider = new SynthesisAgentCouncilProvider({
      councilRoot: await root(),
      agentExecutionFacade: {
        async runAgent(request) {
          return completed(request);
        },
      },
    });
    const bad = artifact('bad-plan.md');
    bad.content!.content_ref = path.join(await root(), 'missing.md');
    const result = await provider.runCouncilRound(
      { ...input, candidate_artifacts: [bad] },
      { artifact_mode: 'plan' },
    );
    expect(result.proposals).toHaveLength(2);
    // 评审失败就不再合成，因此只剩评审的失败诊断，且没有可选产物。
    expect(result.diagnostic_refs).toEqual(expect.arrayContaining(['COUNCIL_REVIEW_FAILED:r0']));
    expect(result.reviews).toEqual([]);
    expect(result.selected_artifact_refs).toEqual([]);
  });

  it.each(['../outside.txt', '..\\outside.txt', '/tmp/outside.txt', 'C:\\outside.txt'])(
    'rejects staged path escape %s',
    async (target) => {
      await expect(stageCouncilArtifacts(await root(), [artifact(target)])).rejects.toThrow();
    },
  );
});
