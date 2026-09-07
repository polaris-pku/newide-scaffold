---
name: agentic-code-reasoning
description: Reasons about code behavior without executing it via certificate-based semi-formal analysis — tracing premises to file:line evidence to formal conclusions for compare / diagnose / explain / audit-improve.
---

# agentic-code-reasoning

> 蒸馏自 KunihiroS/agentic-code-reasoning-skills（仓库根目录）。原为多文件（含辅助 md、prompt 模板、自动化自我改进脚本与 benchmark 资产），已合并为单文件。
> Distilled from KunihiroS/agentic-code-reasoning-skills (repo root); originally multi-file with auxiliary docs and dev-harness scripts, now inlined as text.

> 整合说明（2026-09-07）：本技能已收编 correctness/logic-review（原 hyhmrright/logic-lens 的 logic-review，单文件逻辑评审），作为「轻入口」并入；logic-review 目录保留为指针。
> Integration: single-file logic review (hyhmrright/logic-lens logic-review) was folded in as the light entry on 2026-09-07; its directory is now a pointer.

## When to Use

Use this skill whenever code behavior must be reasoned about **without executing it** — especially when code is provided and needs careful tracing. Invoke it to: trace what a function or program returns step by step, identify which exact operation causes a test failure or wrong value, determine whether two implementations are behaviorally equivalent, simulate an algorithm's execution order manually, or audit for security vulnerabilities like SQL injection or race conditions. Use it any time someone asks "what does this code return?", "which step caused the failure?", "are these equivalent?", "what's the execution order?", or "is this vulnerable?" — even when the answer seems obvious without a skill.

This skill is a translation of the research paper **Agentic Code Reasoning** (Ugare & Chandra, arXiv:2603.01896): structured *semi-formal reasoning* templates act as certificates that prevent skipping cases or making unsupported claims, improving accuracy by 5–12 percentage points across patch-equivalence verification, fault localization, and code QA.

### Modes

- `compare` — determine if two changes produce the same behavior
- `diagnose` — find the root cause of a bug in a small number of files
- `explain` — answer a code question with verified evidence
- `audit-improve` — review code for security, API misuse, or maintainability

Choose a mode before exploring files. If unsure, prefer `explain`.

### Mode selection guide

| Trigger | Mode |
|---------|------|
| "Are these two patches/implementations equivalent?" | `compare` |
| "Where is the bug?" / failing test / single defect | `diagnose` |
| "What does this code do?" / "Why does X happen?" | `explain` |
| "Is this code secure?" / "Review for issues" | `audit-improve` |

### Activation gates

Before selecting a mode, check whether this skill is appropriate for the task. **Do not activate** this skill when:

- The task requires **broad file enumeration** (e.g., "list all files that need to change for this refactor"). This skill is designed for deep analysis of a small number of files, not for wide-coverage listing.
- The task is a **large-scale structural change** spanning many files (e.g., directory reorganization, rename propagation across a monorepo).
- The expected output is a **flat list of files** rather than a reasoned diagnosis with evidence.

Structured certificate-based analysis **over-constrains** broad enumeration: it forces high-confidence, evidence-backed predictions, which reduces file coverage. This was confirmed empirically — on SWE-bench Pro localization tasks with 17–106 ground-truth files, the skill reduced accuracy from 100% to 80%. If the task does not fit, consider working without this skill.

For `diagnose` mode specifically:

| Condition | Use `diagnose` | Do NOT use `diagnose` |
|-----------|---------------|----------------------|
| Root cause scope | Likely 1–5 files | Many files (10+) across the codebase |
| Task nature | Single defect, specific test failure, error trace | Broad refactoring, feature addition, structural reorganization |
| Expected output | Ranked root cause with file:line evidence | Exhaustive list of files to modify |
| Evidence style | Deep code path tracing | Directory-level pattern matching |

## Core Principles

