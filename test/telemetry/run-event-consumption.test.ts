/**
 * RunEventConsumptionRecorder 的计数与副作用边界测试。
 *
 * 守四件事：按 `event_type` 的分类计数与体积累加、提交批次计数、汇总信号只在收尾发
 * 一次且发的是登记过的类型、观测出错不能影响被测调用（没有人绑 recorder 时是空转）。
 *
 * 与 audit.jsonl 的**集合关系**对账不在这里——它需要真实的阶段出口与落库路径，
 * 由 test/app/task-execution-loop.test.ts 与生产冒烟覆盖。
 */

import { describe, expect, it } from 'vitest';
import {
  InMemoryTelemetrySink,
  RunEventConsumptionRecorder,
  getRunEventConsumptionRecorder,
  recordRunEventCommittedBatch,
  recordRunEventConsumed,
  requireTelemetryCatalogEntry,
  runWithRunEventConsumption,
  type TelemetrySink,
} from '../../src/telemetry';

function createRecorder(sink?: TelemetrySink): RunEventConsumptionRecorder {
  return new RunEventConsumptionRecorder({
    run_id: 'run_consumption',
    task_id: 'task_consumption',
    ...(sink ? { sink } : {}),
  });
}

/** 会在 emit 时抛错的 sink，用于验证埋点失败不会外溢。 */
class ExplodingSink implements TelemetrySink {
  emit(): void {
    throw new Error('sink exploded');
  }
}

describe('RunEventConsumptionRecorder', () => {
  it('按 event_type 分类计次并累加 payload 体积', () => {
    const recorder = createRecorder();

    recorder.consume('market.selected', { winner_agent_id: 'agent_a' });
    recorder.consume('memory.context_pack_built', { pack_ref: 'pack_1' });
    recorder.consume('market.selected', { winner_agent_id: 'agent_b' });

    const totals = recorder.snapshot();
    expect(totals.total_events).toBe(3);
    expect(totals.by_type['market.selected']?.count).toBe(2);
    expect(totals.by_type['memory.context_pack_built']?.count).toBe(1);
    // 体积合计必须等于分类之和，否则「按类型看谁大」与总量对不上账。
    const byTypeBytes = Object.values(totals.by_type).reduce(
      (sum, entry) => sum + entry.payload_bytes,
      0,
    );
    expect(totals.payload_bytes).toBe(byTypeBytes);
    expect(totals.payload_bytes).toBeGreaterThan(0);
  });

  it('按 UTF-8 字节算体积，不按字符数', () => {
    const recorder = createRecorder();
    // 6 个汉字：字符长度 6，UTF-8 却是 18 字节（另加两个引号 20）。中文 payload 在这个仓
    // 很常见，用 .length 会系统性少算，报告里的「事件体积」就失去意义。
    recorder.consume('council.decision', { 摘要: '通过评审' });
    expect(recorder.snapshot().payload_bytes).toBe(Buffer.byteLength('{"摘要":"通过评审"}', 'utf-8'));
  });

  it('payload 序列化不了时记 0 字节而不是抛错', () => {
    const recorder = createRecorder();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => recorder.consume('weird.event', circular)).not.toThrow();
    expect(recorder.snapshot().payload_bytes).toBe(0);
    expect(recorder.snapshot().total_events).toBe(1);
  });

  it('分类结果的键序稳定，便于逐字节比对两份快照', () => {
    const first = createRecorder();
    const second = createRecorder();
    for (const [recorder, order] of [
      [first, ['b.event', 'a.event', 'c.event']],
      [second, ['c.event', 'a.event', 'b.event']],
    ] as const) {
      for (const type of order) recorder.consume(type, {});
    }
    expect(Object.keys(first.snapshot().by_type)).toEqual(
      Object.keys(second.snapshot().by_type),
    );
  });

  it('累计提交批次与条数', () => {
    const recorder = createRecorder();

    recorder.commitBatch(2);
    recorder.commitBatch(0);
    recorder.commitBatch(5);

    const totals = recorder.snapshot();
    // 空批次也算一批：它同样是一次提交事务，不能被悄悄忽略。
    expect(totals.committed_batches).toBe(3);
    expect(totals.committed_events).toBe(7);
  });

  it('收尾发出两条汇总信号，且类型都在目录里登记过', async () => {
    const sink = new InMemoryTelemetrySink();
    const recorder = createRecorder(sink);
    recorder.consume('market.selected', { winner_agent_id: 'agent_a' });
    recorder.commitBatch(3);

    const totals = await recorder.finish();

    const records = sink.list();
    expect(records.map((record) => record.event_type)).toEqual([
      'run.event_consumed',
      'run.event_committed_batch',
    ]);
    expect(records[0]?.payload).toMatchObject({
      total_events: totals.total_events,
      by_type: totals.by_type,
    });
    expect(records[1]?.payload).toMatchObject({ committed_batches: 1, committed_events: 3 });
    // 信号必须归到 run 上，否则聚合报告无法按 run 分组。
    expect(records.every((record) => record.run_id === 'run_consumption')).toBe(true);
  });

  it('sink 抛错时收尾照常返回汇总', async () => {
    const recorder = createRecorder(new ExplodingSink());
    recorder.consume('market.selected', {});

    const totals = await recorder.finish();

    expect(totals.total_events).toBe(1);
  });

  it('没有 sink 时只留内存计数', async () => {
    const recorder = createRecorder();
    recorder.consume('market.selected', {});
    await expect(recorder.finish()).resolves.toMatchObject({ total_events: 1 });
  });

  it('没有绑定 recorder 时埋点是空转', () => {
    expect(getRunEventConsumptionRecorder()).toBeUndefined();
    expect(() => {
      recordRunEventConsumed('market.selected', { winner_agent_id: 'agent_a' });
      recordRunEventCommittedBatch(3);
    }).not.toThrow();
  });

  it('ALS 绑定后，深处异步调用记的账归到同一个 run', async () => {
    const recorder = createRecorder();

    await runWithRunEventConsumption(recorder, async () => {
      // 隔一层 await，验证上下文确实跟着异步链走，而不是靠同步调用栈。
      await Promise.resolve();
      recordRunEventConsumed('council.decision', { decision: 'approved' });
      recordRunEventCommittedBatch(1);
    });

    expect(recorder.snapshot()).toMatchObject({
      total_events: 1,
      committed_batches: 1,
      committed_events: 1,
    });
    // 作用域退出后必须恢复空转，否则下一个 run 会记到上一个 run 的账上。
    expect(getRunEventConsumptionRecorder()).toBeUndefined();
  });

  it('本 PR 新增的两个事件类型已登记进目录', () => {
    expect(requireTelemetryCatalogEntry('run.event_consumed').event_type).toBe('run.event_consumed');
    expect(requireTelemetryCatalogEntry('run.event_committed_batch').event_type).toBe(
      'run.event_committed_batch',
    );
  });
});
