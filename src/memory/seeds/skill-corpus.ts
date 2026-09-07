/**
 * skill-corpus — 预置技能语料（skills/ 目录）扫描与映射
 *
 * 只读 side：扫描 `skills/<role>/<skill>/SKILL.md`，解析 frontmatter（仅
 * {name, description}，键集校验与语料规范一致）、区分活动技能 / 路由指针、
 * 解析指针指向的宿主，并提供确定性 ID（uuid v5(slug)）与内容哈希——
 * 供 import 脚本、CLI 与快照测试共用，保证 ID/版本判定跨运行一致。
 */
import { createHash } from 'node:crypto';
import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/** 语料五个质量维度目录（= role 维度，与 role-roster 一一对应） */
export const CORPUS_ROLES = [
  'correctness',
  'maintainability',
  'performance',
  'reliability',
  'security',
] as const;

export type CorpusRole = (typeof CORPUS_ROLES)[number];

/** 语料维度目录名 → 运行时 role_id（Agent 名册键） */
export const ROLE_AGENT_IDS: Readonly<Record<CorpusRole, string>> = {
  correctness: 'role_correctness',
  maintainability: 'role_maintainability',
  performance: 'role_performance',
  reliability: 'role_reliability',
  security: 'role_security',
};

/**
 * 路由指针 → 宿主技能映射（9 个指针目录，重构期并入 7 个宿主）。
 * 指针目录不生成独立 SkillRecord，其 slug 记入宿主记录的 sub_skills。
 */
export const POINTER_TARGETS: Readonly<Record<string, string>> = {
  'logic-review': 'agentic-code-reasoning',
  'harden-code': 'bugsweep',
  'anti-patterns': 'clean-code',
  'cyclomatic-complexity-refactor': 'refactoring',
  'simplify-code': 'simplify-swarm',
  cleanup: 'simplify-swarm',
  'code-humanizer': 'simplify-swarm',
  'backend-latency-profiler-helper': 'backend-performance-review',
  'anthropic-claude-code-security-review': 'code-security-audit',
};

/** 议会部署形态（bugsweep 的 H-S-R 三件套）：活动技能但标记部署形态，不并入宿主 */
export const COUNCIL_TRIO_SLUGS: ReadonlySet<string> = new Set([
  'bug-hunter-hunter',
  'bug-hunter-skeptic',
  'bug-hunter-referee',
]);

/** 语料统一规格：每技能目录只有 SKILL.md 一个文件；角色目录另有 README.md */
export const SKILL_FILE_NAME = 'SKILL.md';
export const ROLE_README_FILE_NAME = 'README.md';

/** 快照基线文件名（skills/ 下，导入后由 --write-baseline 生成并提交） */
export const BASELINE_FILE_NAME = 'skill-manifest.baseline.json';

export interface CorpusSkillFile {
  /** 目录名（= frontmatter name） */
  slug: string;
  role: CorpusRole;
  kind: 'activity' | 'pointer';
  name: string;
  description: string;
  /** frontmatter 之后的正文（含 Provenance 段），trim 后 */
  body: string;
  /** kind=pointer 时的宿主 slug（POINTER_TARGETS[slug]） */
  hostSlug?: string;
  /** SKILL.md 绝对路径（校验报错用） */
  filePath: string;
}

export interface CorpusSkillBaselineEntry {
  slug: string;
  role: CorpusRole;
  /** 确定性技能 ID（uuid v5） */
  id: string;
  /** body + description 的内容哈希（sha256 hex） */
  sha256: string;
}

export interface CorpusBaselineManifest {
  schema: 'newide-skill-baseline/v1';
  /** 仅活动技能（指针不入库） */
  skills: CorpusSkillBaselineEntry[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** uuid v5 命名空间（固定常量 → 所有 slug 的 id 跨运行/跨机器稳定） */
const NAMESPACE_NAME = 'newide-seed-skills:v1';
let cachedNamespace: Buffer | undefined;

function seedNamespace(): Buffer {
  if (!cachedNamespace) {
    cachedNamespace = createHash('sha1').update(NAMESPACE_NAME).digest().subarray(0, 16);
  }
  return cachedNamespace;
}

/** 确定性技能 ID：uuid v5(namespace, slug) */
export function slugToSkillId(slug: string): string {
  const namespace = seedNamespace();
  const hash = createHash('sha1').update(namespace).update(slug, 'utf8').digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // 版本 5 与 RFC4122 variant 位
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 活动技能内容哈希：body 与 description 任一变化都会导致版本 bump */
export function skillContentHash(skill: Pick<CorpusSkillFile, 'body' | 'description'>): string {
  return createHash('sha256')
    .update(skill.body, 'utf8')
    .update('\x00', 'utf8')
    .update(skill.description, 'utf8')
    .digest('hex');
}

/** 解析单个 SKILL.md：frontmatter 键集/name=slug/description 规则校验 */
export async function parseSkillFile(filePath: string): Promise<{
  slug: string;
  name: string;
  description: string;
  body: string;
}> {
  const raw = await fs.readFile(filePath, 'utf8');
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new Error(`Corpus violation: missing frontmatter in ${filePath}`);
  }
  const parsed = parseYaml(match[1] ?? '') as Record<string, unknown> | null;
  const name = typeof parsed?.name === 'string' ? parsed.name : undefined;
  const description = typeof parsed?.description === 'string' ? parsed.description : undefined;
  if (!name || !description) {
    throw new Error(`Corpus violation: frontmatter must have string name+description in ${filePath}`);
  }
  const slug = path.basename(path.dirname(filePath));
  if (name !== slug) {
    throw new Error(`Corpus violation: name(${name}) != dir(${slug}) in ${filePath}`);
  }
  if (Object.keys(parsed ?? {}).length !== 2) {
    throw new Error(`Corpus violation: frontmatter keyset != {name, description} in ${filePath}`);
  }
  if (description.includes('\n') || description.length > 250) {
    throw new Error(
      `Corpus violation: description must be single-line <=250 chars in ${filePath} (len=${description.length})`,
    );
  }
  if (raw.includes('](./') || raw.includes('](../') || /!\[[^\]]*\]\([^)]*\)/.test(raw)) {
    throw new Error(`Corpus violation: local link/image references forbidden in ${filePath}`);
  }
  const body = raw.slice(match[0].length).trim();
  return { slug, name, description, body };
}

