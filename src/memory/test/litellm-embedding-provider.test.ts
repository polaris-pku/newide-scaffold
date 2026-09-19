import { afterEach, describe, expect, it } from 'vitest';
import type { LiteLLMClient } from '../../litellm/contract';
import { LiteLLMEmbeddingProvider } from '../adapters/litellm-embedding-provider';
import { getRunLlmUsageLedger, releaseRunLlmUsageLedger, runWithLlmUsageLedger } from '../../telemetry';

const RUN_IDS: string[] = [];

afterEach(() => {
  for (const runId of RUN_IDS.splice(0)) releaseRunLlmUsageLedger(runId);
});

function stubClient(usage: { prompt_tokens: number; completion_tokens: number }): LiteLLMClient {
  return {
    dimensions: 1024,
    embed: async () => ({
      model: 'text-embedding-v3',
      embeddings: [[0.1, 0.2, 0.3]],
      usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
    }),
  } as unknown as LiteLLMClient;
}

async function embedUnderLedger(
  client: LiteLLMClient,
  runId: string,
  text = 'newIDE embedding usage probe',
): Promise<number[]> {
  RUN_IDS.push(runId);
  const provider = new LiteLLMEmbeddingProvider(client);
  let vector: number[] = [];
  await runWithLlmUsageLedger({ case_id: 'case_embed', run_id: runId }, async () => {
    vector = await provider.embed(text);
  });
  return vector;
}

describe('LiteLLMEmbeddingProvider usage accounting', () => {
  it('records one ledger entry per embed call', async () => {
    const vector = await embedUnderLedger(
      stubClient({ prompt_tokens: 42, completion_tokens: 0 }),
      'run_embed_records',
    );

    expect(vector).toEqual([0.1, 0.2, 0.3]);
    const entries = getRunLlmUsageLedger('run_embed_records')?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      input_tokens: 42,
      output_tokens: 0,
      model: 'text-embedding-v3',
      source: 'proxy',
    });
  });

  it('records one entry per call when embedded repeatedly', async () => {
    const provider = new LiteLLMEmbeddingProvider(
      stubClient({ prompt_tokens: 10, completion_tokens: 0 }),
    );
    RUN_IDS.push('run_embed_repeat');
    await runWithLlmUsageLedger({ case_id: 'case_embed', run_id: 'run_embed_repeat' }, async () => {
      await provider.embed('first');
      await provider.embed('second');
      await provider.embed('third');
    });

    const entries = getRunLlmUsageLedger('run_embed_repeat')?.entries ?? [];
    expect(entries).toHaveLength(3);
    expect(entries.reduce((sum, entry) => sum + entry.input_tokens, 0)).toBe(30);
  });
});
