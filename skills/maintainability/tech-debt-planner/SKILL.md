---
name: tech-debt-planner
description: Maps a codebase into functional modules, scores each for technical debt, and plans prioritized incremental cleanup with guardrails. Use for tech-debt triage, refactor roadmaps or janitor sweeps.
---

# codemap — Architecture Map & Code-Quality Audit

Maps a codebase into *functional* modules, scores each for technical debt, and plans
prioritized incremental cleanup under an independent-verification gate. This is a
debt-triage method scoped to structure and read-cost only — behavioural correctness,
security exposure, and latency are out of scope here.

It maintains three coupled artifacts for a project:

1. **`modules.json`** — the source of truth: every *functional* module (not file) with
   its paths, dependencies, coupling, LoC, content hash, score, grade, tags, findings.
2. **`codemap.html`** — a self-contained interactive map (layered modules,
   dependency highlighting, health coloring, audit-report view).
3. **`codemap.md`** — the written report (per-layer scores, per-module LoC
   table, worst offenders, cross-cutting themes).

The HTML and MD are **derived** from `modules.json` — always regenerate them from the
state file; never hand-edit them. The state file makes everything **incremental**: a
content hash per module tells you exactly what changed and what needs re-auditing.

## State model (`modules.json`)

The state file is the single source of truth and the **only** artifact you edit by hand
(structure / decomposition). Its shape:

- **Top level** — `bands`, `spine`, `meta`, `reportThemes`, `modules`.
- **`meta`** — `lang` (`"zh"`/`"en"`; localizes the UI chrome + report — module names/ids
  are never translated), `project`, `subtitle`, `htmlPath`, `mdPath`, `spineDesc`, `rev`
  (the git baseline the map was last built from).
- **`bands`** — visual layers in data-flow order, e.g.
  `UI → stores → transport → │wire│ → app → handlers → core → persistence → plugins`.
- **`spine`** — the critical request path (the hubs every request crosses).
- **Each module** — `id, label, band, path, paths (globs), coupling, deps, desc, score,
  grade, tags, findings, tests, lastFix, hash`. `desc` is a 1-line "what it does" (shown on
  click) authored in `meta.lang`.
- **`coupling`** — structural centrality: one of `low / med / high / core`; `core` = the
  spine hubs. **Coupling and score are independent** (structural vs quality); the map can
  color by either.
- **`hash`** — a content hash per module. Comparing hashes against the working tree yields
  the three derived states used throughout: **stale** (code changed since audit),
  **unaudited** (new module, no score), **empty** (paths match nothing → likely a deleted
  module). The re-audit set is `stale + unaudited`.

Because the outputs are derived, **commit `modules.json`** so audit history and incremental
diffs stay reviewable. Same state file → identical HTML / MD (determinism).

## Standard — scoring, severities, tags

Upstream, the scoring rubric, smell taxonomy, severity levels, and the required per-module
subagent prompt were fixed in `reference/STANDARDS.md`, with a machine-readable copy in
`reference/standard.json`. Those files are **not bundled**. The rules that must hold anyway:

- **Do not improvise scoring or invent tags.** Fix the ruler *before* the first audit and
  record it (in `meta`/config) so every module is graded on the same scale by every auditor.
- **Score → grade.** Modules carry a numeric score and a letter grade `A–F` (A best, F
  worst), mapped monotonically from the score. The exact numeric cutoffs lived in the
  undistributed standard; if it is unavailable, **declare your own cutoffs** (state the
  range behind each letter) and apply them identically to every module — never re-tune
  mid-run. Audit scope is then controlled by grade: "grade C and below", "D/F modules", etc.
- **Finding severity** — `HIGH | MED | LOW`. Judgement criteria, since the upstream
  definitions are missing: **HIGH** = a structural or architecture-boundary problem the
  module's owner must act on (a behavioural defect or correctness hazard is not scored into
  this rubric); **MED** = a real, growing
  maintenance cost; **LOW** = cosmetic or consistency-only. State the criteria you use and
  hold them constant.
