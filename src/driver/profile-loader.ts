/**
 * Driver 配置的分层加载（driver 可配置化 / A1）。
 *
 * 职责与核心逻辑：
 * - 把「内置默认 → 用户级 → 用户本地 → 项目级 → 项目本地」五层 YAML 合成一份
 *   {@link DriverConfig}，最后叠加环境变量覆盖（**env 永远赢**，与既有 `.env.local`
 *   覆盖约定一致）；
 * - **零配置必须保持历史行为**：没有任何一层、也没有相关 env 时退化成单个
 *   `acp-external` 档案（agent 取 `ACP_AGENT_ID ?? 'claude'`），与今天的装配字节一致；
 * - 合并规则：`default_driver` 后层覆盖；`drivers` 同 id **整档案替换**（不做深合并，
 *   避免出现半新半旧的档案）；`roles` 逐 key 覆盖；
 * - 逐层解析时报错带文件路径；合并后的跨字段校验报错不带路径（它描述的是合成结果）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  DEFAULT_AGENT_ID,
  LEGACY_DRIVER_ID,
  parseDriverConfig,
  parseDriverConfigLayer,
  type DriverConfig,
  type DriverConfigLayer,
} from './profile';

/** 一层配置文件的来源。 */
export interface DriverConfigLayerSource {
  /** YAML 文件绝对路径。 */
  path: string;
}

export interface LoadDriverConfigOptions {
  /** 项目根；默认 `process.cwd()`（与 `createProductionBackendService` 同源）。 */
  projectRoot?: string;
  /** 环境变量；默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 家目录；默认 `os.homedir()`。测试可注入以避开真实 HOME。 */
  homeDir?: string;
  /** 覆盖默认层次顺序（后者覆盖前者）。测试用。 */
  layers?: readonly DriverConfigLayerSource[];
}

/**
 * 默认层次：后者覆盖前者。
 *
 * 用户级在前、项目级在后，所以**项目配置赢过用户配置**——这是「部署默认 + 项目覆盖」
 * 的意图。`.local.yaml` 排在各自的正式文件之后，用于不入库的个人覆盖。
 */
export function defaultDriverConfigLayers(
  projectRoot: string,
  home: string,
): DriverConfigLayerSource[] {
  return [
    { path: join(home, '.agent', 'drivers.yaml') },
    { path: join(home, '.agent', 'drivers.local.yaml') },
    { path: join(projectRoot, '.agent', 'drivers.yaml') },
    { path: join(projectRoot, '.agent', 'drivers.local.yaml') },
  ];
}

/**
 * 加载 driver 配置。
 *
 * 从不抛「找不到配置」——零配置是合法状态，返回内置默认。只有 YAML 语法错误、
 * 结构非法、或跨字段引用悬空才抛 {@link DriverConfigError}。
 */
export function loadDriverConfig(options: LoadDriverConfigOptions = {}): DriverConfig {
  const projectRoot = options.projectRoot ?? process.cwd();
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const layers = options.layers ?? defaultDriverConfigLayers(projectRoot, home);

  let merged: DriverConfigLayer = builtinLayer(env);

  for (const layer of layers) {
    if (!existsSync(layer.path)) continue;
    merged = mergeDriverConfigLayers(merged, readDriverConfigLayer(layer.path));
  }

  return parseDriverConfig(applyEnvOverlay(merged, env));
}

/** 合并两层配置：后者覆盖前者。 */
export function mergeDriverConfigLayers(
  base: DriverConfigLayer,
  override: DriverConfigLayer,
): DriverConfigLayer {
  return {
    version: override.version ?? base.version,
    default_driver: override.default_driver ?? base.default_driver,
    // 同 id 整档案替换：档案是原子的，深合并会造出没有任何一层声明过的组合。
    drivers: { ...(base.drivers ?? {}), ...(override.drivers ?? {}) },
    roles: { ...(base.roles ?? {}), ...(override.roles ?? {}) },
  };
}

/**
 * 内置默认层。
 *
 * 这一层就是「今天的行为」：一个 `acp-external` 档案，A 侧 agent 由 `ACP_AGENT_ID`
 * 决定。把它做成第一层而不是特例分支，是为了让「零配置」和「配置了但没提这个
 * driver」走同一条代码路径。
 */
function builtinLayer(env: NodeJS.ProcessEnv): DriverConfigLayer {
  return {
    version: 1,
    default_driver: LEGACY_DRIVER_ID,
    drivers: {
      [LEGACY_DRIVER_ID]: {
        agent: env.ACP_AGENT_ID?.trim() || DEFAULT_AGENT_ID,
      },
    },
  };
}

/**
 * 环境变量覆盖层。
 *
 * 只开放两个开关，避免 env 面无限膨胀：
 * - `NEWIDE_DRIVER`：覆盖 `default_driver`（对应「部署级默认」）；
 * - `ACP_AGENT_ID`：覆盖 `acp-external` 档案的 agent。这条是刻意保留的——
 *   Electron（`backendBridge.cjs`）与 eval 都靠它选 agent，去掉会让那些路径失效。
 */
function applyEnvOverlay(layer: DriverConfigLayer, env: NodeJS.ProcessEnv): DriverConfigLayer {
  const overriddenDriver = env.NEWIDE_DRIVER?.trim();
  const agentOverride = env.ACP_AGENT_ID?.trim();
  const legacy = layer.drivers?.[LEGACY_DRIVER_ID];

  const drivers =
    agentOverride && legacy
      ? { ...layer.drivers, [LEGACY_DRIVER_ID]: { ...legacy, agent: agentOverride } }
      : layer.drivers;

  return {
    ...layer,
    ...(overriddenDriver ? { default_driver: overriddenDriver } : {}),
    ...(drivers ? { drivers } : {}),
  };
}

function readDriverConfigLayer(filePath: string): DriverConfigLayer {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (cause) {
    throw new Error(`Failed to read driver config file "${filePath}": ${String(cause)}`, { cause });
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (cause) {
    throw new Error(`Failed to parse YAML in "${filePath}": ${String(cause)}`, { cause });
  }

  return parseDriverConfigLayer(raw, filePath);
}
