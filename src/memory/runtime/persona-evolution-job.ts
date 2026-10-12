/**
 * DefaultPersonaEvolutionJob — 独立演化 job 的批量外壳（Phase 4-C）
 *
 * 处理内核在 services/persona-evolution-executor.ts（一条已 claim 的角色怎么走完），逐条的
 * 状态与 claim/lease/fencing 落在 MemoryRepository 的演化状态面上（4-A/4-B）。这里负责
 * 「一次运行」这件事本身：开一条 `persona_evolution` 的 maintenance run、按上限 claim 候选、
 * 逐条隔离、边跑边计数、收尾写结论。
 *
 * 与 Phase 1/2/3 三条通道是同一套外壳形状（停止原因、计数、逐条结果、run 记录），运维不必
 * 为第四条通道再学一套词汇。差别只有这条通道自己的性质：
 *
 * - **候选是「角色」而不是「行」**：claim 走 `claimNextPersonaEvolutionCandidate`（一个角色
 *   一条演化流，processing 标记、租约与 token 都记在角色自己身上），逐条结果以 `role_id`
 *   为主键。因此「一次运行能碰到多少条候选」的上限是按角色算的，与批大小同义。
 * - **有 dry-run**：照常筛候选、照常算快照与判定，但不 claim、不改任何状态、不写 Persona。
 *   run 的六个计数**一律为 0**——一次什么都没写的运行不该在吞吐/积压指标里留下数字，否则
 *   把各 run 的 `completed_count` 加起来的人会数到并没有发生的演化。
 * - **策略版本是一道断言**：运行选项里声明的版本与注入策略的实际版本不一致就拒绝启动，且
 *   在**开 run 之前**拒绝——审计里记下的版本必须就是真正生效的那一个。
 *
 * 几条不能松的约束（与 Phase 1/2/3 相同，理由也相同）：
 *
 * - **claim 数量与墙钟都有上限**。无上限的 claim 循环会把一次调度变成一次不设终点的批处理，
 *   运维既排不掉也估不出时长。
 * - **没有活就立刻返回**，不轮询、不 sleep：退避窗口没到的角色 claim 不到，那是「这次没活」，
 *   不是「再等一会儿」。
 * - **单条失败不阻塞同批**：一个角色的异常只影响它自己的计数。
 * - **优雅停止不再 claim 新的**，在途的那条照常跑完（半途而废只会更慢，回收它的是租约）。
 * - **启动恢复先跑**：先把租约过期仍停在 processing 的角色放回队列，再去消费。
 * - run 是观测与审计实体，不是事务边界：它失败不代表演化失败，反之亦然。
 *
 * 处理途中**不续租**：状态面上没有续租原语（交付通道有 `renewDeliveryClaim`，演化没有），
 * 而一个角色的处理是一次判定加一次存储写——默认策略不调模型，这段窗口比租约小几个数量级。
 * 真的跑超了也不会写坏：所有回写都带 claim token 且都带父版本前提，凭据失效就什么都写不
 * 进去，角色停在 processing 等 `restoreExpired` 回收。要让「判定里调模型」的策略成立，得先
 * 给演化状态面加一个续租方法——那是接口层的改动，不在本阶段范围内。
 *
 * **真跑不产生 `skipped`**（先 claim 再处理，claim 不到即 `no_work`）；`skipped` 只在演练
 * 路径上出现，由计划直接回答「这条角色本来会不会被 claim」。这与晋升外壳的处理一致，差别是
 * 演化把那个原因（`skip_reason`）留在结果里——演练是唯一能看见「大多数角色卡在哪一步」的
 * 场合，把原因丢掉就白筛了一遍。
 */
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import type { MaintenanceFailure, MaintenanceRunCounts } from '../schemas';
import type { ClaimedPersonaEvolutionCandidate } from '../ports/memory-repository';
import {
  PERSONA_EVOLUTION_APPROVAL_MODES,
  type PersonaEvolutionApprovalMode,
  type PersonaEvolutionDecision,
} from '../ports/persona-evolution-strategy';
import type {
  PersonaEvolutionCandidateOutcome,
  PersonaEvolutionJob,
  PersonaEvolutionJobOptions,
  PersonaEvolutionRestoreResult,
  PersonaEvolutionRunOptions,
  PersonaEvolutionRunResult,
  PersonaEvolutionStopReason,
} from '../ports/persona-evolution-job';
import { classifyDeliveryFailure } from '../services/delivery-error-classification';
import { DEFAULT_DELIVERY_LEASE_MS } from '../services/delivery-lifecycle';
import { EMPTY_MAINTENANCE_RUN_COUNTS } from '../services/maintenance-run-lifecycle';
import {
  buildPersonaEvolutionSnapshot,
  personaEvolutionInputSnapshotHash,
  personaEvolutionLastRun,
  planPersonaEvolutionCandidate,
} from '../services/persona-evolution-candidates';
import {
  assertPersonaEvolutionDecisionConsistent,
  auditPersonaEvolutionDecision,
  describePersonaEvolutionContractFailure,
  isPersonaEvolutionDecisionContractError,
} from '../services/persona-evolution-decision';
import {
  classifyPersonaEvolutionFailure,
  executePersonaEvolutionCandidate,
} from '../services/persona-evolution-executor';

