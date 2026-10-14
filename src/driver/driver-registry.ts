/**
 * Driver 注册表（driver 可配置化 / 装配层）。
 *
 * 职责与核心逻辑：
 * - 把一份 {@link DriverConfig} 变成「driver_id → 可直接调用的 DriverRuntimeHandle」映射：
 *   每个档案各建一个 `ExternalDriverRuntime` + `CommandDriverTransport`。进程仍是**每次
 *   调用一次性**（transport 在 `execute` 里 spawn），所以多 driver 不需要常驻多进程；
 * - 把「配置写错了」提前成**启动失败**，而不是跑到 `execute_agent` 才炸：入口文件缺失、
 *   runner 目录缺失、凭据键不齐（报**具体键名**）都在构造期抛；
 * - **两类 driver 的失败语义不同**（这是自动发现引入的关键分野）：
 *   - 手工配置的档案 fail-fast——用户写错了要立刻知道，后端起不来是正确行为；
 *   - 自动发现的档案走 {@link DriverRegistry.registerDiscovered}，失败只记录原因码并返回
 *     结构化结果。它们由探测生成，本机装没装 runner、凭据齐不齐都不该拦住后端启动；
 * - `listDriverIds()` 只报**成功注册过 runtime** 的 id：routing 的「可选性」判据之一是「进程里
 *   有没有它的句柄」，把失败的那些报出去会让前端看到一个选了就炸的 driver；
 * - 下发给子进程的 `ACP_AGENT_ID` 由档案的 `agent` 决定，且**档案的 agent 恒赢**——
 *   不让 `runtime.env` 里的同名键和声明身份悄悄分叉；
 * - 零配置时只产出一个 `acp-external`，与历史装配逐字段一致。
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
  DRIVER_CONNECTION_TYPE_UNSUPPORTED,
  DRIVER_REQUIRED_CREDENTIAL_MISSING,
  DRIVER_RUNNER_ENTRY_MISSING,
  DRIVER_RUNTIME_REGISTRATION_FAILED,
  type DriverConnectionType,
} from './driver-discovery-catalog';
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
  /**
   * 由**自动发现**生成的 driver id。
   *
   * 这一批的装配失败不进 fail-fast，而是记录原因码、继续启动（见文件头）。
   */
  discoveredDriverIds?: readonly string[];
  /** 某个 driver 的连接类型；缺省视为 `acp`。 */
  connectionTypeOf?: (driverId: string) => DriverConnectionType | undefined;
  /**
   * 当前执行链支持的连接类型；缺省只支持 `acp`。
   *
   * `pty` 需要另一套执行链——ACP 探针能连上它，不代表本仓能拿它跑一次 Run。
   */
  supportedConnectionTypes?: readonly DriverConnectionType[];
}

/** 解析结果 + 可直接调用的 handle。 */
export interface ResolvedDriverHandle extends ResolvedDriver {
  handle: DriverRuntimeHandle;
}

/** runtime 注册失败的事实。`message` 是我们自己的文案，不含 secret。 */
export interface DriverRuntimeRegistrationFailure {
  reason_code: string;
  message: string;
}

/** 动态注册的结果：成功给 handle，失败给稳定原因码。 */
export type DriverRuntimeRegistrationResult =
  | { ok: true; handle: DriverRuntimeHandle }
  | ({ ok: false } & DriverRuntimeRegistrationFailure);

export interface DriverRegistry {
  /** 未被显式映射的 role 落到哪个 driver。 */
  readonly default_driver: string;
  /** **成功注册过 runtime** 的 driver id（升序）。 */
  listDriverIds(): string[];
  profileOf(driverId: string): DriverProfile;
  /** 按 driver_id 取 handle；未定义或未注册则抛。 */
  get(driverId: string): DriverRuntimeHandle;
  hasRuntime(driverId: string): boolean;
  /** 该 driver 上次注册失败的原因；成功过或从未尝试则 undefined。 */
  failureOf(driverId: string): DriverRuntimeRegistrationFailure | undefined;
  /**
   * 注册一个自动发现的 driver。
   *
   * 幂等：同 id 已注册时直接返回既有 handle，**不会**再造一个 transport（否则旧的会泄漏）。
   */
  registerDiscovered(
    driverId: string,
    profile: DriverProfile,
    options?: { connection_type?: DriverConnectionType },
  ): DriverRuntimeRegistrationResult;
  /** 按 B 侧 role 取 handle：显式映射优先，否则落 `default_driver`。 */
  resolveForRole(roleId: string): ResolvedDriverHandle;
  /** 关闭全部 driver 的 transport。 */
  shutdown(): Promise<void>;
}

/** 内部：需要 handle 之外的关闭能力。 */
interface ManagedDriver {
  handle: ExternalDriverRuntime;
}

/** 内部注册尝试：失败时把**原始错误**也带上，好让配置 driver 抛回同一个错误实例。 */
type RegistrationAttempt =
  | { ok: true; handle: DriverRuntimeHandle }
  | ({ ok: false; error: unknown } & DriverRuntimeRegistrationFailure);

/**
 * 装配失败但带稳定原因码。
 *
 * 消息与改造前逐字一致（`runner entry missing` / `missing required credential env key(s)`），
 * 因为配置 driver 的 fail-fast 报错是既有契约：测试与运维都按这些字样定位问题。
 */
class DriverRegistrationError extends Error {
  constructor(
    readonly reason_code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DriverRegistrationError';
  }
}

