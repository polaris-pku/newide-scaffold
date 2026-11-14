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
