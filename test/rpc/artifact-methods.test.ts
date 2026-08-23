import { describe, expect, it } from 'vitest';
import { ArtifactRpcMethods } from '../../src/rpc/artifact-methods';
import { JsonRpcDispatcher } from '../../src/rpc/json-rpc-dispatcher';

describe('ArtifactRpcMethods', () => {
  it('reads a run-scoped artifact through artifact.getContent', async () => {
    const dispatcher = new JsonRpcDispatcher();
    new ArtifactRpcMethods({
      getArtifactContent: async (runId, artifactId) => ({
        run_id: runId,
        artifact_id: artifactId,
        type: 'decision_packet',
        media_type: 'text/markdown',
        target_path: 'council-plan.md',
        sha256: 'a'.repeat(64),
        content: '# Final plan',
        bytes_total: 12,
        truncated: false,
      }),
    }).register(dispatcher);

    const response = await dispatcher.dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'artifact.getContent',
      params: { run_id: 'run_1', artifact_id: 'artifact_1' },
    });

    expect(response).toMatchObject({
      result: {
        run_id: 'run_1',
        artifact_id: 'artifact_1',
        content: '# Final plan',
      },
    });
  });
});
