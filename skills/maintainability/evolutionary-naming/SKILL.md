---
name: evolutionary-naming
description: 'Guides naming as an evolutionary process in two modes: audit (broad scan for opportunities)
  and improve (walk one identifier through 7 steps in 3 phases, pausing at boundaries).
  Use when refactoring poor names or naming classes, methods, variables.'
---

# evolutionary-naming

## When to Use

- Use when refactoring code with poor names, when asked to improve naming, or when a user struggles to name a class/method/variable.
- Trigger symptoms: `-Manager`/`-Util` suffixes, single-letter variables, `process`/`handle`/`do` verbs, primitive obsession, god methods with multiple responsibilities.
- Two modes: **audit** (broad scan, list opportunities) and **improve** (walk one specific identifier through the process).
- Tooling: operates with Read, Grep, Glob only (advisory; does not edit files or run git).
- Method attribution: based on Arlo Belshee's "Naming as a Process" (CC BY 3.0); updated edition at digdeeproots.com.

## Core Principles

**Naming is a process, not a single step.** Names evolve through 7 progressive steps grouped into 3 phases. Match the depth of work to the user's actual story — don't run the full pipeline every time.

**This skill is advisory.** It reads code and *proposes* renames, transitions, and the commit message you'd write for each — it does not edit files or run git. The user applies the changes. Phrase every transition as a proposal, and suggest the commit message they would use, rather than claiming the rename is done.

| Phase | Steps | Nature |
|---|---|---|
| **Phase 1: Insight → Name** | Missing → Nonsense → Honest → Honest and Complete | Universal. Pure naming, no structural change. Safe to walk continuously — **except** a rename of an exported/public symbol, route path, DB column, config key, or event name: those are contracts, so sweep the call sites and propose a deprecation path rather than a silent rename. |
| **Phase 2: Name → Structure** | Honest and Complete → Does the Right Thing | Codebase-specific. Requires structural refactoring. **Ask permission.** |
| **Phase 3: Combine for Design** | Does the Right Thing → Intent → Domain Abstraction | Requires reading call sites and domain context. **Ask permission.** |

> "You take the minimum steps to get the name to meet your need for the current story." — leaving names incomplete for colleagues to extend is a feature, not a flaw.

## Choose Your Mode

| User signal | Mode |
|---|---|
| Specific identifier named ("`d` を改善", "DocumentManager をどうにか", "this method") | **improve** |
| One clear target inside a code block + "リファクタリング" / "改善" | **improve** |
| "全体の命名を見直したい" / "改善余地ある?" / "命名レビュー" / "scan" / "audit" / "リストだけほしい" (whole-scope review, just want a list) | **audit** |
| Audit followup: "X だけ直して" (fix only X) after audit output | **improve** (target = X) |
| Ambiguous (large code paste, no specific target, no whole-scope language) | **Ask the user**: "全体を監査しますか、特定の識別子を改善しますか?" (audit everything, or improve one identifier?) |

## Mode: Audit — Exhaustive Naming Detection

Purpose: scan provided code and produce a **structured report** of all naming improvement opportunities, classifying every identifier by its current step. **Do not execute changes.** The output is an actionable list, not a refactor.

### Workflow
1. **Scope** — audit only what the user provides: pasted code, named files, named directories. Do NOT recursively scan the broader codebase unless explicitly invited (e.g. "リポジトリ全体を見て"). Path given → read those files; code pasted → audit that snippet; both → audit the union.
2. **List every identifier** in scope: classes, methods, fields, parameters, local variables, map/dict keys.
3. **Diagnose each** using the Diagnosing Current Step table below.
4. **Group findings by phase:**
   - Phase 1 candidates (current step = Missing/Misleading/Nonsense/Honest) → safe to fix without permission.
   - Phase 2 candidates (current step = Honest and Complete, needs structural change) → requires user permission.
   - Phase 3 candidates (current step = Does the Right Thing or Intent, needs domain context) → note only.
5. **Order within each phase** by lowest current step first (most leverage first).
6. **Output the table.** Then stop. Audit is classification only; refactoring is improve-mode.

### Anti-Patterns — Do NOT Do These
- "Here's the audit, and while I'm here, here's the refactored code" — audit is classification only; stop after the table.
- Skip identifiers that "look fine" — audit means exhaustive; even reasonable names get a row showing their current step.
- Suggest names instead of next-step labels — don't propose `orderRepository` for `OrderManager`; the "Suggested next step" column holds the transition (e.g. "→ applesauce, then Honest"), not a finished name.
- Audit the broader codebase silently — stay within the user-provided scope; if unsure, ask.
- Group by file or by kind instead of by phase — phase grouping reflects required permission level, which is what the user needs to plan work.