1. **Certificate-based reasoning.** You must state premises, trace concrete code paths with file:line evidence, and derive formal conclusions. You cannot skip sections or make unsupported claims.
2. **Premises before conclusions.** Write numbered premises grounded in known facts; every later claim references a premise by number. Do not treat guesses as premises.
3. **Hypothesis-driven exploration.** Form expectations (with confidence levels) before reading files; record observations and hypothesis updates after reading. Choose the next action by *discriminative power* — what unresolved uncertainty it resolves — not by fixed reading order.
4. **Interprocedural tracing as structure, not advice.** Read actual definitions and record their behavior per function, in real time, so skipping definitions is visibly incomplete. Never infer behavior from a function's name.
5. **Mandatory refutation.** Counterfactual / alternative-hypothesis checks are required at key intermediate claims, not only the final conclusion.
6. **Guardrails from the paper's error analysis** (see Guardrails below) translate each recurring failure mode into a hard constraint.

### Guardrails

From the paper's error analysis:

1. **Do not assume behavior from names.** Read the actual function definition. The canonical failure: assuming Python's builtin `format()` when a module-level function with different semantics shadows it.
2. **Do not claim test outcomes without tracing.** Trace each test through the relevant code path before asserting PASS or FAIL.
3. **Do not confuse symptom with root cause.** A crash site (e.g., StackOverflowError in a recursive method) may not be the origin of incorrect state. Trace upstream to find where the bad state was created.
4. **Do not dismiss subtle differences.** If you find a semantic difference between compared items, trace at least one relevant test through the differing code path before concluding the difference has no impact.
5. **Do not trust incomplete chains.** After building a reasoning chain, verify that downstream code does not already handle the edge case or condition you identified — e.g., via exception handlers, default values, or guard clauses. Confident-but-wrong answers often come from thorough-but-incomplete analysis.
6. **Handle unavailable source explicitly.** When a function's source is not in the repository (third-party library), mark it UNVERIFIED in trace tables. Search for type signatures, documentation, or test usage as secondary evidence. Do not guess behavior from the function name.

General:

7. Do not treat style preferences as findings unless they affect maintainability or correctness.
8. Do not hide uncertainty — state what is unverified.
9. Do not skip the refutation check. It is mandatory in every mode.
10. **Do not fabricate to fill template sections.** If you cannot verify a claim, write "NOT VERIFIED" or "N/A" rather than inventing plausible-sounding content. An incomplete but honest certificate is more valuable than a complete but fabricated one.

## Workflow

Apply this process in every mode. **Complete each section in order. Do not write a later section before completing earlier ones.** When a certificate template exists for your selected mode, **use that template as your primary guide** — it is the concrete implementation of Steps 1–6 for that mode.

### Step 1: Task and constraints

Write a short task statement and list constraints (e.g., no repository execution, static inspection only, file:line evidence required).

### Step 2: Numbered premises

Before concluding anything, write numbered premises grounded in known facts:

```
P1: [fact about the task, inputs, or expected behavior]
P2: [fact about relevant files, tests, or specifications]
P3: ...
```

Do not treat guesses as premises. Every later claim must reference a premise by number.

### Step 3: Hypothesis-driven exploration

Exploration priority is not a fixed reading order; choose the next action by discriminative power — what unresolved uncertainty it resolves. Before opening any file, write:

```
HYPOTHESIS H[N]: [what you expect to find and why]
EVIDENCE: [what supports this hypothesis — cite premises or prior observations]
CONFIDENCE: high / medium / low
```

After reading, record:

```
OBSERVATIONS from [filename]:
  O[N]: [finding with file:line]
  O[N]: [another finding with file:line]

HYPOTHESIS UPDATE:
  H[M]: CONFIRMED / REFUTED / REFINED — [explanation]

UNRESOLVED:
  - [remaining questions]

NEXT ACTION RATIONALE: [why the next file or step is justified]
OPTIONAL — INFO GAIN: [what uncertainty this action resolves; which hypothesis/claim it would confirm vs refute]
```

### Step 4: Interprocedural tracing

Update this table **in real time during Step 3** — add each row the moment you read a function definition. Do not write this table all at once from memory.

For every function or method encountered on a relevant code path, record:

| Function/Method | File:Line | Behavior (VERIFIED) | Relevance to test |
|-----------------|-----------|---------------------|-------------------|
| [name] | [file:N] | [actual behavior after reading the definition] | [which test(s) and why this function is on the relevant path] |

**Rules:**
- Read the actual definition. Do not infer behavior from the name.
- Mark the Behavior column VERIFIED only after reading the source.
- If source is unavailable (third-party library), mark UNVERIFIED and note the assumption. Search for type signatures, documentation, or test usage as secondary evidence. Optionally probe language behavior with an independent script.
- Trace through conditionals, mapping tables, and configuration — not just the happy path.
- For exception handling inside loops or multi-branch control flows: after recording the inferred behavior, ask "if this trace were wrong, what concrete input would produce different behavior?" Trace that input through the code before finalizing the row.

