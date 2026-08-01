# Mailbox

This module owns persisted Mailbox messages, deliveries, ACK/reply semantics, and delivery to an
Agent-facing wake port.

V1 is intentionally limited to Task-scoped, single-recipient, one-question/one-answer messages.
ACK records delivery handling; reply records the business answer. Group chat and broadcast are out
of scope.

The module may expose a continuation request, but it must not directly mutate Task/Run state or
start a Run. `src/coordination` validates that request, binds it to a durable Task cursor, and owns
the resulting transition. SQLite implementation details remain in `src/persistence`.

The old `src/coordinator/mailbox-store.ts` and `mailbox-handoff.ts` are IntegrationV0 compatibility
code, not the production Mailbox extension point.
