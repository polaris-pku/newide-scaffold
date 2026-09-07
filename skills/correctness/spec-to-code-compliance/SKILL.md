---
name: spec-to-code-compliance
description: Checks code against the documentation that specifies it, reporting which requirements hold, are contradicted, or are absent, plus behavior no document mentions; use when comparing an implementation to a whitepaper, protocol spec, or design doc.
---

# Spec-to-Code Compliance

> 蒸馏自 trailofbits/skills（仓库内 `plugins/spec-to-code-compliance/skills/spec-to-code-compliance`）。原为多文件 skill（SKILL.md + resources 下 4 篇文档 + yaml/svg 资产），附属文档已全部内联为单文件。
> Distilled from trailofbits/skills (`plugins/spec-to-code-compliance/skills/spec-to-code-compliance`); originally multi-file with resource docs, now inlined as a single file.

## When to Use

Two artifacts disagree, and the job is to find where. You have both documentation describing intended behavior and the code that should implement it — a whitepaper against a protocol, a design note against a service, a README's stated guarantees against the functions behind them.

Most useful when the document is **authoritative** — something a client wrote, published, or is audited against — because then a divergence is a defect rather than stale prose.

Input: a specification document + the codebase that should implement it (optionally a scoped path, a spec file, and a requirement count/limit). Output: a per-requirement compliance analysis — for each requirement one verdict among six — plus the reverse direction: behavior the code has that no document mentions.

## When NOT to Use

- Code with no documentation of intended behavior — there is nothing to check against, and a requirement inferred from the code is checked against itself. Build the system model first (e.g., with the sibling `audit-context-building` skill).
- General bug hunting. This finds one class only: where code and document disagree. A bug both artifacts are silent about is out of scope; a bug the document endorses is a finding against the document.
- Writing or improving documentation — though the output is precisely the list of what needs fixing.

## Core Principles

1. **The document says what the system does; the code decides what it actually does. Every gap between them is either a bug or a documentation fix — and which one it is, is the finding.**
2. **The verdict is not the finding.** `absent` on a mandatory requirement is a finding; `absent` on a sentence describing a roadmap item is not. Deciding which is which is the skill; gather the evidence to decide with.
3. **Severity is consequence, not distance from the text.** A rounding step that bleeds a pool outranks a MUST satisfied by different means than the document describes; documentation drift with no behavioral consequence is a docs ticket.
4. **A refutation the finding's author did not perform is worth more than one they did.** The author favors their own findings. Every divergence must be checked by someone who did not produce it — one pass re-reading the code, one pass re-reading the document — and dropped if either knocks it down.
5. **Records that cannot be prose.** Name the lines you read and the searches you ran. An `absent` verdict is only as good as its search record — the patterns tried and their results are the only thing separating a real absence from a search that stopped early.
6. **Per-requirement, in its own context.** Judging one requirement means reading the enforcement, its callees, and its callers; doing thirty at once means the first few get a real check and the rest get a plausible one — and the transcript looks the same either way, because a verdict resting on a promising function name reads exactly like one resting on having read the function.

## Execution Model

The original skill dispatches work rather than doing it inline: find the documents → split each into individually checkable requirements → give each requirement its own checking pass over the code → run independent refutation agents on every divergence before it is reported (one reads the code again, one re-reads the document; drop what either knocks down) → produce an aggregate report plus one analysis record per requirement. Compact verdicts come back; the detailed records carry the evidence. (Original allowed tools: Workflow, Task, Read, Grep, Glob.)

Work in this shape even without a dispatcher: one focused context per requirement is what makes a real check distinguishable from a plausible one. Keep the refutation passes separate from the finding's author — self-checking is not enough.

## Workflow

The question for every requirement is always the same: **what does this requirement demand of an implementation, where would that be enforced, and is it enforced on every path — and if you cannot find it, have you looked everywhere it could hide?**

1. **Scope.** Identify the documents in play and split them into individually checkable requirements. Name the sections covered; when the spec is a large standard (RFC / FIPS / IEEE), say which sections were checked and which were not — do not imply the whole standard was covered.
2. **For each requirement, restate it concretely.** What property must hold, in terms checkable in code — naming quantities and where they come from. Quote the requirement verbatim and cite its section; a paraphrase silently substitutes your reading for the requirement.
3. **Find where enforcement would live.** Apply the domain map (below). Trace every path that can reach the enforcement point and every path that cannot. Enforcement that exists on the paths anyone would test and is missing on one reachable path is exactly the finding `partial` exists for.
4. **Judge each divergence.** Verify against the actual arithmetic/logic, not the document's vocabulary. Determine the direction of the gap (code wrong, or document misdescribes code — both are findings). Assign severity by consequence.
5. **Refute.** Have the divergence checked by agents that did not produce it: one re-reads the code, one re-reads the document. Drop the finding if either knocks it down. A divergence whose refutation agents both failed is `unverified`, not confirmed.
6. **Report.** Per-requirement analysis records (format below) plus the reverse direction: behavior the code has that no document mentions — which a document-driven pass cannot find by construction.

