---
name: fp-check
description: Systematically verifies a suspected defect and issues a TRUE POSITIVE or FALSE POSITIVE verdict with documented evidence; use to check whether a specific finding is a real behavioral defect, not to hunt for new bugs.
---

# fp-check

> 边界标注（2026-09-07）：只验证"用户指出的具体疑似 bug"的真伪，不主动寻找新 bug。
> Boundary (2026-09-07): verifies one user-pointed finding only — it does not hunt for new bugs.

> 蒸馏自 trailofbits/skills（仓库内 `plugins/fp-check/skills/fp-check`）。原为多文件 skill（SKILL.md + 6 篇 references 文档 + yaml/svg 资产），附属文档已全部内联为单文件。
> Distilled from trailofbits/skills (`plugins/fp-check/skills/fp-check`); originally multi-file with reference docs, now inlined as a single file.

## When to Use

Verify or validate a specific suspected defect and eliminate false positives. Trigger phrases:
- "Is this bug real?" / "is this a true positive?"
- "Is this a false positive?" / "verify this finding"
- "Does this code really behave this way?"
- Any request to verify or validate a specific suspected defect

Input: one concrete finding/claim (file + line/symptom). Output: per-bug verdicts — `BUG #N TRUE POSITIVE — [description]` or `BUG #N FALSE POSITIVE — [reason]` — each backed by documented evidence, plus a final summary with counts.

When NOT to Use:
- Finding or hunting for bugs ("find bugs", "audit code").
- General code review for style, performance, or maintainability.
- Feature development or refactoring.
- Security-class review (exploitability, attack surface, auth) — out of scope here.
- When the user explicitly asks for a quick scan without verification.

Operating note: every suspected bug gets full verification through the chosen path — no partial analysis, no "rapid analysis of remaining bugs". Original tool allowance: Read, Grep, Glob, LSP, Bash, Task, Write, Edit, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, TaskGet.

## Core Principles

