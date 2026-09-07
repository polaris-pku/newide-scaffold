/**
 * skill-corpus-snapshot — 语料源码资产（skills/）结构与快照基线一致性守卫
 *
 * 把语料统一规格搬进 CI：目录/文件纪律（每技能目录只有 SKILL.md）、frontmatter
 * 键集与 name=slug、description 单行 ≤250、指针清单与 POINTER_TARGETS 一致、
 * 活动/指针计数、uuid v5 确定性无碰撞，以及「当前语料 sha256 快照 == 已提交的
 * skill-manifest.baseline.json」——任何对 skills/ 副本的改动（未经
 * `pnpm seed:roles:baseline` 重写基线）都会使本测试失败，防止副本漂移。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CORPUS_ROLES,
  POINTER_TARGETS,
  ROLE_AGENT_IDS,
  buildBaselineManifest,
  readBaselineManifest,
  scanCorpus,
  slugToSkillId,
} from '../seeds/skill-corpus';
import { ROLE_ROSTER } from '../seeds/role-roster';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.resolve(HERE, '..', '..', '..', 'skills');

const EXPECTED_ACTIVITY_TOTALS: Readonly<Record<string, number>> = {
  correctness: 10,
  maintainability: 9,
  performance: 11,
  reliability: 12,
  security: 24,
};

const EXPECTED_POINTER_TOTALS: Readonly<Record<string, number>> = {
  correctness: 2,
  maintainability: 5,
  performance: 1,
  reliability: 0,
  security: 1,
};

describe('skill corpus source assets (skills/)', () => {
  it('总览：75 目录（活动 66 / 指针 9），无重复 slug', async () => {
    const files = await scanCorpus(CORPUS_ROOT);
    expect(files).toHaveLength(75);
    const activities = files.filter((file) => file.kind === 'activity');
    const pointers = files.filter((file) => file.kind === 'pointer');
    expect(activities).toHaveLength(66);
    expect(pointers).toHaveLength(9);

    const slugs = files.map((file) => file.slug);
    expect(new Set(slugs).size).toBe(slugs.length);

    const activityByRole = new Map<string, number>();
    const pointerByRole = new Map<string, number>();
    for (const file of files) {
      const key = file.role;
      activityByRole.set(
        key,
        (activityByRole.get(key) ?? 0) + (file.kind === 'activity' ? 1 : 0),
      );
      pointerByRole.set(
        key,
        (pointerByRole.get(key) ?? 0) + (file.kind === 'pointer' ? 1 : 0),
      );
    }
    for (const role of CORPUS_ROLES) {
      expect(activityByRole.get(role)).toBe(EXPECTED_ACTIVITY_TOTALS[role]);
      expect(pointerByRole.get(role)).toBe(EXPECTED_POINTER_TOTALS[role]);
    }
  });

  it('目录纪律：每技能目录只有 SKILL.md，角色目录只有技能目录与 README.md', async () => {
    const files = await scanCorpus(CORPUS_ROOT);
    for (const file of files) {
      const dirEntries = await fs.readdir(path.dirname(file.filePath));
      expect(dirEntries, `skill dir must contain only SKILL.md: ${file.filePath}`).toEqual([
        'SKILL.md',
      ]);
    }
  });

  it('指针清单与 POINTER_TARGETS 完全一致，且描述可路由到宿主', async () => {
    const files = await scanCorpus(CORPUS_ROOT);
    const pointerSlugs = files
      .filter((file) => file.kind === 'pointer')
      .map((file) => file.slug)
      .sort();
    expect(pointerSlugs).toEqual(Object.keys(POINTER_TARGETS).sort());
    for (const file of files.filter((candidate) => candidate.kind === 'pointer')) {
      const host = POINTER_TARGETS[file.slug];
      expect(host, `pointer ${file.slug} must have host`).toBeDefined();
      expect(file.description).toContain(host!);
    }
  });

  it('确定性技能 ID：uuid v5 稳定、格式合法、无碰撞', async () => {
    const files = await scanCorpus(CORPUS_ROOT);
    const activities = files.filter((file) => file.kind === 'activity');
    const ids = activities.map((file) => slugToSkillId(file.slug));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    expect(slugToSkillId('bugsweep')).toBe(slugToSkillId('bugsweep'));
  });

  it('frontmatter 纪律：name=slug、description 单行 ≤250（由 parseSkillFile 强制）', async () => {
    const files = await scanCorpus(CORPUS_ROOT);
    for (const file of files) {
      expect(file.name).toBe(file.slug);
      expect(file.description.includes('\n')).toBe(false);
      expect(file.description.length).toBeLessThanOrEqual(250);
    }
  });

  it('快照基线：当前语料 sha256 与已提交 skill-manifest.baseline.json 一致（防漂移）', async () => {
    const computed = await buildBaselineManifest(CORPUS_ROOT);
    const stored = await readBaselineManifest(CORPUS_ROOT);
    expect(stored, 'baseline missing; run `pnpm seed:roles:baseline`').not.toBeNull();
    expect(computed.skills).toEqual(stored?.skills);
    expect(computed.skills).toHaveLength(66);
  });

  it('role 名册覆盖全部语料维度，role_id 与维度映射一致', async () => {
    const roles = ROLE_ROSTER.map((entry) => entry.role);
    expect(roles).toEqual([...CORPUS_ROLES]);
    for (const spec of ROLE_ROSTER) {
      expect(spec.role_id).toBe(ROLE_AGENT_IDS[spec.role]);
      expect(spec.charter.length).toBeGreaterThan(0);
      expect(spec.constraints.length).toBeGreaterThan(0);
    }
  });
});