### Handoff to Improve Mode
When the user picks one identifier from the audit ("X だけ直して", "Improve OrderManager"): switch to improve-mode for that single target; do NOT re-audit — the diagnosis is already in your output; carry forward the current-step classification you assigned.

## Mode: Improve — Interactive Single-Target Improvement

Purpose: take ONE identifier and walk it through the naming process, one transition at a time, *proposing* each move. Pause at phase boundaries so the user can decide whether to invest in structural changes.

### Workflow
1. **Confirm the target.** Restate which identifier you're improving. If the user named multiple, ask which one to start with.
2. **Diagnose current step.** State the step + one-line evidence (Diagnosing Current Step table).
3. **Read the user's depth signal** to decide how far to propose walking (Depth Signals table below).
4. **Walk Phase 1 continuously.** Propose transitions through Honest and Complete WITHOUT pausing for each micro-step (Phase 1 is pure renaming: no structural change, behavior-preserving). Show each transition with the commit message the user would use.
5. **Pause before Phase 2.** State that the next step requires structural refactoring and ask: 次は構造的リファクタリング（メソッド/クラス分割）が必要です。`X`, `Y`, `Z` を切り出して進めますか?
6. **Pause before Phase 3.** State that you need to read call sites / consider domain language and ask: 次は呼び出し元を読んで意図を抽出します。コードベース全体の文脈が必要ですが、進めますか?
7. **Stop on user signal.** If the user says "ここまでで" / "OK" / "十分", stop and confirm the final state.

### Pause Protocol
- **Inside Phase 1: don't pause.** Per-step pauses (Missing → applesauce → Honest → Honest and Complete) feel like noise. Walk through them in one response, showing each commit point.
- **At Phase boundaries: always pause.** The user must explicitly authorize structural changes (Phase 2) and design-level changes (Phase 3). Do not infer permission from a generic "改善して" prompt.
- **Override:** if the user pre-authorized depth in their initial prompt ("リファクタリング", "全部やって", "Phase 2まで進めて"), you may cross the boundary they authorized without pausing; pause only at the next un-authorized boundary.

### Output Shape (each transition)
- The before/after of the name
- A one-line `commit:` message
- The new current step

Example:
```
1. 診断: `process(String s)` → 現在 Missing (generic verb + 1-letter param)
2. Missing → Nonsense:  process → applesauce
   commit: rename process to applesauce
3. Nonsense → Honest:   applesauce → probably_parseAndStoreFlight_AndStuff
   commit: rename applesauce to honest name
4. Honest → Honest and Complete:
   probably_parseAndStoreFlight_AndStuff → parseXmlAndStoreFlightToDatabase
   commit: complete the name with all responsibilities

到達: Honest and Complete (Phase 1 終了)
---
次は Phase 2 (Does the Right Thing) です。
このメソッドは parseXml / storeFlightToDatabase の2つの責務を持つことが名前から明らかです。
構造的リファクタリングで2つのメソッドに分割しますか?
```

### Anti-Patterns — Do NOT Do These
- Cross the Phase 2 boundary without asking — structural change touches behavior; always ask.
- Pause at every micro-step inside Phase 1 — Phase 1 is safe; excessive pausing kills flow.
- Audit other identifiers "while I'm here" — improve-mode is single-target; for broad scans use audit-mode.
- Skip applesauce for misleading names like `-Manager` — the applesauce step forces letting go of false comfort.
- Use applesauce for a one-letter variable like `d` — applesauce is for misleading names and extracted chunks; a nameless `d` can go directly to Honest.
- Run all 7 steps when the user said "急いでる" (in a hurry) — honor the depth signal; stop at Honest.
- Suggest a Value Object when only Phase 1 was authorized — note the opportunity, don't do the work.
- Compress the applesauce step into commentary (esp. on handoff from audit) — show the literal `→ applesauce` rename with its own commit message even when the diagnosis was already done in audit; per-step commit visibility is the point.

### When to Defer to Audit Mode
If the user starts asking about multiple identifiers ("`r` も `cnt` も `s` も") or general code quality ("このクラス全体を見直したい"), suggest switching to audit-mode for the broader survey. Improve-mode loses focus when the target multiplies.

## 7-Step Reference (shared diagnostics)

