/**
 * PersonaTriggerPolicy 测试
 *
 * 验证 DefaultPersonaTriggerPolicy 三层门控（技能增长/定期/强制刷新）。
 */
import { describe, it, expect } from 'vitest';
import { DefaultPersonaTriggerPolicy } from '../adapters/default-persona-trigger-policy';

// ──────────────────────────────────────────────
// DefaultPersonaTriggerPolicy
// ──────────────────────────────────────────────

describe('DefaultPersonaTriggerPolicy', () => {
  const DAY = 24 * 60 * 60 * 1000;

  describe('技能增长门控', () => {
    it('skill_growth_count >= minSkillDelta (3) 时触发', () => {
      const policy = new DefaultPersonaTriggerPolicy(3, 7 * DAY, 30 * DAY);
      const result = policy.shouldEvolve({
        role_id: 'role_test',
        skill_growth_count: 3,
        new_experience_count: 0,
        last_induction_at: new Date(),
      });
      expect(result).toBe(true);
    });

    it('skill_growth_count < minSkillDelta 时不触发', () => {
      const policy = new DefaultPersonaTriggerPolicy(3, 7 * DAY, 30 * DAY);
      const result = policy.shouldEvolve({
        role_id: 'role_test',
        skill_growth_count: 2,
        new_experience_count: 0,
        last_induction_at: new Date(),
      });
      expect(result).toBe(false);
    });
  });

  describe('定期门控', () => {
    it('距上次归纳 >= periodicIntervalMs 且有新经验时触发', () => {
      const policy = new DefaultPersonaTriggerPolicy(3, 7 * DAY, 30 * DAY);
      const longAgo = new Date(Date.now() - 8 * DAY);
      const result = policy.shouldEvolve({
        role_id: 'role_test',
        skill_growth_count: 0,
        new_experience_count: 1,
        last_induction_at: longAgo,
      });
      expect(result).toBe(true);
    });

    it('距上次归纳 >= periodicIntervalMs 但无新经验时不触发', () => {
      const policy = new DefaultPersonaTriggerPolicy(3, 7 * DAY, 30 * DAY);
      const longAgo = new Date(Date.now() - 8 * DAY);
      const result = policy.shouldEvolve({
        role_id: 'role_test',
        skill_growth_count: 0,
        new_experience_count: 0,
        last_induction_at: longAgo,
      });
      expect(result).toBe(false);
    });

    it('距上次归纳 < periodicIntervalMs 时不触发', () => {
      const policy = new DefaultPersonaTriggerPolicy(3, 7 * DAY, 30 * DAY);
      const recent = new Date(Date.now() - DAY);
      const result = policy.shouldEvolve({
        role_id: 'role_test',
        skill_growth_count: 0,
        new_experience_count: 1,
        last_induction_at: recent,
      });
      expect(result).toBe(false);
    });
  });

  describe('强制刷新门控', () => {
    it('距上次归纳 >= forcedRefreshMs 时触发（即使无新数据）', () => {
      const policy = new DefaultPersonaTriggerPolicy(3, 7 * DAY, 30 * DAY);
      const veryLongAgo = new Date(Date.now() - 31 * DAY);
      const result = policy.shouldEvolve({
        role_id: 'role_test',
        skill_growth_count: 0,
        new_experience_count: 0,
        last_induction_at: veryLongAgo,
      });
      expect(result).toBe(true);
    });

    it('距上次归纳 < forcedRefreshMs 时不触发', () => {
      const policy = new DefaultPersonaTriggerPolicy(3, 7 * DAY, 30 * DAY);
      const recent = new Date(Date.now() - DAY);
      const result = policy.shouldEvolve({
        role_id: 'role_test',
        skill_growth_count: 0,
        new_experience_count: 0,
        last_induction_at: recent,
      });
      expect(result).toBe(false);
    });
  });

  describe('组合与边界', () => {
    it('从未归纳（last_induction_at=null）且无新技能时，即使新经验多也不触发', () => {
      const policy = new DefaultPersonaTriggerPolicy(3, 7 * DAY, 30 * DAY);
      const result = policy.shouldEvolve({
        role_id: 'role_test',
        skill_growth_count: 0,
        new_experience_count: 10,
        last_induction_at: null,
      });
      expect(result).toBe(false);
    });

    it('多个条件同时满足时仍只返回 true', () => {
      const policy = new DefaultPersonaTriggerPolicy(3, 7 * DAY, 30 * DAY);
      const veryLongAgo = new Date(Date.now() - 31 * DAY);
      const result = policy.shouldEvolve({
        role_id: 'role_test',
        skill_growth_count: 5,
        new_experience_count: 3,
        last_induction_at: veryLongAgo,
      });
      expect(result).toBe(true);
    });

    it('无任何条件满足时不触发', () => {
      const policy = new DefaultPersonaTriggerPolicy(3, 7 * DAY, 30 * DAY);
      const recent = new Date(Date.now() - DAY);
      const result = policy.shouldEvolve({
        role_id: 'role_test',
        skill_growth_count: 0,
        new_experience_count: 0,
        last_induction_at: recent,
      });
      expect(result).toBe(false);
    });
  });
});
