---
name: code-security-audit
description: Audits code changes, diffs, or PRs to find high-confidence exploitable vulnerabilities via three-phase analysis with strict false-positive filtering. Use for audit security, security scan, or audit-this-PR requests.
---

# code-security-audit

> 蒸馏自 LeonMelamud/claude-code-security-review（仓库根目录 `.`）。原为 37 文件（SKILL.md + Python 审计引擎包 + GitHub Action + JS 注释脚本 + references/assets + evals 场景）；脚本自动执行的管道已文字化为流程/信号/判定规则，辅助文档全文内联。
> Distilled from LeonMelamud/claude-code-security-review (repo root); originally 37 files (Python audit engine, GitHub Action, JS PR-comment script, references, evals) with the script-driven pipeline textualized below.

AI-powered security audit for code changes with false positive filtering. Engine upstream of [anthropics/claude-code-security-review](https://github.com/anthropics/claude-code-security-review); this fork packages the audit as an agent skill plus a GitHub Action CI runner.

> 整合说明（2026-09-07）：官方 Anthropic security-review 适配件（同源同输出契约）已并入本技能。
> Integration 2026-09-07: the official Anthropic security-review adaptation (same source, same output contract) was folded into this skill.

## When to Use

- When asked to "audit security", "review for vulnerabilities", "security scan", "check for security issues", "audit this PR", "review these changes for security", or "find vulnerabilities in diff".
- Input: a code change set — a branch diff against `origin/main`, staged changes, last N commits, or a GitHub PR.
- Output: a set of HIGH/MEDIUM findings only, each with file, line, severity, category, confidence, description, exploit scenario, and recommendation.
- This skill actively audits a concrete diff (not a checklist or template scan) and filters to high-confidence, exploitable issues.

## Core Principles

1. **Minimize false positives** — only flag issues with >80% confidence of actual exploitability.
2. **Skip noise** — no theoretical issues, style concerns, or low-impact findings.
3. **Focus on impact** — prioritize unauthorized access, data breaches, system compromise.
4. **Only new issues** — do not comment on pre-existing security concerns.
5. **Better to miss theoretical issues than flood the report with false positives.** Each finding must be something a security engineer would confidently raise in a PR review.

## Workflow — Manual Audit

### 1. Gather the changes

```bash
git diff --merge-base origin/main        # Branch diff
git diff --cached                         # Staged changes
git diff HEAD~N                           # Last N commits
git diff --name-only origin/main...       # List modified files
```

### 2. Three-Phase Analysis

**Phase 1 — Context Research:** identify security frameworks, ORMs, auth libraries, sanitization patterns, and trust boundaries in the codebase (repository exploration tools).

**Phase 2 — Comparative Analysis:** compare the new code against established secure patterns in the same codebase; flag deviations, inconsistent security implementations, and new attack surfaces.

**Phase 3 — Vulnerability Assessment:** check each modified file for the categories below; trace data flow from user inputs to sensitive operations; look for privilege boundaries crossed unsafely; identify injection points and unsafe deserialization.

### 3. Categories to Examine

- **Input Validation:** SQL injection, command injection, XXE, template injection, NoSQL injection, path traversal.
- **Auth & Authz:** auth bypass, privilege escalation, session flaws, JWT vulnerabilities, authorization-logic bypasses.
- **Crypto & Secrets:** hardcoded keys/tokens/passwords, weak cryptographic algorithms, improper key storage/management, randomness issues, certificate-validation bypasses.
- **Code Execution:** RCE via deserialization, pickle injection, YAML deserialization, eval injection, XSS (reflected, stored, DOM-based).
- **Data Exposure:** sensitive data logging/storage, PII violations, API endpoint leakage, debug-information exposure.

Additional note: even local-network-only exploitability can still be HIGH severity.

### 4. Filter False Positives

Apply the full False Positive Filtering section below to every finding. Assign a confidence score of 1–10 and **keep only findings with confidence ≥ 8**. For domain-specific categories, apply the matching custom scan template (see Customization).

### 5. Report

Emit each surviving finding in the Output Format below.

## False Positive Filtering

Apply these rules to every finding before including it in the report.

### Hard Exclusions — automatically remove

1. **DoS/Resource Exhaustion** — denial of service, resource exhaustion, infinite loops, unbounded recursion.
2. **Rate Limiting** — missing-rate-limiting recommendations.
3. **Resource Leaks** — unclosed files/connections, memory leaks, file descriptor leaks.
4. **Open Redirects** — unvalidated redirect vulnerabilities (low impact).
5. **Regex Injection** — injecting untrusted content into regex; regex DoS.
6. **Memory Safety in Non-C/C++** — buffer overflows, use-after-free, null-pointer dereference in Rust, Go, Python, JS, etc. (only valid in C/C++).
7. **SSRF in Client-Side Code** — SSRF in `.js`/`.ts`/`.tsx`/`.jsx` files (client-side cannot bypass firewalls); HTML too.
8. **SSRF Path-Only** — SSRF that only controls path, not host or protocol.
9. **Test Files** — findings in `*_test.*`, `*.test.*`, `__tests__/`, or files only used for testing.
10. **Documentation** — findings in `.md`, `.rst`, or other documentation files.
11. **Secrets on Disk** — secrets/credentials stored on disk (managed by separate processes).
12. **Log Spoofing** — outputting unsanitized user input to logs is not a vulnerability.
13. **Missing Hardening** — lack of security best practices without a concrete vulnerability.
14. **Theoretical Race Conditions** — only report race conditions that are concretely problematic.
15. **Outdated Dependencies** — managed separately, not reported here.
16. **Crash-Only Bugs** — undefined/null variables that crash but aren't exploitable.
17. **AI Prompt Injection** — user-controlled content in AI system prompts is not a vulnerability.
18. **Internal Package Dependencies** — depending on non-public internal libraries is not a vulnerability.
19. **Log Query Injection** — only report if it definitely exposes sensitive data to external users.
20. **Path Traversal in HTTP** — `../` in HTTP request paths is generally not exploitable; only relevant for local file reads.

### Signal Quality Criteria

For findings that pass the hard exclusions, assess:

1. Is there a **concrete, exploitable vulnerability** with a clear attack path?
2. Does this represent a **real security risk** vs. theoretical best practice?
3. Are there **specific code locations** and reproduction steps?
4. Would this finding be **actionable** for a security team?

### Precedents — framework/context-specific rules

1. **Logging** — logging high-value secrets in plaintext IS a vulnerability; logging URLs is safe; logging request headers is dangerous (likely contain credentials); logging non-PII data is NOT a vulnerability.
2. **UUIDs** — unguessable; vulnerabilities requiring UUID guessing are invalid.
3. **Environment Variables & CLI Flags** — trusted values; attacks requiring control of env vars are invalid.
4. **React/Angular XSS** — secure by default; only report XSS using `dangerouslySetInnerHTML`, `bypassSecurityTrustHtml`, or similar unsafe methods (also applies to `.tsx`).
5. **GitHub Actions** — most workflow vulnerabilities are not exploitable in practice; require a concrete attack path with untrusted input.
6. **Client-Side Auth** — lack of permission checking in client-side JS/TS is NOT a vulnerability; server-side handles auth.
7. **Jupyter Notebooks** — most notebook vulnerabilities are not exploitable; require a concrete attack path with untrusted input.
8. **Shell Scripts** — command injection is generally not exploitable (no untrusted user input); require a specific untrusted-input path.
9. **Subtle Web Vulns** — tabnabbing, XS-Leaks, prototype pollution, open redirects are invalid unless extremely high confidence.
10. **Audit Logs** — missing or modifiable audit logs is NOT a vulnerability.
11. **MEDIUM Findings** — only include if obvious and concrete.
12. **Path Traversal in Client Code** — `../` attacks are not a problem in client-side JS.

### Confidence scoring

1–3: low confidence, likely false positive or noise. 4–6: medium, needs investigation. 7–10: high, likely true. **Report threshold: ≥ 8.** The audit prompt's finer scale (0–1) maps as: 0.9–1.0 certain path (test if possible); 0.8–0.9 clear pattern with known methods; 0.7–0.8 suspicious, needs specific conditions; below 0.7 do not report.

## Output Format

Per finding (manual markdown):

```markdown
# Vuln N: [Category]: `file.ts:42`

* Severity: HIGH | MEDIUM
* Confidence: 8/10
* Description: [What the vulnerability is]
* Exploit Scenario: [Concrete attack path]
* Recommendation: [Specific fix]
```

Severity: **HIGH** = directly exploitable → RCE, data breach, auth bypass. **MEDIUM** = requires specific conditions but significant impact. Do NOT report LOW.

Machine output (what the automated engine prints as JSON): each finding carries `file`, `line`, `severity` (HIGH/MEDIUM/LOW), `category` (e.g. `sql_injection`, `xss`), `description`, `exploit_scenario`, `recommendation`, `confidence` (0–1). The audit result adds an `analysis_summary` (`files_reviewed`, `high_severity`/`medium_severity`/`low_severity` counts, `review_completed`).

## What the Automated Pipeline Does (textualized)

When the bundled engine runs (CI or CLI), these steps replace/augment the manual workflow — an agent reproducing them by hand should follow the same logic:

1. **Fetch PR context** — from `GITHUB_REPOSITORY` (`owner/repo`) + `PR_NUMBER` via the GitHub API: PR metadata (title, author, head/base refs and SHAs, changed-file stats) and the changed-file list with per-file patches (paginated, 100/page). Directory exclusions from `EXCLUDE_DIRECTORIES` are applied to the file list.
2. **Fetch and clean the diff** — request the unified diff with `Accept: application/vnd.github.diff`; strip whole file sections that contain generated-file markers (`@generated by`, `@generated`, `Code generated by OpenAPI Generator`, `Code generated by protoc-gen-go`) and drop excluded-directory paths.
3. **Assemble the audit prompt** — inject repo/PR context, the changed-file list, and the diff (or, if the prompt would exceed ~1MB / hits "Prompt is too long", omit the diff and instruct the reviewer to explore the changed files with file tools instead); append any custom scan categories. The prompt body embeds the objective, exclusions, category list, three-phase methodology, severity/confidence guidance, and the exact JSON output schema shown above.
4. **Run the reviewer** — invoke the model/CLI (`claude` CLI with `--output-format json`, default model `claude-opus-4-1-20250805` overridable via `CLAUDE_MODEL`, `Bash(ps:*)` disallowed, prompt fed on stdin, ~20-minute subprocess timeout). Up to 3 attempts with short sleeps; retry on `error_during_execution`, on unparseable output (once), and re-run without the diff on `PROMPT_TOO_LONG`. Claude Code is pre-validated (`claude --version` + `ANTHROPIC_API_KEY`).
5. **Parse the JSON** — parse stdout with fallbacks: direct `json.loads` → fenced ```json code block → first balanced-brace object in the text. Accept only a Claude wrapper object carrying `result`, whose `result` text parses to JSON containing a `findings` key.
6. **Filter stage 1 — hard rules:** the engine applies the Hard Exclusions above to each finding via regex families; each removed finding records the matched rule family (the exclusion breakdown is kept as metadata).
7. **Filter stage 2 — per-finding model filter** (enabled by `ENABLE_CLAUDE_FILTERING=true` with an API key): each surviving finding is re-analyzed individually against the Signal Quality Criteria and Precedents above (plus any custom FP rules), with PR context and the source file content. The model answers JSON `{original_severity, confidence_score (1–10), keep_finding, exclusion_reason, justification}`; `keep_finding: false` excludes the finding with its reason, and kept findings carry the confidence and justification as metadata. A failed API call keeps the finding with a warning at default confidence 10. If stage 2 is disabled, everything surviving stage 1 is kept at default confidence 10.
8. **Filter stage 3 — final directory exclusion** — drop kept findings whose `file` path falls under an excluded directory.
9. **Emit & exit** — print one JSON document to stdout: `{pr_number, repo, findings (kept), analysis_summary, filtering_summary}` where `filtering_summary` holds `total_original_findings`, `excluded_findings` count and full details, `kept_findings`, and per-stage `filter_analysis` (incl. hard/claude/directory exclusion counts and average confidence). Exit code: **0** when no HIGH finding remains, **1** if any kept finding is HIGH (so CI can fail the build), **2** on configuration errors (missing `GITHUB_TOKEN`/`GITHUB_REPOSITORY`/`PR_NUMBER` or invalid init).

## Customization

### Custom scan categories (domain templates)

Append the matching block to the vulnerability-assessment phase for the project's domain:

- **Compliance (GDPR, HIPAA, PCI DSS, SOC2):** GDPR Article 17 "Right to Erasure" implementation gaps; HIPAA PHI encryption-at-rest violations; PCI DSS card-data retention beyond allowed periods; SOC2 audit-trail tampering or deletion capabilities; CCPA data portability API vulnerabilities.
- **Financial services:** transaction replay attacks in payment processing; double-spending in ledger systems; interest-calculation manipulation through timing attacks; regulatory-reporting data tampering; KYC bypass mechanisms.
- **E-commerce:** shopping-cart manipulation for price changes; inventory race conditions allowing overselling; coupon/discount stacking exploits; affiliate-tracking manipulation; review-system auth bypass.
- **GraphQL APIs:** query-depth attacks allowing unbounded recursion; field-level authorization bypass; introspection leakage in production; batch-query abuse.

Writing new categories: be specific (concrete vulnerabilities, not general concerns); avoid duplicating the default categories (injection, auth, crypto, code execution, data exposure); include why it matters in this environment; same HIGH/MEDIUM severity rules apply.

### Custom false-positive filtering (example organization profile)

A project may replace the default FP rules with its own profile, e.g.: all DoS/resource exhaustion excluded (k8s limits + autoscaling); missing rate limiting excluded (API gateway handles it); tabnabbing accepted per threat model; test files and docs excluded; internal configs excluded; memory safety in Rust/Go/managed languages excluded; GraphQL introspection intentionally exposed in dev; missing CSRF excluded (stateless JWT auth only); timing attacks on non-crypto ops excluded; regex DoS excluded (request timeouts); security headers only required on public-facing services. Then score survivors by: can an unauthenticated external attacker exploit this? real data exfiltration or system compromise? exploitable in our production environment? does it bypass our API gateway controls? With project precedents such as: auth bypass must defeat Cognito; all APIs require gateway-validated JWTs; SQLi only valid on raw queries (Prisma ORM everywhere); internal services use mTLS; secrets only in Secrets Manager/k8s secrets; verbose errors allowed in dev/staging; uploads go to S3 via presigned URLs (no local file handling); all user input untrusted and validated server-side; frontend validation is UX-only; strict CSP + Content-Type validation; per-service CORS; webhooks verified by HMAC.

## Evaluation Framework

Validate the audit against any public PR whose vulnerabilities are known by invoking the bundled eval CLI with `ANTHROPIC_API_KEY` set and a `owner/repo#PR` argument (verbose output optional; results JSON is written under an eval-results directory and the process exits 0 on success). The bundled eval scenarios score the manual workflow against crafted vulnerable diffs (each 100 points across criteria like "SQL injection identified", "plaintext password storage flagged", "missing auth on admin endpoint", "correct output format used", "no false positives reported") — including a compliance scenario where the agent must detect PCI DSS card-data logging/retention violations and IDOR/refund-auth issues and apply the financial-services custom categories. Repo-wide, evals compare detection against SAST baselines on real PRs.

## Provenance

- Source repo: https://github.com/LeonMelamud/claude-code-security-review
- Original path: repo root (`.`)
- License: MIT — see repo README ("License: MIT License — see LICENSE") and LICENSE file
- 蒸馏说明：原 37 文件（SKILL.md + claudecode/ Python 包：audit/github_action_audit/prompts/findings_filter/claude_api_client/json_parser/constants/logger/requirements + action.yml + scripts/comment-pr-findings.js + references/（FP 规则、定制模板、两个示例 txt）+ assets/security-review-command.md + evals/ 引擎与 4 个场景 + README/AGENTS.md/tile.json/skills-lock.json）。脚本内管道、正则排除族、判定阈值、默认参数与退出码均已文字化；无需逐行保留的实现细节（如 HTTP 客户端重试退避、缓存/工位预留逻辑、eval 引擎的 git 操作超时常量）已概括，需要精确实现时见原仓库。原 `/security-review` slash-command 模板（与 `anthropic-claude-code-security-review` skill 同源）可复制安装到任意项目的 `.claude/commands/` 下。上游基线见 [anthropics/claude-code-security-review](https://github.com/anthropics/claude-code-security-review)。
