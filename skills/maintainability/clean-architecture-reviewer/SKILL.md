---
name: clean-architecture-reviewer
description: 'Reviews codebases and PRs for Clean Architecture violations: dependency-rule breaks,
  misplaced business logic, missing abstractions; maps layers and import directions,
  then reports findings with a verdict. Use for PR review and layering audits.'
---

# clean-architecture-reviewer

> 蒸馏自 PanGan21/clean-architecture-claude-skills（skills/clean-architecture-reviewer）。原为 3 文件（SKILL.md + 2 份参考 review-checklist / common-violations），已内联合并为单文件。
> Distilled from PanGan21/clean-architecture-claude-skills (skills/clean-architecture-reviewer); originally 3 files (SKILL.md + references review-checklist.md and common-violations.md), now inlined as text.

## When to Use

- Reviewing a pull request for architecture regressions.
- Auditing an existing codebase before refactoring.
- Checking dependency direction after a large change.
- Validating that a new feature follows the established layer boundaries.
- Original metadata: domain `api-architecture`, role `specialist`, scope `review`, triggers `review`, `architecture review`, `dependency rule`, `layering`, `PR review`, `code audit`, `violations`.
- Output is a categorized **report** (see Output Format).
- Related skills in the same family (separate skills, not inlined here): `clean-architecture-dependency-inversion`, `clean-architecture-usecase-generator`, `clean-architecture-test-generator`.

## Core Principles

Senior architect conducting thorough architecture reviews that identify layering violations and improve structural quality. Clean Architecture rests on three enforceable properties:

1. **The Dependency Rule** — source code dependencies point only inward.
2. **Responsibility placement** — business logic lives in entities/use cases, never in controllers or infrastructure.
3. **Abstraction boundaries** — outward-facing seams (repositories, gateways) are interfaces owned by inner layers, implemented by infrastructure, and wired only at the composition root.

### Dependency Direction (per-file check)

Import direction must be `Infrastructure → Adapters → Application → Domain`; no file may import outward from its layer.

| Source Layer | Can Import From | Must NOT Import From |
|---|---|---|
| Domain | Nothing | Application, Adapters, Infrastructure |
| Application | Domain | Adapters, Infrastructure |
| Adapters | Application, Domain | Infrastructure (ideally) |
| Infrastructure | All inner layers | — |

### Business Logic Placement

| Check | Pass example | Fail example |
|---|---|---|
| Entity contains domain rules | Entity method validates email format | Validation in controller |
| Use case orchestrates application rules | Use case checks for duplicate email | Duplicate check in route handler |
| Controller only maps I/O | Parses request, calls use case, returns response | Controller queries database directly |
| Infrastructure implements interfaces | Repository implements the interface defined in the application layer | Use case imports a concrete ORM client |

## Workflow

1. **Context** — Read the code or PR. Summarize the intent in one sentence before proceeding. Never review without understanding the intent first.
2. **Map layers** — Identify which files belong to entities, use cases, adapters, and infrastructure.
3. **Check dependency direction** — Verify all imports point inward. Flag any outward dependency, including **transitive** dependency violations.
4. **Check responsibilities** — Verify business logic is in entities/use cases, not controllers or infrastructure. Review test files too.
5. **Report** — Produce a categorized report using the Output Format below: specific `file:line` references, findings prioritized critical → minor, corrected structure suggestions, and explicit praise of good layering when observed.

## Common Violations (with their fixes)

Examples below use TypeScript; the violations and fixes are identical in Java, Python, Go, C#, Kotlin, and any OO language — replace ORM/framework names with the stack's equivalents.

1. **Framework import in domain** — *BAD:* entity depends on the ORM (`import { Prisma } from "@prisma/client"` and an entity constructor taking `Prisma.OrderCreateInput`). *GOOD:* pure domain object with plain typed fields (`id`, `customerId`, `items`) and domain logic such as a computed `total`; no framework types.
2. **Business logic in controller** — *BAD:* the controller looks up a user, decides "already exists" (`if (user) return 409`), and creates the record. *GOOD:* controller delegates to a use case (`this.createUser.execute({...})`) and maps result → response.
3. **Use case returns HTTP concepts** — *BAD:* `execute(...): Promise<{ statusCode: number; body: unknown }>`. *GOOD:* use case returns a domain result typed by the application layer (`Promise<CreateUserOutput>`); status codes belong to the adapter.
4. **Missing repository interface** — *BAD:* use case imports and depends on the concrete `PrismaUserRepository` from infrastructure. *GOOD:* use case depends on an abstraction (`UserRepository` interface owned by the application layer) injected via constructor.
5. **Composition outside main** — *BAD:* the controller instantiates its own graph (`new CreateUserUseCase(new PrismaUserRepository())`). *GOOD:* dependencies are injected from the composition root; the controller takes `CreateUserUseCase` in its constructor.

### Severity Guide

| Severity | Description | Example |
|---|---|---|
| Critical | Dependency rule break | Entity imports framework |
| Major | Misplaced logic | Business rule in controller |
| Minor | Structural suggestion | Folder naming, missing presenter |

## Checklist

**Common red flags (each one a finding):**
- [ ] ORM or database client imported directly inside a use case or entity.
- [ ] HTTP request/response objects (`req`, `res`, `HttpContext`, …) inside a use case.
- [ ] Entity constructor that accepts a framework-specific type (ORM row, HTTP body).
- [ ] Use case that returns an HTTP status code or framework response object.
- [ ] Controller containing `if/else` business decisions instead of delegating to a use case.

**Abstraction boundaries:**
- [ ] Every repository has an interface in the application layer.
- [ ] Every external gateway has an interface in the application layer.
- [ ] Infrastructure classes implement those interfaces.
- [ ] Composition root is the only place that knows all concrete types.

**Test coverage check:**
- [ ] Entity tests need no mocks — domain rules tested directly.
- [ ] Use case tests mock repository interfaces — orchestration tested.
- [ ] Controller tests verify mapping only, not business logic.
- [ ] Infrastructure tests are integration tests against real (or test) services.

**MUST DO:** summarize PR/codebase intent before reviewing · check every import for dependency direction · give specific file and line references · prioritize findings critical → minor · suggest a corrected structure when violations are found · praise good layering when observed.

**MUST NOT DO:** skip reviewing test files · nitpick naming style when the architecture is correct · block on personal preferences unrelated to Clean Architecture · review without understanding the intent first · ignore transitive dependency violations.

## Output Format

Architecture review report must include:
1. **Summary** — One-sentence intent + overall assessment.
2. **Critical violations** — Dependency rule breaks, business logic in wrong layer.
3. **Major issues** — Missing abstractions, tight coupling.
4. **Minor issues** — Naming, folder placement suggestions.
5. **Positive observations** — Clean patterns observed.
6. **Corrected structure** — Target layout if the current one is confused.
7. **Verdict** — Clean / Needs Refactoring / Critical Violations.

## Provenance

- Source repo: https://github.com/PanGan21/clean-architecture-claude-skills
- Original path: skills/clean-architecture-reviewer
- License: MIT
- Author: https://github.com/PanGan21 · version 0.1.0
- 蒸馏说明：原 3 文件（SKILL.md + references/review-checklist.md + references/common-violations.md）。外来 frontmatter schema（metadata/domain/triggers/role/scope/output-format/related-skills/license/version/author）已全部移入正文对应章节；两份参考的层级导入规则表、责任放置表、5 类常见违规与严重度分级、红旗清单与测试覆盖检查已内联，违规的完整 TS 代码示例被压缩为 BAD→GOOD 形状描述；需要逐行示例见原仓库 references/common-violations.md。
