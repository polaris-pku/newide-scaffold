import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../core';
import type {
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle,
  DriverStreamEvent,
  DriverStreamEventListener,
} from './contract';
import { createDriverRuntimeInvoker } from './driver-runtime-invoker';

describe('createDriverRuntimeInvoker', () => {
  it('maps B-shaped input to a stable prompt and returns an auditable success', async () => {
    const driver = new TestDriver(successResult());
    const invoke = createDriverRuntimeInvoker(driver);
    const input = invocationInput();

    const output = await invoke(input);

    expect(driver.prompts[0]).toMatchObject({
      task_id: 'task_1',
      run_id: 'run_1',
      workspace_path: '/tmp/newide-project',
      session_id: 'session_existing',
      schema_version: SCHEMA_VERSION,
    });
    expect(driver.prompts[0]?.prompt).toBe(
      '{"experiences":[{"content":"Experience body","description":"Experience","id":"exp_1"}],"skills":[{"content":"Skill body","description":"Skill","id":"skill_1"}],"task_instruction":"Implement it"}',
    );
    expect(output.execution).toEqual(successResult());
    expect(output.report).toEqual({
      artifacts: [{ type: 'patch', path: 'artifact://patch/1', summary: 'Changed one file' }],
      summary: 'Driver succeeded (driver_result_1).',
      decisions: [],
      blockers: [],
      referenced_experiences: [
        {
          experience_id: 'exp_1',
          applied: false,
          effectiveness: 'not_applicable',
          note: 'Driver result driver_result_1 did not evidence use of experience exp_1.',
        },
      ],
      assumptions: [],
    });
  });

  it('uses a deterministic fallback when artifact summary metadata is absent', async () => {
    const result = successResult();
    delete result.artifacts[0]?.metadata;

    const output = await createDriverRuntimeInvoker(new TestDriver(result))(invocationInput());

    expect(output.report.artifacts[0]?.summary).toBe('patch artifact artifact_1');
  });

  it('serializes nested context deterministically regardless of property insertion order', async () => {
    const firstDriver = new TestDriver(successResult());
    const secondDriver = new TestDriver(successResult());
    const first = invocationInput();
    const second = invocationInput();
    second.driver_context.skills = [{ content: 'Skill body', description: 'Skill', id: 'skill_1' }];

    await createDriverRuntimeInvoker(firstDriver)(first);
    await createDriverRuntimeInvoker(secondDriver)(second);

    expect(firstDriver.prompts[0]?.prompt).toBe(secondDriver.prompts[0]?.prompt);
  });

  it('sorts unknown and Unicode nested keys by code unit without locale dependence', async () => {
    const driver = new TestDriver(successResult());
    const input = invocationInput();
    Object.assign(input.driver_context.skills[0]!, { z: 1, ä: 2, A: 3, a: { z: 1, A: 2 } });

    await createDriverRuntimeInvoker(driver)(input);

    expect(driver.prompts[0]?.prompt).toContain(
      '"skills":[{"A":3,"a":{"A":2,"z":1},"content":"Skill body","description":"Skill","id":"skill_1","z":1,"ä":2}]',
    );
  });

  it.each(['failed', 'cancelled', 'interrupted'] as const)(
    'preserves %s diagnostics and error semantics in an unresolved blocker',
    async (status) => {
      const result = successResult();
      result.status = status;
      result.diagnostics.notes = ['first attempt failed'];
      result.error = { code: 'DRIVER_ERROR', message: 'Driver stopped', retryable: true };

      const output = await createDriverRuntimeInvoker(new TestDriver(result))(invocationInput());

      expect(output.execution).toBe(result);
      expect(output.report.blockers).toEqual([
        {
          blocker: 'Driver stopped',
          attempts: ['first attempt failed'],
          resolution: 'DRIVER_ERROR (retryable)',
          resolved: false,
        },
      ]);
      expect(output.report.referenced_experiences[0]).toMatchObject({
        applied: false,
        effectiveness: 'not_applicable',
      });
    },
  );

  it('converts a non-abort throw into a failed execution and fallback report', async () => {
    const driver = new TestDriver(new Error('socket closed'));

    const output = await createDriverRuntimeInvoker(driver)(invocationInput());

    expect(output.execution).toMatchObject({
      status: 'failed',
      session_id: 'session_1',
      diagnostics: { driver_id: 'driver_1', notes: ['driver_exception=socket closed'] },
      error: {
        code: 'DRIVER_RUNTIME_INVOKER_ERROR',
        message: 'socket closed',
        retryable: false,
      },
    });
    expect(output.report.blockers[0]).toMatchObject({
      blocker: 'socket closed',
      resolved: false,
    });
  });

  it('rethrows aborts and forwards cancellation to the runtime', async () => {
    const controller = new AbortController();
    const driver = new TestDriver(new Promise<DriverRunResult>(() => undefined));
    const invoke = createDriverRuntimeInvoker(driver);
    const running = invoke(invocationInput(), { signal: controller.signal });

    controller.abort(new DOMException('cancelled by caller', 'AbortError'));

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(driver.interrupt).toHaveBeenCalledWith('cancelled by caller', 'run_1');
  });

  it('forwards incremental driver events while the invocation is active', async () => {
    const driver = new TestDriver(successResult());
    const events: DriverStreamEvent[] = [];

    await createDriverRuntimeInvoker(driver)(invocationInput(), {
      onDriverEvent: (event) => events.push(event),
    });

    expect(events).toEqual([
      expect.objectContaining({
        event_type: 'agent_message_chunk',
        task_id: 'task_1',
        run_id: 'run_1',
      }),
    ]);
    expect(driver.eventListeners.size).toBe(0);
  });

  it('is structurally assignable to the expected B-facing shape', () => {
    type BReport = {
      artifacts: Array<{ type: string; path: string; summary: string }>;
      summary: string;
      decisions: Array<{ point: string; options: string[]; chosen: string; reason: string }>;
      blockers: Array<{
        blocker: string;
        attempts: string[];
        resolution: string;
        resolved: boolean;
      }>;
      referenced_experiences: Array<{
        experience_id: string;
        applied: boolean;
        effectiveness: 'fully_effective' | 'partially_effective' | 'ineffective' | 'not_applicable';
        note: string;
      }>;
      assumptions: Array<{ assumption: string; risk_if_wrong: string }>;
    };
    type Expected = (
      input: ReturnType<typeof invocationInput>,
      options?: { signal?: AbortSignal; onDriverEvent?: DriverStreamEventListener },
    ) => Promise<{ report: BReport; execution: DriverRunResult }>;
    const expected: Expected = createDriverRuntimeInvoker(new TestDriver(successResult()));

    expect(expected).toBeTypeOf('function');
  });

  it('fails before invoking a runtime whose identity differs from source_driver', async () => {
    const driver = new TestDriver(successResult());
    const input = invocationInput();
    input.source_driver = 'another-driver';

    await expect(createDriverRuntimeInvoker(driver)(input)).rejects.toThrow(
      'source_driver another-driver does not match runtime driver_id driver_1',
    );
    expect(driver.prompts).toHaveLength(0);
  });
});

