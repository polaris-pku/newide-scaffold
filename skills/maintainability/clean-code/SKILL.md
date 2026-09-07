---
name: clean-code
description: 'Applies Clean Code principles to code written or modified: descriptive names, small
  single-purpose functions, early returns over nesting, meaningful abstraction, domain-centric
  modules, comments only for the why. Use by default for all code output.'
---

# clean-code

> 蒸馏自 Teqqles/cleanerCodeAISkills（skills/clean-code）。原为 6 文件（SKILL.md + 5 份语言示例参考），已内联合并为单文件。
> Distilled from Teqqles/cleanerCodeAISkills (skills/clean-code); originally 6 files (SKILL.md + 5 per-language example references), now inlined as text.
> 整合说明（2026-09-07）：本技能已收编 maintainability/anti-patterns（同源 cleanerCodeAISkills），其 10 类反模式目录并入文末 Smell Catalog；anti-patterns 目录保留为指针。
> Integration 2026-09-07: anti-patterns smell catalog folded in; its directory is now a pointer.

## When to Use

- Apply these principles **by default to all code output**: writing, reviewing, or modifying any code — regardless of language or framework.
- Trigger: the user asks you to write a function, class, module, or any implementation.
- Trigger: the user mentions clarity, readability, simplicity, naming, nesting, or says "write this cleanly", "keep it simple", "make this easier to understand".

## Core Principles

### Clarity Over Cleverness
Code is read far more often than it is written. Write for the reader.
- Choose the obvious solution when it differs in readability from the clever one.
- Avoid language tricks, operator abuse, or one-liners that obscure intent.
- If you need a comment to explain a construct, rewrite the construct.

### Descriptive Names
Names are the primary documentation. A good name makes the code explain itself.
- Variables, functions, classes, and modules must reveal intent at the call site.
- Avoid single-letter names except in well-understood contexts (loop counters, math).
- Avoid abbreviations that are not universally understood in the domain.
- Function names describe what they do: `calculateTax()` not `calc()`.
- Boolean names read as assertions: `isEnabled`, `hasPermission`, `canRetry`.
- **Language idiom (all five languages):** full words over initials — `currentDate`/`adultUsers` over `d`/`arr`; in filters, name the lambda variable (`user => user.age > 18`, `user for user in users`, `_.age > 18` in Scala) instead of `u => u.a > 18`.

### Small, Single-Purpose Functions
A function does one thing at one level of abstraction.
- If a function needs a comment to explain what it does, split it.
- Keep functions short enough to understand without scrolling.
- Side effects are explicit: a function that reads a value does not also write one unless that is its stated purpose.
- **Language idiom (all languages):** a function that "validates, saves, and emails" in one body is three functions. Split into e.g. `validateUser` → `db.save` → `email.sendWelcome`, called in sequence by `registerUser`; each step throws (Java/TS/JS/Python) or returns an error channel (Scala expresses validation failure as `Either[String, User]` rather than throwing).

### Avoid Deep Nesting: Use Early Returns
Each nesting level adds cognitive load. Flatten wherever possible.
- Guard clauses first: validate preconditions and return (or throw) early.
- Avoid if/else chains in favour of early returns.
- Target: no more than 2–3 levels of nesting in any function.

```javascript
// Nested                                          // Flat
function process(order) {                          function process(order) {
  if (order != null) {                               if (order == null) return
    if (order.isValid()) {                           if (!order.isValid()) return
      if (order.hasItems()) {                        if (!order.hasItems()) return
        return ship(order)                           return ship(order)
      }                                            }
    }                                              }
  }
}
```

- **Python/Java/TS/JS idiom:** invert each guard and return the neutral value early (`if (!user) return 0; if (!user.isPremium) return 0; return ...`), keeping the positive tail as a one-line ternary where it reads flat.
- **Scala idiom:** prefer `Option` over null checks and pattern matching over nested if/else — `maybeUser match { case None => ...; case Some(user) if !user.isPremium => ...; case Some(user) if user.yearsActive > 2 => ...; case _ => ... }`. Errors are `Either` values, not nulls.

### Remove Duplication Through Meaningful Abstraction
When logic appears in two places, extract it: but only when the boundary is clear.
- Wait until you see the pattern a second time before abstracting.
- The extracted name adds meaning; it does not just wrap the implementation.
- A bad abstraction is worse than duplication: name it after *why* it exists, not *what* it does.

