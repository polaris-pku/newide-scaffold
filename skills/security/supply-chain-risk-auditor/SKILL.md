---
name: supply-chain-risk-auditor
description: "Audits dependencies for supply-chain risk, covering version-matched advisories over direct and lockfile trees, abandoned or archived upstreams, npm publisher concentration, and install-time scripts. Use when auditing dependencies or third-party risk."
---

# supply-chain-risk-auditor

> 蒸馏自 trailofbits/skills（仓库内路径 plugins/supply-chain-risk-auditor/skills/supply-chain-risk-auditor）。原为 13 文件（SKILL.md + scripts/ 下 collect/render/model/sources 四个 Python 模块与测试 + uv.lock + pyproject.toml + agents/openai.yaml + svg）；collect.py/render.py/model.py/sources.py 的检查逻辑已文字化为下表与判定规则，测试与界面配置省略。
> Distilled from trailofbits/skills (`plugins/supply-chain-risk-auditor/skills/supply-chain-risk-auditor`); originally 13 files; the logic of the collect/render/model/sources scripts is textualized below.

Generates a supply-chain risk report for a project's direct dependencies (npm, PyPI, Go), plus an advisory sweep of everything its lockfile resolves. In the upstream repo, two deterministic scripts do the measuring; your job is the judgment they refuse to automate. What follows reproduces their measurement and verdict rules as text, so the audit can be understood, planned, and reproduced.

## When to Use

- When asked to audit dependencies, assess supply-chain or third-party package risk, or review a dependency tree before an engagement.
- Input: a project directory with manifests (`package.json`, `pyproject.toml`, `requirements*.txt`, `go.mod`). If none exist, say so and stop — do not audit an ecosystem this collector does not parse by hand.
- Output: a supply-chain risk report over the direct dependencies plus an advisory sweep of lockfile-resolved transitive packages, with a coverage table bounding every claim.

## When NOT to Use

- License compliance auditing.
- Scanning the target's own source for vulnerabilities or secrets — this skill never reads dependency source, only registry, advisory, and repository metadata.
- Judging whether the project installs or builds — the audit works from nothing more than the dependency list (manifests and lockfiles), never installs, builds, or executes anything. Broken installs and import-time breakage are out of scope, and worth saying so if the user seems to expect them.
- Ecosystems other than npm, PyPI, and Go — say the ecosystem is unsupported rather than improvising an audit for it.

## Core Principles

Every figure in this report is a claim about somebody else's project, and hand-collected figures were measured wrong before this skill was rebuilt around scripts: GitHub contributor counts said five-plus people maintain `lodash` where npm's ACL says one, and `gh` saw zero downloads for a package that moves 164 million a week. **Do not estimate maintainer counts, downloads, staleness, or CVE history from `gh`, web search, or memory — measure, and quote what was measured.**

Two rules the tooling is arranged to enforce rather than remember:

- **Unavailable data is never evidence of risk.** Every criterion resolves to assessed-clean, assessed-flagged, or unassessable-with-a-reason.
- **An absent measurement is never a clean verdict.** A run that measured nothing exits non-zero instead of printing a report that finds nothing; an empty answer from a vulnerability database means "no advisories" only for a package known to exist in its registry.

### Rationalizations to reject

- "`gh` can give me maintainer counts faster than the collector." Measured wrong — repo contributors and registry publish rights are different populations.
- "No findings, so the dependencies are safe." Read the coverage table; on PyPI and Go, half the criteria are structurally unassessable.
- "The unassessable rows would just confuse the reader; I'll drop them." They are the boundary of every claim in the report. Dropping them turns partial coverage into a clean bill of health, which is the failure this skill was rebuilt to prevent.
- "The version is probably close enough." A range checked at latest-release and a lockfile-resolved version are different claims; the report labels which one it makes. Keep the label.

## What is measured, and how each criterion is decided

### Dependency discovery and identity

