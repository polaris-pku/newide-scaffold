import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const repoRoot = process.cwd();
const outputFile = path.join(repoRoot, 'dist', 'newide.mjs');
const configTarget = path.join(repoRoot, 'dist', 'config');

await mkdir(path.dirname(outputFile), { recursive: true });
await build({
  entryPoints: [path.join(repoRoot, 'src', 'cli', 'newide.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  outfile: outputFile,
});
await rm(configTarget, { recursive: true, force: true });
await cp(path.join(repoRoot, 'src', 'litellm', 'config'), configTarget, {
  recursive: true,
});
await chmod(outputFile, 0o755);
