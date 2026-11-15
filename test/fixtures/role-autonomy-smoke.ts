/**
 * rpc:smoke 阶段 4「派工进度 + 终止原因」场景的共享夹具。
 *
 * 职责与核心逻辑：
 * - 提供**确定性 role LLM**：只要工具表里有 `dispatch_execution`（role 自主循环的隔离工具
 *   表），前 `ROLE_SMOKE_DISPATCH_BUDGET` 轮各返回一次派工；之后仍返回一次派工，让宿主的
 *   dispatch 预算检查（`NEWIDE_ROLE_MAX_DISPATCHES=2`）在**真正调用 driver 之前**以 typed
 *   termination `budget_dispatches` 收束。注意：role loop 契约里纯文本/“done”都**不结束**
 *   循环（RD-FIN：零派工也必须显式 finish_task），所以「回一段文本让宿主收束」不成立；
 *   必须再派一次，由 `assertDispatchAllowed` 先于 driver 调用拒绝。
 *   工具表里没有 `dispatch_execution` 时原样回退到传入的 legacy fake，legacy/Council 场景
 *   行为不变（同一份 LLM 客户端被两种路径共用）。
 * - 提供**纯断言函数**：把 run 快照、全量事件、落盘 summary 的口径校验集中在这里，脚本只
 *   负责取数；失败信息带实际值（方便在 CI 里直接看出是哪一条契约漂了）。
 * - 提供该场景的样例报文构造：给前端对照的 `run.create` / 快照 / 事件 / summary 片段。
 *
 * 边界：不读写文件、不派工、不启动服务；断言函数不做任何 I/O。
 */
import path from 'node:path';
import type { ToolCallingClient } from '../../src/memory';
import { ROLE_DISPATCH_EVENT } from '../../src/app/run-dispatch-events';

/** 该场景冻结的 dispatch 预算：前两次派工成功，第三次被宿主预算拒绝。 */
export const ROLE_SMOKE_DISPATCH_BUDGET = 2;

/** 预期 typed termination 原因码（artifact 预算终止仍是 C 层 failed 终态）。 */
export const ROLE_SMOKE_TERMINATION_CODE = 'budget_dispatches';

/** samples 里该场景使用的键名（前端按这个键对照样例报文）。 */
export const ROLE_SMOKE_SAMPLE_KEY = 'role_autonomy_dispatch_termination';

/** 该场景用到的 run 目录落盘文件（终态 evidence）。 */
export const ROLE_SMOKE_RUN_FILES = [
  'result.json',
  'summary.json',
  'frontend-snapshot.json',
] as const;

/**
 * 该场景必需的环境变量：role 自主循环开、阶段 3 两个开关显式关（避免用户 shell 里的
 * 残留值改变语义）、dispatch 预算收紧到 2（默认 12 会跑很久且不叫「预算终止」）。
 */
export function buildRoleSmokeEnv(input: {
  base: NodeJS.ProcessEnv;
  state_root: string;
  runner_dir: string;
}): NodeJS.ProcessEnv {
  return {
    ...input.base,
    ACP_DRIVER_RUNNER_DIR: input.runner_dir,
    NEWIDE_STATE_ROOT: input.state_root,
    // 第二个后端实例必须有自己的 coordination SQLite：否则 shell 里残留的
    // NEWIDE_COORDINATION_DB 会让两个实例写同一份持久 Task/Run 状态。
    NEWIDE_COORDINATION_DB: path.join(input.state_root, 'coordination.sqlite'),
    NEWIDE_ROLE_AUTONOMY: '1',
    NEWIDE_DRIVER_EVIDENCE_ONLY: '0',
    NEWIDE_BUFFER_V2: '0',
    NEWIDE_ROLE_MAX_DISPATCHES: String(ROLE_SMOKE_DISPATCH_BUDGET),
  };
}

/**
 * 确定性 role LLM：识别 role 工具表并稳定返回 `dispatch_execution`。
 *
 * 每次调用返回新 `id`；参数只用模型侧合法字段（身份/sequence/预算由宿主填，
 * RD-DIS-02）。第 `ROLE_SMOKE_DISPATCH_BUDGET + 1` 次调用返回的派工不会到达 driver：
 * `assertDispatchAllowed` 在工具执行入口先抛 `budget_dispatches`。
 */
