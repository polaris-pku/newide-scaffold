/**
 * 阶段 2 finish 证据校验与 finish 记录持久化（RD-FIN-01/02/04/05、RD-TRM-04）。
 *
 * 职责与核心逻辑（阶段 2 精简后的完成语义）：
 * - **Role 负责语义验收**：判断任务要求是否满足是 role 的责任；finish 时用
 *   `verification[]` 逐条说明 passed / failed / not_run，未验证的要如实披露。
 *   宿主**不再**从自由文本 `completion_criteria` 推导检查义务、不解析命令、不比较 argv、
 *   不拆分子句、不推断检查覆盖范围（这些解释器已在精简中退役）。
 * - **宿主只做事实校验**：受控 evidence ref 的登记/路径/hash（走 `journal.readEvidence`）、
 *   `passed` claim 引用的派工是否真实存在、该派工是否有 `host_observed + complete + exit 0`
 *   且内容指纹与最终交付一致的检查证据；Driver 自述（`driver_reported`）永远不算通过。
 * - `completed` 额外要求：无未决 `unknown` dispatch（后续显式 `retry_of` 且可信收束的可解）、
 *   无只读违规、未超预算/未被取消、`response_only` 与实际派工不冲突。
 * - 判定规则集中且唯一：unknown/retry 收束 reducer 与 engine/loop 共用
 *   {@link resolveUnresolvedDispatchIds}，本文件不再保留算法副本。
 * - `persistRoleFinish` 是 finish 的**唯一生产落盘点**（loop 直接调用，测试也走同一入口）：
 *   统一 accepted_at、内容派生 entry_id、zero_dispatch 与错误映射（journal_write_failed）。
 *
 * 边界：本模块不写 Task/Run 终态（仍由 coordination 的 `advanceStage`/`failStage` 提交），
 * 不自动回滚只读违规产生的副作用，也不读取当前 Run 之外的 evidence（祖先 ref 由 engine 注入）。
 */
import type { DispatchRecord, ExecutionCheck } from '../driver';
import { canonicalJsonStringify, sha256Hex } from '../driver';
import { RunDispatchJournalError } from '../persistence';
import type {
  RoleBudgetPort,
  RoleFinishArgs,
  RoleFinishDecision,
  RoleFinishGap,
  RoleFinishGapCode,
  RoleFinishRecord,
  RoleFinishValidatorInput,
  RoleFinishValidatorPort,
  RoleJournalPort,
  RoleVerificationClaim,
} from './role-autonomy-contract';
import { resolveUnresolvedDispatchIds, RoleTerminationError } from './role-autonomy-contract';

// ─────────────────────────────────────────────────────────────
// finish 校验器
// ─────────────────────────────────────────────────────────────

/** 生产/测试注入点；校验本身无状态、可安全复用同一实例。 */
export function createRoleFinishValidator(): RoleFinishValidatorPort {
  return {
    validate: (input) => validateRoleFinish(input),
  };
}

