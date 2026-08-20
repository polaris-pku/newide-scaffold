# Memory Module API Surface Plan (feat/memory-api-surface-impl)

> Branch: `feat/memory-api-surface-impl`
> Local deep-dive references (git-ignored by repo convention, see `.gitignore` lines 53-54):
> `src/memory/docs/对外接口局限分析.md` (limitation analysis with evidence)
> `src/memory/docs/对外接口完善计划.md` (full executable design, Chinese)
> This file is the tracked, self-contained plan used for implementation rounds.

## Completion Status (M1–M7)

All milestones implemented, tested, and committed on `feat/memory-api-surface-impl`:

| Milestone | Commit | Scope |
|---|---|---|
| M1 | `f417e32` | Agent lifecycle RPCs + dynamic catalog |
| M2 | `650838b` | Skill / Experience management writes |
| M3 | `7aa8f4e` | Persona update + on-demand regeneration |
| M4 | `caabd2c` | Task rating feedback loop |
| M5 | `589a9b1` | Buffer observability + extraction retry |
| M6 | `b272bcc` | List filters / pagination / in-agent search |
| M7 | (this commit) | capabilities v2 + integration verification + docs |

**Final `memory.*` surface (29 methods):** existing 13 + `createAgent` / `updateAgent` /
`deleteAgent` / `createSkill` / `updateSkill` / `deleteSkill` / `publishSkillToMarket` /
`updateExperience` / `deleteExperience` / `updatePersona` / `regeneratePersona` /
`rateTask` / `getBufferState` / `getPendingBuffer` / `retryExtraction` / `searchMemory`,
plus filter/pagination params on `listAgents` / `listSkills` / `listExperiences`.
Capabilities schema bumped to `newide.b-memory-capabilities.v2` with 28 operation flags.

## 1. Problem

The frontend talks to memory through `memory.*` JSON-RPC methods
(`src/rpc/memory-methods.ts`, 13 methods). All write paths depend on a chain of
prior artifacts (task execution → extraction → promotion → market), so there is
**no "create from scratch" write channel**. Confirmed gaps:

### Known 3 (user-reported)
1. **Cannot create/delete an agent** — `AgentManager.createAgent` exists but is
   never exposed; production only creates implicitly via
   `DriverRuntimeAgentExecutionFacade.ensureRole` (`{role_id, name: role_id, tags: []}`);
   `MemoryRepository` has **no deleteAgent at all**; `MARKET_AGENT_CATALOG`
   (`src/app/production-b-runtime.ts:18-44`) is a hardcoded 4-agent allowlist that
   gates selection/council/mailbox — a new agent would be a "shadow agent".
2. **Cannot manually import a skill** — only channel is `marketImport`, which
   requires the source skill to already exist in the market; no `saveSkill` RPC;
   `SkillRecordSchema.description_embedding` is required, so the server must
   generate embeddings.
3. **Cannot modify persona** — capabilities declare `update_persona: unavailable`;
   worse, `PersonaEvolutionProcessor` is **not wired into production**, so persona
   is frozen after seeding.

### Newly found (analysis round)
| ID | Limitation | Evidence |
|---|---|---|
| L1 | **User rating/feedback chain missing** — `user_rating`/`source_user_rating` exist in schemas but have **zero write points**; both extractors hardcode `undefined` (`llm-experience-extractor.ts:146`, `rule-based-experience-extractor.ts:118`). Confidence cannot be corrected by users. | grep `user_rating` → only schema/views |
| L2 | **No experience/skill curation writes** — `updateExperience`/`deleteExperience`/`updateSkill`/`deleteSkill` implemented in both repos but 0 exposed. Wrong/duplicate memory cannot be fixed. | `ports/memory-repository.ts` |
| L3 | **Buffer invisible & failures unmanageable** — no RPC for buffer meta / pending / dead-letter; `listMaintenance` shows `failed` but cannot retry or requeue (docs "阶段 6" not landed). | `ports/buffer-repository.ts` |
| L4 | **Lists unpaginated/unfiltered, no search** — full dumps only; vector `searchSkills/searchExperiences` exist but no text-query RPC for a single agent. | `adapters/agent-board-query.ts` |
| L5 | **No rename/tags edit, no hard delete, no reactivation, retired still listed** — no `updateAgent`; board query has no status filter. | `ports/agent-board-query.ts` |
| L6 | **No persona version history / on-demand regeneration** (docs "阶段 9" not landed). | `savePersona` overwrite |
| L7 | **capabilities incomplete** — `operations` lacks create/delete/update entries; UI renders only what is declared. | `b-memory-backend-service.ts:78-130` |
| L8 | **Hardcoded catalog** — see known-1. Creation must be coupled to a dynamic catalog. | `production-b-runtime.ts` |
| L9 | **Consistency/idempotency hazards** — manual writes must go through `AgentManager` (memory map + buffer init + QueryMemoryTool injection); manual `saveSkill` has no idempotency key. | `agent-manager.ts:147-162` |
| UX | Long ops have no progress; maintenance evidence has no task/run links; manual writes need server-side embedding; no one-click ops (regenerate persona, retry failed extractions); no rating entry. | — |