## Verdicts (six)

- **`implemented`** — the requirement holds on every path. Including the subtle case: code satisfies the requirement without resembling its wording (arithmetic verified as arithmetic).
- **`partial`** — holds on some paths, fails on one nobody tested. Usually the most serious thing in the report: it survived precisely because it holds on the paths anyone would test.
- **`contradicted`** — code behavior directly violates the requirement.
- **`stronger-than-spec`** — code enforces something no document mentions. It works today, and nothing tells the next person changing that code that anything depended on it.
- **`absent`** — no enforcement found anywhere. Rests entirely on its `searched` record: enforcement often lives where the search did not go — a modifier, a base class, a caller that checks first.
- **`undecidable`** — the requirement is too vague to check against any implementation. A finding about the documentation, not the code.

Adjacent-verdict discipline: `partial` is not `contradicted` when the requirement holds for the common case; `absent` is not `undecidable` when you searched everywhere it could hide; `implemented` is not `absent` just because the code never uses the document's words. Say why you chose this verdict and not the adjacent one.

## Severity Rubric (consequence, not wording distance)

- **Critical** — value or control moves in a way the document rules out, and someone outside the trust boundary can cause it: a missing bound that lets a caller withdraw more than they hold; an access check the document requires and the code omits on a path reachable by an untrusted actor; a formula divergence that accumulates against users every time it runs.
- **High** — the same class of consequence, but gated: needs a privileged role, an unusual state, or a precondition the attacker does not directly control. Also: enforcement exists on the paths anyone would test and is missing on one path that is reachable.
- **Medium** — a real gap whose consequence depends on something not established: a missing error case currently unreachable but nothing prevents it from becoming reachable; an ambiguity in the document that has let two components diverge in how they read it.
- **Low** — no behavioral consequence: the code is correct and the document describes it wrongly, or the code enforces more than the document asks. Say plainly that the fix belongs in the document.

**The two directions of a gap:** decide which side is wrong before assigning severity. If the code's behavior is the intended one, the finding is that the document misdescribes it — still a finding, because the document is what the client publishes and what the next reader will believe. `stronger-than-spec` is the direction people skip: Low now, a regression later.

**Raises severity:** untrusted actor can reach it; needs no unusual state; runs on every call rather than an edge case; the document names the requirement mandatory; other code depends on the requirement holding. **Lowers severity:** needs a role only the client holds; a second mechanism happens to enforce the same thing; the divergence is in a path that cannot currently be reached (state the reason it cannot). **Neither:** how emphatically the document states it — a MUST satisfied through a different mechanism is not a finding, and a quietly-worded sentence about accounting can describe the most serious gap in the system.

**Stating the consequence:** a divergence whose consequence is spelled out gets fixed; one stated as a mismatch gets discussed. Where you can show it, show who acts, in what order, and what they end up with. Where you cannot, say what would have to be true for it to matter — and leave it there. An invented attack sequence or made-up figure discredits the real finding underneath it.

**Requirements that cannot be checked** are findings in their own right, filed against the document: a requirement too vague to check against any implementation, or one document stating a requirement another contradicts. The code may be fine — what is broken is that nobody can say whether it is.

## Domain Map (what a spec is and where enforcement hides)

| Domain | what specifies behavior | what enforcement looks like | where it hides | what makes `absent` credible |
|---|---|---|---|---|
| Smart contracts | whitepaper, protocol spec, NatSpec | `require` / `revert`, modifier, type bound | base contracts, modifiers, libraries, the caller | no modifier, no base-contract check, no caller check, and the vocabulary swept |
| C / C++ | RFC, standard, header comments, design docs | `if`-return, `assert`, length parameter, allocation size | macros, `#ifdef` builds, the caller, a wrapper | checked in every build configuration, not just the one you read |
| Services | API spec, OpenAPI, design docs, README guarantees | middleware, decorator, validation schema, DB constraint | the framework's route registration, not the handler | every route on that path checked, plus the DB schema |
| Firmware / decompiled | datasheet, protocol spec, vendor docs | a compare-and-branch, often unnamed | anywhere; symbol names are absent or wrong | the coverage record says which handlers were read at all |

