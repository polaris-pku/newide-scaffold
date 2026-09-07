---
name: variant-analysis
description: Hunts down the other instances of a bug already found - variants of one root cause across a codebase. Use after a vulnerability or bad pattern turns up in one file and the question is where else it occurs; not for initial discovery.
---

# Variant Analysis

> 边界标注（2026-09-07）：入参是"已确认的一个根因"，输出全仓同源变体；从零找 bug 先用 correctness/bugsweep；security 审计在确认漏洞后可复用本技能扩散排查。
> Boundary (2026-09-07): input = one confirmed root cause, output = its variants repo-wide; for greenfield bug hunting start with bugsweep; security audits reuse this after confirming a vulnerability.

> 蒸馏自 trailofbits/skills（仓库内 `plugins/variant-analysis/skills/variant-analysis`）。原为多文件 skill（SKILL.md + 4 篇 references + CodeQL/Semgrep 每语言查询 + 报告模板 + yaml/svg 资产），查询与模板已文字化为徒手可执行的检查清单。
> Distilled from trailofbits/skills (`plugins/variant-analysis/skills/variant-analysis`); originally multi-file with per-language CodeQL/Semgrep queries, now inlined as text checklists.

## When to Use

- A vulnerability has been found and you need to search for similar instances ("are there others like this?", "is this the same bug?").
- Building or refining CodeQL/Semgrep queries for a security pattern family from one known instance.
- Performing a systematic code audit after an initial issue discovery.
- Triaging a set of look-alike candidates against a known root cause.
- Analyzing how a single root cause manifests in different code paths.

Input: one known bug (file + code + description) in a codebase. Output: a variant-analysis report listing confirmed variants with severity/confidence, the search methodology (including failed patterns), and a CI-ready regression guard.

When NOT to Use: initial vulnerability discovery (build context first); general code review with no known pattern to search for; writing fix recommendations; understanding unfamiliar code.

## Core Principles

1. **One root cause usually has several manifestations, rarely in the module where you found the first one.** Variants exist because developers make consistent mistakes: (1) personal habits — the same person writes similar code and similar errors; (2) copy-paste propagation — boilerplate spreads a bug across the codebase; (3) API misuse — complex APIs invite consistent misunderstandings; (4) framework idioms — framework patterns create predictable vulnerability shapes; (5) incomplete fixes — the bug was fixed in one place and missed elsewhere. Why a variant exists predicts where to find it: a copy-paste bug clusters in sibling files; an API-misuse bug clusters at every call site of that API, anywhere.
2. **The root-cause statement IS the search pattern.** Everything downstream is calibrated against it, so a shallow root cause caps the quality of the whole hunt.
3. **Climb the abstraction ladder one element at a time.** A pattern matching nothing means you misunderstood the bug; a pattern matching mostly noise means you climbed too far. Revert, don't push through noise.
4. **Argue against every candidate before accepting it.** A candidate survives only if you looked for the thing that makes it safe (guard, sanitizer, type constraint, caller set) and did not find it.
5. **Attach severity to every verdict — including informational ones.** Filtering happens downstream where the full set is visible; a finding you decline to mention is a finding nobody sees. Separate Severity (impact if real) from Confidence (how sure it is real).
6. **Narrow scope is the single most common reason a hunt finds nothing.** Search the whole codebase root, not the module where the bug was found.

## Workflow (Five Steps)

**Step 1 — Understand the original issue (root cause + expansion axes).** Extract WHY the code is wrong, not what it does. Ask four questions before writing anything: (1) **What operation is dangerous?** (`eval()`, `system()`, raw SQL, an authorization check); (2) **What data makes it dangerous?** (user-controlled input, a null, an attacker-chosen size); (3) **What's missing?** (sanitization, validation, a bounds check, a null guard); (4) **What context enables it?** (authentication state, an error path, a specific caller). Formulate the statement: *"This vulnerability exists because [UNTRUSTED DATA] reaches [DANGEROUS OPERATION] without [REQUIRED PROTECTION]."* Examples: "User input reaches `eval()` without sanitization"; "Attacker-controlled size reaches `malloc()` without an overflow check"; "Untrusted path reaches `open()` without canonicalization". For logic bugs with no data flow, state the violated invariant instead: "this function must return False for unauthenticated callers, and it returns True when both IDs are null."