export function createRoleSmokeLlm(fallback: ToolCallingClient): ToolCallingClient {
  let roleRound = 0;
  return {
    async completeWithTools(input) {
      const exposesRoleTools = input.tools.some(
        (tool) => tool.function.name === 'dispatch_execution',
      );
      if (!exposesRoleTools) return fallback.completeWithTools(input);
      roleRound += 1;
      return {
        content: null,
        tool_calls: [
          {
            id: `role_smoke_dispatch_${String(roleRound)}`,
            type: 'function',
            function: {
              name: 'dispatch_execution',
              arguments: JSON.stringify({
                instruction: `RPC smoke role dispatch ${String(roleRound)}`,
                kind: 'execute',
                acceptance: [],
                constraints: [],
                expected_artifacts: [],
                session: { mode: 'fresh' },
              }),
            },
          },
        ],
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 断言：只依赖对外可观察字段（快照 / 事件 / summary）
// ─────────────────────────────────────────────────────────────

/** 快照里该场景关心的字段（真实 `RunSnapshot` 结构可赋值给它）。 */
export interface RoleSmokeSnapshotView {
  status: string;
  errors: ReadonlyArray<{ code: string; message: string }>;
  dispatch_summary?:
    | {
        total: number;
        by_status: Record<string, number>;
        last_dispatch?: { dispatch_id: string; status: string } | undefined;
        unknown: { count: number };
        violations: { count: number };
      }
    | undefined;
  dispatch_progress?:
    | {
        terminated?: { code: string; actor: string } | undefined;
        finish_requested?: unknown;
      }
    | undefined;
}

/** 事件里该场景关心的字段（真实 `RunEvent` 结构可赋值给它）。 */
export interface RoleSmokeEventView {
  type: string;
  payload: Record<string, unknown>;
}

/** 断言通过后回传的事实，供脚本写进退出汇总 / samples。 */
export interface RoleSmokeFacts {
  termination_code: string;
  termination_actor: string;
  dispatch_ids: string[];
  event_counts: {
    accepted: number;
    started: number;
    settled: number;
    role_terminated: number;
  };
  summary: {
    total: number;
    by_status: Record<string, number>;
    last_dispatch_id: string;
  };
}

export interface RoleSmokeAssertInput {
  snapshot: RoleSmokeSnapshotView;
  events: ReadonlyArray<RoleSmokeEventView>;
  expected_code?: string;
  expected_actor?: string;
  expected_dispatches?: number;
}

/**
 * 校验阶段 4 场景的全部 run 级事实。任一条不满足都抛带实际值的 Error。
 *
 * 明确拒绝「伪造」：`finish_requested` 必须**缺席**（预算终止前 role 没有 finish），
 * `dispatch_progress.terminated` 必须与 `errors[0].code`/actor 同源。
 */
export function assertRoleSmokeDispatchTermination(input: RoleSmokeAssertInput): RoleSmokeFacts {
  const expectedCode = input.expected_code ?? ROLE_SMOKE_TERMINATION_CODE;
  const expectedActor = input.expected_actor ?? 'host';
  const expectedDispatches = input.expected_dispatches ?? ROLE_SMOKE_DISPATCH_BUDGET;
  const { snapshot, events } = input;

  assertEqual(snapshot.status, 'failed', 'run status (typed termination stays a C-layer failed)');
  assert(
    snapshot.errors.length > 0,
    'role autonomy smoke: snapshot has no errors; typed termination reason was lost',
  );
  const error = snapshot.errors[0]!;
  assertEqual(error.code, expectedCode, 'errors[0].code (typed termination mapping)');

  const summary = snapshot.dispatch_summary;
  assert(
    summary !== undefined,
    'role autonomy smoke: snapshot has no dispatch_summary; Journal facts were not projected',
  );
  assertEqual(summary.total, expectedDispatches, 'dispatch_summary.total');
  assertEqual(
    summary.by_status.succeeded ?? 0,
    expectedDispatches,
    'dispatch_summary.by_status.succeeded',
  );
  assertEqual(summary.unknown.count, 0, 'dispatch_summary.unknown.count');
  assertEqual(summary.violations.count, 0, 'dispatch_summary.violations.count');
  assert(
    (summary.last_dispatch?.dispatch_id ?? '').length > 0,
    'role autonomy smoke: dispatch_summary.last_dispatch.dispatch_id is empty',
  );

  const progress = snapshot.dispatch_progress;
  assert(
    progress !== undefined,
    'role autonomy smoke: snapshot has no dispatch_progress; termination reason was not projected',
  );
  assert(
    progress.terminated !== undefined,
    'role autonomy smoke: dispatch_progress.terminated is missing',
  );
  assertEqual(
    progress.terminated.code,
    error.code,
    'dispatch_progress.terminated.code vs errors[0].code',
  );
  assertEqual(progress.terminated.actor, expectedActor, 'dispatch_progress.terminated.actor');
  assert(
    !Object.prototype.hasOwnProperty.call(progress, 'finish_requested'),
    'role autonomy smoke: dispatch_progress.finish_requested must be absent (budget termination never finishes)',
  );

  const accepted = eventsOfType(events, ROLE_DISPATCH_EVENT.accepted);
  const started = eventsOfType(events, ROLE_DISPATCH_EVENT.started);
  const settled = eventsOfType(events, ROLE_DISPATCH_EVENT.settled);
  const terminated = eventsOfType(events, ROLE_DISPATCH_EVENT.role_terminated);
  assertEqual(accepted.length, expectedDispatches, 'agent.dispatch_accepted event count');
  assertEqual(started.length, expectedDispatches, 'agent.dispatch_started event count');
  assertEqual(settled.length, expectedDispatches, 'agent.dispatch_settled event count');
  assertEqual(terminated.length, 1, 'agent.role_terminated event count');

  const acceptedIds = uniqueIds(accepted);
  const startedIds = uniqueIds(started);
  const settledIds = uniqueIds(settled);
  assertEqual(acceptedIds.length, expectedDispatches, 'accepted dispatch_id unique count');
  assertEqual(settledIds.length, expectedDispatches, 'settled dispatch_id unique count');
  assertEqual(sortedKey(acceptedIds), sortedKey(settledIds), 'accepted/settled dispatch_id sets');
  for (const dispatchId of startedIds) {
    assert(
      acceptedIds.includes(dispatchId),
      `role autonomy smoke: dispatch_started without dispatch_accepted for ${dispatchId}`,
    );
  }
  assert(
    terminated[0]?.payload.code === error.code,
    `role autonomy smoke: agent.role_terminated code ${String(terminated[0]?.payload.code)} != errors[0].code ${error.code}`,
  );

  return {
    termination_code: error.code,
    termination_actor: progress.terminated.actor,
    dispatch_ids: acceptedIds,
    event_counts: {
      accepted: accepted.length,
      started: started.length,
      settled: settled.length,
      role_terminated: terminated.length,
    },
    summary: {
      total: summary.total,
      by_status: { ...summary.by_status },
      last_dispatch_id: summary.last_dispatch!.dispatch_id,
    },
  };
}

/** 终态 `summary.json` 必须与快照同源：至少 dispatch_summary.total 要对得上。 */
export function assertRoleSmokeSummaryFile(
  summary: unknown,
  expectedDispatches: number = ROLE_SMOKE_DISPATCH_BUDGET,
): void {
  assert(
    summary !== null && typeof summary === 'object',
    'role autonomy smoke: summary.json is not an object',
  );
  const dispatchSummary = (summary as Record<string, unknown>)['dispatch_summary'];
  assert(
    dispatchSummary !== null && typeof dispatchSummary === 'object',
    'role autonomy smoke: summary.json has no dispatch_summary',
  );
  const total = (dispatchSummary as Record<string, unknown>)['total'];
  assert(
    total === expectedDispatches,
    `role autonomy smoke: summary.json dispatch_summary.total is ${String(total)}, expected ${String(expectedDispatches)}`,
  );
}

/**
 * samples 里的样例报文：只放前端需要对照的稳定形状，不搬整段指令/transcript。
 */
export function buildRoleSmokeSample(input: {
  run_id: string;
  prompt: string;
  snapshot: RoleSmokeSnapshotView;
  events: ReadonlyArray<RoleSmokeEventView>;
  facts: RoleSmokeFacts;
}): Record<string, unknown> {
  const { snapshot, facts } = input;
  return {
    scenario: 'role_autonomy_dispatch_budget_termination',
    request: {
      method: 'run.create',
      params: { prompt: input.prompt, mode: 'single_agent' },
    },
    result: {
      run_id: input.run_id,
      status: snapshot.status,
      errors: snapshot.errors.map((error) => ({ code: error.code, message: error.message })),
      dispatch_summary: snapshot.dispatch_summary,
      dispatch_progress: snapshot.dispatch_progress,
      dispatch_ids: facts.dispatch_ids,
      event_counts: facts.event_counts,
      events: input.events
        .filter(
          (event) =>
            event.type.startsWith('agent.dispatch_') ||
            event.type === ROLE_DISPATCH_EVENT.role_terminated,
        )
        .map((event) => ({
          type: event.type,
          dispatch_id: event.payload.dispatch_id,
          ...(event.type === ROLE_DISPATCH_EVENT.role_terminated
            ? { code: event.payload.code, actor: event.payload.actor }
            : {}),
          ...(event.payload.status !== undefined ? { status: event.payload.status } : {}),
        })),
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 内部辅助
// ─────────────────────────────────────────────────────────────

function eventsOfType(
  events: ReadonlyArray<RoleSmokeEventView>,
  type: string,
): RoleSmokeEventView[] {
  return events.filter((event) => event.type === type);
}

function uniqueIds(events: ReadonlyArray<RoleSmokeEventView>): string[] {
  const ids: string[] = [];
  for (const event of events) {
    const dispatchId = event.payload.dispatch_id;
    if (typeof dispatchId !== 'string' || dispatchId.length === 0) continue;
    if (!ids.includes(dispatchId)) ids.push(dispatchId);
  }
  return ids;
}

function sortedKey(ids: readonly string[]): string {
  return [...ids].sort().join(',');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`role autonomy smoke: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `role autonomy smoke: ${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}
