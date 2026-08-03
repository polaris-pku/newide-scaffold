# Legacy Coordinator Compatibility

This directory contains the historical IntegrationV0 coordinator, in-memory Mailbox/Checkpoint
stores, compatibility contracts, and artifact helpers used by existing callers.

The canonical durable Task/Run application layer is `src/coordination`. Production Checkpoint and
Mailbox behavior belongs in `src/checkpoint` and `src/mailbox`. Do not add new durable state,
resume, or collaboration behavior to the in-memory stores in this directory.
