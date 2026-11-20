/**
 * 阶段 1：同回复只读并发的 loop 调度测试。
 *
 * 覆盖验收点：
 * - 确定性 deferred fake 证明两条显式只读调查同时进入，活动数不超过冻结上限；
 * - investigate 缺省 read_only / read_only=false / execute / verify / 带验证命令不进入并行组；
 * - 只读与写混排：写启动前只读全部收束，多个写不重叠，tool 消息按原调用顺序回填；
 * - verify 前后 barrier（在途调查收束后才启动，verify 期间不启动其它 Driver）；
 * - 并发下 sequence 不重复、预算预留不会一起越过上限、失败/只读违规互相隔离。
 *
 * 测试只观察 fake 的调用事实（进入/结束顺序、最大活动数、sequence），不依赖固定墙钟。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionStatus } from '../../src/driver';
import { buildExecutionEvidence, hashExecutionEvidence } from '../../src/driver';
import type { ToolCall, ToolCallMessage } from '../../src/memory';
import type {
  RoleBudgetConsumption,
  RoleBudgetPort,
  RoleBudgetSnapshot,
  RoleDispatchInput,
  RoleDispatchObservation,
  RoleDispatchPort,
  RoleFinishValidatorPort,
  RoleFrozenBudget,
  RoleFrozenPolicy,
  RoleLlmCompletion,
  RoleLlmPort,
  RoleLlmUsage,
  RoleLoopContextInput,
  RoleLoopOptions,
} from '../../src/app/role-autonomy-contract';
import {
  ROLE_BUDGET_DEFAULTS,
  ROLE_TOOL_NAMES,
  RoleTerminationError,
} from '../../src/app/role-autonomy-contract';
import { isParallelSafeDispatchCall } from '../../src/app/role-autonomy-tools';
import { runRoleExecutionLoop } from '../../src/app/role-execution-loop';
import {
  FakeFinishValidator,
  FakeJournal,
  FakeMemory,
  FakeDispatchPort,
} from './role-autonomy-test-fixtures';

const CLOCK = (): Date => new Date('2026-11-13T20:00:00.000Z');

function makePolicy(
  budget: RoleFrozenBudget = { limits: { ...ROLE_BUDGET_DEFAULTS }, deadline_at: '2026-11-13T22:00:00.000Z' },
): RoleFrozenPolicy {
  return {
    engine: 'role_autonomy',
    engine_version: 'role-autonomy-v1',
    tool_allowlist: [...ROLE_TOOL_NAMES],
    evidence_only: false,
    buffer_v2: false,
    budget,
    routing: {},
  };
}

function makeContext(overrides: Partial<RoleLoopContextInput> = {}): RoleLoopContextInput {
  return {
    task_id: 'task_parallel',
    run_id: 'run_parallel',
    role_id: 'role_parallel',
    instruction: 'Investigate the two independent areas, then decide',
    response_only_allowed: true,
    ...overrides,
  };
}

let callCounter = 0;

function toolCall(name: string, args: unknown): ToolCall {
  callCounter += 1;
  return {
    id: `p_call_${callCounter}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function readOnlyCall(instruction: string): ToolCall {
  return toolCall('dispatch_execution', { kind: 'investigate', read_only: true, instruction });
}

function completion(toolCalls: ToolCall[]): RoleLlmCompletion {
  return { content: null, tool_calls: toolCalls.length > 0 ? toolCalls : undefined };
}

function finishCall(): ToolCall {
  return toolCall('finish_task', { status: 'completed', summary: 'parallel work finished' });
}

class FakeLlm implements RoleLlmPort {
  readonly calls: Array<{ messages: ToolCallMessage[] }> = [];
  private readonly script: RoleLlmCompletion[];

  constructor(script: RoleLlmCompletion[]) {
    this.script = [...script];
  }

  async completeWithTools(input: {
    messages: ToolCallMessage[];
    tools: unknown[];
  }): Promise<RoleLlmCompletion> {
    this.calls.push({ messages: input.messages.map((message) => ({ ...message })) });
    const next = this.script.shift();
    if (next === undefined) throw new Error('FakeLlm: no scripted completion left');
    return next;
  }
}

class SimpleBudget implements RoleBudgetPort {
  readonly frozen: RoleFrozenBudget;
  readonly consumed: RoleBudgetConsumption = {
    dispatches: 0,
    role_rounds: 0,
    tokens: 0,
    tool_calls: 0,
    tokens_missing: false,
  };

  constructor(frozen: RoleFrozenBudget) {
    this.frozen = frozen;
  }

  snapshot(now?: Date): RoleBudgetSnapshot {
    return {
      frozen: this.frozen,
      consumed: { ...this.consumed },
      wall_clock_remaining_ms: Date.parse(this.frozen.deadline_at) - (now ?? CLOCK()).getTime(),
    };
  }

  assertRoundAllowed(): void {}

  async recordRound(round: number, _usage: RoleLlmUsage | undefined): Promise<void> {
    this.consumed.role_rounds = round;
  }

  assertDispatchAllowed(): void {}

  recordDispatch(): void {
    this.consumed.dispatches += 1;
  }

  assertTokenBudget(): void {}
}

interface Gate {
  promise: Promise<void>;
  resolve: () => void;
}

/** 确定性 deferred 派工：每次 run 停在 gate 上，直到测试显式释放。 */
class DeferredDispatchPort implements RoleDispatchPort {
  readonly calls: RoleDispatchInput[] = [];
  readonly events: Array<{ type: 'start' | 'end'; instruction: string }> = [];
  readonly statuses = new Map<string, ExecutionStatus>();
  readonly violations = new Map<string, string[]>();
  active = 0;
  maxActive = 0;
  private readonly gates = new Map<string, Gate>();

