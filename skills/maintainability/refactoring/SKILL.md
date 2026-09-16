---
name: refactoring
description: 'Applies safe, continuous refactoring that improves structure without changing behavior:
  small reversible steps on a green test suite, dead-code removal, extraction into
  named functions, constants over magic values. Use for cleanup or simplify asks.'
---

# refactoring

> 蒸馏自 Teqqles/cleanerCodeAISkills（skills/refactoring）。原为 6 文件（SKILL.md + 5 份语言示例参考），已内联合并为单文件。
> Distilled from Teqqles/cleanerCodeAISkills (skills/refactoring); originally 6 files (SKILL.md + 5 per-language example references), now inlined as text.
> 整合说明（2026-09-07）：圈复杂度（cyclomatic-complexity）专项的测量/战术/硬规则已并入文末。
> Integration 2026-09-07: the cyclomatic-complexity tactic (measurement, tactics, hard rules) is folded in at the end.

## When to Use

- Use whenever the user asks you to refactor, clean up, simplify, or improve existing code.
- Trigger phrases: "this is getting messy", "clean this up", "simplify this", "rename this", "remove dead code".
- Proactive trigger while reviewing code: magic values, overly long functions, deep nesting, duplicated logic, or misleading names — suggest the refactoring even if not asked.

## Core Principles

### Refactoring Is a Habit, Not a Task
Every time you touch code, leave it clearer than you found it: the Boy Scout Rule.
- When adding a feature, refactor the surrounding code to make the addition clean.
- When fixing a bug, improve the code that made the bug possible.
- "We'll clean this up later" is a deferral to never.

### Small, Reversible Steps Only
Large refactors are hard to review, easy to break, and hard to revert.
- Each step leaves the tests green.
- Commit after each meaningful step: a commit is a checkpoint.
- One step per commit when a refactor requires multiple steps.
- When something goes wrong, revert to the last green commit.

### Always Rely on a Passing Test Suite
- Never refactor without tests covering the code being changed.
- Run the tests after every step: not at the end.
- Write tests before refactoring if none exist.
- The test suite proves behaviour has not changed.
- The one exception is a *provably inert* edit — deleting something grep-verified as unreferenced, where no behaviour can change. There a syntax check plus an import/smoke check suffices; a behaviour-adjacent refactor never qualifies.

### Refactoring Must Not Alter Observable Behaviour
A refactor changes structure, not behaviour.
- Behaviour changes get their own commit, separate from refactoring.
- Mixing the two makes review impossible and corrupts the safety net.
- "Refactor then change" is always cleaner than "change and refactor simultaneously".

## Refactoring Patterns

### Remove Dead Code Immediately
Dead code confuses every reader who must determine whether it matters.
- Delete unused variables, parameters, imports, functions, and classes.
- Do not comment out code: version control preserves history (a commented-out "old rate, kept for reference" line is dead code — delete it).
- Do not write `// TODO: remove this`: remove it now or track it in an issue.
- Unused code compounds; readers assume it might be important.

### Simplify Complex Logic Into Named Functions
- Extract complex conditionals into a function named after the decision: `isEligibleForDiscount()` not `if (age > 65 && tier == 2)`.
- Extract logic into named functions when the name adds meaning, even if used once — this bullet is about naming a *decision*, not about deduplicating (duplication has its own, separate threshold).
- Each function operates at one level of abstraction.

### Replace Magic Values With Named Constants
No numeric or string literals with non-obvious meaning in logic.

```javascript
// Before
if (response.status == 429) {
  sleep(2000)
  retry(3)
}

// After
const HTTP_TOO_MANY_REQUESTS = 429
const RETRY_DELAY_MS = 2000
const MAX_RETRIES = 3

if (response.status == HTTP_TOO_MANY_REQUESTS) {
  sleep(RETRY_DELAY_MS)
  retry(MAX_RETRIES)
}
```

- `MAX_RETRY_ATTEMPTS = 3` is clear; `if retries > 3` is not.
- Name the constant after its meaning: `MAX_CONNECTIONS`, not `THREE`.
- Group related constants together.

### Flatten Nesting With Early Returns
- Guard clauses return early on the negative cases instead of deepening `if` blocks.
- Java/TS/JS: `if (x == null) return DEFAULT;` then proceed — 4 nested levels collapse to flat sequential guards.
- Python: same with `if not x: return ...` guards.
- Scala: flatten nested `Option`/null checks with `match` on the `Option` (or the value), guarding each negative case (`case None => 0; case Some(i) if !i.isPaid => 0; ...`).

## Language Idioms for the Four Core Patterns

