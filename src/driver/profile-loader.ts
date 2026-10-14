/**
 * Driver 配置的分层加载（driver 可配置化 / A1）。
 *
 * 职责与核心逻辑：
 * - 把「内置默认 → 用户级 → 用户本地 → 项目级 → 项目本地 → **自动发现** → UI routing」
 *   各层 YAML 合成一份 {@link DriverConfig}，最后叠加环境变量覆盖（**env 永远赢**，与既有
 *   `.env.local` 覆盖约定一致）；
 * - **零配置必须保持历史行为**：没有任何一层、也没有相关 env 时退化成单个
 *   `acp-external` 档案（agent 取 `ACP_AGENT_ID ?? 'claude'`），与今天的装配字节一致；
 * - 合并规则：`default_driver` 后层覆盖；`drivers` 同 id **整档案替换**（不做深合并，
 *   避免出现半新半旧的档案）；`roles` 逐 key 覆盖；
 * - **自动发现层是特殊的一层**（`origin: 'discovered'`）：它只补 `drivers`、同 id 恒输给手工
 *   配置，且它的 `default_driver` / `roles` 一律忽略。理由是那个文件由后端生成、可随时重建：
 *   它不该有能力改写「用户选的默认 driver」，也不该让一份坏文件把后端起不来——所以它读坏了
 *   只记一条警告，退化成「没有自动 profile」；
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
import {
  DETECTED_DRIVER_PROFILES_FILE_NAME,
  parseDetectedDriverProfiles,
} from './driver-discovery-file-store';
import { UI_DRIVER_ROUTING_FILE_NAME } from './driver-routing-file-store';

/** 一层配置文件的来源。 */
export interface DriverConfigLayerSource {
  /** YAML 文件绝对路径。 */
  path: string;
  /**
   * 该层的 `roles` 如何参与合并。
   *
   * - `merge`（缺省）：逐 key 覆盖，用于手工维护的档案层；
   * - `replace`：整张 `roles` 表替换，用于 UI routing 覆盖层。这是「删除某个 role 的显式
   *   映射即恢复跟随默认 driver」得以成立的前提——逐 key 合并时，下层同名 key 会重新冒出来，
   *   删除永远删不干净。UI 更新接口本来就收发完整 mapping，整表替换与之一致。
   */
  rolesMode?: 'merge' | 'replace';
  /**
   * 该层的权威来源。
   *
   * - `manual`（缺省）：用户/部署手写的配置，字段全量参与合并；
   * - `discovered`：后端自动生成的那一层，**只能补 drivers**，且同 id 输给手工配置。
   *
   * 明确标注来源，是为了让「自动文件被当成用户配置」在类型与代码路径上都不可达——它的字段
   * 限制不是靠约定，而是靠这条 origin 上的分支。
   */
  origin?: 'manual' | 'discovered';
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
  /**
   * 逐路径覆盖某一层的内容（`undefined` 表示该层不存在）。
   *
   * 写入前**预校验**用：不落盘就先按「新 UI 层生效」合成一次配置，引用悬空在写文件之前
   * 就被挡下，旧文件因此天然保持完整。
   */
  layerOverrides?: Readonly<Record<string, DriverConfigLayer | undefined>>;
  /**
   * 自动发现层读坏时的告警出口（YAML 坏了、形状不对、字段越界）。
   *
   * 缺省写到 stderr：这一层是后端自己生成的，读不出来意味着「自动 driver 没了」，必须是
   * 可诊断的——但又不值得让后端起不来。
   */
  onWarning?: (message: string) => void;
}

