import { describe, expect, it } from 'vitest';
import {
  getActiveMemoryAblationPolicy,
  resolveMemoryAblationPolicy,
  runWithMemoryAblationPolicy,
} from '../ablation-policy';

describe('resolveMemoryAblationPolicy', () => {
  it('maps B0–B3 and default compatibility', () => {
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
    expect(resolveMemoryAblationPolicy(undefined)).toEqual({
      include_skills: true,
      include_recent_experience: true,
      schedule_extraction: true,
      promote_skills: false,
    });
  });

  it('propagates active policy through AsyncLocalStorage', async () => {
    const policy = resolveMemoryAblationPolicy('B0');
    await runWithMemoryAblationPolicy(policy, async () => {
      expect(getActiveMemoryAblationPolicy()).toEqual(policy);
    });
    expect(getActiveMemoryAblationPolicy()).toBeUndefined();
  });
});
