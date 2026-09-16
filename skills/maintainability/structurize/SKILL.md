---
name: structurize
description: Finds hidden repetition in an area (Type-3/4 clones, co-change, shotgun scatter), researches its established name (pattern, algorithm, or package), offers named options, and extracts only what the user picks. Use for structurize or standardize asks.
---

# structurize: name the repetition hiding in an area

Scope: the area the user names (directory, feature, data flow), or with none named whatever the current prompt is about, plus one hop out along imports.

**Leave as is** is a real verdict: occurrences that change for *different* reasons were never one thing, and a module needing more knobs than the occurrences have lines is worse than the occurrences. (Deleting visible duplication in a diff is a different question; this asks what repetition should *become*.)

## 1 · Hunt: the real ones are hidden

Copy-paste is the rare, easy case. Repetition usually presents indirectly, as several *related* things rather than one repeated thing:

- **Type-3 / Type-4 clones**: same job, different syntax. Grep cannot see these; read for *intent*, not text.
- **Temporal coupling**: `git log --name-only` over the area. Files that keep changing in the same commit have an implicit dependency and no shared module holding it.
- **Shotgun surgery**: "to add one X you must edit five files." That file list *is* the candidate.
- **Constellations**: a type, its validator, its serializer, its default, each declared separately in every feature. Related, not identical.
- **One domain concept, many models**: the same concept re-modelled per layer or per caller.
- Then the visible ones: repeated control flow over different types, inline field groups, the same `switch` on a type tag, repeated timeout/retry/error boilerplate, `fooA`/`fooB`/`fooC`.

Record each candidate as its occurrences (`file:line`) **plus the variation axes**: exactly what differs between them. Few closed axes → parameterize. More axes than shared lines → there is no module here.

## 2 · Name it: research, don't recall

Research what this is actually called, anywhere. The area's own domain literature usually beats the OO canon: a CRDT reconcile, a React render path, a scheduler, a parser each have their own papers, RFCs, framework docs and maintainer write-ups. Below is a starting map, not a menu, and nothing has to land on it:

- **Fowler, *Refactoring***: the smell names for a missing module: Shotgun Surgery, Divergent Change, Primitive Obsession, Data Clumps.
- **GoF** and **Fowler, *PoEAA***: object collaboration; data access and mapping.
- **Hohpe, *Enterprise Integration Patterns***: anything moving messages through steps.
- **Nygard, *Release It!***: repeated timeout, retry, and failure-handling boilerplate.
- **Kleppmann, *DDIA***: state, sync, replication, derived views.
- **Evans, *DDD***: domain modelling and boundary translation.
- Also `refactoring.guru`, `patterns.dev`, `martinfowler.com/eaaCatalog`, language and framework idiom guides, and whatever the search turns up. Sometimes the answer is a **data structure**, not a pattern.

Never force a canonical label onto something that isn't it. *"No established name; here are the occurrences and their axes"* is a legitimate answer.

Spawn one subagent per candidate when there are several; read directly when there are one or two. Subagents don't inherit this conversation, so brief each with its candidate, occurrences, and axes. Each returns: internal prior art first (grep first; extending an existing seam beats a new module); any maintained **package** that already does it, offered *only with receipts*: last release date and an adoption signal, else don't mention it; and the known critique, if "X considered harmful" tops the results.

## 3 · Propose, gate, extract

Per candidate: `N occurrences · the named pattern · one line on what that pattern does · one line on why it fits these occurrences · its cost`. Always include *adopt package X* and *leave as is* as first-class options; where two patterns both fit, offer both with what each trades away. You supply the named options, the user picks.

Then `AskUserQuestion` **multi-select**, ordered by payoff. Extract only what's picked: **move, don't rewrite**: behavior preserved, one responsibility, named after the pattern, every callsite updated in the same pass, no back-compat shim unless asked. **Then run the repo's typecheck and lint**: a missed callsite surfaces there; fix before reporting. Report what moved, what you left alone, and why.

Out of scope: anything the repo marks frozen, vendored, or generated; duplication that makes tests readable; and repetition across module or service boundaries, since sharing there buys coupling, which is the user's call.
