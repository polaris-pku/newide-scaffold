/**
 * seed-roles — 导入预置技能语料并构建 5 个质量维度 role agent
 *
 * 复用生产 composition（createProductionBRuntime：NEWIDE_B_DATABASE_URL →
 * 外部 PostgreSQL，否则嵌入式 PGlite），把 scaffold `skills/` 语料导入同一
 * 存储：5 个 role agent（role_correctness … role_security）各持有本维度活动
 * 技能（10/9/11/12/24），写入 PersonaDef v1；幂等可重复执行。
 *
 * 用法（scaffold 根目录）：
 *   pnpm seed:roles                 # 真跑并打印报告 + 逐角色校验
 *   pnpm seed:roles:dry             # dry-run，只出计划不动库
 *   pnpm seed:roles:baseline        # 导入后重写 skills/skill-manifest.baseline.json
 *   NEWIDE_B_EMBEDDING_PROVIDER=hash pnpm seed:roles   # 离线确定性向量
 *
 * 注意：与后端共享同一存储时，embedding provider/dimensions 必须一致
 * （默认同 resolveProductionEmbedding；脚本仅在未设置时兜底为 hash）。
 */
import path from 'node:path';
import { createProductionBRuntime } from '../src/app/production-b-runtime';
import {
  ROLE_ROSTER,
  importSkillCorpus,
  scanCorpus,
  slugToSkillId,
  writeBaselineManifest,
  type CorpusRole,
} from '../src/memory';

interface CliOptions {
  dryRun: boolean;
  writeBaseline: boolean;
  rootDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  const dryRun = argv.includes('--dry-run');
  const writeBaseline = argv.includes('--write-baseline');
  const rootIndex = argv.indexOf('--root');
  const rootDir = rootIndex !== -1 ? argv[rootIndex + 1] ?? process.cwd() : process.cwd();
  return { dryRun, writeBaseline, rootDir };
}

function roleOfAgentId(roleId: string): CorpusRole | undefined {
  return ROLE_ROSTER.find((entry) => entry.role_id === roleId)?.role;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  // 未显式配置时兜底 hash embedding：离线、确定性，避免依赖外部 embedding 服务
  process.env.NEWIDE_B_EMBEDDING_PROVIDER ??= 'hash';

  const repoRoot = path.resolve(options.rootDir);
  const skillsDir = path.join(repoRoot, 'skills');
  const runtime = await createProductionBRuntime(process.env, { repoRoot });
  try {
    const report = await importSkillCorpus(runtime.repository, {
      rootDir: skillsDir,
      dryRun: options.dryRun,
    });

    if (!options.dryRun) {
      for (const roleId of report.created_role_ids) {
        await runtime.bufferRepository.ensureAgent(roleId);
      }
      if (options.writeBaseline) {
        await writeBaselineManifest(skillsDir);
      }
    }

    console.log(
      JSON.stringify(
        {
          mode: options.dryRun ? 'dry-run' : 'apply',
          repo_root: repoRoot,
          skills_dir: skillsDir,
          activity_total: report.activity_total,
          pointer_total: report.pointer_total,
          created_role_ids: report.created_role_ids,
          per_role: report.per_role,
          ...(options.writeBaseline && !options.dryRun
            ? { baseline: 'skills/skill-manifest.baseline.json rewritten' }
            : {}),
        },
        null,
        2,
      ),
    );

    if (!options.dryRun) {
      // 验收：语料每个活动技能的确定性 id 都已在对应 role agent 落库（子集覆盖，
      // 不约束该 agent 后续运行时晋升产生的额外技能）。
      const corpusFiles = await scanCorpus(skillsDir);
      let failed = false;
      for (const spec of ROLE_ROSTER) {
        const expectedIds = new Set(
          corpusFiles
            .filter(
              (file) => file.role === spec.role && file.kind === 'activity',
            )
            .map((file) => slugToSkillId(file.slug)),
        );
        const actualIds = new Set(
          (await runtime.repository.listSkills(spec.role_id)).map((skill) => skill.id),
        );
        const missing = [...expectedIds].filter((id) => !actualIds.has(id));
        const ok = missing.length === 0;
        console.log(
          `${ok ? 'OK  ' : 'FAIL'} ${spec.role_id}: expected=${expectedIds.size} actual=${actualIds.size}${
            missing.length > 0 ? ` missing=${missing.join(',')}` : ''
          }`,
        );
        if (!ok) {
          failed = true;
        }
      }
      if (failed) {
        process.exitCode = 1;
      }
      const roleAgentIds = (await runtime.repository.listAgentIds())
        .filter((roleId) => roleOfAgentId(roleId) !== undefined)
        .sort();
      console.log(`role agents registered: ${roleAgentIds.join(', ')}`);
    }
  } finally {
    await runtime.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