/** 一次运行缺省的 claim 上限；显式传 batchSize 可覆盖 */
export const DEFAULT_PERSONA_EVOLUTION_BATCH_SIZE = 20;
/** 一次运行缺省的墙钟上限（毫秒） */
export const DEFAULT_PERSONA_EVOLUTION_MAX_DURATION_MS = 60_000;

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
  approval: PersonaEvolutionApprovalMode;
  /** 本次真正生效的策略版本（claim 的语义参数，也是重评判据） */
  strategy_version: string;
  signal?: AbortSignal | undefined;
  counts: MaintenanceRunCounts;
  outcomes: PersonaEvolutionCandidateOutcome[];
  /**
   * 已用掉的批量名额。
   *
   * 真跑算的是 claim 到的条数；演练算的是「真跑会 claim」的条数——**跳过行不占名额**。
   * 不这样分，一次跨全部 Agent 的演练会被前若干个「输入没变、正在处理中」的角色把名额用光，
   * 一条真正会演化的候选都报不出来，而那正是演练要回答的问题。
   */
  budget_used: number;
}

export class DefaultPersonaEvolutionJob implements PersonaEvolutionJob {
  readonly worker_id: string;
  private readonly now: () => string;

  constructor(private readonly options: PersonaEvolutionJobOptions) {
    this.worker_id = options.worker_id ?? `persona-evolution-job-${randomUUID()}`;
    this.now = options.now ?? nowTimestamp;
  }

