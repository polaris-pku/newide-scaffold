/**
 * recover-dataset — 从本地历史运行归档重建 v0-dask-3-prctx 的问题陈述
 *
 * 规范 jsonl `eval/data/sweevo-v0-repo-full-prctx.jsonl` 不在仓内（要 GITHUB_TOKEN +
 * `../SWE-EVO/` 才能构建）。但过去那批 SWE-EVO 消融跑把完整任务提示留在了
 * `evalResult/<arm>/<instance_id>.json` → `backend_run_id` → `state/runs/<run_id>/request.json`。
 * 本脚本沿这条链把三份 `problem_statement` 切出来，落成本地 jsonl，供 harness 用
 * `--jsonl` 指过去。
 *
 * 用法：
 *   pnpm eval:role-divergence:recover
 *   pnpm eval:role-divergence:recover -- --from evalResult --out eval/data/x.recovered.jsonl
 *
 * 同一 instance 若在多个归档里都找到，全部切一遍并**比对 sha256**：不一致即失败列出
 * 分歧，避免悄悄取到一个被截断的变体。
 */
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { getScaffoldRoot, loadDatasetSubset, loadManifest } from '../paths';
import { extractProblemStatement, PROBLEM_STATEMENT_MARKER } from './recover';

const DEFAULT_SUBSET = 'v0-dask-3-prctx';
const DEFAULT_FROM = 'evalResult';
const DEFAULT_OUT = 'eval/data/sweevo-v0-dask-3-prctx.recovered.jsonl';

/** 每个 instance 的归档记录里可能给出的 run 字段，按优先级 */
const RUN_ID_FIELDS = ['final_backend_run_id', 'backend_run_id'] as const;

/** 发现实例记录时不下探的目录：工作树与运行态占了归档体积的绝大部分 */
const PRUNE_DIRS = new Set([
  '.git',
  'node_modules',
  'worktrees',
  'state',
  'eval',
  'sweevo-work',
  'sweevo-openhands',
]);

interface InstanceRecord {
  instance_id?: string;
  repo?: string;
  base_commit?: string;
  backend_run_id?: string;
  final_backend_run_id?: string;
}

interface Candidate {
  instance_file: string;
  run_id: string;
  request_json: string;
  statement: string;
}

interface RecoveredInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  chosen: Candidate;
  candidates: Candidate[];
}

