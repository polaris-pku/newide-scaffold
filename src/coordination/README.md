# Coordination

`src/coordination` is the canonical Direction C application layer for durable Task and Run
execution. New production coordination work belongs here, not in `src/coordinator`.

## Ownership boundary

| Area | Owns | Does not own |
| --- | --- | --- |
| `coordination` | Task/Run lifecycle, durable cursor, stage loop, integration ports | Checkpoint algorithms, Mailbox message semantics, RPC transport |
| `checkpoint` | Safepoints, file anchors, ResumePackage construction and restoration | Starting Runs or deciding UI behavior |
| `mailbox` | Message/delivery state, ACK/reply semantics, Agent wake/delivery service | Task state transitions or implicit Run creation |
| `persistence` | SQLite/filesystem adapters implementing module ports | Domain policy |
| `app` | Production composition and backend service facade | A second Task/Run state machine |
| `rpc` | JSON-RPC validation and transport mapping | Domain state or persistence |

Checkpoint and Mailbox contributors should change their owned module first. Any change that
advances a Task cursor, starts a Run, or changes the shared SQLite composition is an integration
change owned by the C application layer and should be reviewed separately.

## Dependency direction

```text
app / rpc
    -> coordination
        -> checkpoint + mailbox ports
        -> persistence ports

persistence adapters
    -> implement coordination/checkpoint/mailbox ports
```

`src/coordinator` is the legacy IntegrationV0 compatibility implementation. It remains available
while callers migrate, but new production Checkpoint, Mailbox, Task, or Run behavior must not be
added there.

## Typed stage termination (stage 2, role autonomy)

The role autonomy loop lives in `src/app/role-execution-loop.ts` and `src/app/role-autonomy-engine.ts`
(the composition root owns it); coordination only **maps** its terminal outcome onto the existing
Task/Run commit path. The stable carrier is `stage-termination.ts`:

- `StageTermination = { code, actor, message?, details? }`, `actor ∈ role | host | user | driver | system`,
  and `StageTerminationError` (recognized by **instance**, never by message/name parsing).
- `task-execution-loop.stageFailure` prefers a `StageTerminationError` and returns its `code` +
  `message` + `{ ...details, cursor, actor }`; `TaskProcessor.failStage` writes the same object into
  `task.error` / `run.error` and emits `run.failed` with `{ status: 'failed', code, message }`.
  Ordinary errors keep `stage_execution_failed`; evidence-write failures keep
  `stage_evidence_write_failed`.
- Task/Run **status ownership does not move**: role `blocked`/`failed` still terminate as
  `failed` (they are terminal failures, not resumable Task `blocked`); budgets and host faults are
  `failed` with `budget_*` / `host_failed`; user cancel/interrupt keep `cancelled` / `interrupted`
  because the loop's abort branch runs before the failure mapping.
- The app layer wraps its own `RoleTerminationError` into a `StageTerminationError` at the stage
  executor boundary, so coordination never imports app code. Reason codes that may appear include
  `role_blocked`, `role_failed`, `budget_dispatches|rounds|tokens|wall_clock`, `host_failed`,
  `dispatch_unknown_unresolved`, `journal_write_failed`, `evidence_write_failed`.

## Stage 4: dispatch progress projection and read-back

The dispatch Journal under `<runDir>/journal/` stays the only fact source. Everything the frontend
sees is a projection of it:

- The role engine emits **low-frequency lifecycle events** through the stage event outlet
  (`agent.dispatch_accepted|started|settled|reconciled|inherited`, `agent.plan_updated`,
  `agent.finish_requested`, `agent.role_terminated`; vocabulary in
  `src/app/run-dispatch-events.ts`). They are ordinary `agent.*` timeline events, so they survive
  restart, reach subscribers, and never carry full instructions/transcripts.
- `src/app/run-dispatch-projection.ts` folds that timeline into `dispatch_summary` /
  `dispatch_progress` (`src/protocol/run-snapshot.ts`). Both snapshot projectors
  (`run-snapshot-projector.ts`, `task-run-snapshot-projector.ts`) and the terminal writer use the
  same pure fold, so live, terminal, persisted and on-disk views agree. Identity is `dispatch_id`;
  replayed events do not double count. Parent-chain work is reported under `inherited` and is never
  added to the current Run's `total`.
- Detail stays behind controlled refs: `run.getDispatchJournal` pages the Journal (metadata only)
  and `run.getDispatchEvidence` pages a registered evidence sidecar through `RunDispatchJournal.peek`
  (read-only, no writer lock, no repair). Neither endpoint dispatches work or mutates terminal state;
  a missing timeline/field is a projection gap, never a reason to re-run anything.
- Usage attribution: role LLM calls are recorded under `execute_agent` **and** `role_id` at the
  facade boundary; driver stream events carry the producing `dispatch_id` so driver usage
  observations can be grouped per dispatch (legacy observations stay `unattributed`, not zero).
- **Review fix R4-01 (2026-11-15): events are projections, the Journal is the fact source.** When an
  event outlet failed or the process died before the event was persisted, the projection can be
  rebuilt: `projectDispatchFacts(events, {journal_records})` idempotently merges folded Journal
  records by `dispatch_id` (fills gaps and upgrades a raw `unknown` to a trusted reconciled status,
  never overwriting a settled terminal). The engine re-emits `recovered: true` lifecycle facts at
  recovery entry (no driver/LLM call, no budget/cursor/terminal change), and the terminal writer /
  persisted `run.snapshot` use read-only `readRunDispatchFacts` for the same merge. Legacy runs
  without a Journal keep the pure event projection; no dispatch fact is invented.
- **Review fix R4-02:** `effectiveDispatchRecordStatus` in `role-autonomy-contract.ts` is the single
  interpretation of "raw settled status vs. reconciled effective status" (only a raw `unknown` with
  a trusted `reconciled` is upgraded; issued terminals are never rewritten; Journal rows keep
  `unknown`). Snapshot projection, `inherited.by_status`, the Journal RPC summary and the
  `driver-stream` report reconciliation all use it, and the RPC summary exposes optional
  `reconciled_dispatch_ids`.