- **Tag set.** A tag names the *kind* of problem (`dual-format`, `glue`, …). The full tag
  list lived in `standard.json`; only examples survive here. **Honor the project's tag
  set:** when `<project>/.codemap/standard.json` exists, audit modules using *its* tags
  (including any custom tags the user added) — that is how users capture their own
  definition of a problem. With no project standard, define a small fixed tag vocabulary
  for the run, write it into the state/config, and use it consistently.
- **The standard is configurable per project.** A project may override the skill default by
  placing its own `standard.json` next to the state file (`<project>/.codemap/standard.json`);
  the project file wins over the skill default, and its rubric / severities / coupling / tag
  list are what you apply and what the map's editable **Standard** page shows.
- **Keep the prose standard and the machine copy in sync** whenever you change the defaults.

**The per-module audit contract** (what the missing `STANDARDS.md` subagent prompt required,
restated as requirements): audit **one** module against **its** `paths`; grep markers and
read only the flagged regions (a huge file is scored from its size + a few excerpts, not a
full read); apply the fixed rubric; emit **only** a JSON object shaped as the audit result
(module id + score + grade + tags + `findings[{severity, …}]`). On receipt, validate the
result's shape and internal consistency (grade must agree with score; tags must be from the
active tag set) and **reject malformed or inconsistent results** rather than merging them.

## Directory conventions

**Everything lives under `<project>/.codemap/`** — one folder, not `.claude/`:

- `config.json` — the user's saved preferences (UI language, output location, title…).
- `modules.json` — the state (source of truth).
- `standard.json` — optional per-project custom audit standard.
- `codemap.html` + `codemap.md` — the generated outputs (default).

The output location is a user preference: if the user wants the HTML/MD committed/visible,
let them point it at `docs/` instead (ask). Set `meta.htmlPath` / `meta.mdPath` to wherever
the outputs land so the reciprocal links are correct (both outputs sit in the same dir, so
the in-page link uses the basename). Re-read `config.json` on later runs so preferences
persist.

## Targeting modules without reading the whole state

`modules.json` can be large. To decide what to audit / fix / test, **do not read the whole
file** — select exactly the modules you need and consume just ids, file globs, or findings.
This keeps agent context small. Filters (AND-combined):

- **`max-grade`** — that grade **and worse** (feed a fix/audit loop).
- **`min-score` / `max-score`**.
- **`tag T`** — repeatable; match **any** tag by default, or require **all** with a
  match-all option.
- **`severity`** — `HIGH | MED | LOW`.
- **`band`**, **`coupling`**.
- **`needs-audit`** — the stale + unaudited set (what needs re-auditing).

Output **form**: `ids` (drive the per-module subagent loop), `paths` (read ONLY the relevant
source), `findings` (the exact items to fix, as text), `table`, `json`, or `count`. Use
`paths` to read only the relevant source and `ids` to drive the audit loop — never load the
full `modules.json` just to pick targets.

## Hard rules

1. **Every module score comes from an independent sub-task.** One sub-task audits one module
   against its `paths`, using the audit contract in *Standard*. Never score inline in the
   main thread; never copy one module's score to another. Run them in parallel where the
   platform supports it (see *Capabilities & platform mapping*).
2. **Mechanical steps make no quality judgments; only decomposition, auditing, and
   theme-synthesis are model work.** Size/LoC counting, content hashing, and rendering the
   artifacts are deterministic (this is the half the removed `scan.py` / `render.py` /
   `apply_audit.py` did — reproduce it by hand or with the harness, and note it never
   judges quality).
3. **`modules.json` is the only thing you edit by hand** (structure/decomposition). HTML/MD
   are derived. Recompute LoC/hashes for changed modules before every regeneration so
   staleness is accurate.
4. **Functional modules, not files.** A module is a capability (a store, a handler group, a
   feature folder, a plugin). Map each to a glob set in `paths`. Give every module a 1-line
   `desc` ("what it does", shown on click) authored in `meta.lang` (set `meta.lang` to
   `"zh"`/`"en"`; it localizes the UI chrome — module names/ids are never translated).
