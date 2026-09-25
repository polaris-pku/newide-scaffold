# Protocol delivery persistence

`SqliteCoordinationStore` owns the coordination database and the shared protocol
delivery tables. Schema migration 4 adds `outbox`, `inbox`, and `journal` to
the same SQLite file. Opening an existing database applies
the migration without moving or replaying existing Mailbox `messages` and
`deliveries`; those remain separate legacy business records.

Import `ProtocolDeliveryStore` and the record types from `src/persistence`. The
transaction callback is synchronous and uses one SQLite `BEGIN IMMEDIATE`:

```ts
store.withProtocolTransaction((tx) => {
  tx.commitState(coordinationCommit);
  tx.enqueueOutbox({ id, destination, frame });
});
```

Do not call `store.commitState()` inside this callback: use `tx.commitState()`
to avoid a nested transaction. For received commands, insert or deduplicate with
`tx.receiveInbox()`, claim with `claimInbox()`, perform idempotent business work,
then commit the resulting coordination state, optional reply outbox and inbox
completion in one callback. `completeInbox()` requires the current lease owner
and revision. A duplicate `(consumer_id, protocol, exchange_id)` returns the
existing inbox row; a different frame under that key is rejected. A retried
frame may have a larger `attempt` without becoming a different exchange.

Only claimed workers may mark an outbox as `sent`, schedule retry, or mark it
`failed`. `sent` means delivery acknowledged by the recipient; a missing
business reply does not make the original command eligible for replay. A
received receipt completes its original outbox by `causation_id` in the same
transaction. `listRecoverableOutbox()` returns due `pending` rows and activated
`held` rows with no live lease. `listRecoverableInbox()` returns `received` rows
and `processing` rows with an expired lease. The worker performs network sends
outside the database transaction. Failed sends use `retryOutbox()` with a caller
chosen `nextAttemptAt`; direction-specific policy is not built into storage.

The journal is append-only and is not a recovery queue. Its `seq` is one global
SQLite autoincrement sequence, so filtering by task and run preserves commit
order, including equal timestamps. Protocol state changes append protocol rows
inside the same transaction. `tx.appendCall()` writes a completed local call
with `causation_id = null`; calls never become parents in the protocol causal
graph. The existing `events` timeline and telemetry spans remain separate
business/runtime views, not replacements for this ledger.

The unique inbox key prevents duplicate admission, not exactly-once external
effects. Handlers that affect files, processes or other services must be
idempotent by `exchange_id` when an expired lease is reclaimed after a crash.
