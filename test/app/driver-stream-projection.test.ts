/**
 * driver-stream 投影的完整接收契约。
 *
 * 钉住三件事：11 类 session/update 与 stderr/disconnect 全部有落点（含未知类型的
 * 兜底桶，不再静默丢弃）；tool_call / tool_call_update 的字段瘦身与过程态门槛已
 * 解除；大字段超限走 payload_ref 外置，且信封缺 sequence 时宁可内联也不丢。
 */
import { describe, expect, it } from 'vitest';
import {
  PAYLOAD_INLINE_LIMIT_BYTES,
  projectDriverStreamLifecycleEvent,
} from '../../src/app/driver-stream-projection';
import type { DriverStreamEvent } from '../../src/driver/contract';

function sessionEvent(
  sessionUpdate: string,
  updateFields: Record<string, unknown>,
  options: { sequence?: number | null; role_id?: string } = {},
): DriverStreamEvent {
  const sequence = options.sequence === undefined ? 1 : options.sequence;
  return {
    schema_version: 'driver-event.v1',
    event_type: sessionUpdate,
    task_id: 'task_1',
    run_id: 'run_1',
    session_id: 'session_1',
    ...(options.role_id ? { role_id: options.role_id } : {}),
    ...(sequence !== null ? { sequence } : {}),
    created_at: '2026-01-01T00:00:00.000Z',
    payload: {
      sessionId: 'session_1',
      update: { sessionUpdate, ...updateFields },
    },
  };
}

function driverEvent(
  eventType: string,
  payload: unknown,
  options: { sequence?: number } = {},
): DriverStreamEvent {
  return {
    schema_version: 'driver-event.v1',
    event_type: eventType,
    task_id: 'task_1',
    run_id: 'run_1',
    session_id: 'session_1',
    ...(options.sequence !== undefined ? { sequence: options.sequence } : {}),
    created_at: '2026-01-01T00:00:00.000Z',
    payload,
  };
}

function project(event: DriverStreamEvent) {
  const projected = projectDriverStreamLifecycleEvent(event);
  expect(projected).toBeDefined();
  return projected!;
}

describe('projectDriverStreamLifecycleEvent —— 11 类推送流的落点', () => {
  it.each([
    ['tool_call', { toolCallId: 'tc_1', title: 'Edit file', kind: 'edit' }, 'driver.tool_started'],
    ['agent_message_chunk', { content: { type: 'text', text: 'hi' } }, 'driver.agent_message_chunk'],
    [
      'agent_thought_chunk',
      { content: { type: 'text', text: 'hmm' } },
      'driver.agent_thought_chunk',
    ],
    ['user_message_chunk', { content: { type: 'text', text: 'req' } }, 'driver.user_message_chunk'],
    ['plan', { entries: [{ id: 'p1', content: 'step', status: 'pending' }] }, 'driver.plan_updated'],
    [
      'available_commands_update',
      { availableCommands: [{ name: 'review' }] },
      'driver.available_commands_updated',
    ],
    ['current_mode_update', { currentModeId: 'plan' }, 'driver.mode_changed'],
    [
      'config_option_update',
      { configOptions: [{ id: 'model', value: 'x' }] },
      'driver.config_options_changed',
    ],
    ['session_info_update', { title: '会话', updatedAt: '2026-01-01' }, 'driver.session_info_changed'],
    ['usage_update', { used: 1200, size: 200000 }, 'driver.usage_updated'],
  ] as const)('session/update %s → %s', (sessionUpdate, fields, expectedType) => {
    const projected = project(sessionEvent(sessionUpdate, { ...fields }, { sequence: 5 }));
    expect(projected.event_type).toBe(expectedType);
    expect(projected.payload.session_id).toBe('session_1');
    expect(projected.payload.event_sequence).toBe(5);
  });

  it('tool_call_update 的过程态进模型（此前被丢弃），终态保持原映射', () => {
    const inProgress = project(
      sessionEvent('tool_call_update', { toolCallId: 'tc_1', status: 'in_progress' }),
    );
    const pending = project(sessionEvent('tool_call_update', { toolCallId: 'tc_1', status: 'pending' }));
    const completed = project(
      sessionEvent('tool_call_update', { toolCallId: 'tc_1', status: 'completed' }),
    );
    const failed = project(sessionEvent('tool_call_update', { toolCallId: 'tc_1', status: 'failed' }));

    expect(inProgress.event_type).toBe('driver.tool_progress');
    expect(pending.event_type).toBe('driver.tool_progress');
    expect(completed.event_type).toBe('driver.tool_completed');
    expect(failed.event_type).toBe('driver.tool_failed');
  });
});

