/**
 * adp-retry-policy — 部署级 auto_retry[side_effect] 重试策略(A1 / issue #149)。
 *
 * 职责与核心逻辑:
 * - 重试决策只看部署配置 `auto_retry[side_effect]`(`.env.example` 的
 *   NEWIDE_ADP_AUTO_RETRY_*),按 side_effect 三档映射;
 * - `unknown` 永不自动重跑(断连/超时且副作用不明,先对账)、`cancelled` /
 *   `succeeded` 也不重跑;只有 `failed`(确定失败)才查配置;
 * - `error.retryable` 仅是提示字段,绝不参与重试决策;
 * - 部署配置只在宿主内生效,任何协议帧不得携带 auto_retry(P0 schema .strict() 拒收)。
 */
import { ADP_SIDE_EFFECTS, type AdpSideEffect, type AdpStatus } from '../core';

export type AdpAutoRetryConfig = Record<AdpSideEffect, boolean>;

export interface AdpRetryPolicy {
  readonly autoRetry: Readonly<AdpAutoRetryConfig>;
  /** 唯一的重试判定点:unknown 恒 false,failed 才看 auto_retry[side_effect]。 */
  shouldAutoRetry(status: AdpStatus, sideEffect: AdpSideEffect): boolean;
}

const ENV_KEYS: Record<AdpSideEffect, string> = {
  read_only: 'NEWIDE_ADP_AUTO_RETRY_READ_ONLY',
  workspace_write: 'NEWIDE_ADP_AUTO_RETRY_WORKSPACE_WRITE',
  external: 'NEWIDE_ADP_AUTO_RETRY_EXTERNAL',
};

/** 部署配置读取:仅接受明确的 true/1/yes,其余一律 false(保守缺省)。 */
export function readAutoRetryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AdpAutoRetryConfig {
  const config = {} as AdpAutoRetryConfig;
  for (const sideEffect of ADP_SIDE_EFFECTS) {
    config[sideEffect] = isTruthy(env[ENV_KEYS[sideEffect]]);
  }
  return config;
}

export function createAdpRetryPolicy(
  overrides: Partial<AdpAutoRetryConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): AdpRetryPolicy {
  const autoRetry: AdpAutoRetryConfig = { ...readAutoRetryFromEnv(env), ...overrides };
  return Object.freeze({
    autoRetry: Object.freeze(autoRetry),
    shouldAutoRetry(status: AdpStatus, sideEffect: AdpSideEffect): boolean {
      // unknown 永不自动重跑是协议语义,不是配置项;配置也压不过它。
      if (status !== 'failed') return false;
      return autoRetry[sideEffect] === true;
    },
  });
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
