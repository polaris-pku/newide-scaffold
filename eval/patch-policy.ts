import path from 'node:path';

const PROTECTED_BASENAMES = new Set([
  '.coveragerc',
  'conftest.py',
  'jest.config.js',
  'jest.config.cjs',
  'jest.config.mjs',
  'jest.config.ts',
  'noxfile.py',
  'pyproject.toml',
  'pytest.ini',
  'setup.cfg',
  'tox.ini',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.ts',
]);

const PROTECTED_COMPONENTS = new Set([
  '__tests__',
  'integration_tests',
  'test',
  'tests',
  'testing',
]);

/**
 * Test and runner configuration changes are not valid model output in SWE-EVO.
 * The authoritative evaluator owns those files and injects its hidden test patch.
 */
export function isProtectedEvalPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^(?:a|b)\//, '');
  const basename = path.posix.basename(normalized).toLowerCase();
  const components = normalized
    .toLowerCase()
    .split('/')
    .filter(Boolean);

  if (PROTECTED_BASENAMES.has(basename)) return true;
  if (components.some((component) => PROTECTED_COMPONENTS.has(component))) return true;
  if (/^test_.+\.py$/i.test(basename) || /_test\.py$/i.test(basename)) return true;
  if (/\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(basename)) return true;
  return false;
}

export function assertNoProtectedEvalPaths(filePaths: Iterable<string>): void {
  const protectedPaths = [...new Set([...filePaths].filter(isProtectedEvalPath))].sort();
  if (protectedPaths.length === 0) return;
  throw new Error(
    [
      'Rejected SWE-EVO candidate: model output modifies protected tests or test-runner configuration.',
      `Protected paths: ${protectedPaths.join(', ')}`,
      'Only production-code changes are accepted; hidden tests are owned by the evaluator.',
    ].join(' '),
  );
}

/**
 * Extract paths from a git-generated unified diff. Worktree collection performs
 * a second, NUL-delimited name check, so this parser is primarily for --patch-file.
 */
export function extractPatchPaths(patchText: string): string[] {
  const paths = new Set<string>();
  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(line);
      if (match) {
        addPatchPath(paths, match[1]!);
        addPatchPath(paths, match[2]!);
      }
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const raw = line.slice(4).split('\t', 1)[0]!.trim();
      if (raw !== '/dev/null') addPatchPath(paths, raw);
    }
  }
  return [...paths];
}

export function assertSafeCandidatePatch(patchText: string): void {
  assertNoProtectedEvalPaths(extractPatchPaths(patchText));
}

function addPatchPath(paths: Set<string>, rawPath: string): void {
  let decoded = rawPath;
  if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
    try {
      decoded = JSON.parse(rawPath) as string;
    } catch {
      decoded = rawPath.slice(1, -1);
    }
  }
  decoded = decoded.replace(/^(?:a|b)\//, '');
  if (decoded && decoded !== '/dev/null') paths.add(decoded);
}
