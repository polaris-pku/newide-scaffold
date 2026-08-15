#!/usr/bin/env node
/**
 * Explicit (optional) pre-warm for SWE repo mirrors.
 * Prefer lazy ensure inside eval:sweevo-ablation — do not pre-cache whole subsets by default.
 *
 * Usage:
 *   pnpm eval:ensure-mirrors -- --instance-id conan-io__conan_2.0.14_2.0.15
 *   pnpm eval:ensure-mirrors -- --subset v0-smoke --instance-id conan-io__conan_2.0.14_2.0.15
 *   pnpm eval:ensure-mirrors -- --repo conan-io/conan --base-commit <sha>
 */
import { ensureRepoMirror, resolveMirrorsRoot } from '../ensure-repo-mirror';
import { getInstanceOrThrow, indexDatasetById, loadDataset } from '../load-dataset';
import { loadDatasetSubset, loadManifest, resolveDatasetJsonl } from '../paths';

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const mirrorsRoot = resolveMirrorsRoot(readFlag('--mirrors-root'));
  const repoFlag = readFlag('--repo');
  const baseCommitFlag = readFlag('--base-commit');
  const instanceId = readFlag('--instance-id');
  const subsetId = readFlag('--subset') ?? 'v0-smoke';

  console.log(`[ensure-mirrors] root=${mirrorsRoot}`);

  if (repoFlag && baseCommitFlag) {
    const ensured = await ensureRepoMirror({
      repo: repoFlag,
      baseCommit: baseCommitFlag,
      mirrorsRoot,
    });
    console.log(
      `[ensure-mirrors] ${ensured.repo} -> ${ensured.mirrorPath} (cloned=${String(ensured.cloned)})`,
    );
    return;
  }

  if (!instanceId) {
    console.error(
      [
        'Usage: pnpm eval:ensure-mirrors -- --instance-id <id> [--subset v0-smoke]',
        '   or: pnpm eval:ensure-mirrors -- --repo owner/name --base-commit <sha>',
        'Mirrors default to .newide/eval-mirrors (NEWIDE_SWE_MIRRORS_ROOT overrides it).',
        'Do not pass a whole subset without --instance-id — that would pull every repo.',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  const manifest = loadManifest();
  const subset = loadDatasetSubset(manifest, subsetId);
  const datasetPath = resolveDatasetJsonl(manifest, subset.source_jsonl);
  const instances = indexDatasetById(await loadDataset(datasetPath));
  const instance = getInstanceOrThrow(instances, instanceId);

  const ensured = await ensureRepoMirror({
    repo: instance.repo,
    baseCommit: instance.base_commit,
    mirrorsRoot,
  });
  console.log(
    `[ensure-mirrors] ${instance.instance_id} repo=${ensured.repo} -> ${ensured.mirrorPath} (cloned=${String(ensured.cloned)})`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