  async run(input: RoleDispatchInput): Promise<RoleDispatchObservation> {
    const key = input.brief.instruction;
    this.calls.push(input);
    this.events.push({ type: 'start', instruction: key });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    input.on_dispatched?.();
    try {
      await this.gate(key).promise;
      const status = this.statuses.get(key) ?? 'succeeded';
      const violations = this.violations.get(key) ?? [];
      const evidence = buildExecutionEvidence({
        dispatch_id: input.brief.dispatch_id,
        observation: {
          transport: { evidence: 'execution_unconfirmed' },
          result: { status: status === 'unknown' ? 'succeeded' : status, response: key },
          ...(status === 'failed'
            ? { error: { code: 'E_SIMULATED', message: 'simulated failure', retryable: false } }
            : {}),
        },
      });
      const evidenceSha256 = hashExecutionEvidence(evidence);
      return {
        dispatch_id: input.brief.dispatch_id,
        status,
        evidence,
        evidence_ref: {
          path: `journal/evidence/${input.brief.dispatch_id}.json`,
          sha256: evidenceSha256,
        },
        evidence_sha256: evidenceSha256,
        violations,
        attempts: 1,
      };
    } finally {
      this.active -= 1;
      this.events.push({ type: 'end', instruction: key });
    }
  }

  release(instruction: string): void {
    this.gate(instruction).resolve();
  }

  releaseAll(): void {
    for (const key of this.gates.keys()) this.gate(key).resolve();
  }

  startIndexOf(instruction: string): number {
    return this.events.findIndex(
      (event) => event.type === 'start' && event.instruction === instruction,
    );
  }

  endIndexOf(instruction: string): number {
    return this.events.findIndex(
      (event) => event.type === 'end' && event.instruction === instruction,
    );
  }

  private gate(key: string): Gate {
    let existing = this.gates.get(key);
    if (existing === undefined) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      existing = { promise, resolve };
      this.gates.set(key, existing);
    }
    return existing;
  }
}

interface Harness {
  options: RoleLoopOptions;
  llm: FakeLlm;
  dispatch: DeferredDispatchPort;
  budget: SimpleBudget;
}