- **Smart contracts.** Enforcement usually delegates: `require(_check(x))` is only enforcement if `_check` compares `x` against the bound the document names, on the path taken — follow it. `unchecked` blocks and assembly suspend guarantees the surrounding code is written as though it still has (a document requiring a balance never go below a floor is contradicted by an `unchecked` subtraction; the call site looks identical). Who-may-act requirements map to modifiers, `msg.sender` comparisons, role registries — and to the constructor and upgrade path (an admin function that can move balances contradicts "operator cannot reduce a balance"). Ordering requirements map to where state writes sit relative to external calls: "must settle before notifying" is a line-order question. Arithmetic stated as a percentage is often implemented as a numerator: `amountIn * 997 / 1000` satisfies a 0.3% fee and matches nothing you can grep for — verify the arithmetic, record the equivalence for the next reader.
- **C and C++.** The out-parameter is the classic trap: the caller checks the return code and uses the out-parameter, and one path through the callee returns success without writing it. A "length is validated" requirement is `partial` if one early return skips the validation. Check every build configuration — a bound enforced inside `#ifdef DEBUG` is not enforced in the shipped binary; note the macros, since enforcement written as a macro will not match a search for a function call.
- **Services.** Authorization and input validation carry most requirements, and enforcement is usually NOT in the handler body: it is a middleware chain, a decorator, a route registration, or a validation schema declared elsewhere. A requirement looks `absent` from the handler while enforced framework-side, and looks satisfied because one route registers the middleware while three others do not. The unit of checking is the route table, not the function: enumerate every registered route on that path and say which get the check. Database constraints are enforcement too (uniqueness may live in a migration); consistency across two operations is about transactions.
- **Firmware / decompiled binaries.** Names are absent or wrong, so "don't infer behavior from a name" is not a caution but the default condition: enforcement is a compare-and-branch with no identifier, and the requirement must be recognized from the arithmetic. Most callees are black boxes — normal, not exceptional; a bound never established in the visible listing is `absent` with the searches recorded, and that is a complete answer. Keep a coverage record of which handlers/task entries were read at all; without it, `absent` is not credible.
- **When the specification is a standard (RFC/FIPS/IEEE).** Large → scope it (name the sections checked and unchecked). MUST/SHOULD/MAY is deliberate: a SHOULD the code omits is a documented deviation, not a defect — reporting it as a defect costs credibility on the MUSTs. Terms are defined precisely and usually in a different section from the requirement — read the definition before deciding what the requirement demands.

## Analysis Record Format (one per requirement)

```
## REQ-04 — <the requirement in a few words>

> "<the requirement quoted verbatim>"
> — SPEC.md §3.2

**Verdict:** partial · confidence: high

**What this demands of an implementation:** the property that has to hold, restated concretely enough to
look for; name the quantities and where they come from.

**Where enforcement lives:** cite the code (File.ext:L45 or L89-L135); what it checks and against what;
which paths reach it and which do not.

**Paths walked:** one line per path with ✓ / ✗ — e.g. `redeem` → `_collateralPreserved`: Senior tier
returns true at L82 without comparing. ✗ — the gap.

**Searched:** pattern → hits and where; include searches that found something irrelevant.

**How the verdict was reached:** why this verdict and not the adjacent one (for `partial`, why not
`contradicted`; for `absent`, why the searches are exhaustive rather than merely unsuccessful).

**Open questions:** what still needs looking at.
```

Conventions: cite code as `File.ext:L45` / `L89-L135`; quote the document verbatim and cite its section. The **Searched** section is what makes an `absent` verdict worth anything — record the pattern and its result, including the searches that found something irrelevant (`0 hits` and `6 hits, all in tests` are both evidence; "I looked and found nothing" is not). Search the document's vocabulary AND likely synonyms — the code's word is rarely the document's word. Spend words where the code earns them (branches, call chains, paths where enforcement goes missing); there is no minimum length and padding produces text that looks like analysis and isn't. Leave a section out only when it is genuinely empty, and say so ("No enforcement found anywhere.") — a missing section could mean "none" or "never checked". Before finishing: every claim either cites a line or sits in Open Questions; walk every path through each function called, not only the one that returns successfully; cut the hedges — "probably", "seems to", "should be" each become a claim with a line number or an open question. Finishing with open questions is a complete analysis; finishing with open questions you never wrote down is not.

## Reading the aggregate results

Treat `notChecked`, `unverified`, and `unreadableDocuments` sections seriously before calling the report complete: requirements below the fan-out cut were never checked, and a divergence whose refutation agents both failed is unverified rather than confirmed.

## Checklist

