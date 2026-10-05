/**
 * Driver 注册表（driver 可配置化 / 装配层）。
 *
 * 职责与核心逻辑：
 * - 把一份 {@link DriverConfig} 变成「driver_id → 可直接调用的 DriverRuntimeHandle」映射：
 *   每个档案各建一个 `ExternalDriverRuntime` + `CommandDriverTransport`。进程仍是**每次
 *   调用一次性**（transport 在 `execute` 里 spawn），所以多 driver 不需要常驻多进程；
 * - 把「配置写错了」提前成**启动失败**，而不是跑到 `execute_agent` 才炸：入口文件缺失、
 *   runner 目录缺失、凭据键不齐（报**具体键名**）都在构造期抛；
 * - 下发给子进程的 `ACP_AGENT_ID` 由档案的 `agent` 决定，且**档案的 agent 恒赢**——
 *   不让 `runtime.env` 里的同名键和声明身份悄悄分叉；
 * - 零配置时只产出一个 `acp-external`，与历史装配逐字段一致：这一步不改变运行时行为
 *   （真正按 role 生效在 facade 改成按 role 解析之后）。
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  CommandDriverTransport,
  type CommandDriverTransportOptions,
} from './command-driver-transport';
import type { DriverCapabilities, DriverRuntimeHandle } from './contract';
import { ExternalDriverRuntime, type ExternalDriverTransport } from './external-driver-runtime';
import {
  resolveRoleDriver,
  type DriverConfig,
  type DriverProfile,
  type ResolvedDriver,
} from './profile';

export interface DriverRegistryOptions {
  /** 已合并 + 已校验的配置。 */
  config: DriverConfig;
  /** 部署级 runner 检出目录；`profile.runtime.runner_dir` 可覆盖。 */
  runnerDir: string;
  /** 部署级入口，相对 runner 目录；`profile.runtime.entry` 可覆盖（可为绝对路径）。 */
  defaultEntryRelative: string;
  /**
   * 下发给子进程的基础环境（A 侧 `.env` + 沙箱开关等）。
   *
   * **不含 `ACP_AGENT_ID`**——那个由每个档案的 `agent` 决定。
   */
  baseEnv: NodeJS.ProcessEnv;
  /** 从子进程环境里剔除的键。 */
  unsetEnv?: readonly string[];
  /** 部署级能力位；档案的 `capabilities` 逐项覆盖。 */
  defaultCapabilities?: Partial<DriverCapabilities>;
  /** 子进程无输出多久判定卡死。 */
  inactivityTimeoutMs?: number;
  /** 凭据校验用的父进程环境；默认 `process.env`（与 `spawnOptions` 的基线一致）。 */
  parentEnv?: NodeJS.ProcessEnv;
  /** 测试注入：替换真实 `CommandDriverTransport`。 */
  createTransport?: (options: CommandDriverTransportOptions) => ExternalDriverTransport;
}

/** 解析结果 + 可直接调用的 handle。 */
export interface ResolvedDriverHandle extends ResolvedDriver {
  handle: DriverRuntimeHandle;
}

export interface DriverRegistry {
  /** 未被显式映射的 role 落到哪个 driver。 */
  readonly default_driver: string;
  listDriverIds(): string[];
  profileOf(driverId: string): DriverProfile;
  /** 按 driver_id 取 handle；未定义则抛。 */
  get(driverId: string): DriverRuntimeHandle;
  /** 按 B 侧 role 取 handle：显式映射优先，否则落 `default_driver`。 */
  resolveForRole(roleId: string): ResolvedDriverHandle;
  /** 关闭全部 driver 的 transport。 */
  shutdown(): Promise<void>;
}

/** 内部：需要 handle 之外的关闭能力。 */
interface ManagedDriver {
  handle: ExternalDriverRuntime;
}