function makeHarness(input: {
  script: RoleLlmCompletion[];
  cap: number;
  maxDispatches?: number;
  compact?: boolean;
}): Harness {
  const journal = new FakeJournal();
  const llm = new FakeLlm(input.script);
  const dispatch = new DeferredDispatchPort();
  const memory = new FakeMemory();
  const finish: RoleFinishValidatorPort = new FakeFinishValidator();
  const budget = new SimpleBudget({
    limits: {
      ...ROLE_BUDGET_DEFAULTS,
      ...(input.maxDispatches !== undefined ? { max_dispatches: input.maxDispatches } : {}),
    },
    deadline_at: '2026-11-13T22:00:00.000Z',
  });
  const options: RoleLoopOptions = {
    llm,
    journal,
    dispatch,
    memory,
    policy: makePolicy(budget.frozen),
    context: makeContext(),
    budget,
    finish,
    consumed: {
      dispatches: 0,
      role_rounds: 0,
      tokens: 0,
      tool_calls: 0,
      tokens_missing: false,
    },
    limits: { max_parallel_dispatches: input.cap },
    clock: CLOCK,
  };
  return { options, llm, dispatch, budget };
}

function toolContents(call: { messages: ToolCallMessage[] }): string[] {
  return call.messages
    .filter((message) => message.role === 'tool')
    .map((message) => message.content ?? '');
}

