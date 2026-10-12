/**
 * DefaultSkillPromotionJob — 独立晋升 job 的批量外壳（Phase 3-C）
 *
 * 处理内核在 services/promotion-executor.ts（一条已 claim 的候选怎么走完），逐条的状态与
 * claim/lease/fencing 落在 MemoryRepository 的晋升状态面上（3-A/3-B）。这里负责「一次运行」
 * 这件事本身：开一条 `skill_promotion` 的 maintenance run、按上限 claim 候选、逐条隔离、
 * 边跑边计数、收尾写结论。
 *
 * 与 Phase 1/2 两个 worker 是同一套外壳形状（停止原因、计数、逐条结果、run 记录），运维
 * 不必为第三条通道再学一套词汇。差别只有这个通道自己的性质：
 *
 * - **候选是派生出来的**，不是上游投进来的交付项：没有 delivery_id，claim 走
 *   `claimNextPromotionCandidate`（processing 标记、租约与 token 都记在候选自己身上），
 *   逐条结果以 `role_id` + `experience_id` 为主键。
 * - **有 dry-run**：照常筛候选、照常问策略，但不 claim、不改任何状态、不写 Skill。因此
 *   dry-run 连启动恢复都不做（恢复本身就是一次写）。它的结论只出现在 `outcomes` 与返回值
 *   里，run 的六个计数**一律为 0**——一次什么都没写的运行不该在吞吐/积压指标里留下数字，
 *   否则把各 run 的 `completed_count` 加起来的人会数到并没有发生的晋升。投影状态由每条
 *   outcome 的 `warnings` 标明是演练。演练同样做判定契约校验（见 `previewOne`）：一份自相
 *   矛盾的判定记成 `failed`，不会伪装成 promoted / pending_review / rejected。
 * - **策略版本是一道断言**：运行选项里声明的版本与注入策略的实际版本不一致就拒绝启动，且
 *   在**开 run 之前**拒绝——审计里记下的版本必须就是真正生效的那一个，而一条只写了「配置
 *   是 v2、实际按 v1 判」的 run 会比没有这条 run 更容易让人读错判决。
 * - **策略返回的判定也是一道断言**，但**不在这里**判：执行内核
 *   （services/promotion-executor.ts 的 `assertPromotionDecisionConsistent`）在写任何东西
 *   之前核对判定的**运行时形状**（是不是对象、`verdict` 是否三个合法结论之一、版本与经验 id
 *   是不是非空字符串、两个数组的元素合不合法）以及它与本次执行的关系（版本、经验 id、审核
 *   模式）和它**内部搭不搭**（`verdict` 与审核模式的配对——`eligible` 只配 `auto_approve`、
 *   `pending_review` 只配 `manual_review`；以及 `verdict` 与两个数组的搭配）。放在内核是因为
 *   内核也会被别的调用方直接用；本外壳只在自己的演练路径上复用同一份校验，失败的分类因此与
 *   真跑完全一致。
 *
 * 几条不能松的约束（与 Phase 1/2 相同，理由也相同）：
 *
 * - **claim 数量与墙钟都有上限**。无上限的 claim 循环会把一次调度变成一次不设终点的批处理，
 *   运维既排不掉也估不出时长。
 * - **没有活就立刻返回**，不轮询、不 sleep：退避窗口没到的候选 claim 不到，那是「这次没活」，
 *   不是「再等一会儿」。
 * - **单条失败不阻塞同批**：一条候选的异常只影响它自己的计数。
 * - **优雅停止不再 claim 新的**，在途的那条照常跑完（半途而废只会更慢，回收它的是租约）。
 * - **启动恢复先跑**：先把租约过期仍停在 processing 的候选放回队列，再去消费。
 * - run 是观测与审计实体，不是事务边界：它失败不代表晋升失败，反之亦然。
 *
 * 刻意没做的两件事，都是边界而不是遗漏：
 *
 * 1. **处理途中不续租**。状态面上没有续租原语（交付通道有 `renewDeliveryClaim`，晋升没有），
 *    而一条候选的处理是一次纯函数判定加最多三次存储写——默认策略不调模型，这段窗口比租约
 *    小几个数量级。真的跑超了也不会写坏：所有回写都带 claim token，凭据失效就什么都写不进
 *    去，候选停在 processing 等 `restoreExpired` 回收。要让「判定里调模型」的策略成立，得先
 *    给晋升状态面加一个续租方法——那是接口层的改动，不在本阶段范围内。
 * 2. **不产生 `skipped`**。那个状态描述的是「筛出来但没轮到我们」，而本外壳是先 claim 再
 *    处理：claim 不到即「这次没活」，收工走 `no_work`，不落一条结果行。契约里的这个成员
 *    留给「先列候选再 claim」的另一种外壳形态。
 */
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import type { MaintenanceFailure, MaintenanceRunCounts } from '../schemas';
import type { ClaimedPromotionCandidate } from '../ports/memory-repository';
import type { PromotionApprovalMode } from '../ports/promotion-strategy';
import type {
  PromotionCandidateOutcome,
  PromotionRestoreResult,
  SkillPromotionJob,
  SkillPromotionJobOptions,
  SkillPromotionRunOptions,
  SkillPromotionRunResult,
  SkillPromotionStopReason,
} from '../ports/skill-promotion-job';
import { classifyDeliveryFailure } from '../services/delivery-error-classification';
import { DEFAULT_DELIVERY_LEASE_MS } from '../services/delivery-lifecycle';
import { EMPTY_MAINTENANCE_RUN_COUNTS } from '../services/maintenance-run-lifecycle';
import {
  assertPromotionDecisionConsistent,
  auditPromotionDecision,
  classifyPromotionFailure,
  describeContractFailure,
  executePromotionCandidate,
  isPromotionDecisionContractError,
} from '../services/promotion-executor';
import type { ExperienceRecord } from '../schemas';

