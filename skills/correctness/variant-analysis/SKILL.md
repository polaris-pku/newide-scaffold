---
name: variant-analysis
description: Hunts down the other instances of a bug already found - variants of one root cause across a codebase. Use after a defect or bad pattern turns up in one file and the question is where else it occurs; not for initial discovery.
---

# Variant Analysis

> 边界标注（2026-09-07）：入参是"已确认的一个根因"，输出全仓同源变体；本技能不从零发现缺陷。
> Boundary (2026-09-07): input = one confirmed root cause, output = its variants repo-wide; this skill does not perform initial defect discovery.

> 蒸馏自 trailofbits/skills（仓库内 `plugins/variant-analysis/skills/variant-analysis`）。原为多文件 skill（SKILL.md + 4 篇 references + CodeQL/Semgrep 每语言查询 + 报告模板 + yaml/svg 资产），查询与模板已文字化为徒手可执行的检查清单。
> Distilled from trailofbits/skills (`plugins/variant-analysis/skills/variant-analysis`); originally multi-file with per-language CodeQL/Semgrep queries, now inlined as text checklists.

## When to Use

- A defect has been found and you need to search for similar instances ("are there others like this?", "is this the same bug?").
- Building or refining CodeQL/Semgrep queries for a defect-pattern family from one known instance.
- Performing a systematic code audit after an initial issue discovery.
- Triaging a set of look-alike candidates against a known root cause.
- Analyzing how a single root cause manifests in different code paths.

Input: one known defect (file + code + description) in a codebase. Output: a variant-analysis report listing confirmed variants with severity/confidence, the search methodology (including failed patterns), and a CI-ready regression guard.

When NOT to Use: initial defect discovery (build context first); general code review with no known pattern to search for; writing fix recommendations; understanding unfamiliar code; judging whether a security-shaped finding is exploitable (out of scope here).

## Core Principles

1. **One root cause usually has several manifestations, rarely in the module where you found the first one.** Variants exist because developers make consistent mistakes: (1) personal habits — the same person writes similar code and similar errors; (2) copy-paste propagation — boilerplate spreads a bug across the codebase; (3) API misuse — complex APIs invite consistent misunderstandings; (4) framework idioms — framework patterns create predictable defect shapes; (5) incomplete fixes — the bug was fixed in one place and missed elsewhere. Why a variant exists predicts where to find it: a copy-paste bug clusters in sibling files; an API-misuse bug clusters at every call site of that API, anywhere.
2. **The root-cause statement IS the search pattern.** Everything downstream is calibrated against it, so a shallow root cause caps the quality of the whole hunt.
3. **Climb the abstraction ladder one element at a time.** A pattern matching nothing means you misunderstood the bug; a pattern matching mostly noise means you climbed too far. Revert, don't push through noise.
4. **Argue against every candidate before accepting it.** A candidate survives only if you looked for the thing that makes it safe (guard, validator, bound, type constraint, caller set) and did not find it.
5. **Attach severity to every verdict — including informational ones.** Filtering happens downstream where the full set is visible; a finding you decline to mention is a finding nobody sees. Separate Severity (impact if real) from Confidence (how sure it is real).
6. **Narrow scope is the single most common reason a hunt finds nothing.** Search the whole codebase root, not the module where the bug was found.

## Workflow (Five Steps)