### Step 5: Refutation check (required)

This step is **mandatory**, not optional.

**Scope**: Apply counterfactual reasoning not only at the final conclusion, but at every key intermediate claim — especially:
- "No test exercises this difference" — before asserting this, describe what such a test would look like and show you searched for exactly that pattern.
- "This behavior is X" for a non-trivial control flow — before asserting this, ask what evidence would exist if the behavior were not X.
- "These test outcomes are identical/different" — before asserting this, state what evidence would refute it.

For `compare` and `audit-improve`:

```
COUNTEREXAMPLE CHECK:
If my conclusion were false, what evidence should exist?
- Searched for: [what]
- Found: [what — cite file:line]
- Result: REFUTED / NOT FOUND
```

For `explain` and `diagnose`:

```
ALTERNATIVE HYPOTHESIS CHECK:
If the opposite answer were true, what evidence would exist?
- Searched for: [what]
- Found: [what — cite file:line]
- Conclusion: REFUTED / SUPPORTED
```

### Step 5.5: Pre-conclusion self-check (required)

Before writing the formal conclusion, check each item below. If any answer is **NO**, fix it before Step 6.

- [ ] Every PASS/FAIL or EQUIVALENT/NOT_EQUIVALENT claim traces to a specific `file:line` — not inferred from function names.
- [ ] Every function in the trace table is marked **VERIFIED**, or explicitly **UNVERIFIED** with a stated assumption that does not alter the conclusion.
- [ ] The Step 5 refutation or alternative-hypothesis check involved at least one actual file search or code inspection — not reasoning alone.
- [ ] The conclusion I am about to write asserts nothing beyond what the traced evidence supports.

### Step 6: Formal conclusion

Write a conclusion that:
- References specific numbered premises and claims (e.g., "By P1 and C2…")
- States what was established
- States what remains uncertain or unverified
- Assigns a confidence level: HIGH / MEDIUM / LOW

## Checklist

### All modes

- [ ] Selected a mode before exploring files (default `explain` if unsure); confirmed the task passes the activation gates
- [ ] Wrote numbered premises (Step 2) before drawing any conclusion
- [ ] Kept a running interprocedural trace table, adding each row at the moment a function definition was read (Step 4), with every Behavior marked VERIFIED or explicitly UNVERIFIED
- [ ] Performed the required refutation / alternative-hypothesis check (Step 5) involving at least one real file search, not reasoning alone
- [ ] Passed every item of the pre-conclusion self-check (Step 5.5)
- [ ] Formal conclusion references numbered premises/claims, states what is unverified, and assigns a confidence level
- [ ] Did not fabricate content to fill template sections; wrote NOT VERIFIED / N/A where evidence is lacking

### Compare

- [ ] Structural triage first: compare modified file lists, check for missing modules or test data before any detailed tracing
- [ ] For large patches (>200 lines), rely on structural comparison and high-level semantic analysis rather than exhaustive line-by-line tracing
- [ ] Identified changed files for both sides
- [ ] Identified fail-to-pass AND pass-to-pass tests
- [ ] For each function called in changed code, read its definition and record it in the interprocedural trace table
- [ ] Traced each test through both changes separately before comparing
- [ ] When a semantic difference is found, traced at least one relevant test through the differing path before concluding it has no impact
- [ ] Provided a counterexample (if different) or justified no counterexample exists (if equivalent)

### Diagnose

- [ ] Stated what the failing behavior expects (Phase 1)
- [ ] Traced from entry point toward production code with per-method records (Phase 2)
- [ ] Every divergence claim references a specific premise (Phase 3)
- [ ] Ranked candidates and cited supporting claims (Phase 4)
- [ ] Distinguished symptom site from root cause — if the crash site differs from the origin of incorrect state, investigated upstream
- [ ] Checked for indirection: is the bug in a class not directly called by the test?

### Explain