/** 一次运行缺省的 claim 上限；显式传 batchSize 可覆盖 */
export const DEFAULT_SKILL_PROMOTION_BATCH_SIZE = 20;
/** 一次运行缺省的墙钟上限（毫秒） */
export const DEFAULT_SKILL_PROMOTION_MAX_DURATION_MS = 60_000;

/** 演练结果的标注：它是一条投影，不是一次发生过的事 */
const DRY_RUN_WARNING =
  'Dry run: this outcome is a projection of what the strategy would decide; nothing was claimed, written, or changed.';

/** 一次批处理的共享上下文（真实消费与演练两条循环各自需要的那几项） */
interface BatchContext {
  run_id: string;
  batch_size: number;
  max_duration_ms: number;
  /** run 开始时刻的毫秒值；墙钟上限从它起算 */
  started_ms: number;
  role_id?: string | undefined;
  approval: PromotionApprovalMode;
  /** 本次真正生效的策略版本（claim 的语义参数，也是重评判据） */
  strategy_version: string;
  signal?: AbortSignal | undefined;
  counts: MaintenanceRunCounts;
  outcomes: PromotionCandidateOutcome[];
}

export class DefaultSkillPromotionJob implements SkillPromotionJob {
  readonly worker_id: string;
  private readonly now: () => string;

  constructor(private readonly options: SkillPromotionJobOptions) {
    this.worker_id = options.worker_id ?? `skill-promotion-job-${randomUUID()}`;
    this.now = options.now ?? nowTimestamp;
  }

