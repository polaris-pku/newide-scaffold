---
name: fp-check
description: Systematically verifies a suspected security bug and issues a TRUE POSITIVE or FALSE POSITIVE verdict with documented evidence; use to check whether a specific finding is real or exploitable, not to hunt for new bugs.
---

# fp-check

> 边界标注（2026-09-07）：只验证"用户指出的具体疑似 bug"的真伪；主动找 bug 请用 correctness/bugsweep（议会形态为 bug-hunter-*）；与 bug-hunter-skeptic 同属对抗式证伪，勿重复跑。
> Boundary (2026-09-07): verifies one user-pointed finding only — do not hunt here (use bugsweep or the bug-hunter trio); same adversarial-verification slot as bug-hunter-skeptic, do not double-run.

> 蒸馏自 trailofbits/skills（仓库内 `plugins/fp-check/skills/fp-check`）。原为多文件 skill（SKILL.md + 6 篇 references 文档 + yaml/svg 资产），附属文档已全部内联为单文件。
> Distilled from trailofbits/skills (`plugins/fp-check/skills/fp-check`); originally multi-file with reference docs, now inlined as a single file.

## When to Use

Verify or validate a specific suspected bug and eliminate false positives. Trigger phrases:
- "Is this bug real?" / "is this a true positive?"
- "Is this a false positive?" / "verify this finding"
- "Check if this vulnerability is exploitable"
- Any request to verify or validate a specific suspected bug

Input: one concrete finding/claim (file + line/symptom). Output: per-bug verdicts — `BUG #N TRUE POSITIVE — [description]` or `BUG #N FALSE POSITIVE — [reason]` — each backed by documented evidence, plus a final summary with counts.

When NOT to Use:
- Finding or hunting for bugs ("find bugs", "security analysis", "audit code").
- General code review for style, performance, or maintainability.
- Feature development, refactoring, or non-security tasks.
- When the user explicitly asks for a quick scan without verification.

Operating note: every suspected bug gets full verification through the chosen path — no partial analysis, no "rapid analysis of remaining bugs". Original tool allowance: Read, Grep, Glob, LSP, Bash, Task, Write, Edit, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, TaskGet.

## Core Principles

