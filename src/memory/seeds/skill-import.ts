/**
 * skill-import — 预置技能语料导入与 role agent 种子编排
 *
 * 把 `skills/<role>/<skill>/SKILL.md` 活动技能 1:1 导入为 SkillRecord（id =
 * uuid v5(slug)，幂等），指针目录不生成记录而是记入宿主 sub_skills；为 5 个
 * 质量维度 role agent 建号（缺失时 initializeAgent）、写 PersonaDef v1、
 * 校正指标计数。删除仅限"上版基线存在、本次语料移除"的技能（uuid v5 命名
 * 空间判定），绝不动运行时晋升/市场引入产生的技能。dry-run 只出报告不写库。
 */
import { nowTimestamp } from '../../core';
import type { MemoryRepository } from '../ports/memory-repository';
import type { PersonaDef, SkillRecord } from '../schemas';
import {
  COUNCIL_TRIO_SLUGS,
  readBaselineManifest,
  scanCorpus,
  skillContentHash,
  slugToSkillId,
  type CorpusRole,
  type CorpusSkillFile,
  type SkillEmbeddingsManifest,
} from './skill-corpus';
import { ROLE_ROSTER, type RoleSeedSpec } from './role-roster';

const TAG_STOP_WORDS = new Set([
  'and',
  'for',
  'the',
  'to',
  'of',
  'with',
  'from',
  'into',
  'across',
  'after',
  'between',
  'before',
  'over',
  'under',
  'vs',
]);

export interface CorpusImportOptions {
  /** 语料根目录（scaffold 内 skills/） */
  rootDir: string;
  /** 只计算并报告，不写库（默认 false） */
  dryRun?: boolean;
  /**
   * 预计算向量资产（skills/skill-embeddings.json）。提供时以资产向量填充
   * description_embedding，导入零 embedding 依赖；缺失条目 / sha256 过期 → 抛错
   * （禁止静默现场向量化）。不提供时退回现场 embed（调用方自行保证 provider
   * 维度与库 schema 一致）。
   */
  embeddings?: SkillEmbeddingsManifest | null;
}

/** 资产复用的逐条判定结果（dry-run 报告口径） */
export interface EmbeddingAssetAudit {
  /** 命中资产且 sha256 一致的技能数 */
  reuse: number;
  /** 资产缺失 / 过期（sha256 不一致），导入将抛错的技能数 */
  stale: number;
  /** 未提供资产的技能数（不报错，走现场 embed） */
  absent: number;
  /** 资产缺失 / 过期的技能 slug（报错文案 / dry-run 展示） */
  stale_slugs: string[];
}

export interface RoleImportSummary {
  role: CorpusRole;
  role_id: string;
  /** 本角色活动技能数（= 期望落库数） */
  activity_total: number;
  added: number;
  updated: number;
  skipped: number;
  removed: number;
  agent_created: boolean;
}

export interface CorpusImportReport {
  per_role: RoleImportSummary[];
  /** 本次新建的 role agent（需调用方补 buffer） */
  created_role_ids: string[];
  activity_total: number;
  pointer_total: number;
  /** 资产复用审计（预案指定 embeddings 时才有意义） */
  embedding_asset?: EmbeddingAssetAudit;
}

/** 技能级 tags：dim 维度 + slug 分词（过滤停用词）+ corpus-seed；议会三件套加 deployment 标记 */
export function skillTagsFor(skill: Pick<CorpusSkillFile, 'slug' | 'role'>): string[] {
  const words = skill.slug
    .split('-')
    .filter((word) => word.length > 2 && !TAG_STOP_WORDS.has(word));
  const tags = [`dim:${skill.role}`, ...words, 'corpus-seed'];
  if (COUNCIL_TRIO_SLUGS.has(skill.slug)) {
    tags.push('deployment:trio');
  }
  return [...new Set(tags)];
}

function bumpVersion(version: string): string {
  const [majorText, minorText, patchText] = version.split('.');
  const major = Number(majorText ?? 1);
  const minor = Number(minorText ?? 0);
  const patch = Number(patchText ?? 0);
  return `${major}.${minor}.${patch + 1}`;
}