export function createDriverRegistry(options: DriverRegistryOptions): DriverRegistry {
  const managed = new Map<string, ManagedDriver>();
  const failures = new Map<string, DriverRuntimeRegistrationFailure>();
  const { config } = options;
  const discovered = new Set(options.discoveredDriverIds ?? []);
  const supported = options.supportedConnectionTypes ?? ['acp'];
  const connectionTypeOf = (driverId: string): DriverConnectionType =>
    options.connectionTypeOf?.(driverId) ?? 'acp';

  const attempt = (
    driverId: string,
    profile: DriverProfile,
    connectionType: DriverConnectionType,
  ): RegistrationAttempt => {
    if (!supported.includes(connectionType)) {
      return {
        ok: false,
        reason_code: DRIVER_CONNECTION_TYPE_UNSUPPORTED,
        message:
          `Driver "${driverId}" uses connection type "${connectionType}", ` +
          'which this build cannot execute',
        error: undefined,
      };
    }
    const existing = managed.get(driverId);
    if (existing) return { ok: true, handle: existing.handle };

    try {
      const built = buildManagedDriver(driverId, profile, options);
      managed.set(driverId, built);
      failures.delete(driverId);
      return { ok: true, handle: built.handle };
    } catch (error) {
      return {
        ok: false,
        reason_code: reasonCodeOf(error),
        message: error instanceof Error ? error.message : String(error),
        error,
      };
    }
  };

  const registerDiscovered = (
    driverId: string,
    profile: DriverProfile,
    registration: { connection_type?: DriverConnectionType } = {},
  ): DriverRuntimeRegistrationResult => {
    const result = attempt(driverId, profile, registration.connection_type ?? connectionTypeOf(driverId));
    if (result.ok) return { ok: true, handle: result.handle };
    const failure = { reason_code: result.reason_code, message: result.message };
    failures.set(driverId, failure);
    return { ok: false, ...failure };
  };

  // 构造期：先注册**手工配置**的 driver（fail-fast），再尝试自动发现的那些（失败只记录）。
  // 顺序固定成两遍，是为了让「配置写错了」在任何情况下都还是启动失败，而不是被一个先失败的
  // 自动 driver 掩盖成「启动成功但少一个 driver」。
  for (const [driverId, profile] of Object.entries(config.drivers)) {
    if (discovered.has(driverId)) continue;
    const result = attempt(driverId, profile, connectionTypeOf(driverId));
    if (!result.ok) throw result.error ?? new Error(result.message);
  }
  for (const [driverId, profile] of Object.entries(config.drivers)) {
    if (!discovered.has(driverId)) continue;
    const result = attempt(driverId, profile, connectionTypeOf(driverId));
    if (!result.ok) failures.set(driverId, { reason_code: result.reason_code, message: result.message });
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
    listDriverIds: () => [...managed.keys()].sort(compareCodeUnits),
    profileOf,
    get,
    hasRuntime: (driverId) => managed.has(driverId),
    failureOf: (driverId) => {
      const failure = failures.get(driverId);
      return failure ? { ...failure } : undefined;
    },
    registerDiscovered,
    resolveForRole: (roleId) => {
      const resolved = resolveRoleDriver(config, roleId);
      return { ...resolved, handle: get(resolved.driver_id) };
    },
    shutdown: async () => {
      const shutdownFailures: unknown[] = [];
      for (const { handle } of managed.values()) {
        try {
          await handle.shutdown();
        } catch (error) {
          shutdownFailures.push(error);
        }
      }
      if (shutdownFailures.length === 1) throw shutdownFailures[0];
      if (shutdownFailures.length > 1) {
        throw new AggregateError(shutdownFailures, 'Failed to shut down driver runtimes');
      }
    },
  };
}

/** 装配一个 driver 的 runtime；失败原因由抛出的错误类型携带。 */
function buildManagedDriver(
  driverId: string,
  profile: DriverProfile,
  options: DriverRegistryOptions,
): ManagedDriver {
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

  return {
    handle: new ExternalDriverRuntime({
      driver_id: driverId,
      capabilities: mergeCapabilities(options.defaultCapabilities, profile.capabilities),
      transport,
    }),
  };
}

/** 有原因码就用它，否则归到通用的注册失败。 */
function reasonCodeOf(error: unknown): string {
  return error instanceof DriverRegistrationError
    ? error.reason_code
    : DRIVER_RUNTIME_REGISTRATION_FAILED;
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
    throw new DriverRegistrationError(
      DRIVER_RUNNER_ENTRY_MISSING,
      `Driver "${driverId}" runner directory not found: ${runnerDir}`,
    );
  }
  if (!statSync(runnerDir).isDirectory()) {
    throw new DriverRegistrationError(
      DRIVER_RUNNER_ENTRY_MISSING,
      `Driver "${driverId}" runner path is not a directory: ${runnerDir}`,
    );
  }
  if (!existsSync(entry)) {
    throw new DriverRegistrationError(
      DRIVER_RUNNER_ENTRY_MISSING,
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
    throw new DriverRegistrationError(
      DRIVER_REQUIRED_CREDENTIAL_MISSING,
      `Driver "${driverId}" is missing required credential env key(s): ${missing.join(', ')}. ` +
        'Provide them via ACP_DRIVER_ENV_FILE or the driver\'s runtime.env.',
    );
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
