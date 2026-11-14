/**
 * learning-input-grade — Buffer v2 学习输入的来源分级（提取器的唯一分级实现）
 *
 * 职责与核心逻辑：
 * - 把「执行事实（受控 Journal/evidence 核验后的 host_observed 检查）」与「Role 反思 /
 *   Role 记忆使用声明」分开定级，产出一个置信度上限与可读警告。规则版与 LLM 版提取器都只
 *   调用这里，避免两套提取器对同一份输入给出两个来源等级。
 * - 只有**经证据核验、宿主观察到、数据完整、命令级退出码 0** 的检查才算 `host_observed`；
 *   Buffer 自己声明的通过计数只是待核对材料，不能直接成为权威。Role 的
 *   `verification.passed` 只有在引用的派工确有该证据时才被当作有证据支撑。
 *   Role 自述通过而缺证据 → `role_declared`（dependent），不会变成高置信度经验。
 * - 结束状态同样来自结构化事实：优先 Buffer 的 `role_reflection.status`，缺失时只接受
 *   **受控 Journal finish** 补回；两者都没有就是未知，绝不能默认成 completed。
 * - runner 进程退出码不进入本文件：它从来不是检查命令的退出码。
 *
 * 边界：本文件是纯函数，不读写存储、不调用 LLM。
 */
import type { LearningInputEvidenceVerification } from '../ports/learning-evidence-verifier';
import type {
  BufferDispatchSummary,
  BufferRoleStatus,
  BufferRoleVerification,
  BufferSnapshotV2,
} from '../schemas';

export type LearningInputSourceLevel = 'host_observed' | 'role_declared' | 'missing';

export interface LearningInputGrade {
  level: LearningInputSourceLevel;
  /** 提取出的经验置信度上限（正经验）；负经验另有上限 */
  confidence_cap: number;
  /** 可读警告：进入维护证据的 warnings，不静默把依赖证据说成已验证 */
  warnings: string[];
  /**
   * 参与分级与提取的结束状态：`role_reflection.status`，缺失时只接受受控 Journal finish
   * 补回；仍未解析出来就是 undefined（未知，不默认 completed）。
   */
  status?: BufferRoleStatus;
  /**
   * 参与分级与提取的执行摘要。证据核验通过时是**由 Journal/evidence 重建**的摘要，
   * 其余情况是 Buffer 声称的摘要（但 `evidence_verified=false`，不会被当成宿主事实）。
   */
  dispatches: readonly BufferDispatchSummary[];
  /** 证据引用是否真正核对通过（前缀/边界/hash/evidence ref 全部一致） */
  evidence_verified: boolean;
}

/** 正经验置信度上限：不存在「来源等级够高就接近 1」的通道（晋升仍靠反馈/评分）。 */
const CONFIDENCE_CAP: Record<LearningInputSourceLevel, number> = {
  host_observed: 0.55,
  role_declared: 0.35,
  missing: 0.2,
};

/** 负经验上限：失败/未验证本身就是事实，但仍不允许编成高置信度教训。 */
const NEGATIVE_CONFIDENCE_CAP = 0.5;

/** 这条派工是否带着宿主观察到的通过检查（不看 driver 自述）。 */
export function dispatchHasHostObservedPass(dispatch: BufferDispatchSummary): boolean {
  return dispatch.checks.host_observed_passed > 0;
}

/**
 * Role 的 `verification.passed` 是否被真实证据支撑：
 * 引用的每个 dispatch_id 都必须存在、结局为 succeeded、且带宿主观察到的通过检查。
 * 空 dispatch_ids 的 passed 一律视为未支撑（不能靠一句自述放行）。
 */
function verificationClaimSupported(
  claim: BufferRoleVerification,
  byId: ReadonlyMap<string, BufferDispatchSummary>,
): boolean {
  if (claim.dispatch_ids.length === 0) return false;
  return claim.dispatch_ids.every((dispatchId) => {
    const dispatch = byId.get(dispatchId);
    return (
      dispatch !== undefined &&
      dispatch.status === 'succeeded' &&
      dispatchHasHostObservedPass(dispatch)
    );
  });
}

/**
 * 解析本次 Role 的结束状态。
 *
 * - Buffer 有 status：以它为准（它必须来自已接受的 finish.status）；
 * - Buffer 缺 status 但证据核验通过：只接受受控 Journal finish 行的状态补回，并留诊断；
 * - 两者都没有：返回 undefined（未知），绝不默认 completed。
 */
