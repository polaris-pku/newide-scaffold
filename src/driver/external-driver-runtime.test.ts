import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../core';
import type { DriverPrompt, DriverRunResult } from './contract';
import { ExternalDriverRuntime } from './external-driver-runtime';

const PROMPT: DriverPrompt = {
  task_id: 'task_external',
  run_id: 'run_external',
  prompt: 'Implement the requested change through the external driver contract.',
  created_at: '2026-07-03T00:00:00.000Z',
  schema_version: SCHEMA_VERSION,
};

describe('ExternalDriverRuntime', () => {
  it('forwards DriverPrompt unchanged and returns the transport result', async () => {
    let receivedPrompt: DriverPrompt | undefined;
    const expectedResult = driverRunResult();
    const runtime = new ExternalDriverRuntime({
      driver_id: 'external-acp-driver',
      session_id: 'external-session',
      capabilities: { supports_acp_extension: true },
      transport: {
        invoke: async (input) => {
          receivedPrompt = input;
          return expectedResult;
        },
      },
    });

    const result = await runtime.sendPrompt(PROMPT);

    expect(receivedPrompt).toBe(PROMPT);
    expect(result).toBe(expectedResult);
    expect(runtime.driver_id).toBe('external-acp-driver');
    expect(runtime.session_id).toBe('external-session');
    expect(runtime.capabilities).toMatchObject({
      supports_acp_extension: true,
      supports_structured_output: true,
    });
  });

  it('rejects malformed transport results before they can be registered as artifacts', async () => {
    const runtime = new ExternalDriverRuntime({
      driver_id: 'external-acp-driver',
      transport: {
        invoke: async () =>
          ({
            driver_run_result_id: 'driver_result_bad',
            status: 'succeeded',
          }) as DriverRunResult,
      },
    });

    await expect(runtime.sendPrompt(PROMPT)).rejects.toThrow(
      'External driver returned malformed DriverRunResult: session_id is required',
    );
  });

  it('starts a fresh session when session loading is unsupported', async () => {
    let receivedPrompt: DriverPrompt | undefined;
    const runtime = new ExternalDriverRuntime({
      driver_id: 'external-acp-driver',
      capabilities: { supports_session_load: false },
      transport: {
        invoke: async (input) => {
          receivedPrompt = input;
          return driverRunResult();
        },
      },
    });

    await runtime.sendPrompt({ ...PROMPT, session_id: 'stale-process-local-session' });

    expect(receivedPrompt?.session_id).toBeUndefined();
  });

  it('returns a failed DriverRunResult when the transport throws', async () => {
    const runtime = new ExternalDriverRuntime({
      driver_id: 'external-acp-driver',
      session_id: 'external-session',
      transport: {
        invoke: async () => {
          throw new Error('Command driver timed out after 1000ms');
        },
      },
    });

    const result = await runtime.sendPrompt(PROMPT);

    expect(result).toMatchObject({
      session_id: 'external-session',
      status: 'failed',
      artifacts: [],
      error: {
        code: 'EXTERNAL_DRIVER_TRANSPORT_ERROR',
        message: 'Command driver timed out after 1000ms',
        retryable: true,
      },
    });
    expect(result.transcript_ref.type).toBe('transcript');
    expect(result.diagnostics.notes).toContain(
      'transport_error=Command driver timed out after 1000ms',
    );
  });

  it('delegates interrupt and shutdown to the transport when supported', async () => {
    const interrupt = vi.fn(async (_reason: string) => undefined);
    const shutdown = vi.fn(async () => undefined);
    const runtime = new ExternalDriverRuntime({
      driver_id: 'external-acp-driver',
      transport: {
        invoke: async () => driverRunResult(),
        interrupt,
        shutdown,
      },
    });

    await runtime.interrupt('user cancelled the run');
    await runtime.shutdown();

    expect(interrupt).toHaveBeenCalledWith('user cancelled the run');
    expect(shutdown).toHaveBeenCalledOnce();
  });
});

function driverRunResult(): DriverRunResult {
  const created_at = '2026-07-03T00:00:01.000Z';
  const transcript = artifactRef({
    artifact_id: 'artifact_transcript',
    type: 'transcript',
    uri: 'artifact://transcript/task_external/external-session',
    created_at,
  });

  return {
    driver_run_result_id: 'driver_result_external',
    session_id: 'external-session',
    status: 'succeeded',
    artifacts: [
      artifactRef({
        artifact_id: 'artifact_driver_result',
        type: 'driver_result',
        uri: 'artifact://driver_result/task_external/driver_result_external.json',
        created_at,
      }),
    ],
    transcript_ref: transcript,
    tool_events: [],
    diagnostics: {
      driver_id: 'external-acp-driver',
      duration_ms: 12,
      notes: ['External driver contract returned a structured result.'],
    },
    created_at,
    schema_version: SCHEMA_VERSION,
  };
}

function artifactRef(input: {
  artifact_id: string;
  type: ArtifactRef['type'];
  uri: string;
  created_at: string;
}): ArtifactRef {
  return {
    artifact_id: input.artifact_id,
    type: input.type,
    uri: input.uri,
    producer_id: 'external-acp-driver',
    task_id: 'task_external',
    created_at: input.created_at,
    schema_version: SCHEMA_VERSION,
  };
}