### Domain-Centric Module Structure
Organise modules around business concepts, not technical layers.
- Avoid `/utils`, `/helpers`, `/common`.
- Use `/order`, `/payment`, `/user`: things that change together, grouped together. The folder structure communicates the domain, not the framework.
- **Language idiom (all languages):** put each domain concept in its own folder with its tests beside it — `src/order/{order.py, place_order.py, test_order.py}`, `src/user/{User.ts, registerUser.ts, user.test.ts}`, Java/Scala `order/{Order.java, PlaceOrderUseCase.java, OrderTest.java}`. Name use cases after the action (`PlaceOrderUseCase`, `RegisterUserUseCase`).

### Comments Only When Code Cannot Express Intent
- Self-documenting code is the goal.
- Write a comment only when the **why** cannot be expressed through naming or structure.
- Never describe what the code does: that is the code's job.
- Legal headers and public API documentation are acceptable exceptions.

### Scala-Specific Caution: Don't Hide Complexity in Matching
- Matching can become unwieldy as combinations grow; branching should be clear. Flattening an `Update`-style record into one giant tuple `match` on every field combination obscures business requirements, demands memory work from the reader, grows combinatorially in the default clause, and hides bugs in incoherence.
- Prefer the skimmable form: match on the discriminating field first (`update.updateType match { case StatusUpdate => ...; case ContactDetailsUpdate => ... }`), then inspect the fields each branch actually needs.

## Checklist

Before committing any block, verify:
- [ ] **Readable:** another developer understands it without explanation.
- [ ] **Testable:** it can be verified in isolation without complex setup.
- [ ] **Changeable:** modifying one part does not force changes in unrelated parts.

Per block also verify:
- [ ] Chose the obvious, readable solution over the clever one; no one-liners that obscure intent.
- [ ] Names reveal intent at the call site; booleans read as assertions; no cryptic abbreviations or single letters outside loop counters/math.
- [ ] Each function does one thing at one level of abstraction; no multi-job functions (validate+save+email → split).
- [ ] Nesting ≤ 2–3 levels; preconditions are guard clauses returning early (Scala: `Option` + `match`, `Either` for errors).
- [ ] Logic appearing twice is extracted only behind a meaningful boundary and a name that says *why*.
- [ ] Modules grouped by domain concept with tests colocated; no `/utils`-style dumping grounds.
- [ ] Comments only state *why*; nothing narrates *what* the code does (legal headers / public API docs excepted).
- [ ] No match/switch construct that hides cyclomatic complexity or business rules behind tuple gymnastics.

## Smell Catalog — Anti-Patterns and Fixes (folded in from cleanerCodeAISkills/anti-patterns)

### God Class / Blob
A class that knows too much and does too much. It attracts responsibility because it already has context.
- Symptoms: dozens of methods across unrelated concerns; most changes to the system require editing this class.
- Fix: extract cohesive groups of methods into their own classes. A class with more than one reason to change violates the single responsibility principle.

### Feature Envy
A method that uses more data from another class than from its own.
- Symptoms: chains of getters reaching into another object's internals; the method would make more sense living on the other class.
- Fix: move the method to the class whose data it actually uses. Often signals misplaced responsibility.

### Shotgun Surgery
A single logical change requires editing many classes in many places.
- Symptom: adding a field means touching 5+ files; related logic is scattered rather than grouped.
- Fix: consolidate the scattered logic into a single module or class. The opposite of God Class, but equally painful.

### Primitive Obsession
Using primitive types (strings, ints, booleans) where a domain type would communicate intent.
- Symptoms: `string email`, `string phoneNumber`, `int status` with no validation boundary; the same validation logic repeated everywhere the primitive is used.
- Fix: wrap in a value type that validates at construction: `EmailAddress`, `OrderStatus`. Domain types make invalid states unrepresentable.

### Long Parameter Lists
A function that takes many arguments signals it is doing too much or its dependencies are poorly structured.
- Symptoms: 5+ parameters, especially of the same type; callers constantly pass `null` or default values for parameters they do not use.
- Fix: group related parameters into a value object; split the function into smaller ones that each need fewer arguments.

### Flag Arguments
A boolean parameter that selects between two behaviours inside one function.
- Symptoms: `process(order, true)` where `true` means "rush"; the function body is an if/else split on the flag.
- Fix: two separate functions with descriptive names: `processStandard()`, `processRush()`. A flag argument hides two functions pretending to be one.