**Step 1 — Understand the original issue (root cause + expansion axes).** Extract WHY the code is wrong, not what it does. Ask four questions before writing anything: (1) **What operation is involved?** (an index access, a division, a narrowing, a conversion, a write, a loop bound); (2) **What input or state makes it wrong?** (a caller-supplied value, a null, an empty collection, a boundary value, a concurrent writer); (3) **What's missing?** (a bounds check, a null guard, an atomic update, a rollback on failure, a calendar-aware conversion); (4) **What context enables it?** (which caller, which error path, which execution order). Formulate the statement: *"This defect exists because [INPUT OR STATE] reaches [OPERATION] without [REQUIRED GUARANTEE], so it produces [WRONG BEHAVIOR]."* Examples: "A caller-supplied `offset` reaches `items[offset]` without a bounds check, so a valid large request returns `undefined` instead of a row"; "A rejected step-2 promise reaches the caller without a rollback of step 1, so a failed checkout leaves a persisted order"; "An empty collection reaches `reduce()` without an initial value, so the summary throws instead of returning zero". For defects with no data flow, state the violated invariant instead: "this function must return False for unauthenticated callers, and it returns True when both IDs are null."

Then enumerate the expansion directions (axes) before searching:
1. **Semantically related identifiers** — if the bug involves one name, every name playing the same role is in scope: `offset` → also `limit`, `cursor`, `start`, `count`; `total` → also `sum`, `subtotal`, `balance`; `items` → also `rows`, `entries`, `results`. Ground these in the codebase first (grep the names before claiming them) — plausible identifiers that don't exist waste an entire axis.
2. **Other wrong-branch errors** — the same mistake in a different shape: inverted conditions (`if not x` where `if x` was meant); wrong default return (`return true` on the fall-through path); short-circuit evaluation errors (`or` where `and` was meant); `<` where `<=` was meant.
3. **Data-type edge cases** — null/None/undefined comparisons where BOTH sides can be null; empty string vs null; zero vs null; empty arrays and collections; boundary values (empty, zero, single element, first/last, type limits, division by zero, slice/index bounds).
4. **Documentation/code mismatches** — a function whose behavior contradicts its own name/docstring; search names that claim a guarantee (`is`, `has`, `can`, `should`, `valid`, `safe`, `check`, `validate`, `count`, `total`, `min`, `max`) and confirm the return value means what the name says.

A good axis must be **independently searchable** (names concrete identifiers or constructs, not a theme like "correctness problems"), **non-overlapping** with other axes, and **grounded** (its leads exist in this codebase). Pitfalls: pattern too specific (exact attribute only); single defect class (one manifestation only — a "returns allow when the condition is false" bug also hides as a null-equality bypass, a docs/code mismatch, and an inverted conditional); ungrounded axes.

**Step 2 — Create an exact match.** Write a pattern matching ONLY the known instance and confirm it hits. This is the calibration point that proves your understanding of the bug is correct — it is not the search. A pattern that matches nothing means you have misunderstood the bug, and every search built on it is calibrated against the wrong code.

**Step 3–4 — Generalize one element at a time (the abstraction ladder).**
- **Level 0 (exact match):** the literal defective code. ~1 match, zero false positives. Use to verify a specific fix.
- **Level 1 (variable abstraction):** replace variable names with metavariables (`return $ITEMS[$OFFSET]`). ~3–5 matches, low FP. Finds copy-paste variants.
- **Level 2 (structural abstraction):** generalize the surrounding structure (any `$ARR[$IDX]` inside a function whose body establishes no bound on `$IDX`). ~10–30 matches, medium FP. Use to audit a component.
- **Level 3 (invariant abstraction):** abstract to the violated invariant itself — any index expression derived from caller input, in any function, with no path establishing `0 <= idx < length`, regardless of shape. ~50–100+ matches, high FP. Use for a repo-wide sweep; requires real triage.

**Never generalize multiple elements at once.** BAD: exact code → fully abstract pattern. GOOD: exact code → abstract var1 → abstract var2 → abstract operation. Each step: make ONE change, run it, read ALL new matches, decide whether the FP rate is still acceptable, then continue or revert. Jumping straight to Level 3 produces a pile of results with no way to tell which abstraction introduced the noise.

**Decision points at each step:** abstract this variable name? Yes if different names could carry the same bug; No if the name itself is the semantic constraint you rely on. Abstract this literal? Yes if any value triggers the bug; No if only specific values are. Use `...` wildcards? Yes if argument position doesn't matter; No if only a specific position is the operation. Add flow tracking? Yes if you must prove the value actually reaches the operation (through variables, fields, or across functions); No if pattern presence is already sufficient evidence.