- [ ] Read actual definitions — did not infer behavior from names
- [ ] Filled every row in the function trace table with VERIFIED behavior
- [ ] Tracked key variables from creation through modification to usage
- [ ] Identified semantic properties with per-property file:line evidence
- [ ] Checked the opposite answer before finalizing
- [ ] After identifying an edge case, verified whether downstream code already handles it before reporting it as a finding
- [ ] Stated uncertainty when downstream behavior is not fully verified

### Audit-Improve

- [ ] Defined the review target and scope clearly
- [ ] Stated the risk or quality property being checked as a premise
- [ ] Traced the relevant code path — did not flag isolated lines without context
- [ ] Separated CONFIRMED from PLAUSIBLE findings
- [ ] For each confirmed finding, verified it is reachable via a concrete call path
- [ ] For refactoring, proposed the safest minimal change first
- [ ] Did not report speculative security issues as confirmed vulnerabilities
- [ ] For API misuse, read the actual API definition or documentation before claiming misuse

## Output Format

### Minimal Response Contract

Every response using this skill must include:

| Element | Required in |
|---------|-------------|
| Selected mode | All |
| Numbered premises | All |
| Interprocedural trace table | All (when functions are on the code path) |
| Per-item analysis (per-test, per-method, or per-function) | compare, diagnose, explain |
| Refutation / alternative-hypothesis check | All |
| Formal conclusion with premise/claim references | All |
| Confidence level | All |

### Compare certificate template

Goal: determine whether two changes produce the same relevant behavior. Complete every section. Do not skip to FORMAL CONCLUSION without completing ANALYSIS.

```
DEFINITIONS:
D1: Two changes are EQUIVALENT MODULO TESTS iff executing the relevant
    test suite produces identical pass/fail outcomes for both.
D2: The relevant tests are:
    (a) Fail-to-pass tests: tests that fail on the unpatched code and are
        expected to pass after the fix — always relevant.
    (b) Pass-to-pass tests: tests that already pass before the fix — relevant
        only if the changed code lies in their call path.
    To identify them: search for tests referencing the changed function, class,
    or variable. If the test suite is not provided, state this as a constraint
    in P[N] and restrict the scope of D1 accordingly.

STRUCTURAL TRIAGE (required before detailed tracing):
Before tracing individual functions, compare the two changes structurally:
  S1: Files modified — list files touched by each change. Flag any file
      modified in one change but absent from the other.
  S2: Completeness — does each change cover all the modules that the
      failing tests exercise? If Change B omits a file that Change A
      modifies and a test imports that file, the changes are NOT EQUIVALENT
      regardless of the detailed semantics.
  S3: Scale assessment — if either patch exceeds ~200 lines of diff,
      prioritize structural differences (S1, S2) and high-level semantic
      comparison over exhaustive line-by-line tracing. Exhaustive tracing
      is infeasible for large patches and produces unreliable conclusions.

If S1 or S2 reveals a clear structural gap (missing file, missing module
update, missing test data), you may proceed directly to FORMAL CONCLUSION
with NOT EQUIVALENT without completing the full ANALYSIS section.

PREMISES:
P1: Change A modifies [file(s)] by [specific description]
P2: Change B modifies [file(s)] by [specific description]
P3: The fail-to-pass tests check [specific behavior]
P4: The pass-to-pass tests check [specific behavior, if relevant]

ANALYSIS OF TEST BEHAVIOR:

For each relevant test:
  Test: [name]
  Claim C[N].1: With Change A, this test will [PASS/FAIL]
                because [trace from changed code to test assertion outcome — cite file:line]
  Claim C[N].2: With Change B, this test will [PASS/FAIL]
                because [trace from changed code to test assertion outcome — cite file:line]
  Comparison: SAME / DIFFERENT outcome

For pass-to-pass tests (if changes could affect them differently):
  Test: [name]
  Claim C[N].1: With Change A, behavior is [description]
  Claim C[N].2: With Change B, behavior is [description]
  Comparison: SAME / DIFFERENT outcome

EDGE CASES RELEVANT TO EXISTING TESTS:
(Only analyze edge cases that the ACTUAL tests exercise)
  E[N]: [edge case]
    - Change A behavior: [specific output/behavior]
    - Change B behavior: [specific output/behavior]
    - Test outcome same: YES / NO

COUNTEREXAMPLE (required if claiming NOT EQUIVALENT):
  Test [name] will [PASS/FAIL] with Change A because [reason]
  Test [name] will [FAIL/PASS] with Change B because [reason]
  Diverging assertion: [test_file:line — the specific assert/check that produces a different result]
  Therefore changes produce DIFFERENT test outcomes.

NO COUNTEREXAMPLE EXISTS (required if claiming EQUIVALENT):
  If you already observed a semantic difference, name that difference first and test whether one concrete relevant test/input reaches the same assertion outcome on both sides.
  When claiming EQUIVALENT after observing a semantic difference, anchor the no-counterexample argument to that exact difference with one concrete relevant test/input and the same traced assertion outcome on both sides; otherwise mark the impact UNVERIFIED.
  If NOT EQUIVALENT were true, a counterexample would be this specific test/input diverging at [assert/check:file:line].
  I searched for exactly that anchored pattern:
    Searched for: [specific pattern — the observed difference, relevant test/input, and assertion/check]
    Found: [result — cite file:line, or NONE FOUND with search details]
  Conclusion: no counterexample exists because [brief reason]

FORMAL CONCLUSION:
By Definition D1:
  - Test outcomes with Change A: [PASS/FAIL for each test]
  - Test outcomes with Change B: [PASS/FAIL for each test]
  - Since outcomes are [IDENTICAL/DIFFERENT], changes are
    [EQUIVALENT/NOT EQUIVALENT] modulo the existing tests.

ANSWER: [YES equivalent / NO not equivalent]
CONFIDENCE: [HIGH / MEDIUM / LOW]
```

