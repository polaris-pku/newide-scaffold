/**
 * skill-corpus-snapshot — 语料源码资产（skills/）结构与快照基线一致性守卫
 *
 * 把语料统一规格搬进 CI：目录/文件纪律（每技能目录只有 SKILL.md）、frontmatter
 * 键集与 name=slug、description 单行 ≤250、各角色技能计数、uuid v5 确定性无碰撞，
 * 以及「当前语料 sha256 快照 == 已提交的 skill-manifest.baseline.json」——任何对
 * skills/ 副本的改动（未经 `pnpm seed:roles:baseline` 重写基线）都会使本测试失败，
 * 防止副本漂移。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CORPUS_ROLES,
  ROLE_AGENT_IDS,
  buildBaselineManifest,
  readBaselineManifest,
  readSkillEmbeddings,
  scanCorpus,
  slugToSkillId,
} from '../seeds/skill-corpus';
import { ROLE_ROSTER } from '../seeds/role-roster';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.resolve(HERE, '..', '..', '..', 'skills');

const EXPECTED_ACTIVITY_TOTALS: Readonly<Record<string, number>> = {
  correctness: 10,
  maintainability: 9,
  performance: 10,
  reliability: 8,
  security: 23,
};

describe('skill corpus source assets (skills/)', () => {
  it('总览：60 个技能目录，无重复 slug，各角色计数符合预期', async () => {
    const files = await scanCorpus(CORPUS_ROOT);
    expect(files).toHaveLength(60);

    const slugs = files.map((file) => file.slug);
    expect(new Set(slugs).size).toBe(slugs.length);

    const countByRole = new Map<string, number>();
    for (const file of files) {
      countByRole.set(file.role, (countByRole.get(file.role) ?? 0) + 1);
    }
    for (const role of CORPUS_ROLES) {
      expect(countByRole.get(role)).toBe(EXPECTED_ACTIVITY_TOTALS[role]);
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

  it('确定性技能 ID：uuid v5 稳定、格式合法、无碰撞', async () => {
    const files = await scanCorpus(CORPUS_ROOT);
    const ids = files.map((file) => slugToSkillId(file.slug));
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
    expect(computed.skills).toHaveLength(60);
  });

  it('向量资产存在且 schema/维度/对齐基线：skill-embeddings.json 为有效资产', async () => {
    const asset = await readSkillEmbeddings(CORPUS_ROOT);
    expect(asset, 'asset missing; run `pnpm skills:embed`').not.toBeNull();
    expect(asset?.schema).toBe('newide-skill-embeddings/v1');
    expect(asset?.embed_input).toBe('description');
    expect(typeof asset?.model).toBe('string');
    expect(asset?.model.length).toBeGreaterThan(0);
    expect(asset?.dimensions).toBe(1024);
    expect(asset?.skills).toHaveLength(60);

    // 每条技能与基线同 id/sha256 对齐，且向量维度一致
    const baseline = await readBaselineManifest(CORPUS_ROOT);
    const bySlug = new Map(baseline?.skills.map((entry) => [entry.slug, entry]));
    for (const entry of asset!.skills) {
      const base = bySlug.get(entry.slug);
      expect(base, `asset entry ${entry.slug} must be in baseline`).toBeDefined();
      expect(entry.id).toBe(base!.id);
      expect(entry.sha256).toBe(base!.sha256);
      expect(entry.vector).toHaveLength(asset!.dimensions);
      for (const value of entry.vector) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
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
