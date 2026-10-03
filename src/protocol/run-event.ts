/** Stable frontend-facing run event view model. */
import { z } from 'zod';

export const runEventSourceSchema = z.enum([
  'coordinator',
  'agent',
  'driver',
  'memory',
  'gate',
  'council',
]);

export type RunEventSource = z.infer<typeof runEventSourceSchema>;

export const runEventSchema = z
  .object({
    event_id: z.string().min(1),
    sequence: z.number().int().positive(),
    run_id: z.string().min(1),
    task_id: z.string().min(1),
    type: z.string().min(1),
    source: runEventSourceSchema,
    created_at: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    /**
     * 这里**刻意没有**顶层 `payload_ref`。
     *
     * 它曾经被声明过，但**从未被填充**：driver 流投影把引用写进了载荷内部，即
     * `payload.payload_ref`（形如 `driver-stream.jsonl#stream_sequence=<n>`）。一个
     * 「声明了但永不出现」的契约字段比没有更危险——读契约的人会去顶层找，找不到就
     * 以为引用丢了。所以声明被删掉，真实位置写在这里。
     *
     * 取回接口：`run.getPayload`（按引用取回 `driver-stream.jsonl` 的原始行）。
     */
    schema_version: z.string().min(1),
  })
  .strict();

export type RunEvent = z.infer<typeof runEventSchema>;

export function projectRunEventSource(type: string): RunEventSource {
  if (type.startsWith('agent.')) return 'agent';
  if (type.startsWith('driver.')) return 'driver';
  if (type.startsWith('memory.') || type.startsWith('buffer.')) return 'memory';
  if (type.startsWith('gate.')) return 'gate';
  if (type.startsWith('council.')) return 'council';
  return 'coordinator';
}
