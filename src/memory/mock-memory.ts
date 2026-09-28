/**
 * MemoryProvider 的 MVP 实现
 *
 * 为演示与测试提供最小 ContextPack 装配，不读取真实 Persona/Experience/Skill。
 * 与 Agent 内部 memory-query 链路独立（分叉 B2）。
 */
import { SCHEMA_VERSION, createId, nowTimestamp } from '../core';
import type { BuildContextPackInput, ContextPack, MemoryProvider } from './contract';

export class MockMemoryProvider implements MemoryProvider {
  async buildContextPack(input: BuildContextPackInput): Promise<ContextPack> {
    return {
      context_pack_id: createId('context_pack'),
      task_id: input.task_id,
      role_profile_ref: input.role_profile_ref,
      memory_refs: input.memory_refs ?? [],
      artifact_refs: input.artifact_refs ?? [],
      summary: input.summary_hint ?? `Mock context for ${input.task_id}`,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }
}
