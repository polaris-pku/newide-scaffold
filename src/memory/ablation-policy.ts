/**
 * RFC §1.2 memory ablation policy (B0–B4).
 *
 * Tags alone do not change behavior; callers must apply this policy at
 * retrieval and maintenance choke points. B3 currently matches B2
 * (dynamic persona update is out of scope until a Persona write API exists).
 *
 * B4 is the accumulation-frozen counterpart of B2: retrieval stays at the
 * production setting, but nothing new is written back. Use it when an
 * experiment needs a stable memory read surface — every run sees the seeded
 * skills and whatever experiences already exist, and no run adds more.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type MemoryAblation = 'B0' | 'B1' | 'B2' | 'B3' | 'B4';

export interface MemoryAblationPolicy {
  include_skills: boolean;
  include_recent_experience: boolean;
  schedule_extraction: boolean;
  promote_skills: boolean;
}

const DEFAULT_POLICY: MemoryAblationPolicy = {
  include_skills: true,
  include_recent_experience: true,
  schedule_extraction: true,
  promote_skills: false,
};

const memoryAblationStorage = new AsyncLocalStorage<MemoryAblationPolicy>();

export function resolveMemoryAblationPolicy(
  ablation?: MemoryAblation,
): MemoryAblationPolicy {
  if (ablation === 'B0') {
    return {
      include_skills: false,
      include_recent_experience: false,
      schedule_extraction: false,
      promote_skills: false,
    };
  }
  if (ablation === 'B1') {
    return {
      include_skills: false,
      include_recent_experience: true,
      schedule_extraction: true,
      promote_skills: false,
    };
  }
  if (ablation === 'B2' || ablation === 'B3') {
    return {
      include_skills: true,
      include_recent_experience: true,
      schedule_extraction: true,
      promote_skills: true,
    };
  }
  if (ablation === 'B4') {
    return {
      include_skills: true,
      include_recent_experience: true,
      schedule_extraction: false,
      promote_skills: false,
    };
  }
  return { ...DEFAULT_POLICY };
}

export function runWithMemoryAblationPolicy<T>(
  policy: MemoryAblationPolicy,
  fn: () => T,
): T {
  return memoryAblationStorage.run(policy, fn);
}

export function getActiveMemoryAblationPolicy(): MemoryAblationPolicy | undefined {
  return memoryAblationStorage.getStore();
}