### Diagnosing Current Step
Two situations both diagnose as **Missing** but transition differently:
- A *misleading* name (`process`, `handle`, `data`, `-Manager`) promises meaning it doesn't deliver — worse than a blank; route it through **applesauce** first to strip the false comfort.
- A *single-letter placeholder* (`d`, `r`, `s`) makes no false promise — the name is simply absent. If its meaning is obvious from one line of context, it can go directly to Honest; applesauce is unnecessary.

| Signal | Current Step |
|---|---|
| Concept exists in code but has no name (embedded in a long method/class) | Missing |
| Name is misleading — promises meaning it doesn't deliver (`process`, `handle`, `data`, `manager`) | Missing (route via applesauce) |
| Single-letter placeholder (`s`, `d`, `r`), meaning absent but not misleading | Missing (direct to Honest if obvious; else via applesauce) |
| Name tells one true thing but not everything (`doSomethingToDatabase`) | Honest |
| Name lists everything but is very long (`parseXmlAndStoreAndCacheAndNotify`) | Honest and Complete |
| Each piece has single responsibility but names describe mechanics | Does the Right Thing |
| Names express purpose but don't form a shared vocabulary | Intent |
| Names form a shared domain vocabulary with Value Objects | Domain Abstraction |

### Depth Signals — How Far to Walk
How far to propose walking a name depends on the user's story:

| User signal | Stop at |
|---|---|
| "急いでる" (in a hurry) / "bug fix" / "とりあえず" (just get it done) | Honest (mid Phase 1) |
| "改善して" (improve it) / generic rename | Honest and Complete (end of Phase 1) |
| "リファクタリング" (refactoring) | Does the Right Thing (Phase 2) |
| "設計から見直したい" / "ドメイン的に整理" (rethink the design / organize by domain) | Intent or Domain Abstraction (Phase 3) |

### Step Transitions

**Missing/Misleading → Nonsense (applesauce).** *Look at:* long methods, long classes, long parameter lists, long expressions — find a chunk that belongs together. *Do:* (1) find a chunk: a block of statements, an unclear expression, parameters that travel together; (2) extract it (Extract Method, Introduce Variable, Introduce Parameter Object); (3) name it `applesauce` — obviously nonsense, so nobody mistakes it for a real name; (4) for misleading names (`PageLoad`, `DataManager`): propose renaming to `applesauce` directly — yes, even names that LOOK reasonable: `-Manager`, `-Handler`, `process()` promise meaning they don't deliver; (5) **suggest committing this on its own** with a one-line message; don't batch it with the next step.

Only one `applesauce` in scope at a time. If you need another, first promote the current one to Honest. Don't skip this step even when a name seems "partially honest" — `DocumentManager` feels like it says something, but it doesn't; it's as misleading as `process()`. *Exception:* a single nameless variable like `d` whose meaning is obvious from one line of context can go directly to Honest.

**Nonsense → Honest.** *Look at:* the body of the method/class — system components (`database`, `screen`, `network`), return-value sources, repeated variables. *Do:* (1) identify one true thing about what this code does; (2) rename to express that truth — be specific, not generic; (3) mark uncertainty: `probably_` prefix for things you're not sure about, `_AndStuff` suffix for unknown remaining behavior; (4) **suggest a commit** for this step.

```
// BAD: too generic                      // GOOD: specific, honest about uncertainty
applesauce() → handleFlightInfo()        applesauce() → probably_doSomethingEvilToTheDatabase_AndStuff()
```

**Honest → Honest and Complete.** *Look at:* the body — find everything the code does that isn't yet in the name. *Do iteratively:* **expand the known** (find one more action/effect not in the name → add it) and **narrow the unknown** (find one specific thing the `_AndStuff` part does NOT do → make the suffix more specific). *Goal:* remove `probably_` (add tests to confirm) and `_AndStuff` (track all data effects); the name should let you email someone just the name and they could reconstruct exactly what the code does.

```
probably_doSomethingEvilToTheDatabase_AndStuff()
→ parseXmlAndStoreFlightToDatabaseAndLocalCacheAndBeginBackgroundProcessing()
```

Long names are GOOD here — forget naming conventions about length; completeness is the goal. **Suggest a commit after each addition** — one insight per commit message.

**Honest and Complete → Does the Right Thing (Phase 2).** *Look at:* only the name — ignore the code body and call sites. *Do:* (1) find a part of the name unrelated to the rest, or a concern you want to encapsulate; (2) extract that responsibility via structural refactoring (Extract Method, Split Class, Introduce Parameter Object); (3) distribute the complete name across the new pieces; (4) each new piece keeps an Honest and Complete name; (5) **suggest a commit** for this step.