## 2. Design Principles

1. Server completes derived fields (embedding, ids, timestamps); frontend submits text only.
2. Agent-level writes go through `DriverRuntimeAgentExecutionFacade` (holds `AgentManager`);
   asset-level writes go through `BMemoryBackendService` composing repo/services.
3. Agent catalog becomes DB-driven + env seed; allowlist consumers query dynamically.
4. capabilities ↔ RPC 1:1; UI renders by declaration.
5. Hard delete only allowed for `retired` agents (skills already migrated to market;
   remaining retained experiences are cascade-deleted). Active agents must `retireAgent` first.
6. Idempotency: skills dedupe on `(agent_id, content-hash)`; market import keeps
   `imported_from`; retry extraction keyed by `(role_id, buffer_seq, task_id)`.

## 3. New RPC Methods (`memory.*`)

### A. Agent lifecycle (known-1, L5)
| RPC | Params | Returns | Notes |
|---|---|---|---|
| `memory.createAgent` | `{role_id, name, tags?, persona_seed?, constraints?}` | `AgentBoardAgentView` | validate uniqueness + reserved ids; facade → `AgentManager.createAgent` |
| `memory.updateAgent` | `{role_id, name?, tags?}` | `AgentBoardAgentView` | PATCH; new repo `updateAgentMeta` |
| `memory.deleteAgent` | `{role_id, confirm: true}` | `{deleted: true, removed_experiences}` | retired-only; cascade experiences + buffer dir; new repo `deleteAgent`, buffer `deleteAgent`; remove from manager map |
| `memory.reactivateAgent` | `{role_id}` | `AgentBoardAgentView` | `retired → active`; low priority |

### B. Skill management (known-2, L2)
| RPC | Params | Returns | Notes |
|---|---|---|---|
| `memory.createSkill` | `{role_id, description, content, tags?, version?}` | `SkillView` | server id/embedding/timestamps; `review_status` pending (or approved if auto-approve); content-hash dedupe |
| `memory.updateSkill` | `{role_id, skill_id, description?, content?, tags?, market_status?}` | `SkillView` | re-embed on content change |
| `memory.deleteSkill` | `{role_id, skill_id}` | `{deleted: true}` | respect `imported_by` references |
| `memory.publishSkillToMarket` | `{role_id, skill_id}` | `SkillView` | light listing: `market_status='available'`, keep ownership (distinct from retirement `transferSkillToMarket`) |

### C. Experience management (L2)
| RPC | Params | Returns | Notes |
|---|---|---|---|
| `memory.updateExperience` | `{role_id, experience_id, description?, content?, tags?, confidence?}` | `ExperienceView` | re-embed on content change; confidence → `confidence_history` (`reason: 'manual_adjustment'`) + `avg_confidence` |
| `memory.deleteExperience` | `{role_id, experience_id}` | `{deleted: true}` | detach `promoted_to` link only |

### D. Persona (known-3, L6)
| RPC | Params | Returns | Notes |
|---|---|---|---|
| `memory.updatePersona` | `{role_id, summary?, skills_overview?, experience_coverage?, recent_performance?, notes?}` | `PersonaDef` | PATCH merge + `version+1` + `savePersona` |
| `memory.regeneratePersona` | `{role_id}` | `PersonaDef` | `LlmPersonaInduction` (fallback rule-based); needs LlmClient injected into B service |

### E. Rating / feedback (L1, docs "阶段 8")
| RPC | Params | Returns | Notes |
|---|---|---|---|
| `memory.rateTask` | `{role_id, task_id, rating: resolved\|partially_resolved\|unresolved\|not_rated, note?}` | `{updated_experiences, buffer_updated}` | ① find experiences by `source_task_id` (new repo `findExperiencesBySourceTask`; interim: filter `listExperiences`) → set `source_user_rating`; ② new `services/feedback.ts` adjusts confidence (resolved +0.05 ≤1 / partial none / unresolved −0.1 ≥0, history `reason: 'user_rating'`, sync `avg_confidence`); ③ if buffer still pending, write `BufferSnapshot.user_rating` (new buffer `updateBufferRating`); ④ best-effort `recordTaskOutcome` |

### F. Buffer observability / retry (L3, docs "阶段 6")
| RPC | Params | Returns | Notes |
|---|---|---|---|
| `memory.getBufferState` | `{role_id}` | `{meta, pending_seqs, dead_letter_seqs}` | new buffer `listDeadLetterSeqs` (file: read `dead_letter/` dir; in-memory: set) |
| `memory.getPendingBuffer` | `{role_id, seq}` | `{snapshot, agent_context?}` | passthrough `AgentMemoryScope.getPendingBuffer` |
| `memory.retryExtraction` | `{role_id, seq}` | `BMemoryMaintenanceEvidence` | new buffer `restoreDeadLetter` (dead_letter → pending) + reuse `BMemoryMaintenanceRunner.scheduleBuffer`; idempotent key |