describe('projectDriverStreamLifecycleEvent —— 工具字段不再瘦身', () => {
  it('tool_call 带出 kind / locations / raw_input / status，tool_name 仍读 _meta', () => {
    const projected = project(
      sessionEvent(
        'tool_call',
        {
          toolCallId: 'tc_9',
          title: 'Edit file',
          kind: 'edit',
          status: 'in_progress',
          locations: [{ path: 'src/a.ts', line: 10 }],
          rawInput: { path: 'src/a.ts' },
          _meta: { claudeCode: { toolName: 'Edit' } },
        },
        { sequence: 2 },
      ),
    );

    expect(projected.payload).toMatchObject({
      tool_call_id: 'tc_9',
      title: 'Edit file',
      kind: 'edit',
      status: 'in_progress',
      tool_name: 'Edit',
      locations: [{ path: 'src/a.ts', line: 10 }],
      raw_input: { path: 'src/a.ts' },
    });
  });

  it('tool_call_update 的 content / raw_output 也带出', () => {
    const projected = project(
      sessionEvent('tool_call_update', {
        toolCallId: 'tc_9',
        status: 'completed',
        content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }],
        rawOutput: { ok: true },
      }),
    );

    expect(projected.payload.content).toEqual([
      { type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' },
    ]);
    expect(projected.payload.raw_output).toEqual({ ok: true });
  });
});

describe('projectDriverStreamLifecycleEvent —— 轮次与驱动事件', () => {
  it('stop_reason 读 payload 顶层（driver 自产事件的真实形状）', () => {
    const projected = project(driverEvent('driver.turn_completed', { stop_reason: 'end_turn' }));
    expect(projected.event_type).toBe('driver.turn_completed');
    expect(projected.payload.stop_reason).toBe('end_turn');
  });

  it('stop_reason 兼容旧式 update.stopReason', () => {
    const projected = project(
      driverEvent('turn_completed', { update: { stopReason: 'max_tokens' } }),
    );
    expect(projected.payload.stop_reason).toBe('max_tokens');
  });

  it('driver.turn_failed 带出错误摘要', () => {
    const projected = project(driverEvent('driver.turn_failed', { error: 'spawn 崩了' }));
    expect(projected.payload.reason).toBe('spawn 崩了');
  });

  it('stderr 与 disconnect 有落点', () => {
    const stderr = project(driverEvent('stderr', 'boom', { sequence: 3 }));
    const disconnect = project(driverEvent('disconnect', { code: 1, signal: null }, { sequence: 4 }));

    expect(stderr.event_type).toBe('driver.stderr');
    expect(stderr.payload.text).toBe('boom');
    expect(disconnect.event_type).toBe('driver.disconnected');
    expect(disconnect.payload.exit_status).toEqual({ code: 1, signal: null });
  });

  it('未知的 driver.* 事件原样进模型，未知协议更新进兜底桶', () => {
    const driverUnknown = project(
      driverEvent('driver.turn_cancel_requested', { reason: 'process_signal' }),
    );
    const protocolUnknown = project(sessionEvent('brand_new_update', { fancy: true }));

    expect(driverUnknown.event_type).toBe('driver.turn_cancel_requested');
    expect(protocolUnknown.event_type).toBe('driver.session_update_unknown');
    expect(protocolUnknown.payload.source_event_type).toBe('brand_new_update');
    expect(protocolUnknown.payload.raw).toMatchObject({ update: { fancy: true } });
  });
});

describe('projectDriverStreamLifecycleEvent —— 大字段外置与内联底线', () => {
  it('超限字段不内联，payload_ref 指回原始行', () => {
    const projected = project(
      sessionEvent(
        'tool_call',
        { toolCallId: 'tc_big', rawInput: { blob: 'x'.repeat(PAYLOAD_INLINE_LIMIT_BYTES) } },
        { sequence: 7 },
      ),
    );

    expect(projected.payload.raw_input).toBeUndefined();
    expect(projected.payload.payload_ref).toBe('driver-stream.jsonl#sequence=7');
  });

  it('小字段照常内联且始终带 payload_ref', () => {
    const projected = project(sessionEvent('plan', { entries: [{ id: 'p1', content: 'x' }] }));
    expect(projected.payload.entries).toEqual([{ id: 'p1', content: 'x' }]);
    expect(projected.payload.payload_ref).toBe('driver-stream.jsonl#sequence=1');
  });

  it('信封缺 sequence 时无法引用，大字段一律内联不丢', () => {
    const big = { blob: 'x'.repeat(PAYLOAD_INLINE_LIMIT_BYTES * 2) };
    const projected = project(
      sessionEvent('tool_call', { toolCallId: 'tc_big', rawInput: big }, { sequence: null }),
    );

    expect(projected.payload.payload_ref).toBeUndefined();
    expect(projected.payload.raw_input).toEqual(big);
  });

  it('信封的 role_id 一并带出', () => {
    const projected = project(
      sessionEvent('usage_update', { used: 1, size: 2 }, { role_id: 'role_a' }),
    );
    expect(projected.payload.role_id).toBe('role_a');
  });
});