function valueOf(argv: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function relFromScaffold(target: string): string {
  const rel = path.relative(getScaffoldRoot(), target);
  return rel.startsWith('..') ? target : rel;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sectionCount(statement: string): number {
  return (statement.match(/^### /gm) ?? []).length;
}

/** 在有界深度内找出所有名为 `<instanceId>.json` 的实例记录 */
async function findInstanceFiles(
  root: string,
  instanceId: string,
  maxDepth: number,
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    const names = await fs.readdir(dir, 'utf8').catch((): string[] => []);
    for (const name of names) {
      const full = path.join(dir, name);
      const stats = await fs.stat(full).catch(() => null);
      if (stats === null) continue;
      if (stats.isDirectory()) {
        if (PRUNE_DIRS.has(name)) continue;
        await walk(full, depth + 1);
      } else if (name === `${instanceId}.json`) {
        found.push(full);
      }
    }
  };
  await walk(root, 0);
  return found.sort();
}

async function collectCandidates(instanceFile: string): Promise<Candidate[]> {
  const record = JSON.parse(await fs.readFile(instanceFile, 'utf8')) as InstanceRecord;
  const out: Candidate[] = [];
  for (const field of RUN_ID_FIELDS) {
    const runId = record[field];
    if (!runId) continue;
    const requestJson = path.join(path.dirname(instanceFile), 'state', 'runs', runId, 'request.json');
    if (!existsSync(requestJson)) continue;
    const payload = JSON.parse(await fs.readFile(requestJson, 'utf8')) as { prompt?: string };
    const statement = payload.prompt ? extractProblemStatement(payload.prompt) : undefined;
    if (statement === undefined) continue;
    out.push({ instance_file: instanceFile, run_id: runId, request_json: requestJson, statement });
  }
  return out;
}

async function recoverInstance(instanceId: string, fromRoot: string): Promise<RecoveredInstance> {
  const files = await findInstanceFiles(fromRoot, instanceId, 3);
  const candidates: Candidate[] = [];
  for (const file of files) candidates.push(...(await collectCandidates(file)));
  if (candidates.length === 0) {
    throw new Error(
      `No recoverable run archive for ${instanceId} under ${fromRoot}. ` +
        'Point --from at a directory holding prior eval snapshots, or supply the canonical jsonl.',
    );
  }

  const distinct = new Map(candidates.map((c) => [sha256(c.statement), c]));
  if (distinct.size > 1) {
    const detail = [...distinct.entries()]
      .map(([hash, c]) => `  ${hash.slice(0, 12)} chars=${String(c.statement.length)} ${relFromScaffold(c.request_json)}`)
      .join('\n');
    throw new Error(
      `Archives disagree on ${instanceId}'s problem_statement — one of them is truncated or from a ` +
        `different dataset version. Refusing to pick:\n${detail}`,
    );
  }

  const chosen = candidates[0]!;
  const record = JSON.parse(await fs.readFile(chosen.instance_file, 'utf8')) as InstanceRecord;
  return {
    instance_id: instanceId,
    repo: record.repo ?? 'unknown',
    base_commit: record.base_commit ?? '',
    problem_statement: chosen.statement,
    chosen,
    candidates,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const scaffoldRoot = getScaffoldRoot();
  const subsetId = valueOf(argv, '--subset') ?? DEFAULT_SUBSET;
  const fromRoot = path.resolve(scaffoldRoot, valueOf(argv, '--from') ?? DEFAULT_FROM);
  const outPath = path.resolve(scaffoldRoot, valueOf(argv, '--out') ?? DEFAULT_OUT);
  const instancesArg = valueOf(argv, '--instances');

  const subset = loadDatasetSubset(loadManifest(), subsetId);
  const instanceIds = instancesArg
    ? instancesArg.split(',').map((value) => value.trim())
    : subset.instance_ids;

  if (!existsSync(fromRoot)) {
    throw new Error(
      `Archive root not found: ${fromRoot}. Pass --from=<dir> pointing at prior eval snapshots ` +
        '(repo-local evalResult/ by default; gitignored, so it only exists on machines that ran the ablations).',
    );
  }

  const recovered: RecoveredInstance[] = [];
  for (const instanceId of instanceIds) recovered.push(await recoverInstance(instanceId, fromRoot));

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const jsonl = recovered
    .map((r) =>
      JSON.stringify({
        repo: r.repo,
        instance_id: r.instance_id,
        base_commit: r.base_commit,
        problem_statement: r.problem_statement,
      }),
    )
    .join('\n');
  await fs.writeFile(outPath, `${jsonl}\n`, 'utf8');

  const provenancePath = outPath.replace(/\.jsonl$/, '.provenance.json');
  await fs.writeFile(
    provenancePath,
    `${JSON.stringify(
      {
        tool: 'eval/role-divergence/recover-dataset.ts',
        generated_at: new Date().toISOString(),
        from_root: relFromScaffold(fromRoot),
        marker: PROBLEM_STATEMENT_MARKER,
        subset: subsetId,
        canonical_source_jsonl: subset.source_jsonl,
        instances: recovered.map((r) => ({
          instance_id: r.instance_id,
          sha256: sha256(r.problem_statement),
          chars: r.problem_statement.length,
          pr_sections: sectionCount(r.problem_statement),
          chosen: {
            instance_file: relFromScaffold(r.chosen.instance_file),
            run_id: r.chosen.run_id,
            request_json: relFromScaffold(r.chosen.request_json),
          },
          candidates: r.candidates.map((c) => ({
            instance_file: relFromScaffold(c.instance_file),
            run_id: c.run_id,
            sha256: sha256(c.statement),
            chars: c.statement.length,
          })),
        })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  process.stderr.write(`[recover-dataset] wrote ${relFromScaffold(outPath)}\n`);
  for (const r of recovered) {
    process.stderr.write(
      `  ${r.instance_id}: ${String(r.problem_statement.length)} chars, ` +
        `${String(sectionCount(r.problem_statement))} sections, ${String(r.candidates.length)} archive hit(s), ` +
        `sha256 ${sha256(r.problem_statement).slice(0, 12)}\n`,
    );
  }
  process.stderr.write(`[recover-dataset] provenance ${relFromScaffold(provenancePath)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