- **Manifest sources:** npm (`package.json` — `dependencies` and `optionalDependencies` are installed by default and included; `devDependencies` marked dev-only), PyPI (`pyproject.toml` / `requirements*.txt`, dev-groups and environment markers handled), Go (`go.mod` direct `require`s). Missing or unreadable manifests produce notes, never silent zeros.
- **Version resolution** is recorded per dependency as one of: `lockfile` (exactly what the project installs), `manifest-pin` (exact pin in the manifest), `go-mod-minimum` (go.mod's minimum; module-version selection may build higher), `latest-release` (the registry's current release, not the project's choice — used when the manifest gives a range and no lockfile pins it), or `unresolved`. Advisory verdicts state which of these the claim rests on; a range checked at latest release is a weaker claim than a lockfile-resolved version.
- **Lockfiles read for exact versions and the transitive sweep:** `package-lock.json` / `npm-shrinkwrap.json` (npm 7+ flat `packages` table), `uv.lock`, and a Go 1.17+ `go.mod`. `yarn.lock`, `pnpm-lock.yaml`, and `poetry.lock` are **not read** — the report says so when they are present, and versions fall back to pins or the latest release.
- **Non-registry resolution:** a dependency resolving from `file:`, `workspace:`, git, or a vendored directory is never looked up by registry name — a same-named public package's advisories, publishers, and deprecation belong to code the project does not install. Every criterion becomes unassessable for it, with the shared reason naming the source.
- **Registry existence matters:** registry identity is confirmed before empty answers are read as clean; an attested npm entry carries an integrity hash for a registry tarball; entries without attestation (git/file/private-registry) are "unverifiable" and named as such.

### Criteria and verdict rules

Tier A — comparable across every ecosystem; only these reach the headline verdict:

| Criterion | Flagged when | Clean when | Unassessable when |
|---|---|---|---|
| **Advisories** (OSV, keyed by ecosystem+package — never by repo) | OSV records advisories affecting the resolved version; the verdict quotes the count, the advisory IDs, and exactly which version claim is made | "No advisories recorded" — only if the package is confirmed to exist | OSV did not answer; or empty answer for a package whose existence is unconfirmed |
| **Deprecated / yanked** | npm: deprecation message present on the package; PyPI: the resolved release is yanked | Not deprecated / release not yanked | Go: deprecation lives in the module's own `go.mod`, which is not read; PyPI: metadata unreadable |
| **Repository archived** (GitHub) | Repo `archived` flag true | Repository active | No source repository resolved; API error / rate limit |
| **Staleness** (last-push date) | No push in > **730 days** (two years) — verdict states duration and last-push date; sub-60d in days, then months, then years | Pushed within 730 days (negative delta = "pushed today", clock ahead) | No last-push date; unparseable; no timezone; rate-limited |

Tier B — registry-dependent (npm publishes these; PyPI publishes none; Go has no registry):

| Criterion | Flagged when | Clean when | Unassessable when |
|---|---|---|---|
| **Publisher concentration** (npm) | Exactly **one human** publisher on the current publish ACL (verdict names the maintainer and the listed total; bot-looking accounts excluded and named as a guess) | ≥ 2 human publishers hold publish rights | Package publishes from CI **with provenance** (effective publisher set = whoever can merge to the release branch — not externally observable); registry lists no maintainers; every listed maintainer looks automated; PyPI / Go structurally |
| **Install-time script execution** (npm) | Package runs an install script — flag text notes `npm ci --ignore-scripts` prevents execution | No install script | PyPI: depends on whether a wheel or an sdist is installed |

OpenSSF Scorecard — individual checks only, never the aggregate score (aggregate tracks project size and hygiene, not takeover risk): each check scored 0–10; only the two that name a concrete mechanism can flag — **Dangerous-Workflow** and **Binary-Artifacts** flag at score < 10 (an actual script-injection/untrusted-checkout pattern; binaries committed to the repo that nobody can review). **Token-Permissions** and **Code-Review** are measured and reported but can never flag (they describe CI-configuration maturity, which correlates with project size rather than with the likelihood of malicious code being published; Code-Review largely restates publisher concentration). Scorecard not evaluated for a repo, or not reported for a check, is unassessable — never clean. All four are separated in the report as *upstream repository and CI hygiene* because the audited project cannot change a third party's repository.

Informational — measured and counted, never flagged, phrased as proportions so absence reads as a number: **publish provenance** ("N of M publish with build provenance"), **security policy** ("N of M publish a security policy" — GitHub 404 on SECURITY.md is evidence of none; rate-limit is not), and **download volume** (npm weekly downloads; < 1,000/week is labelled "low volume" — an absolute floor, not a rank; PyPI and Go are unassessable). Downloads exist for prioritisation context, not as a finding.

### Transitive sweep

Every registry-verified package resolved by a supported lockfile beyond the direct set is checked for advisories at its locked version (batched OSV queries, ≤500 per batch). Unverifiable entries (no integrity/registry attestation) are listed separately with a reason and never folded into the "checked" count. The sweep's accounting is reconciled (total = checked + unverifiable, when no stated reason) so a dropped entry cannot silently shrink the sweep; "the transitive tree was not examined" must always carry a reason.

### Data-source facts worth knowing (from the collector)

- npm's full packument for popular packages is **invalid JSON** (unescaped control characters — lodash's 247KB response is rejected by `jq`); parse with `json.loads(..., strict=False)`.
- The packument-level `.maintainers` is the *current* publish ACL; the version-level list is a publish-time snapshot and disagrees (lodash reads 1 current against 3 at v4.18.1). Publisher-concentration verdicts use the current ACL.
- OSV advisories must be keyed by ecosystem+package; repo-keyed queries under-report (3 vs 5 for lodash).
- deps.dev keys Go versions *with* a `v` prefix; OSV wants it stripped.
- GitHub reports primary rate-limit exhaustion as **403** with `x-ratelimit-remaining: 0`, not 429 — matching only 429 misses the throttle that actually happens.
- HTTP caching is bounded (≈6 hours): entries older than the bound are refetched when online, so a stale cached `pushed_at` cannot manufacture staleness flags. The cache lives outside the audited repository.

