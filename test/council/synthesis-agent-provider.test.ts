import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import type {
  AgentExecutionFacade,
  AgentExecutionRequest,
} from '../../src/protocol/agent-execution';
import type { CouncilParticipantBinding } from '../../src/council';
import { councilRunDirName } from '../../src/council/council-workspace';
import { SynthesisAgentCouncilProvider } from '../../src/council/providers/synthesis-agent-provider';

describe('SynthesisAgentCouncilProvider', () => {
  it('runs plan-first roles without allowing product-file changes', async () => {
    const councilRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-council-plan-'));
    const requests: AgentExecutionRequest[] = [];
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input) {
        requests.push(input);
        const targetPath =
          input.council_seat === 'synthesizer' ? 'final-plan.md' : 'council-plan.md';
        const proposalIds = input.instruction.match(/proposal_[a-z0-9-]+/g) ?? [];
        return {
          agent_run_id: `agent_run_${input.role_id}`,
          agent_id: input.role_id,
          role_id: input.role_id,
          context_pack_ref: `context_${input.role_id}`,
          driver_run_result_id: `driver_result_${input.role_id}`,
          artifact_refs:
            input.council_seat === 'reviewer'
              ? []
              : [createArtifact(`artifact_${input.role_id}`, input.role_id, 'file', targetPath)],
          transcript_ref: createArtifact(
            `transcript_${input.role_id}`,
            input.role_id,
            'transcript',
          ),
          session_id: `session_${input.role_id}`,
          response:
            input.council_seat === 'reviewer'
              ? [
                  'Review completed.',
                  '```json',
                  JSON.stringify({
                    reviews: proposalIds.map((proposalId) => ({
                      proposal_id: proposalId,
                      verdict: 'approve',
                      reason: 'Plan is actionable.',
                      unmet_criteria: [],
                      evidence_refs: [],
                    })),
                  }),
                  '```',
                  '<<<DRIVER_RETURN>>>',
                ].join('\n')
              : `${input.role_id} completed`,
          tool_events: [],
          diagnostics: { driver_id: `driver_${input.role_id}` },
          status: 'completed',
          created_at: '2026-07-07T00:00:00.000Z',
          schema_version: SCHEMA_VERSION,
        };
      },
    };
    const provider = new SynthesisAgentCouncilProvider({ agentExecutionFacade, councilRoot });

    const result = await provider.runCouncilRound(baseInput(), { artifact_mode: 'plan' });

    expect(requests).toHaveLength(4);
    expect(requests[0]?.instruction).toContain('council-plan.md');
    expect(requests[0]?.instruction).toContain('Do not modify product files');
    expect(requests[0]?.instruction).toContain('call the invoke_driver tool');
    expect(requests[0]?.driver_instruction).toContain('council-plan.md');
    expect(requests[0]?.driver_instruction).not.toContain('invoke_driver');
    expect(requests[2]?.instruction).toContain('Review the staged Council Plan inputs');
    expect(requests[3]?.instruction).toContain('final-plan.md');
    expect(requests[3]?.instruction).toContain('Do not implement');
    expect(result.reviews).toHaveLength(2);
    expect(result.reviews.every((review) => review.verdict === 'approve')).toBe(true);
    expect(result.selected_artifact_refs).toEqual([
      `artifact_${COUNCIL_AGENTS.synthesizer}`,
    ]);
  });

  it('rejects product files emitted by a plan-first Council role', async () => {
    const councilRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-council-plan-invalid-'));
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input) {
        return {
          agent_run_id: `agent_run_${input.role_id}`,
          agent_id: input.role_id,
          role_id: input.role_id,
          context_pack_ref: `context_${input.role_id}`,
          driver_run_result_id: `driver_result_${input.role_id}`,
          artifact_refs: [
            createArtifact(`artifact_${input.role_id}`, input.role_id, 'file', 'src/change.ts'),
          ],
          transcript_ref: createArtifact(
            `transcript_${input.role_id}`,
            input.role_id,
            'transcript',
          ),
          session_id: `session_${input.role_id}`,
          response: 'completed',
          tool_events: [],
          diagnostics: { driver_id: `driver_${input.role_id}` },
          status: 'completed',
          created_at: '2026-07-07T00:00:00.000Z',
          schema_version: SCHEMA_VERSION,
        };
      },
    };
    const provider = new SynthesisAgentCouncilProvider({ agentExecutionFacade, councilRoot });

    const result = await provider.runCouncilRound(baseInput(), { artifact_mode: 'plan' });

    expect(result.selected_artifact_refs).toEqual([]);
    expect(result.decision.verdict).toBe('request_revision');
    expect(result.diagnostic_refs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^COUNCIL_PROPOSAL_FAILED:/),
        expect.stringMatching(/^COUNCIL_REVIEW_FAILED:/),
        expect.stringMatching(/^COUNCIL_SYNTHESIS_FAILED:/),
      ]),
    );
  });

  it('runs proposer, reviewer, and synthesizer roles through AgentExecutionFacade', async () => {
    const councilRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-council-provider-'));
    const requests: AgentExecutionRequest[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input, options) {
        requests.push(input);
        signals.push(options?.signal);
        return {
          agent_run_id: `agent_run_${input.role_id}`,
          agent_id: input.role_id,
          role_id: input.role_id,
          context_pack_ref: `context_${input.role_id}`,
          driver_run_result_id: `driver_result_${input.role_id}`,
          artifact_refs: [createArtifact(`artifact_${input.role_id}`, input.role_id)],
          transcript_ref: createArtifact(
            `transcript_${input.role_id}`,
            input.role_id,
            'transcript',
          ),
          session_id: `session_${input.role_id}`,
          response:
            input.role_id === COUNCIL_AGENTS.reviewer
              ? JSON.stringify({
                  reviews: ['proposal-placeholder'],
                })
              : `${input.role_id} completed`,
          tool_events: [],
          diagnostics: {
            driver_id: `driver_${input.role_id}`,
          },
          status: 'completed',
          created_at: '2026-07-07T00:00:00.000Z',
          schema_version: SCHEMA_VERSION,
        };
      },
    };
    const provider = new SynthesisAgentCouncilProvider({ agentExecutionFacade, councilRoot });
    const controller = new AbortController();
    const lifecycleEvents: string[] = [];

    const result = await provider.runCouncilRound(
      {
        run_id: 'run_001',
        task_id: 'task_001',
        trigger: 'manual',
        decision_mode: 'advisory',
        question: 'Select a final implementation candidate.',
        participants: participantBindings(),
        proposals: [],
        evidence_pack: {
          evidence_pack_id: 'evidence_pack_001',
          task_id: 'task_001',
          artifact_refs: [],
          gate_result_refs: [],
          summary: 'evidence',
          created_at: '2026-07-07T00:00:00.000Z',
          schema_version: SCHEMA_VERSION,
        },
        schema_version: SCHEMA_VERSION,
      },
      {
        signal: controller.signal,
        onLifecycleEvent: (event) => lifecycleEvents.push(event.type),
      },
    );

    expect(new Set(requests.slice(0, 2).map((request) => request.role_id))).toEqual(
      new Set([COUNCIL_AGENTS.proposerA, COUNCIL_AGENTS.proposerB]),
    );
    expect(requests.slice(2).map((request) => request.role_id)).toEqual([
      COUNCIL_AGENTS.reviewer,
      COUNCIL_AGENTS.synthesizer,
    ]);
    const proposerARequest = requests.find(
      (request) => request.role_id === COUNCIL_AGENTS.proposerA,
    );
    expect(proposerARequest).toMatchObject({
      participant_id: 'participant_proposer_0',
      council_seat: 'proposer',
      council_seat_index: 0,
      role_id: COUNCIL_AGENTS.proposerA,
    });
    expect(signals).toEqual(Array(4).fill(controller.signal));
    expect(
      Object.fromEntries(requests.map((request) => [request.role_id, request.workspace_path])),
    ).toEqual({
      [COUNCIL_AGENTS.proposerA]: path.join(
        councilRoot,
        councilRunDirName('run_001'),
        'participant_proposer_0',
      ),
      [COUNCIL_AGENTS.proposerB]: path.join(
        councilRoot,
        councilRunDirName('run_001'),
        'participant_proposer_1',
      ),
      [COUNCIL_AGENTS.reviewer]: path.join(
        councilRoot,
        councilRunDirName('run_001'),
        'participant_reviewer_0',
      ),
      [COUNCIL_AGENTS.synthesizer]: path.join(
        councilRoot,
        councilRunDirName('run_001'),
        'participant_synthesizer_0',
      ),
    });
    for (const request of requests) {
      await expect(fs.stat(request.workspace_path!)).resolves.toMatchObject({});
    }
    expect(result.proposals).toHaveLength(2);
    expect(result.reviews).toHaveLength(2);
    expect(result.synthesis).toMatchObject({
      synthesizer_id: COUNCIL_AGENTS.synthesizer,
      artifact_refs: [`artifact_${COUNCIL_AGENTS.synthesizer}`],
    });
    expect(result.decision).toMatchObject({
      verdict: 'select',
      selected_artifact_refs: [`artifact_${COUNCIL_AGENTS.synthesizer}`],
      can_create_merge_authorization: false,
    });
    expect(result.generated_artifact_refs.map((artifact) => artifact.artifact_id)).toContain(
      `artifact_${COUNCIL_AGENTS.synthesizer}`,
    );
    expect(result.participants).toEqual(participantBindings());
    expect(result.output).toMatchObject({
      status: 'selected',
      selected_artifact_refs: [`artifact_${COUNCIL_AGENTS.synthesizer}`],
      can_create_merge_authorization: false,
    });
    expect(lifecycleEvents).toEqual([
      'council.participants.selected',
      'council.phase.started',
      'council.phase.started',
      'council.proposal.completed',
      'council.proposal.completed',
      'council.phase.started',
      'council.review.completed',
      'council.phase.started',
      'council.synthesis.completed',
    ]);
    await fs.rm(councilRoot, { recursive: true, force: true });
  });

  it('runs independent proposer roles concurrently', async () => {
    let activeProposers = 0;
    let maxActiveProposers = 0;
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input) {
        if (input.council_seat === 'proposer') {
          activeProposers += 1;
          maxActiveProposers = Math.max(maxActiveProposers, activeProposers);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeProposers -= 1;
        }
        return completedExecution(input);
      },
    };
    const provider = new SynthesisAgentCouncilProvider({ agentExecutionFacade });

    await provider.runCouncilRound(baseInput());

    expect(maxActiveProposers).toBe(2);
  });

  it('steers a silent Driver and continues once in the same Session', async () => {
    const requests: AgentExecutionRequest[] = [];
    const lifecycleEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let slowAttempt = true;
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input, options) {
        requests.push(input);
        if (input.role_id === COUNCIL_AGENTS.proposerA && slowAttempt) {
          slowAttempt = false;
          options?.onDriverEvent?.({
            schema_version: 'driver-event.v1',
            event_type: 'driver.turn_started',
            run_id: input.run_id,
            session_id: 'session_slow_proposer',
          });
          await new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(options.signal?.reason ?? new Error('aborted')),
              { once: true },
            );
          });
        }
        return completedExecution(input);
      },
    };
    const provider = new SynthesisAgentCouncilProvider({
      agentExecutionFacade,
      roleInactivityTimeoutMs: 5,
    });

    const result = await provider.runCouncilRound(baseInput(), {
      onLifecycleEvent: (event) => lifecycleEvents.push(event),
    });

    const proposerRequests = requests.filter(
      (request) => request.role_id === COUNCIL_AGENTS.proposerA,
    );
    expect(proposerRequests).toHaveLength(2);
    expect(proposerRequests[1]).toMatchObject({ session_id: 'session_slow_proposer' });
    expect(proposerRequests[1]?.driver_instruction).toContain('STEERED CONTINUATION');
    expect(result.proposals).toHaveLength(2);
    expect(lifecycleEvents).toContainEqual(
      expect.objectContaining({
        type: 'council.phase.started',
        payload: expect.objectContaining({ recovery: 'same_session_continuation' }),
      }),
    );
  });

  it('does not interrupt a long role while the Driver keeps emitting events', async () => {
    let proposerAttempts = 0;
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input, options) {
        if (input.role_id === COUNCIL_AGENTS.proposerA) {
          proposerAttempts += 1;
          options?.onDriverEvent?.({
            schema_version: 'driver-event.v1',
            event_type: 'driver.turn_started',
            run_id: input.run_id,
            session_id: 'session_active_proposer',
          });
          for (let index = 0; index < 5; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 3));
            options?.onDriverEvent?.({
              schema_version: 'driver-event.v1',
              event_type: 'agent_thought_chunk',
              run_id: input.run_id,
              session_id: 'session_active_proposer',
            });
          }
        }
        return completedExecution(input);
      },
    };
    const provider = new SynthesisAgentCouncilProvider({
      agentExecutionFacade,
      roleInactivityTimeoutMs: 5,
    });

    const result = await provider.runCouncilRound(baseInput());

    expect(proposerAttempts).toBe(1);
    expect(result.proposals).toHaveLength(2);
  });

  it('does not suspend the whole Council when an internal role waits on Mailbox', async () => {
    const lifecycleEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input) {
        const result = completedExecution(input);
        if (input.role_id !== COUNCIL_AGENTS.proposerA) return result;
        return {
          ...result,
          artifact_refs: [],
          diagnostics: {
            ...result.diagnostics,
            mailbox_outcomes: [
              {
                kind: 'request',
                wait_for_reply: true,
                delivery_id: 'delivery_waiting',
                to_role_id: COUNCIL_AGENTS.reviewer,
              },
            ],
          },
        };
      },
    };
    const provider = new SynthesisAgentCouncilProvider({ agentExecutionFacade });

    const result = await provider.runCouncilRound(baseInput(), {
      onLifecycleEvent: (event) => lifecycleEvents.push(event),
    });

    expect(result.proposals).toHaveLength(1);
    expect(result.selected_artifact_refs).toEqual([
      `artifact_${COUNCIL_AGENTS.synthesizer}`,
    ]);
    expect(result.diagnostic_refs).toContain(
      'COUNCIL_PROPOSAL_FAILED:participant_proposer_0',
    );
    expect(lifecycleEvents).toContainEqual(
      expect.objectContaining({
        type: 'council.role.failed',
        payload: expect.objectContaining({
          participant_id: 'participant_proposer_0',
          fallback_action: 'continue_with_available_evidence',
        }),
      }),
    );
  });

  it('does not turn an unstructured reviewer response into approve', async () => {
    const provider = new SynthesisAgentCouncilProvider({ agentExecutionFacade: createFacade() });

    const result = await provider.runCouncilRound(baseInput());

    expect(result.reviews).not.toHaveLength(0);
    expect(result.reviews.every((review) => review.verdict === 'needs_revision')).toBe(true);
    expect(result.reviews.every((review) => review.unmet_criteria?.includes('structured_review'))).toBe(
      true,
    );
  });

  it.each([
    [COUNCIL_AGENTS.proposerA, 'participant_proposer_0', 'COUNCIL_PROPOSAL_FAILED'],
    [COUNCIL_AGENTS.proposerB, 'participant_proposer_1', 'COUNCIL_PROPOSAL_FAILED'],
    [COUNCIL_AGENTS.reviewer, 'participant_reviewer_0', 'COUNCIL_REVIEW_FAILED'],
    [COUNCIL_AGENTS.synthesizer, 'participant_synthesizer_0', 'COUNCIL_SYNTHESIS_FAILED'],
  ] as const)(
    'records a stable diagnostic and continues autonomously when %s fails',
    async (failedAgent, failedParticipant, expectedCode) => {
      const requests: string[] = [];
      const lifecycleEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const agentExecutionFacade: AgentExecutionFacade = {
        async runAgent(input) {
          requests.push(input.role_id);
          return {
            agent_run_id: `agent_run_${input.role_id}`,
            agent_id: input.role_id,
            role_id: input.role_id,
            context_pack_ref: `context_${input.role_id}`,
            driver_run_result_id: `driver_result_${input.role_id}`,
            artifact_refs:
              input.role_id === failedAgent
                ? []
                : [createArtifact(`artifact_${input.role_id}`, input.role_id)],
            transcript_ref: createArtifact(
              `transcript_${input.role_id}`,
              input.role_id,
              'transcript',
            ),
            diagnostics: { driver_id: `driver_${input.role_id}` },
            status: input.role_id === failedAgent ? 'failed' : 'completed',
            created_at: '2026-07-07T00:00:00.000Z',
            schema_version: SCHEMA_VERSION,
          };
        },
      };
      const provider = new SynthesisAgentCouncilProvider({ agentExecutionFacade });

      const result = await provider.runCouncilRound(
        {
          run_id: 'run_failed_role',
          task_id: 'task_failed_role',
          trigger: 'manual',
          decision_mode: 'advisory',
          question: 'Fail one Council role.',
          participants: participantBindings(),
          proposals: [],
          schema_version: SCHEMA_VERSION,
        },
        { onLifecycleEvent: (event) => lifecycleEvents.push(event) },
      );
      expect(result.diagnostic_refs).toContain(`${expectedCode}:${failedParticipant}`);
      expect(new Set(requests.slice(0, 2))).toEqual(
        new Set([COUNCIL_AGENTS.proposerA, COUNCIL_AGENTS.proposerB]),
      );
      expect(requests.slice(2)).toEqual([
        COUNCIL_AGENTS.reviewer,
        COUNCIL_AGENTS.synthesizer,
        ...(failedAgent === COUNCIL_AGENTS.synthesizer
          ? [COUNCIL_AGENTS.synthesizer]
          : []),
      ]);
      expect(lifecycleEvents).toContainEqual(
        expect.objectContaining({
          type: 'council.role.failed',
          payload: expect.objectContaining({
            code: expectedCode,
            participant_id: failedParticipant,
            agent_id: failedAgent,
            agent_status: 'failed',
          }),
        }),
      );
    },
  );

  it('preserves cancellation without publishing a Council failure event', async () => {
    const controller = new AbortController();
    const lifecycleEvents: string[] = [];
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input) {
        controller.abort(new Error('cancelled by user'));
        return {
          agent_run_id: `agent_run_${input.role_id}`,
          agent_id: input.role_id,
          role_id: input.role_id,
          context_pack_ref: `context_${input.role_id}`,
          driver_run_result_id: `driver_result_${input.role_id}`,
          artifact_refs: [],
          transcript_ref: createArtifact(
            `transcript_${input.role_id}`,
            input.role_id,
            'transcript',
          ),
          diagnostics: { driver_id: `driver_${input.role_id}` },
          status: 'cancelled',
          created_at: '2026-07-07T00:00:00.000Z',
          schema_version: SCHEMA_VERSION,
        };
      },
    };
    const provider = new SynthesisAgentCouncilProvider({ agentExecutionFacade });

    await expect(
      provider.runCouncilRound(
        {
          run_id: 'run_cancelled',
          task_id: 'task_cancelled',
          trigger: 'manual',
          decision_mode: 'advisory',
          question: 'Cancel Council.',
          participants: participantBindings(),
          proposals: [],
          schema_version: SCHEMA_VERSION,
        },
        {
          signal: controller.signal,
          onLifecycleEvent: (event) => lifecycleEvents.push(event.type),
        },
      ),
    ).rejects.toThrow('cancelled by user');
    expect(lifecycleEvents).not.toContain('council.failed');
    expect(lifecycleEvents).not.toContain('council.role.failed');
  });

  it('surfaces a lifecycle publication failure instead of silently losing audit events', async () => {
    const failedProvider = new SynthesisAgentCouncilProvider({
      agentExecutionFacade: createFacade(COUNCIL_AGENTS.proposerA),
    });
    await expect(
      failedProvider.runCouncilRound(baseInput(), {
        onLifecycleEvent: () => {
          throw new Error('observer unavailable');
        },
      }),
    ).rejects.toThrow('observer unavailable');
  });
});

