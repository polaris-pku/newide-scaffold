/**
 * production-b-runtime-role-seed — NEWIDE_B_SEED_ROLES 开箱自举测试
 *
 * 验证 createProductionBRuntime 在开关开启时把提交的 skills/ 语料导入为 5 个
 * 质量维度 role agent（幂等、persona 宪章落库、技能计数精确）；开关关闭时
 * 保持只含默认市场 agent 的既有行为（不污染其他测试/环境）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createProductionBRuntime } from '../../src/app/production-b-runtime';
import {
  InMemoryRepository,
  ROLE_ROSTER,
  scanCorpus,
} from '../../src/memory';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** scaffold 根（skills/ 语料资产所在） */
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CORPUS_ROOT = path.join(REPO_ROOT, 'skills');

describe('production B runtime role seeding (NEWIDE_B_SEED_ROLES)', () => {
  it('开关开启时：自举 5 个 role agent，各维度技能计数与语料一致，persona 宪章落库', async () => {
    const repository = new InMemoryRepository();
    const runtime = await createProductionBRuntime(
      { NEWIDE_B_SEED_ROLES: '1' },
      {
        repoRoot: REPO_ROOT,
        storage: { repository, close: async () => undefined },
      },
    );
    try {
      const agentIds = new Set(await repository.listAgentIds());
      for (const spec of ROLE_ROSTER) {
        expect(agentIds.has(spec.role_id), `role ${spec.role_id} must be seeded`).toBe(true);
      }

      const activityByRole = new Map<string, number>();
      for (const file of await scanCorpus(CORPUS_ROOT)) {
        if (file.kind === 'activity') {
          activityByRole.set(file.role, (activityByRole.get(file.role) ?? 0) + 1);
        }
      }

      for (const spec of ROLE_ROSTER) {
        const skills = await repository.listSkills(spec.role_id);
        expect(skills.length, `${spec.role_id} skill count`).toBe(
          activityByRole.get(spec.role) ?? 0,
        );
        const persona = await repository.getPersona(spec.role_id);
        expect(persona.summary).toBe(spec.charter);
        expect(persona.skills_overview).toContain(String(skills.length));
        const metrics = await repository.getMetrics(spec.role_id);
        expect(metrics.skill_count).toBe(skills.length);
        expect(metrics.promoted_skill_count).toBe(0);
        expect(metrics.imported_skill_count).toBe(0);
      }
    } finally {
      await runtime.close();
    }
  });

  it('开关关闭时：不创建 role agent（默认仅 4 个市场 agent）', async () => {
    const repository = new InMemoryRepository();
    const runtime = await createProductionBRuntime(
      {},
      {
        repoRoot: REPO_ROOT,
        storage: { repository, close: async () => undefined },
      },
    );
    try {
      const agentIds = await repository.listAgentIds();
      for (const spec of ROLE_ROSTER) {
        expect(agentIds).not.toContain(spec.role_id);
      }
    } finally {
      await runtime.close();
    }
  });
});