/**
 * 默认层次：后者覆盖前者。
 *
 * 用户级在前、项目级在后，所以**项目配置赢过用户配置**——这是「部署默认 + 项目覆盖」
 * 的意图。`.local.yaml` 排在各自的正式文件之后，用于不入库的个人覆盖。
 *
 * `drivers.detected.local.yaml`（自动发现）排在手工层之后、UI 层之前：它排在后面是因为
 * 「后加载」只是书写顺序，它真正的作用是**补**手工层没写的 driver（同 id 恒输给手工配置，
 * 见 {@link mergeDiscoveredDriverConfigLayer}）；排在 UI 层之前是因为 UI routing 覆盖一切。
 *
 * `drivers.ui.local.yaml` 排在最后且 `rolesMode: 'replace'`：前端编辑过的 routing 覆盖
 * 一切手工默认值，并且**拥有整张 role 表**——UI 里没有的 role 就是「跟随默认 driver」。
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
    {
      path: join(projectRoot, '.agent', DETECTED_DRIVER_PROFILES_FILE_NAME),
      origin: 'discovered',
    },
    {
      path: join(projectRoot, '.agent', UI_DRIVER_ROUTING_FILE_NAME),
      rolesMode: 'replace',
    },
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
  const overrides = options.layerOverrides;
  const warn = options.onWarning ?? warnToStderr;

  let merged: DriverConfigLayer = builtinLayer(env);

  for (const layer of layers) {
    const overridden =
      overrides && Object.prototype.hasOwnProperty.call(overrides, layer.path)
        ? overrides[layer.path]
        : undefined;
    if (overridden !== undefined) {
      merged = mergeLayer(merged, overridden, layer);
      continue;
    }
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, layer.path)) continue;
    if (!existsSync(layer.path)) continue;

    if (layer.origin === 'discovered') {
      const discovered = readDiscoveredLayer(layer.path, warn);
      if (discovered) merged = mergeDiscoveredDriverConfigLayer(merged, discovered);
      continue;
    }
    merged = mergeLayer(merged, readDriverConfigLayer(layer.path), layer);
  }

  return parseDriverConfig(applyEnvOverlay(merged, env));
}

/** 按层的来源选合并方式：自动发现层只能补，手工层照旧后层覆盖。 */
function mergeLayer(
  base: DriverConfigLayer,
  override: DriverConfigLayer,
  source: DriverConfigLayerSource,
): DriverConfigLayer {
  return source.origin === 'discovered'
    ? mergeDiscoveredDriverConfigLayer(base, override)
    : mergeDriverConfigLayers(base, override, source.rolesMode ?? 'merge');
}

/**
 * 合并自动发现层：**只补 `drivers`**，且同 id 恒输给已有（手工）配置。
 *
 * 三条限制都是刻意的：
 * - 同 id 输给手工配置——用户写了 `runtime.runner_dir` 或凭据，自动层不能把它覆盖成最小档案；
 * - `default_driver` / `roles` 一律不采纳——那个文件由后端生成，不该有能力改写「用户选的默认
 *   driver」，也不该凭空造出 role 映射；
 * - `version` 也不采纳——版本号属于手工配置的编号空间。
 */
export function mergeDiscoveredDriverConfigLayer(
  base: DriverConfigLayer,
  override: DriverConfigLayer,
): DriverConfigLayer {
  const drivers = { ...(base.drivers ?? {}) };
  for (const [driverId, profile] of Object.entries(override.drivers ?? {})) {
    if (Object.prototype.hasOwnProperty.call(drivers, driverId)) continue;
    drivers[driverId] = profile;
  }
  return { ...base, drivers };
}

/**
 * 读自动发现层；任何问题都退化成「没有自动 profile」，并报一条警告。
 *
 * 与手工层的关键区别：手工层读坏了要在启动时炸出来（用户写错了要立刻知道），自动层读坏了
 * 只该少几个 driver——它是后端自己生成的，而且下一轮探测就能重建。
 */
function readDiscoveredLayer(
  filePath: string,
  warn: (message: string) => void,
): DriverConfigLayer | undefined {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (cause) {
    warn(`[driver-discovery] failed to read ${DETECTED_DRIVER_PROFILES_FILE_NAME}: ${String(cause)}`);
    return undefined;
  }
  try {
    const parsed = parseDetectedDriverProfiles(content, filePath);
    if (Object.keys(parsed.drivers).length === 0) return undefined;
    return { version: parsed.version, drivers: parsed.drivers };
  } catch (cause) {
    warn(
      `[driver-discovery] ignoring auto-discovered driver profiles: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return undefined;
  }
}

function warnToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * 只按**手工层**加载配置。
 *
 * 用于「配置事实」的投影：自动发现层是后端自己生成的，不能拿它当「用户配了什么」——否则一个
 * agent 只要被发现过一次，下一轮合并就会把它算成配置 driver，`stale` 判定永远不成立，
 * `discovered:` 前缀也再不会出现。
 */
export function loadManualDriverConfig(options: LoadDriverConfigOptions = {}): DriverConfig {
  const projectRoot = options.projectRoot ?? process.cwd();
  const home = options.homeDir ?? homedir();
  return loadDriverConfig({
    ...options,
    projectRoot,
    homeDir: home,
    layers:
      options.layers ??
      defaultDriverConfigLayers(projectRoot, home).filter(
        (layer) => layer.origin !== 'discovered',
      ),
  });
}

/** 合并两层配置：后者覆盖前者。 */
export function mergeDriverConfigLayers(
  base: DriverConfigLayer,
  override: DriverConfigLayer,
  rolesMode: 'merge' | 'replace' = 'merge',
): DriverConfigLayer {
  return {
    version: override.version ?? base.version,
    default_driver: override.default_driver ?? base.default_driver,
    // 同 id 整档案替换：档案是原子的，深合并会造出没有任何一层声明过的组合。
    drivers: { ...(base.drivers ?? {}), ...(override.drivers ?? {}) },
    roles:
      rolesMode === 'replace'
        ? { ...(override.roles ?? {}) }
        : { ...(base.roles ?? {}), ...(override.roles ?? {}) },
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
