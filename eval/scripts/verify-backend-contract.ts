/**
 * Validate a backend summary.json against the eval --backend-summary contract.
 *
 * Usage:
 *   pnpm eval:verify-backend-contract -- --summary .newide/runs/<id>/summary.json
 *   pnpm eval:verify-backend-contract -- --fixture
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readBackendWorktreePath } from '../worktree-patch';

const MEMORY_ABLATIONS = new Set(['B0', 'B1', 'B2', 'B3']);

function readFlag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function verifySummary(summaryPath: string): void {
  const raw = JSON.parse(readFileSync(summaryPath, 'utf-8')) as unknown;
  if (!isRecord(raw)) {
    throw new Error('summary.json must be a JSON object');
  }
  const worktreePath = readBackendWorktreePath(summaryPath);
  const errors: string[] = [];

  if (raw.memory_ablation !== undefined) {
    if (typeof raw.memory_ablation !== 'string' || !MEMORY_ABLATIONS.has(raw.memory_ablation)) {
      errors.push(
        `memory_ablation must be one of B0|B1|B2|B3 when present (got ${String(raw.memory_ablation)})`,
      );
    }
  }

  try {
    execFileSync('git', ['-C', worktreePath, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    errors.push(
      `worktree_path "${worktreePath}" is not inside a Git repository (eval cannot collect patch)`,
    );
  }

  if (errors.length > 0) {
    throw new Error(`Backend summary contract failed:\n- ${errors.join('\n- ')}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        summary_path: path.resolve(summaryPath),
        worktree_path: worktreePath,
        memory_ablation: raw.memory_ablation ?? null,
      },
      null,
      2,
    ),
  );
}

function createFixtureSummary(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'newide-backend-contract-'));
  const repo = path.join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'eval@newide.local'], {
    cwd: repo,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'NewIDE Eval'], { cwd: repo, stdio: 'ignore' });
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  const summaryPath = path.join(dir, 'summary.json');
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        run_id: 'fixture_run',
        task_id: 'fixture_task',
        status: 'completed',
        worktree_path: repo,
        memory_ablation: 'B2',
      },
      null,
      2,
    ),
    'utf-8',
  );
  return summaryPath;
}

function main(): void {
  if (hasFlag('--fixture')) {
    const summaryPath = createFixtureSummary();
    try {
      verifySummary(summaryPath);
    } finally {
      rmSync(path.dirname(summaryPath), { recursive: true, force: true });
    }
    return;
  }

  const summaryPath = readFlag('--summary');
  if (!summaryPath) {
    console.error(
      'Usage: pnpm eval:verify-backend-contract -- --summary <summary.json>\n' +
        '       pnpm eval:verify-backend-contract -- --fixture',
    );
    process.exit(2);
  }
  verifySummary(summaryPath);
}

main();