5. **Four separate, independent subagent roles — never merge two:**
   **auditor** (scores quality), **test-author** (writes tests), **fixer** (changes code),
   **acceptance/verifier** (proves no regression). A fix is accepted ONLY when an independent
   acceptance subagent shows the pre-fix green tests are still green and the build/typecheck
   is clean. A fixer may not write/edit its own tests or grade its own work — that defeats
   the gate.

## Capabilities & platform mapping

This workflow needs three capabilities. Each has a graceful fallback, so it runs on any
agent — only the convenience changes, never the rules above.

| Capability | Native (Claude Code) | Codex / Cursor | Fallback if unavailable |
|---|---|---|---|
| **Independent sub-tasks** (one auditor/fixer per module) | `Agent` tool, many in parallel | their subagent/task tool | Audit modules **one at a time in the main thread** — still one module per pass against the rubric, never batch-scoring. Slower, fully valid. |
| **Structured result** (the audit JSON) | `schema` on the Agent call | tool-specific schema, or just ask for JSON | Ask the sub-task to return **only** the JSON object; validate it yourself against the audit contract and reject malformed/inconsistent results — no schema feature required. |
| **Ask the user** (preferences at build time) | `AskUserQuestion` | tool's prompt UI | Ask in plain text, or apply defaults (`lang=en`, output `.codemap/`, title = repo folder name) and tell the user how to change them in `.codemap/config.json`. |

The non-negotiables (independent per-module audit, mechanical steps are deterministic, the
four-role fix gate) hold on every platform; the table only changes *how* you spawn the work.

## Token efficiency

Almost all the cost is the per-module audit sub-tasks reading code — the mechanical steps
are nearly free. Levers, biggest first:

1. **Audit on the cheapest capable model.** The audit is read-code + apply-fixed-rubric +
   emit-JSON; a small/fast model does it well, and the result is validated on receipt
   (malformed output is rejected). Keep the top model for decomposition, theme synthesis,
   and fixes only.
2. **Read targeted, not whole.** The audit reads markers and only the flagged regions; a
   huge file is scored from its size + a few excerpts, not a full read. Select `paths` so a
   sub-task opens only its module's files.
3. **Batch the small modules.** Group tiny / low-coupling leaves (≤ ~150 LoC) into one
   sub-task that audits each *independently* (per *Standard*). Core / large / high-coupling
   modules stay solo. This cuts the *number* of spawns (each spawn re-pays system-prompt +
   rubric overhead). Select all modules then group by LoC/coupling.
4. **Update, don't rebuild.** After the first build, only ever run an incremental update —
   it re-audits just the git-changed modules (`needs_audit`), so steady-state cost is tiny.
5. **Structure-first for big repos.** Do the first build in **structure-only** mode
   (decompose + sizes/hashes + render, *no audits*) to get the map and LoC instantly and
   cheaply; the HTML renders unscored modules fine. Then fill scores over time with
   incremental updates / on-demand audits, cheapest-first or worst-suspected-first.

---

## Phase 1 — initial build (first map)

Use when no `modules.json` exists yet.

0. **Ask the user for preferences first** (use `AskUserQuestion` if available, else just ask
   in plain text; or apply the defaults from *Capabilities & platform mapping*), then save
   them to `<project>/.codemap/config.json`:
   - **UI language** — `en` or `zh` (localizes the map chrome + report; module names are
     never translated). → `meta.lang`.
   - **Output location** — where the HTML/MD go. Default `.codemap/` (kept with the tool
     data); offer `docs/` if they want them committed/visible. → `meta.htmlPath` / `meta.mdPath`.
   - **Project title** (defaults to the repo/folder name) and an optional one-line subtitle,
     in the chosen language. → `meta.project` / `meta.subtitle`.

   Write `config.json` like:
   ```json
   {"lang":"zh","project":"My App","subtitle":"…","outputDir":".codemap",
    "htmlFile":"codemap.html","mdFile":"codemap.md"}
   ```
   and apply it to `meta` when you build `modules.json`. Re-read `config.json` on later
   runs so preferences persist.
