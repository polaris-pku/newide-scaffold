/**
 * 运行阶段映射的单一实现：持久游标 → 对外粗粒度 stage 与 N 码。
 *
 * 为什么必须只有一份：存活期的 registry 与回放用的持久投影过去各算各的，而 registry
 * 那条只在 create / 终态写 `current.stage`，`appendEvent` 只更新 `active_node_code`。
 * 结果是**同一个 run 在两条路径上给出的 stage 不一致**——`run.getSnapshot` 走持久投影，
 * 落盘的 `frontend-snapshot.json` 走 registry。把映射抽到这里、两边引用同一个函数，
 * 这类漂移在结构上不再可能发生。
 */
import type { PersistedRunStatus, TaskResumeCursor } from '../persistence';

/** 对外暴露的粗粒度阶段；协议 `current.stage` 用它。 */
export type AppRunStage = 'executing' | 'council' | 'delivery' | 'intervention';

const CURSORS: ReadonlySet<string> = new Set<TaskResumeCursor>([
  'select_agent',
  'execute_agent',
  'council',
  'gate',
  'deliver',
  'mailbox_wait',
  'done',
]);

/**
 * 游标 → 粗粒度 stage。
 *
 * 终态（失败/取消/中断）一律是 `intervention`，此时游标停在哪儿都不再重要。
 * 注意这与「游标是否终态」是两件事：`mailbox_wait` 期间 run 可能已是 `completed`，
 * 而游标仍停在 `mailbox_wait`。
 */
export function stageForCursor(cursor: TaskResumeCursor, status: PersistedRunStatus): AppRunStage {
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') {
    return 'intervention';
  }
  if (cursor === 'council') return 'council';
  if (cursor === 'gate' || cursor === 'deliver' || cursor === 'done') return 'delivery';
  if (cursor === 'mailbox_wait') return 'intervention';
  return 'executing';
}

/** 游标 → 前端流程图的 N 码；终态统一落在 N18。 */
export function nodeCodeForCursor(cursor: TaskResumeCursor, status: PersistedRunStatus): string {
  if (status !== 'created' && status !== 'running') return 'N18';
  switch (cursor) {
    case 'select_agent':
      return 'N3';
    case 'execute_agent':
      return 'N8';
    case 'council':
      return 'N14';
    case 'gate':
      return 'N13';
    case 'deliver':
    case 'done':
      return 'N18';
    case 'mailbox_wait':
      return 'N16';
  }
}

/**
 * 从事件载荷里读游标；非游标取值返回 undefined。
 *
 * 读路径刻意宽容：`handler.*` 的载荷来自另一个模块，这里不该因为一个脏值抛错，
 * 把整个快照打挂。写路径的严格性由 `TaskProcessor.readActiveStage` 负责。
 */
export function readCursorFromPayload(value: unknown): TaskResumeCursor | undefined {
  return typeof value === 'string' && CURSORS.has(value)
    ? (value as TaskResumeCursor)
    : undefined;
}
