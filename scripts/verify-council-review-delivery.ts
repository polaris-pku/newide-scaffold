#!/usr/bin/env node
/**
 * Council review-delivery gate over an ablation experiment dir.
 *
 * Guards the failure mode seen in the 2026-09-20 A3 batch: the reviewer's
 * structured payload never reached the synthesizer, the recorded verdict was
 * the fallback template ("Reviewer did not return a valid structured review
 * for this proposal."), and the run was still scored. A run like that measures
 * neither "council with review" nor "council without review", so it must not
 * enter a comparison unnoticed.
 *
 * For every instance of every council arm it checks four links:
 *   review  the verdict recorded in council.review.completed is substantive
 *   ids     the reviewer's review_ids reached synthesis.input_review_ids
 *   plan    the synthesized final plan absorbed the review, not the template
 *   impl    implementation consumed that synthesized plan
 *
 * Exits non-zero when any reachable instance fails, so the batch can be
 * re-run (or the instance excluded) before grading.
 *
 * Usage:
 *   pnpm tsx scripts/verify-council-review-delivery.ts -- --experiment-dir <dir> [--arm B0]
 */
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getScaffoldRoot } from '../eval/paths';
import { councilRunDirName } from '../src/council/council-workspace';

/** The two reasons `buildReviews` writes when no structured review was parsed. */
const REVIEW_FALLBACK = /did not return a valid structured review/i;
const REVIEWER_FAILED = /Reviewer execution failed;\s*proposal remains unverified/i;
/** A real review carries a substantive rationale; the templates are one sentence. */
const MIN_REASON_LENGTH = 120;

const ABLATION_ARMS = ['B0', 'B1', 'B2', 'B3', 'B4'] as const;

type ReviewState = 'substantive' | 'void' | 'missing' | 'n/a';
type PlanState = 'absorbed' | 'quotes-template' | 'unconfirmed' | 'not-found';
type Verdict = 'PASS' | 'FAIL' | 'PARTIAL' | 'N/A';

interface InstanceCheck {
  instance_id: string;
  run_id: string | undefined;
  review: ReviewState;
  ids: boolean | undefined;
  plan: PlanState;
  impl: boolean | undefined;
  verdict: Verdict;
  notes: string[];
}