export function createDriverRegistry(options: DriverRegistryOptions): DriverRegistry {
  const managed = new Map<string, ManagedDriver>();
  const { config } = options;

  for (const [driverId, profile] of Object.entries(config.drivers)) {
    const runnerDir = resolveRunnerDir(profile, options);
    const entry = resolveEntry(driverId, profile, runnerDir, options);
    assertRunnerPresent(driverId, runnerDir, entry);

    const env = buildChildEnv(profile, options);
    assertCredentialsPresent(driverId, profile, env, options);

    const transportOptions: CommandDriverTransportOptions = {
      // 直接调 node：Windows 上 spawn('pnpm'/'pnpm.cmd') 不带 shell 不可靠。
      command: process.execPath,
      args: [entry],
      cwd: runnerDir,
      env,
      ...(options.unsetEnv && options.unsetEnv.length > 0
        ? { unsetEnv: [...options.unsetEnv] }
        : {}),
      ...(options.inactivityTimeoutMs !== undefined
        ? { inactivityTimeoutMs: options.inactivityTimeoutMs }
        : {}),
    };

    const transport = options.createTransport
      ? options.createTransport(transportOptions)
      : new CommandDriverTransport(transportOptions);

    managed.set(driverId, {
      handle: new ExternalDriverRuntime({
        driver_id: driverId,
        capabilities: mergeCapabilities(options.defaultCapabilities, profile.capabilities),
        transport,
      }),
    });
  }

  const profileOf = (driverId: string): DriverProfile => {
    const profile = config.drivers[driverId];
    if (!profile) {
      throw new Error(
        `Driver "${driverId}" is not configured. Configured: [${Object.keys(config.drivers).join(', ') || '(none)'}]`,
      );
    }
    return profile;
  };

  const get = (driverId: string): DriverRuntimeHandle => {
    const entry = managed.get(driverId);
    if (!entry) throw new Error(`Driver "${driverId}" has no runtime handle`);
    return entry.handle;
  };

  return {
    default_driver: config.default_driver,
    listDriverIds: () => Object.keys(config.drivers),
    profileOf,
    get,
    resolveForRole: (roleId) => {
      const resolved = resolveRoleDriver(config, roleId);
      return { ...resolved, handle: get(resolved.driver_id) };
    },
    shutdown: async () => {
      const failures: unknown[] = [];
      for (const { handle } of managed.values()) {
        try {
          await handle.shutdown();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Failed to shut down driver runtimes');
      }
    },
  };
}

/**
 * 合并能力位：档案逐项覆盖部署默认。
 *
 * 必须逐键过滤 `undefined`——`exactOptionalPropertyTypes` 下，zod 可选字段推出来的
 * `boolean | undefined` 不能直接 spread 进 `Partial<DriverCapabilities>`。未声明的键
 * 保持缺席，交由 `ExternalDriverRuntime` 用 DEFAULT_CAPABILITIES 补齐。
 */
function mergeCapabilities(
  defaults: Partial<DriverCapabilities> | undefined,
  overrides: DriverProfile['capabilities'],
): Partial<DriverCapabilities> {
  const merged: Partial<Record<keyof DriverCapabilities, boolean>> = {};
  for (const source of [defaults, overrides]) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'boolean') merged[key as keyof DriverCapabilities] = value;
    }
  }
  return merged;
}

function resolveRunnerDir(
  profile: DriverProfile,
  options: DriverRegistryOptions,
): string {
  const override = profile.runtime?.runner_dir?.trim();
  return override ? path.resolve(override) : path.resolve(options.runnerDir);
}

function resolveEntry(
  driverId: string,
  profile: DriverProfile,
  runnerDir: string,
  options: DriverRegistryOptions,
): string {
  const override = profile.runtime?.entry?.trim();
  if (!override) return path.join(runnerDir, options.defaultEntryRelative);
  return path.isAbsolute(override) ? override : path.join(runnerDir, override);
}

/**
 * 构造期校验 runner：目录存在且是目录，入口文件存在。
 *
 * 这对应「本仓能自足判定的可用性三项」里的入口项——本机**是否装了某个 agent CLI**
 * 本仓判断不了（启动命令来自 `${AGENT_ID}_CLI_COMMAND` 或 adapter 默认值），那条只能
 * 如实降级，不能在这里假装检查。
 */
function assertRunnerPresent(driverId: string, runnerDir: string, entry: string): void {
  if (!existsSync(runnerDir)) {
    throw new Error(`Driver "${driverId}" runner directory not found: ${runnerDir}`);
  }
  if (!statSync(runnerDir).isDirectory()) {
    throw new Error(`Driver "${driverId}" runner path is not a directory: ${runnerDir}`);
  }
  if (!existsSync(entry)) {
    throw new Error(
      `Driver "${driverId}" runner entry missing: ${entry} (run pnpm --dir ${runnerDir} build)`,
    );
  }
}

/**
 * 组装下发给子进程的环境。
 *
 * `ACP_AGENT_ID` 放在最后：档案的 `agent` 是声明身份，`runtime.env` 不能悄悄改写它。
 */
function buildChildEnv(profile: DriverProfile, options: DriverRegistryOptions): NodeJS.ProcessEnv {
  return {
    ...options.baseEnv,
    ...(profile.runtime?.env ?? {}),
    ACP_AGENT_ID: profile.agent,
  };
}

/**
 * 校验档案声明的凭据键是否齐备。
 *
 * 报错必须点名**具体键**（`missing_env:OPENAI_API_KEY` 那一侧的信息源就是这里），
 * 而不是笼统的「driver 未就绪」。
 */
function assertCredentialsPresent(
  driverId: string,
  profile: DriverProfile,
  childEnv: NodeJS.ProcessEnv,
  options: DriverRegistryOptions,
): void {
  const required = profile.credentials?.env ?? [];
  if (required.length === 0) return;

  const parentEnv = options.parentEnv ?? process.env;
  const unset = new Set(options.unsetEnv ?? []);
  const missing = required.filter((key) => {
    if (unset.has(key)) return true;
    const value = childEnv[key] ?? parentEnv[key];
    return value === undefined || value.trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(
      `Driver "${driverId}" is missing required credential env key(s): ${missing.join(', ')}. ` +
        'Provide them via ACP_DRIVER_ENV_FILE or the driver\'s runtime.env.',
    );
  }
}
