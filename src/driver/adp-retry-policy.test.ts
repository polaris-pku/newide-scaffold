/**
 * adp-retry-policy.test — 部署级 auto_retry[side_effect] 的单测(issue #149)。
 * 钉死 DoD 第 4 条:unknown 永不自动重跑;failed 的重试只看部署配置;
 * error.retryable 不参与决策;配置不进入帧(帧侧断言见 adp-driver-endpoint.test)。
 */
import { describe, expect, it } from 'vitest';
import { ADP_SIDE_EFFECTS } from '../core';
import { createAdpRetryPolicy, readAutoRetryFromEnv } from './adp-retry-policy';

describe('createAdpRetryPolicy', () => {
  it('unknown / cancelled / succeeded 恒不重试,即使该档配置为 true', () => {
    const policy = createAdpRetryPolicy({
      read_only: true,
      workspace_write: true,
      external: true,
    });
    for (const sideEffect of ADP_SIDE_EFFECTS) {
      expect(policy.shouldAutoRetry('unknown', sideEffect)).toBe(false);
      expect(policy.shouldAutoRetry('cancelled', sideEffect)).toBe(false);
      expect(policy.shouldAutoRetry('succeeded', sideEffect)).toBe(false);
    }
  });

  it('failed 的重试只看 auto_retry[side_effect],按档位区分', () => {
    const policy = createAdpRetryPolicy({ workspace_write: true });
    expect(policy.shouldAutoRetry('failed', 'workspace_write')).toBe(true);
    expect(policy.shouldAutoRetry('failed', 'read_only')).toBe(false);
    expect(policy.shouldAutoRetry('failed', 'external')).toBe(false);
  });

  it('缺省保守:未配置的档位一律不重试', () => {
    const policy = createAdpRetryPolicy({}, {});
    for (const sideEffect of ADP_SIDE_EFFECTS) {
      expect(policy.shouldAutoRetry('failed', sideEffect)).toBe(false);
    }
  });
});

describe('readAutoRetryFromEnv', () => {
  it('仅接受明确的 true/1/yes/on', () => {
    const config = readAutoRetryFromEnv({
      NEWIDE_ADP_AUTO_RETRY_READ_ONLY: 'true',
      NEWIDE_ADP_AUTO_RETRY_WORKSPACE_WRITE: '1',
      NEWIDE_ADP_AUTO_RETRY_EXTERNAL: 'no',
    });
    expect(config).toEqual({ read_only: true, workspace_write: true, external: false });
  });
});