interface CouncilEvent {
  event_type?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

const repoRoot = getScaffoldRoot();
const experimentDir = resolve(repoRoot, requireFlag('--experiment-dir'));
if (!existsSync(experimentDir)) throw new Error(`experiment dir not found: ${experimentDir}`);
const armFilter = readFlag('--arm');

const arms = ABLATION_ARMS.filter(
  (arm) =>
    (!armFilter || arm === armFilter) && existsSync(join(experimentDir, arm, 'arm-summary.json')),
);
if (arms.length === 0) throw new Error(`No arm-summary.json under ${experimentDir}`);

const checks: InstanceCheck[] = [];
for (const arm of arms) {
  const armDir = join(experimentDir, arm);
  const armSummary = JSON.parse(readFileSync(join(armDir, 'arm-summary.json'), 'utf8')) as {
    state_root?: string;
  };
  // Archived batches record the recording machine's absolute state_root; the
  // arm-local copy is what is actually on disk here, so prefer it when present.
  const armLocalState = join(armDir, 'state');
  const stateRoot = existsSync(join(armLocalState, 'runs'))
    ? armLocalState
    : resolve(armDir, armSummary.state_root ?? 'state');
  const records = (await fs.readdir(armDir)).filter(
    (name) => name.endsWith('.json') && name !== 'arm-summary.json',
  );
  for (const record of records) {
    const row = JSON.parse(await fs.readFile(join(armDir, record), 'utf8')) as Record<
      string,
      unknown
    >;
    const instanceId = String(row.instance_id ?? record.replace(/\.json$/, ''));
    checks.push(
      await checkInstance(instanceId, row, stateRoot),
    );
  }
}

for (const check of checks) {
  const detail = [
    `review=${check.review}`,
    `ids=${formatBool(check.ids)}`,
    `plan=${check.plan}`,
    `impl=${formatBool(check.impl)}`,
  ].join(' ');
  log(`${check.verdict.padEnd(7)} ${check.instance_id.padEnd(36)} ${detail}`);
  for (const note of check.notes) log(`        ${note}`);
}

const failed = checks.filter((check) => check.verdict === 'FAIL');
const partial = checks.filter((check) => check.verdict === 'PARTIAL');
const passed = checks.filter((check) => check.verdict === 'PASS');
log('');
log(
  `instances=${String(checks.length)} pass=${String(passed.length)} ` +
    `partial=${String(partial.length)} fail=${String(failed.length)}`,
);
if (failed.length > 0) {
  log(`FAILED: ${failed.map((check) => check.instance_id).join(', ')}`);
  log('Do not grade these runs: the review layer was void or never reached the synthesizer.');
  process.exitCode = 1;
} else if (partial.length > 0) {
  log(
    `PARTIAL (review reached synthesis, plan citation unconfirmed): ` +
      `${partial.map((check) => check.instance_id).join(', ')}`,
  );
}

async function checkInstance(
  instanceId: string,
  row: Record<string, unknown>,
  stateRoot: string,
): Promise<InstanceCheck> {
  const runId = String(row.final_backend_run_id ?? row.backend_run_id ?? '') || undefined;
  const check: InstanceCheck = {
    instance_id: instanceId,
    run_id: runId,
    review: 'n/a',
    ids: undefined,
    plan: 'not-found',
    impl: undefined,
    verdict: 'N/A',
    notes: [],
  };
  if (!runId) {
    check.notes.push('record carries no backend_run_id');
    return check;
  }
  const auditPath = join(stateRoot, 'runs', runId, 'audit.jsonl');
  const audit = await fs.readFile(auditPath, 'utf8').catch(() => null);
  if (!audit) {
    check.notes.push(`no audit.jsonl at ${auditPath}`);
    return check;
  }
  const events: CouncilEvent[] = [];
  for (const line of audit.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as CouncilEvent);
    } catch {
      // truncated tail line
    }
  }
  const typeOf = (event: CouncilEvent): string => event.event_type ?? event.type ?? '';
  if (!events.some((event) => typeOf(event) === 'council.started')) {
    check.review = 'n/a';
    check.verdict = 'N/A';
    check.notes.push('run never entered Council');
    return check;
  }

  const reviewEvent = lastOf(events, typeOf, 'council.review.completed');
  const synthesisEvent = lastOf(events, typeOf, 'council.synthesis.completed');
  const implEvent = lastOf(events, typeOf, 'council.implementation.completed');

  const reviews = (reviewEvent?.payload?.reviews as Record<string, unknown>[] | undefined) ?? [];
  const reviewIds = (reviewEvent?.payload?.review_ids as string[] | undefined) ?? [];
  const roleFailures = events
    .filter((event) => typeOf(event) === 'council.role.failed')
    .filter((event) => event.payload?.phase === 'review');

  if (!reviewEvent || reviews.length === 0) {
    check.review = 'missing';
    check.notes.push('no council.review.completed event with reviews');
  } else if (
    reviews.some(
      (review) =>
        REVIEW_FALLBACK.test(String(review.reason ?? '')) ||
        REVIEWER_FAILED.test(String(review.reason ?? '')) ||
        ((review.unmet_criteria as string[] | undefined) ?? []).includes('structured_review'),
    )
  ) {
    check.review = 'void';
    check.notes.push('recorded verdict is the fallback template, not a real review');
  } else if (
    reviews.every(
      (review) =>
        String(review.reason ?? '').length >= MIN_REASON_LENGTH &&
        ((review.evidence_refs as string[] | undefined) ?? []).length > 0,
    )
  ) {
    check.review = 'substantive';
  } else {
    check.review = 'void';
    check.notes.push('review rationale is too thin to be a real verdict');
  }
  for (const failure of roleFailures) {
    check.notes.push(`council.role.failed(phase=review) fallback=${String(failure.payload?.fallback_action ?? '')}`);
  }

  const synthesis = synthesisEvent?.payload?.synthesis as
    | { input_review_ids?: string[]; artifact_refs?: string[] }
    | undefined;
  const synthesisRefs = synthesis?.artifact_refs ?? [];
  if (synthesis && reviewIds.length > 0) {
    const received = synthesis.input_review_ids ?? [];
    check.ids =
      received.length === reviewIds.length && reviewIds.every((id) => received.includes(id));
    if (!check.ids) {
      check.notes.push(`synthesis received [${received.join(', ')}] but reviewer produced [${reviewIds.join(', ')}]`);
    }
  } else if (!synthesis) {
    check.notes.push('no council.synthesis.completed event');
  }

  const implRefs = (implEvent?.payload?.final_plan_artifact_refs as string[] | undefined) ?? [];
  if (implRefs.length > 0) {
    check.impl = synthesisRefs.length > 0 && implRefs.every((ref) => synthesisRefs.includes(ref));
    if (!check.impl) check.notes.push(`implementation plan refs [${implRefs.join(', ')}] are not the synthesis artifact`);
  } else if (!implEvent) {
    check.notes.push('no council.implementation.completed event');
  }

  check.plan = await readPlanState(stateRoot, runId, implRefs.length > 0 ? implRefs : synthesisRefs, reviewIds);
  if (check.plan === 'quotes-template') {
    check.notes.push('the synthesized plan quotes the review fallback template');
  }
  if (check.plan === 'not-found') check.notes.push('synthesized final-plan.md not found on disk');

  if (
    check.review === 'void' ||
    check.review === 'missing' ||
    check.ids === false ||
    check.impl === false ||
    check.plan === 'quotes-template'
  ) {
    check.verdict = 'FAIL';
  } else if (check.plan === 'unconfirmed' || check.plan === 'not-found') {
    check.verdict = 'PARTIAL';
  } else {
    check.verdict = 'PASS';
  }
  return check;
}