  /**
   * 跑一次：开 run → （缺省先做启动恢复）→ 批量 claim 并逐条执行 → 收尾。
   *
   * 只有外壳自己的故障（claim 读不动存储）才会把 run 标成 failed；候选自己的成败只体现在
   * 计数里——一次「9 条晋升、1 条进死信」的运行是正常的运行，不是失败的运行。
   */
  async run(options: SkillPromotionRunOptions = {}): Promise<SkillPromotionRunResult> {
    const batchSize =
      options.batchSize ?? this.options.batch_size ?? DEFAULT_SKILL_PROMOTION_BATCH_SIZE;
    const maxDurationMs =
      options.maxDurationMs ?? this.options.max_duration_ms ?? DEFAULT_SKILL_PROMOTION_MAX_DURATION_MS;
    if (!Number.isInteger(batchSize) || batchSize < 0) {
      throw new Error('Skill promotion batchSize must be a non-negative integer.');
    }
    if (!Number.isFinite(maxDurationMs) || maxDurationMs < 0) {
      throw new Error('Skill promotion maxDurationMs must be a non-negative number.');
    }

    const strategyVersion = this.options.strategy.version;
    if (options.strategy_version !== undefined && options.strategy_version !== strategyVersion) {
      throw new Error(
        `Skill promotion run declared strategy version "${options.strategy_version}" but the `
          + `injected strategy is "${strategyVersion}"; refusing to start rather than record an `
          + 'audit entry whose version is not the one that judged the candidates.',
      );
    }

    const approval = options.approval ?? this.options.approval ?? this.options.strategy.config.approval;
    const roleId = options.role_id ?? this.options.role_id;
    const dryRun = options.dryRun ?? false;

    const startedAt = options.now ?? this.now();
    const startedMs = Date.parse(startedAt);
    const run = await this.options.runStore.start({
      job_type: 'skill_promotion',
      worker_id: this.worker_id,
      now: startedAt,
    });

    const counts: MaintenanceRunCounts = { ...EMPTY_MAINTENANCE_RUN_COUNTS };
    const outcomes: PromotionCandidateOutcome[] = [];
    let stopReason: SkillPromotionStopReason = 'no_work';
    let workerFailure: MaintenanceFailure | undefined;
    let restoredCount = 0;

    const context: BatchContext = {
      run_id: run.run_id,
      batch_size: batchSize,
      max_duration_ms: maxDurationMs,
      started_ms: startedMs,
      counts,
      outcomes,
      approval,
      strategy_version: strategyVersion,
      ...(roleId !== undefined ? { role_id: roleId } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };

    try {
      // dry-run 什么都不写，因此连启动恢复都不做（恢复会把过期的 processing 放回队列）
      if (!dryRun && (options.restoreExpired ?? this.options.restore_expired ?? true)) {
        const restored = await this.restoreExpired({
          now: startedAt,
          ...(roleId !== undefined ? { role_id: roleId } : {}),
        });
        restoredCount = restored.count;
      }

      stopReason = dryRun
        ? await this.previewBatch(context)
        : await this.consumeBatch(context);
    } catch (error) {
      // 外壳自己出问题（claim 读不动存储等）：如实把 run 标成 failed，并保留已处理的计数。
      const classified = classifyDeliveryFailure(error);
      workerFailure = { code: classified.code, message: classified.message };
      counts.failure_count += 1;
      stopReason = 'worker_error';
    }

    const lastError = lastErrorOf(outcomes, workerFailure);
    const finished =
      workerFailure === undefined
        ? await this.options.runStore.finish(run.run_id, {
            ...counts,
            ...(lastError !== undefined ? { last_error: lastError } : {}),
            now: this.now(),
          })
        : await this.options.runStore.fail(run.run_id, workerFailure, {
            ...counts,
            now: this.now(),
          });
    if (!finished) {
      // 唯一可能是这条 run 已经是终态——run_id 是本进程刚开的，别人碰不到它。
      throw new Error(`Maintenance run ${run.run_id} could not be settled; it was already terminal.`);
    }

    return {
      run: finished,
      counts,
      stop_reason: stopReason,
      restored_count: restoredCount,
      outcomes,
      strategy_version: strategyVersion,
      approval,
      dry_run: dryRun,
      ...(workerFailure !== undefined ? { worker_failure: workerFailure } : {}),
    };
  }

  /**
   * 启动恢复：把租约过期仍停在 processing 的候选放回队列。
   *
   * 直接复用状态面自己的恢复能力——它逐条在自己的临界区里重新判过期，因此不会把「列举之后
   * 已经被别人完成」的候选重投一次。它是一次**写**，所以演练路径不调用它。
   */
  async restoreExpired(
    options: { now?: string; role_id?: string } = {},
  ): Promise<PromotionRestoreResult> {
    const restored = await this.options.repository.restoreExpiredPromotionClaims({
      now: options.now ?? this.now(),
      ...(options.role_id !== undefined ? { role_id: options.role_id } : {}),
    });
    return {
      count: restored.length,
      // 经验自己的 `agent_id` 就是它所属的 role（恢复是按 role 逐批读出来的）
      restored: restored.map((experience) => ({
        role_id: experience.agent_id,
        experience_id: experience.id,
      })),
    };
  }

  /**
   * 真实消费：claim 一条、执行一条，直到没活、到量、超时或被要求停。
   *
   * 每次 claim 都拿跑前的时钟读数作参考时刻：退避窗口与租约过期都以它为准，因此注入时钟的
   * 测试可以精确跨过某一条候选的 `next_retry_at`，而不必等真实时间。
   */
  private async consumeBatch(context: BatchContext): Promise<SkillPromotionStopReason> {
    const leaseMs = this.options.lease_ms ?? DEFAULT_DELIVERY_LEASE_MS;

    for (;;) {
      const guard = this.checkBatchGuards(context);
      if (guard) return guard;

      const candidate = await this.options.repository.claimNextPromotionCandidate({
        owner: this.worker_id,
        now: this.now(),
        lease_ms: leaseMs,
        strategy_version: context.strategy_version,
        approval: context.approval,
        ...(context.role_id !== undefined ? { role_id: context.role_id } : {}),
      });
      if (!candidate) {
        // 没有到期候选就是「这次没活」——队列空 / 退避没到 / 已被别人领走，都是同一件事。
        return 'no_work';
      }

      context.counts.claimed_count += 1;
      const outcome = await this.executeOne(candidate, context);
      context.outcomes.push(outcome);
      countOutcome(context.counts, outcome);
    }
  }

  /**
   * 演练：照常筛候选、照常问策略，但**不 claim、不写任何东西**。
   *
   * 候选列表用 `limit: batchSize` 一次取回，这与真实路径「一次 claim 一条」不是同一件事，
   * 但两者的出口判据一致（同样看 abort / 到量 / 超时），因此停止原因的含义在两条路径上相同。
   * 计数一律不动：演练没有 claim、没有终局，run 上不该出现数字。
   */
  private async previewBatch(context: BatchContext): Promise<SkillPromotionStopReason> {
    const candidates = await this.options.repository.listPromotionCandidates({
      now: this.now(),
      strategy_version: context.strategy_version,
      approval: context.approval,
      limit: context.batch_size,
      ...(context.role_id !== undefined ? { role_id: context.role_id } : {}),
    });

    let index = 0;
    for (;;) {
      const guard = this.checkBatchGuards(context);
      if (guard) return guard;

      const experience = candidates[index];
      index += 1;
      if (!experience) return 'no_work';

      context.outcomes.push(await this.previewOne(experience, context));
    }
  }

  /**
   * 三个出口判据，两条路径共用一处：优雅停止 → 到量 → 超时。
   *
   * 顺序固定不是为了好看：停止信号排在最前，是因为「运维要求停」在任何情况下都该立刻生效，
   * 不该被一次到量或超时掩盖成别的停止原因。返回 undefined 表示这一轮可以继续。
   */
  private checkBatchGuards(context: BatchContext): SkillPromotionStopReason | undefined {
    if (context.signal?.aborted) return 'aborted';
    if (context.outcomes.length >= context.batch_size) return 'batch_size';
    if (Date.parse(this.now()) - context.started_ms >= context.max_duration_ms) {
      return 'max_duration';
    }
    return undefined;
  }

  /**
   * 执行一条已 claim 的候选，并把执行器抛出的异常收进结果里。
   *
   * 执行器本该自己收敛所有失败（它拿得到 token，也只能由它写终态）；真抛出来说明有意料之外
   * 的缺陷。这时**不能**让异常掀掉整批：这一条记成外壳侧失败，余下的照常处理。
   */
  private async executeOne(
    candidate: ClaimedPromotionCandidate,
    context: BatchContext,
  ): Promise<PromotionCandidateOutcome> {
    try {
      const result = await executePromotionCandidate(
        {
          repository: this.options.repository,
          strategy: this.options.strategy,
          now: this.now,
          owner: this.worker_id,
        },
        candidate,
        { approval: context.approval, now: this.now() },
      );
      return {
        status: result.status,
        role_id: result.role_id,
        experience_id: result.experience_id,
        attempt_count: result.attempt_count,
        run_id: context.run_id,
        ...(result.decision !== undefined ? { decision: result.decision } : {}),
        ...(result.skill_id !== undefined ? { skill_id: result.skill_id } : {}),
        ...(result.failure !== undefined ? { failure: result.failure } : {}),
        warnings: [...result.warnings],
      };
    } catch (error) {
      return {
        status: 'failed',
        role_id: candidate.role_id,
        experience_id: candidate.experience.id,
        attempt_count: candidate.attempt_count,
        run_id: context.run_id,
        failure: classifyDeliveryFailure(error),
        warnings: ['The promotion executor threw before it could settle this candidate.'],
      };
    }
  }

  /**
   * 预览一条候选：只调策略，落下来的 status 是「真跑一次会得到什么」。
   *
   * `eligible` 映射成 `promoted`（真跑会写出 Skill），`pending_review` / `rejected` 原样保留
   * ——它们的名字在契约里就是同一件事。策略自己抛错时记成这一条的失败（包含分类），演练因此
   * 也能回答「换个配置跑一次会不会有候选先炸掉」。
   *
   * 演练路径**自己**调一遍判定契约校验，而不是复用执行内核：这一步什么都不写，但结论会被
   * 人当成真跑的预演来读，而「策略会把一份不合法的判定交回来」正是演练最该提前暴露的一类
   * 配置错。校验用的是**同一个函数**（因此同一套 violation、同一种失败分类，含结论与审核模式
   * 配不上对的那一种），不过就记成 `failed`（带规范化 failure），**不**退化成 `promoted` /
   * `pending_review` / `rejected`
   * 里的任何一个——那会把一次配置错伪装成一个正常结论。判定值先落在 `unknown` 上再做校验，
   * 因此一份 `null` / 标量判定只会变成本条 `failed`，不会在读字段时抛出 TypeError 掀掉整批。
   */
  private async previewOne(
    experience: ExperienceRecord,
    context: BatchContext,
  ): Promise<PromotionCandidateOutcome> {
    const role_id = experience.agent_id;
    const base = {
      role_id,
      experience_id: experience.id,
      attempt_count: experience.promotion?.attempt_count ?? 0,
      run_id: context.run_id,
    };

    // 策略交回来的东西在运行时是未知的（自定义策略可以绕过类型层）：先落在 `unknown` 上，
    // 校验过了才读字段——否则一份 `null` 或标量判定会在读 `verdict` 时抛出 TypeError，把
    // 一次配置错变成一次外壳崩溃
    let returned: unknown;
    try {
      returned = await this.options.strategy.evaluate({
        role_id,
        experience,
        now: this.now(),
        approval: context.approval,
      });
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        failure: classifyDeliveryFailure(error),
        warnings: [DRY_RUN_WARNING, 'The strategy threw while previewing this candidate.'],
      };
    }

    const expected = {
      experience_id: experience.id,
      approval: context.approval,
      strategy_version: context.strategy_version,
    };
    try {
      // 与执行内核同一份校验、同一种失败分类：演练的结论会被人当成真跑的预演来读，两条路径
      // 对「什么叫非法判定」必须给出同一个答案
      assertPromotionDecisionConsistent(returned, expected);
    } catch (error) {
      const audited = auditPromotionDecision(returned);
      return {
        ...base,
        status: 'failed',
        ...(audited !== undefined ? { decision: audited } : {}),
        failure: classifyPromotionFailure(error),
        warnings: [
          DRY_RUN_WARNING,
          isPromotionDecisionContractError(error)
            ? describeContractFailure(error)
            : 'The strategy returned an invalid decision while previewing this candidate.',
        ],
      };
    }

    const decision = returned;
    return {
      ...base,
      status: decision.verdict === 'eligible' ? 'promoted' : decision.verdict,
      decision,
      warnings: [DRY_RUN_WARNING],
    };
  }
}