Then enumerate the expansion directions (axes) before searching:
1. **Semantically related identifiers** — if the bug involves one name, every name playing the same role is in scope: `isAuthenticated` → also `isActive`, `isAdmin`, `isVerified`, `isLoggedIn`; `userId` → also `ownerId`, `creatorId`, `authorId`. Ground these in the codebase first (grep the names before claiming them) — plausible identifiers that don't exist waste an entire axis.
2. **Other boolean-logic errors** — the same mistake in a different shape: inverted conditions (`if not x` where `if x` was meant); wrong default return (`return True` on the fall-through path); short-circuit evaluation errors (`or` where `and` was meant).
3. **Data-type edge cases** — null/None/undefined comparisons where BOTH sides can be null; empty string vs null; zero vs null; empty arrays and collections.
4. **Documentation/code mismatches** — a function whose behavior contradicts its own name/docstring; search names carrying `deny`, `restrict`, `block`, `forbid`, `check`, `validate` and confirm the return value means what the name says.

A good axis must be **independently searchable** (names concrete identifiers or constructs, not a theme like "authorization problems"), **non-overlapping** with other axes, and **grounded** (its leads exist in this codebase). Pitfalls: pattern too specific (exact attribute only); single vulnerability class (one manifestation only — a "returns allow when the condition is false" bug also hides as a null-equality bypass, a docs/code mismatch, and an inverted conditional); ungrounded axes.

**Step 2 — Create an exact match.** Write a pattern matching ONLY the known instance and confirm it hits. This is the calibration point that proves your understanding of the bug is correct — it is not the search. A pattern that matches nothing means you have misunderstood the bug, and every search built on it is calibrated against the wrong code.

**Step 3–4 — Generalize one element at a time (the abstraction ladder).**
- **Level 0 (exact match):** literal vulnerable code. ~1 match, zero false positives. Use to verify a specific fix.
- **Level 1 (variable abstraction):** replace variable names with metavariables (`$QUERY = "SELECT * FROM users WHERE id=" + $INPUT`). ~3–5 matches, low FP. Finds copy-paste variants.
- **Level 2 (structural abstraction):** generalize the surrounding structure (any string concat `$Q = "..." + $INPUT` inside a function that reaches `cursor.execute($Q)`). ~10–30 matches, medium FP. Use to audit a component.
- **Level 3 (semantic abstraction):** abstract to the security property itself — taint from sources (request args/form) to sinks (`cursor.execute(...)`) regardless of shape. ~50–100+ matches, high FP. Use for a full security assessment; requires real triage.

**Never generalize multiple elements at once.** BAD: exact code → fully abstract pattern. GOOD: exact code → abstract var1 → abstract var2 → abstract operation. Each step: make ONE change, run it, read ALL new matches, decide whether the FP rate is still acceptable, then continue or revert. Jumping straight to Level 3 produces a pile of results with no way to tell which abstraction introduced the noise.

**Decision points at each step:** abstract this variable name? Yes if different names could carry the same bug; No if the name itself is the semantic constraint you rely on. Abstract this literal? Yes if any value triggers the bug; No if only specific values are dangerous. Use `...` wildcards? Yes if argument position doesn't matter; No if only a specific position is a sink. Add taint tracking? Yes if you must prove data actually flows source→sink; No if pattern presence is already sufficient evidence.

**Search scope:** run every search against the ENTIRE codebase root, not the directory the original bug lived in — a bug found in `api/handlers/` with a variant in `utils/auth.py` is the normal case.

**Tool selection:** ripgrep for quick surface recon (fast, zero setup); Semgrep for simple pattern matching and iteration (works on incomplete/non-building code); Semgrep taint / CodeQL for data-flow tracking; CodeQL for interprocedural/cross-function precision. Tool loyalty is an anti-pattern — "I only use CodeQL" costs you the fast passes that tell you where to aim it.

**Stop rule:** stop generalizing when more than roughly half the matches are noise — that signals you climbed one level too far; revert and take a different abstraction rather than pushing further up the same one. (Reference FP rates by context: automated CI blocking <5%; developer warning <20%; security audit triage <50%; research/exploration <80%.)