- [ ] Document is authoritative (client-written / published / audited against)? If it is stale prose, say so.
- [ ] Scope stated: documents in play, sections checked vs not checked, requirement count.
- [ ] Requirement quoted verbatim with its section cited; restated concretely with named quantities.
- [ ] Enforcement located and cited (`File.ext:L45`); traced into callees (modifiers, base contracts, middleware, wrappers, `#ifdef` builds, route tables, DB constraints, callers) — never concluded from a name.
- [ ] Every path walked: enforcement on all reachable paths, or each missing path named.
- [ ] Searched section recorded: vocabulary + synonyms + patterns with results, including misses.
- [ ] Verdict chosen among the six with the adjacent-verdict reasoning stated.
- [ ] Direction of gap determined (code wrong vs document misdescribes code) before severity.
- [ ] Severity by consequence; raising/lowering factors considered; consequence stated concretely or the unestablished precondition named.
- [ ] Arithmetic verified as arithmetic (fee numerators, unchecked blocks, integer width) — never by grep for the document's words.
- [ ] Refutation performed by non-authors (code re-read + document re-read); both-knock-down drops the finding; both-fail marks it `unverified`.
- [ ] Reverse direction checked: behavior the code has that no document mentions.
- [ ] Every claim cites a line or sits in Open Questions; no "probably/seems to/should be" hedges; empty sections explicitly marked empty.

## Examples

**`implemented` — arithmetic that satisfies a requirement it does not resemble.** Requirement: "The protocol charges a fixed 0.3% fee on the input amount for every swap." Code at Router.sol:L108-L111 computes `amountIn * 997` then `amountOut = (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee)`. Nothing contains `fee`, `0.3`, or `30`; searching the document's vocabulary stops at a comment. The verdict rests on the arithmetic: input scaled by 997 over a denominator scaled by 1000 ⇒ fee = 3/1000 = 0.3%. Deciding `implemented` over `partial` needs three facts: the fee is applied before output is computed (cannot be bypassed by the caller), it is a literal not a storage read (no admin path changes it), and there is no branch around it (every swap passes L108). Record the 997/1000 ↔ 0.3% equivalence so the next reader does not re-derive it. Mistake to avoid: calling this `undecidable`/`absent` because the fee is unnamed.

**`absent` — the searches are the finding.** Requirement: "All swap operations MUST enforce a maximum slippage of 1% between expected and actual output." The `swap` signature carries no `minAmountOut` — suggestive, not conclusive (the bound could be computed internally from an oracle). What makes `absent` credible is the record: `slippage` → 0 hits; `minAmount`/`minOut`/`limitPrice`/`maxDelta` → 0 hits (synonyms checked because the code's word is not the document's); `require`/`revert` in `swap` → 2 hits, both on `amountIn > 0` and `tokenIn != tokenOut`; modifiers → `nonReentrant` only; oracle/TWAP reads → none; the one callee read in full (computes output, enforces nothing); callers → none in scope (it is an entrypoint). Six places it could have been, none holding it — that is an absence. Without the list it is a guess in citation format. Mistake to avoid: concluding `absent` after searching only the document's own vocabulary.

**`partial` — enforcement on the path nobody tested.** Requirement: "The parser MUST reject any frame whose declared length exceeds the remaining buffer." `parse_frame(buf, len, out)` checks `if (len < HDR) return -1`, then `if (declared > len - HDR) return -1` at the non-continuation path — but a `FLAG_CONT` branch writes `out->len = declared` straight from attacker-controlled bytes with no comparison against `len`, returning success. Two paths, one enforcing and one not → `partial`, naming which path fails; `contradicted` would overstate (the requirement holds for the common case), `implemented` would miss the finding. Then check the callers: a caller validating before calling closes it; one trusting `out->len` after a zero return confirms it. Also check other build configurations (`#ifdef`-gated handling). Mistake to avoid: stopping at the first check that matches the requirement — it is usually the one on the path everyone tests.

## Provenance

- Source repo: https://github.com/trailofbits/skills
- Original path: `plugins/spec-to-code-compliance/skills/spec-to-code-compliance`
- License: unknown — see repo (no LICENSE bundled in the skill directory)
- 蒸馏说明：原目录含 7 文件（SKILL.md + resources 下 4 篇：ANALYSIS_FORMAT / DIVERGENCE_RUBRIC / DOMAIN_NOTES / WORKED_EXAMPLE，另有 agents/openai.yaml 与 assets 图标，纯展示资产已省略）。SKILL.md 中关于 Claude Code 斜杠命令与插件工作流（按需求 fan-out、产出聚合报告 + 每需求一条记录）的机制性描述已改写为通用执行模型文字；四篇 resources 按语义内联进 Verdicts / Severity Rubric / Domain Map / Analysis Record Format / Examples 各节。判定规则（六种 verdict、severity 升降因子、各领域 enforcement 藏身处、Searched 记录要求）尽力逐字保留。未删除/新建任何文件。
- Distillation note (EN): original had 7 files (4 resource docs inlined; openai.yaml/icon are content-free presentation assets). Claude Code slash-command/plugin routing details were rewritten as a generic execution model; judgment rules (six verdicts, severity rubric, domain-specific enforcement map, search-record discipline) are preserved at high fidelity. No files were deleted or created.
