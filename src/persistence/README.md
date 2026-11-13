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

## Run dispatch journal (stage 1)

`run-dispatch-journal.ts` is the append-only, per-Run dispatch fact source for
the role/driver autonomy work. It is **not wired into the production
composition root yet** (that is stage 2); the default run path is unchanged.
Schemas live in `src/driver/execution-contract.ts` — persistence implements file
I/O, folding and the controlled evidence reader only.

```
<runDir>/journal/dispatches.jsonl      one immutable JSON event per line (fsync per append)
<runDir>/journal/evidence/<dispatch>.json  immutable evidence sidecar (canonical JSON, sha256)
<runDir>/journal/repair/<...>.tail     preserved raw bytes of a repaired half-written tail
<runDir>/journal/.writer.lock/         single-writer lock DIRECTORY
<runDir>/journal/.writer.lock/owner.json  {pid, token, created_at, run_id}, atomic tmp+rename
<runDir>/journal/.writer.lock.reclaim/ fixed reclaim GATE directory (manual recovery only)
```

- Identity: `{run_id, task_id, role_id}`; `accepted` assigns the dispatch
  `sequence` (contiguous 1..N), and `dispatched` / `settled` / `reconciled` must
  match it. `entry_id` duplicates dedupe by content (ignoring `at`); equal
  `settled`/`reconciled` semantics dedupe, conflicts throw `JournalCorruptionError`.
- Fold derives `phase` + `status` per dispatch: accepted with no dispatched and
  no delivery evidence is `not_executed`; dispatched with no settled/trusted
  receipt is `unknown`; a trusted ADP `reconciled` overrides `unknown` and takes
  precedence over local guesses even when only `accepted` exists. `settled`
  status is never rewritten by late reconciliation.
- **Single writer (review fix: gate-serialized reclaim)**: the lock is a directory
  created with non-recursive `mkdir` (atomic; `EEXIST` = held), and `owner.json` is
  published with tmp `wx` + fsync + rename so a reader never sees half-written
  ownership. Stale recovery is serialized through a fixed reclaim **gate**
  directory (`.writer.lock.reclaim/`, created atomically): acquisitions fail
  `journal_locked` while the gate exists; a dead-owner reclaim must hold the gate
  and **re-read the owner under it**, and only then delete the stale lock
  directory; `close()` also takes the gate and re-reads the owner, deleting only
  its own lock. The live lock path is **never moved/renamed** — there is no
  move-then-verify window that could let two writers hold the journal. A lock
  with missing/unparseable/incomplete owner is never treated as dead (fail
  closed). A crashed reclaimer can leave the gate behind: that is deliberately
  fail-closed, and recovery is manual — verify no writer is active, then remove
  `<runDir>/journal/.writer.lock.reclaim` (and a stale `.writer.lock` whose owner
  is dead) and retry. A busy gate during `close()` leaves the lock in place (no
  delete, no throw).
- **Ownership lost means no writes**: every write path re-reads `owner.json`
  before writing and requires the instance's `token` + pid; otherwise it clears
  `lockHeld` and throws `journal_lock_lost`. In-memory `lockHeld` alone is never
  trusted.
- **In-instance serialization + open→closing→closed lifecycle (review fix: P1
  writer/close race)**: every mutation entry point (`append*`,
  `appendEvidence`, `repairTail`, `registerEvidenceRef(s)`) is admitted
  synchronously and then runs through a single FIFO critical section that covers
  "read state → validate → write journal/sidecar → fsync → update in-memory
  state". Two appends on the same instance therefore cannot validate against the
  same stale fold and both commit the same `sequence`. `close()` enters
  `closing` synchronously: mutations arriving afterwards are rejected with
  `journal_not_open`; mutations admitted before `close()` — already running
  **or still queued** — all finish before the writer lock is released, and only
  then does the instance become `closed` (it never writes journal or sidecars
  again). Concurrent `close()` calls share one close promise, so none returns
  before the actual close completes. A failed mutation rejects only its own
  caller: the queue is not poisoned and the next operation re-reads the real
  durable state, so a half-written/corrupt state still fails closed.
- Half-written **last** line only: `repairTail()` stores the raw bytes and hash
  in a sidecar, then appends a `repair` entry; readers may skip only the line
  immediately before a matching `repair`. Middle corruption, hash mismatch,
  missing repair or sequence regression fail closed. A **complete** JSON line at
  EOF without a trailing newline is a valid entry (read = `ok`, never repaired or
  dropped); before the next append the journal durably appends exactly one `\n`
  (`appendLineTerminator`), and a failure there throws before the new line is
  written, so no two events can be concatenated.
- Durability: every line is fsynced; directory fsync is best-effort and recorded
  as `durability={mode:'best_effort',directory_sync:false}` when the platform
  refuses it (Windows). Do not claim power-loss durability in that mode.
- Evidence refs: `appendEvidence` writes canonical JSON bytes so
  `ref.sha256 === hashExecutionEvidence(evidence)`; `readEvidence(ref,
  {offset, limit})` accepts only refs registered on this journal (written or
  folded), requires **both** the path and the sha256 to be registered, enforces
  safe relative paths + realpath containment, a size cap, pagination and
  full-byte sha256 verification. The derived sidecar path
  `journal/evidence/<dispatch_id>.json` is bound to the settled
  `evidence_sha256` — after a restart, a tampered file with a caller-supplied new
  hash is rejected (`evidence_ref_not_registered`), never redefined. Explicit
  `registerEvidenceRef` (async) refuses to redefine an already-registered path
  with a different hash (`evidence_ref_conflict`); `retry_of` /
  `reconciliation_ref` validation reuses the same registry. Large evidence stays
  in the sidecar; the journal line stores refs and hashes.
- A Run directory without `journal/dispatches.jsonl` is `legacy`: read/fold
  report `kind: 'legacy'` and fabricate no dispatch, create no file and migrate
  no history.
- Fault-injection: `DispatchJournalIo` is injectable (`createNodeDispatchJournalIo`
  is the real implementation) and includes `mkdirExclusive`, `rmdir`,
  `appendLineTerminator`, so tests/barrier checks can fail a specific lock,
  newline, append or evidence write without a real crash.