| Pattern | Java | TypeScript / JavaScript | Python | Scala |
|---|---|---|---|---|
| Extract condition | `private boolean hasActivePaidSubscription(User u) { return ... }` | `function hasActivePaidSubscription(user) { return ... }` | `def has_active_paid_subscription(user): ...` | `def hasActivePaidSubscription(user: User): Boolean = ...` |
| Name constants | `private static final int HTTP_TOO_MANY_REQUESTS = 429;` | `const HTTP_TOO_MANY_REQUESTS = 429` | `HTTP_TOO_MANY_REQUESTS = 429` | `val HttpTooManyRequests = 429` (UpperCamel values) |
| Delete dead code | Delete commented-out leftovers such as `// BigDecimal legacyRate = ... // old flat rate` | Same — commented "old rate, kept for reference" lines are removed | Same — commented-out `legacy_rate` lines are removed | Same |
| Flatten nesting | Guard each null/empty state with early `return DEFAULT;` | Guard with `if (!invoice) return 0` etc. | Guard with `if not invoice: return 0` etc. | Match on `Option`; guards `case Some(i) if ...` for each negative case |

## Checklist

- [ ] Only refactor code covered by tests; write characterization tests first if none exist.
- [ ] Keep every step small and reversible; commit after each meaningful step (one step per commit).
- [ ] Run the test suite after every step — green before moving on; revert to the last green commit on failure.
- [ ] Behaviour changes get their own commit, never mixed with structural refactors.
- [ ] Dead code (unused vars/params/imports/functions/classes, commented-out blocks) deleted, not preserved as comments.
- [ ] Complex conditions extracted into functions named after the decision.
- [ ] Magic values replaced by named constants with meaningful names, grouped together.
- [ ] Nesting flattened with early returns / guards (Scala: flat `match` on `Option`).
- [ ] Leave the code clearer than you found it (Boy Scout Rule).

## Cyclomatic Complexity Tactic — measure first, then refactor

> Provenance: 并入自 saurabhkumar8112/cyclomatic-complexity-skill（repo: https://github.com/saurabhkumar8112/cyclomatic-complexity-skill，path: skills/cyclomatic-complexity，license unknown — see repo）。

Purpose: AI-written code often works but branches like a jungle. This tactic: measure complexity, refactor hotspots, keep code human-maintainable.

### Measure first

CC = decision points + 1. Decision points: `if`, `else if`, `case`, loops, `catch`, ternary, `&&`, `||` in conditions.

Project linter config wins. If eslintrc, radon config, sonar config, or similar sets a complexity threshold, use that. No config: use defaults below.

Thresholds (this skill's starting default, not a standard — tune them to the project's own linter and keep them stable within a run):
- 1-5: fine, leave alone
- 6-10: watch, refactor if touching anyway
- 11-15: refactor now
- 15+: must split, no debate

Prefer real tools over eyeballing when environment allows:
- Python: `radon cc -s -a <path>`
- JS/TS: eslint `complexity` rule
- Go: `gocyclo`
- Polyglot: `lizard <path>`

No tool available: count manually, per function, show the count.

### Refactor tactics, in order of preference

1. **Guard clauses.** Invert conditions, return early, kill nesting.
2. **Extract function.** Each extracted piece gets a name that says what, not how. Names are documentation.
3. **Lookup table / map** instead of if-else or switch chains.
4. **Named predicates.** `if (isEligibleForRefund(order))` beats a 4-clause boolean soup.
5. **Polymorphism / strategy** for switch-on-type. Only when the switch appears in 2+ places.
6. **Flatten loops.** Extract loop body, use continue instead of nested if.

### Hard rules

- Preserve behavior. Run tests before and after. No tests: say so, suggest adding, refactor conservatively.
- Don't game the metric. A dense one-liner hiding 6 branches is worse than the honest if-chain it replaced. Complexity should move into well-named units, not disappear into cleverness.
- Don't break public APIs or exported signatures without asking.
- Small functions with clear names > few functions with comments explaining sections.
- One responsibility per function. If the name needs "and", split.

### Workflow

1. Measure all touched functions, rank by CC descending.
2. Report hotspots with numbers before touching anything.
3. Refactor worst first, one function at a time.
4. Re-measure. Show before/after table: function, CC before, CC after.
5. Verify: tests pass, behavior unchanged, diff reviewable.

### Output format

End every refactor with:

```
## Complexity report
| Function | Before | After |
|----------|--------|-------|
| parseOrder | 14 | 4 |

Extracted: validateHeader, resolveDiscount
Behavior verified: <how>
```

Keep prose minimal. Numbers and diffs do the talking.

## Provenance

- Source repo: https://github.com/Teqqles/cleanerCodeAISkills
- Original path: skills/refactoring
- License: unknown — see repo
- 蒸馏说明：原含 6 文件（SKILL.md + 5 份语言示例参考 typescript/python/java/scala/javascript）。参考文档示范 4 个核心重构（抽取命名条件、常量替换魔法值、删除死代码、早退展平嵌套）的各语言写法，已概括为「语言惯用法」表与正文规则；完整逐语言 before/after 代码示例被压缩。需要原文见原仓库 references/ 目录。
