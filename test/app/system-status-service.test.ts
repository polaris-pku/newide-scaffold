/**
 * 已配置 driver 的对外暴露（driver 可配置化 / 能力声明）。
 *
 * 钉住两件事：
 * - **未配置时输出不变**：不传 `driver_profiles` 时 `driver.execute` 不带 `limitations`、
 *   也不冒出任何 `driver:*` 组件，历史消费方看到的东西逐字段一致；
 * - **诚实降级**：配置了 driver 之后，能力条目只能说「已配置且凭据齐备；agent CLI
 *   是否就绪未验证」，并且要**指名到具体 driver 与其 agent**，不能笼统说「未就绪」。
 */

import { describe, expect, it } from 'vitest';

import {
  DRIVER_CONFIGURED_CLI_UNVERIFIED,
  createProductionSystemStatusService,
} from '../../src/app/system-status-service';
import type { SystemStatusDriverProfile } from '../../src/app/system-status-service';

function build(driverProfiles?: readonly SystemStatusDriverProfile[]) {
  return createProductionSystemStatusService({
    package_name: 'newide-bcd',
    package_version: '0.1.0',
    build_commit: 'test-commit',
    coordination_durable: true,
    driver_provider_id: 'acp-external-runner',
    driver_provider_version: '1.0.0',
    ...(driverProfiles ? { driver_profiles: driverProfiles } : {}),
    b_repository_mode: 'postgresql',
    b_embedding: { provider: 'HashEmbeddingProvider', readiness: 'ready' },
  });
}

const claude: SystemStatusDriverProfile = { driver_id: 'acp-external', agent: 'claude' };
const codex: SystemStatusDriverProfile = {
  driver_id: 'codex',
  agent: 'codex',
  limitations: ['Codex adapter 不支持 permission 事件。'],
};

describe('unconfigured output stays as it was', () => {
  it('adds no limitations and no per-driver components', () => {
    const service = build();
    const capabilities = service.capabilities().capabilities;

    expect(capabilities.find((item) => item.capability_id === 'driver.execute')).toMatchObject({
      status: 'degraded',
      reason_code: 'DRIVER_HANDSHAKE_UNAVAILABLE',
    });
    expect(
      capabilities.find((item) => item.capability_id === 'driver.execute')?.limitations,
    ).toBeUndefined();

    const components = service.readiness().components;
    expect(components.filter((item) => item.component_id.startsWith('driver:'))).toEqual([]);
    expect(components.map((item) => item.component_id)).toContain('driver_provider');
  });
});

describe('configured drivers', () => {
  it('names each driver and its agent in the honest limitation', () => {
    const service = build([claude, codex]);
    const limitations = service
      .capabilities()
      .capabilities.find((item) => item.capability_id === 'driver.execute')?.limitations;

    expect(limitations).toContainEqual(
      `driver "acp-external"（agent: claude）: ${DRIVER_CONFIGURED_CLI_UNVERIFIED}`,
    );
    expect(limitations).toContainEqual(`driver "codex"（agent: codex）: ${DRIVER_CONFIGURED_CLI_UNVERIFIED}`);
    // 档案自报的限制也一并带出
    expect(limitations).toContain('Codex adapter 不支持 permission 事件。');
  });

  it('exposes one degraded component per configured driver', () => {
    const service = build([claude, codex]);
    const driverComponents = service
      .readiness()
      .components.filter((item) => item.component_id.startsWith('driver:'));

    expect(driverComponents).toEqual([
      {
        component_id: 'driver:acp-external',
        status: 'degraded',
        provider: { provider_id: 'claude', mode: 'configured-credentials-complete' },
        reason_code: 'AGENT_CLI_READINESS_NOT_VERIFIABLE',
      },
      {
        component_id: 'driver:codex',
        status: 'degraded',
        provider: { provider_id: 'codex', mode: 'configured-credentials-complete' },
        reason_code: 'AGENT_CLI_READINESS_NOT_VERIFIABLE',
      },
    ]);
  });

  it('never claims a driver is available, because the CLI cannot be verified here', () => {
    const service = build([claude, codex]);
    const driverComponents = service
      .readiness()
      .components.filter((item) => item.component_id.startsWith('driver:'));

    expect(driverComponents.every((item) => item.status === 'degraded')).toBe(true);
  });
});
