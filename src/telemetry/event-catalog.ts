export type TelemetryOwner = 'F' | 'B-owned-observed' | 'C-owned-observed';

export type TelemetrySignalLevel = 'L1_HARNESS' | 'L2_EVENT' | 'L3_FIELD';

export interface TelemetryCatalogEntry {
  event_type: string;
  owner: TelemetryOwner;
  level: TelemetrySignalLevel;
  source: 'harness' | 'proxy' | 'event_store' | 'b_memory' | 'c_coordination';
  description: string;
}

export const TELEMETRY_EVENT_CATALOG = [
  {
    event_type: 'harness.swe_evo_evaluated',
    owner: 'F',
    level: 'L1_HARNESS',
    source: 'harness',
    description: 'SWE-EVO case-level outcome for memory and coordination evaluation.',
  },
  {
    event_type: 'harness.cooperbench_evaluated',
    owner: 'F',
    level: 'L1_HARNESS',
    source: 'harness',
    description: 'CooperBench coordination outcome and failure taxonomy.',
  },
  {
    event_type: 'proxy.llm_usage_recorded',
    owner: 'F',
    level: 'L1_HARNESS',
    source: 'proxy',
    description: 'LLM token usage proxy signal used by token_per_fix.',
  },
  {
    event_type: 'llm.usage_dropped',
    owner: 'F',
    level: 'L2_EVENT',
    source: 'proxy',
    description: 'An LLM usage record could not reach the ledger or the sink; carries the reason.',
  },
  {
    event_type: 'run.event_consumed',
    owner: 'F',
    level: 'L2_EVENT',
    source: 'harness',
    description: 'Per-run stage event totals: counts, payload bytes and the breakdown by type.',
  },
  {
    event_type: 'run.event_committed_batch',
    owner: 'F',
    level: 'L2_EVENT',
    source: 'harness',
    description: 'Per-run count of coordination commit batches and the events they carried.',
  },
  {
    event_type: 'eval.agent_crash',
    owner: 'F',
    level: 'L2_EVENT',
    source: 'harness',
    description: 'P2 perturbation controller observed an intentional agent crash.',
  },
  {
    event_type: 'eval.cold_restart',
    owner: 'F',
    level: 'L2_EVENT',
    source: 'harness',
    description: 'P2 baseline restarted from a bounded summary instead of checkpoint resume.',
  },
  {
    event_type: 'memory.context_pack_built',
    owner: 'B-owned-observed',
    level: 'L2_EVENT',
    source: 'b_memory',
    description: 'B memory built a ContextPack; F observes retrieval and ablation fields.',
  },
  {
    event_type: 'driver.run_result',
    owner: 'B-owned-observed',
    level: 'L2_EVENT',
    source: 'b_memory',
    description: 'Driver result emitted by runtime; F observes DriverReturn and tool events.',
  },
  {
    event_type: 'memory.experience_referenced',
    owner: 'B-owned-observed',
    level: 'L3_FIELD',
    source: 'b_memory',
    description: 'Referenced experiences copied from DriverReturn, not owned by F.',
  },
  {
    event_type: 'buffer.report_received',
    owner: 'B-owned-observed',
    level: 'L2_EVENT',
    source: 'b_memory',
    description: 'B buffer accepted a DriverReturn report for later extraction.',
  },
  {
    event_type: 'memory.extraction_triggered',
    owner: 'B-owned-observed',
    level: 'L2_EVENT',
    source: 'b_memory',
    description: 'B buffer gate selected a batch for extraction.',
  },
  {
    event_type: 'memory.extraction_completed',
    owner: 'B-owned-observed',
    level: 'L2_EVENT',
    source: 'b_memory',
    description: 'B extraction completed and produced an ExtractResult.',
  },
  {
    event_type: 'memory.confidence_updated',
    owner: 'B-owned-observed',
    level: 'L2_EVENT',
    source: 'b_memory',
    description: 'B updated ExperienceRecord confidence; F observes the delta.',
  },
  {
    event_type: 'memory.skill_promoted',
    owner: 'B-owned-observed',
    level: 'L2_EVENT',
    source: 'b_memory',
    description: 'B promoted an ExperienceRecord into a SkillRecord.',
  },
  {
    event_type: 'memory.persona_updated',
    owner: 'B-owned-observed',
    level: 'L2_EVENT',
    source: 'b_memory',
    description: 'B regenerated PersonaDef; F observes version and trigger reason.',
  },
  {
    event_type: 'metrics.updated',
    owner: 'B-owned-observed',
    level: 'L2_EVENT',
    source: 'b_memory',
    description: 'B AgentMetrics snapshot observed for attribution.',
  },
  {
    event_type: 'memory.agent_lifecycle',
    owner: 'B-owned-observed',
    level: 'L2_EVENT',
    source: 'b_memory',
    description: 'B AgentHandle lifecycle transition observed by F.',
  },
  {
    event_type: 'task.created',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'C coordinator created a task.',
  },
  {
    event_type: 'task.claimed',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'C coordinator claimed a task.',
  },
  {
    event_type: 'task.started',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'C coordinator started or resumed task execution.',
  },
  {
    event_type: 'task.completed',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'C coordinator marked a task as completed.',
  },
  {
    event_type: 'task.failed',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'C coordinator marked a task as failed.',
  },
  {
    event_type: 'task.checkpoint_resume',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'C resume path emitted before building ResumePackage.',
  },
  {
    event_type: 'task.before_merge',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'C emitted the merge boundary event before authorization.',
  },
  {
    event_type: 'agent.message_send',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'C persisted an AgentMessage send operation.',
  },
  {
    event_type: 'agent.message_recv',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'C recorded AgentMessage delivery to a recipient.',
  },
  {
    event_type: 'agent.checkpoint',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'C persisted a checkpoint event with resume source fields.',
  },
  {
    event_type: 'checkpoint.saved',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'Scaffold v0 checkpoint event observed as the agent.checkpoint alias.',
  },
  {
    event_type: 'gate.result',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'C persisted a GateResultRecord-compatible result.',
  },
  {
    event_type: 'merge.authorization',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'C produced merge authorization state for the merger boundary.',
  },
  {
    event_type: 'system.timeout',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'C waiting set or delivery timed out.',
  },
  {
    event_type: 'system.budget_exceeded',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'C detected a task budget exhaustion condition.',
  },
  {
    event_type: 'lifecycle.human_gate',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'C entered a human gate or ask-human lifecycle point.',
  },
  {
    event_type: 'coord.checkpoint_observed',
    owner: 'C-owned-observed',
    level: 'L3_FIELD',
    source: 'c_coordination',
    description: 'F observed fields from a C-owned Checkpoint object.',
  },
  {
    event_type: 'coord.resume_package_observed',
    owner: 'C-owned-observed',
    level: 'L3_FIELD',
    source: 'c_coordination',
    description: 'F observed fields from a C-owned ResumePackage object.',
  },
  {
    event_type: 'coord.message_delivery_observed',
    owner: 'C-owned-observed',
    level: 'L3_FIELD',
    source: 'c_coordination',
    description: 'F observed fields from a C-owned MessageDelivery object.',
  },
  {
    event_type: 'coord.file_lease_observed',
    owner: 'C-owned-observed',
    level: 'L3_FIELD',
    source: 'c_coordination',
    description: 'F observed fields from a C-owned FileLease object.',
  },
  {
    event_type: 'coord.anchor_validation_observed',
    owner: 'C-owned-observed',
    level: 'L3_FIELD',
    source: 'c_coordination',
    description: 'F observed anchor validation fields used for resume and duplicate-work metrics.',
  },
  {
    event_type: 'council.decision',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'Council terminal decision; F observes verdict and selection for B.1/B.2.',
  },
  {
    event_type: 'council.started',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'Council session created; F observes topology and participants for B.1/B.4.',
  },
  {
    event_type: 'council.review_round_end',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'Council review round completed; F observes round count for B.1.',
  },
  {
    event_type: 'council.extraction_completed',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'Context extraction gateway output; F observes token savings for B.3.',
  },
  {
    event_type: 'council.completed',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'Council lifecycle ended; F observes duration and total rounds for B.1.',
  },
  {
    event_type: 'task.escalated',
    owner: 'C-owned-observed',
    level: 'L2_EVENT',
    source: 'c_coordination',
    description: 'Task escalated to human; F observes is_escalated for B.2.',
  },
  {
    event_type: 'audit.coordination_trace_observed',
    owner: 'C-owned-observed',
    level: 'L3_FIELD',
    source: 'c_coordination',
    description: 'F observed Council coordination trace fields for B.1/B.2.',
  },
  {
    event_type: 'audit.decision_packet_observed',
    owner: 'C-owned-observed',
    level: 'L3_FIELD',
    source: 'c_coordination',
    description: 'F observed Decision Packet audit fields for B.4/B.5.',
  },
  {
    event_type: 'audit.token_tracker_observed',
    owner: 'C-owned-observed',
    level: 'L3_FIELD',
    source: 'c_coordination',
    description: 'F observed Council token tracker fields for B.3.',
  },
  {
    event_type: 'harness.swe_bench_verified_evaluated',
    owner: 'F',
    level: 'L1_HARNESS',
    source: 'harness',
    description: 'SWE-bench Verified case-level outcome for Pass@1 evaluation.',
  },
  {
    event_type: 'harness.testbed_regression_checked',
    owner: 'F',
    level: 'L1_HARNESS',
    source: 'harness',
    description: 'Testbed PASS_TO_PASS regression check for A.2.',
  },
] as const satisfies readonly TelemetryCatalogEntry[];

const TELEMETRY_EVENT_CATALOG_BY_TYPE = new Map<string, TelemetryCatalogEntry>(
  TELEMETRY_EVENT_CATALOG.map((entry) => [entry.event_type, entry]),
);

export function getTelemetryCatalogEntry(eventType: string): TelemetryCatalogEntry | undefined {
  return TELEMETRY_EVENT_CATALOG_BY_TYPE.get(eventType);
}

export function requireTelemetryCatalogEntry(eventType: string): TelemetryCatalogEntry {
  const entry = getTelemetryCatalogEntry(eventType);
  if (!entry) {
    throw new Error(`Telemetry event ${eventType} is not registered in the catalog`);
  }
  return entry;
}

export function isFOwnedTelemetryEvent(eventType: string): boolean {
  return getTelemetryCatalogEntry(eventType)?.owner === 'F';
}
