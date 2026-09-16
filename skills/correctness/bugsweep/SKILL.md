---
name: bugsweep
description: 'Finds and fixes runtime behavioral bugs via adversarial Hunter-Skeptic-Referee review:
  frozen-scope context, anti-pattern priming, minimal verified fixes with auto-revert
  safety. For ''find bugs'', ''audit the code'', or deep review.'
---

# bugsweep

> 蒸馏自 shanemhamilton/bugsweep（仓库根目录）。原为超大多文件技能（122 文件：SKILL.md + 8 个角色 prompt、约 30 个 shell 脚本、22 个 bats 测试、41 个 md 参考/反模式目录、config/schemas/templates），已合并为单文件，脚本机制改写为文字规则。
> 维度收敛（2026-09-11）：反模式目录已按正确性维度契约收敛——删除 AuthZ/access 与 Secrets/config 两类；architectural 原十条中 SSRF / auth bypass / sibling-verb authz / privileged forwarding / middleware-guard / deserialization / cascading-check 七条属安全判据，已删或改写；七个语言目录逐条筛除安全项。保留的是正确性母题（契约漂移、跨边界假设、共享可变状态、检查与使用被 IO 边界隔开、同一量在两处不同推导）。注意：上游是通用自主审计器，本语料把它窄化为维度专家，这是有意的偏离。

## When to Use

Use this skill for an **autonomous, adversarial bug-hunt and auto-fix pipeline** over a codebase — whenever the user wants to "find bugs", "hunt bugs", "audit the code", "deep code review", "check the logic before shipping", "run an unattended/overnight audit", or "make sure bugs don't reach production", even if they never say "bugsweep". Scope can be narrowed with a `<path>` argument, but the default is the whole repo: this is not a diff scanner.

It separates **finding** a bug from **challenging** it from **confirming** it from **fixing** it, so no single role rubber-stamps its own guesses. It builds **frozen-scope context** (a distilled architecture model) to catch large cross-file bugs, **primes itself** with stack-specific anti-patterns, applies only **minimal, verified fixes** with auto-revert safety, and routes every irreversible Git operation through deterministic shell scripts so safety never depends on judgment. Every run lands verified work or records remaining action in the project's existing tracker, then removes the exact branch/worktree it created. Progress is persisted to disk so long unattended runs survive context resets and learn across runs.

### Modes / invocations

Parse the invocation; default to the SAFEST reading when ambiguous.

| Invocation | Behavior |
| --- | --- |
| `/bugsweep` | **Detect only.** Bounded planned audit, tracker upsert, no source changes. (Default.) |
| `/bugsweep --fix` | Find + adversarial-confirm + fix, locally integrate verified work, and clean up. Single bounded pass. |
| `/bugsweep --approve` | Like `--fix`, but PAUSE for the user's OK before each fix. |
| `/bugsweep --autonomous` | Find + confirm + fix, then **loop** until clean or a cap, with periodic context checkpoints/resets. The unattended/overnight mode; implies `--fix --loop`. |
| `/bugsweep <path>` | Scope to a file or directory (combine with any flag). |
| `/bugsweep --severity <low|medium|high|critical>` | Only fix bugs at/above this severity. |
| `/bugsweep --recall` | Also record plausible 50–67% confidence near-misses for human review; never fixes them. |
| `/bugsweep --update` | Update the bugsweep installation, then exit; re-invoke after updating. |

Recommend a first-time `--approve` run to calibrate trust before `--autonomous`.

### Scope semantics

- **Whole repo by default.** With no path argument the whole repo is in scope — bugsweep finds latent bugs in old, unchanged code; it is **not a diff scanner**.
- **Path-scoped when a path is given.** Only files under that path are coverage/edit targets; dependencies outside it may be read as context but never counted as covered or changed.
- The selected scope is **frozen** for the run and never permanently "done" while a frontier remains.

## Core Principles

### The trust contract (read first — it governs everything)

Non-negotiable. Scripts enforce the irreversible parts; you enforce the rest. If a rule cannot be honored, STOP and report — never work around it.

1. **Isolate every run.** One exact `bugsweep/<run-id>` branch in a Bugsweep-owned linked worktree. Never switch the user's checkout or infer ownership from the `bugsweep/*` prefix. Persist the exact branch, worktree, base SHA, and original target.
2. **No Git remotes.** During preflight, hunt, fix, finalize, and closeout: no push/pull/fetch, PR, or force-push. Local integration is allowed only in fix modes after the configured quality gate. Project-tracker upserts are allowed; they are not permission to mutate source-control remotes or unrelated external state.
3. **Delete only owned disposable state.** No `git reset --hard` on user content, no history rewriting, no wildcard/prefix cleanup. The only uncontained branch that may be discarded is the exact current run branch, after a verified recovery bundle and a tracker receipt exist. Follow an independent destructive-action check before deletion.
4. **Preserve the user's work.** Preflight never stashes, commits, switches, or cleans the user's checkout. Its starting branch, index, and files remain byte-for-byte unchanged until an authorized local integration at closeout.
5. **One bug, one commit, auto-revert on regression.** Re-run checks after each fix; if a fix introduces a new failure that survives the flaky check, revert it and quarantine the bug. A newly-failing test is rerun `.verify.flaky_reruns` (default 3) times: only a **strict majority of rerun passes** reclassifies it as FLAKY and excludes it from the revert; a tie or a majority of rerun failures still reverts. **Precise, non-overclaimed safety:** reruns share the initial run's working tree/environment (no per-rerun isolation), so this distinguishes "failed the majority of reruns" from "passed the majority" — NOT truly "deterministic" from "flaky." A monotonic **state-pollution** bug (a broken fix whose first run fails but leaves a marker/cache making later runs pass) can be misclassified as flaky; the majority vote raises the bar but does not eliminate this. Therefore **any fix that lands with a flaky classification is loudly surfaced** (flaky.jsonl + ledger + run-summary + `FLAKY=`/`FLAKY_TEST=` lines) and must be reviewed — never silent. Full per-rerun isolation is a documented future enhancement.
6. **Fix only confirmed bugs** — findings must pass the full adversarial review first.
7. **Minimal surgical fixes only.** No refactoring, renaming, reformatting, or unrelated changes.
8. **Stay inside the caps** (iterations, runtime, fixes) and stop when converged.
9. **Everything is logged** to the run ledger so an overnight run is auditable.
10. **Close the loop.** Every confirmed-but-unfixed or quarantined bug is idempotently created or updated in the project's existing tracker. A run succeeds only as `COMPLETED_LANDED` or `COMPLETED_RECORDED`, and only after exact readback proves its branch and worktree are gone. Tracker or cleanup failures are incomplete, never done.

