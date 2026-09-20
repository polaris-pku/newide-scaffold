import { describe, expect, it } from 'vitest';
import {
  getActiveMemoryAblationPolicy,
  resolveMemoryAblationPolicy,
  runWithMemoryAblationPolicy,
} from '../ablation-policy';

describe('resolveMemoryAblationPolicy', () => {
  it('maps B0–B4 and default compatibility', () => {
    expect(resolveMemoryAblationPolicy('B0')).toEqual({
      include_skills: false,
      include_recent_experience: false,
      schedule_extraction: false,
      promote_skills: false,
    });
    expect(resolveMemoryAblationPolicy('B1')).toEqual({
      include_skills: false,
      include_recent_experience: true,
      schedule_extraction: true,
      promote_skills: false,
    });
    expect(resolveMemoryAblationPolicy('B2')).toEqual({
      include_skills: true,
      include_recent_experience: true,
      schedule_extraction: true,
      promote_skills: true,
    });
    expect(resolveMemoryAblationPolicy('B3')).toEqual(resolveMemoryAblationPolicy('B2'));
    expect(resolveMemoryAblationPolicy('B4')).toEqual({
      include_skills: true,
      include_recent_experience: true,
      schedule_extraction: false,
      promote_skills: false,
    });
    expect(resolveMemoryAblationPolicy(undefined)).toEqual({
      include_skills: true,
      include_recent_experience: true,
      schedule_extraction: true,
      promote_skills: false,
    });
  });

  it('keeps B4 as the read-only variant of B2', () => {
    const b2 = resolveMemoryAblationPolicy('B2');
    const b4 = resolveMemoryAblationPolicy('B4');
    // Same read surface as production ...
    expect(b4.include_skills).toBe(b2.include_skills);
    expect(b4.include_recent_experience).toBe(b2.include_recent_experience);
    // ... with nothing written back, so a run cannot change the next run's inputs.
    expect(b4.schedule_extraction).toBe(false);
    expect(b4.promote_skills).toBe(false);
  });

  it('propagates active policy through AsyncLocalStorage', async () => {
    const policy = resolveMemoryAblationPolicy('B0');
    await runWithMemoryAblationPolicy(policy, async () => {
      expect(getActiveMemoryAblationPolicy()).toEqual(policy);
    });
    expect(getActiveMemoryAblationPolicy()).toBeUndefined();
  });
});