**Search scope:** run every search against the ENTIRE codebase root, not the directory the original bug lived in — a bug found in `api/handlers/` with a variant in `utils/auth.py` is the normal case.

**Tool selection:** ripgrep for quick surface recon (fast, zero setup); Semgrep for simple pattern matching and iteration (works on incomplete/non-building code); Semgrep taint / CodeQL for data-flow tracking; CodeQL for interprocedural/cross-function precision. Tool loyalty is an anti-pattern — "I only use CodeQL" costs you the fast passes that tell you where to aim it.

**Stop rule:** stop generalizing when more than roughly half the matches are noise — that signals you climbed one level too far; revert and take a different abstraction rather than pushing further up the same one. (Reference FP rates by context: automated CI blocking <5%; developer warning <20%; batched triage <50%; research/exploration <80%.)

**False-positive filters:** exclude test trees (`!**/test*`, `!**/*_test.*`, `!**/node_modules/**`, `!**/vendor/**`, per language test suffixes); subtract the form that already establishes the guarantee (`pattern-not-inside:` the guard clause, the schema bound, the null check); exclude values the code itself derives rather than caller input (loop counters, compile-time constants, values the function just validated); add reachability constraints for dead code (`pattern-not-inside: if False: ...`). Analyze false positives as you go rather than deferring them — they tell you which abstraction was too aggressive, information you lose if you batch-triage at the end.

**Step 5 — Triage: decide which candidates are real, with severity.** The snippet alone is never enough. Read the surrounding function, the callers, and the type of every value involved, then look specifically for the thing that makes it safe: a guard earlier in the function or in a decorator/middleware; a validation schema or a type constraint that makes the triggering value unreachable; a normalization step between the input and the operation; a caller set that never supplies the triggering value. A candidate survives only if you looked for these and did not find them. Note what is NOT on that list: having no callers — code nothing reaches today is still unguarded code, and a variant hunt is exactly the search that finds it before a caller arrives.

**Reachability of a surviving candidate:** Reachable — is there a path from a real entry point (request handler, job, CLI, callback) to this code? Triggerable — can an actual input, schedule, or state take the value the root cause names? Unguarded — is the guarantee named in the root cause genuinely absent here? A candidate that is reachable and triggerable but has a DIFFERENT guarantee in place is a false positive worth recording, not a finding. A candidate unreachable today but unguarded is a real finding at LOWER severity — say so explicitly and say what would make it reachable.

**Edge cases that hide real bugs (test every candidate where applicable):** null equality bypasses — if both sides of a comparison can be null simultaneously the comparison succeeds for the wrong reason (`order.owner_id == current_user.id` passes when both are None; ask what values each side can hold, whether both can be null at once, and what causes that); documentation/code mismatch — function does the opposite of its name/docstring claim (e.g. `check_restricted_permission` returning True for users who DO have permission), and every caller of such a function is a potential finding even where the call site looks correct; empty string vs null, zero vs null; empty arrays/collections; boundary values at type limits; first/last element and single-element inputs.

**Record false positives by reason** — grouped, they become the report's false-positive table and let the next stage refine the pattern instead of re-triaging the same matches.

**Then write it up** (report structure below), including the patterns that failed and a CI rule to prevent regression.

## Defect-Shape Catalog (hand-executable summary of the shipped queries)

The original skill ships per-language CodeQL and Semgrep templates built around sources, sinks, and barriers — a security vocabulary. Re-anchored to this dimension, the manual sweep reduces to: name the **defect shape** the root cause belongs to, list the code shapes that can carry it, then check every such site for the guarantee the root cause says is missing.