function toSkillRecord(
  skill: CorpusSkillFile,
  roleId: string,
  now: string,
  subSkills: string[],
  version: string,
  embedding: number[],
): SkillRecord {
  return {
    id: slugToSkillId(skill.slug),
    description: skill.description,
    description_embedding: embedding,
    content: skill.body,
    version,
    review_status: 'approved',
    ...(subSkills.length > 0 ? { sub_skills: subSkills } : {}),
    tags: skillTagsFor(skill),
    promoted_at: now,
    agent_id: roleId,
    origin_agent_id: roleId,
    reviewed_by: 'curated-seed',
    reviewed_at: now,
    created_at: now,
    updated_at: now,
  };
}

function buildRolePersona(spec: RoleSeedSpec, activityCount: number, now: string): PersonaDef {
  return {
    role_id: spec.role_id,
    version: 1,
    summary: spec.charter,
    skills_overview: `预置 ${activityCount} 项活动技能（corpus seed 2026-09-08），覆盖：${spec.families_zh}。`,
    experience_coverage: '预置语料种子导入，尚无运行时经验。',
    recent_performance: '等待首个任务。',
    notes: spec.boundary_zh,
    generated_at: now,
  };
}

/**
 * 预计算资产审计与向量表构建。
 *
 * 提供资产时：按 id 查找向量且校验 sha256 与当前语料一致 → 复用；任何条目
 * 缺失或过期 → 报错提示重跑 `pnpm skills:embed`（禁止静默现场向量化）。实际
 * 导入（dryRun=false）抛错中止；dry-run 只报告可复用/将报错条数，不抛错。
 * 未提供资产：返回 null 向量表，导入退回现场 embed（调用方负责 provider 维度
 * 与库一致）。
 */
async function buildEmbeddingTable(
  assets: SkillEmbeddingsManifest | null | undefined,
  activities: CorpusSkillFile[],
  dryRun: boolean,
): Promise<{ byId: Map<string, number[]>; audit: EmbeddingAssetAudit }> {
  if (!assets) {
    return {
      byId: new Map(),
      audit: { reuse: 0, stale: 0, absent: activities.length, stale_slugs: [] },
    };
  }
  const assetBySlug = new Map(assets.skills.map((entry) => [entry.slug, entry]));
  const byId = new Map<string, number[]>();
  const staleSlugs = new Set<string>();
  for (const activity of activities) {
    const entry = assetBySlug.get(activity.slug);
    if (entry === undefined || entry.sha256 !== skillContentHash(activity)) {
      staleSlugs.add(activity.slug);
    } else {
      byId.set(activity.slug, entry.vector);
    }
  }
  const stale = [...staleSlugs].sort();
  if (!dryRun && stale.length > 0) {
    throw new Error(
      `Embedding asset stale/missing for ${stale.length} skill(s): ${stale.join(', ')}. ` +
        'Re-run `pnpm skills:embed` to regenerate skills/skill-embeddings.json.',
    );
  }
  return {
    byId,
    audit: { reuse: byId.size, stale: stale.length, absent: 0, stale_slugs: stale },
  };
}

/**
 * 执行导入（幂等）。activity 技能按 uuid v5(slug) 比对：无记录 → save；
 * 内容/描述变化 → 版本 patch bump + update；无变化 → skip。语料移除 →
 * 删除（仅限基线曾登记的同名空间技能）。
 */
