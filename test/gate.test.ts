import { describe, it, expect } from 'vitest';
import { SCHEMA_VERSION, nowTimestamp } from '../src/core';
import {
  BaseGateRunner,
  CommandRunner,
  PromptRunner,
  CompositeRunner,
  HttpRunner,
  DecisionAggregator,
  PriorityGateScheduler,
  type GateDefinition,
  type GateRequest,
  type GateResult,
  type SubGateRef,
  type GateRunner,
  type GateDecision,
} from '../src/gate';

// Helper to construct mock results safely without using 'any'
function makeMockResult(decision: GateDecision, gateId: string): GateResult {
  return {
    gate_result_id: 'res-id',
    gate_id: gateId,
    gate_point: 'point',
    request_id: 'req-id',
    decision,
    reason: 'mock reason',
    required_actions: [],
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  } as unknown as GateResult;
}

describe('Gate Runners', () => {
  it('BaseGateRunner.build should create appropriate subclass runners', () => {
    const cmdDef: GateDefinition = {
      type: 'command',
      command: 'echo "hello"',
      retry_threshold: 3,
      outputConfig: { on_fail: 'deny' },
    };
    const runner = BaseGateRunner.build('gate-1', cmdDef);
    expect(runner).toBeInstanceOf(CommandRunner);
    expect(runner.gate_id).toBe('gate-1');

    const promptDef: GateDefinition = {
      type: 'prompt',
      model: 'gemini-pro',
      prompt: 'Check code',
      retry_threshold: 1,
      outputConfig: {},
    };
    const prRunner = BaseGateRunner.build('gate-2', promptDef);
    expect(prRunner).toBeInstanceOf(PromptRunner);

    const httpDef: GateDefinition = {
      type: 'http',
      input: 'https://example.com/api',
      retry_threshold: 2,
      outputConfig: {},
    };
    const httpRunner = BaseGateRunner.build('gate-3', httpDef);
    expect(httpRunner).toBeInstanceOf(HttpRunner);

    const compDef: GateDefinition = {
      type: 'composite',
      gates: [{ gate_id: 'sub-1' }],
      retry_threshold: 1,
      outputConfig: {},
    };
    const resolver = async (_gateId: string): Promise<GateRunner> => ({}) as GateRunner;
    const compRunner = BaseGateRunner.build('gate-4', compDef, resolver);
    expect(compRunner).toBeInstanceOf(CompositeRunner);
  });

  it('CommandRunner should execute a command successfully and return allow', async () => {
    const cmdDef: GateDefinition = {
      type: 'command',
      command: 'node -e "process.exit(0)"',
      retry_threshold: 3,
      outputConfig: { on_fail: 'deny' },
    };
    const runner = BaseGateRunner.build('command-gate', cmdDef);
    const request: GateRequest = {
      gate_id: 'command-gate',
      gate_point: 'task.completed',
      request_id: 'req-1',
      priority: 100,
      denying: true,
      timeout_ms: 5000,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
    const result = await runner.run(request);
    expect(result.decision).toBe('allow');
    expect(result.reason).toContain('Command executed successfully');
    expect(result.audit_ref).toBe('audit://command/command-gate/req-1');
  });

  it('CommandRunner should handle failed command with exit code and outputConfig on_fail', async () => {
    const cmdDef: GateDefinition = {
      type: 'command',
      command: 'node -e "process.exit(5)"',
      retry_threshold: 3,
      outputConfig: { on_fail: 'ask' },
    };
    const runner = BaseGateRunner.build('command-gate-fail', cmdDef);
    const request: GateRequest = {
      gate_id: 'command-gate-fail',
      gate_point: 'task.completed',
      request_id: 'req-2',
      priority: 100,
      denying: true,
      timeout_ms: 5000,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
    const result = await runner.run(request);
    expect(result.decision).toBe('ask');
    expect(result.reason).toContain('failed with exit code 5');
    expect(result.required_actions).toContain('inspect-logs');
  });
});

describe('DecisionAggregator with Composite rules', () => {
  it('DecisionAggregator.aggregate should return strictest decision', () => {
    const aggregator = new DecisionAggregator();
    const results: GateResult[] = [
      makeMockResult('allow', 'g1'),
      makeMockResult('defer', 'g2'),
      makeMockResult('ask', 'g3'),
    ];
    const finalResult = aggregator.aggregate(results);
    expect(finalResult.decision).toBe('ask');
  });

  it('aggregateComposite should downgrade deny to allow for optional sub-gates', () => {
    const aggregator = new DecisionAggregator();
    const results: GateResult[] = [
      makeMockResult('deny', 'g-opt'),
      makeMockResult('allow', 'g-req'),
    ];
    const subGates: SubGateRef[] = [
      { gate_id: 'g-opt', required: false },
      { gate_id: 'g-req', required: true },
    ];
    const finalResult = aggregator.aggregateComposite(results, subGates);
    expect(finalResult.decision).toBe('allow');
  });

  it('aggregateComposite should keep deny for required sub-gates', () => {
    const aggregator = new DecisionAggregator();
    const results: GateResult[] = [
      makeMockResult('deny', 'g-req'),
      makeMockResult('allow', 'g-opt'),
    ];
    const subGates: SubGateRef[] = [
      { gate_id: 'g-req', required: true },
      { gate_id: 'g-opt', required: false },
    ];
    const finalResult = aggregator.aggregateComposite(results, subGates);
    expect(finalResult.decision).toBe('deny');
  });
});

describe('CompositeRunner', () => {
  it('should run subgates and aggregate results using composite rules', async () => {
    const definitions: Record<string, GateDefinition> = {
      'composite-gate': {
        type: 'composite',
        gates: [
          { gate_id: 'sub-allow', required: true },
          { gate_id: 'sub-deny-optional', required: false },
        ],
        retry_threshold: 1,
        outputConfig: {},
      },
      'sub-allow': {
        type: 'command',
        command: 'node -e "process.exit(0)"',
        retry_threshold: 1,
        outputConfig: {},
      },
      'sub-deny-optional': {
        type: 'command',
        command: 'node -e "process.exit(1)"',
        retry_threshold: 1,
        outputConfig: { on_fail: 'deny' },
      },
    };

    const resolver = async (gateId: string): Promise<GateRunner> => {
      return BaseGateRunner.build(gateId, definitions[gateId]!, resolver);
    };

    const runner = BaseGateRunner.build('composite-gate', definitions['composite-gate']!, resolver);
    const request: GateRequest = {
      gate_id: 'composite-gate',
      gate_point: 'task.completed',
      request_id: 'req-3',
      priority: 100,
      denying: true,
      timeout_ms: 5000,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };

    const result = await runner.run(request);
    expect(result.decision).toBe('allow');
    expect(result.reason).toContain('Composite gate evaluation');
  });
});

describe('GateScheduler', () => {
  it('should schedule GateRequests based on priority descending', async () => {
    const scheduler2 = new PriorityGateScheduler();
    const resolvedOrder: string[] = [];

    // Override internal executeRequest to track exact call ordering typesafely
    const schedulerAccessor = scheduler2 as unknown as {
      executeRequest: (req: GateRequest) => Promise<GateResult>;
    };
    schedulerAccessor.executeRequest = async (req: GateRequest) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      resolvedOrder.push(req.gate_id);
      return makeMockResult('allow', req.gate_id);
    };

    scheduler2.initialize({
      definitions: {
        g1: { type: 'command', retry_threshold: 1, outputConfig: {} },
        g2: { type: 'command', retry_threshold: 1, outputConfig: {} },
        g3: { type: 'command', retry_threshold: 1, outputConfig: {} },
      },
      concurrency: 1,
    });

    const r1: GateRequest = { gate_id: 'g1', priority: 10 } as unknown as GateRequest;
    const r2: GateRequest = { gate_id: 'g2', priority: 50 } as unknown as GateRequest;
    const r3: GateRequest = { gate_id: 'g3', priority: 100 } as unknown as GateRequest;

    // Trigger r1 first (starts immediately because queue is empty)
    const p1 = scheduler2.insert(r1);

    // Queue up r2 and r3 while r1 is running.
    // They will reside in the queue and be sorted based on priority descending: r3 (100) before r2 (50)
    const p2 = scheduler2.insert(r2);
    const p3 = scheduler2.insert(r3);

    await Promise.all([p1, p2, p3]);

    // r1 finishes first, then r3 executes as it has higher priority than r2
    expect(resolvedOrder).toEqual(['g1', 'g3', 'g2']);
  });
});
