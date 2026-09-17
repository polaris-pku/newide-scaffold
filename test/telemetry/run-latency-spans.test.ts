/**
 * run-latency span 登记处的不变式测试。
 *
 * 这些断言守的是「名字与 layer 单一来源」这件事本身，与 recorder 的计时行为无关，
 * 所以独立成文件：以后任何人往登记处加 span 或改 span 名，先在这里被挡住。
 */

import { describe, expect, it } from 'vitest';
import {
  DRIVER_TIMING_MILESTONES,
  RUN_LATENCY_SPANS,
  agentToolSpan,
  driverMilestoneSpan,
  latencySpan,
  resolveRunLatencySpan,
  stageSpan,
  type RunLatencyLayer,
} from '../../src/telemetry/run-latency-spans';

describe('run-latency span 登记处', () => {
  /**
   * 核心不变式：layer 从名字派生，所以名字前缀必须等于 layer。
   *
   * 漂移的后果不是报错，而是报告按 layer 分组时这些 span 落到意想不到的组里，
   * 看归因的人却无从察觉。这条测试把不变式钉住。
   */
  it('keeps every registered span name prefix equal to its layer', () => {
    // 唯一被允许的例外：根 span。它是报告对齐整个 run 时间轴的锚点，改名会打断
    // 既有 latency.jsonl 的可比性。
    const exceptions = new Set<string>(['run.loop_total']);
    const drifted = Object.entries(RUN_LATENCY_SPANS)
      .filter(([name, layer]) => name.split('.')[0] !== layer)
      .map(([name, layer]) => `${name} -> ${layer}`)
      .filter((entry) => !exceptions.has(entry.split(' -> ')[0]!));

    expect(drifted).toEqual([]);
    // 例外本身也必须被登记处承认，避免「例外」变成随便加的口子。
    expect(RUN_LATENCY_SPANS['run.loop_total']).toBe('loop');
  });

  it('registers every stage cursor the task loop can execute', () => {
    const stageCursors = ['select_agent', 'execute_agent', 'council', 'gate', 'deliver'];
    for (const cursor of stageCursors) {
      expect(RUN_LATENCY_SPANS[`stage.${cursor}` as keyof typeof RUN_LATENCY_SPANS]).toBe('stage');
    }
  });

  it('covers every layer with at least the run-level anchor spans', () => {
    const layers = new Set<RunLatencyLayer>(Object.values(RUN_LATENCY_SPANS));
    expect([...layers].sort()).toEqual(['agent', 'driver', 'facade', 'loop', 'stage']);
  });

  it('derives layer from the name for registered spans and dynamic families', () => {
    expect(latencySpan('facade.retrieve_memory')).toEqual({
      name: 'facade.retrieve_memory',
      layer: 'facade',
    });
    // 动态族：后缀运行时才知道，前缀与 layer 仍由族固定。
    expect(stageSpan('execute_agent')).toEqual({ name: 'stage.execute_agent', layer: 'stage' });
    expect(agentToolSpan('query_memory')).toEqual({
      name: 'agent.tool.query_memory',
      layer: 'agent',
    });
    expect(driverMilestoneSpan('driver.first_output')).toEqual({
      name: 'driver.first_output',
      layer: 'driver',
    });
  });

  it('resolves names and refs through the same registry', () => {
    const fromName = resolveRunLatencySpan('driver.invoke');
    const fromRef = resolveRunLatencySpan(stageSpan('gate'));
    expect(fromName.layer).toBe<RunLatencyLayer>('driver');
    expect(fromRef.name).toBe('stage.gate');
    expect(fromRef.layer).toBe<RunLatencyLayer>('stage');
  });

  it('keeps the driver milestone vocabulary closed', () => {
    expect([...DRIVER_TIMING_MILESTONES]).toEqual([
      'driver.prompt_written',
      'driver.first_output',
      'driver.event_channel',
    ]);
    for (const milestone of DRIVER_TIMING_MILESTONES) {
      expect(driverMilestoneSpan(milestone).name.split('.')[0]).toBe('driver');
    }
  });
});