describe('阶段 1：同回复只读并发', () => {
  it('两条显式只读调查同时进入，上限 2 时 maxActive=2，结果按输入顺序回填', async () => {
    const harness = makeHarness({
      cap: 2,
      script: [completion([readOnlyCall('area-a'), readOnlyCall('area-b')]), completion([finishCall()])],
    });
    const run = runRoleExecutionLoop(harness.options);

    await vi.waitFor(() => expect(harness.dispatch.calls).toHaveLength(2));
    expect(harness.dispatch.maxActive).toBe(2);
    expect(harness.dispatch.calls.map((call) => call.brief.sequence)).toEqual([1, 2]);

    // 先释放第二条：结果消息仍按调用顺序回填。
    harness.dispatch.release('area-b');
    harness.dispatch.release('area-a');
    const outcome = await run;

    expect(outcome.status).toBe('completed');
    const secondRoundTools = toolContents(harness.llm.calls[1]!);
    expect(secondRoundTools).toHaveLength(2);
    expect(secondRoundTools[0]).toContain(
      harness.dispatch.calls[0]!.brief.dispatch_id,
    );
    expect(secondRoundTools[1]).toContain(
      harness.dispatch.calls[1]!.brief.dispatch_id,
    );
  });

  it('三条只读调查在上限 2 下从不超过上限', async () => {
    const harness = makeHarness({
      cap: 2,
      script: [
        completion([readOnlyCall('one'), readOnlyCall('two'), readOnlyCall('three')]),
        completion([finishCall()]),
      ],
    });
    const run = runRoleExecutionLoop(harness.options);

    await vi.waitFor(() => expect(harness.dispatch.calls).toHaveLength(2));
    expect(harness.dispatch.maxActive).toBe(2);
    harness.dispatch.release('one');
    await vi.waitFor(() => expect(harness.dispatch.calls).toHaveLength(3));
    expect(harness.dispatch.maxActive).toBe(2);
    harness.dispatch.releaseAll();
    await expect(run).resolves.toMatchObject({ status: 'completed' });
  });

  it('写/verify/缺省只读等调用不会进入并行组（与只读混排时 maxActive 恒为 1）', async () => {
    const cases: Array<{ name: string; unsafe: ToolCall }> = [
      {
        name: 'investigate without explicit read_only',
        unsafe: toolCall('dispatch_execution', { kind: 'investigate', instruction: 'implicit' }),
      },
      {
        name: 'read_only=false',
        unsafe: toolCall('dispatch_execution', {
          kind: 'execute',
          read_only: false,
          instruction: 'write',
        }),
      },
      { name: 'execute', unsafe: toolCall('dispatch_execution', { kind: 'execute', instruction: 'exec' }) },
      { name: 'verify', unsafe: toolCall('dispatch_execution', { kind: 'verify', instruction: 'verify' }) },
      {
        name: 'verify with verification_command',
        unsafe: toolCall('dispatch_execution', {
          kind: 'verify',
          instruction: 'run check',
          session: { mode: 'fresh' },
          verification_command: { executable: 'node', args: ['-e', '0'] },
        }),
      },
    ];
    for (const testCase of cases) {
      const journal = new FakeJournal();
      const llm = new FakeLlm([completion([readOnlyCall('safe'), testCase.unsafe]), completion([finishCall()])]);
      const dispatch = new FakeDispatchPort(journal);
      const options: RoleLoopOptions = {
        llm,
        journal,
        dispatch,
        memory: new FakeMemory(),
        policy: makePolicy(),
        context: makeContext(),
        budget: new SimpleBudget({
          limits: { ...ROLE_BUDGET_DEFAULTS },
          deadline_at: '2026-11-13T22:00:00.000Z',
        }),
        finish: new FakeFinishValidator(),
        consumed: { dispatches: 0, role_rounds: 0, tokens: 0, tool_calls: 0, tokens_missing: false },
        limits: { max_parallel_dispatches: 2 },
        clock: CLOCK,
      };
      await runRoleExecutionLoop(options);
      expect(dispatch.maxActive, testCase.name).toBe(1);
    }
  });

  it('带 verification_command 的 investigate 形状即使避开 schema 也不会被当作并行安全', () => {
    const call = toolCall('dispatch_execution', {
      kind: 'investigate',
      read_only: true,
      instruction: 'investigate with command',
      verification_command: { executable: 'node', args: ['-e', '0'] },
    });
    expect(isParallelSafeDispatchCall(call)).toBe(false);
  });

  it('只读与写混排：写启动前只读全部收束，多个写不重叠，tool 消息按原顺序回填', async () => {
    const calls = [
      readOnlyCall('a'),
      readOnlyCall('b'),
      toolCall('dispatch_execution', { kind: 'execute', instruction: 'write-1' }),
      toolCall('dispatch_execution', { kind: 'execute', instruction: 'write-2' }),
      readOnlyCall('d'),
    ];
    const harness = makeHarness({
      cap: 2,
      script: [completion(calls), completion([finishCall()])],
    });
    const run = runRoleExecutionLoop(harness.options);

    await vi.waitFor(() => expect(harness.dispatch.calls).toHaveLength(2));
    expect(harness.dispatch.maxActive).toBe(2);
    harness.dispatch.release('b');
    harness.dispatch.release('a');

    // 两个只读都结束之后，第一个写才启动。
    await vi.waitFor(() => expect(harness.dispatch.calls).toHaveLength(3));
    const writeOneStart = harness.dispatch.startIndexOf('write-1');
    expect(writeOneStart).toBeGreaterThan(harness.dispatch.endIndexOf('a'));
    expect(writeOneStart).toBeGreaterThan(harness.dispatch.endIndexOf('b'));
    // 写在途时，后面的写与只读都不得启动。
    expect(harness.dispatch.calls).toHaveLength(3);

    harness.dispatch.release('write-1');
    await vi.waitFor(() => expect(harness.dispatch.calls).toHaveLength(4));
    // 多个写之间不重叠：第二个写必须在第一个写结束之后。
    expect(harness.dispatch.startIndexOf('write-2')).toBeGreaterThan(
      harness.dispatch.endIndexOf('write-1'),
    );

    harness.dispatch.release('write-2');
    await vi.waitFor(() => expect(harness.dispatch.calls).toHaveLength(5));
    expect(harness.dispatch.startIndexOf('d')).toBeGreaterThan(
      harness.dispatch.endIndexOf('write-2'),
    );
    harness.dispatch.release('d');
    const outcome = await run;
    expect(outcome.status).toBe('completed');
    // tool 结果消息顺序 = 输入 tool_calls 顺序（与完成顺序无关）。
    const toolCallIds = harness.llm.calls[1]!.messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.tool_call_id);
    expect(toolCallIds).toEqual(calls.map((call) => call.id));
  });

  it('verify 作为独占 barrier：在途调查收束后才启动，期间不启动其它 Driver', async () => {
    const harness = makeHarness({
      cap: 3,
      script: [
        completion([
          readOnlyCall('survey-1'),
          readOnlyCall('survey-2'),
          toolCall('dispatch_execution', { kind: 'verify', instruction: 'verify-all' }),
          readOnlyCall('after-verify'),
        ]),
        completion([finishCall()]),
      ],
    });
    const run = runRoleExecutionLoop(harness.options);

    await vi.waitFor(() => expect(harness.dispatch.calls).toHaveLength(2));
    expect(harness.dispatch.maxActive).toBe(2);
    harness.dispatch.release('survey-1');
    harness.dispatch.release('survey-2');

    await vi.waitFor(() => expect(harness.dispatch.calls).toHaveLength(3));
    const verifyStart = harness.dispatch.startIndexOf('verify-all');
    expect(verifyStart).toBeGreaterThan(harness.dispatch.endIndexOf('survey-1'));
    expect(verifyStart).toBeGreaterThan(harness.dispatch.endIndexOf('survey-2'));
    expect(harness.dispatch.calls).toHaveLength(3);

    harness.dispatch.release('verify-all');
    await vi.waitFor(() => expect(harness.dispatch.calls).toHaveLength(4));
    expect(harness.dispatch.startIndexOf('after-verify')).toBeGreaterThan(
      harness.dispatch.endIndexOf('verify-all'),
    );
    harness.dispatch.release('after-verify');
    const outcome = await run;
    expect(outcome.dispatches.map((dispatch) => dispatch.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
  });

  it('并发下 sequence 唯一且预算预留不会一起越过上限', async () => {
    const harness = makeHarness({
      cap: 2,
      maxDispatches: 1,
      script: [completion([readOnlyCall('first'), readOnlyCall('second')])],
    });
    const run = runRoleExecutionLoop(harness.options);
    await vi.waitFor(() => expect(harness.dispatch.calls).toHaveLength(1));
    // 第二条在准入阶段就被预算预留拒绝；释放第一条让 loop 收束。
    harness.dispatch.release('first');
    const error = await run.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RoleTerminationError);
    expect((error as RoleTerminationError).termination.code).toBe('budget_dispatches');
    expect(harness.dispatch.calls).toHaveLength(1);
    expect(harness.budget.consumed.dispatches).toBe(1);
  });

  it('失败与只读违规彼此隔离：另一条只读成功，违规随对应结果返回', async () => {
    const harness = makeHarness({
      cap: 2,
      script: [completion([readOnlyCall('violating'), readOnlyCall('clean')]), completion([finishCall()])],
    });
    harness.dispatch.statuses.set('violating', 'failed');
    harness.dispatch.violations.set('violating', ['read_only_changed']);
    const run = runRoleExecutionLoop(harness.options);

    await vi.waitFor(() => expect(harness.dispatch.calls).toHaveLength(2));
    harness.dispatch.releaseAll();
    const outcome = await run;

    expect(outcome.dispatches.map((dispatch) => dispatch.status)).toEqual(['failed', 'succeeded']);
    const results = toolContents(harness.llm.calls[1]!).map((content) => JSON.parse(content));
    expect(results[0].data.violations).toEqual(['read_only_changed']);
    expect(results[1].data.violations).toEqual([]);
    // 失败不是宿主终止：loop 仍进入下一轮并接受 finish。
    expect(harness.llm.calls).toHaveLength(2);
  });
});
