/**
 * BatchBufferTriggerPolicy — BufferTriggerPolicy 的实现
 *
 * 三层触发门控（Spec §4.2.2）：
 *   1. 容量门控：pending_count >= BATCH_SIZE（默认 3）
 *   2. 时间门控：pending 中最老报告距今 >= MAX_STALENESS（默认 6 小时）
 *   3. 优先级门控：存在 effectiveness = "ineffective" 的报告
 *
 * 任一条件满足即触发提取。
 */
import { isBufferSnapshotV2, type BufferMeta, type BufferSnapshotLike } from '../schemas';
import type { BufferTriggerPolicy } from '../ports/buffer-trigger-policy';

export class BatchBufferTriggerPolicy implements BufferTriggerPolicy {
  constructor(
    private readonly batchSize = 3,
    private readonly maxStalenessMs = 6 * 60 * 60 * 1000,
  ) {}

  shouldExtract(meta: BufferMeta, pending: BufferSnapshotLike[]): boolean {
    // 1. 容量门控
    if (meta.pending_count >= this.batchSize) {
      return true;
    }

    // 2. 时间门控：最老报告距今 >= maxStalenessMs
    const now = Date.now();
    const oldest = pending.reduce<Date | null>((earliest, snapshot) => {
      const receivedAt = new Date(snapshot.received_at);
      return earliest === null || receivedAt < earliest ? receivedAt : earliest;
    }, null);

    if (oldest !== null && now - oldest.getTime() >= this.maxStalenessMs) {
      return true;
    }

    // 3. 优先级门控：存在 effectiveness = "ineffective" 的报告（v2 没有六字段报告）
    const hasIneffective = pending.some(
      (snapshot) =>
        !isBufferSnapshotV2(snapshot) &&
        snapshot.driver_return?.effectiveness === 'ineffective',
    );
    if (hasIneffective) {
      return true;
    }

    return false;
  }
}