function baseInput() {
  return {
    run_id: 'run_observer',
    task_id: 'task_observer',
    trigger: 'manual' as const,
    decision_mode: 'advisory' as const,
    question: 'Observe Council.',
    participants: participantBindings(),
    proposals: [],
    schema_version: SCHEMA_VERSION,
  };
}

function createFacade(failedRole?: string): AgentExecutionFacade {
  return {
    async runAgent(input) {
      const failed = input.role_id === failedRole;
      return {
        agent_run_id: `agent_run_${input.role_id}`,
        agent_id: input.role_id,
        role_id: input.role_id,
        context_pack_ref: `context_${input.role_id}`,
        driver_run_result_id: `driver_result_${input.role_id}`,
        artifact_refs: failed ? [] : [createArtifact(`artifact_${input.role_id}`, input.role_id)],
        transcript_ref: createArtifact(`transcript_${input.role_id}`, input.role_id, 'transcript'),
        session_id: `session_${input.role_id}`,
        response: 'unstructured response',
        tool_events: [],
        diagnostics: { driver_id: `driver_${input.role_id}` },
        status: failed ? ('failed' as const) : ('completed' as const),
        created_at: '2026-07-07T00:00:00.000Z',
        schema_version: SCHEMA_VERSION,
      };
    },
  };
}

