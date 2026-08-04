/**
 * Offline SWE-EVO PR/Issue body cache (paper Appendix N.1 style).
 *
 * Fetches GitHub PR/Issue *bodies* only (never dataset patch_without_test),
 * writes a resume-friendly cache, then emits an augmented JSONL where
 * problem_statement = release_note + "### PR|Issue N:" sections.
 *
 * Usage:
 *   pnpm eval:build-pr-context -- --subset v0-repo-full
 *   pnpm eval:build-pr-context -- --subset v0-repo-full --out-jsonl eval/data/sweevo-v0-repo-full-prctx.jsonl
 *
 * Auth: set GITHUB_TOKEN or GH_TOKEN (recommended). Without a token, GitHub
 * allows ~60 unauthenticated requests/hour.
 */
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { getInstanceOrThrow, indexDatasetById, loadDataset } from '../load-dataset';
import { loadDatasetSubset, loadManifest, resolveDatasetJsonl, getScaffoldRoot } from '../paths';

interface GhRef {
  owner: string;
  repo: string;
  kind: 'pull' | 'issues';
  number: number;
  url: string;
}

interface CachedBody {
  url: string;
  owner: string;
  repo: string;
  kind: 'pull' | 'issues';
  number: number;
  title: string;
  body: string;
  fetched_at: string;
  status: 'ok' | 'missing' | 'error';
  error?: string;
}

const URL_RE =
  /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/g;
/** Plain (#123) / #123 and Sphinx-style (:pr:`123`) / (:issue:`123`). */
const SHORT_RE = /\(#(\d+)\)|#(\d+)\b/g;
const SPHINX_RE = /\(:?(pr|issue|pull):`(\d+)`\)/gi;

function readFlag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

function loadEnvFiles(repoRoot: string): void {
  for (const rel of ['.env', '.env.local']) {
    const p = path.join(repoRoot, rel);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1]!;
      let val = m[2]!;
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      process.env[key] ??= val;
    }
  }
}

function githubToken(): string | undefined {
  return (
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    process.env.GITHUB_PAT?.trim() ||
    undefined
  );
}

function cacheKey(ref: GhRef): string {
  return `${ref.owner}__${ref.repo}__${ref.kind}__${ref.number}`;
}

function collectRefs(problemStatement: string, defaultRepo: string): Map<string, GhRef> {
  const out = new Map<string, GhRef>();
  const text = problemStatement ?? '';

  for (const m of text.matchAll(URL_RE)) {
    const owner = m[1]!;
    const repo = m[2]!;
    const kind = (m[3] === 'pull' ? 'pull' : 'issues') as 'pull' | 'issues';
    const number = Number(m[4]);
    const ref: GhRef = {
      owner,
      repo,
      kind,
      number,
      url: `https://github.com/${owner}/${repo}/${kind === 'pull' ? 'pull' : 'issues'}/${number}`,
    };
    out.set(cacheKey(ref), ref);
  }

  const [defOwner, defName] = defaultRepo.split('/');
  if (defOwner && defName) {
    const addDefault = (number: number, kindHint?: 'pull' | 'issues') => {
      if (!Number.isFinite(number) || number <= 0) return;
      const kind = kindHint ?? 'issues';
      const ref: GhRef = {
        owner: defOwner,
        repo: defName,
        kind,
        number,
        url: `https://github.com/${defOwner}/${defName}/${kind === 'pull' ? 'pull' : 'issues'}/${number}`,
      };
      const key = cacheKey(ref);
      const altKey = `${defOwner}__${defName}__${kind === 'pull' ? 'issues' : 'pull'}__${number}`;
      if (!out.has(key) && !out.has(altKey)) {
        out.set(key, ref);
      }
    };
    for (const m of text.matchAll(SHORT_RE)) {
      addDefault(Number(m[1] || m[2]));
    }
    for (const m of text.matchAll(SPHINX_RE)) {
      const kindRaw = (m[1] || '').toLowerCase();
      const kind = kindRaw === 'issue' ? 'issues' : 'pull';
      addDefault(Number(m[2]), kind);
    }
  }

  return out;
}

