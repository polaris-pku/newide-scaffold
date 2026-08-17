import { SCHEMA_VERSION, createId, nowTimestamp, type RunId, type TaskId } from '../core';
import type { ContextPack } from '../memory/contract';
import type { DriverReturn, ExtractResult, PersonaDef, SkillRecord } from '../memory/schemas';
import type { MemoryRetrievalResult } from '../memory/services/memory-query';
import type { PromotionOutcome } from '../memory/types';
import {
  observeAgentMetricsUpdated,
  observeBufferReportReceived,
  observeContextPackBuilt,
  observeExtractionCompleted,
  observeExtractionTriggered,
  observeSkillPromoted,
} from './adapters/b-memory';
import { emitTelemetryBatch } from './emit';
import { activeLedgerTokenCostTotal } from './llm-usage-ledger';
import type { TelemetryEmission, TelemetrySink } from './telemetry-sink';

export interface MemoryCycleTelemetryContext {
  task_id: TaskId;
  role_id: string;
  run_id?: RunId;
  memory_ablation?: string;
  /** Optional override; defaults to active LLM usage ledger total. */
  token_cost_total?: number;
}

function buildObservedContextPack(
  task_id: TaskId,
  role_id: string,
  retrieval: MemoryRetrievalResult,
): ContextPack {
  const timestamp = nowTimestamp();
  return {
    context_pack_id: createId('context_pack'),
    task_id,
    role_profile_ref: {
      role_id,
      persona_ref: `persona://${role_id}/current`,
      skill_refs: retrieval.skills.map((skill) => `skill://${skill.id}`),
      capability_tags: [],
      memory_policy: {
        allow_in_driver_context: true,
        allow_in_council_proposer: false,
        allow_in_council_judge: false,
        max_memory_items: 10,
      },
      schema_version: SCHEMA_VERSION,
    },
    memory_refs: [
      ...retrieval.experiences.map((experience) => ({
        memory_id: experience.id,
        kind: 'experience' as const,
        uri: `memory://experience/${experience.id}`,
        summary: experience.description,
        schema_version: SCHEMA_VERSION,
      })),
      ...retrieval.skills.map((skill) => ({
        memory_id: skill.id,
        kind: 'skill' as const,
        uri: `memory://skill/${skill.id}`,
        summary: skill.description,
        schema_version: SCHEMA_VERSION,
      })),
    ],
    artifact_refs: [],
    summary: 'F telemetry observation synthesized from memory-cycle retrieval',
    created_at: timestamp,
    schema_version: SCHEMA_VERSION,
  };
}

export function observeDriverReturnReport(input: {
  task_id: TaskId;
  run_id?: RunId;
  call_id: string;
  source_driver: string;
  driver_return: DriverReturn;
}): TelemetryEmission[] {
  const baseEmission: TelemetryEmission = {
    event_type: 'driver.run_result',
    subject_id: input.call_id,
    subject_type: 'driver_return_report',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    payload: {
      source_driver: input.source_driver,
      driver_return: input.driver_return,
    },
    source: { kind: 'b_memory', object_type: 'DriverReturn' },
  };

  const referencedExperiences = input.driver_return.referenced_experiences;
  if (!referencedExperiences || referencedExperiences.length === 0) {
    return [baseEmission];
  }

  return [
    baseEmission,
    {
      event_type: 'memory.experience_referenced',
      subject_id: input.call_id,
      subject_type: 'driver_return',
      ...(input.run_id ? { run_id: input.run_id } : {}),
      task_id: input.task_id,
      payload: {
        referenced_experiences: referencedExperiences,
      },
      source: { kind: 'b_memory', object_type: 'DriverReturn.referenced_experiences' },
    },
  ];
}

export function collectMemoryCycleTelemetry(input: {
  context: MemoryCycleTelemetryContext;
  retrieval: MemoryRetrievalResult;
  call_id: string;
  source_driver: string;
  driver_return: DriverReturn;
  buffer_seq: number;
  extract_result: ExtractResult;
  promotion: PromotionOutcome;
  persona: PersonaDef;
  skills_after: SkillRecord[];
  experience_count: number;
}): TelemetryEmission[] {
  const { context } = input;
  const emissions: TelemetryEmission[] = [
    observeContextPackBuilt({
      context_pack: buildObservedContextPack(context.task_id, context.role_id, input.retrieval),
      ...(context.run_id ? { run_id: context.run_id } : {}),
      ...(context.memory_ablation ? { ablation: context.memory_ablation } : {}),
      retrieved_experience_ids: input.retrieval.experiences.map((experience) => experience.id),
      retrieved_skill_ids: input.retrieval.skills.map((skill) => skill.id),
    }),
    ...observeDriverReturnReport({
      task_id: context.task_id,
      ...(context.run_id ? { run_id: context.run_id } : {}),
      call_id: input.call_id,
      source_driver: input.source_driver,
      driver_return: input.driver_return,
    }),
    observeBufferReportReceived({
      task_id: context.task_id,
      source_driver: input.source_driver,
      buffer_seq: input.buffer_seq,
      extraction_status: 'pending',
      ...(context.run_id ? { run_id: context.run_id } : {}),
    }),
    observeExtractionTriggered({
      task_id: context.task_id,
      trigger: 'immediate',
      pending_count: 1,
      ...(context.run_id ? { run_id: context.run_id } : {}),
    }),
    observeExtractionCompleted({
      task_id: context.task_id,
      extract_result: input.extract_result,
      batch_id: `${context.task_id}:${input.buffer_seq}`,
      ...(context.run_id ? { run_id: context.run_id } : {}),
    }),
    observeAgentMetricsUpdated({
      role_id: context.role_id,
      skill_count: input.skills_after.length,
      experience_count: input.experience_count,
      persona_version: input.persona.version,
      token_cost_total:
        typeof context.token_cost_total === 'number'
          ? context.token_cost_total
          : activeLedgerTokenCostTotal(),
    }),
  ];

  if (input.promotion.skill) {
    emissions.push(
      observeSkillPromoted({
        task_id: context.task_id,
        experience_id: input.promotion.skill.promoted_from ?? input.promotion.skill.id,
        skill_id: input.promotion.skill.id,
        review_status: input.promotion.skill.review_status,
        ...(context.run_id ? { run_id: context.run_id } : {}),
      }),
    );
  }

  return emissions;
}

export async function recordMemoryCycleTelemetry(
  sink: TelemetrySink,
  input: Parameters<typeof collectMemoryCycleTelemetry>[0],
): Promise<void> {
  await emitTelemetryBatch(sink, collectMemoryCycleTelemetry(input));
}
