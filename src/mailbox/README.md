# Mailbox

This module owns persisted Mailbox messages, deliveries, ACK/reply semantics, and delivery to an
Agent-facing wake port.

The current contract is limited to Task-scoped, single-recipient, one-question/one-answer
messages. ACK records delivery handling; reply records the business answer. Group chat and
broadcast are out of scope.

The module exposes delivery facts and a continuation request, but it does not directly mutate
Task/Run state or start a Run. `src/coordination` validates that request, binds it to the durable
`mailbox_wait` cursor, and owns the resulting transition. SQLite implementation details remain in
`src/persistence`.

The old `src/coordinator/mailbox-store.ts` and `mailbox-handoff.ts` are IntegrationV0 compatibility
code, not the production Mailbox extension point.