function addRefsFromPrMeta(prs: unknown, into: Map<string, GhRef>): void {
  if (!Array.isArray(prs)) return;
  for (const p of prs) {
    if (!p || typeof p !== 'object') continue;
    const row = p as Record<string, unknown>;
    const raw = String(row.pr_url || row.pr_link || '');
    const m = raw.match(
      /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/,
    );
    if (!m) continue;
    const kind = (m[3] === 'pull' ? 'pull' : 'issues') as 'pull' | 'issues';
    const ref: GhRef = {
      owner: m[1]!,
      repo: m[2]!,
      kind,
      number: Number(m[4]),
      url: `https://github.com/${m[1]}/${m[2]}/${kind === 'pull' ? 'pull' : 'issues'}/${m[4]}`,
    };
    into.set(cacheKey(ref), ref);
  }
}

async function fetchGithubBody(ref: GhRef, token?: string): Promise<CachedBody> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'newide-sweevo-pr-context',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const endpoints =
    ref.kind === 'pull'
      ? [
          `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
          `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`,
        ]
      : [
          `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`,
          `https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
        ];

  let lastError = 'unknown';
  for (const apiUrl of endpoints) {
    const res = await fetch(apiUrl, { headers });
    if (res.status === 404) {
      lastError = '404';
      continue;
    }
    if (res.status === 403 || res.status === 429) {
      const reset = res.headers.get('x-ratelimit-reset');
      const remaining = res.headers.get('x-ratelimit-remaining');
      throw new Error(
        `GitHub rate limited (status=${res.status}, remaining=${remaining ?? '?'}, reset=${reset ?? '?'})`,
      );
    }
    if (!res.ok) {
      lastError = `HTTP ${res.status}`;
      continue;
    }
    const json = (await res.json()) as { title?: string; body?: string | null };
    return {
      url: ref.url,
      owner: ref.owner,
      repo: ref.repo,
      kind: apiUrl.includes('/pulls/') ? 'pull' : 'issues',
      number: ref.number,
      title: (json.title ?? '').trim(),
      body: (json.body ?? '').trim(),
      fetched_at: new Date().toISOString(),
      status: 'ok',
    };
  }

  return {
    url: ref.url,
    owner: ref.owner,
    repo: ref.repo,
    kind: ref.kind,
    number: ref.number,
    title: '',
    body: '',
    fetched_at: new Date().toISOString(),
    status: lastError === '404' ? 'missing' : 'error',
    error: lastError,
  };
}

