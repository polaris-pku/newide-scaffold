/**
 * command-observation — 受支持 Driver 的**命令级观察**事件协议（阶段 2 复审修复）。
 *
 * 职责与核心逻辑：
 * - 定义宿主可消费的命令级观察事件 `driver.command_observed`：由 driver runtime 的
 *   命令执行端（不是 coding agent 的回复文本）在一条命令结束时通过既有
 *   `NEWIDE_DRIVER_EVENT` 事件通道上报 `{command, exit_code, stdout, stderr}`。
 * - 这是「受支持 Driver」的能力：宿主必须能拿到**原始命令 + 退出码 + 原始输出**，
 *   才能把检查标成 `host_observed`；没有该事件的 Driver 一律证据缺口
 *   （driver 自述 / runner 退出码都不能冒充）。
 * - **被检查内容身份**：事件必须携带 `checked_workspace_sha256`——命令执行端在**命令结束、
 *   交还 agent 控制权之前**，对工作区内容计算 canonical 内容指纹（算法同宿主
 *   `hashWorkspaceContent`：相对路径 → 文件字节 sha256，按路径排序后 JSON 化再 sha256）。
 *   宿主在收到事件时独立重算同一指纹并比对：不一致 = 命令结束到宿主观察之间内容已变，
 *   不能证明检查作用于哪一版内容 → 降级 `partial`（证据缺口），绝不把事件接收时刻的快照
 *   当成被检查版本。宿主只把比对通过的指纹写成检查的 `workspace_sha256`，finish 再用它与
 *   最终交付内容比对；driver 单独自报的 hash 不能直接当证据。
 * - 解析是 strict 的：形状不合法的事件按「该 Driver 不支持命令级观察」处理，
 *   不猜测、不把半个事件升级成证据。`stdout`/`stderr` 超限时由上报方截断并置
 *   `truncated=true`；宿主据此把 observation 降为 `partial`。
 *
 * 边界：本文件只做协议解析；写证据文件、构建 ExecutionCheck、判断「检查通过」都在
 * app 层（role-autonomy-engine / role-autonomy-finish）。不修改外部 ACP 仓库。
 */
import { z } from 'zod';
import type { DriverStreamEvent } from './contract';

/** 事件名（跨进程契约，写入 NEWIDE_DRIVER_EVENT 行的 event_type）。 */
export const DRIVER_COMMAND_OBSERVED_EVENT = 'driver.command_observed';

/** 单次原始输出的字符上限（超出由上报方截断并标 truncated）。 */
export const DRIVER_COMMAND_OBSERVATION_MAX_OUTPUT_CHARS = 256_000;

export const DriverCommandObservationSchema = z
  .object({
    command: z.string().trim().min(1).max(4_096),
    exit_code: z.number().int(),
    stdout: z.string().max(DRIVER_COMMAND_OBSERVATION_MAX_OUTPUT_CHARS).optional(),
    stderr: z.string().max(DRIVER_COMMAND_OBSERVATION_MAX_OUTPUT_CHARS).optional(),
    /** true = 上报方截断了 stdout/stderr；宿主只能把 observation 标 partial。 */
    truncated: z.boolean().optional(),
    /** 该命令覆盖的交付对象（工作区相对路径）；缺省表示适用整个工作区。 */
    target_paths: z.array(z.string().trim().min(1).max(1_024)).max(256).optional(),
    /**
     * 命令结束时（交还 agent 之前）工作区的 canonical 内容指纹，算法与宿主
     * `hashWorkspaceContent` 一致。宿主必须独立重算并比对，不能直接信任该自报值。
     */
    checked_workspace_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    tool_call_id: z.string().trim().min(1).max(200).optional(),
    duration_ms: z.number().nonnegative().optional(),
    /** 观察时间；缺省由宿主用收到事件的时间。 */
    observed_at: z.iso.datetime().optional(),
  })
  .strict();

export type DriverCommandObservation = z.infer<typeof DriverCommandObservationSchema>;

/**
 * 从 driver 事件流解析命令级观察；不是该事件/形状不合法 → undefined。
 * 不抛错：未知或畸形事件不能打断 driver 执行。
 */
export function parseDriverCommandObservation(
  event: DriverStreamEvent,
): DriverCommandObservation | undefined {
  if (event.event_type !== DRIVER_COMMAND_OBSERVED_EVENT) return undefined;
  const parsed = DriverCommandObservationSchema.safeParse(event.payload);
  return parsed.success ? parsed.data : undefined;
}
