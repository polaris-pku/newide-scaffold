/**
 * writePendingBuffer — 缓冲区写入服务
 *
 * 校验学习输入（v1 DriverReturn 快照或 v2 执行事实 + Role 反思）后，通过
 * AgentMemoryScope 写入 pending buffer；可配对 AgentContextSnapshot。
 * 仅使用 Spec 类型，不含 mock 映射逻辑。
 */
import { parseBufferSnapshot, type BufferSnapshotLike, type AgentContextSnapshot } from '../schemas';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { SaveBufferResult } from '../ports/buffer-repository';

/**
 * 写入 pending buffer 并回传落盘后的快照。
 *
 * 泛型保持调用方手里的具体版本（写入 v1 就拿到 v1，写入 v2 就拿到 v2）：实现只做
 * 「版本判别 + 校验」这一件事，落盘结果由适配器补上 seq 配对字段后原样交回。
 */
export async function writePendingBuffer<S extends BufferSnapshotLike>(
  memory: AgentMemoryScope,
  snapshot: S,
  agentContext?: AgentContextSnapshot,
): Promise<SaveBufferResult & { snapshot: S }> {
  // 版本判别 + 校验走同一入口：v2 不能按 v1 解析（否则字段被静默 strip）。
  parseBufferSnapshot(snapshot);
  const saved = await memory.saveBufferSnapshot(snapshot, agentContext);
  // 适配器只会给快照补 `context_snapshot_ref`（不改变版本判别字段），因此这里的窄化
  // 由「写入的是什么版本，读回的就是什么版本」这条不变量支撑。
  return saved as SaveBufferResult & { snapshot: S };
}