**False-positive filters:** exclude test trees (`!**/test*`, `!**/*_test.*`, `!**/node_modules/**`, `!**/vendor/**`, per language test suffixes); subtract the already-sanitized form (`pattern-not: dangerous_func(sanitize($X))`); exclude literal values that are not attacker-controlled (`pattern-not: dangerous_func("...")`); add reachability constraints for dead code (`pattern-not-inside: if False: ...`). Analyze false positives as you go rather than deferring them — they tell you which abstraction was too aggressive, information you lose if you batch-triage at the end.

**Step 5 — Triage: decide which candidates are real, with severity.** The snippet alone is never enough. Read the surrounding function, the callers, and the type of every value involved, then look specifically for the thing that makes it safe: a guard earlier in the function or in a decorator/middleware; a sanitizer, validator, or parameterized API between source and sink; a type constraint that makes the dangerous value unreachable; a caller set that never supplies attacker-controlled input. A candidate survives only if you looked for these and did not find them. Note what is NOT on that list: having no callers — code nothing reaches today is still unprotected code, and a variant hunt is exactly the search that finds it before a caller arrives.

**Exploitability of a surviving candidate:** Reachable — is there a path from an external entry point to this code? Controllable — can an attacker influence the value that makes it dangerous? Unprotected — is the protection named in the root cause genuinely absent here? A candidate that is reachable and controllable but has a DIFFERENT protection in place is a false positive worth recording, not a finding. A candidate unreachable today but unprotected is a real finding at LOWER severity — say so explicitly and say what would make it reachable.

**Edge cases that hide real bugs (test every candidate where applicable):** null equality bypasses — if both sides of a comparison can be null simultaneously the comparison succeeds for the wrong reason (`order.owner_id == current_user.id` passes when both are None; ask what values each side can hold, whether both can be null at once, and who can cause that); documentation/code mismatch — function does the opposite of its name/docstring claim (e.g. `check_restricted_permission` returning True for users who DO have permission), and every caller of such a function is a potential finding even where the call site looks correct; unauthenticated and anonymous callers; empty string vs null, zero vs null; empty arrays/collections; boundary values at type limits.

**Record false positives by reason** — grouped, they become the report's false-positive table and let the next stage refine the pattern instead of re-triaging the same matches.

**Then write it up** (report structure below), including the patterns that failed and a CI rule to prevent regression.

## Checklist (manual sweep)

**Root cause (Step 1):**
- [ ] Root-cause statement formulated: "[UNTRUSTED DATA] reaches [DANGEROUS OPERATION] without [REQUIRED PROTECTION]" (or violated invariant for logic bugs).
- [ ] Expansion axes enumerated: semantically related identifiers (grounded by grep), other boolean-logic shapes, data-type edge cases, documentation/code mismatches.
- [ ] Each axis independently searchable, non-overlapping, grounded; each will be checked without cross-axis bias.

**Search (Steps 2–4):**
- [ ] Exact-match pattern built and confirmed to hit only the known instance (Level 0 calibration).
- [ ] Generalization proceeds one element at a time; each change run and every new match read before the next change.
- [ ] Search ran against the whole codebase root (not the origin module).
- [ ] Abstraction stopped when >~50% noise; reverted and re-abstracted rather than pushing through noise.
- [ ] FPs filtered as encountered: test trees excluded; sanitized forms subtracted; non-attacker-controlled literals excluded; dead code constrained.
- [ ] Manual language catalog below consulted for source/sink/barrier vocabulary.

**Triage (Step 5):**
- [ ] For every candidate: function + callers + value types read; guard / sanitizer / type constraint / caller-set checked and found absent.
- [ ] Exploitability established: Reachable? Controllable? Unprotected? Different protection in place → recorded FP, not finding; unreachable-today-but-unprotected → lower-severity finding with what-would-make-it-reachable stated.
- [ ] Edge cases applied: null-equality bypass (both sides nullable), name/docstring contradiction, empty-vs-null, zero-vs-null, empty collections, type boundaries.
- [ ] Severity (impact if real) and Confidence (how sure) recorded separately on every verdict.
- [ ] False positives recorded grouped by reason.

**Report:**
- [ ] Summary, original vulnerability, search methodology table (pattern versions/tools/match counts), findings (severity-ordered), false-positive patterns (grouped), recommendations + CI guard.
- [ ] Real code quoted verbatim at every confirmed location; failed patterns recorded alongside working ones.

## Manual Language Catalogs (hand-executable summary of the shipped queries)