function completedExecution(input: AgentExecutionRequest) {
  return {
    agent_run_id: `agent_run_${input.role_id}`,
    agent_id: input.role_id,
    role_id: input.role_id,
    context_pack_ref: `context_${input.role_id}`,
    driver_run_result_id: `driver_result_${input.role_id}`,
    artifact_refs: [createArtifact(`artifact_${input.role_id}`, input.role_id)],
    transcript_ref: createArtifact(`transcript_${input.role_id}`, input.role_id, 'transcript'),
    session_id: input.session_id ?? `session_${input.role_id}`,
    response: 'completed',
    tool_events: [],
    diagnostics: { driver_id: `driver_${input.role_id}` },
    status: 'completed' as const,
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

const COUNCIL_AGENTS = {
  proposerA: 'agent_backend',
  proposerB: 'agent_frontend',
  reviewer: 'agent_security',
  synthesizer: 'agent_architect',
} as const;

function participantBindings(): CouncilParticipantBinding[] {
  return [
    {
      participant_id: 'participant_proposer_0',
      seat: 'proposer',
      seat_index: 0,
      agent_id: COUNCIL_AGENTS.proposerA,
    },
    {
      participant_id: 'participant_proposer_1',
      seat: 'proposer',
      seat_index: 1,
      agent_id: COUNCIL_AGENTS.proposerB,
    },
    {
      participant_id: 'participant_reviewer_0',
      seat: 'reviewer',
      seat_index: 0,
      agent_id: COUNCIL_AGENTS.reviewer,
    },
    {
      participant_id: 'participant_synthesizer_0',
      seat: 'synthesizer',
      seat_index: 0,
      agent_id: COUNCIL_AGENTS.synthesizer,
    },
  ];
}

function createArtifact(
  artifactId: string,
  roleId: string,
  type: ArtifactRef['type'] = 'patch',
  targetPath = `${roleId}.txt`,
): ArtifactRef {
  return {
    artifact_id: artifactId,
    type,
    uri: `artifact://${type}/${artifactId}`,
    producer_id: roleId,
    task_id: 'task_001',
    ...(type === 'transcript'
      ? {}
      : {
          content: {
            kind: 'text' as const,
            content_ref: `data:text/plain,${encodeURIComponent(`output from ${roleId}\n`)}`,
            target_path: targetPath,
          },
        }),
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}
