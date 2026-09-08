#!/usr/bin/env node
/**
 * embed-corpus — 为 skills/ 语料生成预计算向量资产 skills/skill-embeddings.json
 *
 * 在你的机器上跑一次 `pnpm skills:embed`：用现有 embedding 配置
 * （@ai-sdk/openai + EMBEDDING_API_KEY/EMBEDDING_BASE_URL/EMBEDDING_MODEL，
 * 与 src/litellm/config/embedding.yaml 的 embed task 同模型同端点）对每条活动
 * 技能的 description 调真实 embedding 模型（text-embedding-v3 @ 1024d），输出
 * 带模型/维度/端点元数据的资产清单，随仓库在分支 feat/skills-role-seed 上提交。
 * 服用方 seed 导入时直接复用这份向量（离线、确定性、不现场向量化）。
 *
 * 用法（scaffold 根目录）：
 *   pnpm skills:embed            # 全量 66 条，需 .env.local 已有 embedding 服务配置
 *   pnpm skills:embed --limit 2  # 只跑前 N 条（dry 验证维度/连通性，不落盘）
 *   pnpm skills:embed --from D:/path/to/skills
 *
 * 失败语义：任一条 embed 失败即整体失败退出（资产必须全或无，不留半份）。
 */
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const skillsRoot =
  process.argv.indexOf('--from') !== -1
    ? path.resolve(process.argv[process.argv.indexOf('--from') + 1] ?? '')
    : path.join(repoRoot, 'skills');
const limitIndex = process.argv.indexOf('--limit');
const limit = limitIndex !== -1 ? Number(process.argv[limitIndex + 1]) : undefined;

const CORPUS_ROLES = [
  'correctness',
  'maintainability',
  'performance',
  'reliability',
  'security',
];

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** uuid v5 命名空间（与 skill-corpus.slugToSkillId 一致，保证 id 与仓储记录一一对应） */
const uuidNamespace = createHash('sha1').update('newide-seed-skills:v1').digest().subarray(0, 16);

function slugToSkillId(slug) {
  const hash = createHash('sha1').update(uuidNamespace).update(slug, 'utf8').digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function skillContentHash(body, description) {
  return createHash('sha256')
    .update(body, 'utf8')
    .update('\x00', 'utf8')
    .update(description, 'utf8')
    .digest('hex');
}

/** 轻量 .env/.env.local 加载（与 litellm/client.ts loadEnvFiles 同规则，不覆盖已设变量） */
function loadEnvFiles() {
  const candidates = ['.env', path.join(repoRoot, 'src', 'memory', '.env'), '.env.local'];
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    let content;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (key && !process.env[key]) {
        process.env[key] = trimmed.slice(eqIdx + 1).trim();
      }
    }
  }
}

async function scanActivities() {
  const files = [];
  for (const role of CORPUS_ROLES) {
    const roleDir = path.join(skillsRoot, role);
    let entries;
    try {
      entries = await fs.readdir(roleDir, { withFileTypes: true });
    } catch {
      throw new Error(`Cannot read corpus role dir ${roleDir}`);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(roleDir, entry.name, 'SKILL.md');
      const raw = await fs.readFile(filePath, 'utf8');
      const match = FRONTMATTER_RE.exec(raw);
      if (!match) {
        throw new Error(`Missing frontmatter in ${filePath}`);
      }
      const parsed = parseYaml(match[1] ?? '');
      const description = String(parsed?.description ?? '');
      if (description.startsWith('Routes ')) {
        continue; // 指针不入资产不入库
      }
      files.push({
        slug: entry.name,
        role,
        description,
        body: raw.slice(match[0].length).trim(),
      });
    }
  }
  files.sort((left, right) =>
    left.role === right.role
      ? left.slug.localeCompare(right.slug)
      : left.role.localeCompare(right.role),
  );
  return files;
}

function requireEmbeddingEnv() {
  const apiKey = process.env.EMBEDDING_API_KEY;
  const baseURL = process.env.EMBEDDING_BASE_URL;
  const model = process.env.EMBEDDING_MODEL;
  if (!apiKey || !baseURL || !model) {
    throw new Error(
      'Missing embedding env: EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL must be set (see .env.local)',
    );
  }
  return { apiKey, baseURL, model };
}

async function embedAll(activities) {
  const { apiKey, baseURL, model } = requireEmbeddingEnv();
  const { createOpenAI } = await import('@ai-sdk/openai');
  const { embed } = await import('ai');
  const embeddingModel = createOpenAI({ apiKey, baseURL }).embedding(model);
  const vectors = [];
  for (const file of activities) {
    const result = await embed({ model: embeddingModel, value: file.description });
    vectors.push(result.embedding);
  }
  return { vectors, model };
}

async function main() {
  const activities = await scanActivities();
  console.log(`activities: ${activities.length}`);
  const targets = limit !== undefined ? activities.slice(0, limit) : activities;
  if (limit !== undefined) {
    console.log(`--limit ${limit}: 只验证模型/维度连通性，不落盘`);
  }

  const { vectors, model } = await embedAll(targets);
  const dimensions = vectors[0]?.length;
  for (const vector of vectors) {
    if (!vector || vector.length !== dimensions) {
      throw new Error('Inconsistent vector dimensions across corpus');
    }
  }
  console.log(`embed ok: ${vectors.length} vectors @ ${dimensions}d (model=${model})`);

  if (limit !== undefined) {
    return;
  }

  const manifest = {
    schema: 'newide-skill-embeddings/v1',
    model,
    provider: 'openai',
    base_url: process.env.EMBEDDING_BASE_URL,
    dimensions,
    created_at: new Date().toISOString(),
    embed_input: 'description',
    skills: activities.map((file, index) => ({
      slug: file.slug,
      role: file.role,
      id: slugToSkillId(file.slug),
      sha256: skillContentHash(file.body, file.description),
      vector: vectors[index],
    })),
  };

  const outputPath = path.join(skillsRoot, 'skill-embeddings.json');
  await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`wrote ${outputPath} (${manifest.skills.length} skills, ${dimensions}d, model=${model})`);
}

loadEnvFiles();
void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});