export async function importSkillCorpus(
  repository: MemoryRepository,
  options: CorpusImportOptions,
): Promise<CorpusImportReport> {
  const { rootDir, dryRun = false } = options;
  const files = await scanCorpus(rootDir);

  const activityByRole = new Map<CorpusRole, CorpusSkillFile[]>();
  const absorbersByHost = new Map<string, string[]>();
  for (const file of files) {
    if (file.kind === 'activity') {
      const list = activityByRole.get(file.role) ?? [];
      list.push(file);
      activityByRole.set(file.role, list);
    } else if (file.hostSlug) {
      const list = absorbersByHost.get(file.hostSlug) ?? [];
      list.push(file.slug);
      absorbersByHost.set(file.hostSlug, list);
    }
  }

  // 基线（上版已导入集合）→ 删除判定：仅当技能 id 命中"基线曾登记"且当前语料
  // 已移除时才删，运行时晋升（randomUUID）的技能永不命中。
  const baseline = await readBaselineManifest(rootDir);
  const priorIdToSlug = new Map((baseline?.skills ?? []).map((entry) => [entry.id, entry.slug]));

  const activities = files.filter((file) => file.kind === 'activity');
  const { byId: embeddingById, audit } = await buildEmbeddingTable(
    options.embeddings,
    activities,
    dryRun,
  );

  const registered = new Set(await repository.listAgentIds());
  const now = nowTimestamp();
  const report: CorpusImportReport = {
    per_role: [],
    created_role_ids: [],
    activity_total: activities.length,
    pointer_total: files.filter((file) => file.kind === 'pointer').length,
    ...(options.embeddings ? { embedding_asset: audit } : {}),
  };

  for (const spec of ROLE_ROSTER) {
    const roleActivities = (activityByRole.get(spec.role) ?? [])
      .slice()
      .sort((left, right) => left.slug.localeCompare(right.slug));
    const currentIds = new Set(roleActivities.map((activity) => slugToSkillId(activity.slug)));
    const agentExisted = registered.has(spec.role_id);

    if (!agentExisted) {
      if (!dryRun) {
        await repository.initializeAgent({
          role_id: spec.role_id,
          name: spec.name,
          tags: [...spec.tags],
          persona_seed: spec.charter,
          constraints: [...spec.constraints],
        });
      }
      report.created_role_ids.push(spec.role_id);
      registered.add(spec.role_id);
    } else if (!dryRun) {
      await repository.updateAgentMeta(spec.role_id, { name: spec.name, tags: [...spec.tags] });
    }

    const existingSkills = agentExisted ? await repository.listSkills(spec.role_id) : [];
    const existingById = new Map(existingSkills.map((skill) => [skill.id, skill]));

    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const activity of roleActivities) {
      const id = slugToSkillId(activity.slug);
      const previous = existingById.get(id);
      const changed =
        previous !== undefined &&
        (previous.content !== activity.body || previous.description !== activity.description);
      const version = previous === undefined || !changed ? '1.0.0' : bumpVersion(previous.version);
      const subSkills = (absorbersByHost.get(activity.slug) ?? []).slice().sort();
      const record = toSkillRecord(
        activity,
        spec.role_id,
        now,
        subSkills,
        version,
        embeddingById.get(activity.slug) ?? [],
      );

      if (previous === undefined) {
        if (!dryRun) {
          await repository.saveSkill(spec.role_id, record);
        }
        added += 1;
      } else if (changed) {
        if (!dryRun) {
          await repository.updateSkill(spec.role_id, record);
        }
        updated += 1;
      } else {
        skipped += 1;
      }
    }

    let removed = 0;
    for (const existing of existingSkills) {
      const priorSlug = priorIdToSlug.get(existing.id);
      if (priorSlug !== undefined && !currentIds.has(existing.id)) {
        if (!dryRun) {
          await repository.deleteSkill(spec.role_id, existing.id);
        }
        removed += 1;
      }
    }

    if (!dryRun) {
      const finalCount = (await repository.listSkills(spec.role_id)).length;
      await repository.savePersona(spec.role_id, buildRolePersona(spec, finalCount, now));
      await repository.updateMetrics(spec.role_id, (metrics) => ({
        ...metrics,
        skill_count: finalCount,
        imported_skill_count: 0,
        promoted_skill_count: 0,
      }));
    }

    report.per_role.push({
      role: spec.role,
      role_id: spec.role_id,
      activity_total: activities.length,
      added,
      updated,
      skipped,
      removed,
      agent_created: !agentExisted,
    });
  }

  return report;
}
