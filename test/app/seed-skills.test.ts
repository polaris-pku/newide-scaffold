/**
 * 预置技能语料测试
 *
 * 验证三件事：四个角色各拿到两条 approved 技能；重复 seed 幂等；语料的 tag 能被真实
 * 检索流水线命中，且只在本角色作用域内命中。
 *
 * 第三条是这份语料存在的理由——前两条只是它的前提。若 tag 命中不了，
 * 技能就永远不会进入 retrieveMemoriesForTask 的候选集，seed 得再整齐也没有意义。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProductionBRuntime } from '../../src/app/production-b-runtime';
import { SEED_SKILLS, seedSkills } from '../../src/app/seed-skills';
import {
  createAgentMemoryScope,
  HashEmbeddingProvider,
  InMemoryBufferRepository,
  InMemoryRepository,
  retrieveMemoriesForTask,
} from '../../src/memory';

const ROLES = [
  'role_fullstack_engineer',
  'role_ts_engineer',
  'role_code_reviewer',
  'role_synthesis_engineer',
] as const;

const roots: string[] = [];
const embedding = new HashEmbeddingProvider();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'newide-seed-skills-'));
  roots.push(root);
  return root;
}

async function seededRepository(): Promise<InMemoryRepository> {
  const repository = new InMemoryRepository(embedding);
  const runtime = await createProductionBRuntime(
    {},
    {
      appStateRoot: await temporaryRoot(),
      storage: { repository, close: async () => undefined },
    },
  );
  await runtime.close();
  return repository;
}

describe('seed skills', () => {
  it('gives every seeded role two approved skills with the catalog ids', async () => {
    const repository = await seededRepository();

    for (const role_id of ROLES) {
      const expected = SEED_SKILLS.filter((seed) => seed.role_id === role_id);
      expect(expected.length).toBeGreaterThan(0);

      const skills = await repository.listSkills(role_id);
      expect(skills.map((skill) => skill.id).sort()).toEqual(
        expected.map((seed) => seed.id).sort(),
      );
      expect(skills.every((skill) => skill.review_status === 'approved')).toBe(true);
      // market_status 必须留空：'superseded' 会被检索资格过滤掉，而这三态都不该出现
      expect(skills.every((skill) => skill.market_status === undefined)).toBe(true);
    }

    expect(SEED_SKILLS).toHaveLength(8);
  });

  it('is idempotent across repeated seeding', async () => {
    const repository = await seededRepository();
    const before = await Promise.all(ROLES.map((role_id) => repository.listSkills(role_id)));

    await seedSkills(repository);

    const after = await Promise.all(ROLES.map((role_id) => repository.listSkills(role_id)));
    expect(after.map((skills) => skills.map((skill) => skill.id))).toEqual(
      before.map((skills) => skills.map((skill) => skill.id)),
    );
  });

  it('retrieves each role’s skills for a query carrying one of their tags', async () => {
    const repository = await seededRepository();
    const bufferRepository = new InMemoryBufferRepository();

    for (const role_id of ROLES) {
      for (const seed of SEED_SKILLS.filter((item) => item.role_id === role_id)) {
        const scope = createAgentMemoryScope(repository, bufferRepository, role_id);
        const result = await retrieveMemoriesForTask(
          scope,
          { task_query: `Handle the ${seed.tags[0]!} work in this repository.` },
          { embedding },
        );

        expect(result.skills.map((skill) => skill.id)).toContain(seed.id);
        // 全量注入：检索不应截断 content，否则 Driver 拿到的是半截技能
        const retrieved = result.skills.find((skill) => skill.id === seed.id);
        expect(retrieved?.content).toBe(seed.content);
      }
    }
  });

  it('never crosses roles when retrieving', async () => {
    const repository = await seededRepository();
    const bufferRepository = new InMemoryBufferRepository();

    for (const role_id of ROLES) {
      const scope = createAgentMemoryScope(repository, bufferRepository, role_id);
      const result = await retrieveMemoriesForTask(
        scope,
        { task_query: 'Handle the typescript contract review synthesis work.' },
        { embedding },
      );

      const otherRoleIds = new Set(
        SEED_SKILLS.filter((seed) => seed.role_id !== role_id).map((seed) => seed.id),
      );
      expect(result.skills.every((skill) => !otherRoleIds.has(skill.id))).toBe(true);
    }
  });
});
