/**
 * 把运行快照的 timeline 序号对齐到推流通道的序号空间。
 *
 * 背景：同一批事件过去在两条通道上带着**两个不同的 `sequence`**——
 * - 推流（`run.event`）与存活期快照用 registry 分配的序号（`events.length + 1`）；
 * - 持久快照（生产环境 `run.getSnapshot` 返回的就是它）的 timeline 来自 SQLite
 *   `events` 表的 `AUTOINCREMENT` 行号。
 *
 * 于是前端那套「先 getSnapshot 对齐、再 subscribe 补增量、按 sequence 排序」的流程里，
 * **同一个事件在快照里的号和在推送里的号不是同一个数**，跨通道排序会错。
 *
 * 为什么不是「把 SQLite 序号透传进 registry」：registry 还要承载只在进程内的事件
 * （driver chunk、telemetry），它们的量级远超权威事件（council 实测一次 run 里
 * driver chunk 上万条、权威事件几十条）。让权威序号和这些观测序号共用一个自增器，
 * 只会得到「权威值几乎永远落后、只能退回 max+1」——两条通道仍然不一致。
 *
 * 所以统一到**推流这一侧**：它覆盖该 run 的全部事件，是前端实时看到的那一条。
 *
 * 三条不变量：
 * 1. **两条通道都持有的同一事件，号必须相同**——这是本模块存在的理由，任何情况下不牺牲。
 * 2. 值**非递减**（不是严格递增），且 **timeline 数组顺序才是权威顺序**。
 * 3. 推流没见过的快照独有事件（例如 registry 不持有的 `task.created` / `run.created`）
 *    **借用前一个号的同位号**，绝不占新号。
 *
 * 第 3 条是踩过坑才定下来的：起初给独有事件分配 `previous + 1`，结果它会顶掉紧随其后的
 * live 事件（后者只能再 +1），而生产 run 开头的 `task.created` 恰恰带一个全局
 * AUTOINCREMENT 大号——会把后面**几乎每个**事件的号都顶掉，等于把不变量 1 彻底破坏。
 * 让独有事件与前一个号并列，代价是出现相等值（前端按数组顺序渲染即可，
 * `sequence` 只用于去重与判缺），换来不变量 1 在任何输入下都成立。
 *
 * 边界：进程重启后 registry 为空，快照回落到持久序号，前端此时本就该整体重新对齐。
 */
import type { RunEvent } from '../protocol/run-event';
import type { RunSnapshot } from '../protocol/run-snapshot';

export function alignTimelineSequences(
  timeline: readonly RunEvent[],
  liveEvents: readonly RunEvent[],
): RunEvent[] {
  if (liveEvents.length === 0 || timeline.length === 0) return [...timeline];

  const liveSequenceByEventId = new Map<string, number>(
    liveEvents.map((event) => [event.event_id, event.sequence]),
  );
  const liveSequences = [...liveSequenceByEventId.values()];
  const firstLiveSequence = Math.min(...liveSequences);

  let previous = firstLiveSequence;
  return timeline.map((event) => {
    const liveSequence = liveSequenceByEventId.get(event.event_id);
    if (liveSequence !== undefined) {
      previous = liveSequence;
      return liveSequence === event.sequence ? event : { ...event, sequence: liveSequence };
    }
    // 推流没见过的事件：同位，不占号。
    return previous === event.sequence ? event : { ...event, sequence: previous };
  });
}

/** 便捷包装：只替换 timeline，其余字段原样；没有变化时返回同一个对象。 */
export function withAlignedTimeline(
  snapshot: RunSnapshot,
  liveEvents: readonly RunEvent[],
): RunSnapshot {
  const timeline = alignTimelineSequences(snapshot.timeline, liveEvents);
  if (timeline.every((event, index) => event === snapshot.timeline[index])) return snapshot;
  return { ...snapshot, timeline };
}