Cross-run learning lives in persistent state, not in temporary branches. Pruning a run branch never erases coverage, risk, conclusions, variants, or tracker receipts.

### Why the design is safe

The trust contract above and the role separation (Hunter → Skeptic → Referee, with only the Referee's CONFIRMED list fix-eligible) are the safety mechanism; the two properties worth naming on top of them:

- **All progress is on disk** (architecture context, anti-pattern brief, recon plan, ledger, continuity anchor), so a context reset drops only disposable working memory.
- **Nightshift no-silence contract, honestly stated**: the guarantee that a wall-clock deadline never produces silence comes from VOLUNTARY, phase-boundary guard checks — the model finalizing BEFORE its budget runs out — not from any mechanism that survives a hard process kill. Launch wrappers (orchestrator, scheduler, CI) should set their own outer limit **above** `caps.max_runtime_minutes`; the inner deadline is sized so bugsweep self-finalizes first (writing report + run-summary) instead of being killed with nothing on disk.

### Default caps and tuning values (config defaults)

- `caps`: max_iterations 10; max_runtime_minutes 120; max_fixes_per_run 50; no_progress_streak_to_stop 2.
- `severity_floor`: `low` (fixes only at/above this).
- `adversarial`: referee_votes 3 (K for severity ≥ high), referee_votes_cap 5; referee_enabled true; challenge_enabled true.
- `verify.flaky_reruns`: 3.
- `session.checkpoint_every_iterations`: 3.
- `context`: large_repo_file_threshold 800; large_repo_first_pass_batches 40; decay_factor 0.85; high_risk_top_n 25; recheck_audited_after_runs 5; variants_enabled true.
- `priority`: recent_commit_count 50; max_targets 50; max_reasons_per_file 5; promotion_limit 8; max_promoted_files 200; max_glob_matches 25; max_signal_age_hours 168.
- `analyzers.enabled`: false (off-the-shelf static analyzers are an explicit opt-in seed step).
- `recall.enabled`: false.
- `protected_branches`: main, master, develop, production, prod, release.
- `exclude_globs` (never scanned): node_modules, dist, build, .git, vendor, Pods, .next, coverage, *.lock, *.min.js, __generated__ dirs, etc.

## Workflow

### Step 0 — Preflight (deterministic safety setup)

**Version check first, every invocation** (passive, non-blocking; a slow/offline network is silently ignored). Detect the install location (Claude Code skills dir, falling back to Codex skills dir), compare local `VERSION` with the published one; if `--update` was passed, run the updater and stop — do not proceed to the hunt.

Before creating any branch:

- **Resolve exactly one project tracker** and verify create/update plus readback access. Choose the first source that explicitly identifies it: (1) a tracker/provider/project named by the user or invocation; (2) repository instructions (e.g. `AGENTS.md`/`CLAUDE.md`/contributing docs); (3) repository-local Beads only when present and callable. Hosting is not evidence of tracker use (a GitHub remote does not prove GitHub Issues is the system of record); if several trackers are documented, use the one named for bugs/engineering work; never create the same finding in several systems. Use the project's existing CLI/connector/app — do not install an SDK or write a provider adapter. **If no single tracker can be resolved, stop before any branch is created** and ask the user to name the system of record.
- Snapshot the exact initial local branch/worktree refs (ownership evidence, not a cleanup glob).

**Always run preflight in isolated worktree mode** before reading any source file: it verifies the repo is safe, leaves the user's checkout untouched, creates **one** isolated linked worktree on a collision-free `bugsweep/<ts>-<pid>-<rand>` branch (under a `.bugsweep/worktrees/` dir), and prints `RUN_DIR`, `BRANCH`, `WORKTREE` (plus `STASH=none` — nothing to restore; a stash is never taken). If it exits non-zero, STOP and show the error verbatim. Capture all three; they are the only Git resources this run owns, and all artifacts live under the run dir. When several runs share one repository (parallel subagents), the caller must add `--concurrent`; ordinary runs omit it and block on any prior mapped branch so a crash-retry cannot accumulate another branch. Callers pass their own PID as the lease owner so the run's lease tracks the shell that actually owns it (liveness for stale-lease reclaim).

**Deadline discipline**: preflight persists `BUGSWEEP_DEADLINE_EPOCH` from `caps.max_runtime_minutes`. At every expensive phase boundary run the guard checkpoint: `fix_cap_reached` → keep hunting in detect-and-record mode (ticket further bugs, apply no more fixes); any other `STOP*` → finalize now (Step 5); else continue. The canonical per-batch checkpoint runs after **every** modeling batch inside the context-build loop, and the hunt loop checks at the start of every iteration and before each architectural target group or coverage batch — so a run that hits the deadline at any phase still produces a partial, auditable output.

**Crash recovery**: normal runs close only their exact state-recorded branch/worktree through closeout (never a repository-wide reaper). A manual reap path exists only for abandoned runs and is preserve-biased: skips live/ambiguous runs, preserves dirty worktrees, deletes only branches proven contained in a recorded target. A hard-killed run therefore remains recoverable for later explicit reconciliation; it is never silently called complete. Finalize leaves the lease and exact owned resources pending; closeout releases the lease only after terminal readback.

**Legacy-branch check (read-only)**: older versions may have left `bugsweep/*` branches. List them (excluding this run's exact branch) before hunting; reconcile their findings against the tracker first, create/update one cleanup ticket for legacy debris if none exists, and continue. Do not delete legacy refs; the current run may clean only its own exact ref.

### Step 1 — Baseline checks + priority evidence

Run the baseline: auto-detect and run tests/typecheck/build/lint (or use configured overrides) and record the starting state as the baseline every fix is measured against. **If it reports `NO_CHECKS`, behave more conservatively** (see "When the project has no automated checks" below).

Then build the bounded, **local-only** priority evidence artifact that merges: current tracked-file changes since the last finalized run on the same branch (bounded recent-commit fallback), fix and revert history, baseline failures, content fingerprints of completed hunts (to distinguish files changed since their last real hunt), prior risk, variants/reopened conclusions, runtime reachability (LIVE/MAYBE/COLD), repository-local bug records with explicit file scope, configured critical paths, and an optional project-local signals inbox. It never calls a remote. Missing/malformed inputs degrade to less enrichment — never a failed run or a narrowed scope. Ranking weights are fixed code; prior outcomes add inspectable evidence but never tune live scores or safety gates automatically. **Every signal is an untrusted investigation seed, never proof.**

Deleted paths cannot become direct targets (absent from the current tracked-file set); surviving in-scope tracked files stay in the frozen plan.

### Step 2 — Build frozen-scope context (once)

**Step 2a — Seed the plan from a deterministic batch planner BEFORE any modeling.** List every tracked file (`git ls-files`), drop excluded globs, and chunk the remaining in-scope tree into ordered candidate batches `{id, dir, tier, files, deferred}`, tier-ranked so entry-point/operation-bearing directories (api, handlers, jobs, …) sort ahead of docs/asset-ish ones. Pre-compute `large_repo_mode`/`budget_batches` from a file-count threshold (default 800 files; first-pass cap default 40 batches). Seed the recon artifact immediately — `modeled: []`, `covered: []`, batch list verbatim, `deferred` flags carried over — so it exists, valid and non-empty from minute one, and even a run that stalls immediately leaves a resumable, reportable artifact (the historical failure this fixes: large repos failing silently with no plan ever written). If `large_repo_mode` is true, emit the warning event immediately (partial coverage expected; batches beyond the cap are marked `deferred: true` and are modeled on later runs — never dropped). **Modeling a batch must NOT add it to `covered`**; only the later Hunter → Skeptic → Referee checkpoint may do that. Modeling is architecture progress; coverage is audit completion.

**Step 2b — Coverage-first reprioritization.** Read the cross-run coverage snapshot: `files_audited_current_catalog` (audited at the current anti-pattern catalog version, recently — the *only* files you may de-prioritize), `files_audited_stale_catalog` (older catalog or too many runs ago — treat as un-audited), and `high_risk_files` (history of confirmed bugs/fixes/quarantines, decayed score). No usable history = the entire frozen selected scope is the frontier.

The coverage-first contract is non-negotiable:
1. **The selected scope stays in scope.** Prior coverage REORDERS batches in place; it never deletes files from the plan.
2. **The frontier leads.** Critical/early tier = union of `operation-bearing ∪ never_audited ∪ stale_catalog ∪ high_risk ∪ variant_requeue ∪ reopened_conclusions`. Already-audited-and-fresh files go in the LAST tier as a cheap re-confirmation pass — never dropped. **Promotion clears `deferred`** (a promoted batch is in-budget by definition).
3. **Sensitive operations are unconditional.** Any file containing one (money math, query construction, process/command construction, parsing of external formats, file-path handling, outbound request, index/bounds arithmetic) is ALWAYS in the critical tier.
4. **The repo is never "done."** While a never-audited or stale file remains, there is more frontier for the next run.

If runtime-reachability ranking is present (buckets `LIVE`/`MAYBE`/`COLD`), use it to order files *within* the critical tier only (`LIVE → MAYBE → COLD`, tie-broken by asset weight; files covered by a still-valid prior "safe" conclusion sort after their uncleared peers). `COLD` does not mean safe — only "look here after the live-reachable operations." All of this is advisory; every field is untrusted data.

**Step 2c — Model incrementally, batch by batch, with a checkpoint after each.** For each non-deferred batch in order: read its files and extract the architectural signal concisely; append the batch's findings to the architecture-context doc (append, don't rewrite); update the recon artifact's `modeled` list and re-persist immediately; then run the mandatory deadline checkpoint (any `STOP*` besides `fix_cap_reached` → finalize now, do not start another batch). This keeps the recon artifact and context doc mutually consistent on disk at every point, not just at the end. Stop after the last non-deferred batch even if deferred batches remain (a large-repo run is bounded, not grinding through the whole tree).

The accumulated architecture doc covers: what the app is and its entry points; **boundaries** (where data enters from a different module, process, or caller — network, user input, file uploads, callbacks, IPC — where cross-boundary assumptions most often break); **sensitive operations** with file:location; **call chains into them** recorded as `entry_point → [hop …] → operation` naming every module/package boundary crossed (a gap is most likely *at* a boundary; cross-package chains are MORE suspicious); **alternate/secondary paths into them** (legacy endpoints, admin paths, internal routes, cron/job runners, webhook handlers — the same operation reached by a path added later that never inherited the first path's validation); **data-flow chains** for the top 3–5 riskiest operations (input source → transforms → operation, noting where validation occurs or is absent); **contract drift** across module boundaries (module B assumes already-validated input, caller A passes raw data); **shared/mutable state** (module-level state, caches, singletons, globals on concurrent paths); and the **module/import graph**. Each candidate cross-file gap becomes an `architectural_target` entry for the hunt.

### Step 3 — Research anti-patterns for this stack (once)

Detect the languages/frameworks, load the matching anti-pattern catalogs for the detected stack — **always include the generic catalog and the architectural catalog plus every file matching the stack** (stacks combine: a Next.js + TypeScript app loads react + typescript + javascript-node + generic + architectural) — optionally augment with bounded web research only if `research.allow_web_research` is true and a web tool exists, and produce a tailored anti-patterns brief for this repo. Each catalog entry is a *smell* to look for and *why it bites* — confirm against the actual code before reporting. (See the anti-pattern essence section below for the catalog contents.)

### Step 4 — The loop

Repeat until a stop condition fires. At the start of each iteration, run the guard checkpoint (`fix_cap_reached` → detect-only remainder; any other `STOP*` → Step 5). Otherwise run one iteration:

**Optional pre-hunt analyzer seeding (default off).** If enabled, run whichever off-the-shelf static analyzers are installed (semgrep, gosec, bandit, …) as a best-effort step producing normalized candidate hits for the Hunter to read as **seeds**. It never fails the run — an absent tool or disabled config is a clean no-op. A hit tells you where to look first; it never tells you what to conclude; every seed still requires full independent verification.

1. **HUNT** — dispatch a separate Hunter (use a subagent/Task for context isolation if available) on the next uncovered batch, loaded with the architecture context and the anti-pattern brief. The hunter runs BOTH lenses and records which found each bug:
   - **Local lens (per batch):** scan the batch's files line by line, tracing real runtime behavior against the anti-pattern brief plus the universal bug classes (see "What counts as a bug").
   - **Architectural lens (cross-file):** on iteration 1 run a dedicated, bounded hunt over the top-N architectural targets (typically 5–10; cap N so it fits one subagent context; note the rest for later iterations — never claim they were audited). Walk every target and call chain, naming **every hop** `entry_point → hop1[pkg] → … → operation` and identifying where the gap is. An architectural finding with a vague "somewhere in the chain" is not a finding; one that names the exact hop where the check is absent IS a finding.
   - Hunters never fix anything and never verify their own findings.
   - **Evidence is mandatory**: for every candidate, point at exact code and describe a concrete input or sequence that produces wrong behavior — otherwise drop it. Five real bugs beat twenty maybes. Architectural findings must name the full path and the gap.
   - **Output per candidate**: `BUG-<n>` with lens, priority reason codes (attribution only — from the seed that actually caused inspection, never inferred after the fact), file:line, severity (low|medium|high|critical), one-line title, why_wrong (the incorrect behavior), manifests (concrete trigger + bad outcome; full path for architectural), evidence (specific lines/identifiers; each hop for architectural).

2. **CHALLENGE (Skeptic)** — dispatch a *separate* adversary that did not find these bugs. It actively tries to disprove each candidate by reading the code itself, calibrated to **punish dismissing real bugs twice as hard as missing a false-positive catch**: only reject when it can point to a concrete reason the code is actually safe — never reject on a hunch, never reject because a bug is inconvenient or subtle; when it cannot confidently disprove, it must let the candidate stand.
   - **Grounds NOT sufficient to REJECT** (if the Skeptic's ONLY evidence is one of these, mark **DISPUTED** instead and let the Referee adjudicate):
     - "This bug is in the upstream library, not our code." (Upstream attribution is irrelevant to whether the running code is defective.)
     - "No call site inside this codebase triggers it." (For library code, callers may be external and not visible here.)
     - "This is a pre-existing or long-standing issue." (Pre-existing bugs are exactly what this audit hunts; age does not confer safety.)
     - "It is documented behavior." (Documented behavior is still a defect if the behavior is wrong.)
     - "The bug requires a chained precondition to trigger" is a valid **severity-downgrade** argument, not a rejection — it belongs in the severity rationale.
   - **Published upstream bug reports**: if the Hunter cites a matching upstream issue/changelog entry, treat it as evidence the defect class is real and understood; to REJECT, produce concrete code-level evidence this specific version is fixed (fix commit present, guard backported) or the defective path is genuinely unreachable; otherwise DISPUTED.
   - Verdicts: **UPHELD** (tried and could not disprove), **REJECTED** (concrete code-level evidence of safety), or **DISPUTED** (genuinely uncertain, or rejection rests on an unverifiable assumption or a weak ground above — send to the Referee rather than guessing). Record a one-line reason and confidence (0–100). Dedupe candidates sharing a root cause. For architectural findings, walk the claimed path hop by hop — any wrong hop or an existing check fails the finding. Preserve each candidate's priority reason codes unchanged.

3. **REFEREE** — in every fix-capable mode, require a neutral arbiter to independently rule every DISPUTED and UPHELD item. It reads the cited code fresh (for architectural findings, independently verifies the full path and the specific missing check) and rules **CONFIRMED** only when it can state the triggering condition AND is **>67% confident the behavior is wrong at runtime**; otherwise **NOT CONFIRMED**, recorded as "confirmed-uncertain / needs human" — never a fix target. Finalize severity by real-world impact (blast radius, data exposure, frequency, how wrong the result is); architectural defects that bypass a validation or accounting check are typically high/critical even if the change needed to trigger them is small. If two passes still can't settle it, default to NOT CONFIRMED for fixing and flag for a human: **under-fixing is safe; auto-editing on a shaky finding is not.** Weak Skeptic reasoning in a DISPUTED item neither lowers nor raises the bar — the code decides, not the attribution. Its CONFIRMED list is the only thing eligible to fix.
   - **K-vote majority for severity ≥ high/critical (conservative by design):** a single adjudication is enough for medium/low (unchanged single-pass path, no vote records). For high/critical, before a finding becomes CONFIRMED and fix-eligible: perform **K = min(referee_votes=3, referee_votes_cap=5)** independent adjudications of the SAME finding, reusing the identical >67% rubric but varying the framing so they are genuinely independent reads (e.g. trace forward input→operation; trace backward operation→every call site; actively try to disprove it Skeptic-style). Record each vote. Promote **ONLY on a strict majority** of CONFIRMED votes (strictly more CONFIRMED than every other outcome combined). **A tie, a lone CONFIRMED vote, or a minority is NOT CONFIRMED** — route it to "needs human" (and, in recall mode, possibly to near-misses). If the config value is missing/malformed, fall back to a small default (3) — never skip the K-vote path.
   - **Analyzer corroboration (one-directional):** when a finding's file/line matches a normalized static-analyzer hit, record `corroborated_by:<tool>` as supporting evidence. Corroboration raises confidence in an otherwise-CONFIRMED finding; **absence of a hit must NOT lower confidence** (most real bugs — especially architectural ones — have no off-the-shelf detector); a hit alone never confirms a finding.
   - **Recall mode (`--recall`, config `recall.enabled`):** for every NOT-CONFIRMED item whose confidence sits in the **50–67 band** (genuinely plausible, short of the >67% bar), record it as a **near-miss** for human review. Hard rules: a near-miss is **never** fix-eligible; it must not soften or influence any other item's verdict; only a fresh independent re-evaluation reaching >67% in a later run may promote it. Include recorded near-misses in the report's near-misses section.
   - **Cross-run learning the Referee records while adjudicating:**
     - *Variant query*: for each CONFIRMED bug with a **transferable shape** (off-by-one, missing null guard, contract drift, unvalidated input reaching an operation, check-then-act, partial work with no rollback, …), synthesize ONE structural Semgrep-style rule matching the bug's *shape* (operation + missing guard), not its exact line — so future runs hunt for siblings. The rule must match its own origin file; an over-broad rule is stored low-confidence (won't auto-requeue); never weaken the guard. Skip for one-off bugs with no transferable shape. Detect-only runs still synthesize variants.
     - *Guard*: when it verifies a specific function genuinely establishes a guarantee on every path through it, register it (class from: bounds, null, exec, file_path, money, time, encoding). This is a HINT for ranking, **never a clearance** — the next run still hunts the operation, because the call graph misses paths. Only register what was actually verified; never infer from a name.
     - *"Safe" conclusion*: when it traces a potential defect and concludes a specific operation is SAFE on the paths examined, record the conclusion with every symbol the reasoning depended on (the operation's own function, validators and guards on the path). The conclusion **auto-re-opens** (its file rejoins the frontier) the instant ANY premise/guard body changes, the operation gains a new reachable path, or the catalog advances — a "safe" verdict can never silently outlive its assumptions. It only ever DEPRIORITIZES within the critical tier; it can never drop an operation from scope. Keep the claim short and factual; retire it if later found wrong.
   - Receipts: the Referee appends a `referee_verdict` event (CONFIRMED or NOT_CONFIRMED) for every ruled item — mandatory before any fix — plus an iteration event with confirmed/new-bug counts for no-progress detection and session checkpoints. Detected-but-unfixed confirmed items in detect-only mode or below the fix floor carry a `confirmed` event instead.

4. **FIX** (if `--fix`/`--approve`/`--autonomous`, unless detect-only remainder) — per confirmed bug at/above the severity floor, in severity order:
   0. **Repro, best-effort (see Repro protocol below).** If the bug has a reproducible shape, synthesize a minimal failing test asserting the CORRECT behavior and confirm it is RED *before* editing anything. A red-confirmed repro adds an extra gate to the fix; an unreproduced or skipped repro falls back to suite-only gating and must never block the fix.
   1. **Minimal change only.** Edit only what's needed to correct the behavior — no refactoring, renaming, reformatting, restructuring, or unrelated lines. A fix that changes 3 lines is reviewable; one that changes 300 is not. In `--approve` mode, do not broaden the approved edit — a material change requires a new approval before mutation.
   2. **Match the codebase.** Use existing patterns, validation helpers, and error conventions in the file; no new dependency or pattern.
   3. **Run the full verify checks** (against the baseline). If a red repro was confirmed (see Repro protocol), additionally re-run it: `REPRO=confirmed` (exit 0) → proceed exactly on the check result; `REPRO=failed` (exit 1) → treat **exactly like a REGRESSION** even if the suite printed OK (the general suite passing does not prove THIS bug is fixed when a purpose-built repro says otherwise).
   4. **Decide from the result:**
      - `OK` with no new failures (and no failed repro) → stage only this bug's owned files, inspect the staged diff (unrelated or generated changes quarantine the fix), and commit exactly this one fix (`fix(bugsweep): BUG-<n> <short title>`). Record the fix event with bug id, severity, file, commit sha.
      - `NO_CHECKS`, or `OK` annotated `FLAKY=`/`FLAKY_TEST=` → **do not auto-land.** Commit only if needed to escrow the exact fix, mark review-required, and route through tracker + recovery-bundle closeout. Never auto-land unverified code.
      - `REGRESSION`, or `REPRO=failed` → revert immediately (uncommitted: restore only the exact files this fix touched, never a repo-wide checkout/clean; already committed: revert the HEAD commit), append the bug to the quarantine list with the failure detail, and move on.
   5. End with a clean owned worktree: every touched file is in this bug's commit or restored. Unexpected dirt quarantines the fix; never absorb it with broad staging.
   - **When NOT to auto-fix (quarantine instead):** the fix would require changing a public API/contract or many call sites; the correct behavior is genuinely ambiguous and needs a product decision; there are no automated checks AND the change is non-trivial; two attempts to fix it both regressed the checks. Quarantined bugs go in the report under "needs human" with enough detail for someone to fix by hand. Never leave the branch with a failing checkpoint commit.

5. **RECORD + checkpoint** — append the iteration result to the ledger (the Referee writes the iteration event with confirmed/new-bug counts). After the full Hunter → Skeptic → Referee chain finishes for a batch, run the coverage checkpoint, which records exact Git blob IDs and marks the batch covered as one idempotent protocol — do not write coverage surfaces by hand. (If the exact Git-object checkpoint is unavailable — no Python 3 — coverage is left untouched and the run finalizes with an incomplete report plus a degraded summary that underreports coverage as zero, with the generated report stub marked `stalled`; never claim unverifiable work.) Then run the session checkpoint that refreshes the continuity anchor. If it prints `RESET_RECOMMENDED`, finish to a clean state (every fix committed or reverted, nothing mid-edit), then **reset/compact context** and immediately **rehydrate**: read the continuity anchor, architecture context, anti-pattern brief, recon state, and tail the ledger before continuing. Continuity is preserved because all progress is on disk; a reset only drops disposable working memory.

**Stop conditions**: all planned batches covered with no pending findings; a runtime/iteration cap; or a no-progress streak (default 2) only after the planned frontier is exhausted. A fix cap stops mutation, not discovery. Non-`--autonomous` modes make one bounded pass over the planned batches. Deferred large-repo batches make the result PARTIAL, never repo-clean.

### Repro protocol (best-effort, entirely skippable, never blocks Fix)

Per CONFIRMED bug with a reproducible shape, immediately before Fix: (1) decide if the bug has a single nameable triggering condition the finding already describes — if not, skip; (2) detect the repo's test framework/conventions (resolved test command or auto-detect: pytest, jest/vitest, go test, cargo test, bats, …) and mirror an existing test's style; (3) write **ONE minimal test asserting the CORRECT behavior — not the buggy one** (getting this backwards silently inverts the whole gate), preferring the project's own test discovery path; for a bare script/CLI repo with no test directory, write a small standalone repro script in the run dir instead; (4) confirm it is RED before touching fix code.

Results: `REPRO=red_confirmed` (repro demonstrates the bug → the Fix phase must gate on it going green); `REPRO=unreproduced` (passed before any fix — wrong assertion or unreachable bug: one more attempt at most, then delete the misleading test file and proceed, falling back to suite-only gating exactly like `none`); `REPRO=none` (skipped). Skip when: no test framework detected (`NO_CHECKS`); the bug's shape isn't a minimal-test shape (broad architectural/cross-file finding with no single triggering call, config-only, or needing infra a unit test can't stand up deterministically); two attempts came back unreproduced. A skipped/unreproduced repro never stops Fix — its only effect is that a red-confirmed repro makes the revert decision MORE strict (Fix step 3b; decision matrix).

### Step 5 — Finalize artifacts, resolve work, and clean up

**Write the report before finalizing** (two-stage template below; include `PARTIAL` whenever coverage is incomplete — large-repo deferral, cap, early interrupt, or unexhausted frontier). If no report was written, finalize emits a stub from the ledger and recon state.

Finalize is an artifact checkpoint, not the terminal success signal. It persists cross-run learning (files in covered batches appended to the audit log stamped with catalog version + run ordinal; per-file bug/fix/quarantine events appended to the risk log), creates the machine-readable run summary, appends deterministic report sections (do **not** author the machine-readable findings section or the priority-focus section yourself — they are generated from the run-summary reduction of the ledger + recon state, so prose and JSON never diverge), restores or leaves the user's checkout untouched, and creates a per-run closeout blocker. `BRANCH_PENDING_CLOSEOUT` is not success; do not end the run there.

Then close out, in this order:

1. **Tracker resolution.** Read the run summary. Idempotently create or update tracker items for: `confirmed_unfixed` bugs (detect-only or below the fix floor), quarantined fixes/regressions, approval declines/timeouts, fixes with `NO_CHECKS` or a flaky-annotated `OK`, escrowed unexpected dirt, and one run-level follow-up item for an incomplete audited frontier when the project expects bugsweep to continue. Rejected candidates, style observations, and per-batch speculation are NOT tickets. Derive a **stable key** from repository identity + the finding's normalized root cause + primary location; search before creating; update an existing open item instead of duplicating. Each item includes: stable key and run id; severity, category, affected file/line, full architectural path when applicable; concrete trigger, bad outcome, root cause, evidence; verification result and why it did not land; minimal proposed fix and focused checks; report path and recovery-bundle path/digest when code was escrowed. **Read back every write** before continuing — a command reporting success without readback is not a receipt. If the tracker becomes unavailable, append the intended payload with its idempotency key to the durable outbox, set outcome `INCOMPLETE_TRACKER`, preserve the verified recovery bundle, and never claim the write happened — later preflight stays blocked until reconciled.
2. **Branch disposition.** Classify from the run summary and exact recorded state — never select a branch by timestamp, newest commit, or `bugsweep/*` glob:
   - **Verified fixes can land** → integrate the exact run branch into the recorded original target (construct the merge away from the target ref, run the post-merge quality gate, advance the target with compare-and-swap). Local integration is part of `--fix`/`--approve`/`--autonomous`; it never implies permission to push. An already-contained branch is re-gated to produce current evidence. Closeout reads the integration receipt plus Referee verdict and approval events — Git ancestry alone is insufficient.
   - **Clean run / no unique commits** → recorded closeout: proves the exact branch is contained and there is no actionable unresolved work, then removes the owned resources.
   - **Unique commits cannot land** → before discarding anything, escrow and verify a recovery bundle OUTSIDE the linked worktree (`git bundle create` + `git bundle verify` + record tip + SHA-256 digest), attach the bundle path and digest to a verified tracker receipt, obtain a **fresh independent deletion review** of the exact branch/impact/recovery commands, and only then run the recorded closeout. If independent review is unavailable, do not delete unique work — return `INCOMPLETE_CLEANUP` and block the next preflight. Never remove a dirty worktree; restore or narrowly commit its owned changes first.
3. **Terminal exact-resource gate.** Closeout requires `integrate-results.json` to bind the exact current source tip to a gated target tip; Referee verdicts must precede each fix; in approved mode, approval must follow the verdict and precede reproduction or mutation. Then run exact readback for the recorded branch and worktree (check the exact branch ref and exact canonical worktree path from state — do NOT use a zero count of all `bugsweep/*` branches as proof, and confirm the user's checkout branch/status equals the preflight snapshot). A successful run owns neither:
   - `COMPLETED_LANDED`: verified changes are on the recorded local target, tracker receipts cover any remaining action, and no run-owned Git resource remains.
   - `COMPLETED_RECORDED`: all action is read back from the tracker with verified recovery where needed, and no run-owned Git resource remains.
   - `INCOMPLETE_TRACKER` / `INCOMPLETE_CLEANUP`: never "done"; retry the idempotent closeout before any later run creates another branch; never create another bugsweep branch while a closeout blocker exists.
4. Append the final **Closeout receipt** section to the report with the outcome, tracker receipt path/IDs, recovery bundle, and exact resource readback — written after finalize, not guessed in the pre-finalize prose.

## Repro / fix decision matrix (condensed)

| Verify result | Action |
|---|---|
| `OK`, no new failures, (no red repro or repro green) | Stage only owned files → inspect diff → one commit |
| `OK` with `FLAKY=`/`FLAKY_TEST=` | Never auto-land; commit only to escrow; review-required; tracker + recovery-bundle closeout |
| `NO_CHECKS` | Never auto-land unverified code; conservative fix rules (below) |
| `REGRESSION`, or `REPRO=failed` | Revert exact changes / revert HEAD commit → quarantine with failure detail |

## When the project has no automated checks

If the baseline reports `NO_CHECKS`, the auto-revert safety net is absent — behave more conservatively:
- **Prefer detect-only.** Recommend review by hand, or add even a minimal check command (a typecheck or build command is often enough to catch the worst regressions).
- **Only auto-fix the unambiguous.** Restrict autonomous fixes to changes whose correctness is obvious by inspection and local in scope (e.g. a missing null check, an inverted boolean, an off-by-one). Quarantine anything that touches control flow broadly or changes a contract.
- **Smaller commits, more detail.** Make each fix tiny with a fuller commit message and ledger note, since human review is now the only verification.
- **Suggest a check command** in the report so future runs can fix far more aggressively and safely.

## What counts as a bug (and what to ignore)

**FIND:** logic (off-by-one, inverted conditions, wrong operators), error handling (swallowed errors, missing null checks, unhandled rejections, leaked resources), concurrency/races (missing await/lock, check-then-act), data integrity (truncation, encoding, timezone, overflow, money precision), API-contract violations, and cross-file/architectural gaps (contract drift across a module boundary; a caller that assumes a different contract than its callee). Security-class issues (injection, auth/authz bypass, SSRF, path traversal, hardcoded secrets, unsafe deserialization, missing authz checks) are out of this role's scope.

**IGNORE (linter/formatter jobs, not bugs):** style, formatting, naming, unused imports, missing type annotations that don't fault at runtime, TODOs, dependency versions, coverage gaps. Flagging these erodes trust.

## Anti-pattern essence (what the Hunt primes itself with)

Each catalog entry is a smell and why it bites — confirm a concrete trigger against real code before reporting.

### Generic (all stacks)

- **Input/trust:** caller-supplied data reaches an operation without validation or normalization, so the operation produces the wrong result or fails — a value used where a different shape was assumed; validation on one path to an operation but not another; trusting client-supplied values that should be server-derived (price, totals, role, IDs used in lookups). The question here is behavioral (is the result wrong for that input); whether the input is *exploitable* is out of scope here.
- **Error handling:** errors swallowed (empty catch, ignored return); error path returns a default/empty value treated as valid; missing null/undefined/None checks on values that can be absent; partial multi-step work with no rollback.
- **State/money/time/data:** read-modify-write on shared state without atomicity (check-then-act across an await/IO boundary); money in floats; naive timezone/datetime handling (DST, off-by-one-day); integer overflow/unbounded growth/truncation; off-by-one in pagination, slicing, loops, boundary comparisons.
- **Resource safety:** file/connection/lock not released on error paths; unbounded retries/recursion; no timeout on outbound calls.

### Architectural (cross-file; always applied)

1. **Assumption propagated across a package boundary without re-checking** — module A receives a value and passes it to module B, which assumes it was validated/normalized; A validates but a different caller of B does not (or A's validation is bypassed by a direct call). Find every caller of B; verify each establishes the equivalent guarantee — validation in *some* callers is not validation in *all*.
2. **Contract drift: "already validated" assumption not enforced** — a callee documents/assumes input is validated/normalized (helper wrapping an operation, "call only with validated X", struct field comments); a caller passes raw or weakly-typed data. Enumerate every call site; find the one that doesn't fulfill the assumption.
3. **Shared mutable state written from concurrent paths without synchronization** — module-level map/slice/field/cache written from multiple goroutines/threads/async callbacks without a mutex/lock/atomic; lazy-init without a once-guard. Enumerate every write and every read that follows a conditional write.
4. **A check separated from its use by an IO boundary** — a value is validated or fetched, then an `await`/IO call happens, then the value is used as though it were still valid (the row still exists, the file is still there, the state has not changed). Name the window and whether anything re-checks after the boundary — a check with nothing after the boundary closes nothing.
5. **A value re-derived differently on two paths that must agree** — the same quantity computed in two places (a total in the request path and in a batch job; a length measured in bytes in one place and characters in another) with no single source of truth. Enumerate the sites and compare their derivations; divergence is the defect even when each looks correct alone.

### Language catalogs (load matching + generic + architectural)

- **TypeScript** — `as`/`as unknown as` assertions and `any` hide real shape mismatches (casting `JSON.parse`/API responses/`any` straight to a domain type); non-null assertion `!` on values that can be null at runtime; `@ts-ignore`/`@ts-expect-error` suppressing real diagnostics; trusting types on data that crossed an untyped boundary (network, localStorage, env, message payloads) without runtime validation — the type is a claim, not a check; array/map index access typed `T` but actually `T | undefined` (`noUncheckedIndexedAccess` off); optional-property vs `undefined` confusion (`exactOptionalPropertyTypes` off); non-exhaustive switch over a union with no `assertNever` default; type guards that lie; narrowing lost across `await`/closure; async function whose return isn't awaited (`Promise<T>` treated as `T`); floating promises; loose tsconfig (`strict: false`, `strictNullChecks: false`); `skipLibCheck` masking real conflicts; declaration merging changing third-party types.
- **JavaScript / Node** — missing `await` (conditions always truthy, unhandled rejections); `forEach` with async callback (not awaited, errors lost — use `for...of`/`Promise.all`); unhandled rejection paths; `Promise.all` vs `allSettled` misuse; `==` coercion and falsy surprises (`0`, `""`, `NaN`); `JSON.parse` without try/catch; `parseInt` without radix; trusting `req.query`/`req.body`/`req.params` for values that should be server-derived (price, totals, IDs used in lookups); Express 4 async handler throws hanging the request (unwrapped); a mutating route that persists a malformed body unvalidated; wrong status codes (200 on failure).
- **React / React Native / Next.js** — `useEffect` with wrong/missing dependency array (stale closures, effects that don't re-run); `setCount(count + 1)` in async/batched paths instead of functional update; effects starting async work without cancel/ignore on unmount (setState after unmount; slow earlier request overwriting fast later one); missing cleanup for subscriptions/timers/listeners; derived state duplicated into `useState` and going stale; list keys by index while list reorders; reading data before it loads (`.map` on undefined first render); no loading/error state; a conditional render that emits a falsy value as text (`{count && <X/>}` renders `0`); Next.js serializing server-only data into client components; a cache keyed only by URL whose payload varies per caller, so a later caller reads a stale wrong value; RN: platform APIs without an `isPlatform` guard.
- **Python / Django / Flask / FastAPI** — mutable default arguments; bare `except:`/`except Exception: pass` swallowing errors; late-binding closures in loops; `==` vs `is`; truthiness of `0`/`""`/empty containers; float money instead of `Decimal`; `assert` for runtime validation (stripped under `-O`); Django: N+1 / repeatedly evaluated querysets; `objects.get()` without catching `DoesNotExist`/`MultipleObjectsReturned`; a queryset re-evaluated inside a loop; Flask/FastAPI: blocking IO in async endpoints; Pydantic trusting the client for fields the server must set; per-request mutation of module-level state; forgetting `await`; check-then-act across `await`.
- **Go** — ignored errors (`val, _ := f()`) proceeding with a zero value; returning a non-nil error with a partially-populated value; nil pointer/map/interface dereference; writing to a nil map; typed-nil-in-interface (`!= nil`); data races (run `-race`); goroutine closing over a loop variable; goroutine leaks (no cancellation/`ctx` propagation, ignoring `ctx.Done()`); `WaitGroup` Add/Done mismatch; deadlock on unbuffered channel; `defer` cleanup placed after the error return or in a loop; missing `rows.Close()`/`resp.Body.Close()`; integer overflow/truncating conversions; `int` vs `int64` on 32-bit; time without zone; comparing times with `==` instead of `.Equal`; ignoring `r.Context()` cancellation; writing to `http.ResponseWriter` after `WriteHeader`.
- **Kotlin / Android** — platform types from Java (`String!`) → NPE at use; `!!` on possibly-null values; `lateinit var` read before init; ignoring `map[key]` nullability; coroutines: `GlobalScope` (work outliving its owner), swallowed `CancellationException` in `catch (e: Exception)` breaking structured concurrency, blocking calls on non-blocking dispatchers, `runBlocking` on main (ANR), shared mutable state without a mutex/confined dispatcher, check-then-act across a suspension point, fire-and-forget `launch` losing exceptions; `also`/`apply` vs `let`/`run` returning the wrong thing; non-thread-safe `lazy`; `data class` equals/hashCode ignoring body properties; `copy()` bypassing `init` validation; companion-object mutable state; `Int` overflow; `Double` for money; non-exhaustive `when`; default/named-argument mismatch; elvis `?:` hiding a real error; Android: holding Context/Activity/View in longer-lived objects (leak); using views after fragment destruction; UI updates off the main thread.
- **Swift / iOS** — force-unwrap `!`/`try!`/force-cast `as!` on values that can be nil/throw (`URL(string: userInput)!`); implicitly unwrapped optionals used before assignment; `fatalError`/`precondition` reachable from user input; UI updates off the main thread; retain cycles from closures capturing `self` strongly without `[weak self]`; data races across queues/tasks; `@State`/`@StateObject` vs `@ObservedObject` misuse; uncancelled `Task {}` capturing self; money in `Double` instead of `Decimal`; `Date` math ignoring `Calendar`/`TimeZone`; overflow with `&+`; truncating conversions; force-decoding JSON / `Codable` with non-optional fields the server can omit; SwiftUI view identity bugs (missing/unstable `.id`); `onAppear` work re-running unexpectedly.

> Security classes (injection, path traversal, SSRF, secrets, authorization/authentication, unsafe deserialization) are deliberately absent from these catalogs — they are out of scope here. See "What counts as a bug" above.

## Parallel fan-out (orchestrator contract, for very large codebases)

An orchestrator fans out **up to 5** worktree-isolated bugsweep subagents (each `--autonomous` or `--approve`), then reviews, integrates, and pushes — while **the orchestrator itself never hunts** (its only inputs are each subagent's on-disk run summaries). Partition the frontier deterministically across N ≤ 5 shards (or atomic batch claiming for uneven sizes); each subagent hunts only its assigned batch ids. Dispatch each with the concurrent worktree preflight. When subagents finish: read each run summary, integrate verified branches **one at a time with re-verification after each merge**, review, then push/merge to the user's real branch. Record the combined follow-up frontier so the next session knows where coverage is thin. N ≤ 5 is grounded in what was reviewed for that concurrency level.

## Checklist

The trust contract rules (above) plus the numbered steps of the loop are the checklist — every rule there is a gate. Two things worth re-stating because they are missed most often: coverage is only recorded by the Referee checkpoint (modeling a batch is not covering it), and a run never ends as COMPLETED until exact readback proves no run-owned branch or worktree remains.

## Output Format

Write the finding sections in the report before finalize, then append the closeout receipt after tracker and cleanup readback. Present a condensed version using this two-stage template:

```markdown
# bugsweep report — <timestamp>
**Run branch (ephemeral):** bugsweep/<run-id>   **Mode:** <mode>   **Iterations:** <n>
**Stack:** <detected>   **Baseline checks:** <summary>   **Final checks:** <summary>

## Summary
- Confirmed bugs: <n> (critical <n>, high <n>, medium <n>, low <n>); architectural: <n>
- Fixed & verified: <n>   Quarantined (needs human): <n>
- Coverage: <batches covered>/<total> batches [COMPLETE | PARTIAL — <stop reason>]; reviewed via Hunter→Skeptic→Referee

## Fixed
<one line per fix: BUG-ID · severity · lens · file:line · repro status · vote split for high/critical · what was wrong · commit sha>

## Quarantined / needs human
<one line per item: BUG-ID · stable finding key · severity · file:line · why it wasn't auto-fixed>

## Confirmed but not fixed (detect-only or below severity floor)
- <BUG-ID> · <stable finding key> · <severity> · <category> · <file>:<line> · <repro status> · <vote split for high/critical> · <one-line cause>

## Near misses (review, never auto-fixed)
<!-- Include only when recall mode is active. -->
- <BUG-ID> · <severity> · <category> · <file>:<line> · confidence <50–67> · <why plausible but unproven>

## Closeout receipt
<!-- Append after finalize + tracker + exact cleanup readback. -->
- Outcome: <COMPLETED_LANDED | COMPLETED_RECORDED | INCOMPLETE_TRACKER | INCOMPLETE_CLEANUP>
- Tracker receipts: <path and item IDs>
- Recovery bundle: <path or none>
- Owned branch/worktree remaining: <none or exact blocker>
```

Do **not** author a "Findings (machine-readable)" or "Priority focus" section yourself — finalize appends both automatically from the run-summary reduction of the ledger + recon state, including on a stub/partial report. Write only the prose sections above and stop.

## Provenance

- Source repo: https://github.com/shanemhamilton/bugsweep
- Original path: repo root (`.`); the canonical skill entry point is `SKILL.md` at the repo root.
- License: MIT (Copyright (c) 2026 Shane Hamilton)
- 蒸馏说明：原技能共 122 文件 / 约 1.5MB。已将脚本自动执行的机制（隔离 worktree、守卫/截止检查、覆盖率指纹检查点、flaky 重跑判定、K 票多数、变体查询、guard/结论记录、finalize/closeout 门禁等）改写成文字步骤与判定规则，并保留关键默认阈值；按语言反模式目录压缩为精华清单，完整表述见 https://github.com/shanemhamilton/bugsweep/tree/main/references/antipatterns 。bats 测试主要锁定 prompt/config 契约形状，已以规则文字呈现；仓库自身开发流程文档未纳入。
- Distillation note: script internals beyond documented behavior (e.g. exact state-machine edge cases of the largest scripts) were not read line-by-line and are summarized; consult the original repo for exact semantics. The catalog `VERSION` mechanism re-queues files audited under an older catalog — re-review previously-cleared areas whenever the standard changes.
- 维度收敛（2026-09-11，详见文首维度收敛注）：反模式目录两大块（generic 6 类、architectural 10 条）与七个语言目录逐条筛除安全判据；Skeptic 段落的 CVE/可利用性措辞改为上游缺陷报告/可触发；工作流中的 "sink" 术语统一改为 "sensitive operation"（结构性词汇，非判据变更）；sanitizer 记录改为 guard 记录。原先已声明安全类不在范围内，但反模式目录仍在为这些类别做预热，属自相矛盾，本次一并消除。