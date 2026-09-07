#!/usr/bin/env node
/**
 * sync-skills — 把语料主源（默认 spec/skills，scaffold 的上级目录）镜像同步为
 * scaffold `skills/` 源码资产（rsync --delete 语义：目标多余文件/目录会被删除，
 * 保证 scaffold 内副本与主源逐字节一致）。
 *
 * 用法（scaffold 根目录）：
 *   pnpm skills:sync                       # 默认源：../skills
 *   node scripts/sync-skills.mjs --from D:/path/to/skills
 *
 * 同步后如有内容变化：重新执行 `pnpm seed:roles`（或 dry-run 预览），
 * 稳定后 `pnpm seed:roles:baseline` 重写快照基线并提交。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const defaultSource = path.resolve(repoRoot, '..', 'skills');
const fromIndex = process.argv.indexOf('--from');
const sourceRoot =
  fromIndex !== -1 ? path.resolve(process.argv[fromIndex + 1] ?? '') : defaultSource;
const targetRoot = path.join(repoRoot, 'skills');

let copied = 0;
let removed = 0;

/** 仅存在于 scaffold 侧、不被镜像同步覆盖/删除的本地文件（如第三方版权声明） */
const LOCAL_ONLY_FILES = new Set(['THIRD-PARTY-NOTICES.md']);

async function mirror(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  let sourceEntries;
  try {
    sourceEntries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read source skills dir ${sourceDir}: ${error.message}`);
  }
  const targetEntries = await fs.readdir(targetDir, { withFileTypes: true }).catch(() => []);
  const remaining = new Map(targetEntries.map((entry) => [entry.name, entry]));

  for (const entry of sourceEntries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await mirror(sourcePath, targetPath);
    } else if (entry.isFile()) {
      if (!LOCAL_ONLY_FILES.has(entry.name)) {
        await fs.copyFile(sourcePath, targetPath);
        copied += 1;
      } else {
        console.log(`kept local-only: ${entry.name}`);
      }
    }
    remaining.delete(entry.name);
  }

  for (const [name] of remaining) {
    if (LOCAL_ONLY_FILES.has(name)) {
      continue;
    }
    await fs.rm(path.join(targetDir, name), { recursive: true, force: true });
    removed += 1;
  }
}

async function main() {
  console.log(`source: ${sourceRoot}`);
  console.log(`target: ${targetRoot}`);
  await mirror(sourceRoot, targetRoot);
  console.log(`synced: ${copied} files copied, ${removed} stale entries removed`);
  const manifest = path.join(targetRoot, 'skill-manifest.baseline.json');
  try {
    await fs.access(manifest);
    console.log(`note: baseline exists (${manifest}); run pnpm seed:roles:baseline after content changes`);
  } catch {
    console.log('note: no baseline manifest yet; run pnpm seed:roles:baseline to generate');
  }
}

void main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
