/**
 * DriverStreamEvent → 领域事件的投影：决定 driver 事件流里哪些进事件模型、带什么字段。
 *
 * 契约要点：
 * - 11 类 session/update 与 stderr / disconnect 全部有落点，未知类型也进模型
 *   （`driver.*` 原样保留，其余收进 `driver.session_update_unknown`），不再静默丢弃。
 * - 小字段内联；序列化后超过 PAYLOAD_INLINE_LIMIT_BYTES 的大字段（工具 rawInput /
 *   rawOutput / content、长 stderr、大 chunk）不内联，由 `payload_ref` 指回
 *   driver-stream.jsonl 的原始行（`driver-stream.jsonl#sequence=<n>`，相对 run 目录）。
 *   信封没有 sequence 时无法引用，大字段一律内联——宁可胖，不可丢。
 * - 信封字段 session_id / role_id / event_sequence 统一放 payload 顶层。
 */
import { SCHEMA_VERSION, createId, type Event } from '../core';
import type { DriverStreamEvent } from '../driver/contract';

/** payload_ref 指回 driver-stream.jsonl 原始行的引用前缀。 */
export const DRIVER_STREAM_REF_PREFIX = 'driver-stream.jsonl#sequence=';

/** 载荷内联上限（JSON 序列化字节）。超限字段走 payload_ref，不进事件模型。 */
export const PAYLOAD_INLINE_LIMIT_BYTES = 8 * 1024;

export function projectDriverStreamLifecycleEvent(event: DriverStreamEvent): Event | undefined {
  const rawPayload = recordValue(event.payload);
  const update = recordValue(rawPayload?.update);
  const hasRef = typeof event.sequence === 'number';
  const payload: Record<string, unknown> = {
    ...(event.session_id ? { session_id: event.session_id } : {}),
    ...(event.role_id ? { role_id: event.role_id } : {}),
    ...(event.sequence !== undefined ? { event_sequence: event.sequence } : {}),
    ...(hasRef ? { payload_ref: `${DRIVER_STREAM_REF_PREFIX}${String(event.sequence)}` } : {}),
  };

  let eventType: string;
  switch (event.event_type) {
    case 'driver.turn_started':
    case 'turn_started':
      eventType = 'driver.turn_started';
      addNumber(payload, 'prompt_length', rawPayload?.prompt_length);
      break;
    case 'driver.turn_completed':
    case 'turn_completed':
      eventType = 'driver.turn_completed';
      // 两条生产路径：driver 自产事件把 stop_reason 放 payload 顶层，旧式
      // turn_completed 放 update.stopReason。两个位置都读，谁有算谁。
      addString(payload, 'stop_reason', rawPayload?.stop_reason ?? update?.stopReason);
      break;
    case 'driver.turn_failed':
    case 'turn_failed':
      eventType = 'driver.turn_failed';
      addString(payload, 'reason', update?.reason ?? rawPayload?.error ?? rawPayload?.reason);
      break;
    case 'driver.interrupt_requested':
      eventType = 'driver.interrupt_requested';
      addString(payload, 'reason', rawPayload?.reason);
      break;
    case 'tool_call':
      eventType = 'driver.tool_started';
      addToolFields(payload, update, hasRef);
      break;
    case 'tool_call_update': {
      addToolFields(payload, update, hasRef);
      const status = typeof update?.status === 'string' ? update.status : undefined;
      eventType =
        status === 'completed'
          ? 'driver.tool_completed'
          : status === 'failed'
            ? 'driver.tool_failed'
            : 'driver.tool_progress';
      break;
    }
    case 'agent_message_chunk':
      eventType = 'driver.agent_message_chunk';
      addLarge(payload, 'content', update?.content, hasRef);
      break;
    case 'agent_thought_chunk':
      eventType = 'driver.agent_thought_chunk';
      addLarge(payload, 'content', update?.content, hasRef);
      break;
    case 'user_message_chunk':
      eventType = 'driver.user_message_chunk';
      addLarge(payload, 'content', update?.content, hasRef);
      break;
    case 'plan':
      eventType = 'driver.plan_updated';
      addLarge(payload, 'entries', update?.entries, hasRef);
      break;
    case 'available_commands_update':
      eventType = 'driver.available_commands_updated';
      addLarge(payload, 'available_commands', update?.availableCommands, hasRef);
      break;
    case 'current_mode_update':
      eventType = 'driver.mode_changed';
      addString(payload, 'current_mode_id', update?.currentModeId);
      break;
    case 'config_option_update':
      eventType = 'driver.config_options_changed';
      addLarge(payload, 'config_options', update?.configOptions, hasRef);
      break;
    case 'session_info_update':
      eventType = 'driver.session_info_changed';
      addString(payload, 'title', update?.title);
      addString(payload, 'updated_at', update?.updatedAt);
      break;
    case 'usage_update':
      eventType = 'driver.usage_updated';
      addNumber(payload, 'used', update?.used);
      addNumber(payload, 'size', update?.size);
      addLarge(payload, 'cost', update?.cost, hasRef);
      break;
    case 'stderr':
      eventType = 'driver.stderr';
      addLarge(payload, 'text', typeof event.payload === 'string' ? event.payload : undefined, hasRef);
      break;
    case 'disconnect':
      eventType = 'driver.disconnected';
      addLarge(payload, 'exit_status', rawPayload, hasRef);
      break;
    default:
      // 未知类型不再静默丢弃：driver.* 原样进模型，协议侧新增类型收进统一的未知桶，
      // 带上源类型名，消费者按需自行展开。
      eventType = event.event_type.startsWith('driver.')
        ? event.event_type
        : 'driver.session_update_unknown';
      if (eventType === 'driver.session_update_unknown') payload.source_event_type = event.event_type;
      addLarge(payload, 'raw', event.payload, hasRef);
      break;
  }

  return {
    event_id: createId('run_event'),
    event_type: eventType,
    subject_id: event.run_id ?? event.session_id ?? event.event_type,
    ...(event.run_id ? { run_id: event.run_id } : {}),
    ...(event.task_id ? { task_id: event.task_id } : {}),
    payload,
    created_at: event.created_at ?? new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
  };
}

/**
 * 工具调用的身份与细节。tool_call 与 tool_call_update 共用——update 是部分更新，
 * 缺席的字段自然跳过，由上层把多次投影叠加起来看全貌。
 */
function addToolFields(
  payload: Record<string, unknown>,
  update: Record<string, unknown> | undefined,
  hasRef: boolean,
): void {
  addString(payload, 'tool_call_id', update?.toolCallId);
  addString(payload, 'title', update?.title);
  addString(payload, 'kind', update?.kind);
  addString(payload, 'status', update?.status);
  const meta = recordValue(update?._meta);
  const claudeCode = recordValue(meta?.claudeCode);
  addString(payload, 'tool_name', claudeCode?.toolName);
  addLarge(payload, 'locations', update?.locations, hasRef);
  addLarge(payload, 'raw_input', update?.rawInput, hasRef);
  addLarge(payload, 'raw_output', update?.rawOutput, hasRef);
  addLarge(payload, 'content', update?.content, hasRef);
}

function addString(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) target[key] = value;
}

function addNumber(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value)) target[key] = value;
}

/**
 * 大字段的内联/外置判定。超限且可引用时跳过内联（payload_ref 已指向原始行）；
 * 不可引用时无论多大都内联——投影的底线是信息不丢。
 */
function addLarge(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  hasRef: boolean,
): void {
  if (value === undefined) return;
  if (hasRef) {
    const bytes = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
    if (bytes > PAYLOAD_INLINE_LIMIT_BYTES) return;
  }
  target[key] = value;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
