/**
 * Role → Driver 路由的对外协议契约（`driver.getConfig` / `driver.updateRouting` /
 * `driver.resetRouting`）。
 *
 * 职责与核心逻辑：
 * - 这里是这三个 RPC 的**唯一契约来源**：请求、响应都由 strict Zod schema 描述，未知字段
 *   一律拒绝，前端不需要再维护一份类型；
 * - 响应里的 driver 是**非敏感投影**：只含 driver_id / agent / 可选择性 / 限制措辞，
 *   绝不含 `runtime.env`、凭据值、runner 绝对路径或 command。这条界线由 schema 本身守住
 *   ——没有字段可以承载它们；
 * - `selectable` 是后端明确计算的布尔值，前端不得从 `limitations` 文案里推断。本仓只能
 *   确认「档案已配置、runner 存在、凭据键齐备」，无法确认 A 侧 CLI 是否安装，所以状态
 *   诚实降级为 `degraded` + `AGENT_CLI_READINESS_NOT_VERIFIABLE`，而不是写成可用。
 */
import { z } from 'zod';

/** 路由快照的 schema 版本；与 `SystemSchemaManifestV1` 同类的稳定标识。 */
export const DRIVER_ROUTING_SCHEMA_VERSION = 'driver-routing.v1';

/** 一个 driver 的对外可见事实（非敏感投影）。 */
export const driverRoutingDriverSchema = z
  .object({
    /** 本仓 driver 标识（`DriverConfig.drivers` 的 key）。 */
    driver_id: z.string().min(1),
    /** 该 driver 使用的 A 侧 agent（`ACP_AGENT_ID`）。 */
    agent: z.string().min(1),
    /** 给人看的名字；档案可缺省。 */
    display_name: z.string().min(1).optional(),
    /** 给人看的说明；档案可缺省。 */
    description: z.string().min(1).optional(),
    /**
     * 后端明确计算的「是否可选择」。前端不要从 `status` 或 `limitations` 推断。
     */
    selectable: z.boolean(),
    status: z.enum(['configured', 'degraded', 'unavailable']),
    /** 降级/不可用原因码；`configured` 时缺席。 */
    reason_code: z.string().min(1).optional(),
    /** 已知限制的诚实措辞（含档案自报的）。 */
    limitations: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** 一行 role 路由。 */
export const driverRoutingRoleSchema = z
  .object({
    role_id: z.string().min(1),
    /** 配置里显式写的目标；无显式映射时等于 `default_driver`。 */
    driver_id: z.string().min(1),
    /** 解析后真正会用的 driver（Phase 1 恒等于 `driver_id`，保留字段以便将来引入别名）。 */
    effective_driver_id: z.string().min(1),
    source: z.enum(['default', 'role_override']),
    /** 该 role 是否存在于当前 B 侧 Agent 目录。缺省表示读目录失败，不能谎报存在。 */
    known_role: z.boolean(),
  })
  .strict();

/** `driver.getConfig` 的完整返回。 */
export const driverRoutingSnapshotSchema = z
  .object({
    schema_version: z.literal(DRIVER_ROUTING_SCHEMA_VERSION),
    /** 规范化后的路由文档摘要；下一次 update 的 `expected_revision` 必须与它一致。 */
    revision: z.string().min(1),
    scope: z.literal('project'),
    default_driver: z.string().min(1),
    drivers: z.array(driverRoutingDriverSchema),
    roles: z.array(driverRoutingRoleSchema),
    /** 配置里显式出现、但不在当前 Agent 目录中的 role；保留其原映射直到显式改写。 */
    orphan_roles: z.array(driverRoutingRoleSchema),
  })
  .strict();

/**
 * `driver.updateRouting` 的请求。
 *
 * 刻意要求**完整 mapping** 而不是单 role patch：一个保存动作要么整体生效、要么整体被拒，
 * 不会出现「默认 driver 已换、某个 role 还是旧的」这种中间状态。
 */
export const updateDriverRoutingInputSchema = z
  .object({
    expected_revision: z.string().min(1),
    default_driver: z.string().min(1),
    roles: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();

/** `driver.resetRouting` 的请求：删除 UI 覆盖文件，回到下层手工配置。 */
export const resetDriverRoutingInputSchema = z
  .object({
    expected_revision: z.string().min(1),
  })
  .strict();

export type DriverRoutingDriver = z.infer<typeof driverRoutingDriverSchema>;
export type DriverRoutingRole = z.infer<typeof driverRoutingRoleSchema>;
export type DriverRoutingSnapshot = z.infer<typeof driverRoutingSnapshotSchema>;
export type UpdateDriverRoutingInput = z.infer<typeof updateDriverRoutingInputSchema>;
export type ResetDriverRoutingInput = z.infer<typeof resetDriverRoutingInputSchema>;
