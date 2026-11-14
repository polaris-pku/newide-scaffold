/**
 * 阶段事件的唯一出口。
 *
 * 抽成独立模块是为了让阶段执行器与角色自主循环共用同一个出口，而不必让两者互相引用
 * 形成模块环。事件计数
 * 与「是否有人监听」解耦：事件已经产生就先计数，监听方随后抛错不该让它从计数里消失。
 */
import { SCHEMA_VERSION, createId, nowTimestamp, type Event } from '../core';
import type { TaskStageExecutionContext } from '../coordination';
import type { TaskResumeCursor } from '../persistence';
import { recordRunEventConsumed } from '../telemetry';

export function emitStageEvent<TCursor extends TaskResumeCursor>(
  context: Pick<TaskStageExecutionContext<TCursor>, 'task_id' | 'run_id' | 'on_event'>,
  eventType: string,
  subjectId: string,
  payload: Record<string, unknown>,
): void {
  if (!context.on_event) return;
  const event: Event = {
    event_id: createId('event'),
    event_type: eventType,
    subject_id: subjectId,
    task_id: context.task_id,
    run_id: context.run_id,
    payload,
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
  // 只在这一处计数：这是全部阶段事件的唯一出口，计数因此不可能漏掉某个调用点。
  // 放在 on_event 之前——事件此时已经产生，消费方随后抛错不该让它从计数里消失。
  recordRunEventConsumed(eventType, payload);
  context.on_event(event);
}