function resolveRoleStatus(
  snapshot: BufferSnapshotV2,
  verification: LearningInputEvidenceVerification | undefined,
  warnings: string[],
): BufferRoleStatus | undefined {
  const declared = snapshot.role_reflection.status;
  const journalStatus = verification?.status === 'verified' ? verification.finish_status : undefined;
  if (declared !== undefined && journalStatus !== undefined && declared !== journalStatus) {
    warnings.push(
      `Buffer v2 declares role end status ${declared}, but the verified Journal finish says ` +
        `${journalStatus}; the verified finish status is used.`,
    );
    return journalStatus;
  }
  if (declared !== undefined) return declared;
  if (journalStatus !== undefined) {
    warnings.push(
      `Buffer v2 has no role_reflection.status; the ${journalStatus} end status was recovered ` +
        'from the verified Journal finish (legacy v2 compatibility).',
    );
    return journalStatus;
  }
  warnings.push(
    'Buffer v2 has no role end status and no verified Journal finish was available; the end ' +
      'status is unknown and is not assumed to be completed.',
  );
  return undefined;
}

/**
 * 给一条 v2 学习输入定级。
 *
 * 规则（顺序即优先级）：
 * 1. 证据核验通过，且有宿主观察到的通过检查，且所有 `passed` 陈述都被证据支撑
 *    → `host_observed`；
 * 2. 角色陈述过 `passed` 但没有宿主证据支撑 → `role_declared`，并留下警告
 *    （「无来源的测试通过主张」不能被当成事实）；
 * 3. 有派工/反思但没有宿主通过的检查 → `role_declared`；
 * 4. 零派工且没有任何派工证据 → `missing`（这不等于伪造失败：答复类任务可以合法零派工）。
 *
 * 没有传入核验结果时按「证据未核验」处理（role_declared 封顶）并留警告：直接信任
 * Buffer 里的 host_observed 计数正是阶段 3 审核复现的缺陷，不能靠「没接线」绕过。
 */
export function gradeLearningInput(
  snapshot: BufferSnapshotV2,
  verification?: LearningInputEvidenceVerification,
): LearningInputGrade {
  const warnings: string[] = [];
  const evidenceVerified = verification?.status === 'verified';
  if (verification === undefined) {
    warnings.push(
      'No learning-evidence verifier is wired for this extraction: Buffer v2 journal/evidence ' +
        'references were not checked, so no check is treated as host-observed fact.',
    );
  } else if (!evidenceVerified) {
    warnings.push(
      `Buffer v2 journal/evidence verification result is ${verification.status}; host-observed ` +
        'check counts from the Buffer are not trusted as verified facts.',
    );
    warnings.push(...verification.warnings);
  }

  const dispatches: readonly BufferDispatchSummary[] =
    evidenceVerified && verification.dispatches !== undefined
      ? verification.dispatches
      : snapshot.dispatches;
  const status = resolveRoleStatus(snapshot, verification, warnings);
  if (status !== undefined && status !== 'completed') {
    warnings.push(
      `Role finished ${status}; the task did not complete. Verified sub-results may still be ` +
        'extracted, but they must not be described as a completed task.',
    );
  }

  const byId = new Map(dispatches.map((dispatch) => [dispatch.dispatch_id, dispatch] as const));
  const hostObservedPass = evidenceVerified && dispatches.some(dispatchHasHostObservedPass);
  const passedClaims = snapshot.role_reflection.verification.filter(
    (claim) => claim.outcome === 'passed',
  );
  const unsupportedPassed = passedClaims.filter(
    (claim) => !verificationClaimSupported(claim, byId),
  );

  if (unsupportedPassed.length > 0) {
    warnings.push(
      `${String(unsupportedPassed.length)} role verification claim(s) marked passed without ` +
        'host-observed passing evidence; they are recorded as dependent statements, not facts.',
    );
  }
  if (!hostObservedPass && dispatches.length > 0) {
    warnings.push(
      'No verified host-observed passing check exists for this run; execution facts stay ' +
        'dependent (driver-reported success is not host evidence).',
    );
  }

  const level: LearningInputSourceLevel =
    hostObservedPass && unsupportedPassed.length === 0
      ? 'host_observed'
      : dispatches.length > 0 ||
          snapshot.role_reflection.reflection.length > 0 ||
          snapshot.role_reflection.summary.length > 0
        ? 'role_declared'
        : 'missing';

  return {
    level,
    confidence_cap: CONFIDENCE_CAP[level],
    warnings,
    ...(status !== undefined ? { status } : {}),
    dispatches,
    evidence_verified: evidenceVerified,
  };
}

/** 负经验置信度上限（与来源等级无关：失败事实比成功主张更容易成立，但仍有上限）。 */
export function negativeConfidenceCap(): number {
  return NEGATIVE_CONFIDENCE_CAP;
}

/**
 * 经验/反馈的 `source_driver` 溯源标签。
 *
 * v2 没有「完成这次任务的那一个 driver」：零派工没有 driver（返回空串，不虚构身份），
 * 多次派工可能是多个 driver（按 dispatch 顺序去重后以 `,` 连接）。
 */
export function sourceDriversLabel(snapshot: BufferSnapshotV2): string {
  return (snapshot.source_drivers ?? []).join(',');
}