function formatSection(entry: CachedBody): string {
  const label = entry.kind === 'pull' ? 'PR' : 'Issue';
  const title = entry.title ? ` ${entry.title}` : '';
  const body = entry.body || '(no description body on GitHub)';
  return `### ${label} ${entry.number}:${title}\n${body}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const repoRoot = getScaffoldRoot();
  loadEnvFiles(repoRoot);
  loadEnvFiles(path.resolve(repoRoot, '..', 'acp-client-prototype'));

  const subsetId = readFlag('--subset') ?? 'v0-repo-full';
  const outJsonlRel =
    readFlag('--out-jsonl') ?? `eval/data/sweevo-${subsetId}-prctx.jsonl`;
  const cacheDirRel = readFlag('--cache-dir') ?? 'eval/data/pr-issue-cache';
  const cacheDir = path.resolve(repoRoot, cacheDirRel);
  const outJsonl = path.resolve(repoRoot, outJsonlRel);
  const token = githubToken();

  const manifest = loadManifest();
  const subset = loadDatasetSubset(manifest, subsetId);
  const datasetPath = resolveDatasetJsonl(manifest, subset.source_jsonl);
  const instancesById = indexDatasetById(await loadDataset(datasetPath));

  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(path.dirname(outJsonl), { recursive: true });

  const allRefs = new Map<string, GhRef>();
  const perInstance = new Map<string, GhRef[]>();
  for (const id of subset.instance_ids) {
    const inst = getInstanceOrThrow(instancesById, id) as unknown as Record<string, unknown>;
    const refMap = collectRefs(String(inst.problem_statement ?? ''), String(inst.repo ?? ''));
    addRefsFromPrMeta(inst.PRs, refMap);
    const refs = [...refMap.values()];
    perInstance.set(id, refs);
    for (const ref of refs) allRefs.set(cacheKey(ref), ref);
  }

  console.log(
    `[pr-context] subset=${subsetId} instances=${subset.instance_ids.length} unique_refs=${allRefs.size} token=${token ? 'yes' : 'no'}`,
  );

  const delayMs = token ? 250 : 65_000; // anonymous ~60 req/hr
  let fetched = 0;
  let cachedHits = 0;
  let failures = 0;

  for (const ref of allRefs.values()) {
    const file = path.join(cacheDir, `${cacheKey(ref)}.json`);
    if (existsSync(file)) {
      cachedHits += 1;
      continue;
    }
    try {
      const body = await fetchGithubBody(ref, token);
      await fs.writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf-8');
      fetched += 1;
      if (body.status !== 'ok') failures += 1;
      console.log(
        `[pr-context] ${body.status} ${ref.url}${body.title ? ` — ${body.title.slice(0, 80)}` : ''}`,
      );
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pr-context] ERROR ${ref.url}: ${message}`);
      if (/rate limited/i.test(message)) {
        console.error('[pr-context] stopping early due to rate limit; re-run to resume from cache');
        break;
      }
    }
    await sleep(delayMs);
  }

  // Build augmented JSONL (only for subset instances; preserve other fields).
  const lines: string[] = [];
  const summaryRows: Array<Record<string, unknown>> = [];
  for (const id of subset.instance_ids) {
    const inst = getInstanceOrThrow(instancesById, id) as unknown as Record<string, unknown>;
    const refs = perInstance.get(id) ?? [];
    const sections: string[] = [];
    let ok = 0;
    let missing = 0;
    for (const ref of refs) {
      const file = path.join(cacheDir, `${cacheKey(ref)}.json`);
      if (!existsSync(file)) {
        missing += 1;
        continue;
      }
      const entry = JSON.parse(await fs.readFile(file, 'utf-8')) as CachedBody;
      if (entry.status === 'ok') {
        sections.push(formatSection(entry));
        ok += 1;
      } else {
        missing += 1;
      }
    }
    const releaseNote = String(inst.problem_statement ?? '');
    const augmented =
      sections.length > 0 ? `${releaseNote}\n\n${sections.join('\n\n')}` : releaseNote;
    const out = {
      ...inst,
      problem_statement: augmented,
      problem_statement_release_note: releaseNote,
      pr_issue_context_count: ok,
      pr_issue_context_missing: missing,
      problem_statement_mode: sections.length > 0 ? 'release_note_plus_pr_issue' : 'release_note_only',
    };
    // Never persist gold-ish patches into the prompt-facing file.
    if ('PRs' in out) {
      const prs = Array.isArray(out.PRs) ? out.PRs : [];
      out.PRs = prs.map((p) => {
        if (!p || typeof p !== 'object') return p;
        const copy = { ...(p as Record<string, unknown>) };
        delete copy.patch_without_test;
        delete copy.test_patch;
        return copy;
      });
    }
    lines.push(JSON.stringify(out));
    summaryRows.push({
      instance_id: id,
      refs: refs.length,
      context_ok: ok,
      context_missing: missing,
      mode: out.problem_statement_mode,
    });
  }

  await fs.writeFile(outJsonl, `${lines.join('\n')}\n`, 'utf-8');
  const summaryPath = path.join(
    path.dirname(outJsonl),
    `${path.basename(outJsonl, '.jsonl')}.summary.json`,
  );
  await fs.writeFile(
    summaryPath,
    `${JSON.stringify(
      {
        subset_id: subsetId,
        source_jsonl: datasetPath,
        out_jsonl: outJsonl,
        cache_dir: cacheDir,
        unique_refs: allRefs.size,
        fetched_this_run: fetched,
        cache_hits: cachedHits,
        failures,
        auth: token ? 'token' : 'anonymous',
        instances: summaryRows,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );

  console.log(`[pr-context] wrote ${outJsonl}`);
  console.log(`[pr-context] summary ${summaryPath}`);
  console.log(
    `[pr-context] done fetched=${fetched} cache_hits=${cachedHits} failures=${failures}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