### Diagnose certificate template

Goal: identify the root cause of a single defect, not just the crash site.

**Scope constraint:** This mode is designed for defects whose root cause resides in a small number of files (typically 1–5). For tasks requiring broad file enumeration across many files, do not use this mode — the structured analysis will over-constrain the output and reduce coverage.

Complete phases in order. Each phase depends on the previous one.

```
PHASE 1: TEST / SYMPTOM SEMANTICS

What does the failing test or bug report describe?
State as formal premises:
  PREMISE T1: The test calls [X.method(args)] and expects [behavior]
  PREMISE T2: The test asserts [condition]
  PREMISE T3: The observed failure is [error type / wrong output / hang]
  ...

PHASE 2: CODE PATH TRACING

Trace the execution path from the test entry point into production code.
For each significant method call, record:

| # | METHOD | LOCATION | BEHAVIOR | RELEVANT |
|---|--------|----------|----------|----------|
| 1 | ClassName.method(params) | file:line | [verified behavior] | [why it matters to PREMISE T[N]] |
| 2 | ... | ... | ... | ... |

Build the call sequence: test → method1 → method2 → ...

PHASE 3: DIVERGENCE ANALYSIS

For each code path traced, identify where the implementation diverges
from the test's expectations. State as formal claims:

  CLAIM D1: At [file:line], [code] produces [behavior]
            which contradicts PREMISE T[N] because [reason]
  CLAIM D2: ...

Each claim MUST reference a specific PREMISE and a specific code location.

PHASE 4: RANKED PREDICTIONS

Based on divergence claims, produce ranked predictions:
  Rank 1 ([confidence]): [file:line range] — [description]
    Supporting claim(s): D[N]
    Root cause / symptom: [which one]
  Rank 2 ([confidence]): ...
```

Exploration protocol: use the hypothesis-driven format from the Workflow Step 3 during exploration. Number hypotheses H1, H2… and observations O1, O2… for traceability.

### Explain certificate template

Goal: answer a code question with verified semantic evidence. Complete every section. Do not write FINAL ANSWER before ALTERNATIVE HYPOTHESIS CHECK.

```
QUESTION: [restate the question]

FUNCTION TRACE TABLE:
| Function/Method | File:Line | Parameter Types | Return Type | Behavior (VERIFIED) |
|-----------------|-----------|-----------------|-------------|---------------------|
| [function1]     | [file:N]  | [param types]   | [ret type]  | [ACTUAL behavior]   |
| [function2]     | [file:N]  | [param types]   | [ret type]  | [ACTUAL behavior]   |

DATA FLOW ANALYSIS:
Variable: [key variable name]
  - Created at: [file:line]
  - Modified at: [file:line(s), or NEVER MODIFIED]
  - Used at: [file:line(s)]

(Repeat for each key variable)

SEMANTIC PROPERTIES:
Property 1: [e.g., "map is immutable after initialization"]
  - Evidence: [specific file:line]
Property 2: ...
  - Evidence: [specific file:line]

ALTERNATIVE HYPOTHESIS CHECK:
If the opposite answer were true, what evidence would exist?
  - Searched for: [what you looked for]
  - Found: [what you found — cite file:line]
  - Conclusion: REFUTED / SUPPORTED

FINAL ANSWER:
[answer with explicit evidence citations]

CONFIDENCE: [HIGH / MEDIUM / LOW]
```