  /**
   * 跑一次：开 run → （缺省先做启动恢复）→ 批量 claim 并逐条执行 → 收尾。
   *
   * 只有外壳自己的故障（claim 读不动存储）才会把 run 标成 failed；角色自己的成败只体现在
   * 计数里——一次「9 条演化、1 条进死信」的运行是正常的运行，不是失败的运行。
   */
  async run(options: PersonaEvolutionRunOptions = {}): Promise<PersonaEvolutionRunResult> {
    const batchSize =
      options.batchSize ?? this.options.batch_size ?? DEFAULT_PERSONA_EVOLUTION_BATCH_SIZE;
    const maxDurationMs =
      options.maxDurationMs
      ?? this.options.max_duration_ms
      ?? DEFAULT_PERSONA_EVOLUTION_MAX_DURATION_MS;
    if (!Number.isInteger(batchSize) || batchSize < 0) {
      throw new Error('Persona evolution batchSize must be a non-negative integer.');
    }
    if (!Number.isFinite(maxDurationMs) || maxDurationMs < 0) {
      throw new Error('Persona evolution maxDurationMs must be a non-negative number.');
    }

    const strategyVersion = this.options.strategy.version;
    if (options.strategy_version !== undefined && options.strategy_version !== strategyVersion) {
      throw new Error(
        `Persona evolution run declared strategy version "${options.strategy_version}" but the `
          + `injected strategy is "${strategyVersion}"; refusing to start rather than record an `
          + 'audit entry whose version is not the one that judged the candidates.',
      );
    }

    const approval = options.approval ?? this.options.approval ?? this.options.strategy.config.approval;
    // 运行选项是**运行时**的值（配置、RPC 参数）：策略自己的构造校验看不到它，因此在这里挡。
    // 放过去的话，一个拼错的模式会被计划当成「人工审核」（判据是「等不等于 auto_approve」），
    // 于是本该自动演化的运行静默地一件都不做——正是「不得静默」要防的那种
    if (!PERSONA_EVOLUTION_APPROVAL_MODES.includes(approval)) {
      throw new Error(
        `Unknown persona evolution approval mode: "${String(approval)}"; expected one of `
          + `${PERSONA_EVOLUTION_APPROVAL_MODES.join(' | ')}.`,
      );
    }
    const roleId = options.role_id ?? this.options.role_id;
    const dryRun = options.dryRun ?? false;

    const startedAt = options.now ?? this.now();
    const startedMs = Date.parse(startedAt);
    const run = await this.options.runStore.start({
      job_type: 'persona_evolution',
      worker_id: this.worker_id,
      now: startedAt,
    });

    const counts: MaintenanceRunCounts = { ...EMPTY_MAINTENANCE_RUN_COUNTS };
    const outcomes: PersonaEvolutionCandidateOutcome[] = [];
    let stopReason: PersonaEvolutionStopReason = 'no_work';
    let workerFailure: MaintenanceFailure | undefined;
    let restoredCount = 0;

    const context: BatchContext = {
      run_id: run.run_id,
      batch_size: batchSize,
      max_duration_ms: maxDurationMs,
      started_ms: startedMs,
      counts,
      outcomes,
      budget_used: 0,
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

      stopReason = dryRun ? await this.previewBatch(context) : await this.consumeBatch(context);
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
   * 启动恢复：把租约过期仍停在 processing 的角色放回队列。
   *
   * 直接复用状态面自己的恢复能力——它逐条在自己的临界区里重新判过期，因此不会把「列举之后
   * 已经被别人完成」的候选重投一次。它是一次**写**，所以演练路径不调用它。
   */
  async restoreExpired(
    options: { now?: string; role_id?: string } = {},
  ): Promise<PersonaEvolutionRestoreResult> {
    const restored = await this.options.repository.restoreExpiredPersonaEvolutionClaims({
      now: options.now ?? this.now(),
      ...(options.role_id !== undefined ? { role_id: options.role_id } : {}),
    });
    return {
      count: restored.length,
      restored: restored.map((item) => ({ role_id: item.role_id })),
    };
  }

  /**
   * 真实消费：claim 一条、执行一条，直到没活、到量、超时或被要求停。
   *
   * 每次 claim 都拿跑前的时钟读数作参考时刻：退避窗口与租约过期都以它为准，因此注入时钟的
   * 测试可以精确跨过某个角色的 `next_retry_at`，而不必等真实时间。
   */
  private async consumeBatch(context: BatchContext): Promise<PersonaEvolutionStopReason> {
    const leaseMs = this.options.lease_ms ?? DEFAULT_DELIVERY_LEASE_MS;

    for (;;) {
      const guard = this.checkBatchGuards(context);
      if (guard) return guard;

      const candidate = await this.options.repository.claimNextPersonaEvolutionCandidate({
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

      context.budget_used += 1;
      context.counts.claimed_count += 1;
      const outcome = await this.executeOne(candidate, context);
      context.outcomes.push(outcome);
      countOutcome(context.counts, outcome);
    }
  }

  /**
   * 演练：照常筛候选、照常问策略，但**不 claim、不写任何东西**。
   *
   * 与真跑的分工：真跑是「claim 一条看一条」，因此只能看见 claim 得到的那些；演练按
   * `listAgentIds()` 逐个角色读状态、算快照、判计划，因此**连跳过都能报出来**（`skip_reason`）。
   * 读与算用的都是共享的那几个函数（`buildPersonaEvolutionSnapshot` /
   * `planPersonaEvolutionCandidate`），所以「什么算同一份输入」「什么时候该跳过」与适配器在
   * 临界区里用的是同一份规则；差别只在**读不是原子的**——演练是一次投影，它不承诺「读到的
   * 输入」与「据此写的租约」来自同一次读（真跑承诺，因为那是 claim 的语义）。
   *
   * 计数一律不动：演练没有 claim、没有终局，run 上不该出现数字。
   */
  private async previewBatch(context: BatchContext): Promise<PersonaEvolutionStopReason> {
    const roles =
      context.role_id !== undefined
        ? [context.role_id]
        : await this.options.repository.listAgentIds();

    for (const role_id of roles) {
      const guard = this.checkBatchGuards(context);
      if (guard) return guard;

      let preview: { outcome: PersonaEvolutionCandidateOutcome; previewed: boolean };
      try {
        preview = await this.previewRole(role_id, context);
      } catch (error) {
        // 单条隔离：读不出一个角色的输入（正好被删掉、载荷损坏）不该让整次演练崩掉
        preview = {
          previewed: true,
          outcome: {
            status: 'failed',
            role_id,
            attempt_count: 0,
            run_id: context.run_id,
            failure: classifyDeliveryFailure(error),
            warnings: [DRY_RUN_WARNING, 'The preview could not read this role.'],
          },
        };
      }
      context.outcomes.push(preview.outcome);
      if (preview.previewed) context.budget_used += 1;
    }
    return 'no_work';
  }

  /**
   * 三个出口判据，两条路径共用一处：优雅停止 → 到量 → 超时。
   *
   * 顺序固定不是为了好看：停止信号排在最前，是因为「运维要求停」在任何情况下都该立刻生效，
   * 不该被一次到量或超时掩盖成别的停止原因。返回 undefined 表示这一轮可以继续。
   */
  private checkBatchGuards(context: BatchContext): PersonaEvolutionStopReason | undefined {
    if (context.signal?.aborted) return 'aborted';
    if (context.budget_used >= context.batch_size) return 'batch_size';
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
    candidate: ClaimedPersonaEvolutionCandidate,
    context: BatchContext,
  ): Promise<PersonaEvolutionCandidateOutcome> {
    try {
      const result = await executePersonaEvolutionCandidate(
        {
          repository: this.options.repository,
          strategy: this.options.strategy,
          now: this.now,
          owner: this.worker_id,
        },
        candidate,
        { approval: context.approval, source_run_id: context.run_id, now: this.now() },
      );
      return {
        status: result.status,
        role_id: result.role_id,
        attempt_count: result.attempt_count,
        run_id: context.run_id,
        input_snapshot_hash: result.input_snapshot_hash,
        parent_version: result.parent_version,
        ...(result.decision !== undefined ? { decision: result.decision } : {}),
        ...(result.persona_version !== undefined ? { persona_version: result.persona_version } : {}),
        ...(result.failure !== undefined ? { failure: result.failure } : {}),
        warnings: [...result.warnings],
      };
    } catch (error) {
      return {
        status: 'failed',
        role_id: candidate.role_id,
        attempt_count: candidate.attempt_count,
        run_id: context.run_id,
        input_snapshot_hash: candidate.input_snapshot_hash,
        parent_version: candidate.persona.version,
        failure: classifyDeliveryFailure(error),
        warnings: ['The persona evolution executor threw before it could settle this candidate.'],
      };
    }
  }

  /**
   * 预览一条角色：先判计划，再（必要时）只调策略。
   *
   * 计划说「跳过」时**不问策略**：那正是 `skip_reason` 要回答的事，而问一次策略会白烧一次
   * 可能的模型调用（真跑根本不会走到那一步）。计划说「要动」时落下来的 status 是「真跑一次
   * 会得到什么」：`eligible` 映射成 `evolved`（真跑会写出新版本），`pending_review` /
   * `rejected` 原样保留——它们的名字在契约里就是同一件事。
   *
   * 演练路径**自己**调一遍判定契约校验，而不是复用执行内核：这一步什么都不写，但结论会被
   * 人当成真跑的预演来读，而「策略会把一份不合法的判定交回来」正是演练最该提前暴露的一类
   * 配置错。校验用的是**同一个函数**（同一套 violation、同一种失败分类，含结论与审核模式配
   * 不上对的那一种），不过就记成 `failed`（带规范化 failure），**不**退化成 evolved /
   * pending_review / rejected 里的任何一个——那会把一次配置错伪装成一个正常结论。判定值先
   * 落在 `unknown` 上再做校验，因此一份 `null` / 标量判定只会变成本条 `failed`，不会在读字段
   * 时抛出 TypeError 掀掉整批。
   */
  private async previewRole(
    role_id: string,
    context: BatchContext,
  ): Promise<{ outcome: PersonaEvolutionCandidateOutcome; previewed: boolean }> {
    const repository = this.options.repository;
    const marker = await repository.getPersonaEvolutionMarker(role_id);
    const persona = await repository.getPersona(role_id);
    const [skills, experiences] = await Promise.all([
      repository.listSkills(role_id),
      repository.listExperiences(role_id),
    ]);
    const snapshot = buildPersonaEvolutionSnapshot({ role_id, skills, experiences });
    const input_snapshot_hash = personaEvolutionInputSnapshotHash(snapshot);
    // 演练不 claim，标记本来就没被动过，因此这里读到的就是「计划执行之前的那份」
    const last_evolution = personaEvolutionLastRun(marker);

    const base = {
      role_id,
      attempt_count: marker?.attempt_count ?? 0,
      run_id: context.run_id,
      input_snapshot_hash,
      parent_version: persona.version,
    };

    const plan = planPersonaEvolutionCandidate(marker, {
      now: this.now(),
      strategy_version: context.strategy_version,
      approval: context.approval,
      input_snapshot_hash,
    });
    if (plan.kind === 'skip') {
      return {
        previewed: false,
        outcome: {
          ...base,
          status: 'skipped',
          skip_reason: plan.reason,
          warnings: [DRY_RUN_WARNING],
        },
      };
    }

    // 策略交回来的东西在运行时是未知的（自定义策略可以绕过类型层）：先落在 `unknown` 上，
    // 校验过了才读字段——否则一份 `null` 或标量判定会在读 `verdict` 时抛出 TypeError
    let returned: unknown;
    try {
      returned = await this.options.strategy.evaluate({
        role_id,
        now: this.now(),
        approval: context.approval,
        current_persona: persona,
        parent_version: persona.version,
        snapshot,
        input_snapshot_hash,
        ...(last_evolution !== undefined ? { last_evolution } : {}),
      });
    } catch (error) {
      return {
        previewed: true,
        outcome: {
          ...base,
          status: 'failed',
          failure: classifyPersonaEvolutionFailure(error, 'judgement'),
          warnings: [DRY_RUN_WARNING, 'The strategy threw while previewing this candidate.'],
        },
      };
    }

    const expected = {
      role_id,
      approval: context.approval,
      strategy_version: context.strategy_version,
      parent_version: persona.version,
      input_snapshot_hash,
    };
    try {
      // 与执行内核同一份校验、同一种失败分类：演练的结论会被人当成真跑的预演来读，两条路径
      // 对「什么叫非法判定」必须给出同一个答案
      assertPersonaEvolutionDecisionConsistent(returned, expected);
    } catch (error) {
      const audited = auditPersonaEvolutionDecision(returned);
      return {
        previewed: true,
        outcome: {
          ...base,
          status: 'failed',
          ...(audited !== undefined ? { decision: audited } : {}),
          failure: classifyPersonaEvolutionFailure(error, 'judgement'),
          warnings: [
            DRY_RUN_WARNING,
            isPersonaEvolutionDecisionContractError(error)
              ? describePersonaEvolutionContractFailure(error)
              : 'The strategy returned an invalid decision while previewing this candidate.',
          ],
        },
      };
    }

    const decision: PersonaEvolutionDecision = returned;
    return {
      previewed: true,
      outcome: {
        ...base,
        status: decision.verdict === 'eligible' ? 'evolved' : decision.verdict,
        decision,
        warnings: [DRY_RUN_WARNING],
      },
    };
  }
}

/**
 * 一条结果落到哪个计数格。
 *
 * 三种业务结论（evolved / pending_review / rejected）都算 `completed`：角色被推到了终态，
 * 判定不合格不是故障。`skipped` 是「本次不归我」（真跑不产生，演练会产生，但演练的计数全为
 * 0），`failed` 是「终态没写进去」，两者都不该混进完成数。
 */
function countOutcome(
  counts: MaintenanceRunCounts,
  outcome: PersonaEvolutionCandidateOutcome,
): void {
  switch (outcome.status) {
    case 'evolved':
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
 * 优先写角色侧的失败码（「这一批为什么没干净」），没有失败码时才写外壳自己的故障——两者
 * 同时出现时，角色失败更能解释现场；外壳故障本身已经在 worker_failure 里。角色名是这条
 * 通道的主键，因此不像晋升那样还要再带一个行 id。
 */
function lastErrorOf(
  outcomes: PersonaEvolutionCandidateOutcome[],
  workerFailure: MaintenanceFailure | undefined,
): string | undefined {
  const failed = outcomes.filter((outcome) => outcome.failure !== undefined);
  const last = failed[failed.length - 1];
  if (last?.failure) {
    return `${last.role_id}: ${last.failure.code}: ${last.failure.message}`;
  }
  if (workerFailure) return `${workerFailure.code}: ${workerFailure.message}`;
  return undefined;
}