1. **Verification, not pattern recognition.** "This pattern looks dangerous" is not analysis; complete the data-flow trace before any conclusion. Unsafe-looking code may have upstream validation.
2. **Each instance is verified independently.** Similar code being vulnerable elsewhere proves nothing — every context has different validation, callers, and protections.
3. **LLMs are biased toward seeing bugs and overrating severity.** Actively argue against the claim (devil's advocate) and prove it with evidence before any TRUE POSITIVE verdict.
4. **Never skip verification for efficiency, and never short-circuit a bug because it "looks" obvious.** If a verification phase fails, document the failure with evidence and continue all remaining phases — issue FALSE POSITIVE only after all phases complete.
5. **Six gates must ALL pass** before any bug is reported as a vulnerability.
6. **Rationalizations to reject (STOP if you catch yourself thinking any of these):**

| Rationalization | Why It's Wrong | Required Action |
|---|---|---|
| "Rapid analysis of remaining bugs" | Every bug gets full verification | Return to task list, verify next bug through all phases |
| "This pattern looks dangerous, so it's a vulnerability" | Pattern recognition is not analysis | Complete data flow tracing before any conclusion |
| "Skipping full verification for efficiency" | No partial analysis allowed | Execute all steps per the chosen verification path |
| "The code looks unsafe, reporting without tracing data flow" | Unsafe-looking code may have upstream validation | Trace the complete path from source to sink |
| "Similar code was vulnerable elsewhere" | Each context has different validation, callers, and protections | Verify this specific instance independently |
| "This is clearly critical" | LLMs are biased toward seeing bugs and overrating severity | Complete devil's advocate review; prove it with evidence |

## Workflow

### Step 0: Understand the Claim and Context

Restate the bug in your own words before any analysis. If you cannot state it clearly, ask the user for clarification — half of false positives collapse here because the claim does not make coherent sense when restated precisely. Document:
- **Exact vulnerability claim** (e.g., "heap buffer overflow in `parse_header()` when `content_length` exceeds 4096").
- **Alleged root cause** (e.g., "missing bounds check before `memcpy` at line 142").
- **Supposed trigger** (e.g., "attacker sends HTTP request with oversized Content-Length header").
- **Claimed impact** (e.g., "remote code execution via controlled heap corruption").
- **Threat model**: privilege level, sandboxing, what the attacker can already do before triggering (e.g., "unauthenticated remote attacker vs privileged local user"; "runs inside Chrome renderer sandbox" vs "runs as root with no sandbox").
- **Bug class** — classify it and apply the class-specific verification requirements (see "Bug-Class Verification" below) in addition to the generic phases.
- **Execution context** — when and how this code path is reached in normal execution.
- **Caller analysis** — which functions call this code and what input constraints they impose.
- **Architectural context** — is this part of a larger security system with multiple protection layers?
- **Historical context** — recent changes, known issues, previous security reviews of this area.

### Route: Standard vs Deep Verification

**Standard Verification** — use when ALL hold: clear, specific claim (not vague); single component (no cross-component interaction in the bug path); well-understood bug class (buffer overflow, SQL injection, XSS, integer overflow, …); no concurrency/async in the trigger; straightforward data flow source→sink. No task tracking — work the linear checklist sequentially, documenting findings inline.

**Deep Verification** — use when ANY hold: ambiguous claim interpretable multiple ways; cross-component bug path (data flows through 3+ modules/services); race conditions / TOCTOU / concurrency in the trigger; logic bugs without a clear spec to verify against; standard verification inconclusive or escalated; user explicitly requests full verification. Track each phase as a task with explicit dependencies.

**Default:** start with standard. Standard has two built-in escalation checkpoints that route to deep when complexity exceeds the linear checklist. When escalating, hand off all evidence gathered so far — deep continues from where standard left off, without repeating completed work.

### Standard Verification Path

**Step 1 — Data Flow.** Trace data from source to the alleged vulnerability sink. Map trust boundaries (internal/trusted vs external/untrusted); identify all validation and sanitization between source and sink; check API contracts (many APIs have built-in bounds protection that prevents the alleged issue); check environmental protections (compiler, runtime, OS, framework) that prevent exploitation *entirely* (not just raise the bar); apply class-specific checks. **Key pitfall:** analyzing the vulnerable code in isolation — conditional logic upstream may make the vulnerability mathematically unreachable; trace the full validation chain. **Escalation check:** 3+ trust boundaries, callbacks/async control flow, or an ambiguous validation chain in the path → escalate to deep.

**Step 2 — Exploitability.** Prove the attacker can trigger it. **Attacker control:** prove the attacker controls the data reaching the vulnerable operation — internal storage set by trusted components is not attacker-controlled. **Bounds proof:** for integer/bounds issues create an explicit algebraic proof: verify `IF validation_check_passes THEN bounds_guarantee_holds`. **Race feasibility:** for race conditions prove concurrent access is actually possible — single-threaded initialization and synchronized contexts cannot have races.

**Step 3 — Impact.** Determine whether exploitation has real security consequences. Distinguish real security impact (RCE, privesc, info disclosure) from operational robustness issues (crash recovery, cleanup failure). Distinguish primary security controls from defense-in-depth: failure of a defense-in-depth measure is not a vulnerability if primary protections remain intact.

**Step 4 — PoC Sketch.** Create a pseudocode PoC showing the attack path (executable and unit-test PoCs optional in standard):

```
Data Flow: [Source] → [Validation?] → [Transform?] → [Vulnerable Op] → [Impact]
Attacker controls: [what input, how]
Trigger: [pseudocode showing the exploit path]
```

**Step 5 — Devil's Advocate Spot-Check.** Answer these 7 questions; if any produces genuine uncertainty you cannot resolve with the evidence at hand, escalate to deep verification.
Against the vulnerability: (1) Am I seeing a vulnerability because the pattern "looks dangerous" rather than because it actually is? (2) Am I incorrectly assuming attacker control over trusted data? (3) Have I rigorously proven the mathematical condition for vulnerability can occur? (4) Am I confusing defense-in-depth failure with a primary security vulnerability? (5) Am I hallucinating this vulnerability — is this actually real or am I pattern-matching on scary-looking code? For the vulnerability (false-negative protection): (6) Am I dismissing a real vulnerability because the exploit seems complex or unlikely? (7) Am I inventing mitigations or validation logic I haven't verified in the actual source code? Re-read the code after reaching a conclusion.

**Step 6 — Gate Review.** Apply all six gates and all 13 false-positive-pattern items to reach the verdict (below).

### Deep Verification Path

Create one task per phase for each bug (Bug #N), wiring dependencies so each phase stays blocked until everything it depends on is complete:

```
Phase 1: Data Flow Analysis
  Task 1.1: Map trust boundaries and trace data flow
  Then in parallel (blocked by 1.1): 1.2 Research API contracts and safety guarantees;
  1.3 Environment protection analysis; 1.4 Cross-reference analysis
Phase 2: Exploitability Verification (blocked by Phase 1)
  In parallel: 2.1 Confirm attacker controls input data; 2.2 Mathematical bounds
  verification; 2.3 Race condition feasibility proof
  Then (blocked by 2.1–2.3): 2.4 Adversarial analysis (full attack surface: input control,
  validation bypass paths, timing dependencies, state manipulation)
Phase 3: Impact Assessment (blocked by Phase 2)
  In parallel: 3.1 Demonstrate real security impact; 3.2 Primary control vs defense-in-depth
Phase 4: PoC Creation (blocked by Phase 3)
  4.1 Create pseudocode PoC with data flow diagram (ALWAYS)
  Then in parallel (blocked by 4.1): 4.2 Executable PoC (if feasible);
  4.3 Unit test PoC (if feasible); 4.4 Negative PoC — show exploit preconditions
  Then (blocked by 4.2–4.4): 4.5 Verify PoC demonstrates the vulnerability
Phase 5: Devil's Advocate (blocked by Phase 4) — 5.1 devil's advocate review
Gate Review (blocked by Phase 5) — evaluate all six gates before verdict
```

**Execution rules:** mark each task in-progress when starting, completed only with concrete evidence; launch independent sub-phases in parallel and collect all results before the next dependency gate; never start a phase until all tasks it depends on are complete; apply the full 13-item false-positive checklist to each bug.

**Agents (if delegating):** delegate Phase 1 tasks to a data-flow analyzer, Phase 2 to an exploitability verifier, Phase 4 to a PoC builder, passing the bug description and prior phase results as context. Phases 3, 5 and the Gate Review require cross-phase synthesis — handle them yourself; do not delegate.

**Phase pitfalls / decision criteria:**
- **1.1:** do not analyze code in isolation — trace the full validation chain; upstream conditional logic may make the vulnerable code mathematically unreachable.
- **1.2:** check API contracts before claiming overflows — built-in bounds protection may prevent the issue regardless of inputs.
- **1.3:** distinguish "prevents exploitation entirely" (e.g., Rust safe type system) from "makes exploitation harder" (e.g., ASLR, stack canaries) — mitigations that only raise the bar do not eliminate the vulnerability itself.
- **1.4:** check whether similar patterns exist elsewhere and are handled safely; review test coverage, code-review history, and design docs.
- **2.2:** explicit algebraic proof, template below: verify `IF validation_check_passes THEN bounds_guarantee_holds`.
- **2.3:** proving concurrent access is possible; no races in single-threaded/synchronized contexts.
- **4.4 Negative PoC:** demonstrate the gap between normal operation and the exploit path — what preconditions must hold for the vulnerability to trigger and why they do not hold under normal conditions.
- **Phase 5:** before verdict, systematically challenge the claim assuming you are biased toward finding bugs and rating them critical. Answer all 13 questions below, then re-read the code.

**Devil's Advocate — full 13-question review** (document answers for each; 1–11 argue AGAINST the vulnerability, 12–13 argue FOR it as false-negative protection):
1. What non-vulnerability explanations exist for this code pattern?
2. How would the original developers justify this implementation?
3. What crucial system architecture context might be missing?
4. Am I seeing a vulnerability because the pattern "looks dangerous" rather than because it actually is?
5. Even if validation looks insufficient, does it actually prevent the claimed condition?
6. Am I incorrectly assuming attacker control over trusted data?
7. Have I rigorously proven the mathematical condition for vulnerability can occur?
8. Beyond theoretical possibility, is this practically exploitable?
9. Am I confusing defense-in-depth failure with a primary security vulnerability?
10. What compiler/runtime/OS protections might prevent exploitation?
11. Am I hallucinating this vulnerability? LLMs are biased toward seeing bugs everywhere and rating every finding critical — is this a real, exploitable issue or pattern-matching on scary-looking code?
12. Am I dismissing a real vulnerability because the exploit seems complex or unlikely?
13. Am I inventing mitigations or validation logic that I haven't verified in the actual source code? Re-read the code after reaching a conclusion.

### Batch Triage (multiple bugs)

1. Run Step 0 for all bugs first — restating each claim often collapses obvious false positives immediately.
2. Route each bug independently (some standard, some deep).
3. Process all standard-routed bugs first, then deep-routed bugs.
4. After all bugs are verified, check for **exploit chains** — findings that individually failed gate review may combine into a viable attack.

## Checklist

**False-Positive Pattern Checklist — apply ALL 13 items to EVERY potential bug:**
- [ ] 1. Trace full validation chain backwards from the dangerous operation — don't analyze isolated snippets.
- [ ] 1a. Map complete conditional logic flow: what conditions must hold for execution to reach the alleged vulnerability? Do those conditions mathematically prevent the vulnerable scenario (e.g., code reachable only when `length > 12` makes `buffer[length-4]` safe)? Are there minimum size/length requirements guaranteeing safe access?
- [ ] 2. Identify defensive programming patterns — `ASSERT(size == expected_size)` followed by size-controlled operations is defensive, not vulnerable; verify checks actually prevent the alleged vulnerability.
- [ ] 3. Confirm exploitable data paths — report only vulnerabilities with a confirmed exploitable data flow, traced step by step.
- [ ] 4. Understand data source context — API return values, compile-time constants and network data have different trust profiles; determine the actual source.
- [ ] 5. Analyze bounds validation logic — find the mathematical relationship between validation checks and later operations (`packet_size >= MIN_SIZE` and `MIN_SIZE >= sizeof(header)` ⇒ `packet_size - sizeof(header)` cannot underflow).
- [ ] 6. Verify TOCTOU claims — prove the checked value can change between check and use; if a size is checked and immediately used with no external modification possible, there is no TOCTOU.
- [ ] 7. Understand API contract and trust boundaries before claiming overflows — built-in bounds protection may make overflows impossible regardless of input.
- [ ] 8. Distinguish internal storage from external input — config stores/registries are controlled by trusted components; install-time values are not attacker-controlled.
- [ ] 9. Don't confuse pattern recognition with vulnerability analysis — size parameters being modified ≠ buffer overflow when the API prevents writing beyond bounds.
- [ ] 10. Verify concurrent access is actually possible — no races in single-threaded initialization or synchronized contexts; verify the threading model and synchronization.
- [ ] 11. Assess real vs theoretical security impact — would it lead to code execution, privilege escalation, or information disclosure? Storage failure for non-critical data is operational, not security.
- [ ] 12. Understand defense-in-depth vs primary controls — defense-in-depth failure is not always a vulnerability if primary protections exist (token cleanup failure is not critical if tokens are single-use by design at the server).
- [ ] 13. Apply the checklist rigorously, not superficially — for EVERY potential vulnerability work through ALL items before concluding.

**Six Gate Review — before reporting ANY bug as a vulnerability, ALL must pass:**
- [ ] Gate 1 Process: all phases completed with documented evidence (not just assertions).
- [ ] Gate 2 Reachability: attacker can reach and control the data at the vulnerability — attacker-controlled path + PoC confirms.
- [ ] Gate 3 Real Impact: exploitation leads to RCE, privesc, or info disclosure with concrete scenarios (not merely an operational robustness issue).
- [ ] Gate 4 PoC Validation: PoC (pseudocode, executable, or unit test) demonstrates the attack path — attacker control, trigger, impact.
- [ ] Gate 5 Math Bounds: algebraic proof shows the vulnerable condition is possible (math proves validation does NOT prevent it).
- [ ] Gate 6 Environment: no environmental protection entirely prevents exploitation.

**Red flags for false positives** (recurring failure patterns): reporting vulnerabilities in validation/bounds-checking code itself; claiming TOCTOU without proving the value can change; ignoring preceding validation; assuming network data reaches operations without tracing the path; confusing defensive assertions with vulnerabilities; flagging size calculations without understanding the mathematical constraints; claiming overflows in fixed-size/compile-time-bounded operations; reporting races in single-threaded or synchronized contexts; analyzing snippets without broader system design; ignoring architectural guarantees (single-writer, trusted sources); confusing debug/test-only paths with production; missing that framework/language guarantees prevent the issue; claiming memory corruption when allocation sizes are verified sufficient; claiming API-related memory corruption for APIs that manage memory safely.

## Bug-Class Verification

Apply class-specific requirements in addition to the generic phases:

- **Memory corruption** (overflow, UAF, double-free, type confusion). *Language safety check first:* memory corruption in safe Rust, Go (without `unsafe.Pointer`/cgo), or managed languages (Java, C#, Python) is almost always a false positive. Check for `unsafe` blocks (Rust), cgo/`unsafe.Pointer` (Go), JNI/P/Invoke (managed) — if entirely in the safe subset, reject the claim unless it involves a compiler bug/soundness hole. Verify: what exactly gets corrupted (object/field/region); corruption size/offset and attacker control; is it a useful exploitation primitive (arbitrary read/write, vtable/function-pointer overwrite) or just a crash; allocator (glibc, tcmalloc, jemalloc, Windows heap) and its hardening; UAF → trace object lifetime (what frees, what reuses, can attacker control the replacement); type confusion → prove the mismatch and that misinterpretation yields a useful primitive.
- **Logic bugs** (auth bypass, access control, state transitions, confused deputy, privesc via API misuse). Check against spec/RFC/design docs, not just code; map all state transitions and unreachable-by-design states; identify implicit assumptions never enforced in code; for auth bugs verify ALL auth/authz paths (secondary checks may catch it). Note: logic bugs pass every bounds check and mathematical proof — clean static analysis must not convince you it's a false positive.
- **Race conditions** (TOCTOU, data races, signal-handling races). What is the actual race window (nanoseconds or seconds)? Can the attacker widen it (stall a thread via slow NFS mount, large allocation, CPU contention)? Verify the threading model and all synchronization primitives (mutexes, atomics, RCU, lock-free). Filesystem TOCTOU: can the attacker control the path between check and use (symlink races)?
- **Integer issues** (overflow, underflow, truncation, signedness, wraparound). Exact integer types and ranges at every point; signed overflow (undefined behavior in C/C++, compiler may exploit it) vs unsigned (defined wraparound); trace all casts/conversions/promotions — where does truncation or sign extension occur; is the resulting value used dangerously (allocation size, array index, loop bound); check `-Wconversion`/`-Wsign-compare` compiler warnings.
- **Crypto weaknesses** (weak algorithms, bad parameters, nonce reuse, padding oracle, weak randomness, timing channels). Check parameters against current standards (NIST/IETF) and known attacks — "AES-128" fine, "DES" not; is the PRNG cryptographically secure and properly seeded; for nonce reuse prove the same nonce can actually repeat in practice; for timing channels is the code reachable by a measurer (network jitter may make remote timing impractical); compare against a reference implementation/test vectors.
- **Injection** (SQL, XSS, command, SSTI, path traversal, LDAP). Trace attacker input from entry point to sink — any sanitization/escaping in between; does the framework auto-escape (parameterized queries, template auto-escaping) and is it enabled and unbypassed; XSS context matters (HTML body, attribute, JS, URL — each needs different escaping); path traversal — is the path canonicalized before the access check, can `../` or null bytes bypass; test payload delivery through all intermediate encoding/decoding/transformation steps.
- **Information disclosure** (uninitialized memory reads, error leaks, timing channels, padding oracles). What specific data leaks — a stack leak revealing ASLR base/canary is critical, a static string is worthless; is the leaked data useful (ASLR bypass, session tokens, crypto keys); uninitialized memory — prove it is actually uninitialized at the point of read; timing — can the attacker make enough precise measurements; error messages — does the error path actually reach the attacker or is it server-side logged only?
- **Denial of Service** (algorithmic complexity, resource exhaustion, crashes, infinite loops, memory bombs). What is the resource consumption ratio (X bytes in → Y resources out) — meaningful amplification? Can resources be reclaimed or is exhaustion permanent? Algorithmic complexity — prove the actual worst-case input triggers worst-case behavior, don't just claim O(n²); crash bugs — reliably triggerable or dependent on heap/stack layout; does the service restart automatically?
- **Deserialization** (object injection, gadget chains). Does the attacker actually control the serialized data reaching the call; does a usable gadget chain exist in the classpath/import graph — without one, unsafe deserialization is a design smell, not an exploitable bug; library and version known gadget chains; type restrictions/allowlists/look-ahead filters; language specifics: Java `ObjectInputStream`, Python `pickle`, PHP `unserialize`, .NET `BinaryFormatter`.

## Output Format

Verdict per bug (use the literal verdict lines):
- **TRUE POSITIVE**: all six gate reviews pass → `BUG #N TRUE POSITIVE — [brief vulnerability description]`
- **FALSE POSITIVE**: any gate review fails → `BUG #N FALSE POSITIVE — [brief reason for rejection]`

If any phase fails verification, document the failure with evidence and continue all remaining phases; issue the FALSE POSITIVE verdict only after all phases are complete.

**Final summary** (after processing ALL suspected bugs): (1) Counts — X TRUE POSITIVES, Y FALSE POSITIVES. (2) TRUE POSITIVE list — each with a brief vulnerability description. (3) FALSE POSITIVE list — each with a brief reason for rejection.

**Evidence templates (document per bug):**

```
Bug #N Data Flow Analysis
Source: [exact location] — Trust Level: [trusted/untrusted]
Path: Source → Validation1[file:line] → Transform[file:line] → Vulnerability[file:line]
Validation Points:
  - Check1: [condition] at [file:line] — [passes/fails/bypassed]
  - Check2: [condition] at [file:line] — [passes/fails/bypassed]
```

```
Bug #N Mathematical Analysis
Claim: Operation X is vulnerable to [overflow/underflow/bounds violation]
Given Constraints: [list all validation conditions]
Algebraic Proof:
1. [first constraint from validation] ... N. Therefore: [confirmed/debunked] (Q.E.D.)
Conclusion: [vulnerability is/is not mathematically possible]
```
Example: Given `input_size >= MIN_SIZE` (validation), `MIN_SIZE = 16`, `header_size = 8`; then `input_size >= 16`, `input_size - 8 >= 8`, so `input_size - header_size >= 8` — underflow impossible.

```
Bug #N Attacker Control Analysis
Input Vector: [how attacker provides input] | Control Level: [full/partial/none]
Constraints: [limits on attacker input] | Reachability: [can attacker-controlled data reach the vulnerable operation?]
```

```
PoC for Bug #N: [description]
Data Flow Diagram: [External Input] → [Validation] → [Processing] → [Vulnerable Operation],
annotated per stage with attacker control / possible bypass / transform / unsafe op.
PSEUDOCODE: function + weak_validation (why it fails) + transform + unsafe_operation (trigger)
```

```
Bug #N Devil's Advocate Review
Vulnerability Claim: [description]
1–11. [challenges AGAINST the vulnerability] | 12–13. [challenges FOR it]
Final Assessment: [confirmed/debunked with reasoning]
```

## Examples

Example verdict (gate failure drives a FALSE POSITIVE):

```
BUG #3 FALSE POSITIVE — Integer underflow in packet_handler.c:142
  Gate 5 (Math Bounds) FAIL: validation at line 98 ensures packet_size >= 16,
  making (packet_size - header_size) >= 8. Underflow is mathematically impossible.
```

Example reasoning flow that ends FALSE POSITIVE: report claims "buffer overflow when `parse_header()` copies an attacker-controlled `content_length`". Data-flow trace shows the value first passes `if (content_length > 4096) return ERROR` in the caller and the copy uses the checked size; API contract for the copy routine guarantees no write past the destination; devil's advocate Q7 finds no verified mitigation was invented — instead the real bounds guarantee is located in code. Gates 2/5 fail with evidence → FALSE POSITIVE.

## Provenance

- Source repo: https://github.com/trailofbits/skills
- Original path: `plugins/fp-check/skills/fp-check`
- License: unknown — see repo (no LICENSE bundled in the skill directory)
- 蒸馏说明：原目录含 9 文件（SKILL.md + references 下 6 篇文档：standard-verification / deep-verification / gate-reviews / bug-class-verification / false-positive-patterns / evidence-templates，另有 agents/openai.yaml 与 assets 图标，无内容价值已省略）。全部参考文献已内联：standard 与 deep 两路径的任务/阶段/判定规则合并为单一 Workflow；deep 的 agent 委派表改写为文本分工说明（Phase 3/5/Gate 不委派）；evidence 模板压缩为骨架示例。未删除/新建任何文件。
- Distillation note (EN): original had 9 files (6 reference docs inlined here; openai.yaml/icon are presentation assets and were dropped as content-free). Standard and deep verification paths are both preserved; delegation of deep phases is described in prose. No files were deleted or created.
