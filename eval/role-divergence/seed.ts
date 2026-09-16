/**
 * seed — 把语料导入实验专用 PGlite，并种一个空记忆的中性 agent
 *
 * 五个质量维度角色走既有 `importSkillCorpus` 资产模式：以 `AssetEmbeddingProvider`
 * （1024 维零向量，仅用于通过 readiness 探针）构造仓储，向量由
 * `skills/skill-embeddings.json` 提供——`PgMemoryRepository.withDescriptionEmbedding`
 * 在「记录向量长度 == provider 维度」时原样落库，因此资产向量被真正写入，
 * 且全流程零 embedding API 调用。
 *
 * 另外种一个 `role_neutral`：无技能、中性 persona，专供实验二的「白板 plan」，
 * 使其与角色 plan 走**同一条** facade → driver 链路，唯一差别是记忆为空。
 */
import path from 'node:path';
import {
  createProductionBRuntime,
  type BackendBRuntime,
} from '../../src/app/production-b-runtime';
import {
  type CorpusRole,
  AssetEmbeddingProvider,
  ROLE_ROSTER,
  importSkillCorpus,
  readSkillEmbeddings,
} from '../../src/memory';
import { PGLITE_DIR_ENV, type ExperimentConfig } from './config';
import { NEUTRAL_AGENT_ID } from './types';

/** 期望的各维度技能数——与 `skills/README.md`、语料快照测试同源 */
export const EXPECTED_SKILL_TOTALS: Readonly<Record<CorpusRole, number>> = {
  correctness: 10,
  maintainability: 9,
  performance: 10,
  reliability: 8,
  security: 23,
};

/** 资产维度：必须与查询侧 provider 维度一致，否则向量空间错位 */
export const EXPECTED_DIMENSIONS = 1024;

const NEUTRAL_CHARTER =
  '在这个对照条件下不作为任何专业质量角色行事：不做正确性、可维护性、性能、可靠性或安全维度的专门权衡，只依据给定的问题陈述产出一份中性的实现计划。';
const NEUTRAL_BOUNDARY = '本 agent 仅用于产出白板对照 plan，不承担任何质量维度职责。';

export interface SeedReport {
  per_role: Array<{ role: CorpusRole; role_id: string; skill_count: number }>;
  neutral_role_id: string;
  dimensions: number;
  asset_model: string;
}

export async function seedRoleCorpus(config: ExperimentConfig): Promise<SeedReport> {
  const asset = await readSkillEmbeddings(config.skills_dir);
  if (!asset) {
    throw new Error(
      `Embedding asset missing at ${config.skills_dir}/skill-embeddings.json. ` +
        'Run `pnpm skills:embed` before seeding the experiment.',
    );
  }
  if (asset.dimensions !== EXPECTED_DIMENSIONS) {
    throw new Error(
      `Embedding asset dimensions ${asset.dimensions} != expected ${EXPECTED_DIMENSIONS}. ` +
        'Query-side and corpus-side vectors must share the same space.',
    );
  }

  const env: NodeJS.ProcessEnv = { ...process.env, [PGLITE_DIR_ENV]: config.pglite_dir };
  const runtime = await createProductionBRuntime(env, {
    repoRoot: config.scaffold_root,
    appStateRoot: path.join(config.result_root, 'app-state'),
    embedding: new AssetEmbeddingProvider(asset.dimensions),
  });

  try {
    const report = await importSkillCorpus(runtime.repository, {
      rootDir: config.skills_dir,
      embeddings: asset,
    });
    for (const roleId of report.created_role_ids) {
      await runtime.bufferRepository.ensureAgent(roleId);
    }

    const perRole: SeedReport['per_role'] = [];
    for (const spec of ROLE_ROSTER) {
      const skills = await runtime.repository.listSkills(spec.role_id);
      const expected = EXPECTED_SKILL_TOTALS[spec.role];
      if (skills.length !== expected) {
        throw new Error(
          `${spec.role_id}: seeded ${skills.length} skills, expected ${expected}. ` +
            'Corpus and experiment expectation have diverged.',
        );
      }
      const notApproved = skills.filter((skill) => skill.review_status !== 'approved');
      if (notApproved.length > 0) {
        throw new Error(
          `${spec.role_id}: ${notApproved.length} skill(s) not approved; ` +
            'retrieval filters on review_status === "approved" and would drop them.',
        );
      }
      const wrongDim = skills.filter(
        (skill) => skill.description_embedding.length !== EXPECTED_DIMENSIONS,
      );
      if (wrongDim.length > 0) {
        throw new Error(
          `${spec.role_id}: ${wrongDim.length} skill(s) with embedding dim != ${EXPECTED_DIMENSIONS}.`,
        );
      }
      perRole.push({ role: spec.role, role_id: spec.role_id, skill_count: skills.length });
    }

    await ensureNeutralAgent(runtime);

    return {
      per_role: perRole,
      neutral_role_id: NEUTRAL_AGENT_ID,
      dimensions: asset.dimensions,
      asset_model: asset.model,
    };
  } finally {
    await runtime.close();
  }
}

/** 种中性对照 agent（幂等）：无技能、中性 persona */
async function ensureNeutralAgent(runtime: BackendBRuntime): Promise<void> {
  const existing = new Set(await runtime.repository.listAgentIds());
  if (!existing.has(NEUTRAL_AGENT_ID)) {
    await runtime.repository.initializeAgent({
      role_id: NEUTRAL_AGENT_ID,
      name: '中性白板 Neutral',
      tags: ['neutral', 'role-divergence-control'],
      persona_seed: NEUTRAL_CHARTER,
      constraints: [],
    });
    await runtime.bufferRepository.ensureAgent(NEUTRAL_AGENT_ID);
  }
  await runtime.repository.savePersona(NEUTRAL_AGENT_ID, {
    role_id: NEUTRAL_AGENT_ID,
    version: 1,
    summary: NEUTRAL_CHARTER,
    skills_overview: '无预置技能：本对照条件下不加载任何技能。',
    experience_coverage: '无运行时经验。',
    recent_performance: '等待首个任务。',
    notes: NEUTRAL_BOUNDARY,
    generated_at: new Date().toISOString(),
  });

  const skills = await runtime.repository.listSkills(NEUTRAL_AGENT_ID);
  if (skills.length !== 0) {
    throw new Error(
      `Neutral agent ${NEUTRAL_AGENT_ID} must have zero skills, found ${skills.length}.`,
    );
  }
}