## Workflow

1. Confirm the target directory has supported manifests (see When to Use). None → say so and stop.
2. Check `gh auth status`. Unauthenticated GitHub allows 60 requests/hour against 5,000, and the collector makes several per dependency; expect repository criteria (archived, maintenance activity, security policy, Scorecard) to come back unassessable without it. Say so rather than fixing it silently.
3. Measure, then render. The reference collector/renderer live in the upstream repo; put outputs somewhere outside the audited repository unless asked otherwise. Expect a few minutes for ~50 dependencies — several HTTP requests per dependency, more with many Go modules, and slower without authenticated `gh`. If the collector exits non-zero, it is refusing to report (no dependencies found, or an artifact that cannot reconcile) — relay its message verbatim instead of retrying or working around it.
4. Read the rendered report and the machine artifact. The report is the deliverable; the JSON carries the datum behind every verdict when you need to cite one.
5. Add what the measurement cannot, clearly separated from what it measured:
   - A short narrative for this reader: what to act on first, and why.
   - Upgrade paths for advisory findings — check whether the fix is a patch or a major version away.
   - Replacement candidates for abandoned or archived dependencies. Verify a candidate exists in the registry before naming it, and label these as judgment, not measurement.
   - For flagged install scripts: whether `npm ci --ignore-scripts` is viable for this project's build.

## Reading the report

- **The coverage table bounds every claim.** "No advisories" means "none among what was assessed" — check the assessed count before repeating a clean verdict.
- **Quote figures verbatim.** Do not re-derive, round, or embellish the report's numbers; every one is reproducible from the artifact.

Report layout (renderer order, chosen for blast radius): header (subject, scanned path, commit, manifests read, scan time, direct-dependency count by ecosystem) → **Summary** (advisory headline that is honest about version sources — "checked at the versions this project resolves" is only claimed when every version came from the project; otherwise it names how many were latest-release/go.mod-minimum fallbacks; transitive summary; N of M flagged and how many reach production; and the **weakest coverage** figure — the criterion established for the fewest dependencies, because a reader must not infer safety from silence) → production-dependency section → findings (Tier A+B first, then upstream Scorecard hygiene separately) → transitive advisories → informational counts → per-tier coverage table → not-assessable rows → method and caveats (scope notes, unread lockfiles, umbrella-package caveat — e.g. rails 5.0.0 reports 0 advisories where actionpack 5.0.0 reports 10 — cache statistics). Third-party strings are escaped into report prose/tables (newlines collapsed, `|` and `[` escaped, backticks neutralised in code spans) so hostile deprecation text cannot forge headings or truncate tables.

## Style for what you add

Write added prose the way a security report reads, and apply the same register to the report addendum and the final reply alike — replies get pasted into tickets and reports verbatim. State the finding, the datum behind it, and the action.

- Impersonal and declarative: no first or second person ("I ran the collector", "you should upgrade"), no contractions, no exclamation points.
- Active voice, with the subject matter as the actor: "upgrading to 1.19.0 clears all 25 advisories", not "it is recommended that axios be upgraded".
- Objective: no intensifiers or subjective framing ("very", "significant", "fortunately"), and no guesses about why the project chose what it chose.
- Tense: past for what the audit did, present for the state of the dependencies, future for the consequences of acting or not.
- Constructive: a recommendation names the action and its cost, never a culprit.

Tooling note: the upstream implementation assumes `Read`/`Write`/`Bash`/`Glob`/`Grep` tool access (original frontmatter `allowed-tools`) for running collectors and reading artifacts; the criteria logic above is what those tools measure.

## Provenance

- Source repo: https://github.com/trailofbits/skills
- Original path: `plugins/supply-chain-risk-auditor/skills/supply-chain-risk-auditor`
- License: unknown — see repo
- 蒸馏说明：原 13 文件（SKILL.md + scripts/：collect.py ≈66KB、render.py ≈35KB、sources.py ≈29KB、model.py ≈18KB 及 4 个 pytest 测试 + pyproject.toml + uv.lock + agents/openai.yaml + 品牌 svg）。四个 Python 模块的判定逻辑已按 criterion 表格文字化：信号三态模型（assessed-clean / assessed-flagged / unassessable-with-reason，clean 必须带 datum）、Tier A/B/Scorecard/Info 分层与"哪些只测不报"、staleness 730 天与 downloads 1000/周阈值、Scorecard 仅 Dangerous-Workflow 与 Binary-Artifacts 可 flag、OSV/包名/时区/缓存等数据源注意点、render 报告结构与防伪造 Markdown 转义。未逐行保留的细节（HTTP 客户端实现、批处理大小、确切措辞）需要精确内容时见原仓库 scripts/。
