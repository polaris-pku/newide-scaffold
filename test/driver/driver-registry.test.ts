/**
 * Driver 注册表的测试（driver 可配置化 / 装配层）。
 *
 * 重点钉住两件事：
 * - **装配等价性**：零配置下产出的唯一 driver 必须与历史写死的 `acp-external` 逐字段
 *   一致（command / args / cwd / ACP_AGENT_ID），否则这一步就不是零行为变更；
 * - **构造期失败要可归因**：入口缺失、runner 目录缺失、凭据键不齐都必须在
 *   `createDriverRegistry` 里就抛，且报错点名具体 driver 与具体键名——不能拖到
 *   `execute_agent` 阶段只留下一个非零退出码。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDriverRegistry,
  loadDriverConfig,
  parseDriverConfig,
  type CommandDriverTransportOptions,
  type DriverConfig,
  type DriverRegistryOptions,
  type ExternalDriverTransport,
} from '../../src/driver';

const tempDirs: string[] = [];
const ENTRY_RELATIVE = path.join('dist', 'src', 'driver', 'contract-runner.js');

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'newide-driver-registry-'));
  tempDirs.push(dir);
  return dir;
}

/** 造一个「看起来像」已构建的 A 侧 runner 目录。 */
function makeRunnerDir(withEntry = true): string {
  const dir = makeTempDir();
  const entry = path.join(dir, ENTRY_RELATIVE);
  mkdirSync(path.dirname(entry), { recursive: true });
  if (withEntry) writeFileSync(entry, '// stub runner\n', 'utf-8');
  return dir;
}

interface Captured {
  transports: CommandDriverTransportOptions[];
  shutDown: number;
}