### Audit-Improve certificate template

Goal: inspect code for risks or improvement opportunities, grounded in traced evidence.

Sub-modes:

- `security-audit` — injection, auth bypass, path traversal, secrets, unsafe defaults
- `refactor-review` — oversized units, duplication, mixed responsibilities, fragile flow
- `code-smell-check` — hidden coupling, dead branches, poor naming, hard-to-test design
- `api-misuse-check` — incorrect API usage, wrong assumptions about library semantics

| Sub-mode | Primary question | Key requirement |
|---|---|---|
| `security-audit` | Is this unsafe operation reachable? | Verify a concrete call path for every confirmed finding |
| `refactor-review` | What is the safest minimal change? | Always propose the smallest effective refactoring first |
| `code-smell-check` | Is there concrete coupling or testability harm? | Trace coupling to a specific dependency — do not flag patterns without evidence |
| `api-misuse-check` | Does the usage violate the documented contract? | Read the API definition or documentation before claiming misuse |

```
REVIEW TARGET: [file(s) / module / component]
AUDIT SCOPE: [which sub-mode(s) and what property is being checked]

PREMISES:
P1: [fact about the code's purpose or expected security properties]
P2: [fact about the API contract or framework requirements]
...

FINDINGS:

For each finding:
  Finding F[N]: [title]
    Category: security / refactor / smell / api-misuse
    Status: CONFIRMED / PLAUSIBLE (needs more evidence)
    Location: [file:line range]
    Trace: [code path that leads to this issue — cite file:line at each step]
    Impact: [what can go wrong and under what conditions]
    Evidence: [specific file:line proof]

COUNTEREXAMPLE CHECK:
For each confirmed finding, did you verify it is reachable?
  F[N]: Reachable via [call path] — YES / UNVERIFIED

RECOMMENDATIONS:
R[N] (for F[N]): [specific fix or mitigation]
  Risk of change: [what could break]
  Minimal safe change: [smallest effective fix]

UNVERIFIED CONCERNS:
- [issues that need more context or are speculative]

CONFIDENCE: [HIGH / MEDIUM / LOW]
```

## Light Entry — Single-File Logic Review (folded in from logic-lens/logic-review)

> 轻入口（2026-09-07 并入）：本文件上文的证书协议（compare / diagnose / explain / audit-improve）是逻辑评审的「深入口」；原 correctness/logic-review（蒸馏自 hyhmrright/logic-lens 的 skills/logic-review，单文件逻辑评审）作为「轻入口」收编于此，其目录保留为指针。
> Light entry (folded in 2026-09-07): the certificate protocol above (compare / diagnose / explain / audit-improve) is the deep entry for logic review; the single-file logic review distilled from hyhmrright/logic-lens (skills/logic-review) now lives in this section, and its old directory is kept as a pointer.

### 定位与双入口路由 / Positioning and two-entry routing

- **深入口**：目录/模块级，或已有具体失败现象（失败测试、栈轨迹、具体错误值）的推理任务——用上文的证书协议，本文件是唯一载体。
- **轻入口（本节）**：当用户贴出**单文件 / 单函数 / 粘贴片段**（单个单元），含糊地问 "review this"、"does this look right"、"检查这段代码"、"测试过但线上炸"，且**没有给出具体失败现象**——不走上面的证书模板，走本节流程，产出带 `Logic Score` 的评审报告。
- Two entries: deep (certificate protocol, above) for confirmed failures and module-level reasoning; light (this section) when a single file/function is pasted with a vague "review this / does this look right / 测试过但线上炸" and no concrete failure symptom.

### 范围硬规则 / Scope hard rule