class TestDriver implements DriverRuntimeHandle {
  readonly driver_id = 'driver_1';
  readonly session_id = 'session_1';
  readonly capabilities = {
    supports_acp_extension: false,
    supports_structured_output: true,
    supports_session_load: false,
    supports_tool_events: false,
    supports_permission_events: false,
  };
  readonly prompts: DriverPrompt[] = [];
  readonly eventListeners = new Set<DriverStreamEventListener>();
  readonly interrupt = vi.fn(async (_reason: string) => undefined);

  constructor(private readonly result: DriverRunResult | Error | Promise<DriverRunResult>) {}

  async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    this.prompts.push(input);
    for (const listener of this.eventListeners) {
      listener({
        schema_version: 'driver-event.v1',
        event_type: 'agent_message_chunk',
        task_id: input.task_id,
        run_id: input.run_id,
        payload: { text: 'live output' },
      });
    }
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }

  subscribeToEvents(listener: DriverStreamEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async collectTranscript(): Promise<ArtifactRef> {
    return transcript();
  }
}

function invocationInput() {
  return {
    task_id: 'task_1',
    run_id: 'run_1',
    workspace_path: '/tmp/newide-project',
    session_id: 'session_existing',
    call_id: 'call_1',
    source_driver: 'driver_1',
    driver_context: {
      task_instruction: 'Implement it',
      skills: [{ id: 'skill_1', description: 'Skill', content: 'Skill body' }],
      experiences: [{ id: 'exp_1', description: 'Experience', content: 'Experience body' }],
    },
  };
}

function successResult(): DriverRunResult {
  return {
    driver_run_result_id: 'driver_result_1',
    session_id: 'session_1',
    status: 'succeeded',
    artifacts: [
      {
        artifact_id: 'artifact_1',
        type: 'patch',
        uri: 'artifact://patch/1',
        producer_id: 'driver_1',
        task_id: 'task_1',
        metadata: { summary: 'Changed one file' },
        created_at: '2026-07-12T00:00:00.000Z',
        schema_version: SCHEMA_VERSION,
      },
    ],
    transcript_ref: transcript(),
    tool_events: [],
    diagnostics: { driver_id: 'driver_1', duration_ms: 12, notes: ['complete'] },
    created_at: '2026-07-12T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function transcript(): ArtifactRef {
  return {
    artifact_id: 'transcript_1',
    type: 'transcript',
    uri: 'artifact://transcript/1',
    producer_id: 'driver_1',
    task_id: 'task_1',
    created_at: '2026-07-12T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}
