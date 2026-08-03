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