- 只审**一个文件或一个函数**；输入是单文件、单函数或片段（片段无行号时以函数名与表达式锚定追踪，不虚构行号）。
- 目录/整个模块、已确认失败、两版本对比、整仓自动修复——**本语料没有对应的兄弟技能**：原 logic-review 路由到的 `logic-health`（目录/模块）、`logic-locate`（已确认失败）、`logic-diff`（两版本对比）、`logic-fix-all`（整仓自动修复）均**未收录**。遇到这类请求，应说明该场景无对应兄弟技能，并建议改用本文件深入口，或 correctness 角色的 bugsweep。
- Hard rule: one file or one function only; the siblings the original routed to (logic-health / logic-locate / logic-diff / logic-fix-all) are NOT in this corpus — state that, then recommend this file's deep entry or bugsweep (correctness role).
- 不触发：样式/格式化、安全扫描、性能、测试生成、架构/设计问题——只找**逻辑** bug。

### 报告契约 / Report contract

- 每条 finding（`## Findings` / `## 发现` 内）必须含五个**行首字面前缀**：`Premises:` / `Trace:` / `Divergence:` / `Trigger:` / `Remedy:`；中文：`前提：` / `追踪：` / `偏差：` / `触发：` / `修复：`。小节标题不算数——字段必须出现在 finding 块内部。
- 语言自动检测决定用哪套 token，整份报告只用一套；**禁止同义词替换**（"前置条件"≠`前提：`，"根因/核心缺陷/结论"≠`偏差：`——人读得通，下游子串匹配会判缺失）；可附加描述性副标题，但字面前缀必须保留。
- 无 bug 结论也要写 `Divergence: None — [why the premise holds]`（中文 `偏差：无——[原因]`）；`Divergence` 字段绝不省略。
- 已确认的 L 级 finding 不得降级为 "Additional observation / 附加观察"。
- Every finding block must carry the five literal line-starting prefixes in the detected language (no synonyms such as 前置条件/根因); no-bug conclusions still emit `Divergence: None — <reason>`.

### 工作流要点 / Workflow essentials

- **Step 0 — 语言与范围路由**：检测用户语言（决定 token 集）；确认范围是单文件/单函数，否则按范围硬规则处理。
- **Step 1 — claimed behavior**：读注释/docstring/测试名/提交信息，写一句话："This code is supposed to [verb] [what], given [inputs], producing [output/side effect]."——一切追踪以此句为反驳基准。
- **Step 2 — 先写前提再追踪**：跑 Premises Construction Checklist（前提清单：名称解析 / 类型契约 / 状态前置 / 控制流假设），先过 "What is NOT a Premise"；前提覆盖 caller 契约、callee 契约、状态生命周期、可观察后果。
- **Step 3 — 风险路径台账**：每条候选路径一行（风险代码 / 入口 / 输入与状态条件 / 涉及分支·callee·资源 / 是否可达及理由 / Class A|B），覆盖正常路径 + L3 边界（空/零/单元素/首尾/极值/除零·切片·索引）+ L1/L2 名称类型（遮蔽、动态分发、强转、nullable、反序列化）+ L6 callee（返回 null/raise/改参/变形）+ L5/L8 控制资源（每个提前 return/throw/catch/break/continue）+ L4/L7 状态并发（迭代中变更、共享可变默认、别名、闭包、await/线程边界）+ L9 时间区域编码；只有写明"不可达/无关"才能丢弃候选。
- **Step 4 — 深追踪与分歧点判定（可达性门）**：逐路径深追踪，≥3 个实质步骤且 ≥2 个位置锚点，低于阈值降级 Suggestion；**Class A（自明，触发条件在本地代码可见）** 本地代码即证据、按分配严重度报；**Class B（依赖外部不变量）** 先做可达性探测——(1) 搜不变量强制点（构造器/校验器/schema/可见调用点）；(2) 强制存在且无旁路 → **放弃不报**（可在 Summary 记 "Invariant enforced at [location] — no current bug"）；(3) 无强制 → 按严重度报；(4) 部分强制/越出当前范围 → 封顶 🟡 Warning + `manual verification recommended`；探测结果记入该 finding 的 Trace（非 Premises）。分歧点按 L1–L9 根因码归类（名称解析 / 隐式强转 / 边界盲区 / 单上下文别名变更 / 控制流逃逸抑制 / callee 契约不符 / 跨执行上下文状态危害 / 资源释放回滚失败 / 时间·区域·编码类型级丢失），按根因去重（一个坏 callee 契约多个调用点症状 → 报一条 L6）。
- **Step 5 — 对抗式证伪**：对每个幸存候选做三连反驳——前提反驳（前提是否基于未验证假设？）、路径反驳（触发路径在生产中真可达吗？上游 guard/配置/中间件/类型约束是否挡住？）、后果反驳（下游 catch/兜底/重试/幂等是否中和危害？）——结论记入 Trace：`Rebuttal check: PASSED` / `DOWNGRADED` / `WITHDRAWN`（中文：`反驳检查：已通过/已降级/已撤回`）；L7 并发类只接受显式同步原语为防御，GIL/单线程事件循环/"时机不太可能"一律不算防御。
- Five-step skeleton: Step0 language + scope routing → Step1 one-sentence claimed behavior → Step2 premises before tracing (name resolution / type contracts / state preconditions / control-flow assumptions) → Step3 risk-path ledger → Step4 deep tracing + divergence adjudication under the reachability gate (Class A self-evident: reportable on local code; Class B invariant-dependent: reachability probe required before reporting) → Step5 adversarial falsification (premise / path / consequence rebuttals).
- 收尾细节（高保真补充）：Remedy 须可粘贴的代码；Trigger 须可复现（构造不出具体触发 → 自动降级 Suggestion；外部状态依赖标记 `manual verification recommended`）；Remedy 干跑（dry-run）确认原偏差消除、无回归、happy path 不变；有运行时则执行验证门（8a 最小复现脚本 = 纯计算 + 断言 → 8b 原码上应 FAIL，PASS 即误报撤回并回滚扣分 → 8c 应用修复后应 PASS 标 `✅ Execution-verified`；无运行时标 `⚠️ Unverified — no runtime available`）。