function buildRegistry(
  config: DriverConfig,
  runnerDir: string,
  overrides: Partial<DriverRegistryOptions> = {},
): { registry: ReturnType<typeof createDriverRegistry>; captured: Captured } {
  const captured: Captured = { transports: [], shutDown: 0 };
  const registry = createDriverRegistry({
    config,
    runnerDir,
    defaultEntryRelative: ENTRY_RELATIVE,
    baseEnv: { ACP_WORKSPACE: '/ws' },
    parentEnv: {},
    createTransport: (options) => {
      captured.transports.push(options);
      const transport: ExternalDriverTransport = {
        invoke: () => Promise.reject(new Error('transport not exercised in this test')),
        shutdown: () => {
          captured.shutDown += 1;
          return Promise.resolve();
        },
      };
      return transport;
    },
    ...overrides,
  });
  return { registry, captured };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('assembly equivalence with the legacy single driver', () => {
  it('produces one acp-external driver matching the historical spawn shape', () => {
    const runnerDir = makeRunnerDir();
    const config = loadDriverConfig({
      projectRoot: makeTempDir(),
      homeDir: makeTempDir(),
      env: {},
    });
    const { registry, captured } = buildRegistry(config, runnerDir);

    expect(registry.listDriverIds()).toEqual(['acp-external']);
    expect(registry.default_driver).toBe('acp-external');
    expect(captured.transports).toHaveLength(1);
    expect(captured.transports[0]).toMatchObject({
      command: process.execPath,
      args: [path.join(path.resolve(runnerDir), ENTRY_RELATIVE)],
      cwd: path.resolve(runnerDir),
    });
    expect(captured.transports[0]?.env?.ACP_AGENT_ID).toBe('claude');
    expect(captured.transports[0]?.env?.ACP_WORKSPACE).toBe('/ws');
  });

  it('keeps ACP_AGENT_ID selecting the legacy agent', () => {
    const config = loadDriverConfig({
      projectRoot: makeTempDir(),
      homeDir: makeTempDir(),
      env: { ACP_AGENT_ID: 'codex' },
    });
    const { captured } = buildRegistry(config, makeRunnerDir());

    expect(captured.transports[0]?.env?.ACP_AGENT_ID).toBe('codex');
  });
});

describe('per-driver assembly', () => {
  const twoDrivers = parseDriverConfig({
    default_driver: 'claude',
    drivers: {
      claude: { agent: 'claude' },
      codex: { agent: 'codex' },
    },
    roles: { reviewer: 'codex' },
  });

  it('spawns each profile with its own ACP_AGENT_ID', () => {
    const { registry, captured } = buildRegistry(twoDrivers, makeRunnerDir());

    expect(registry.listDriverIds().sort()).toEqual(['claude', 'codex']);
    expect(captured.transports.map((options) => options.env?.ACP_AGENT_ID)).toEqual([
      'claude',
      'codex',
    ]);
  });

  it('lets runtime.env add variables but never override the declared agent', () => {
    const config = parseDriverConfig({
      default_driver: 'claude',
      drivers: {
        claude: {
          agent: 'claude',
          runtime: { env: { ANTHROPIC_BASE_URL: 'https://x.example', ACP_AGENT_ID: 'evil' } },
        },
      },
    });
    const { captured } = buildRegistry(config, makeRunnerDir());

    expect(captured.transports[0]?.env?.ANTHROPIC_BASE_URL).toBe('https://x.example');
    // 声明身份恒赢：不让 runtime.env 把它悄悄改掉
    expect(captured.transports[0]?.env?.ACP_AGENT_ID).toBe('claude');
  });

  it('honours a per-profile runner_dir override', () => {
    const otherRunner = makeRunnerDir();
    const config = parseDriverConfig({
      default_driver: 'claude',
      drivers: {
        claude: { agent: 'claude' },
        codex: { agent: 'codex', runtime: { runner_dir: otherRunner } },
      },
    });
    const { captured } = buildRegistry(config, makeRunnerDir());

    expect(captured.transports[1]?.cwd).toBe(path.resolve(otherRunner));
    expect(captured.transports[1]?.args).toEqual([
      path.join(path.resolve(otherRunner), ENTRY_RELATIVE),
    ]);
  });

  it('merges profile capabilities over the deployment defaults', () => {
    const config = parseDriverConfig({
      default_driver: 'claude',
      drivers: {
        claude: { agent: 'claude', capabilities: { supports_session_load: false } },
      },
    });
    const { registry } = buildRegistry(config, makeRunnerDir(), {
      defaultCapabilities: { supports_acp_extension: true, supports_session_load: true },
    });

    // 未被档案声明的键缺席，由 ExternalDriverRuntime 的 DEFAULT_CAPABILITIES 补齐
    expect(registry.get('claude').capabilities).toEqual({
      supports_acp_extension: true,
      supports_structured_output: true,
      supports_session_load: false,
      supports_tool_events: false,
      supports_permission_events: false,
    });
  });

  it('resolves a role through its mapping and falls back to default_driver', () => {
    const { registry } = buildRegistry(twoDrivers, makeRunnerDir());

    expect(registry.resolveForRole('reviewer')).toMatchObject({ driver_id: 'codex' });
    expect(registry.resolveForRole('proposer').driver_id).toBe('claude');
    expect(registry.resolveForRole('reviewer').handle).toBe(registry.get('codex'));
    expect(() => registry.get('ghost')).toThrow(/has no runtime handle/);
  });

  it('shuts down every driver transport', async () => {
    const { registry, captured } = buildRegistry(twoDrivers, makeRunnerDir());

    await registry.shutdown();

    expect(captured.shutDown).toBe(2);
  });
});

describe('construct-time failures are attributable', () => {
  const codexOnly = parseDriverConfig({
    default_driver: 'codex',
    drivers: { codex: { agent: 'codex' } },
  });

  it('fails when the runner entry is missing', () => {
    expect(() => buildRegistry(codexOnly, makeRunnerDir(false))).toThrow(/runner entry missing/);
  });

  it('fails when the runner directory does not exist', () => {
    expect(() => buildRegistry(codexOnly, path.join(makeTempDir(), 'absent'))).toThrow(
      /runner directory not found/,
    );
  });

  it('names the missing credential key instead of a generic "not ready"', () => {
    const config = parseDriverConfig({
      default_driver: 'codex',
      drivers: { codex: { agent: 'codex', credentials: { env: ['OPENAI_API_KEY'] } } },
    });

    expect(() => buildRegistry(config, makeRunnerDir())).toThrow(/OPENAI_API_KEY/);
    expect(() => buildRegistry(config, makeRunnerDir())).toThrow(/Driver "codex"/);
  });

  it('accepts credentials supplied by baseEnv or the parent process env', () => {
    const config = parseDriverConfig({
      default_driver: 'codex',
      drivers: { codex: { agent: 'codex', credentials: { env: ['OPENAI_API_KEY'] } } },
    });

    expect(() =>
      buildRegistry(config, makeRunnerDir(), { baseEnv: { OPENAI_API_KEY: 'sk-x' } }),
    ).not.toThrow();
    expect(() =>
      buildRegistry(config, makeRunnerDir(), { parentEnv: { OPENAI_API_KEY: 'sk-y' } }),
    ).not.toThrow();
  });

  it('treats a blank credential as missing', () => {
    const config = parseDriverConfig({
      default_driver: 'codex',
      drivers: { codex: { agent: 'codex', credentials: { env: ['OPENAI_API_KEY'] } } },
    });

    expect(() =>
      buildRegistry(config, makeRunnerDir(), { baseEnv: { OPENAI_API_KEY: '   ' } }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it('reports every missing key at once', () => {
    const config = parseDriverConfig({
      default_driver: 'codex',
      drivers: {
        codex: { agent: 'codex', credentials: { env: ['OPENAI_API_KEY', 'CODEX_API_KEY'] } },
      },
    });

    const spy = vi.fn();
    try {
      buildRegistry(config, makeRunnerDir());
    } catch (error) {
      spy(error);
    }
    const message = String(spy.mock.calls[0]?.[0]);
    expect(message).toContain('OPENAI_API_KEY');
    expect(message).toContain('CODEX_API_KEY');
  });
});