async function validateRoleFinish(input: RoleFinishValidatorInput): Promise<RoleFinishDecision> {
  const gaps: RoleFinishGap[] = [];
  const now = input.now ?? new Date();

  // 1) 先读一次折叠结果：finish 是否已接受、未决 dispatch、只读违规、检查证据都在里面。
  let fold: Awaited<ReturnType<RoleJournalPort['fold']>> | undefined;
  try {
    fold = await input.journal.fold();
  } catch (error) {
    gaps.push(
      gap(
        'journal_unavailable',
        'dispatch journal is not readable; finish evidence cannot be verified',
        { cause: describeError(error) },
      ),
    );
  }

  // 恢复链上的祖先记录是**只读事实**：不复制成当前 Run 的派工，但与当前记录一起参与
  // completed 的安全校验（只读违规/未决 unknown/response_only/检查证据适用性）。
  const inheritedRecords = input.inherited_records ?? [];
  const allRecords = [...(fold?.records ?? []), ...inheritedRecords];

  // 2) finish 只接受一次：已接受过就不再接受第二次（也不伪造第二份终态）。
  if (fold?.finish !== undefined) {
    return {
      accepted: false,
      gaps: [
        gap('finish_already_accepted', 'role finish was already accepted for this run', {
          status: fold.finish.status,
          at: fold.finish.at,
        }),
      ],
    };
  }

  // 3) 取消：取消中的循环不得成功 finish（用户取消由 C 层 finishRun(cancelled) 提交）。
  if (input.cancelled) {
    gaps.push(gap('cancelled', 'role loop was cancelled; finish cannot be accepted'));
  }

  // 4) 预算：只拦「已完成收束之后仍继续工作」的越界，不惩罚最后一次合法收束。
  if (input.request.status === 'completed') {
    const budgetGap = budgetExhaustedGap(input.budget, now);
    if (budgetGap !== undefined) gaps.push(budgetGap);
  }

  // 5) 引用校验对所有 finish 状态生效：blocked/failed 也不得引用不存在的证据。
  //    top-level 与 verification claim 的 ref 合并去重后只读一次。
  for (const ref of uniqueEvidenceRefs(input.request)) {
    const evidenceGap = await validateEvidenceRef(input.journal, ref);
    if (evidenceGap !== undefined) gaps.push(evidenceGap);
  }

  // 6) completed 专属校验：未决 dispatch / 只读违规 / 显式验证陈述 / response_only 冲突。
  if (input.request.status === 'completed') {
    if (fold !== undefined) {
      const unresolved = resolveUnresolvedDispatchIds(allRecords);
      if (unresolved.length > 0) {
        gaps.push(
          gap(
            'unresolved_dispatch',
            'completed finish cannot be accepted while a dispatched execution is still unknown',
            { dispatch_ids: unresolved },
          ),
        );
      }
      const readOnlyViolations = findReadOnlyViolations(allRecords);
      if (readOnlyViolations.length > 0) {
        gaps.push(
          gap(
            'read_only_violation',
            'completed finish cannot be accepted after a read-only execution changed the workspace',
            { dispatch_ids: readOnlyViolations },
          ),
        );
      }
    }

    gaps.push(
      ...evaluateVerificationClaims({
        claims: input.request.verification ?? [],
        records: allRecords,
        dispatches: input.dispatches,
        currentWorkspaceSha256: input.current_workspace_sha256,
      }),
    );

    if (input.request.response_only === true) {
      const conflict = responseOnlyConflict(input, allRecords);
      if (conflict !== undefined) gaps.push(conflict);
    }
  }

  if (gaps.length > 0) return { accepted: false, gaps };
  return { accepted: true, record: buildFinishRecord(input.request, now) };
}

// ─────────────────────────────────────────────────────────────
// finish 记录持久化（唯一生产入口）
// ─────────────────────────────────────────────────────────────

export interface PersistRoleFinishInput {
  journal: RoleJournalPort;
  record: RoleFinishRecord;
  /** 是否零派工；由 loop 用「恢复前派工数 + 本次派工数」直接给出，不再二次推断。 */
  zero_dispatch: boolean;
}

/**
 * 把已接受的 finish 写成 Journal `finish` 控制行（actor='role'）。
 * 同一记录重复调用是幂等写重试（内容派生 entry_id）；内容冲突由 journal 拒绝 →
 * 转 `journal_write_failed`。loop 与测试都调用本入口，不保留替代实现。
 */