### Inappropriate Intimacy
Two classes that know too much about each other's internals.
- Symptoms: class A reaches into class B's private fields or internal structure; changing class B's internals breaks class A.
- Fix: define a public interface on B that exposes only what A needs; introduce an intermediary if the coupling cannot be reduced directly.
- JS-specific form: modules coupled through shared mutable globals (`export let currentUser`, a mutable `config.js`) — fix by passing dependencies explicitly (parameters/arguments) instead of importing shared mutable state.

### Speculative Generality
Code written to handle cases that do not exist yet and may never exist.
- Symptoms: abstract classes with a single implementation; parameters, hooks, or extension points that nothing uses; "we might need this later".
- Fix: delete it. Write it when you need it. YAGNI. Unused abstractions confuse every reader who tries to understand why they exist.
- Scala-specific form: a type class (`trait Serializable[A]`) with exactly one `given` instance, added "for flexibility" — call the concrete method directly until a second use case arrives.

### Temporal Coupling
Code that must be called in a specific sequence but does not enforce or communicate that sequence.
- Symptoms: calling methods out of order causes subtle bugs; `init()` must be called before `process()` but nothing prevents the reverse.
- Fix: make the sequence impossible to violate through the type system or API design; combine the steps into a single operation that guarantees the order.

### Data Clumps
Groups of data that always appear together but are not captured in a named structure.
- Symptoms: the same 3–4 parameters travel together across many function signatures; parallel arrays or maps that represent one conceptual entity.
- Fix: extract a class or record that names the concept.

### Language-Specific Fix Idioms

The five language references illustrate the same catalog; the fixing shapes are language-flavoured. Use the row matching the code's language:

| Smell | Fix shape by language |
|---|---|
| God Class | All languages: extract focused classes (e.g. `OrderService`, `InventoryService`, `OrderNotifications` out of `OrderManager`) — each with one responsibility. |
| Feature Envy | All languages: move the behaviour onto the object that owns the data (e.g. `Customer.formatAddress()` instead of a helper reaching through `order.getCustomer().getAddress()...`). |
| Primitive Obsession | **Java:** `record EmailAddress(String value)` with a compact constructor that validates and normalizes. **TS/JS:** class whose constructor validates raw input and throws a typed error, storing the normalized value. **Python:** `@dataclass(frozen=True)` with `__post_init__` validation. **Scala:** `case class` with a `private` constructor plus a smart constructor in the companion returning `Either[String, EmailAddress]`. |
| Flag Arguments | All languages: replace the boolean with two named functions (`sendUrgentNotification` / `sendStandardNotification`). |
| Temporal Coupling | All languages: a single entry point / static factory that performs the required steps in order — Java/TS/JS `static generate(config)`, Python `@staticmethod`, Scala companion-object `generate(config)`; alternatively a builder or `init`-less constructor. |
| Data Clumps | **Java:** `record Coordinate(double latitude, double longitude)`. **TS:** `interface Coordinate`. **JS:** a plain named object literal. **Python:** frozen `@dataclass Coordinate`. **Scala:** `case class Coordinate`. Then signatures take `Coordinate`, not `lat1, lon1, lat2, lon2`. |
| Inappropriate Intimacy | JS: replace shared mutable module globals with explicit dependency passing (`placeOrder(cart, apiBase, currentUser)`). Others: expose a minimal public interface / intermediary. |
| Speculative Generality | Scala: drop a single-instance type class and call the concrete method until a second implementation exists. All languages: delete unused abstractions (YAGNI). |

> Provenance: 并入自 Teqqles/cleanerCodeAISkills（repo: https://github.com/Teqqles/cleanerCodeAISkills，path: skills/anti-patterns）。

## Provenance

- Source repo: https://github.com/Teqqles/cleanerCodeAISkills
- Original path: skills/clean-code
- License: unknown — see repo
- 蒸馏说明：原含 6 文件（SKILL.md + 5 份语言示例参考 typescript/python/java/scala/javascript）。参考文档为同一批原则的语言代码示例，已概括为各节下的 "Language idiom" 行；全量逐语言代码示例被压缩，Scala 特有忠告（Option/match、避免巨型 tuple match）单独保留。需要逐语言完整示例见原仓库 references/ 目录。