| Defect shape | Code shapes that can carry it | The guarantee whose absence IS the defect |
|---|---|---|
| Boundary / off-by-one | `arr[i]`, `arr[i+1]`, `slice(a, b)`, `substring`, `subList`, loop bounds `<` vs `<=`, pagination offsets | `0 <= i < len` established before the access, on every path that reaches it |
| Null / absent value | member access on a possibly-absent value, `!` / `!!` assertions, `unwrap()`, unchecked `[0]`, destructuring, a dropped optional check | existence proven before use — a guard, a default, or a type that actually excludes absent |
| Integer width / sign | `+` / `*` on counters, casts between widths, `parseInt` / `Atoi`, allocation sizes, money in floats | the range fits the destination for every reachable input |
| Non-atomic read-modify-write | `get` → compute → `put` across an await/IO boundary; `if !has then set`; counters; lazy init | the read and the write are atomic together, or the update is conditional at the store |
| Unhandled failure path | `catch` that swallows or returns success; ignored error return; rejected promise with no handler; multi-step work with no rollback | the failure is propagated or compensated, and callers do not read success after a failure |
| Contract drift across a boundary | a callee that assumes pre-validated input; a caller passing raw data; a wrapper documented "call only with X" | every call site satisfies the callee's stated assumption — validation in *some* callers is not validation in *all* |
| Ordering / lifecycle | narrow → await → use (narrowing invalidated); init-before-use; use-after-release; `defer` placed after the return | the invariant still holds at the point of use, not only where it was established |
| Time / locale / encoding | date arithmetic without a calendar; `Date` vs local time; timezone conversion; byte-vs-character length; case-insensitive comparison | the conversion matches the unit and locale the behavior assumes |

Per-language notes on where the shapes hide differently: **C/C++** — an out-parameter written on only one path while the caller checks the return code; a guard inside `#ifdef DEBUG` that is absent from the shipped binary; `snprintf`/`strlcpy` bounds that go off-by-one when the return value is reused as a length. **Go** — typed-nil-in-interface (`err != nil` when the interface holds a nil pointer); a value returned alongside a non-nil error; `defer` inside a loop. **Java/Kotlin** — `Integer`/`Long` unboxing on a null; `equals` vs `==`; a coroutine's `CancellationException` swallowed by a broad `catch`. **Python** — mutable default arguments; late-binding closures in loops; `==` vs `is`. **JS/TS** — a non-null assertion `!` on a value that can be null at runtime; a narrowing lost across an `await`; an array index typed `T` but actually `T | undefined`.

For the security-shaped families — taint from an external source to a dangerous sink, injection, missing authorization, secret handling — this skill does not carry the source/sink/barrier catalogs.

## Output Format

Report sections (every section earns its place):
1. **Summary** — original defect (ID, or the issue/ticket it came from), analysis date, codebase, count of variants found.
2. **Original defect** — root-cause statement, origin location (`path/file:LINE` in `function()`), verbatim defective code.
3. **Search methodology** — methodology table (below), including patterns that FAILED; the table makes the hunt reproducible: which abstractions worked, which produced noise, where the search stopped.
4. **Findings** — one block per confirmed variant, severity-ordered: title, Severity/Confidence/Status table, location, verbatim code, analysis (why true/false positive), reachability checklist (Reachable from a real entry point / Triggering value obtainable / Named guarantee absent).
5. **False positive patterns** — grouped by reason, not one row per match.
6. **Recommendations** — immediate fixes first, then preventive measures ending in a CI-ready rule derived from whichever pattern found the most variants.

Methodology table:

| Version | Pattern | Tool | Matches | TP | FP |
|---|---|---|---|---|---|
| v1 | exact | ripgrep | 1 | 1 | 0 |
| v2 | abstract (var) | semgrep | N | N | N |

Quote the REAL code at each confirmed location — paraphrased code loses the detail a reviewer needs to confirm the finding, and a wrong quote destroys trust in every other finding in the document. Leave a regression guard: end with the CI-ready rule (Semgrep/CodeQL) derived from the pattern that found the most variants.

