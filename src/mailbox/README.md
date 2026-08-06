# Mailbox

This module owns persisted Mailbox messages, deliveries, ACK/reply semantics, and delivery to an
Agent-facing wake port.

The current contract is limited to Task-scoped, single-recipient, one-question/one-answer
messages. ACK records delivery handling; reply records the business answer. Group chat and
broadcast are out of scope.

The only Agent tool shape is:

```ts
mailbox_send({
  to_role_id: string,
  kind: 'request' | 'notice',
  content: string,
  artifact_refs?: string[],
})
```

`request` wakes the recipient and leaves the sender waiting for one business reply. `notice` is
durable and is shown on the recipient's next natural turn without an extra wake-up. The Host adds
Task/workspace/thread/reply/idempotency metadata and owns ACKs. The historical `type/payload` Host
RPC fields remain an adapter for old callers and audit rows; they are not part of the Agent tool.

Delivery requires an explicitly registered Task/workspace/role Session. A missing binding is
reported as a collaboration deadlock and never causes the worker to create a new Session.

The module exposes delivery facts and a continuation request, but it does not directly mutate
Task/Run state or start a Run. `src/coordination` validates that request, binds it to the durable
`mailbox_wait` cursor, and owns the resulting transition. SQLite implementation details remain in
`src/persistence`.

The old `src/coordinator/mailbox-store.ts` and `mailbox-handoff.ts` are IntegrationV0 compatibility
code, not the production Mailbox extension point.