```
parseXmlAndStoreFlightToDatabaseAndLocalCacheAndBeginBackgroundProcessing()
→ parseXml() + storeFlightToDatabaseAndLocalCache() + beginBackgroundProcessing()
```

Name by "what it does", not "what it is" — this motivates splitting. Phase 1 transitions are pure renames and preserve behavior. Phase 2 and Phase 3 involve structural moves (extract, split, introduce object) that *can* change behavior: when proposing them, remind the user to run the tests after applying each step and to keep each step a separate commit so a failing one is easy to roll back.

**Does the Right Thing → Intent (Phase 3).** *Look at:* call sites and usage context — NOT the body. *Do:* (1) read every place this method/class/variable is used; (2) understand its role in the larger orchestration; (3) rename from "what it does" to "why it exists" — its purpose; (4) **suggest a commit**.

```
storeFlightToDatabaseAndLocalCache() → beginTrackingFlight()
```

*Danger — falling back to Nonsense:* naming by WHEN it's called (`onPageLoad`) or by initial conditions is Nonsense, not Intent.

**Intent → Domain Abstraction (Phase 3).** *Look at:* a set of methods/classes that share something in common; look for primitive-obsession patterns. *Signals of missing abstractions:* parameters that travel together across methods; fields always used together; similar name prefixes/suffixes (`flightId`, `flightCode`, `flightStatus`); names ending in `-er` (action not object), `-Manager`, `-Util`; `firstName: String, lastName: String, ssn: String` — primitives that are one concept. *Do:* (1) identify the missing Value Object / Whole Value; (2) extract it: Introduce Parameter Object → promote to class → move related methods in; (3) name the new concept in domain language; (4) **suggest a commit**.

### Universal Red Flags
| About to do | What's wrong |
|---|---|
| Rename `process()` to `importFlightData()` in one step | Jumped from Missing to Intent; go through Honest and Complete first. |
| Propose 5+ renames in one batch | Each rename is a separate insight; commit each one. |
| Name a class without reading its full body | You can't be Honest about what you haven't read. |
| Skip `probably_` / `_AndStuff` because it looks unprofessional | Misleading "professional" names cause bugs; honest uncertainty is better. |
| Rename to a shorter name at Honest and Complete | Long names are correct here; shortening comes at Intent level. |
| Variable named same as type (`GridSquare gridSquare`) | Name by what distinguishes this instance. |
| Using CS terms (`Transformer`, `Processor`, `Handler`) at Intent level | Use domain terms the business understands. |

### Why a Commit per Step
Each naming improvement makes the code strictly better. A commit locks in that gain, so if the next step fails the user rolls back to a better state than before. Propose one commit per step, never a batch — the naming process IS the commit history. Suggest the message; the user runs the commit.

## Output Format — Audit Report

```
## Naming Audit: <file or scope name>

### Phase 1 candidates (safe — pure naming, no structural change)
| Identifier | Kind | Current step | Evidence | Suggested next step |
|------------|------|--------------|----------|---------------------|
| `OrderManager` | class | Missing (misleading) | `-Manager` suffix; body parses, persists, notifies | → applesauce, then Honest |
| `process(s, x, f)` | method | Missing | generic verb, single-letter params | → applesauce |
| `r` | local var | Missing | one-letter | → record (Honest) |

### Phase 2 candidates (requires structural permission)
| Identifier | Current step | Why it's stuck | Suggested change |
|------------|--------------|----------------|------------------|
| `parseAndStoreAndNotify()` | Honest and Complete | name lists 3 concerns | extract 3 methods (Phase 2) |

### Phase 3 candidates (note only — requires domain context)
| Pattern | Observation |
|---------|-------------|
| `(id, code, ts, val)` travel together as Map keys | Possible Value Object; revisit after structural cleanup |

---
Found N Phase-1 issues, M Phase-2 candidates, K Phase-3 patterns.
**To execute:** ask "Improve `<identifier>`" to enter improve-mode for any row.
```

## Provenance

- Source repo: https://github.com/kawasima/evolutionary-naming
- Original path: skills/evolutionary-naming
- License: unknown — see repo (method content is Arlo Belshee's "Naming as a Process", CC BY 3.0)
- 蒸馏说明：原含 4 文件（SKILL.md 路由/总览 + reference.md 共享 7 步诊断/深度信号/转换规则/红旗 + audit-mode.md + improve-mode.md），已全部内联。前端字段 allowed-tools: Read/Grep/Glob 已并入 When to Use（advisory 说明）。日文用户信号与暂停提示语保留原样并附英文括注；需要逐句原文见原仓库各 md。