### 输出 / Output

- 报告骨架：Mode 行（Logic Review / 逻辑审查）、Scope 行（`**Scope:**` / `**范围：**`）、字面行 `**Logic Score:** XX/100`（中文 `**逻辑评分：** XX/100`，不是 "Score:"/"Quality:"），置于 Scope 行正下方，再渲染 `## Findings`（`## 发现`）与 `## Summary`。
- 评分从 100 起算：Critical −15、Warning −7、Suggestion −2；被可达性探测/执行验证撤回的 finding 同步回滚扣分。
- **"没有确认的逻辑错误 = 100/100 是专业结果"**——正确性平价：绝不降证据标准凑发现；每条安全路径记一句安全终止理由（≥1 句），但不包装成 Suggestion finding；问 "does X cause bug Y?" 且追踪证明 Y 不适用时，写五字段无 bug 结论而非编造 finding。
- Output: report with Logic Score 0–100; "no confirmed logic errors = 100/100" is a professional result — never lower evidence standards to manufacture findings.
- Provenance：并入自 hyhmrright/logic-lens（repo: https://github.com/hyhmrright/logic-lens，path: skills/logic-review），2026-09-07；license unknown。

## Provenance

- Source repo: https://github.com/KunihiroS/agentic-code-reasoning-skills
- Original path: repo root (`.`); the canonical skill is `SKILL.md`, reorganized per this distillation.
- License: MIT (Copyright (c) 2026 KunihiroS)
- Source paper: Agentic Code Reasoning, Ugare & Chandra (Meta), arXiv:2603.01896
- 蒸馏说明：原目录含 28 文件（SKILL.md + README/CLAUDE/Objective/design 等辅助 md、docs/、prompts/ 8 个自改进 prompt 模板、auto-improve.sh 与 benchmark 脚本等）。SKILL.md 正文即技能本体，几乎原样保留并按统一骨架重组；`prompts/`、`auto-improve.sh`、`scripts/`、`benchmark/` 相关说明属于该仓库对 SKILL.md 自身的自动化自我改进开发流程（非技能运行内容），已不纳入正文；需要精确迭代流程/审计细则可查原仓库的 `Objective.md`、`failed-approaches.md`、`docs/design.md`、`docs/iteration-workflow.md`。
- Distillation note: the SKILL.md body was the complete skill; auxiliary .md/.sh/py/json/pdf files document the repo's own automated self-improvement harness over SKILL.md and were not inlined. Benchmark results cited (compare +5.0pp, audit-improve +6.3pp on claude-haiku-4.5) live in the original README.