### G. List enhancements / search (L4)
| RPC | Params | Returns | Notes |
|---|---|---|---|
| `memory.listSkills` / `listExperiences` (extended) | optional `{type?, review_status?, tag?, confidence_min?, confidence_max?, keyword?, offset?, limit?, sort?}` | array | extend `AgentBoardQuery` filters/pagination; `keyword` = text contains; `listAgents` gains `status?` |
| `memory.searchMemory` | `{role_id, query, top_k?, include_skills?, include_experiences?}` | `{skills, experiences}` | text → embedding → repo `searchSkills/searchExperiences` |

## 4. Port / Service Extensions

**`ports/memory-repository.ts`** (+ in-memory + pg implementations):
`updateAgentMeta`, `deleteAgent` (cascade experiences), `findExperiencesBySourceTask`.

**`ports/buffer-repository.ts`** (+ in-memory + file implementations):
`deleteAgent`, `updateBufferRating`, `listDeadLetterSeqs`, `restoreDeadLetter`.

**`ports/agent-board-query.ts`** (+ `adapters/agent-board-query.ts`):
`listAgents(status?)`, `listSkills(role_id, filter?)`, `listExperiences(role_id, filter?)` with pagination.

**New services**: `services/memory-writer.ts` (skill/experience writes, embedding/id/timestamps,
dedupe), `services/feedback.ts` (applyUserRating), `services/persona-update.ts`
(mergePersonaPatch + regeneratePersona).

**`src/app/`**: extend `BMemoryLifecycle` with `createAgent`/`updateAgent`/`deleteAgent`
(implemented by `DriverRuntimeAgentExecutionFacade` via base `AgentManager`);
`BMemoryBackendService` new methods + capabilities v2 (`newide.b-memory-capabilities.v2`,
16 new operations); optional `personaInducer` (LlmClient) injection;
`production-b-runtime.ts` catalog dynamicization (§5); `backend-rpc-stdio.ts` allowlist
consumers become dynamic queries.

**`src/rpc/memory-methods.ts`**: new RPCs + strict Zod param schemas.

## 5. Catalog Dynamicization (pre-requisite, known-1/L8)

- Keep `seedCatalog` (seed `MARKET_AGENT_CATALOG` + optional `NEWIDE_AGENT_CATALOG_JSON`
  overrides into DB via `initializeAgent`).
- Replace static `market_agent_ids` with dynamic `() => repository.listAgentIds()`
  (auto-excludes `__market__`) at the 5 consumers (`assertValidMarketAgentIds` → seed-only
  bootstrap check; `BAgentProjectionAdapter.allowedAgentIds`; council resolver
  `allowedAgentIds`; mailbox `allowedRoleIds`; `bootstrapAgentIds`).
- Keep `tags: ['market_eligible']` style qualification where appropriate.

## 6. Milestones

| # | Scope | Main files |
|---|---|---|
| M1 | Catalog dynamicization + agent lifecycle | `production-b-runtime.ts`, `driver-runtime-agent-execution-facade.ts`, `agent-manager.ts`, `ports/memory-repository.ts`, `ports/buffer-repository.ts`, both repos, `b-memory-backend-service.ts`, `newide-backend-service.ts`, `memory-methods.ts` |
| M2 | Skill/experience management writes | new `services/memory-writer.ts`, `findExperiencesBySourceTask`, app 3 layers, `memory-methods.ts` |
| M3 | Persona update + regenerate | new `services/persona-update.ts`, LlmClient injection, app 3 layers, `memory-methods.ts` |
| M4 | Rating chain | new `services/feedback.ts`, `updateBufferRating`, app 3 layers, `memory-methods.ts` |
| M5 | Buffer observability/retry | `ports/buffer-repository.ts` + both impls, `b-memory-maintenance-runner.ts` (retry reuse), app 3 layers, `memory-methods.ts` |
| M6 | List filters/pagination/search | `ports/agent-board-query.ts`, `adapters/agent-board-query.ts`, app 3 layers, `memory-methods.ts` |
| M7 | capabilities v2 + docs + integration verification | `b-memory-backend-service.ts`, README updates, stdio RPC smoke script |

Dependencies: M1 is the base for M2–M7; M4 needs `findExperiencesBySourceTask` (from M2
or earlier); M3 needs M1's injection channel.

## 7. Verification

1. Per milestone: `pnpm typecheck && pnpm test`; unit tests for new services / repo methods / RPC param validation.
2. stdio RPC smoke (`pnpm backend:rpc`): `memory.createAgent` → `memory.createSkill` →
   `memory.updatePersona` → `memory.rateTask` → `memory.getBufferState` →
   `memory.retryExtraction` → `memory.deleteAgent` (after retire); verify shapes + capabilities v2.
3. Full gate: `pnpm verify`.
4. Update `src/memory/docs/README.md` capability matrix.

## 8. Out of Scope (future)

- Buffer claim/lease state machine + crash recovery (docs "阶段 6" remainder).
- Persona version history persistence & rollback (docs "阶段 9" remainder; this plan does PATCH + on-demand regen).
- Full event-driven metrics (docs "阶段 8" remainder; this plan closes rating → confidence minimum loop).
- `memory.createExperience` manual fabrication (conflicts with extraction semantics).