export async function persistRoleFinish(input: PersistRoleFinishInput): Promise<void> {
  const { journal, record } = input;
  try {
    await journal.appendFinish({
      actor: 'role',
      status: record.status,
      // journal `reason` 上限 4000；完整 summary 仍通过扩展字段落盘。
      reason: truncate(record.summary, 4_000),
      evidence_refs: [...record.evidence_refs],
      summary: record.summary,
      unresolved: [...record.unresolved],
      role_reflection: record.role_reflection,
      response_only: record.response_only,
      verification: record.verification.map((claim) => ({
        requirement: claim.requirement,
        outcome: claim.outcome,
        dispatch_ids: [...claim.dispatch_ids],
        evidence_refs: claim.evidence_refs.map((ref) => ({ ...ref })),
        ...(claim.note !== undefined ? { note: claim.note } : {}),
      })),
      zero_dispatch: input.zero_dispatch,
      at: record.accepted_at,
      // 内容派生 entry_id：同一 finish 记录重复持久化是幂等写重试（journal 按 entry_id 去重），
      // 不同内容仍是冲突（fail closed → journal_write_failed），不会被静默覆盖。
      entry_id: finishEntryId(record, input.zero_dispatch),
    });
  } catch (error) {
    throw new RoleTerminationError(
      {
        code: 'journal_write_failed',
        actor: 'host',
        message: 'failed to persist the role finish control row to the dispatch journal',
        details: { status: record.status, cause: describeError(error) },
      },
      error,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// 内部：记录构造与引用收集
// ─────────────────────────────────────────────────────────────

function buildFinishRecord(request: RoleFinishArgs, now: Date): RoleFinishRecord {
  return {
    status: request.status,
    summary: request.summary,
    evidence_refs: [...request.evidence_refs],
    unresolved: [...request.unresolved],
    role_reflection: request.role_reflection,
    response_only: request.response_only === true,
    verification: (request.verification ?? []).map((claim) => ({
      ...claim,
      dispatch_ids: [...claim.dispatch_ids],
      evidence_refs: [...claim.evidence_refs],
    })),
    accepted_at: now.toISOString(),
  };
}

/** top-level 与 verification claim 的 evidence ref 合并去重（同名 path+sha 只校验一次）。 */
function uniqueEvidenceRefs(
  request: RoleFinishArgs,
): Array<RoleFinishArgs['evidence_refs'][number]> {
  const seen = new Set<string>();
  const refs: Array<RoleFinishArgs['evidence_refs'][number]> = [];
  const push = (ref: RoleFinishArgs['evidence_refs'][number]): void => {
    const key = `${ref.path}\u0000${ref.sha256}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };
  for (const ref of request.evidence_refs) push(ref);
  for (const claim of request.verification ?? []) {
    for (const ref of claim.evidence_refs) push(ref);
  }
  return refs;
}

// ─────────────────────────────────────────────────────────────
// 内部：verification 陈述的事实校验
// ─────────────────────────────────────────────────────────────

/**
 * 逐条校验 `verification[]`（只核事实，不做语义判断）：
 * - `failed` / `not_run` 是 role 的如实陈述，宿主不要求证据；
 * - `passed` 必须至少引用一个真实派工（`dispatch_ids`），且该派工存在
 *   `host_observed + complete + exit_code=0 + workspace_sha256 与最终交付一致`的检查证据：
 *   没有运行的检查、Driver 自述、非零退出、partial 观察、过期指纹都不能写成通过；
 * - 宿主不比较 `requirement` 与 `completion_criteria`，也不比较命令字符串。
 */
function evaluateVerificationClaims(input: {
  claims: readonly RoleVerificationClaim[];
  records: readonly DispatchRecord[];
  dispatches: RoleFinishValidatorInput['dispatches'];
  currentWorkspaceSha256: string | undefined;
}): RoleFinishGap[] {
  const gaps: RoleFinishGap[] = [];
  const checksByDispatch = collectChecksByDispatch(input.records, input.dispatches);
  for (const claim of input.claims) {
    if (claim.outcome !== 'passed') continue;
    const detail: Record<string, unknown> = {
      requirement: claim.requirement,
      dispatch_ids: [...claim.dispatch_ids],
    };
    if (claim.dispatch_ids.length === 0) {
      gaps.push(
        gap(
          'evidence_source_insufficient',
          'a verification claim marked passed must reference at least one dispatched execution',
          { ...detail, reason: 'verification_without_dispatch' },
        ),
      );
      continue;
    }
    const checks: ExecutionCheck[] = [];
    const missingDispatchIds: string[] = [];
    for (const dispatchId of claim.dispatch_ids) {
      const found = checksByDispatch.get(dispatchId);
      if (found === undefined) {
        missingDispatchIds.push(dispatchId);
        continue;
      }
      checks.push(...found);
    }
    const hostObserved = checks.filter((check) => check.provenance === 'host_observed');
    if (hostObserved.length === 0) {
      gaps.push(
        gap(
          'evidence_source_insufficient',
          missingDispatchIds.length > 0
            ? 'a verification claim references dispatches that have no observed evidence'
            : 'a verification claim marked passed has no host-observed check evidence; driver-reported results do not qualify',
          {
            ...detail,
            reason:
              missingDispatchIds.length > 0
                ? 'verification_dispatch_unobserved'
                : 'no_host_observed_check',
            ...(missingDispatchIds.length > 0 ? { missing_dispatch_ids: missingDispatchIds } : {}),
          },
        ),
      );
      continue;
    }
    const current = input.currentWorkspaceSha256;
    const passing = hostObserved.filter((check) =>
      isPassingHostObservedCheck(check, current),
    );
    if (passing.length > 0) continue;
    const failing = hostObserved.filter(
      (check) =>
        check.observation === 'complete' &&
        check.exit_code !== undefined &&
        check.exit_code !== 0,
    );
    const stale = hostObserved.filter(
      (check) =>
        check.observation === 'complete' &&
        check.exit_code === 0 &&
        current !== undefined &&
        check.workspace_sha256 !== undefined &&
        check.workspace_sha256 !== current,
    );
    if (failing.length > 0) {
      gaps.push(
        gap(
          'evidence_source_insufficient',
          'a verification claim marked passed cites a host-observed check that did not pass (non-zero exit code)',
          {
            ...detail,
            reason: 'host_observed_check_failed',
            failing_checks: failing.map((check) => ({
              command: check.command,
              exit_code: check.exit_code,
            })),
          },
        ),
      );
      continue;
    }
    if (stale.length > 0) {
      gaps.push(
        gap(
          'evidence_stale',
          'the cited host-observed check evidence was captured for an earlier workspace version; re-run the check after the final change',
          {
            ...detail,
            reason: 'check_evidence_stale',
            stale_workspace_sha256: stale.map((check) => check.workspace_sha256),
            current_workspace_sha256: current ?? null,
          },
        ),
      );
      continue;
    }
    gaps.push(
      gap(
        'evidence_source_insufficient',
        current === undefined
          ? 'the final workspace fingerprint is unavailable; a passed verification claim cannot be proven against the final deliverable'
          : 'no complete host-observed check with exit_code=0 applies to the final deliverable',
        {
          ...detail,
          reason:
            current === undefined
              ? 'final_workspace_fingerprint_unavailable'
              : 'no_passing_host_observed_check',
          checks: hostObserved.map((check) => ({
            command: check.command,
            exit_code: check.exit_code,
            observation: check.observation,
            has_workspace_sha256: check.workspace_sha256 !== undefined,
          })),
          current_workspace_sha256: current ?? null,
        },
      ),
    );
  }
  return gaps;
}

/** 按 dispatch id 收集已观察检查（journal 折叠记录优先，写屏障返回的 observation 补充）。 */
function collectChecksByDispatch(
  records: readonly DispatchRecord[],
  dispatches: RoleFinishValidatorInput['dispatches'],
): Map<string, ExecutionCheck[]> {
  const byDispatch = new Map<string, ExecutionCheck[]>();
  const push = (dispatchId: string, checks: readonly ExecutionCheck[]): void => {
    const existing = byDispatch.get(dispatchId) ?? [];
    existing.push(...checks);
    byDispatch.set(dispatchId, existing);
  };
  for (const record of records) {
    if (record.evidence === undefined) continue;
    push(record.dispatch_id, record.evidence.checks);
  }
  for (const observation of dispatches) {
    // unknown 尚未收束，不能拿它的检查去支撑 completed。
    if (observation.status === 'unknown') continue;
    push(observation.dispatch_id, observation.evidence.checks);
  }
  return byDispatch;
}

/** 通过判定：host_observed + complete + exit 0 + 最终交付内容指纹一致（缺指纹不算通过）。 */
function isPassingHostObservedCheck(
  check: ExecutionCheck,
  currentWorkspaceSha256: string | undefined,
): boolean {
  if (check.provenance !== 'host_observed') return false;
  if (check.observation !== 'complete') return false;
  if (check.exit_code !== 0) return false;
  if (currentWorkspaceSha256 === undefined) return false;
  return check.workspace_sha256 === currentWorkspaceSha256;
}

// ─────────────────────────────────────────────────────────────
// 内部：completed 安全约束
// ─────────────────────────────────────────────────────────────

/** 只读违规：宿主在 settled 时记的 `read_only_changed`（investigate 产生差异/verify 未声明写）。 */
function findReadOnlyViolations(records: readonly DispatchRecord[]): string[] {
  return records
    .filter((record) => record.violations.includes('read_only_changed'))
    .map((record) => record.dispatch_id);
}

/**
 * response_only 冲突：答复类任务未获允许，或已经发生非只读派工（可能改了代码）时，
 * 不能用 response_only 支撑 completed。
 */
function responseOnlyConflict(
  input: RoleFinishValidatorInput,
  records: readonly DispatchRecord[],
): RoleFinishGap | undefined {
  if (!input.context.response_only_allowed) {
    return gap(
      'response_only_conflict',
      'this task is not a response-only task; response_only cannot support completion',
    );
  }
  const writes = records.filter(
    (record) => record.phase !== 'accepted' && record.brief.read_only === false,
  );
  if (writes.length > 0) {
    return gap(
      'response_only_conflict',
      'response_only contradicts a dispatched non-read-only execution',
      { dispatch_ids: writes.map((record) => record.dispatch_id) },
    );
  }
  return undefined;
}

/** 预算触限只拦越界/过期，不拦「恰好用完最后一次合法额度后收束」。 */
function budgetExhaustedGap(budget: RoleBudgetPort, now: Date): RoleFinishGap | undefined {
  const snapshot = budget.snapshot(now);
  const { limits } = snapshot.frozen;
  const consumed = snapshot.consumed;
  if (consumed.dispatches > limits.max_dispatches) {
    return gap('budget_exhausted', 'dispatch budget exceeded', {
      dimension: 'dispatches',
      consumed: consumed.dispatches,
      limit: limits.max_dispatches,
    });
  }
  if (consumed.role_rounds > limits.max_role_rounds) {
    return gap('budget_exhausted', 'role LLM round budget exceeded', {
      dimension: 'role_rounds',
      consumed: consumed.role_rounds,
      limit: limits.max_role_rounds,
    });
  }
  if (consumed.tokens > limits.role_token_budget) {
    return gap('budget_exhausted', 'role token budget exceeded', {
      dimension: 'tokens',
      consumed: consumed.tokens,
      limit: limits.role_token_budget,
      tokens_missing: consumed.tokens_missing,
    });
  }
  if (snapshot.wall_clock_remaining_ms <= 0) {
    return gap('budget_exhausted', 'role wall clock deadline has passed', {
      dimension: 'wall_clock',
      deadline_at: snapshot.frozen.deadline_at,
      remaining_ms: snapshot.wall_clock_remaining_ms,
    });
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────
// 内部：引用校验与错误映射
// ─────────────────────────────────────────────────────────────

/**
 * 用 journal 的受控读取面校验引用（登记/存在/大小/hash/路径都在 journal 里执行），
 * 把稳定错误码映射为 finish gap；底层异常不直接抛给 role。
 */
async function validateEvidenceRef(
  journal: RoleJournalPort,
  ref: RoleFinishArgs['evidence_refs'][number],
): Promise<RoleFinishGap | undefined> {
  try {
    await journal.readEvidence(ref);
    return undefined;
  } catch (error) {
    if (error instanceof RunDispatchJournalError) {
      switch (error.code) {
        case 'evidence_ref_not_registered':
        case 'evidence_ref_invalid':
        case 'evidence_ref_conflict':
        case 'evidence_path_unsafe':
          return gap(
            'evidence_ref_not_registered',
            `evidence ref ${ref.path} is not a registered evidence ref of this run`,
            { ref, cause: error.code },
          );
        case 'evidence_hash_mismatch':
          return gap(
            'evidence_hash_mismatch',
            `evidence ref ${ref.path} content does not match the registered sha256`,
            { ref, cause: error.code },
          );
        case 'evidence_missing':
          return gap('evidence_missing', `evidence ref ${ref.path} does not exist`, {
            ref,
            cause: error.code,
          });
        case 'evidence_too_large':
          return gap(
            'evidence_source_insufficient',
            `evidence ref ${ref.path} exceeds the controlled read size limit`,
            { ref, cause: error.code },
          );
        default:
          return gap('journal_unavailable', `evidence ref ${ref.path} could not be validated`, {
            ref,
            cause: error.code,
          });
      }
    }
    return gap('journal_unavailable', `evidence ref ${ref.path} could not be validated`, {
      ref,
      cause: describeError(error),
    });
  }
}

// ─────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────

/**
 * 内容派生的 finish `entry_id`：同一记录重复持久化走 journal 的 entry_id 幂等去重，
 * 不同内容仍被 journal 判冲突（fail closed），不会被静默覆盖或写成第二份 finish。
 */
function finishEntryId(record: RoleFinishRecord, zeroDispatch: boolean): string {
  const digest = sha256Hex(
    canonicalJsonStringify({
      actor: 'role',
      status: record.status,
      summary: record.summary,
      evidence_refs: record.evidence_refs,
      unresolved: record.unresolved,
      role_reflection: record.role_reflection,
      response_only: record.response_only,
      verification: record.verification,
      zero_dispatch: zeroDispatch,
      accepted_at: record.accepted_at,
    }),
  );
  return `jrn_finish_${digest.slice(0, 48)}`;
}

function gap(
  code: RoleFinishGapCode,
  message: string,
  detail?: Record<string, unknown>,
): RoleFinishGap {
  return detail === undefined ? { code, message } : { code, message, detail };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