The original skill ships per-language CodeQL and Semgrep templates. Executed by hand, they reduce to: find where untrusted data starts (sources), where it ends (sinks), and what counts as a barrier between them — then check every source→sink path with no barrier. The shipped catalogs:

**Python.** Sources: Flask `request.args` / `.form` / `.json` / `.data` (`.get(...)` or `[...]`), `os.environ.get(...)` / `os.environ`, `input(...)` (Django: `request.GET.get`, `request.POST.get`). Sinks: `os.system()`, `os.popen()`, `subprocess.call/run/Popen` with `shell=True`, `eval()`, `exec()`, SQL `cursor.execute(...)`, `open(...)` (path). Barriers: `shlex.quote()`, `os.path.basename()`, `int()`, and calls named `sanitize` / `escape` / `validate`.

**JavaScript/TypeScript.** Sources: Express `req.query` / `.body` / `.params` / `.cookies`, `window.location` / `document.location` / `location.search` / `location.hash`. Sinks: `child_process.exec` / `execSync` / `spawn` / `spawnSync`, `eval()`, `Function()`, `setTimeout`/`setInterval` (string), SQL `$DB.query` / `$DB.raw` / `query`/`raw`/`execute`, XSS `$EL.innerHTML =`, `document.write()`. Barriers: `parseInt()`, `encodeURIComponent()`, `escape()`, `$DB.escape()`.

**Java.** Sources: servlet `HttpServletRequest.getParameter/getHeader/getCookies/getQueryString/getInputStream`, Spring `@RequestParam` / `@PathVariable` / `@RequestBody` parameters. Sinks: `Runtime.getRuntime().exec()`, `new ProcessBuilder(...)`, `java.sql.Statement.executeQuery/executeUpdate/execute`, `prepareStatement`, `new File(...)`, `FileInputStream/FileOutputStream`, `Paths.get(...)`, XXE `DocumentBuilder.parse(...)`, deserialization `ObjectInputStream.readObject()`. Barriers: `Integer.parseInt/valueOf`, `StringEscapeUtils.escapeHtml4`, `ESAPI.encoder().encodeForSQL`, and calls named `escape`/`sanitize`/`valueOf`.

**Go.** Sources: `net/http` `req.URL.Query().Get(...)`, `req.FormValue/PostFormValue/Header.Get(...)`, `net/url` `Values.Get`, Gin `c.Query/Param/PostForm/GetHeader`, Echo `QueryParam/FormValue`, `os.Args[i]`, `os.Getenv(...)`. Sinks: `os/exec.Command` / `CommandContext`, `database/sql` `DB.Query/QueryRow/Exec`, `os.Open/OpenFile/ReadFile`, `ioutil.ReadFile`, template injection `template.HTML(...)`. Barriers: `strconv.Atoi/ParseInt`, `filepath.Clean/Base`, `html.EscapeString`, and calls named `Escape`/`Quote`/`Clean`/`ParseInt`/`Atoi`.

**C/C++.** Sources: `argv`, stdin reads `gets/fgets/scanf/fscanf/sscanf/getline/getchar/fgetc`, network reads `recv/recvfrom/recvmsg/read`, `getenv`, file reads `fread/fgets`. Sinks: command injection `system/popen/execl/execlp/execle/execv/execvp/execvpe`; unsafe string ops `strcpy/strcat/sprintf/vsprintf/gets` (buffer overflow); format string `printf/fprintf/sprintf/snprintf/syslog` (first arg non-literal); memory allocation `malloc/calloc/realloc/alloca` (integer-overflow-in-size); path ops `fopen/open/access/stat/lstat`; SQL names matching `%query%`. Barriers: size-bounded string functions `strncpy/strncat/snprintf/strlcpy/strlcat`, validation calls `strlen/strnlen/isalpha/isdigit/isalnum`, names matching `%escape%`, and any relational comparison guarding the value in an `if` (integer bounds check). Additional canned rules: format-string = `printf($VAR)` style calls where the format argument is a variable, not a literal; integer-overflow-before-alloc = `$SIZE = $X * $Y; ...; malloc($SIZE)` or `malloc($X * $Y)`; unsafe-function presence = any `gets/strcpy/strcat/sprintf/vsprintf` regardless of data flow (WARNING).

**Common FP filters across languages** (also encoded in the shipped rules): exclude test trees (`*_test.py`, `test_*.py`, `tests/`, `*.test.js`, `*.spec.js`, `*Test.java`, `*_test.go`, `node_modules/`, `vendor/`); pattern-not for literal-only sink arguments; for Java the pattern-match rule only fires inside methods that receive an `HttpServletRequest` parameter.