/**
 * 扫描语料根目录（skills/），返回全部技能文件并做结构校验：
 * slug 全局唯一、指针均指向同角色活动宿主。
 */
export async function scanCorpus(rootDir: string): Promise<CorpusSkillFile[]> {
  const files: CorpusSkillFile[] = [];
  for (const role of CORPUS_ROLES) {
    const roleDir = path.join(rootDir, role);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(roleDir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Corpus violation: role dir missing ${roleDir}: ${String(error)}`);
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      if (entry.isDirectory()) {
        const skillDir = path.join(roleDir, entry.name);
        const filePath = path.join(skillDir, SKILL_FILE_NAME);
        const parsed = await parseSkillFile(filePath);
        const kind: CorpusSkillFile['kind'] = parsed.description.startsWith('Routes ')
          ? 'pointer'
          : 'activity';
        files.push({
          slug: parsed.slug,
          role,
          kind,
          name: parsed.name,
          description: parsed.description,
          body: parsed.body,
          ...(kind === 'pointer' ? { hostSlug: POINTER_TARGETS[parsed.slug] } : {}),
          filePath,
        });
      } else if (entry.name !== ROLE_README_FILE_NAME) {
        throw new Error(
          `Corpus violation: unexpected file in role dir ${roleDir}: ${entry.name} (only ${ROLE_README_FILE_NAME} allowed)`,
        );
      }
    }
  }

  // slug 全局唯一性 + 指针宿主存在性校验
  const seen = new Set<string>();
  const activityByRole = new Map<CorpusRole, Set<string>>();
  for (const file of files) {
    if (seen.has(file.slug)) {
      throw new Error(`Corpus violation: duplicate skill slug across roles: ${file.slug}`);
    }
    seen.add(file.slug);
    if (file.kind === 'activity') {
      const set = activityByRole.get(file.role) ?? new Set<string>();
      set.add(file.slug);
      activityByRole.set(file.role, set);
    }
  }
  for (const file of files) {
    if (file.kind === 'pointer') {
      const host = file.hostSlug;
      if (!host || !POINTER_TARGETS[file.slug]) {
        throw new Error(`Corpus violation: pointer ${file.slug} has no POINTER_TARGETS entry`);
      }
      if (!activityByRole.get(file.role)?.has(host)) {
        throw new Error(
          `Corpus violation: pointer ${file.slug} -> ${host} is not an activity skill of role ${file.role}`,
        );
      }
    }
  }
  return files;
}

/** 生成快照基线清单（仅活动技能，排序稳定） */
export async function buildBaselineManifest(rootDir: string): Promise<CorpusBaselineManifest> {
  const files = await scanCorpus(rootDir);
  const entries: CorpusSkillBaselineEntry[] = files
    .filter((file) => file.kind === 'activity')
    .map((file) => ({
      slug: file.slug,
      role: file.role,
      id: slugToSkillId(file.slug),
      sha256: skillContentHash(file),
    }))
    .sort((left, right) =>
      left.role === right.role
        ? left.slug.localeCompare(right.slug)
        : left.role.localeCompare(right.role),
    );
  return { schema: 'newide-skill-baseline/v1', skills: entries };
}

/** 读取已提交的快照基线（不存在返回 null） */
export async function readBaselineManifest(
  rootDir: string,
): Promise<CorpusBaselineManifest | null> {
  const filePath = path.join(rootDir, BASELINE_FILE_NAME);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as CorpusBaselineManifest;
  } catch {
    return null;
  }
}

/** 写入快照基线（导入完成并核对后调用） */
export async function writeBaselineManifest(rootDir: string): Promise<CorpusBaselineManifest> {
  const manifest = await buildBaselineManifest(rootDir);
  await fs.writeFile(
    path.join(rootDir, BASELINE_FILE_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return manifest;
}
