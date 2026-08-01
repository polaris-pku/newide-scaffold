# Checkpoint

This module owns pure Checkpoint and recovery mechanics: safepoints, file/Git anchors,
ResumePackage construction, verification, and workspace restoration.

It does not start Runs, mutate frontend state, or silently restart from the beginning. The C
application layer in `src/coordination` decides whether a blocked Task may resume and creates the
new Run. An invalid or missing anchor must remain an explicit blocked outcome.

The old `src/coordinator/checkpoint-store.ts` is IntegrationV0 compatibility code and is not the
production Checkpoint extension point.
