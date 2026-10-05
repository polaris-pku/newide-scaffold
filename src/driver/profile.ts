/**
 * Driver 档案配置模型（driver 可配置化 / A1）。
 *
 * 职责与核心逻辑：
 * - 定义「可用 driver 的数据体」：{@link DriverConfig} 是整份配置，{@link DriverProfile}
 *   是单个 driver 档案，`roles` 是 B 侧 role → driver 的映射；
 * - driver 在本仓是 **per-role 的无状态工具**：档案只描述「用哪个 A 侧 coding agent、
 *   怎么把它拉起来、需要哪些凭据、自称什么能力、计费记到哪一腿」，不承载任何记忆。
 *   B 侧的记忆（persona / skills / experiences）绑在 role_id 上，与 driver 无关；
 * - 用 Zod 作类型单一来源（与 `src/protocol` 同约定），解析失败时带上字段路径；
 * - 纯模型层：不读文件、不看 env、不装配 transport（那些在 `profile-loader`）。
 */

import { z } from 'zod';

/**
 * 本仓 driver 标识。
 *
 * 注意它与 A 侧 `ACP_AGENT_ID` 不是一回事：一个 driver 档案 = 一个 A 侧 agent +
 * 一套启动方式 + 一套凭据。同名的 `driver_id` 会进 Run 快照与用量账本。
 */
export const driverIdSchema = z.string().min(1);

/**
 * 零配置时的历史 driver 标识。
 *
 * 保持 `'acp-external'` 是硬要求：今天 `createProductionBackendService` 把它写死给唯一
 * 那个 handle，Run 快照、`source_driver`、账本都已经带上了这个值。改名会让历史 Run
 * 与新 Run 对不上。
 */
export const LEGACY_DRIVER_ID = 'acp-external';

/** A 侧 agent 缺省值：与今天 `env.ACP_AGENT_ID ?? 'claude'` 一致。 */
export const DEFAULT_AGENT_ID = 'claude';

/** 档案可覆盖的能力位（缺项由 `ExternalDriverRuntime` 的 DEFAULT_CAPABILITIES 补齐）。 */
export const driverProfileCapabilitiesSchema = z
  .object({
    supports_acp_extension: z.boolean().optional(),
    supports_structured_output: z.boolean().optional(),
    supports_session_load: z.boolean().optional(),
    supports_tool_events: z.boolean().optional(),
    supports_permission_events: z.boolean().optional(),
  })
  .strict();

/**
 * 单个 driver 档案。
 *
 * `agent` 是唯一必填项——它决定 spawn 时下发的 `ACP_AGENT_ID`，也是「选 driver 就是选
 * A 侧 agent」这条语义的唯一来源。
 */
