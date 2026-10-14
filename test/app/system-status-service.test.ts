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
  systemStatusDriverStatus,
} from '../../src/app/system-status-service';
import type {
  SystemStatusDriverProfile,
  SystemStatusDriverStatus,
} from '../../src/app/system-status-service';

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

/**
 * 动态 driver 状态（来自 driver catalog 投影）。
 *
 * 与上面的静态 `driver_profiles` 相比，这里的两条要求是新的：
 * - **同一份投影**：`system.capabilities` 里的 driver 必须与 `driver.getConfig` 说同一件事，
 *   所以提供者是**函数**——每次查询重新取值，探测刷新后新增的 driver 立刻可见；
 * - **不可选择要说清为什么**：组件与能力条目都带具体原因码，前端不必猜「是还没探测到，
 *   还是 runtime 起不来」。
 */
describe('dynamic driver status', () => {
  function buildWithProvider(driverStatus: () => readonly SystemStatusDriverStatus[]) {
    return createProductionSystemStatusService({
      package_name: 'newide-bcd',
      package_version: '0.1.0',
      build_commit: 'test-commit',
      coordination_durable: true,
      driver_provider_id: 'acp-external-runner',
      driver_provider_version: '1.0.0',
      driver_status: driverStatus,
      b_repository_mode: 'postgresql',
      b_embedding: { provider: 'HashEmbeddingProvider', readiness: 'ready' },
    });
  }

  const readyDiscovered: SystemStatusDriverStatus = systemStatusDriverStatus({
    driver_id: 'discovered:gemini-8a12f40e',
    agent: 'gemini',
    source: 'discovered',
    selectable: true,
    status: 'degraded',
    reason_code: 'AGENT_CLI_READINESS_NOT_VERIFIABLE',
    probe_verified: true,
    display_name: 'Gemini CLI',
    limitations: ['driver "discovered:gemini-8a12f40e"（agent: gemini）: ACP 探测通过'],
  });

  it('projects one component per driver and names the reason a driver is unusable', () => {
    const service = buildWithProvider(() => [
      readyDiscovered,
      systemStatusDriverStatus({
        driver_id: 'discovered:codex-11111111',
        agent: 'codex',
        source: 'discovered',
        selectable: false,
        status: 'unavailable',
        reason_code: 'DRIVER_DISCOVERY_STALE',
      }),
    ]);

    const components = service.readiness().components.filter((item) =>
      item.component_id.startsWith('driver:'),
    );

    expect(components).toEqual([
      {
        component_id: 'driver:discovered:codex-11111111',
        status: 'unavailable',
        provider: { provider_id: 'codex', mode: 'acp-probed' },
        reason_code: 'DRIVER_DISCOVERY_STALE',
      },
      {
        component_id: 'driver:discovered:gemini-8a12f40e',
        status: 'degraded',
        provider: { provider_id: 'gemini', mode: 'acp-probed' },
        reason_code: 'AGENT_CLI_READINESS_NOT_VERIFIABLE',
      },
    ]);
  });

  it('does not repeat the "CLI not verified" line for a driver the probe reached', () => {
    const service = buildWithProvider(() => [readyDiscovered]);

    const limitations = service
      .capabilities()
      .capabilities.find((item) => item.capability_id === 'driver.execute')?.limitations;

    expect(limitations).toContain('driver "discovered:gemini-8a12f40e"（agent: gemini）: ACP 探测通过');
    expect(limitations?.some((line) => line.includes(DRIVER_CONFIGURED_CLI_UNVERIFIED))).toBe(false);
  });

  it('explains an unusable driver in the capability text too', () => {
    const service = buildWithProvider(() => [
      systemStatusDriverStatus({
        driver_id: 'discovered:codex-11111111',
        agent: 'codex',
        source: 'discovered',
        selectable: false,
        status: 'unavailable',
        reason_code: 'DRIVER_CONNECTION_TYPE_UNSUPPORTED',
      }),
    ]);

    const limitations = service
      .capabilities()
      .capabilities.find((item) => item.capability_id === 'driver.execute')?.limitations;

    expect(limitations).toContain(
      'driver "discovered:codex-11111111"（agent: codex）: 当前不可选择（DRIVER_CONNECTION_TYPE_UNSUPPORTED）',
    );
  });

  it('re-reads the driver catalog on every call', () => {
    let drivers: readonly SystemStatusDriverStatus[] = [];
    const service = buildWithProvider(() => drivers);

    expect(
      service.readiness().components.filter((item) => item.component_id.startsWith('driver:')),
    ).toEqual([]);
    expect(
      service.capabilities().capabilities.find((item) => item.capability_id === 'driver.execute')
        ?.limitations,
    ).toBeUndefined();

    // 一次刷新之后（探测到了新 driver），能力里必须立刻出现它
    drivers = [readyDiscovered];

    expect(
      service.readiness().components.filter((item) => item.component_id.startsWith('driver:')),
    ).toHaveLength(1);
    expect(
      service.capabilities().capabilities.find((item) => item.capability_id === 'driver.execute')
        ?.limitations,
    ).toHaveLength(1);
  });
});