1. **Verification, not pattern recognition.** "This pattern looks dangerous" is not analysis; complete the data-flow trace before any conclusion. Unsafe-looking code may have upstream validation.
2. **Each instance is verified independently.** Similar code being defective elsewhere proves nothing — every context has different validation, callers, and protections.
3. **LLMs are biased toward seeing bugs and overrating severity.** Actively argue against the claim (devil's advocate) and prove it with evidence before any TRUE POSITIVE verdict.
4. **Never skip verification for efficiency, and never short-circuit a bug because it "looks" obvious.** If a verification phase fails, document the failure with evidence and continue all remaining phases — issue FALSE POSITIVE only after all phases complete.
5. **Rationalizations to reject (STOP if you catch yourself thinking any of these)** — each re-litigates principles 1–4 above and none survives them: "rapid analysis of remaining bugs"; "this pattern looks dangerous, so it's a defect"; "skipping full verification for efficiency"; "the code looks unsafe, report it without tracing data flow"; "similar code was defective elsewhere"; "this is clearly critical".

## Workflow

### Step 0: Understand the Claim and Context

Restate the bug in your own words before any analysis. If you cannot state it clearly, ask the user for clarification — half of false positives collapse here because the claim does not make coherent sense when restated precisely. Document:
- **Exact defect claim** (e.g., "`parse_header()` overflows when `content_length` exceeds 4096").
- **Alleged root cause** (e.g., "missing bounds check before `memcpy` at line 142").
- **Supposed trigger** (e.g., "a request with an oversized Content-Length header").
- **Claimed impact** (e.g., "the process crashes / returns corrupt data").
- **Reachability context**: what a real caller/input/schedule must do to reach this path, and what constraints on the input already exist upstream.
- **Bug class** — classify it and apply the class-specific verification requirements (see "Bug-Class Verification" below) in addition to the generic phases.
- **Execution context** — when and how this code path is reached in normal execution.
- **Caller analysis** — which functions call this code and what input constraints they impose.
- **Architectural context** — is this part of a larger system with layers that already guard against this condition?
- **Historical context** — recent changes, known issues, previous reviews of this area.

### Route: Standard vs Deep Verification

**Standard Verification** — use when ALL hold: clear, specific claim (not vague); single component (no cross-component interaction in the bug path); well-understood bug class (buffer overflow, integer overflow, off-by-one, unvalidated input, …); no concurrency/async in the trigger; straightforward data flow from input to operation. No task tracking — work the linear checklist sequentially, documenting findings inline.

**Deep Verification** — use when ANY hold: ambiguous claim interpretable multiple ways; cross-component bug path (data flows through 3+ modules/services); race conditions / TOCTOU / concurrency in the trigger; logic bugs without a clear spec to verify against; standard verification inconclusive or escalated; user explicitly requests full verification. Track each phase as a task with explicit dependencies.

**Default:** start with standard. Standard has two built-in escalation checkpoints that route to deep when complexity exceeds the linear checklist. When escalating, hand off all evidence gathered so far — deep continues from where standard left off, without repeating completed work.

### Standard Verification Path

**Step 1 — Data Flow.** Trace data from source to the alleged defect site. Map trust boundaries (internal/trusted vs external/untrusted); identify all validation and normalization between the input and the operation; check API contracts (many APIs have built-in bounds protection that prevents the alleged issue); check environmental protections (compiler, runtime, OS, framework) that prevent the deviant behavior *entirely* (not just make it less likely to surface); apply class-specific checks. **Key pitfall:** analyzing the defective code in isolation — conditional logic upstream may make the deviation mathematically unreachable; trace the full validation chain. **Escalation check:** 3+ trust boundaries, callbacks/async control flow, or an ambiguous validation chain in the path → escalate to deep.

**Step 2 — Trigger / reachability.** Prove a concrete input, timing, or call actually drives the operation into the deviant behavior. **Input control:** prove the data reaching the operation can really take the value needed to trigger the deviation — internal storage set by trusted components cannot. **Bounds proof:** for integer/bounds issues create an explicit algebraic proof: verify `IF validation_check_passes THEN bounds_guarantee_holds`. **Race feasibility:** for race conditions prove concurrent access is actually possible — single-threaded initialization and synchronized contexts cannot have races.

**Step 3 — Behavioral impact.** Determine whether the deviation has a real, observable consequence. Distinguish a genuine behavior-vs-intent failure (wrong output, data corruption, a crash users hit) from a theoretical or stylistic concern. Distinguish a primary guard from a defense-in-depth measure: if the primary guard still enforces the intended behavior, a defense-in-depth gap is not a defect.

**Step 4 — Reproduction sketch.** Create a pseudocode reproduction showing the path to the deviant behavior (executable and unit-test reproductions optional in standard):

```
Data Flow: [Input] → [Validation?] → [Transform?] → [Operation] → [Observed deviation]
Input control: [what input, how it reaches here]
Trigger: [pseudocode showing the path to the wrong behavior]
```

**Step 5 — Devil's Advocate Spot-Check.** Answer the full 13-question review (below); if any answer produces genuine uncertainty you cannot resolve with the evidence at hand, escalate to deep verification. Re-read the code after reaching a conclusion.

**Step 6 — Gate Review.** Apply all six gates and all 13 false-positive-pattern items to reach the verdict (below).

### Deep Verification Path

Create one task per phase for each bug (Bug #N), wiring dependencies so each phase stays blocked until everything it depends on is complete:

```
Phase 1: Data Flow Analysis
  Task 1.1: Map trust boundaries and trace data flow
  Then in parallel (blocked by 1.1): 1.2 Research API contracts and safety guarantees;
  1.3 Environment protection analysis; 1.4 Cross-reference analysis
Phase 2: Trigger / Reachability Verification (blocked by Phase 1)
  In parallel: 2.1 Confirm a concrete input/timing reaches the defect; 2.2 Mathematical bounds
  verification; 2.3 Race condition feasibility proof
  Then (blocked by 2.1–2.3): 2.4 Adversarial analysis (input control,
  guard bypass paths, timing dependencies, state manipulation)
Phase 3: Impact Assessment (blocked by Phase 2)
  In parallel: 3.1 Demonstrate real behavioral impact; 3.2 Primary guard vs defense-in-depth
Phase 4: Reproduction (blocked by Phase 3)
  4.1 Create pseudocode reproduction with data flow diagram (ALWAYS)
  Then in parallel (blocked by 4.1): 4.2 Executable reproduction (if feasible);
  4.3 Unit test reproduction (if feasible); 4.4 Negative reproduction — show trigger preconditions
  Then (blocked by 4.2–4.4): 4.5 Verify reproduction demonstrates the deviant behavior
Phase 5: Devil's Advocate (blocked by Phase 4) — 5.1 devil's advocate review
Gate Review (blocked by Phase 5) — evaluate all six gates before verdict
```

**Execution rules:** mark each task in-progress when starting, completed only with concrete evidence; launch independent sub-phases in parallel and collect all results before the next dependency gate; never start a phase until all tasks it depends on are complete; apply the full 13-item false-positive checklist to each bug.

**Agents (if delegating):** delegate Phase 1 tasks to a data-flow analyzer, Phase 2 to a trigger/reachability verifier, Phase 4 to a reproduction builder, passing the bug description and prior phase results as context. Phases 3, 5 and the Gate Review require cross-phase synthesis — handle them yourself; do not delegate.

**Phase pitfalls / decision criteria:**
- **1.3:** distinguish "prevents the deviation entirely" (e.g., Rust safe type system) from "makes the symptom less likely to surface" (e.g., a reprieve that masks it) — anything that only lowers the odds does not eliminate the deviation itself.
- **4.4 Negative reproduction:** demonstrate the gap between normal operation and the deviant path — what preconditions must hold for the deviation to trigger and why they do not hold under normal conditions.

**Devil's Advocate — full 13-question review** (document answers for each; 1–11 argue AGAINST the defect, 12–13 argue FOR it as false-negative protection):
1. What non-defect explanations exist for this code pattern?
2. How would the original developers justify this implementation?
3. What crucial system architecture context might be missing?
4. Am I seeing a defect because the pattern "looks dangerous" rather than because the behavior actually deviates?
5. Even if validation looks insufficient, does it actually prevent the claimed condition?
6. Am I incorrectly assuming the input can take the triggering value?
7. Have I rigorously proven the mathematical condition for the deviation can occur?
8. Beyond theoretical possibility, is this actually reachable in practice?
9. Am I confusing a defense-in-depth gap with a genuine behavior failure?
10. What compiler/runtime/OS guards might prevent the deviation?
11. Am I hallucinating this defect? LLMs are biased toward seeing bugs everywhere and rating every finding critical — is this a real, reproducible deviation or pattern-matching on scary-looking code?
12. Am I dismissing a real defect because triggering it seems complex or unlikely?
13. Am I inventing mitigations or validation logic that I haven't verified in the actual source code? Re-read the code after reaching a conclusion.

### Batch Triage (multiple bugs)

1. Run Step 0 for all bugs first — restating each claim often collapses obvious false positives immediately.
2. Route each bug independently (some standard, some deep).
3. Process all standard-routed bugs first, then deep-routed bugs.
4. After all bugs are verified, check for **combined failures** — findings that individually failed gate review may combine into a real defect.

## Checklist

**False-Positive Pattern Checklist — apply ALL 13 items to EVERY potential defect:**
- [ ] 1. Trace full validation chain backwards from the operation — don't analyze isolated snippets.
- [ ] 1a. Map complete conditional logic flow: what conditions must hold for execution to reach the alleged defect? Do those conditions mathematically prevent the deviant scenario (e.g., code reachable only when `length > 12` makes `buffer[length-4]` safe)? Are there minimum size/length requirements guaranteeing safe access?
- [ ] 2. Identify defensive programming patterns — `ASSERT(size == expected_size)` followed by size-controlled operations is defensive, not defective; verify checks actually prevent the alleged deviation.
- [ ] 3. Confirm the defective data path — report only defects with a confirmed reachable data flow, traced step by step.
- [ ] 4. Understand data source context — API return values, compile-time constants and network data have different trust profiles; determine the actual source.
- [ ] 5. Analyze bounds validation logic — find the mathematical relationship between validation checks and later operations (`packet_size >= MIN_SIZE` and `MIN_SIZE >= sizeof(header)` ⇒ `packet_size - sizeof(header)` cannot underflow).
- [ ] 6. Verify TOCTOU claims — prove the checked value can change between check and use; if a size is checked and immediately used with no external modification possible, there is no TOCTOU.
- [ ] 7. Understand API contract and trust boundaries before claiming overflows — built-in bounds protection may make overflows impossible regardless of input.
- [ ] 8. Distinguish internal storage from external input — config stores/registries are controlled by trusted components; install-time values are not input-controlled.
- [ ] 9. Don't confuse pattern recognition with defect analysis — size parameters being modified ≠ buffer overflow when the API prevents writing beyond bounds.
- [ ] 10. Verify concurrent access is actually possible — no races in single-threaded initialization or synchronized contexts; verify the threading model and synchronization.
- [ ] 11. Assess real vs theoretical impact — does the deviation produce wrong output, data loss/corruption, or a crash users hit? A robustness-only failure is a lower-severity concern, not a behavior-vs-intent defect.
- [ ] 12. Understand defense-in-depth vs primary controls — a defense-in-depth gap is not always a defect if primary guards still enforce the intended behavior (token cleanup failure is not critical if tokens are single-use by design at the server).
- [ ] 13. Apply the checklist rigorously, not superficially — for EVERY potential defect work through ALL items before concluding.

**Six Gate Review — before reporting ANY bug as a true positive, ALL must pass:**
- [ ] Gate 1 Process: all phases completed with documented evidence (not just assertions).
- [ ] Gate 2 Reachability: a concrete input, timing, or call reaches the defective behavior — a reachable path + reproduction confirms it.
- [ ] Gate 3 Real Impact: the behavior deviates from intent with an observable consequence (wrong output, data corruption, a crash) — not merely a theoretical or stylistic concern.
- [ ] Gate 4 Reproduction Validation: the reproduction (pseudocode, executable, or unit test) demonstrates the failure — input/timing, trigger, observed deviation.
- [ ] Gate 5 Math/Evidence Bounds: the proof or evidence chain shows the deviant condition is possible (the guard does NOT prevent it).
- [ ] Gate 6 Environment: no environmental guard entirely prevents the deviant behavior.

## Bug-Class Verification

Apply class-specific requirements in addition to the generic phases. In every class the question is the same: does the *behavior* deviate from intent for an input a real caller can supply?

- **Memory corruption** (overflow, UAF, double-free, type confusion). *Language safety check first:* memory corruption in safe Rust, Go (without `unsafe.Pointer`/cgo), or managed languages (Java, C#, Python) is almost always a false positive. Check for `unsafe` blocks (Rust), cgo/`unsafe.Pointer` (Go), JNI/P-Invoke (managed) — if entirely in the safe subset, reject the claim unless it involves a compiler bug/soundness hole. Verify: what exactly gets corrupted (object/field/region); the corruption size/offset and how the triggering input reaches it; whether it is deterministic or dependent on allocation layout; UAF → trace object lifetime (what frees, what reuses, is the reuse reachable from the same trigger); type confusion → prove the mismatch and show the misinterpreted value reaching an operation that depends on it.
- **Logic bugs** (state transitions, invariant violations, wrong branch, confused deputy). Check against spec/RFC/design docs, not just code; map all state transitions and unreachable-by-design states; identify implicit assumptions never enforced in code; verify every path that reaches the operation — a guard on one path does not cover another, and secondary checks may already catch it. Note: logic bugs pass every bounds check and mathematical proof — clean static analysis must not convince you it's a false positive.
- **Race conditions** (TOCTOU, data races, signal-handling races). What is the actual race window (nanoseconds or seconds)? Can ordinary conditions widen it (a slow filesystem, a large allocation, CPU contention, a GC pause) rather than only a contrived schedule? Verify the threading model and all synchronization primitives (mutexes, atomics, RCU, lock-free). Filesystem TOCTOU: can the path change between check and use (symlink races)?
- **Integer issues** (overflow, underflow, truncation, signedness, wraparound). Exact integer types and ranges at every point; signed overflow (undefined behavior in C/C++, the compiler may assume it cannot happen) vs unsigned (defined wraparound); trace all casts/conversions/promotions — where does truncation or sign extension occur; is the resulting value used dangerously (allocation size, array index, loop bound); check `-Wconversion`/`-Wsign-compare` compiler warnings.
- **Unvalidated input reaching an operation** (string-built queries, unescaped paths, unchecked sizes, missing null guards). The question is behavioral, not adversarial: does an input a real caller can supply make the operation return the wrong result, act on the wrong object, or fail outright? Trace the input from its entry point to the operation and check whether an upstream constraint (validation schema, middleware, type guarantee, trusted source) already bounds it — if it does, the deviation is unreachable and the claim is a false positive.
- **Liveness / termination** (unbounded loops, missing cancellation, runaway resource growth). What input or state makes the operation fail to terminate, or to keep consuming without releasing? Prove the worst case is reachable by a real caller rather than merely asserted; distinguish a hang a caller can hit from one needing a contrived schedule. (The *availability* consequence of such a bug — SLO, blast radius, how the service recovers — is out of scope here.)

The exploitability question is out of scope here: injection, authorization/authentication, cryptographic parameter choice, information disclosure, and deserialization gadget chains are not judged by this skill. The classes above cover their *behavioral* reading only — what a caller observes going wrong. A finding whose sole defect is that the code is exploitable, with no behavioral deviation, is out of scope.

## Output Format

Verdict per bug (use the literal verdict lines):
- **TRUE POSITIVE**: all six gate reviews pass → `BUG #N TRUE POSITIVE — [brief behavioral-defect description]`
- **FALSE POSITIVE**: any gate review fails → `BUG #N FALSE POSITIVE — [brief reason for rejection]`

If any phase fails verification, document the failure with evidence and continue all remaining phases; issue the FALSE POSITIVE verdict only after all phases are complete.

**Final summary** (after processing ALL suspected bugs): (1) Counts — X TRUE POSITIVES, Y FALSE POSITIVES. (2) TRUE POSITIVE list — each with a brief behavioral-defect description. (3) FALSE POSITIVE list — each with a brief reason for rejection.

**Evidence templates (document per bug):**

```
Bug #N Data Flow Analysis
Source: [exact location] — Trust Level: [trusted/untrusted]
Path: Source → Validation1[file:line] → Transform[file:line] → Defect[file:line]
Validation Points:
  - Check1: [condition] at [file:line] — [passes/fails/bypassed]
  - Check2: [condition] at [file:line] — [passes/fails/bypassed]
```

```
Bug #N Mathematical Analysis
Claim: Operation X deviates under [overflow/underflow/bounds violation]
Given Constraints: [list all validation conditions]
Algebraic Proof:
1. [first constraint from validation] ... N. Therefore: [confirmed/debunked] (Q.E.D.)
Conclusion: [deviation is/is not mathematically possible]
```
Example: Given `input_size >= MIN_SIZE` (validation), `MIN_SIZE = 16`, `header_size = 8`; then `input_size >= 16`, `input_size - 8 >= 8`, so `input_size - header_size >= 8` — underflow impossible.

```
Bug #N Input/Reachability Analysis
Input Vector: [how the input reaches this code] | Control Level: [full/partial/none]
Constraints: [limits on the input] | Reachability: [can the triggering value reach the operation?]
```

```
Reproduction for Bug #N: [description]
Data Flow Diagram: [Input] → [Validation] → [Processing] → [Deviant Operation],
annotated per stage with input control / possible bypass / transform / deviant op.
PSEUDOCODE: function + weak_validation (why it fails) + transform + unsafe_operation (trigger)
```

```
Bug #N Devil's Advocate Review
Defect Claim: [description]
1–11. [challenges AGAINST the defect] | 12–13. [challenges FOR it]
Final Assessment: [confirmed/debunked with reasoning]
```

## Examples

Example reasoning flow that ends FALSE POSITIVE: report claims "buffer overflow when `parse_header()` copies a caller-supplied `content_length`". Data-flow trace shows the value first passes `if (content_length > 4096) return ERROR` in the caller and the copy uses the checked size; API contract for the copy routine guarantees no write past the destination; devil's advocate Q7 finds no verified mitigation was invented — instead the real bounds guarantee is located in code. Gates 2/5 fail with evidence → FALSE POSITIVE.

## Provenance

- Source repo: https://github.com/trailofbits/skills
- Original path: `plugins/fp-check/skills/fp-check`
- License: unknown — see repo (no LICENSE bundled in the skill directory)
- 蒸馏说明：原目录含 9 文件（SKILL.md + references 下 6 篇文档：standard-verification / deep-verification / gate-reviews / bug-class-verification / false-positive-patterns / evidence-templates，另有 agents/openai.yaml 与 assets 图标，无内容价值已省略）。全部参考文献已内联：standard 与 deep 两路径的任务/阶段/判定规则合并为单一 Workflow；deep 的 agent 委派表改写为文本分工说明（Phase 3/5/Gate 不委派）；evidence 模板压缩为骨架示例。未删除/新建任何文件。
- Distillation note (EN): original had 9 files (6 reference docs inlined here; openai.yaml/icon are presentation assets and were dropped as content-free). Standard and deep verification paths are both preserved; delegation of deep phases is described in prose. No files were deleted or created.
- 维度收敛（2026-09-11）：Bug-Class Verification 原 8 类中，Crypto weaknesses / Injection / Information disclosure / Deserialization 四类为纯安全判据，已删并将范围声明改为排除；Memory corruption 与 Logic bugs 剥掉可利用性框架（exploitation primitive、allocator hardening、attacker control、auth bypass/privesc 标定）保留行为判据；新增 Liveness/termination（终止性=正确性，可用性影响不在本技能范围）与 Unvalidated input reaching an operation（保留"输入→sink"的行为问法，剥离可利用性问法）。ASLR/stack canaries 从环境防护判据中移除——它们只影响可利用性，不改变行为偏差。