## Output Format

Report sections (every section earns its place):
1. **Summary** — original bug (ID/CVE), analysis date, codebase, count of variants found.
2. **Original vulnerability** — root-cause statement, origin location (`path/file:LINE` in `function()`), verbatim vulnerable code.
3. **Search methodology** — methodology table (below), including patterns that FAILED; the table makes the hunt reproducible: which abstractions worked, which produced noise, where the search stopped.
4. **Findings** — one block per confirmed variant, severity-ordered: title, Severity/Confidence/Status table, location, verbatim code, analysis (why true/false positive), exploitability checklist (Reachable from external input / User-controlled data / No sanitization).
5. **False positive patterns** — grouped by reason, not one row per match.
6. **Recommendations** — immediate fixes first, then preventive measures ending in a CI-ready rule derived from whichever pattern found the most variants.

Methodology table:

| Version | Pattern | Tool | Matches | TP | FP |
|---|---|---|---|---|---|
| v1 | exact | ripgrep | 1 | 1 | 0 |
| v2 | abstract (var) | semgrep | N | N | N |

Quote the REAL code at each confirmed location — paraphrased code loses the detail a reviewer needs to confirm the finding, and a wrong quote destroys trust in every other finding in the document. Leave a regression guard: end with the CI-ready rule (Semgrep/CodeQL) derived from the pattern that found the most variants.

## Examples

SQL-injection hunt walkthrough (illustrates Levels 0→3): original bug is `query = "SELECT * FROM users WHERE id=" + request.args.get('id')` in `api/handlers/users.py`. Level 0 exact literal matches 1 (calibration). Level 1: `$QUERY = "SELECT * FROM users WHERE id=" + $INPUT` → 4 matches — finds copy-paste variants in sibling handlers. Level 2: `$Q = "..." + $INPUT` inside any function whose body reaches `cursor.execute($Q)` → 18 matches, several are parameterized-query false positives to filter with `pattern-not` on the safe form. Level 3 (taint): sources `request.args.get/request.form.get`, sink `cursor.execute(...)` → 60+ matches incl. matches where the input flows through an intermediate variable; triage required. Also sweep axes from Step 1: related identifiers (other `request.args.get` uses feeding other sinks like `os.system`), boolean variants, and the `users` table touched from other entry points. Search ran against the whole repo, not `api/handlers/`. Report ends with a Semgrep taint rule as the CI regression guard.

`absent`-style negative result is still reported: a hunt that generalizes to the family limit and finds zero additional variants is written up with the methodology table showing where it stopped and why (e.g., "only call site is behind a `can_view` middleware — the caller set filters attacker input"), so the next hunt does not repeat the axis.

## Provenance

- Source repo: https://github.com/trailofbits/skills
- Original path: `plugins/variant-analysis/skills/variant-analysis`
- License: unknown — see repo (no LICENSE bundled in the skill directory)
- 蒸馏说明：原目录含 18 文件：SKILL.md + references 下 4 篇（root-cause / searching / triage / reporting）+ resources 下 5 个 CodeQL .ql、5 个 Semgrep .yaml、1 个 variant-report-template.md，外加 agents/openai.yaml 与 assets 图标（纯展示资产，已省略）。四篇 references 与报告模板已近乎全文内联；CodeQL/Semgrep 为每语言通用模板规则（占位符 [VARIANT_NAME]/[ORIGINAL_BUG_ID]），其 source/sink/barrier 目录与内置过滤已概括为正文 "Manual Language Catalogs" 徒手检查清单与判定规则；抽象阶梯各层的示例匹配量（1 / 3–5 / 10–30 / 50–100+）与 FP 率语境阈值均来自原文 searching.md。原 workflow（/variant-analysis:variants 并行 fan-out）的机制在正文简化为"每轴独立检查、互不知情"。未删除/新建任何文件。
- Distillation note (EN): original had 18 files (4 reference docs + report template fully inlined; 10 per-language CodeQL/Semgrep template rules distilled into the Manual Language Catalogs checklist; openai.yaml/icon dropped as content-free). Abstraction-ladder match counts and FP-context thresholds are taken verbatim from searching.md. No files were deleted or created.
