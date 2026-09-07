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
  slugToSkillId,
  type CorpusRole,
  type CorpusSkillFile,
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
): SkillRecord {
  return {
    id: slugToSkillId(skill.slug),
    description: skill.description,
    description_embedding: [],
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

  const registered = new Set(await repository.listAgentIds());
  const now = nowTimestamp();
  const report: CorpusImportReport = {
    per_role: [],
    created_role_ids: [],
    activity_total: files.filter((file) => file.kind === 'activity').length,
    pointer_total: files.filter((file) => file.kind === 'pointer').length,
  };

  for (const spec of ROLE_ROSTER) {
    const activities = (activityByRole.get(spec.role) ?? [])
      .slice()
      .sort((left, right) => left.slug.localeCompare(right.slug));
    const currentIds = new Set(activities.map((activity) => slugToSkillId(activity.slug)));
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
    for (const activity of activities) {
      const id = slugToSkillId(activity.slug);
      const previous = existingById.get(id);
      const changed =
        previous !== undefined &&
        (previous.content !== activity.body || previous.description !== activity.description);
      const version = previous === undefined || !changed ? '1.0.0' : bumpVersion(previous.version);
      const subSkills = (absorbersByHost.get(activity.slug) ?? []).slice().sort();
      const record = toSkillRecord(activity, spec.role_id, now, subSkills, version);

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