/**
 * 一条结果落到哪个计数格。
 *
 * 三种业务结论（promoted / pending_review / rejected）都算 `completed`：候选被推到了终态，
 * 判定不合格不是故障。`skipped` 是「本次不归我」（本外壳不产生，见文件头），`failed` 是
 * 「终态没写进去」，两者都不该混进完成数。
 */
function countOutcome(counts: MaintenanceRunCounts, outcome: PromotionCandidateOutcome): void {
  switch (outcome.status) {
    case 'promoted':
    case 'pending_review':
    case 'rejected':
      counts.completed_count += 1;
      return;
    case 'skipped':
      counts.skipped_count += 1;
      return;
    case 'retried':
      counts.retried_count += 1;
      return;
    case 'dead_letter':
      counts.dead_letter_count += 1;
      return;
    case 'failed':
      counts.failure_count += 1;
      return;
  }
}

/**
 * run 上那条 human-readable 的结论。
 *
 * 优先写候选侧的失败码（「这一批为什么没干净」），没有失败码时才写外壳自己的故障——两者
 * 同时出现时，候选失败更能解释现场；外壳故障本身已经在 worker_failure 里。带上 role_id 是
 * 因为经验 id 单独看不知道属于哪个 Agent。
 */
function lastErrorOf(
  outcomes: PromotionCandidateOutcome[],
  workerFailure: MaintenanceFailure | undefined,
): string | undefined {
  const failed = outcomes.filter((outcome) => outcome.failure !== undefined);
  const last = failed[failed.length - 1];
  if (last?.failure) {
    return `${last.role_id}/${last.experience_id}: ${last.failure.code}: ${last.failure.message}`;
  }
  if (workerFailure) return `${workerFailure.code}: ${workerFailure.message}`;
  return undefined;
}