1. **Decompose the project into functional modules.** Explore the tree (parallel Explore
   agents for big repos). Identify capabilities and group them into **bands** (visual
   layers in data-flow order, e.g. UI → stores → transport → │wire│ → app → handlers →
   core → persistence → plugins). For each module record `id, label, band, path, paths
   (globs), coupling, deps, desc`. Add `bands`, `spine` (the critical request path), and
   `meta` (project, htmlPath, mdPath, spineDesc). Write this to `modules.json` (no scores
   yet). Coupling = structural centrality (low/med/high/core); core = the spine hubs.
2. **Compute size:** LoC per module + a content hash per module. Every module starts
   `unaudited`.
3. **Audit — one independent sub-task per module, in parallel.** For each id in
   `needs_audit`, spawn a sub-task with the audit contract (see *Standard*), filled with the
   module's label/paths. Collect each JSON result, validate it, and write it back into the
   state (record the git rev the audit was taken against). Run on the cheapest capable
   model, read targeted excerpts, and batch the small/leaf modules per *Token efficiency* +
   *Standard*. **Structure-only mode:** for a huge repo (or a fast/cheap first pass) you may
   SKIP this step entirely — render the map with no scores (it renders unscored modules
   fine), then fill scores later with an incremental update.
4. **Synthesize `reportThemes`** (4–7 cross-cutting patterns) from the collected findings
   and write them into `modules.json`.
5. **Render + stamp.** Regenerate the HTML + MD from `modules.json`, then **stamp the git
   baseline** into `meta.rev` (the current HEAD) so future updates can diff from here.
   Report the result: avg score, grade spread, worst offenders, and the two artifact paths.

## Phase 2 — check (is the map current? — read-only)

Use when the user asks "is the architecture map up to date / still accurate?".

1. Recompute LoC/hashes (no write).
2. Read the comparison: report `up_to_date`, the **stale** list (code changed since audit),
   **unaudited** (new modules with no score), and **empty** (paths match nothing → likely
   deleted modules). The git view shows the **commits since the last codemap run**
   (`meta.rev`) and which modules they touched — surface those commits so the user sees
   recent history at a glance. Do **not** modify anything; offer to run an incremental
   update.
3. Also sanity-check for *new* capabilities not yet in `modules.json` (a quick look at new
   top-level dirs / large new files). New modules are model-discovered, not scan-detected.

## Phase 3 — update (incremental refresh, git-aware)

Use after code changes, or when `check` found drift. Re-audits only what changed, and uses
git to show recent history and scope the work.

1. **Reconcile structure first** (cheap): if modules were added/removed/renamed, edit
   `modules.json` (add new module entries with `paths`; drop `empty` ones; fix globs).
2. **Recompute size + git diff.** Recompute LoC/hashes. Read the **`git`** view: `commits`
   (since `meta.rev`, the last run) and `changed_modules` (modules those commits touched).
   Show the user the recent commits — the fast "what changed" view. The audit set is
   `needs_audit` (= stale + unaudited); content-hash staleness already includes everything
   `changed_modules` lists (plus any uncommitted edits), so re-audit `needs_audit`. If `git`
   is null the project isn't a git repo — fall back to content-hash staleness only.
3. **Re-audit only those modules**, each with its own independent subagent (same protocol
   as the initial build, step 3). Record each fresh audit against the current HEAD. Fresh
   modules keep their cached audit — that is the whole point of the content hash.
4. **Refresh `reportThemes`** if the changes are material (otherwise keep them).
5. **Render + stamp.** Regenerate the outputs, then **stamp the baseline** (current HEAD →
   `meta.rev`), so the next update/check diffs from here. Summarize which modules were
   re-scored and how their score moved, with the commits that caused it.