/**
 * Locate the synthesized plan and decide whether it absorbed the review.
 * The artifact directory is keyed by artifact id, so the implementation's own
 * reference is the most reliable anchor; the synthesizer workspace is the
 * fallback when implementation never ran.
 */
async function readPlanState(
  stateRoot: string,
  runId: string,
  artifactRefs: readonly string[],
  reviewIds: readonly string[],
): Promise<PlanState> {
  const councilDir = join(stateRoot, 'council', councilRunDirName(runId));
  const candidates: string[] = artifactRefs.map((ref) =>
    join(councilDir, 'primary', 'inputs', ref, 'final-plan.md'),
  );
  for (const entry of await fs.readdir(councilDir).catch(() => [] as string[])) {
    if (!entry.startsWith('cp_s')) continue;
    candidates.push(join(councilDir, entry, 'final-plan.md'));
  }
  for (const candidate of candidates) {
    const text = await fs.readFile(candidate, 'utf8').catch(() => null);
    if (text === null) continue;
    if (REVIEW_FALLBACK.test(text) || REVIEWER_FAILED.test(text)) return 'quotes-template';
    // Plans cite reviews by short id (review_d82a57ad), so match the prefix.
    const prefixes = reviewIds.map((id) => id.slice(0, 13));
    if (prefixes.some((prefix) => text.includes(prefix))) return 'absorbed';
    if (/unmet criteria|material review concern/i.test(text)) return 'absorbed';
    return 'unconfirmed';
  }
  return 'not-found';
}

function lastOf(
  events: readonly CouncilEvent[],
  typeOf: (event: CouncilEvent) => string,
  type: string,
): CouncilEvent | undefined {
  return events.filter((event) => typeOf(event) === type).at(-1);
}

function formatBool(value: boolean | undefined): string {
  return value === undefined ? '-' : value ? 'ok' : 'no';
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireFlag(name: string): string {
  const value = readFlag(name);
  if (!value) throw new Error(`Usage: --experiment-dir <dir> is required`);
  return value;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}
