/**
 * Driver 档案配置模型与分层加载的测试（driver 可配置化 / A1）。
 *
 * 覆盖三件事：
 * - **零配置等价性**：没有任何配置文件时，解析结果必须等价于今天写死的
 *   `acp-external` + `ACP_AGENT_ID ?? 'claude'`，否则这一步就不是零行为变更；
 * - **分层语义**：项目级赢用户级、同 id 整档案替换、roles 逐 key 覆盖；
 * - **悬空引用**：`default_driver` 或 `roles` 指向未定义的 driver 必须报错并给出候选。
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_ID,
  DriverConfigError,
  LEGACY_DRIVER_ID,
  loadDriverConfig,
  mergeDriverConfigLayers,
  parseDriverConfig,
  parseDriverConfigLayer,
  projectDriverConfigForRun,
  resolveRoleDriver,
  type DriverConfig,
} from '../../src/driver';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'newide-driver-profile-'));
  tempDirs.push(dir);
  return dir;
}

/** 在 `<dir>/<name>` 写一个 YAML 文件并返回其绝对路径。 */
function writeYaml(dir: string, name: string, content: string): string {
  const filePath = join(dir, name);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('zero-config equivalence', () => {
  it('falls back to the legacy acp-external profile without any layer', () => {
    const config = loadDriverConfig({ projectRoot: makeTempDir(), homeDir: makeTempDir(), env: {} });

    expect(config.default_driver).toBe(LEGACY_DRIVER_ID);
    expect(Object.keys(config.drivers)).toEqual([LEGACY_DRIVER_ID]);
    expect(config.drivers[LEGACY_DRIVER_ID]?.agent).toBe(DEFAULT_AGENT_ID);
    expect(config.roles).toBeUndefined();
  });

  it('keeps ACP_AGENT_ID selecting the legacy profile agent', () => {
    const config = loadDriverConfig({
      projectRoot: makeTempDir(),
      homeDir: makeTempDir(),
      env: { ACP_AGENT_ID: 'codex' },
    });

    expect(config.drivers[LEGACY_DRIVER_ID]?.agent).toBe('codex');
  });

  it('reports an error when NEWIDE_DRIVER names an undefined driver', () => {
    expect(() =>
      loadDriverConfig({
        projectRoot: makeTempDir(),
        homeDir: makeTempDir(),
        env: { NEWIDE_DRIVER: 'nope' },
      }),
    ).toThrow(DriverConfigError);
  });
});

describe('layered loading', () => {
  it('lets the project layer win over the user layer for the same driver id', () => {
    const userHome = makeTempDir();
    const projectRoot = makeTempDir();
    writeYaml(userHome, join('.agent', 'drivers.yaml'), [
      'default_driver: claude',
      'drivers:',
      '  claude:',
      '    agent: claude',
      '    runtime:',
      '      env:',
      '        ANTHROPIC_BASE_URL: https://user.example',
      '  codex:',
      '    agent: codex',
    ].join('\n'));
    writeYaml(projectRoot, join('.agent', 'drivers.yaml'), [
      'default_driver: codex',
      'drivers:',
      '  claude:',
      '    agent: claude',
      '    runtime:',
      '      env:',
      '        ANTHROPIC_BASE_URL: https://project.example',
    ].join('\n'));

    const config = loadDriverConfig({ projectRoot, homeDir: userHome, env: {} });

    // 项目层的 default_driver 赢
    expect(config.default_driver).toBe('codex');
    // 用户层加的 codex 档案仍在（drivers 是并集）
    expect(config.drivers['codex']?.agent).toBe('codex');
    // 同 id 整档案替换：拿到的是项目层的 env，而不是两层混合
    expect(config.drivers['claude']?.runtime?.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://project.example',
    });
  });

  it('reads roles from a layer and resolves them', () => {
    const projectRoot = makeTempDir();
    writeYaml(projectRoot, join('.agent', 'drivers.yaml'), [
      'default_driver: claude',
      'drivers:',
      '  claude:',
      '    agent: claude',
      '  codex:',
      '    agent: codex',
      '    credentials:',
      '      env: [OPENAI_API_KEY]',
      'roles:',
      '  reviewer: codex',
    ].join('\n'));

    const config = loadDriverConfig({ projectRoot, homeDir: makeTempDir(), env: {} });

    expect(resolveRoleDriver(config, 'reviewer')).toEqual({
      driver_id: 'codex',
      profile: { agent: 'codex', credentials: { env: ['OPENAI_API_KEY'] } },
    });
    // 未映射的 role 落到 default_driver
    expect(resolveRoleDriver(config, 'proposer').driver_id).toBe('claude');
  });

  it('names the offending file when a layer is structurally invalid', () => {
    const projectRoot = makeTempDir();
    const filePath = writeYaml(projectRoot, join('.agent', 'drivers.yaml'), [
      'default_driver: claude',
      'drivers:',
      '  claude:',
      '    agent: claude',
      '    typo_field: 1',
    ].join('\n'));

    expect(() => loadDriverConfig({ projectRoot, homeDir: makeTempDir(), env: {} })).toThrow(
      new RegExp(filePath.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')),
    );
  });

  it('skips missing layers silently', () => {
    const config = loadDriverConfig({
      projectRoot: makeTempDir(),
      homeDir: makeTempDir(),
      env: { NEWIDE_DRIVER: LEGACY_DRIVER_ID },
    });

    expect(config.default_driver).toBe(LEGACY_DRIVER_ID);
  });
});

describe('config validation', () => {
  it('rejects a default_driver that is not defined', () => {
    expect(() =>
      parseDriverConfig({ default_driver: 'ghost', drivers: { claude: { agent: 'claude' } } }),
    ).toThrow(/default_driver "ghost" is not defined/);
  });

  it('rejects a role mapped to an undefined driver and lists candidates', () => {
    let error: DriverConfigError | undefined;
    try {
      parseDriverConfig({
        default_driver: 'claude',
        drivers: { claude: { agent: 'claude' } },
        roles: { reviewer: 'ghost' },
      });
    } catch (cause) {
      error = cause as DriverConfigError;
    }

    expect(error).toBeInstanceOf(DriverConfigError);
    expect(error?.errors[0]).toContain('roles.reviewer');
    expect(error?.errors[0]).toContain('Defined: [claude]');
  });

  it('rejects unknown keys instead of silently ignoring them', () => {
    expect(() =>
      parseDriverConfig({
        default_driver: 'claude',
        drivers: { claude: { agent: 'claude', surprise: true } },
      }),
    ).toThrow(/surprise/);
  });

  it('accepts a partial layer that omits default_driver', () => {
    const layer = parseDriverConfigLayer({ drivers: { claude: { agent: 'claude' } } });
    expect(layer.default_driver).toBeUndefined();
    expect(layer.drivers?.['claude']?.agent).toBe('claude');
  });
});

describe('mergeDriverConfigLayers', () => {
  it('overrides default_driver and unions drivers and roles', () => {
    const base = parseDriverConfigLayer({
      default_driver: 'claude',
      drivers: { claude: { agent: 'claude' } },
      roles: { reviewer: 'claude' },
    });
    const override = parseDriverConfigLayer({
      drivers: { codex: { agent: 'codex' } },
      roles: { reviewer: 'codex', proposer: 'codex' },
    });

    const merged = mergeDriverConfigLayers(base, override);

    expect(merged.default_driver).toBe('claude');
    expect(Object.keys(merged.drivers ?? {}).sort()).toEqual(['claude', 'codex']);
    expect(merged.roles).toEqual({ reviewer: 'codex', proposer: 'codex' });
  });

  it('produces a config whose resolved profile is the injected one', () => {
    const config: DriverConfig = parseDriverConfig({
      default_driver: 'codex',
      drivers: { codex: { agent: 'codex', capabilities: { supports_tool_events: true } } },
      roles: { reviewer: 'codex' },
    });

    expect(resolveRoleDriver(config, 'any-role').profile.capabilities).toEqual({
      supports_tool_events: true,
    });
  });
});

describe('projectDriverConfigForRun', () => {
  it('keeps only the auditable shape, not the whole profile', () => {
    const config = parseDriverConfig({
      default_driver: 'claude',
      drivers: {
        claude: { agent: 'claude', runtime: { env: { ANTHROPIC_BASE_URL: 'https://x.example' } } },
        codex: { agent: 'codex', credentials: { env: ['OPENAI_API_KEY'] } },
      },
      roles: { reviewer: 'codex' },
    });

    expect(projectDriverConfigForRun(config)).toEqual({
      default_driver: 'claude',
      drivers: { claude: 'claude', codex: 'codex' },
      roles: { reviewer: 'codex' },
    });
  });

  it('omits roles when the config has none', () => {
    const config = parseDriverConfig({
      default_driver: 'claude',
      drivers: { claude: { agent: 'claude' } },
    });

    expect(projectDriverConfigForRun(config)).toEqual({
      default_driver: 'claude',
      drivers: { claude: 'claude' },
    });
  });
});

/**
 * 随仓库发布的示例配置（`.agent/drivers.example.yaml`）是这份 schema 的活文档。
 *
 * 这两条的作用不同：第一条让示例**不能悄悄过期**（档案字段增删会先在这里红），
 * 第二条钉住它**不会被当成生效配置加载**——否则照抄示例就会在用户没打算的时候
 * 把部署切成多 driver。
 */
describe('shipped example config', () => {
  const examplePath = join(process.cwd(), '.agent', 'drivers.example.yaml');

  it('stays a valid, complete driver config', () => {
    const config = parseDriverConfig(
      parseYaml(readFileSync(examplePath, 'utf-8')),
      examplePath,
    );

    expect(config.default_driver).toBe('claude');
    expect(Object.keys(config.drivers).sort()).toEqual(['claude', 'codex']);
    expect(resolveRoleDriver(config, 'reviewer').driver_id).toBe('codex');
    expect(resolveRoleDriver(config, 'proposer').driver_id).toBe('claude');
    // 示例必须示范到字段粒度：删掉这里任何一个字段，都应先在测试里红。
    expect(config.drivers['codex']?.billing?.source).toBe('codex_jsonl');
    expect(config.drivers['claude']?.credentials?.env).toEqual(['ANTHROPIC_API_KEY']);
    expect(config.drivers['codex']?.limitations?.length).toBeGreaterThan(0);
  });

  it('is not picked up as a live config', () => {
    const projectRoot = makeTempDir();
    mkdirSync(join(projectRoot, '.agent'), { recursive: true });
    copyFileSync(examplePath, join(projectRoot, '.agent', 'drivers.example.yaml'));

    const config = loadDriverConfig({ projectRoot, homeDir: makeTempDir(), env: {} });

    expect(config.default_driver).toBe(LEGACY_DRIVER_ID);
    expect(Object.keys(config.drivers)).toEqual([LEGACY_DRIVER_ID]);
  });
});