## Examples

Off-by-one hunt walkthrough (illustrates the ladder's pattern shapes): the original defect is `return items[offset]` in `api/handlers/products.js`, with `offset` taken from the query string. Level 1 generalizes to `return $ITEMS[$OFFSET]` (copy-paste variants in sibling handlers); Level 2 to any `$ARR[$IDX]` in a function whose body establishes no bound on `$IDX` (subtract sites where a loop bound or schema already bounds it, with `pattern-not-inside`); Level 3 to any index expression derived from caller input with no path establishing `0 <= idx < length` (some flow through an intermediate variable). Also sweep the Step 1 axes: related identifiers (`limit`, `cursor`, `start`, `count`), wrong-branch variants (`<=` where `<` was meant), and the same access reached from other entry points.

`absent`-style negative result is still reported: a hunt that generalizes to the family limit and finds zero additional variants is written up with the methodology table showing where it stopped and why (e.g., "the only call site passes a loop index that the loop condition itself bounds by the array length — the guarantee is established at the caller"), so the next hunt does not repeat the axis.

## Provenance

- Source repo: https://github.com/trailofbits/skills
- Original path: `plugins/variant-analysis/skills/variant-analysis`
- License: unknown — see repo (no LICENSE bundled in the skill directory)
- 蒸馏说明：原目录含 18 文件：SKILL.md + references 下 4 篇（root-cause / searching / triage / reporting）+ resources 下 5 个 CodeQL .ql、5 个 Semgrep .yaml、1 个 variant-report-template.md，外加 agents/openai.yaml 与 assets 图标（纯展示资产，已省略）。四篇 references 与报告模板已近乎全文内联；CodeQL/Semgrep 为每语言通用模板规则（占位符 [VARIANT_NAME]/[ORIGINAL_BUG_ID]），其 source/sink/barrier 目录与内置过滤已概括为正文 "Manual Language Catalogs" 徒手检查清单与判定规则；抽象阶梯各层的示例匹配量（1 / 3–5 / 10–30 / 50–100+）与 FP 率语境阈值均来自原文 searching.md。原 workflow（/variant-analysis:variants 并行 fan-out）的机制在正文简化为"每轴独立检查、互不知情"。未删除/新建任何文件。
- Distillation note (EN): original had 18 files (4 reference docs + report template fully inlined; 10 per-language CodeQL/Semgrep template rules distilled into the Manual Language Catalogs checklist; openai.yaml/icon dropped as content-free). Abstraction-ladder match counts and FP-context thresholds are taken verbatim from searching.md. No files were deleted or created.
- 维度收敛（2026-09-11）：本技能上游是安全方法论（root cause 模板为"不可信数据→危险 sink 无保护"、目录为 source/sink/barrier、triage 判可利用性、示例为 SQL 注入），作为 correctness 语料会把 agent 推向 security 的倾向。已重锚到本维度：根因模板改为"[输入或状态]→[操作] 缺 [必要保证] 导致 [错误行为]"；原「Manual Language Catalogs」（5 语言 source/sink/barrier 清单）整体替换为新撰写的「Defect-Shape Catalog」（8 类缺陷形状 × 可承载代码形状 × 缺失的保证 + 5 语言差异注，末段显式声明安全类 taint/injection/authz/secrets 四种不在本技能范围）；抽象阶梯各层与示例（SQL 注入 → 数组越界）同步改写；triage 由 Exploitability（Reachable/Controllable/Unprotected）改为 Reachability（Reachable/Triggerable/Unguarded）；输出契约的去安全化（vulnerability → defect、exploitability checklist → reachability checklist）。抽象阶梯机制、FP 阈值与"一因多manifestation"洞察为维度中性，逐字保留。**注意：Defect-Shape Catalog 与替换后的示例是新撰写内容，非上游蒸馏，需人工复核。**
