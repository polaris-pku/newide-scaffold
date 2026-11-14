/**
 * BufferTriggerPolicy 端口
 *
 * 决定何时批量触发 pending buffer 的经验提取（时间门控、数量阈值等）。
 * MVP 当前在 runTaskMemoryCycle 内同步处理；未来可接异步调度器。
 */
import type { BufferMeta, BufferSnapshotLike } from "../schemas";

export interface BufferTriggerPolicy {
  /** 判断当前是否应触发提取 */
  shouldExtract(meta: BufferMeta, pending: BufferSnapshotLike[]): boolean;
}