export const driverProfileSchema = z
  .object({
    /** A 侧 ACP agent 标识（`ACP_AGENT_ID`），如 claude / codex / gemini。 */
    agent: z.string().min(1),
    /** 给人看的说明，进 `system.capabilities` 文案。 */
    description: z.string().min(1).optional(),
    /**
     * 启动方式覆盖。缺项时沿用部署级默认（`ACP_DRIVER_RUNNER_DIR` +
     * `dist/src/driver/contract-runner.js`）。
     */
    runtime: z
      .object({
        /** 覆盖 ACP runner 检出目录。 */
        runner_dir: z.string().min(1).optional(),
        /** 覆盖 runner 入口（相对 runner_dir 或绝对路径）。 */
        entry: z.string().min(1).optional(),
        /** 追加/覆盖下发给子进程的环境变量。 */
        env: z.record(z.string().min(1), z.string()).optional(),
      })
      .strict()
      .optional(),
    /**
     * 该 driver 需要的凭据环境变量名。
     *
     * 只声明「需要哪些键」，不存值——值仍由 `ACP_DRIVER_ENV_FILE` / `ACPDriverEnv` 供给。
     * 缺失时可用性判定要报出**具体键名**，而不是笼统的「未就绪」。
     */
    credentials: z
      .object({
        env: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    /** 能力声明；缺项表示「未声明」，不是「不支持」。 */
    capabilities: driverProfileCapabilitiesSchema.optional(),
    /** 计费腿：该 driver 的用量记到哪一个 `TokenUsageSource`。 */
    billing: z
      .object({
        source: z.string().min(1),
      })
      .strict()
      .optional(),
    /** 已知限制的诚实措辞，直接进前端文案（见 A3「诚实降级」）。 */
    limitations: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * 完整配置（合并 + env 覆盖之后的最终形态）。
 *
 * `default_driver` 与 `drivers` 必填：一份「能用」的配置必须能回答「没被显式映射的
 * role 走哪个 driver」和「这个 driver 是什么」。
 */
export const driverConfigSchema = z
  .object({
    version: z.number().int().positive().optional(),
    default_driver: driverIdSchema,
    drivers: z.record(z.string().min(1), driverProfileSchema),
    roles: z.record(z.string().min(1), driverIdSchema).optional(),
  })
  .strict();

/**
 * 单层配置文件的形态：全部字段可缺省。
 *
 * 一层只声明它要覆盖的部分——例如只加一个 driver 而不重述 `default_driver`。
 * 层次合并之后再按 {@link driverConfigSchema} 做最终校验。
 */
export const driverConfigLayerSchema = z
  .object({
    version: z.number().int().positive().optional(),
    default_driver: driverIdSchema.optional(),
    drivers: z.record(z.string().min(1), driverProfileSchema).optional(),
    roles: z.record(z.string().min(1), driverIdSchema).optional(),
  })
  .strict();

export type DriverProfile = z.infer<typeof driverProfileSchema>;
export type DriverConfig = z.infer<typeof driverConfigSchema>;
export type DriverConfigLayer = z.infer<typeof driverConfigLayerSchema>;
export type DriverProfileCapabilities = z.infer<typeof driverProfileCapabilitiesSchema>;

/** 解析结果：role（或 default）解析到哪个 driver 标识 + 哪份档案。 */
export interface ResolvedDriver {
  driver_id: string;
  profile: DriverProfile;
}

/** 配置校验失败的聚合错误，形状与 `HookConfigValidationError` 一致。 */
export class DriverConfigError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(
      `Driver config validation failed with ${errors.length} error(s):\n` +
        errors.map((error) => `  - ${error}`).join('\n'),
    );
    this.name = 'DriverConfigError';
    this.errors = errors;
  }
}

/** 把一份**完整**配置解析为 {@link DriverConfig}，并做跨字段校验。 */
export function parseDriverConfig(raw: unknown, sourcePath?: string): DriverConfig {
  const config = parseWith(driverConfigSchema, raw, sourcePath);
  assertReferencesResolve(config, sourcePath);
  return config;
}

/** 把一层配置文件解析为 {@link DriverConfigLayer}；不做跨字段校验（合并后再做）。 */
export function parseDriverConfigLayer(raw: unknown, sourcePath?: string): DriverConfigLayer {
  return parseWith(driverConfigLayerSchema, raw, sourcePath);
}

/**
 * 解析一个 role 应当使用哪个 driver。
 *
 * role 显式映射优先，否则落到 `default_driver`。这也是「Run 内冻结解析结果」的唯一
 * 取值入口——调用方不应自己去 `config.drivers[...]` 里翻。
 */
export function resolveRoleDriver(config: DriverConfig, roleId: string): ResolvedDriver {
  const driverId = config.roles?.[roleId] ?? config.default_driver;
  const profile = config.drivers[driverId];
  if (!profile) {
    throw new DriverConfigError([
      `role "${roleId}" resolves to driver "${driverId}", which is not defined in drivers. ` +
        `Defined: [${Object.keys(config.drivers).join(', ') || '(none)'}]`,
    ]);
  }
  return { driver_id: driverId, profile };
}

function parseWith<T extends z.ZodType>(
  schema: T,
  raw: unknown,
  sourcePath?: string,
): z.infer<T> {
  const prefix = sourcePath ? `[${sourcePath}] ` : '';
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;

  throw new DriverConfigError(
    parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${prefix}${path}: ${issue.message}`;
    }),
  );
}

/** 校验 `default_driver` 与 `roles` 的每个取值都指向已定义的 driver。 */
function assertReferencesResolve(config: DriverConfig, sourcePath?: string): void {
  const prefix = sourcePath ? `[${sourcePath}] ` : '';
  const defined = Object.keys(config.drivers);
  const hints = `Defined: [${defined.join(', ') || '(none)'}]`;
  const errors: string[] = [];

  if (!(config.default_driver in config.drivers)) {
    errors.push(
      `${prefix}default_driver "${config.default_driver}" is not defined in drivers. ${hints}`,
    );
  }
  for (const [roleId, driverId] of Object.entries(config.roles ?? {})) {
    if (!(driverId in config.drivers)) {
      errors.push(`${prefix}roles.${roleId}: driver "${driverId}" is not defined in drivers. ${hints}`);
    }
  }

  if (errors.length > 0) throw new DriverConfigError(errors);
}
