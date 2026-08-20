import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProductionBRuntime } from '../../src/app/production-b-runtime';
import { InMemoryRepository } from '../../src/memory';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('createProductionBRuntime', () => {
  it('seeds the app catalog through B public repository and buffer ports', async () => {
    const appStateRoot = await temporaryRoot();
    const repository = new InMemoryRepository();
    await repository.initializeAgent({
      role_id: 'role_ts_engineer',
      name: 'User-owned TypeScript Specialist',
      tags: ['user_owned'],
      persona_seed: 'Preserve this existing persona.',
    });
    const close = vi.fn(async () => undefined);

    const runtime = await createProductionBRuntime({}, {
      appStateRoot,
      storage: { repository, close },
    });

    expect(runtime.app_state_root).toBe(appStateRoot);
    // market_agent_ids 现在是 DB 快照（按 role_id 排序），而非硬编码种子声明顺序
    expect(runtime.market_agent_ids).toEqual([
      'role_code_reviewer',
      'role_fullstack_engineer',
      'role_synthesis_engineer',
      'role_ts_engineer',
    ]);
    expect(new Set(await runtime.repository.listAgentIds())).toEqual(
      new Set([
        'role_fullstack_engineer',
        'role_ts_engineer',
        'role_code_reviewer',
        'role_synthesis_engineer',
      ]),
    );
    await expect(runtime.repository.getAgent('role_fullstack_engineer')).resolves.toMatchObject({
      tags: expect.arrayContaining(['market_eligible']),
    });
    await expect(runtime.repository.getAgent('role_ts_engineer')).resolves.toMatchObject({
      name: 'User-owned TypeScript Specialist',
      tags: ['user_owned'],
      persona: { summary: 'Preserve this existing persona.' },
    });
    await expect(runtime.bufferRepository.getBufferMeta('role_ts_engineer')).resolves.toMatchObject({
      pending_count: 0,
    });

    await Promise.all([runtime.close(), runtime.close()]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('falls back to embedded PGlite when no database URL is configured', async () => {
    const runtime = await createProductionBRuntime(
      { NEWIDE_B_EMBEDDING_PROVIDER: 'hash' },
      { appStateRoot: await temporaryRoot() },
    );

    expect(runtime.market_agent_ids).toEqual([
      'role_code_reviewer',
      'role_fullstack_engineer',
      'role_synthesis_engineer',
      'role_ts_engineer',
    ]);
    expect(new Set(await runtime.repository.listAgentIds())).toEqual(
      new Set([
        'role_fullstack_engineer',
        'role_ts_engineer',
        'role_code_reviewer',
        'role_synthesis_engineer',
      ]),
    );
    await runtime.close();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'newide-production-b-runtime-'));
  roots.push(root);
  return root;
}