## Phase 4 — test `<module>` (generate tests)

A **test-author subagent** generates tests for a module — independently of fixing. This is
also the prerequisite for a safe fix (it builds the regression net). Two modes:

- **characterization** (default before a fix): lock the module's CURRENT observable
  behavior so a later change can't silently alter it. Assert "same as today", not "correct".
- **coverage**: add missing unit tests for the module's public surface and the behaviors
  named in its `findings`.

Steps:
1. **Detect the repo's test framework + location** (pytest / jest / vitest / go test / …)
   from existing tests near the module; match their style and placement. Do NOT invent a
   new framework or harness.
2. **One test-author subagent** writes tests against the module's `paths`, runs them, and
   iterates until green on the CURRENT (unmodified) code. It reports: files added, what
   behavior is now locked, and a coverage note. If a test only passes by asserting a known
   bug, it must FLAG the bug, not bake it in as desired behavior.
3. **Tests are real source** — they stay in the tree (they are the regression net). Record
   their globs in the module's `tests` field in `modules.json`. Recompute sizes/hashes and
   regenerate (test LoC is tracked but excluded from the module's own audit scope).

Keep test-author distinct from fixer and auditor.

## Phase 5 — fix `<module-or-finding>` (auto-fix, regression-gated)

Use when the user says "fix the findings in module X" / "auto-fix the worst offenders". A
fix is **only accepted if an independent acceptance subagent proves no regression.** Four
separate subagents (hard rule 5): test-author → fixer → acceptance → auditor.

1. **Scope (by selection).** Resolve the target set by the *Targeting* filters instead of
   reading the whole state — e.g. "grade C-and-below" + "tag dual-format" → ids for "all
   C-and-below dual-format modules"; then select `findings` for just the findings to fix and
   `paths` for just the files to read. Confirm with the user before risky fixes (duplication
   merges, dual-format removal touching a protocol, deleting "dead" code — first verify it is
   truly unused).
2. **Baseline (test-author subagent).** Ensure the module has tests that lock its CURRENT
   behavior; if coverage is thin, run Phase 4 (characterization) first. Run the module's
   tests + the narrowest build/typecheck on the UNMODIFIED code and record the **green
   baseline** (which tests pass, build/type status, key outputs). If you can't get a green
   baseline, STOP and tell the user — auto-fixing without a behavioral net is not safe.
3. **Fix (fixer subagent, `isolation: "worktree"`).** Give it the module's paths, findings,
   and the *Standard* rules; implement the fix and preserve behavior. The fixer **must not
   edit tests** (no moving the goalposts) and must not touch files outside its paths without
   flagging.
4. **Acceptance gate (independent verifier subagent — NOT the fixer).** Re-run the SAME
   baseline tests + build/typecheck on the fixed code. Return
   `{pass: bool, regressions: [...], evidence: "..."}`. **PASS only if every baseline-green
   test is still green and there are no new build/type errors.** On FAIL: report the
   regression with evidence and revert / hand back to the fixer — do not accept.
5. **Re-audit (auditor subagent, independent).** Only after PASS: re-score the module →
   recompute sizes/hashes → render. Show **before/after score AND the acceptance evidence**
   (tests run, all green, build clean).
6. **Never auto-commit unless asked.** Report honestly — a fix that fails the gate is
   reported as failed, not merged. Record the outcome in the module's `lastFix` field.

---

## Notes

- **Languages:** the engine is language-agnostic — `paths` globs and LoC counting work for
  any stack; the subagent reads whatever code the globs point at.

## Provenance

- Source repo: https://github.com/Asixa/codemap-skill
- Original path: SKILL.md (repo root)
- License: unknown - see repo
- 并入说明（2026-09-07）：下载并归一为单文件（frontmatter 仅 name/description）；原仓库配套技能/辅助文件未随附，需要时回上游取用。
- Integration note (2026-09-07): fetched and normalized to single-file; sibling skills and auxiliary files of the source repo are not bundled - see upstream.
