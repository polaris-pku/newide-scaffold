/**
 * 阶段 2 role 自主循环的**真实引擎适配层**（app 组合根）。
 *
 * 职责与核心逻辑：
 * - 把 stage executor 显式选择的 `execution_engine='role_autonomy'` 落到一次 Run：
 *   打开该 Run 的 RunDispatchJournal（阶段 1 单写者账本）→ 在调用 role LLM 之前写入/读回
 *   冻结的 `init` 控制行（引擎版本、工具授权、开关、四类预算、deadline、routing 引用）→
 *   恢复已消费预算 → 组装 memory/dispatch/evidence 端口 → 调 `runRoleExecutionLoop` →
 *   把 outcome 映射成 protocol 的 `AgentExecutionResult`（completed）或抛
 *   `RoleTerminationError`（blocked/failed/budget/host）。
 * - 派工复用阶段 1 的 `runJournaledDispatch`（accepted→dispatched→driver once→evidence→
 *   settled 写屏障），driver 每 dispatch 只调用一次，**没有自动重试/自动重放**；unknown 只
 *   作为事实交还 role 决策。§3 ADP receipt 写屏障不在本文件重写。
 * - 恢复：同 Run 重启时 Journal 里已有 role finish 就直接复现终态（不再调用 LLM/driver）；
 *   accepted-only/dispatched-only/settled 的解释沿用阶段 1 折叠；新 Run 写自己的 Journal，
 *   祖先链只读（peek），预算余额与原 deadline 继承、不因 restart 重置。
 * - 本文件不做选路（选路在 role-autonomy-selection.ts，stage executor 调用）；不写
 *   coordination 终态，也不改 Gate/Deliver。
 * - 阶段 3（默认关闭）：冻结策略的 `evidence_only` 传给 driver invoker 作为派工 prompt 分支；
 *   `buffer_v2` 时把 finish 后的执行事实 + Role 反思交给 `role-learning-input.ts` 落 Buffer v2
 *   并在线登记一条 Context Delivery（不在本文件做经验提取）。
 *
 * 依赖注入：预算控制器 / finish 校验器 / loop 本体通过工厂注入，因此本文件不 import
 * 它们的实现模块，避免与并行开发互相耦合；真实实现由组合根装配。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createId, nowTimestamp, SCHEMA_VERSION, type ArtifactRef } from '../core';
import type {
  BudgetSnapshot,
  DriverAttemptObservation,
  DriverCommandObservation,
  DriverRunResult,
  JournalFinishEntry,
  JournalInitEntry,
} from '../driver';
import {
  buildExecutionEvidence,
  DRIVER_COMMAND_OBSERVATION_MAX_OUTPUT_CHARS,
  DriverTransportError,
  ExecutionContractViolation,
  hashExecutionEvidence,
  type AdpMappedOutcome,
  type DriverExecutionEvidence,
  hostObservedCheck,
  isDriverEffectEvent,
  mapAdpOutcome,
  parseDriverCommandObservation,
  runVerificationCommand,
  sha256Hex,
  type DispatchRecord,
  type EvidenceRef,
  type ExecutionBrief,
  type ExecutionCheck,
  type ExecutionEvidence,
  type ForeignRetryAnchor,
  type JournalViolation,
} from '../driver';
import { evidenceOf } from '../driver/driver-transport-error';
import { createDriverRuntimeInvoker } from '../driver/driver-runtime-invoker';
import type { DriverRuntimeHandle } from '../driver/contract';
import { runJournaledDispatch, type DispatchAttemptResult } from '../driver/dispatch-attempt';
import { DispatchJournalBarrierError } from '../driver/dispatch-attempt';
import {
  DISPATCH_EVIDENCE_DIR,
  DISPATCH_JOURNAL_DIR,
  RunDispatchJournal,
  type DispatchJournalIo,
  type DispatchJournalReadResult,
} from '../persistence';
import type { AgentExecutionResult } from '../protocol/agent-execution';
import {
  createAgentMemoryScope,
  repositoryRetrieveMemoryForTask,
  AgentQueryMemoryTool,
  type AgentTaskRequest,
  type BufferMemoryUsedEntry,
  type BufferRepository,
  type EmbeddingProvider,
  type MemoryRepository,
  type PersonaDef,
  type ToolCallingClient,
  type ToolCallMessage,
  type ToolDefinition,
} from '../memory';
import {
  collectWorkspaceArtifactsFromContent,
  diffWorkspaceFiles,
  hashWorkspaceContent,
  mergeArtifacts,
  snapshotWorkspaceContent,
  snapshotWorkspaceContentSync,
  snapshotWorkspaceFiles,
  type WorkspaceContentSnapshot,
  type WorkspaceFileSnapshot,
} from '../coordinator/workspace-change-detector';
import {
  buildRoleFreezeInitInput,
  effectiveDispatchRecordStatus,
  isRoleAutonomySwitchCombinationValid,
  resolveBlockingUnresolvedDispatchIds,
  resolveRolePolicyBudget,
  resolveUnresolvedDispatchIds,
  roleFrozenPolicyFromJournalInit,
  roleTerminationFromDispatchBarrier,
  ROLE_AUTONOMY_ENGINE_VERSION,
  RoleTerminationError,
  type RoleAutonomyEnginePort,
  type RoleAutonomyEngineRequest,
  type RoleBudgetConsumption,
  type RoleBudgetOverrides,
  type RoleBudgetPort,
  type RoleDispatchObservation,
  type RoleDispatchPort,
  type RoleFinishRecord,
  type RoleFinishValidatorPort,
  type RoleFrozenPolicy,
  type RoleFrozenPolicyPlan,
  type RoleFrozenRouting,
  type RoleJournalPort,
  type RoleLoopOptions,
  type RoleLoopOutcome,
  type RoleMemoryPort,
  type RoleUsage,
  type RoleWorkspaceState,
} from './role-autonomy-contract';
import {
  collectRunLineage,
  findFrozenEngineInLineage,
  RoleLineageReadError,
} from './role-autonomy-selection';
import {
  foldRoleBudgetFacts,
  roleBudgetFactsFromLines,
  type RoleBudgetFacts,
} from './role-autonomy-budget';
import { armAbortDeadline } from './role-deadline';
import { ROLE_DISPATCH_EVENT, type RoleLifecycleEvent } from './run-dispatch-events';
import {
  buildRoleLearningInput,
  persistRoleLearningInput,
  type RoleLearningInputDeps,
  type RoleLearningInputWriteResult,
} from './role-learning-input';

export interface RoleAutonomyEngineDeps {
  runs_root: string;
  llm: ToolCallingClient;
  repository: MemoryRepository;
  buffer_repository: BufferRepository;
  embedding?: EmbeddingProvider;
  driver_for: (roleId: string, runId?: string) => DriverRuntimeHandle;
  /** 预算控制器工厂（真实实现由组合根注入，engine 只依赖端口）。 */
  create_budget: (input: {
    frozen: RoleFrozenPolicy['budget'];
    consumed: RoleBudgetConsumption;
    journal: RoleJournalPort;
    clock?: () => Date;
  }) => RoleBudgetPort;
  /** finish 证据校验器工厂。 */
  create_finish_validator: () => RoleFinishValidatorPort;
  /** loop 本体工厂（真实实现由组合根注入）。 */
  run_loop: (options: RoleLoopOptions) => Promise<RoleLoopOutcome>;
  /** 部署级宿主预算覆盖（可提高或降低默认值；非法由选路模块拒绝）。 */
  budget_overrides?: RoleBudgetOverrides;
  routing?: RoleFrozenRouting;
  clock?: () => Date;
  /**
   * 阶段 3 在线学习输入登记端口（组合根接到 Context Delivery outbox）。
   * 只负责登记，不做经验提取；缺省时 Buffer 仍落盘，诊断里记 registration_error。
   */
  learning_input?: RoleLearningInputDeps;
  /** 测试/故障注入用 IO（默认 Node 实现）。 */
  journal_io?: DispatchJournalIo;
}

export class RoleAutonomyEngine implements RoleAutonomyEnginePort {
  /**
   * 迟到结果的持久回执与对账任务（跨 `run()` 生命周期）：
   * - 回调先写 durable receipt（run 内 `role-autonomy/late-results/`），再做 reconciled 追加；
   * - engine 的 Journal 已关闭时安全重新获取写者所有权，拿不到（其他 writer/关闭竞争）就保留回执，
   *   由后续 drain（下次 run 启动 / 显式 drain / 关闭后排空）补偿；
   * - 任何失败都留下回执里的 error 事实，不静默丢弃。
   */
  private readonly lateResults = new Set<Promise<void>>();
  /**
   * 每个 Run 自己的迟到回执上下文，按 run 目录索引。
   *
   * 生产组合根会复用同一个 engine 顺序/并发跑多个 Run：回调必须绑定**派工时所属 Run** 的
   * Journal/目录/错误列表，绝不能读「当前/最近一次 run」猜归属（复审 P1 复现 3）。
   * Run 结束后上下文保留（写者已关闭、无活动写入），供显式 drain 补偿遗留回执；数量有上限。
   */
  private readonly lateContexts = new Map<string, LateResultContext>();
  private static readonly MAX_RETAINED_LATE_CONTEXTS = 16;

  constructor(private readonly deps: RoleAutonomyEngineDeps) {}

  async run(input: RoleAutonomyEngineRequest): Promise<AgentExecutionResult> {
    if (!input.instruction.trim()) {
      throw new RoleTerminationError({
        code: 'host_failed',
        actor: 'host',
        message: 'role autonomy requires a non-empty instruction',
      });
    }
    const runDir = path.join(this.deps.runs_root, input.run_id);
    const identity = { run_id: input.run_id, task_id: input.task_id, role_id: input.role_id };
    let journal: RunDispatchJournal;
    try {
      journal = await RunDispatchJournal.open({
        runDir,
        identity,
        ...(this.deps.journal_io ? { io: this.deps.journal_io } : {}),
      });
    } catch (error) {
      throw new RoleTerminationError(
        {
          code: 'journal_write_failed',
          actor: 'host',
          message: `failed to open the dispatch journal for run ${input.run_id}: ${errorMessage(error)}`,
          details: { stage: 'journal_open' },
        },
        error,
      );
    }

    try {
      const context: LateResultContext = {
        runDir,
        identity,
        journal,
        journalClosed: false,
        receipt_errors: [],
        active: true,
        emit: (event) => this.emitLifecycle(input, event),
      };
      // 同一 Run 并发进入（第二个写者）已经被 Journal 锁在上层拒绝；这里按 run 目录覆盖注册，
      // 并发不同 Run 各有自己的上下文，关闭/drain/错误列表互不干扰。
      this.lateContexts.set(context.runDir, context);
      // 上次进程/引擎结束后遗留的迟到回执：在本 Run 自己的写者所有权下先补偿对账。
      await this.drainReceiptsFor(context);
      try {
        return await this.runWithJournal(input, journal, runDir, context);
      } catch (error) {
        // 阶段 4：typed termination 留一条低频投影事件（原因码/actor 与发往 C 层的同一份）。
        // 事件只是投影：Task/Run 状态仍由既有 C 层提交路径写，这里不改变任何终态。
        if (error instanceof RoleTerminationError) {
          this.emitLifecycle(input, {
            type: ROLE_DISPATCH_EVENT.role_terminated,
            subject_id: input.run_id,
            payload: {
              code: error.termination.code,
              actor: error.termination.actor,
              ...(error.termination.message.length > 0
                ? { message: error.termination.message.slice(0, 4_000) }
                : {}),
            },
          });
        }
        throw error;
      }
    } finally {
      const context = this.lateContexts.get(runDir);
      try {
        await journal.close();
      } finally {
        if (context !== undefined) {
          context.active = false;
          context.journalClosed = true;
          // Journal 关闭后仍有未对账回执：用新的写者所有权补偿一次；失败保留回执（可诊断）。
          await this.drainReceiptsFor(context).catch(() => undefined);
        }
        this.pruneLateContexts();
      }
    }
  }

  /**
   * 等待当前所有迟到结果对账任务结束（测试/诊断用；正常终止不等待迟到结果）。
   * 迟到回调可能刚被 promise 结算排队，因此先让出几轮事件循环。
   */
  async waitForLateResultReconciliation(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.lateResults.size === 0) {
        if (attempt >= 2) return;
        continue;
      }
      await Promise.allSettled([...this.lateResults]);
    }
  }

  /**
   * 显式补偿回执（其他 writer 释放后）：对每个已注册 Run 自己的回执目录逐一 drain。
   * 绝不跨 Run 猜测归属；已结束 Run 的上下文保留到上限，仍可被显式补偿。
   */
  async drainLateResultReceipts(): Promise<void> {
    for (const context of [...this.lateContexts.values()]) {
      await this.drainReceiptsFor(context);
    }
  }

  /** 只清理已结束且超出上限的旧上下文；活动 Run 的上下文永不淘汰。 */
  private pruneLateContexts(): void {
    const inactive = [...this.lateContexts.values()].filter((context) => !context.active);
    const excess = inactive.length - RoleAutonomyEngine.MAX_RETAINED_LATE_CONTEXTS;
    for (let index = 0; index < excess; index += 1) {
      const context = inactive[index];
      if (context !== undefined) this.lateContexts.delete(context.runDir);
    }
  }

  /**
   * 排空该 Run 的迟到回执（run 启动、run 关闭后、显式 drain、迟到结果回调共用**同一算法**）：
   * 扫描目录 → 跳过已对账/不可读回执 → 交给 `reconcileReceipt` → 成功删除、失败标 pending。
   * 不同调用者的差异只在 `reconcileReceipt`：写者还开着就直接复用，已关闭才重新获取所有权。
   */
  private async drainReceiptsFor(target: LateResultContext): Promise<void> {
    for (const { file, receipt } of await this.collectLateReceipts(target)) {
      try {
        await this.reconcileReceipt(target, receipt);
        await fs.rm(file, { force: true });
      } catch (error) {
        await this.updateLateReceipt(file, {
          status: 'pending',
          attempts: (receipt.attempts ?? 0) + 1,
          error: errorMessage(error),
        });
        target.receipt_errors.push(
          `late-result ${receipt.dispatch_id} not reconciled: ${errorMessage(error)}`,
        );
      }
    }
  }

  /**
   * 回执目录唯一的扫描/读取算法：只返回仍待对账的回执；解析失败的标记 `unreadable` 后跳过，
   * 目录不存在视为没有回执，其它读取错误记录到该 Run 的诊断（不跨 Run 串联）。
   */
  private async collectLateReceipts(
    target: LateResultContext,
  ): Promise<Array<{ file: string; receipt: LateResultReceipt }>> {
    const directory = this.lateResultDirectory(target.runDir);
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) return [];
      target.receipt_errors.push(`read late-result directory: ${errorMessage(error)}`);
      return [];
    }
    const receipts: Array<{ file: string; receipt: LateResultReceipt }> = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(directory, name);
      let receipt: LateResultReceipt;
      try {
        receipt = JSON.parse(await fs.readFile(file, 'utf8')) as LateResultReceipt;
      } catch (error) {
        await this.updateLateReceipt(file, {
          status: 'unreadable',
          error: `cannot parse late-result receipt: ${errorMessage(error)}`,
        });
        continue;
      }
      if (receipt.status === 'reconciled' || receipt.status === 'unreadable') continue;
      receipts.push({ file, receipt });
    }
    return receipts;
  }

  /**
   * 对账单条回执：当前写者仍有效就直接复用；Journal 已关闭/写者竞争时重新获取该 Run 的
   * 写者所有权后重试。仅对「写者不可用」重试，其它错误立即交给排空算法标记 pending。
   */
  private async reconcileReceipt(
    context: LateResultContext,
    receipt: LateResultReceipt,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < LATE_RECONCILE_ATTEMPTS; attempt += 1) {
      try {
        if (!context.journalClosed) {
          const status = await reconcileLateDriverResult(
            context.journal,
            receipt.dispatch_id,
            receipt.execution,
          );
          this.emitReconciled(context, receipt.dispatch_id, status);
          return;
        }
        await this.reconcileWithReopenedJournal(context, receipt);
        return;
      } catch (error) {
        lastError = error;
        if (!isJournalUnavailable(error)) throw error;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 10);
          timer.unref?.();
        });
        context.journalClosed = true;
      }
    }
    throw lastError;
  }

  /** 用重新获取的写者所有权对账单条回执；用完立即关闭（不持有额外锁）。 */
  private async reconcileWithReopenedJournal(
    context: LateResultContext,
    receipt: LateResultReceipt,
  ): Promise<void> {
    let journal: RunDispatchJournal | undefined;
    try {
      journal = await RunDispatchJournal.open({
        runDir: context.runDir,
        identity: context.identity,
        ...(this.deps.journal_io ? { io: this.deps.journal_io } : {}),
      });
      await reconcileLateDriverResult(journal, receipt.dispatch_id, receipt.execution).then(
        (status) => this.emitReconciled(context, receipt.dispatch_id, status),
      );
    } finally {
      await journal?.close().catch(() => undefined);
    }
  }

  private async runWithJournal(
    input: RoleAutonomyEngineRequest,
    journal: RunDispatchJournal,
    runDir: string,
    context: LateResultContext,
  ): Promise<AgentExecutionResult> {
    // 半写尾部按阶段 1 的安全修复机制处理；损坏/不可读必须 fail closed，
    // 不能退回 legacy 或重新冻结（RD-JRN-04）。
    await this.prepareJournal(journal);
    const fold = await this.foldOrTerminate(journal, 'current');
    const policy = await this.resolveFrozenPolicy(input, journal, fold.init);
    const currentDispatches = fold.records;
    const lineage = await this.lineageRunIds(input);
    // 祖先 Journal 只读；损坏/不可读同样 fail closed（只有「没有 Journal」才按旧 Run 忽略）。
    const ancestors = await this.peekAncestorJournals(input, lineage);
    // 阶段 4：把父链已有的派工事实作为**只读投影**发进本 Run 的时间线。它不写父目录、
    // 也不伪造当前 Run 的 dispatch；`dispatch_summary.inherited` 据此与当前计数分开。
    this.emitInheritedDispatches(input, ancestors);
    // 阶段 4 修复 R4-01：事件是投影、Journal 是事实源。上一轮执行的事件出口可能失败，或
    // 进程在 accepted/settled 事件落盘前被杀；恢复入口用已折叠的 Journal 记录按
    // dispatch_id 幂等补发当前 Run 的低频事实（不派工、不重置预算/游标、不改终态）。
    this.emitRecoveredDispatches(input, currentDispatches);
    // 基线/产物索引属于**同一次逻辑执行**：沿恢复链继承并核验，不能把恢复前的已修改状态
    // 重新当成初始基线（否则恢复后不再改文件就会漏交付）。
    const workspaceBefore = await this.loadWorkspaceBaseline(runDir, input.workspace_path, lineage);
    const priorArtifacts = await this.readArtifactIndex(runDir, lineage);

    // 已有 role finish：复现终态，不再调用 LLM/driver（崩溃恢复幂等）。
    if (fold.finish !== undefined) {
      if (fold.finish.status === 'completed') {
        await this.assertNoUnresolvedDispatches(journal, ancestors);
      }
      const artifacts = await this.collectFinalArtifacts(input, workspaceBefore, priorArtifacts);
      return this.resultFromRecoveredFinish(
        input,
        runDir,
        journal,
        policy,
        fold.finish,
        currentDispatches,
        artifacts,
      );
    }

    const currentRead = await journal.read();
    const consumed = await this.restoreConsumedBudget(currentRead, currentDispatches, ancestors);
    const budget = this.deps.create_budget({
      frozen: policy.budget,
      consumed,
      journal,
      ...(this.deps.clock ? { clock: this.deps.clock } : {}),
    });
    // 恢复时额度已耗尽：必须在任何 LLM/记忆/Driver 外部调用之前显式结束。
    this.assertBudgetUsableBeforeExternalCall(budget);

    // 跨 Run 显式重试：把祖先记录作为锚点交给当前 Journal 的 retry 校验，
    // 绝不伪造当前 Run 的 dispatch 事实。
    journal.setForeignRetryAnchors(foreignRetryAnchors(ancestors));
    const recoveredDispatches = this.recoveredDispatchObservations(currentDispatches, ancestors);
    const allPriorRecords = [
      ...currentDispatches,
      ...ancestors.flatMap((ancestor) => ancestor.readRecords),
    ];
    const recoveredDispatchCount = allPriorRecords.length;
    const recoveredUnresolved = resolveUnresolvedDispatchIds(allPriorRecords);
    const recoverySummary = renderRecoverySummary({
      current_run_id: input.run_id,
      current: currentDispatches,
      ancestors: ancestors.map((ancestor) => ({
        run_id: ancestor.run_id,
        records: ancestor.readRecords,
      })),
    });

    // 祖先链只读继承：read_evidence 允许读取祖先 Run 已登记的受控 ref；
    // finish(completed) 还必须覆盖祖先链的未收束 unknown、只读违规、response_only 冲突，
    // 并允许按同样的适用性规则使用祖先的有效检查证据。
    const roleJournal = this.withAncestorEvidence(journal, ancestors);
    const finish = this.withAncestorFinishPolicy(this.deps.create_finish_validator(), ancestors);
    const workspaceState = () => this.workspaceState(input.workspace_path);

    const artifactState: ArtifactRef[] = [...priorArtifacts];
    const dispatchPort: RoleDispatchPort = {
      run: async (dispatchInput) => {
        const observation = await this.runDispatch(
          input,
          journal,
          dispatchInput,
          policy,
          artifactState,
          runDir,
          ancestors,
          context,
        );
        await this.writeArtifactIndex(runDir, artifactState);
        return observation;
      },
    };
    // 宿主实际交付给 Role 的记忆（召回/查询结果）。它是 host-observed 的使用情况，
    // 与 Role 自述区分开：写进 v2 学习输入，但不据此提高记忆置信度。
    const memoryUsed: BufferMemoryUsedEntry[] = [];
    const memoryPort = this.createMemoryPort(input, memoryUsed);

    const outcome = await this.deps.run_loop({
      llm: this.createLlmPort(),
      journal: roleJournal,
      dispatch: dispatchPort,
      memory: memoryPort,
      policy,
      context: {
        task_id: input.task_id,
        run_id: input.run_id,
        role_id: input.role_id,
        instruction: input.instruction,
        ...(input.workspace_path ? { workspace_path: input.workspace_path } : {}),
        ...(input.session_id ? { confirmed_session_id: input.session_id } : {}),
        ...(policy.routing.driver_id ? { frozen_driver_id: policy.routing.driver_id } : {}),
        response_only_allowed: true,
        ...(input.completion_criteria !== undefined
          ? { completion_criteria: [...input.completion_criteria] }
          : {}),
        ...(recoverySummary.length > 0 ? { recovery_summary: recoverySummary } : {}),
        ...(recoveredDispatches.length > 0 ? { recovered_dispatches: recoveredDispatches } : {}),
        ...(recoveredDispatchCount > 0 ? { recovered_dispatch_count: recoveredDispatchCount } : {}),
        ...(recoveredUnresolved.length > 0
          ? { recovered_unresolved_dispatches: recoveredUnresolved }
          : {}),
        workspace_fingerprint: workspaceState,
      },
      budget,
      finish,
      consumed,
      ...(this.deps.clock ? { clock: this.deps.clock } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      limits: { history_messages: 60, tool_result_chars: 12_000, dispatch_history: 24 },
      on_plan_updated: (plan: string) => {
        this.emitLifecycle(input, {
          type: ROLE_DISPATCH_EVENT.plan_updated,
          subject_id: input.run_id,
          payload: { plan: plan.slice(0, 8_000) },
        });
      },
      on_finish_requested: (finish) => {
        this.emitLifecycle(input, {
          type: ROLE_DISPATCH_EVENT.finish_requested,
          subject_id: input.run_id,
          payload: {
            status: finish.status,
            verification_count: finish.verification_count,
            unresolved_count: finish.unresolved_count,
          },
        });
      },
    });

    const usage = outcome.usage;
    // 学习输入的派工摘要要在 loop 之后重新折叠：入口快照只有本 Run 开始前的记录，
    // loop 期间新写的 accepted/settled 行不在里面。
    const finalRecords = (await this.foldOrTerminate(journal, 'current')).records;
    const finalArtifacts = await this.collectFinalArtifacts(input, workspaceBefore, artifactState);
    await this.writeArtifactIndex(runDir, finalArtifacts);
    // 只带本 Run 自己的回执错误；并发/后续 Run 的错误不会串进这份 transcript。
    const lateReceiptErrors = [...context.receipt_errors];
    await this.writeTranscript(runDir, input, outcome, usage, finalArtifacts, lateReceiptErrors);
    const transcript = await this.transcriptArtifact(runDir, input);

    if (outcome.status === 'completed') {
      // 最终闸门：即使 finish 校验器接受（或注入的校验器有缺陷），祖先/当前链上存在
      // 未收束 unknown 时也不得声称 completed（RD-TRM-04/05）。
      await this.assertNoUnresolvedDispatches(journal, ancestors);
    }

    if (outcome.status !== 'completed') {
      // 未收束的 unknown dispatch 用独立原因码表达（RD-TRM-01 的
      // `dispatch_unknown_unresolved`）；Task/Run 状态仍由 C 层保持 failed。
      const unresolved = outcome.unresolved_dispatches;
      // 失败/阻塞的 finish 也是一条真实执行事实：buffer_v2 打开时同样登记为学习输入，
      // 让离线提取能产出「负经验」而不是只在成功路径学习。登记失败不掩盖终止原因。
      const learningInput = policy.buffer_v2
        ? await this.persistLearningInput(input, runDir, journal, outcome, memoryUsed, finalRecords)
        : undefined;
      throw new RoleTerminationError({
        code:
          unresolved.length > 0
            ? 'dispatch_unknown_unresolved'
            : outcome.status === 'blocked'
              ? 'role_blocked'
              : 'role_failed',
        actor: 'role',
        message: outcome.finish.summary,
        details: {
          finish_status: outcome.status,
          unresolved_dispatches: unresolved,
          evidence_refs: outcome.finish.evidence_refs,
          unresolved: outcome.finish.unresolved,
          dispatches: outcome.dispatches.map((dispatch) => ({
            dispatch_id: dispatch.dispatch_id,
            status: dispatch.status,
          })),
          ...(learningInput !== undefined ? { learning_input: learningInput } : {}),
        },
      });
    }

    return this.completedResult(
      input,
      runDir,
      journal,
      policy,
      outcome,
      transcript,
      usage,
      finalArtifacts,
      finalRecords,
      memoryUsed,
    );
  }

  /**
   * 阶段 3：把一次 role finish 变成 Buffer v2 学习输入（落盘 + 在线登记）。
   *
   * 只做登记，不做提取；任何失败都转成可诊断事实而不是终止原因（学习输入不该让一个
   * 已经达成的执行结果变成失败）。journal_read 在这里现读：前缀 hash 必须覆盖到 finish 行。
   */
  private async persistLearningInput(
    input: RoleAutonomyEngineRequest,
    runDir: string,
    journal: RunDispatchJournal,
    outcome: RoleLoopOutcome,
    memoryUsed: readonly BufferMemoryUsedEntry[],
    records: readonly DispatchRecord[],
  ): Promise<RoleLearningInputWriteResult | { buffer_version: 2; error: string }> {
    try {
      const journalRead = await journal.read();
      const snapshot = buildRoleLearningInput({
        task: {
          task_id: input.task_id,
          run_id: input.run_id,
          role_id: input.role_id,
          task_description: input.instruction,
          ...(input.workspace_path ? { workspace_path: input.workspace_path } : {}),
        },
        outcome,
        records,
        journal_read: journalRead,
        memory_used: memoryUsed,
      });
      return await persistRoleLearningInput({
        run_dir: runDir,
        role_id: input.role_id,
        task_id: input.task_id,
        run_id: input.run_id,
        ...(input.workspace_path ? { workspace_path: input.workspace_path } : {}),
        snapshot,
        deps: this.deps.learning_input ?? {},
        buffer_repository: this.deps.buffer_repository,
      });
    } catch (error) {
      return {
        buffer_version: 2,
        error: `learning input was not persisted: ${errorMessage(error)}`,
      };
    }
  }

  // ── 冻结与恢复 ────────────────────────────────────────────

  private async resolveFrozenPolicy(
    input: RoleAutonomyEngineRequest,
    journal: RoleDispatchJournalPortView,
    existingInit: JournalInitEntry | undefined,
  ): Promise<RoleFrozenPolicy> {
    if (existingInit !== undefined) {
      const frozen = roleFrozenPolicyFromJournalInit(existingInit);
      if (frozen === undefined) {
        throw new RoleTerminationError({
          code: 'host_failed',
          actor: 'host',
          message: 'journal init row is not a valid role_autonomy freeze record',
          details: { reason: 'role_freeze_invalid', run_id: input.run_id },
        });
      }
      if (frozen.engine_version !== ROLE_AUTONOMY_ENGINE_VERSION) {
        throw new RoleTerminationError({
          code: 'host_failed',
          actor: 'host',
          message: `frozen role autonomy engine version ${frozen.engine_version} does not match ${ROLE_AUTONOMY_ENGINE_VERSION}`,
          details: {
            reason: 'role_engine_version_mismatch',
            frozen: frozen.engine_version,
            current: ROLE_AUTONOMY_ENGINE_VERSION,
          },
        });
      }
      return frozen;
    }

    const lineage = await findFrozenEngineInLineage({
      runs_root: this.deps.runs_root,
      run_id: input.run_id,
      ...(input.restarted_from_run_id !== undefined
        ? { restarted_from_run_id: input.restarted_from_run_id }
        : {}),
      identity: { run_id: input.run_id, task_id: input.task_id, role_id: input.role_id },
    });
    const inherited =
      lineage === undefined
        ? undefined
        : lineage.init.engine === 'role_autonomy'
          ? roleFrozenPolicyFromJournalInit(lineage.init)
          : undefined;
    if (lineage !== undefined && inherited === undefined) {
      throw new RoleTerminationError({
        code: 'host_failed',
        actor: 'host',
        message: `ancestor run ${lineage.run_id} has a non-role-autonomy frozen engine`,
        details: { reason: 'ancestor_engine_mismatch', ancestor_run_id: lineage.run_id },
      });
    }
    if (inherited !== undefined && inherited.engine_version !== ROLE_AUTONOMY_ENGINE_VERSION) {
      throw new RoleTerminationError({
        code: 'host_failed',
        actor: 'host',
        message: `inherited frozen engine version ${inherited.engine_version} does not match ${ROLE_AUTONOMY_ENGINE_VERSION}`,
        details: { reason: 'role_engine_version_mismatch', ancestor_run_id: lineage?.run_id },
      });
    }

    // 新 Run 的预算/deadline 只来自选路冻结计划（或部署覆盖 + TaskBudget 的唯一合并入口），
    // engine 不再各自推导出第二份策略（RD-SEL-03）。
    const computedPlan = inherited === undefined ? this.resolveBudgetPlan(input) : undefined;
    const plan = computedPlan;
    if (inherited === undefined && plan === undefined) {
      throw new RoleTerminationError({
        code: 'host_failed',
        actor: 'host',
        message: 'role autonomy budget overrides or task budget are invalid',
        details: { reason: 'role_budget_override_invalid' },
      });
    }
    const limits = inherited?.budget.limits ?? plan!.limits;
    const deadlineAt = inherited?.budget.deadline_at ?? plan!.deadline_at;
    const routing = inherited?.routing ?? plan!.routing;
    const maxToolCalls = inherited?.budget.max_tool_calls ?? plan?.max_tool_calls;
    // 阶段 3 开关与预算同源冻结：新 Run 取选路计划，继承链取祖先冻结值（恢复不切换）。
    const evidenceOnly = inherited?.evidence_only ?? plan!.evidence_only;
    const bufferV2 = inherited?.buffer_v2 ?? plan!.buffer_v2;
    if (
      !isRoleAutonomySwitchCombinationValid({ evidence_only: evidenceOnly, buffer_v2: bufferV2 })
    ) {
      throw new RoleTerminationError({
        code: 'host_failed',
        actor: 'host',
        message: 'buffer_v2 requires evidence_only in the frozen role autonomy policy',
        details: {
          reason: 'role_switch_invalid',
          evidence_only: evidenceOnly,
          buffer_v2: bufferV2,
        },
      });
    }
    const freezeInput = buildRoleFreezeInitInput({
      limits,
      deadline_at: deadlineAt,
      routing,
      evidence_only: evidenceOnly,
      buffer_v2: bufferV2,
      ...(maxToolCalls !== undefined ? { max_tool_calls: maxToolCalls } : {}),
    });
    try {
      // Journal init 的 at 用冻结决策时刻：deadline_at - at 恰好等于墙钟上限，
      // 恢复时不会被「写 init 的几毫秒」悄悄放宽/收紧。
      await journal.appendInit(
        plan !== undefined ? { ...freezeInput, at: plan.frozen_at } : freezeInput,
      );
    } catch (error) {
      throw new RoleTerminationError(
        {
          code: 'journal_write_failed',
          actor: 'host',
          message: `failed to persist the role autonomy freeze record: ${errorMessage(error)}`,
          details: { stage: 'journal_init' },
        },
        error,
      );
    }
    return {
      engine: 'role_autonomy',
      engine_version: freezeInput.engine_version,
      tool_allowlist: freezeInput.tool_allowlist,
      evidence_only: evidenceOnly,
      buffer_v2: bufferV2,
      budget: {
        limits,
        deadline_at: deadlineAt,
        ...(maxToolCalls !== undefined ? { max_tool_calls: maxToolCalls } : {}),
      },
      routing,
    };
  }

  /**
   * 新 Run 的冻结计划：优先使用 stage 选路已经算好的 `freeze_plan`（避免二次合并）；
   * 缺省时用 {@link resolveRolePolicyBudget}（部署覆盖 + TaskBudget 的唯一入口）。
   */
  private resolveBudgetPlan(input: RoleAutonomyEngineRequest): RoleFrozenPolicyPlan | undefined {
    if (input.freeze_plan !== undefined) {
      // 选路计划是权威；直接调用者/旧测试夹具没带阶段 3 开关时按关闭解释。
      return {
        ...input.freeze_plan,
        evidence_only: input.freeze_plan.evidence_only ?? false,
        buffer_v2: input.freeze_plan.buffer_v2 ?? false,
      };
    }
    const resolved = resolveRolePolicyBudget({
      overrides: this.deps.budget_overrides ?? {},
      ...(input.task_budget !== undefined ? { task_budget: input.task_budget } : {}),
    });
    if (resolved === undefined) return undefined;
    const now = this.deps.clock?.() ?? new Date();
    const frozenAt = now.toISOString();
    return {
      limits: resolved.limits,
      deadline_at: new Date(
        now.getTime() + resolved.limits.wall_clock_seconds * 1_000,
      ).toISOString(),
      frozen_at: frozenAt,
      max_tool_calls: resolved.max_tool_calls,
      routing: this.deps.routing ?? this.defaultRouting(input),
      // 直接调用 engine（无选路计划）的调用者拿不到部署开关：默认关闭，不猜。
      evidence_only: false,
      buffer_v2: false,
    };
  }

  private defaultRouting(input: RoleAutonomyEngineRequest): RoleFrozenRouting {
    try {
      return { driver_id: this.deps.driver_for(input.role_id, input.run_id).driver_id };
    } catch {
      // driver 解析失败不阻断冻结：真正派工时仍会解析，失败会按屏障/typed termination 处理。
      return {};
    }
  }

  /**
   * 已消费预算：当前 Run + 祖先链（dispatches / role_rounds / tokens / tool_calls），restart 不清零。
   * 折算法只有一份（`foldRoleBudgetFacts`，生产/测试共用）：这里只负责把每级 Run 的 Journal
   * 事实收集成 Facts（当前 Run 在前，祖先由近到远）。
   */
  private async restoreConsumedBudget(
    currentRead: DispatchJournalReadResultView,
    currentRecords: readonly DispatchRecord[],
    ancestors: readonly AncestorJournal[],
  ): Promise<RoleBudgetConsumption> {
    const facts: RoleBudgetFacts[] = [
      roleBudgetFactsFromLines(currentRecords.length, currentRead.lines),
    ];
    for (const ancestor of ancestors) {
      facts.push(roleBudgetFactsFromLines(ancestor.readRecords.length, ancestor.read.lines));
    }
    return foldRoleBudgetFacts(facts);
  }

  /** 当前 Run 的 Journal 尾部预处理：repairable_tail 修复；corrupt 直接终止。 */
  private async prepareJournal(journal: RunDispatchJournal): Promise<void> {
    let snapshot;
    try {
      snapshot = await journal.read();
    } catch (error) {
      throw journalFailure('journal_unreadable', 'cannot read the dispatch journal', error);
    }
    if (snapshot.status === 'corrupt') {
      throw journalFailure(
        'journal_corrupt',
        'dispatch journal is corrupt; refusing to guess an execution engine',
        { problems: snapshot.problems },
      );
    }
    if (snapshot.status === 'repairable_tail') {
      try {
        // 复用阶段 1 的安全修复（保留原字节/hash + repair 行），不手写修复逻辑。
        await journal.repairTail();
      } catch (error) {
        throw journalFailure(
          'journal_corrupt',
          'dispatch journal has an unrepairable half-written tail',
          error,
        );
      }
    }
  }

  private async foldOrTerminate(
    journal: RunDispatchJournal,
    which: 'current' | 'ancestor',
  ): Promise<Awaited<ReturnType<RunDispatchJournal['fold']>>> {
    try {
      return await journal.fold();
    } catch (error) {
      throw journalFailure(
        'journal_corrupt',
        `cannot fold the ${which} dispatch journal into dispatch records`,
        error,
      );
    }
  }

  /**
   * 祖先 Run 的只读 journal 快照（当前 Run 之后、按由近到远排序）。
   * 只有「该祖先 Run 没有 Journal」才允许忽略；损坏/不可读一律 fail closed
   * （否则会漏掉祖先的 unknown 或把它当全新 Run 接管）。
   */
  private async peekAncestorJournals(
    input: RoleAutonomyEngineRequest,
    lineage: readonly string[],
  ): Promise<AncestorJournal[]> {
    const ancestors: AncestorJournal[] = [];
    for (const ancestorId of lineage.slice(1)) {
      const runDir = path.join(this.deps.runs_root, ancestorId);
      let journal: RunDispatchJournal;
      try {
        journal = await RunDispatchJournal.peek({
          runDir,
          identity: {
            run_id: ancestorId,
            task_id: input.task_id,
            role_id: input.role_id,
          },
        });
      } catch (error) {
        if (isErrnoCode(error, 'ENOENT')) continue; // 旧 Run 没有 run 目录 = 没有 Journal。
        throw journalFailure(
          'journal_unreadable',
          `cannot open the ancestor dispatch journal for run ${ancestorId}`,
          error,
        );
      }
      let read;
      try {
        read = await journal.read();
      } catch (error) {
        if (isErrnoCode(error, 'ENOENT')) continue;
        throw journalFailure(
          'journal_unreadable',
          `cannot read the ancestor dispatch journal for run ${ancestorId}`,
          error,
        );
      }
      if (read.status === 'corrupt') {
        throw journalFailure(
          'journal_corrupt',
          `ancestor dispatch journal for run ${ancestorId} is corrupt`,
          { ancestor_run_id: ancestorId, problems: read.problems },
        );
      }
      // run.restart 创建新 Task；祖先账本必须按自己的 init.task_id 折叠，
      // 不能拿当前 Task 身份判祖先为损坏。run_id/role_id 仍由恢复链与当前 Role 约束。
      const init = read.controls.find((entry) => entry.event === 'init');
      if (init !== undefined && init.task_id !== input.task_id) {
        journal = await RunDispatchJournal.peek({
          runDir,
          identity: { run_id: ancestorId, task_id: init.task_id, role_id: input.role_id },
        });
      }
      const fold = await this.foldOrTerminate(journal, 'ancestor');
      ancestors.push({ run_id: ancestorId, journal, read, readRecords: fold.records });
    }
    return ancestors;
  }

  /**
   * read_evidence 的祖先链只读回退：只接受本 Run 或祖先链登记过的受控 ref；
   * 路径/大小/hash 校验仍由 RunDispatchJournal.readEvidence 完成。
   */
  private withAncestorEvidence(
    current: RunDispatchJournal,
    ancestors: readonly AncestorJournal[],
  ): RoleJournalPort {
    return {
      read: () => current.read(),
      fold: () => current.fold(),
      appendInit: (input) => current.appendInit(input),
      appendFinish: (input) => current.appendFinish(input),
      appendRoleRound: (input) => current.appendRoleRound(input),
      registerEvidenceRef: (ref) => current.registerEvidenceRef(ref),
      getDispatchRecord: (dispatchId) => current.getDispatchRecord(dispatchId),
      readEvidence: async (ref, options) => {
        try {
          return await current.readEvidence(ref, options);
        } catch (error) {
          const code = Reflect.get(error as object, 'code');
          if (code !== 'evidence_ref_not_registered' && code !== 'evidence_missing') {
            throw error;
          }
          for (const ancestor of ancestors) {
            try {
              return await ancestor.journal.readEvidence(ref, options);
            } catch (ancestorError) {
              const ancestorCode = Reflect.get(ancestorError as object, 'code');
              if (
                ancestorCode !== 'evidence_ref_not_registered' &&
                ancestorCode !== 'evidence_missing'
              ) {
                throw ancestorError;
              }
            }
          }
          throw error;
        }
      },
    };
  }

  /**
   * 仅向 finish 校验器提供祖先事实；校验规则由同一个 validator 决定。
   * unknown 只限制 completed，不能阻止 Role 以 blocked/failed 明确结束。
   */
  private withAncestorFinishPolicy(
    base: RoleFinishValidatorPort,
    ancestors: readonly AncestorJournal[],
  ): RoleFinishValidatorPort {
    const inheritedRecords = ancestors.flatMap((ancestor) => ancestor.readRecords);
    return {
      validate: (input) =>
        base.validate({
          ...input,
          inherited_records: inheritedRecords,
        }),
    };
  }

  /**
   * 恢复链遍历：算法与 selection 共用 {@link collectRunLineage}（同一深度上限、循环检测与
   * 读取失败语义）；这里只把读取失败映射成 typed termination（不能当成「没有父链」）。
   */
  private async lineageRunIds(input: RoleAutonomyEngineRequest): Promise<string[]> {
    try {
      return await collectRunLineage(
        this.deps.runs_root,
        input.run_id,
        input.restarted_from_run_id,
      );
    } catch (error) {
      if (error instanceof RoleLineageReadError) {
        throw new RoleTerminationError(
          {
            code: 'host_failed',
            actor: 'host',
            message: error.message,
            details: { reason: 'lineage_unreadable', run_id: error.run_id },
          },
          error,
        );
      }
      throw error;
    }
  }

  /** 最终闸门：当前 Run + 祖先链上不存在未收束的 unknown dispatch。 */
  private async assertNoUnresolvedDispatches(
    currentJournal: RunDispatchJournal,
    ancestors: readonly AncestorJournal[],
  ): Promise<void> {
    const folded = await this.foldOrTerminate(currentJournal, 'current');
    const records = new Map<string, DispatchRecord>();
    // 当前 Run 的最新事实优先，祖先按近到远补充；这里也覆盖已持久化 finish 的恢复入口。
    for (const record of [
      ...folded.records,
      ...ancestors.flatMap((ancestor) => ancestor.readRecords),
    ]) {
      if (!records.has(record.dispatch_id)) records.set(record.dispatch_id, record);
    }
    const unresolved = resolveBlockingUnresolvedDispatchIds([...records.values()]);
    if (unresolved.length === 0) return;
    throw new RoleTerminationError({
      code: 'dispatch_unknown_unresolved',
      actor: 'role',
      message: `role finished completed but unknown dispatches are unresolved: ${unresolved.join(', ')}`,
      details: { unresolved_dispatches: unresolved },
    });
  }

  private async resultFromRecoveredFinish(
    input: RoleAutonomyEngineRequest,
    runDir: string,
    journal: RunDispatchJournal,
    policy: RoleFrozenPolicy,
    finish: JournalFinishEntry,
    records: readonly DispatchRecord[],
    artifacts: readonly ArtifactRef[],
  ): Promise<AgentExecutionResult> {
    if (finish.actor !== 'role' && finish.actor !== 'host') {
      throw new RoleTerminationError({
        code: 'host_failed',
        actor: 'host',
        message: `journal finish actor ${finish.actor} is not a role-loop finish`,
        details: { reason: 'journal_finish_actor_mismatch' },
      });
    }
    const finishRecord: RoleFinishRecord = {
      status:
        finish.status === 'completed'
          ? 'completed'
          : finish.status === 'blocked'
            ? 'blocked'
            : 'failed',
      summary: finish.summary ?? finish.reason,
      evidence_refs: finish.evidence_refs,
      unresolved: finish.unresolved ?? [],
      role_reflection: finish.role_reflection ?? '',
      response_only: finish.response_only ?? false,
      verification: finish.verification ?? [],
      accepted_at: finish.at,
    };
    const outcome: RoleLoopOutcome = {
      status: finishRecord.status,
      finish: finishRecord,
      // finish.summary 就是最终答复：不拿恢复前的旧正文冒充（RD-FIN-01）。
      response: finishRecord.summary,
      dispatches: records
        .filter((record) => record.evidence !== undefined && record.evidence_sha256 !== undefined)
        .map(recordToObservation),
      usage: { input_tokens: 0, output_tokens: 0, usage_missing: true, role_rounds: 0 },
      // 恢复时以 finish 行记录的 zero_dispatch 为准（恢复前真实工作不能丢）；
      // 旧数据没有该字段时按折叠记录数保守判断。
      zero_dispatch: finish.zero_dispatch ?? records.length === 0,
      plan: undefined,
      // 与 finish 校验/engine 最终闸门共用同一 reducer：可信 reconciled 收束过的 unknown
      // 不再是未决派工（原始记录仍保留 unknown）；零变更的只读超时不算阻塞交付。
      unresolved_dispatches: resolveBlockingUnresolvedDispatchIds(records),
    };
    if (finishRecord.status !== 'completed') {
      // 恢复到一条 blocked/failed finish：学习输入照样登记（与首次执行同一规则）。
      const learningInput = policy.buffer_v2
        ? await this.persistLearningInput(input, runDir, journal, outcome, [], records)
        : undefined;
      throw new RoleTerminationError({
        code: finishRecord.status === 'blocked' ? 'role_blocked' : 'role_failed',
        actor: 'role',
        message: finishRecord.summary,
        details: {
          recovered: true,
          evidence_refs: finishRecord.evidence_refs,
          ...(learningInput !== undefined ? { learning_input: learningInput } : {}),
        },
      });
    }
    const transcript = await this.transcriptArtifact(runDir, input);
    // 恢复路径拿不到恢复前的记忆交付事实（不伪造）：memory_used 如实为空。
    return this.completedResult(
      input,
      runDir,
      journal,
      policy,
      outcome,
      transcript,
      outcome.usage,
      artifacts,
      records,
      [],
    );
  }

  // ── 端口组装 ──────────────────────────────────────────────

  private createLlmPort() {
    return {
      completeWithTools: async (input: {
        messages: ToolCallMessage[];
        tools: ToolDefinition[];
        signal?: AbortSignal;
      }) => {
        if (input.signal?.aborted) throw abortError(input.signal);
        const result = await this.deps.llm.completeWithTools({
          messages: input.messages,
          tools: input.tools,
          tool_choice: 'auto',
        });
        const usage = readToolCallUsage(result as { usage?: unknown });
        return {
          content: result.content,
          tool_calls: result.tool_calls,
          ...(usage !== undefined ? { usage } : {}),
          ...(result.finish_reason !== undefined
            ? { finish_reason: result.finish_reason }
            : {}),
        };
      },
    };
  }

  private createMemoryPort(
    input: RoleAutonomyEngineRequest,
    memoryUsed: BufferMemoryUsedEntry[],
  ): RoleMemoryPort {
    const scope = createAgentMemoryScope(
      this.deps.repository,
      this.deps.buffer_repository,
      input.role_id,
    );
    const queryTool = new AgentQueryMemoryTool(scope, this.deps.embedding);
    const task: AgentTaskRequest = {
      spec: input.instruction,
      task_id: input.task_id,
      run_id: input.run_id,
      ...(input.workspace_path ? { workspace_path: input.workspace_path } : {}),
      call_id: createId('call'),
      source_driver: this.deps.driver_for(input.role_id, input.run_id).driver_id,
    };
    /** 记录宿主实际交给 Role 的记忆（按 kind:id 去重；只作 dependent 输入）。 */
    const recordMemoryUsed = (
      kind: BufferMemoryUsedEntry['kind'],
      id: string,
      via: BufferMemoryUsedEntry['via'],
    ): void => {
      if (id.length === 0) return;
      if (memoryUsed.some((entry) => entry.kind === kind && entry.id === id)) return;
      memoryUsed.push({ kind, id, via });
    };
    return {
      recall: async (_input, signal) => {
        // 自动召回 + Persona 进入 role 首轮上下文（RD-OWN/阶段 2 上下文要求）。
        // 取消/总墙钟由 loop 的 runGuarded 竞速兜底；这里尽量提前拒绝，减少无谓工作。
        if (signal?.aborted === true) throw abortError(signal);
        const [persona, retrieval] = await Promise.all([
          scope.getPersona().catch(() => undefined),
          repositoryRetrieveMemoryForTask(scope, task, input.task_id, {
            ...(this.deps.embedding ? { embedding: this.deps.embedding } : {}),
          }),
        ]);
        if (persona !== undefined) {
          recordMemoryUsed(
            'persona',
            `${persona.role_id}@v${String(persona.version)}`,
            'auto_recall',
          );
        }
        for (const skill of retrieval.skills) recordMemoryUsed('skill', skill.id, 'auto_recall');
        for (const experience of retrieval.experiences) {
          recordMemoryUsed('experience', experience.id, 'auto_recall');
        }
        const sections = [
          ...(persona !== undefined ? [renderPersona(persona)] : []),
          renderRecall(retrieval.skills, retrieval.experiences),
        ].filter((section) => section.length > 0);
        return { text: sections.join('\n\n') };
      },
      query: async ({ query, limit }) => {
        const output = await queryTool.execute({ query });
        for (const skill of output.skills ?? []) recordMemoryUsed('skill', skill.id, 'query');
        for (const experience of output.experiences ?? []) {
          recordMemoryUsed('experience', experience.id, 'query');
        }
        const rendered = renderRecall(output.skills ?? [], output.experiences ?? []);
        const count = (output.skills?.length ?? 0) + (output.experiences?.length ?? 0);
        return {
          text: limit === undefined ? rendered : rendered.slice(0, limit * 2_000),
          count,
        };
      },
    };
  }

  private async runDispatch(
    input: RoleAutonomyEngineRequest,
    journal: RunDispatchJournal,
    dispatchInput: { brief: ExecutionBrief; brief_sha256: string; budget_before: BudgetSnapshot },
    policy: RoleFrozenPolicy,
    artifacts: ArtifactRef[],
    runDir: string,
    ancestors: readonly AncestorJournal[],
    context: LateResultContext,
  ): Promise<RoleDispatchObservation> {
    const brief = dispatchInput.brief;
    this.assertSessionReuseAllowed(input, brief);
    await this.assertCrossRunRetryAllowed(journal, brief, ancestors);
    // 阶段 4：宿主接受 brief 的低频投影。它在 Journal accepted 写屏障之前发出——
    // 若屏障失败，投影里只会有 accepted 没有 started，按契约折叠为 not_executed，
    // 语义仍然正确（没有派工执行过）。
    this.emitLifecycle(input, {
      type: ROLE_DISPATCH_EVENT.accepted,
      subject_id: brief.dispatch_id,
      payload: {
        dispatch_id: brief.dispatch_id,
        kind: brief.kind,
        read_only: brief.read_only,
        session_mode: brief.session.mode,
        sequence: brief.sequence,
        ...(brief.retry_of !== undefined ? { retry_of: brief.retry_of } : {}),
      },
    });
    const captured: { driver_artifacts: ArtifactRef[] } = { driver_artifacts: [] };
    try {
      const result: DispatchAttemptResult = await runJournaledDispatch({
        journal,
        brief,
        brief_sha256: dispatchInput.brief_sha256,
        budget_before: dispatchInput.budget_before,
        execute: async () => {
          // Journal 的 accepted/dispatched 两行已经 durable，这里才是真正开始 driver 调用。
          this.emitLifecycle(input, {
            type: ROLE_DISPATCH_EVENT.started,
            subject_id: brief.dispatch_id,
            payload: { dispatch_id: brief.dispatch_id, kind: brief.kind },
          });
          return this.executeDriver(input, journal, brief, policy, runDir, captured, context);
        },
      });
      // 派工已按事实 settle：投影只带身份/状态/违规/受控 evidence 引用（正文在侧车）。
      this.emitLifecycle(input, {
        type: ROLE_DISPATCH_EVENT.settled,
        subject_id: brief.dispatch_id,
        payload: {
          dispatch_id: brief.dispatch_id,
          kind: brief.kind,
          status: result.status,
          violations: [...result.violations],
          attempts: result.attempts,
          evidence_ref: {
            path: result.evidence_ref.path,
            sha256: result.evidence_sha256,
          },
        },
      });
      appendArtifacts(artifacts, captured.driver_artifacts);
      // 取消/墙钟在派工等待期间发生：dispatch 已按事实 settle（unknown，不重放），
      // 但 loop 不得继续；抛 typed termination，让原因码一路保留到 task.error。
      this.assertTerminationAfterDispatch(input, policy, brief.dispatch_id);
      return result;
    } catch (error) {
      if (error instanceof DispatchJournalBarrierError) {
        // Journal/evidence 写失败：立刻终止，不继续派工/成功 finish（RD-JRN-03）。
        // 原因码映射与工具表共用 `roleTerminationFromDispatchBarrier`，两条调用路径不各写一份。
        throw roleTerminationFromDispatchBarrier(error);
      }
      throw error;
    }
  }

  /**
   * 跨 Run 重试必须通过**实际 Journal 引用校验**：祖先 unknown 的 reconciliation_ref 要能被
   * 祖先 Journal 的受控读取面验证（登记 + hash + 路径），不能只用模型给的 path/sha。
   */
  private async assertCrossRunRetryAllowed(
    journal: RunDispatchJournal,
    brief: ExecutionBrief,
    ancestors: readonly AncestorJournal[],
  ): Promise<void> {
    const retryOf = brief.retry_of;
    if (retryOf === undefined) return;
    if ((await journal.getDispatchRecord(retryOf)) !== undefined) return;
    for (const ancestor of ancestors) {
      const record = ancestor.readRecords.find((candidate) => candidate.dispatch_id === retryOf);
      if (record === undefined) continue;
      if (record.status === 'succeeded') {
        throw new ExecutionContractViolation(
          'retry_not_allowed',
          `retry_of ${retryOf} already succeeded in ancestor run ${ancestor.run_id}`,
        );
      }
      if (record.status !== 'unknown') return;
      const reconciliationRef = brief.reconciliation_ref;
      if (reconciliationRef === undefined) {
        throw new ExecutionContractViolation(
          'retry_without_evidence',
          `retrying unknown ancestor dispatch ${retryOf} requires reconciliation_ref evidence`,
        );
      }
      try {
        await ancestor.journal.readEvidence(reconciliationRef);
      } catch (error) {
        throw new ExecutionContractViolation(
          'retry_without_evidence',
          `reconciliation_ref ${reconciliationRef.path} is not verified evidence of ${retryOf}`,
          error,
        );
      }
      return;
    }
    throw new ExecutionContractViolation(
      'retry_not_allowed',
      `retry_of ${retryOf} does not reference any known dispatch`,
    );
  }

  private assertSessionReuseAllowed(input: RoleAutonomyEngineRequest, brief: ExecutionBrief): void {
    if (brief.session.mode !== 'reuse') return;
    const confirmed = input.session_id;
    if (confirmed !== undefined && brief.session.session_id === confirmed) return;
    throw new RoleTerminationError({
      code: 'host_failed',
      actor: 'host',
      message:
        'role requested Session reuse that is not confirmed for this Run; refusing to dispatch',
      details: { reason: 'session_reuse_unconfirmed', dispatch_id: brief.dispatch_id },
    });
  }

  /**
   * 单次 driver attempt：不重试、不自动补发。
   *
   * 状态来自**既有 ADP 证据化映射**（`mapAdpOutcome`，与 endpoint/reconciler 同一语义）：
   * - 明确未执行（spawn 失败/not_executed）→ failed；
   * - 确定业务失败 → failed；
   * - interrupted + 副作用、断连/超时/传输错误（已收到结果但结局不明）→ unknown；
   * - 超时/取消在途 → 返回 unknown 事实，由 runDispatch settle 后终止 loop。
   * `result_received` 作为独立事实交给 `buildExecutionEvidence`，不从映射后的 status 反推。
   * 命令级观察（受支持 Driver 的 `driver.command_observed`）在这里转成 host_observed checks。
   */
  private async executeDriver(
    input: RoleAutonomyEngineRequest,
    journal: RunDispatchJournal,
    brief: ExecutionBrief,
    policy: RoleFrozenPolicy,
    runDir: string,
    captured: { driver_artifacts: ArtifactRef[] },
    context: LateResultContext,
  ): Promise<DriverAttemptObservation> {
    const driver = this.deps.driver_for(input.role_id, input.run_id);
    const invoker = createDriverRuntimeInvoker(driver);
    const workspace = input.workspace_path;
    const before = workspace ? await snapshotWorkspaceFiles(workspace) : undefined;
    const now = () => this.deps.clock?.() ?? new Date();
    const remainingMs = Math.floor(Date.parse(policy.budget.deadline_at) - now().getTime());
    const effectiveTimeout = resolveDispatchTimeoutMs(brief.timeout_ms, policy, remainingMs);

    const timeoutController = new AbortController();
    const wallClockController = new AbortController();
    // 分段定时：Node 的 setTimeout 超过 2^31-1 ms 会被截成 1ms（长冻结 deadline 会误触发）。
    const disarmTimeout = armAbortDeadline(
      timeoutController,
      effectiveTimeout,
      () => new DriverTransportError('dispatch timed out', 'execution_unconfirmed'),
    );
    const disarmWallClock = armAbortDeadline(
      wallClockController,
      remainingMs,
      () =>
        new RoleTerminationError({
          code: 'budget_wall_clock',
          actor: 'host',
          message: `role wall clock exhausted (deadline ${policy.budget.deadline_at})`,
        }),
    );
    const signals = [
      timeoutController.signal,
      wallClockController.signal,
      ...(input.signal ? [input.signal] : []),
    ];
    const signal = AbortSignal.any(signals);
    let dispatched = false;
    let effectsObserved = false;
    /**
     * 命令观察 + 被检查内容身份。事件到达时宿主**独立重算**工作区内容指纹，与 driver 在
     * 命令结束时上报的 `checked_workspace_sha256` 比对：
     * - 一致 → 该指纹可证明「检查结束 → 宿主观察 → 最终交付」是同一份内容；
     * - 不一致/缺失 → 检查不能绑定到被检查版本（命令后又被修改，或 Driver 不支持该协议），
     *   observation 降级 `partial`，finish 不会把它当通过。
     *
     * 注意：不能用「事件接收时刻的快照」直接当被检查版本——只是用它校验 Driver 上报值；
     * 只有断言通过时才写入检查的 `workspace_sha256`。
     */
    const commandObservations: Array<{
      observation: DriverCommandObservation;
      workspace_sha256?: string;
      fingerprint_verified: boolean;
    }> = [];
    try {
      if (brief.verification_command !== undefined) {
        if (workspace === undefined) {
          throw new DriverTransportError(
            'verification command requires a workspace',
            'not_executed',
          );
        }
        dispatched = true;
        const observed = await runVerificationCommand({
          command: brief.verification_command,
          workspace,
          signal,
        });
        // This command was executed by the host adapter. Capture the checked content before
        // handing control back to Role, using the same fingerprint as final delivery.
        const workspaceSha = hashWorkspaceContent(snapshotWorkspaceContentSync(workspace));
        const observation: DriverCommandObservation = {
          command: [brief.verification_command.executable, ...brief.verification_command.args]
            .map((part) => JSON.stringify(part))
            .join(' '),
          ...observed,
          checked_workspace_sha256: workspaceSha,
          observed_at: now().toISOString(),
        };
        input.on_driver_event?.({
          schema_version: 'driver-event.v1',
          event_type: 'driver.command_observed',
          payload: observation,
          task_id: input.task_id,
          run_id: input.run_id,
          dispatch_id: brief.dispatch_id,
          created_at: now().toISOString(),
        });
        const checks = await this.buildCommandChecks(runDir, brief.dispatch_id, [
          {
            observation,
            workspace_sha256: workspaceSha,
            fingerprint_verified: true,
          },
        ]);
        const response = `exit_code=${observed.exit_code}\n${observed.stdout}\n${observed.stderr}`;
        const delta = await this.workspaceDelta(workspace, before);
        return {
          transport: { evidence: 'execution_unconfirmed' },
          result: {
            status: observed.exit_code === 0 ? 'succeeded' : 'failed',
            driver_id: 'local-verification',
            response,
            ...(observed.exit_code !== 0
              ? {
                  error: {
                    code: 'VERIFICATION_FAILED',
                    message: response.slice(0, 2_000),
                    retryable: false,
                  },
                }
              : {}),
          },
          response_excerpt: response.slice(0, responseExcerptChars()),
          checks,
          ...(delta !== undefined ? { workspace_delta: delta } : {}),
        };
      }
      const invocation = await invoker(
        {
          task_id: input.task_id,
          run_id: input.run_id,
          ...(workspace ? { workspace_path: workspace } : {}),
          ...(brief.session.mode === 'reuse' && brief.session.session_id !== undefined
            ? { session_id: brief.session.session_id, resume_session: true }
            : {}),
          call_id: createId('call'),
          source_driver: driver.driver_id,
          // 阶段 3：evidence-only 分支不要求六字段报告/报告文件；legacy/Council 冻结在
          // evidence_only=false 时仍走原 converter（既有路径行为不变）。
          report_mode: policy.evidence_only ? 'evidence_only' : 'six_field',
          driver_context: {
            task_instruction: renderBriefInstruction(brief),
            skills: [],
            experiences: [],
          },
        },
        {
          signal,
          onDispatch: () => {
            dispatched = true;
          },
          onDriverEvent: (event) => {
            if (isDriverEffectEvent(event)) effectsObserved = true;
            const observation = parseDriverCommandObservation(event);
            if (observation !== undefined) {
              let verified = false;
              let hostSha: string | undefined;
              if (workspace !== undefined) {
                try {
                  hostSha = hashWorkspaceContent(snapshotWorkspaceContentSync(workspace));
                } catch {
                  hostSha = undefined;
                }
                verified =
                  hostSha !== undefined &&
                  observation.checked_workspace_sha256 !== undefined &&
                  observation.checked_workspace_sha256 === hostSha &&
                  observation.truncated !== true;
              }
              commandObservations.push({
                observation,
                // 校验通过才把指纹写成证据；未通过时保留 driver 自报值仅用于审计/过期诊断，
                // observation 会降级 partial，finish 绝不会把它当通过。
                ...(verified && hostSha !== undefined
                  ? { workspace_sha256: hostSha }
                  : observation.checked_workspace_sha256 !== undefined
                    ? { workspace_sha256: observation.checked_workspace_sha256 }
                    : {}),
                fingerprint_verified: verified,
              });
            }
            // 阶段 4：把「哪个派工产生了这条 driver 事件」作为事实随事件转发（usage 归属用）。
            // 只加元数据，不改 driver 事件本身的任何字段。
            input.on_driver_event?.({ ...event, dispatch_id: brief.dispatch_id });
          },
          onLateResult: (execution) => {
            // 超时/取消后迟到的真实结果：先落 durable receipt，再尽力追加 reconciled；
            // 不覆盖终态、不重跑，engine 结束后也能安全重新获取写者所有权对账。
            // 上下文在本 Run 的派工创建时绑定，绝不在回调里按「当前/最近一次 Run」猜测。
            this.handleLateResult(context, brief.dispatch_id, execution);
          },
        },
      );
      const execution = invocation.execution;
      if (execution.artifacts.length > 0) captured.driver_artifacts.push(...execution.artifacts);
      const delta = await this.workspaceDelta(workspace, before);
      const effects =
        effectsObserved ||
        execution.tool_events.length > 0 ||
        execution.artifacts.length > 0 ||
        (delta?.changed_paths.length ?? 0) > 0;
      const checks = await this.buildCommandChecks(runDir, brief.dispatch_id, commandObservations);
      if (invocation.thrown !== undefined) {
        const mapped = mapAdpOutcome({
          kind: 'thrown',
          evidence: {
            dispatched,
            effects_observed: effects,
            result_received: false,
            cancel_requested: false,
          },
          error: invocation.thrown,
        });
        return failureObservation({
          mapped,
          transportEvidence: evidenceOf(invocation.thrown),
          delta,
          checks,
        });
      }
      const mapped = mapAdpOutcome({
        kind: 'result',
        evidence: {
          dispatched,
          effects_observed: effects,
          result_received: true,
          cancel_requested: false,
        },
        execution,
      });
      return resultObservation({ mapped, execution, delta, checks });
    } catch (error) {
      const delta = await this.workspaceDelta(workspace, before).catch(() => undefined);
      // 取消/墙钟/单 dispatch 超时：均为「无法确认结局」的事实，不重放；
      // 由 runDispatch 在 settle 后按用户/墙钟终止，或由 role 继续决策（单 dispatch 超时）。
      if (input.signal?.aborted) {
        return unknownObservation('user_cancelled', 'HOST_CANCELLED', delta);
      }
      if (wallClockController.signal.aborted) {
        return unknownObservation('wall_clock', 'ROLE_WALL_CLOCK_EXHAUSTED', delta);
      }
      if (timeoutController.signal.aborted) {
        return unknownObservation('dispatch_timeout', 'DRIVER_DISPATCH_TIMEOUT', delta);
      }
      if (error instanceof DriverTransportError) {
        return failureObservation({
          mapped: mapAdpOutcome({
            kind: 'thrown',
            evidence: {
              dispatched,
              effects_observed: effectsObserved,
              result_received: false,
              cancel_requested: false,
            },
            error,
          }),
          transportEvidence: evidenceOf(error),
          delta,
          checks: [],
        });
      }
      throw error;
    } finally {
      disarmTimeout();
      disarmWallClock();
    }
  }

  /** 取消/墙钟在派工等待期间发生：settle 后终止 loop（原因码区分用户取消与预算）。 */
  private assertTerminationAfterDispatch(
    input: RoleAutonomyEngineRequest,
    policy: RoleFrozenPolicy,
    dispatchId: string,
  ): void {
    if (input.signal?.aborted) {
      throw new RoleTerminationError({
        code: 'host_cancelled',
        actor: 'user',
        message: 'role execution cancelled by user signal',
        details: { reason: 'cancelled', dispatch_id: dispatchId },
      });
    }
    const now = (this.deps.clock?.() ?? new Date()).getTime();
    if (now >= Date.parse(policy.budget.deadline_at)) {
      throw new RoleTerminationError({
        code: 'budget_wall_clock',
        actor: 'host',
        message: `role wall clock exhausted (deadline ${policy.budget.deadline_at})`,
        details: { dispatch_id: dispatchId, deadline_at: policy.budget.deadline_at },
      });
    }
  }

  /**
   * 受支持 Driver 的命令级观察 → host_observed checks：
   * 原始命令/退出码/stdout/stderr 写成 run 内受控 evidence 文件（hash 绑定），
   * 并绑定**命令结束时 driver 上报、宿主独立重算校验过的**内容指纹与适用路径
   * （不做事后回填；指纹未通过校验 → partial，避免旧检查冒充最终版本）。
   */
  private async buildCommandChecks(
    runDir: string,
    dispatchId: string,
    observations: ReadonlyArray<{
      observation: DriverCommandObservation;
      workspace_sha256?: string;
      fingerprint_verified: boolean;
    }>,
  ): Promise<ExecutionCheck[]> {
    if (observations.length === 0) return [];
    const directory = path.join(runDir, 'role-autonomy', 'observations', dispatchId);
    await fs.mkdir(directory, { recursive: true });
    const checks: ExecutionCheck[] = [];
    for (let index = 0; index < observations.length; index += 1) {
      const { observation, workspace_sha256, fingerprint_verified } = observations[index]!;
      const prefix = String(index + 1).padStart(3, '0');
      const observedAt =
        observation.observed_at ?? (this.deps.clock?.() ?? new Date()).toISOString();
      const stdoutRef =
        observation.stdout !== undefined
          ? await writeBoundedObservationFile(
              runDir,
              directory,
              `${prefix}.stdout.txt`,
              observation.stdout,
            )
          : undefined;
      const stderrRef =
        observation.stderr !== undefined
          ? await writeBoundedObservationFile(
              runDir,
              directory,
              `${prefix}.stderr.txt`,
              observation.stderr,
            )
          : undefined;
      checks.push(
        hostObservedCheck({
          command: observation.command,
          exit_code: observation.exit_code,
          ...(stdoutRef !== undefined ? { stdout_ref: stdoutRef } : {}),
          ...(stderrRef !== undefined ? { stderr_ref: stderrRef } : {}),
          ...(workspace_sha256 !== undefined ? { workspace_sha256 } : {}),
          ...(observation.target_paths !== undefined
            ? { target_paths: [...observation.target_paths] }
            : {}),
          observed_at: observedAt,
          // 截断或指纹未通过宿主独立校验 → 证据不完整；finish 只接受 complete。
          observation:
            observation.truncated === true || !fingerprint_verified ? 'partial' : 'complete',
        }),
      );
    }
    return checks;
  }

  /**
   * 迟到结果入口：**由派工时绑定的 Run 上下文**处理，先写 durable receipt，再尽力追加 reconciled。
   * 写入/对账任务都登记到 `lateResults`，供测试与关闭前排空使用。
   */
  private handleLateResult(
    context: LateResultContext,
    dispatchId: string,
    execution: DriverRunResult,
  ): void {
    const task = this.writeReceiptAndDrain(context, dispatchId, execution).catch(() => undefined);
    this.lateResults.add(task);
    void task.finally(() => {
      this.lateResults.delete(task);
    });
  }

  /**
   * 迟到结果的生命周期：先写 durable receipt（即使随后对账失败也不丢事实），
   * 再走**同一个**回执排空算法（扫描/筛选/失败标记只有一份实现）。
   */
  private async writeReceiptAndDrain(
    context: LateResultContext,
    dispatchId: string,
    execution: DriverRunResult,
  ): Promise<void> {
    await this.writeLateReceipt(context, dispatchId, execution);
    await this.drainReceiptsFor(context);
  }

  private lateResultDirectory(runDir: string): string {
    return path.join(runDir, 'role-autonomy', 'late-results');
  }

  private async writeLateReceipt(
    context: LateResultContext,
    dispatchId: string,
    execution: DriverRunResult,
  ): Promise<void> {
    const receipt: LateResultReceipt = {
      version: 1,
      dispatch_id: dispatchId,
      execution,
      received_at: (this.deps.clock?.() ?? new Date()).toISOString(),
      status: 'pending',
      attempts: 0,
    };
    const file = path.join(this.lateResultDirectory(context.runDir), `${dispatchId}.json`);
    try {
      await writeJsonFile(file, receipt);
    } catch (error) {
      // 迟到回执写失败不能终止已结束的 Run：保留可诊断事实，由后续 drain/运维观察。
      context.receipt_errors.push(
        `late-result receipt write failed for ${dispatchId}: ${errorMessage(error)}`,
      );
    }
  }

  private async updateLateReceipt(
    file: string,
    patch: { status: LateResultReceipt['status']; attempts?: number; error?: string },
  ): Promise<void> {
    try {
      const current = JSON.parse(await fs.readFile(file, 'utf8')) as LateResultReceipt;
      await fs.writeFile(
        file,
        JSON.stringify({
          ...current,
          ...patch,
          ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
        }),
        'utf8',
      );
    } catch {
      // 回执本身不可写：保留内存 diagnostics（receipt_errors），不阻断对账流程。
    }
  }

  private async workspaceDelta(
    workspace: string | undefined,
    before: WorkspaceFileSnapshot | undefined,
  ): Promise<
    { changed_paths: string[]; coverage: 'complete' | 'partial' | 'unavailable' } | undefined
  > {
    if (!workspace || !before) return undefined;
    try {
      const after = await snapshotWorkspaceFiles(workspace);
      return { changed_paths: diffWorkspaceFiles(before, after), coverage: 'complete' };
    } catch {
      return { changed_paths: [], coverage: 'unavailable' };
    }
  }

  // ── 预算与恢复上下文 ──────────────────────────────────────

  /**
   * 恢复时额度已耗尽：必须在任何外部调用（LLM/记忆/Driver）之前失败，
   * 不能先调用一轮 LLM 才发现。dispatch 预算耗尽不在这里拦：role 仍可收束。
   */
  private assertBudgetUsableBeforeExternalCall(budget: RoleBudgetPort): void {
    // 回合规则只由 `RoleBudget.assertRoundAllowed` 判定（含墙钟检查）；这里不再重复比较
    // role_rounds/max_role_rounds，避免同一规则两处维护后漂移。
    budget.assertRoundAllowed();
    budget.assertTokenBudget();
    const snapshot = budget.snapshot();
    if (
      snapshot.frozen.max_tool_calls !== undefined &&
      snapshot.consumed.tool_calls >= snapshot.frozen.max_tool_calls
    ) {
      throw new RoleTerminationError({
        code: 'budget_tool_calls',
        actor: 'host',
        message: `role tool-call budget exhausted before restart (${snapshot.consumed.tool_calls}/${snapshot.frozen.max_tool_calls})`,
        details: { recovered: true },
      });
    }
  }

  /** 恢复前已结算的派工观察（accepted-only/dispatched-only 没有证据，只进入摘要/未决列表）。 */
  private recoveredDispatchObservations(
    currentRecords: readonly DispatchRecord[],
    ancestors: readonly AncestorJournal[],
  ): RoleDispatchObservation[] {
    const observations: RoleDispatchObservation[] = [];
    for (const record of currentRecords) {
      if (record.evidence === undefined || record.evidence_sha256 === undefined) continue;
      observations.push(recordToObservation(record));
    }
    for (const ancestor of ancestors) {
      for (const record of ancestor.readRecords) {
        if (record.evidence === undefined || record.evidence_sha256 === undefined) continue;
        observations.push(recordToObservation(record));
      }
    }
    return observations;
  }

  // ── 工作区基线与产物 ──────────────────────────────────────

  /**
   * 交付对象基线属于**同一次逻辑执行**：首次进入时持久化，恢复时沿恢复链继承并核验。
   *
   * 不能用恢复时的已修改工作区重新取基线，否则「settled 后中断 → 新 Run 直接完成」会把
   * 恢复前的真实修改全部漏掉。缺失/损坏/写入失败都显式 fail closed，不静默按新基线继续。
   */
  private async loadWorkspaceBaseline(
    runDir: string,
    workspace: string | undefined,
    lineage: readonly string[],
  ): Promise<WorkspaceBaseline | undefined> {
    if (!workspace) return undefined;
    const resolvedWorkspace = path.resolve(workspace);
    const current = await this.readWorkspaceBaseline(runDir, resolvedWorkspace);
    if (current !== undefined) return current;
    // 沿恢复链找最近一份基线：它才是同一次逻辑执行的初始状态。
    for (const ancestorId of lineage.slice(1)) {
      const inherited = await this.readWorkspaceBaseline(
        path.join(this.deps.runs_root, ancestorId),
        resolvedWorkspace,
      );
      if (inherited === undefined) continue;
      await this.persistWorkspaceBaseline(runDir, inherited);
      return inherited;
    }
    if (lineage.length > 1) {
      // 恢复 Run 但整条链都没有基线：无法证明哪些文件是本次交付，不能静默漏交付。
      throw new RoleTerminationError({
        code: 'host_failed',
        actor: 'host',
        message:
          'recovered run has no workspace baseline in its recovery chain; refusing to guess deliverables',
        details: { reason: 'workspace_baseline_unavailable', lineage: [...lineage] },
      });
    }
    const files = await snapshotWorkspaceContent(workspace);
    const baseline: WorkspaceBaseline = {
      workspace_path: resolvedWorkspace,
      files,
    };
    await this.persistWorkspaceBaseline(runDir, baseline);
    return baseline;
  }

  private async readWorkspaceBaseline(
    runDir: string,
    resolvedWorkspace: string,
  ): Promise<WorkspaceBaseline | undefined> {
    const raw = await readJsonFile<unknown>(
      path.join(runDir, 'role-autonomy', 'workspace-before.json'),
      (error) =>
        hostFailure(
          `workspace baseline is unreadable: ${errorMessage(error)}`,
          { reason: 'workspace_baseline_corrupt', run_dir: runDir },
          error,
        ),
    );
    if (raw === undefined) return undefined;
    // 阶段 2 早期的 `[path, "size:mtime"]` 数组格式已退役（R10 盘点：本仓 `.newide` 下没有
    // 任何该格式的 workspace-before.json，功能默认关闭且未发布，无真实数据依赖）。
    // 遇到该格式按「不支持的版本」显式 fail closed，而不是猜一个基线漏交付。
    if (raw === null || typeof raw !== 'object') {
      throw hostFailure('workspace baseline has an unsupported shape', {
        reason: 'workspace_baseline_corrupt',
        run_dir: runDir,
      });
    }
    const record = raw as Record<string, unknown>;
    if (record.version !== 2 || !Array.isArray(record.entries)) {
      throw hostFailure('workspace baseline has an unsupported version', {
        reason: 'workspace_baseline_corrupt',
        run_dir: runDir,
      });
    }
    const recordedWorkspace = record.workspace_path;
    // v2 记录必须带身份（属于哪个工作区）；缺字段同样按损坏处理，不能猜。
    if (typeof recordedWorkspace !== 'string') {
      throw hostFailure('workspace baseline is missing its workspace identity', {
        reason: 'workspace_baseline_corrupt',
        run_dir: runDir,
      });
    }
    if (path.resolve(recordedWorkspace) !== resolvedWorkspace) {
      throw hostFailure('workspace baseline belongs to a different workspace', {
        reason: 'workspace_baseline_workspace_mismatch',
        expected: resolvedWorkspace,
        recorded: recordedWorkspace,
      });
    }
    return {
      workspace_path: resolvedWorkspace,
      files: parseWorkspaceBaselineEntries(record.entries, runDir),
    };
  }

  private async persistWorkspaceBaseline(
    runDir: string,
    baseline: WorkspaceBaseline,
  ): Promise<void> {
    await writeJsonFile(
      path.join(runDir, 'role-autonomy', 'workspace-before.json'),
      {
        version: 2,
        workspace_path: baseline.workspace_path,
        entries: [...baseline.files.entries()],
      },
      {
        failure: (error) =>
          hostFailure(
            `failed to persist the workspace baseline: ${errorMessage(error)}`,
            { reason: 'workspace_baseline_write_failed', run_dir: runDir },
            error,
          ),
      },
    );
  }

  /**
   * finish 时刻的交付事实：内容指纹用文件字节 sha256（不是 size/mtime），与检查证据同一口径；
   * 读取失败时缺省（finish 不会把检查证据当适用）。
   */
  private async workspaceState(workspace: string | undefined): Promise<RoleWorkspaceState> {
    if (!workspace) return {};
    try {
      const current = await snapshotWorkspaceContent(workspace);
      return { sha256: hashWorkspaceContent(current) };
    } catch {
      return {};
    }
  }

  private artifactIndexPath(runDir: string): string {
    return path.join(runDir, 'role-autonomy', 'artifacts.json');
  }

  /**
   * 产物索引：当前 Run 优先；恢复时沿链继承 Driver 产物（工作区产物由基线重算）。
   * 损坏/不可读/写入失败都显式终止，不静默返回空清单导致恢复漏交付。
   */
  private async readArtifactIndex(
    runDir: string,
    lineage: readonly string[],
  ): Promise<ArtifactRef[]> {
    const current = await this.readArtifactIndexFile(runDir);
    if (current !== undefined) return current;
    const inherited: ArtifactRef[] = [];
    for (const ancestorId of lineage.slice(1)) {
      const ancestor = await this.readArtifactIndexFile(path.join(this.deps.runs_root, ancestorId));
      if (ancestor === undefined) continue;
      appendArtifacts(inherited, ancestor);
    }
    if (inherited.length > 0) await this.writeArtifactIndex(runDir, inherited);
    return inherited;
  }

  private async readArtifactIndexFile(runDir: string): Promise<ArtifactRef[] | undefined> {
    const raw = await readJsonFile<unknown>(this.artifactIndexPath(runDir), (error, phase) =>
      hostFailure(
        `artifact index is ${phase === 'read' ? 'unreadable' : 'corrupt'}: ${errorMessage(error)}`,
        { reason: 'artifact_index_corrupt', run_dir: runDir },
        error,
      ),
    );
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
      throw hostFailure('artifact index has an unsupported shape', {
        reason: 'artifact_index_corrupt',
        run_dir: runDir,
      });
    }
    // 逐成员按 ArtifactRef 契约完整校验：任一成员无效 = 索引损坏，fail closed；
    // 静默 filter 会把损坏成员当成不存在，恢复后父 Run 报告从交付里消失。
    const artifacts: ArtifactRef[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      const problem = artifactRefProblem(raw[index]);
      if (problem !== undefined) {
        throw hostFailure(`artifact index member ${index} is invalid: ${problem}`, {
          reason: 'artifact_index_corrupt',
          run_dir: runDir,
          index,
          problem,
        });
      }
      artifacts.push(raw[index] as ArtifactRef);
    }
    return artifacts;
  }

  private async writeArtifactIndex(
    runDir: string,
    artifacts: readonly ArtifactRef[],
  ): Promise<void> {
    await writeJsonFile(this.artifactIndexPath(runDir), artifacts, {
      indent: 2,
      failure: (error) =>
        hostFailure(
          `failed to persist the artifact index: ${errorMessage(error)}`,
          { reason: 'artifact_index_write_failed', run_dir: runDir },
          error,
        ),
    });
  }

  /**
   * 本轮 role 执行产生的最终工作区产物（相对**继承来的逻辑基线**）+ 恢复前已记录的
   * Driver 产物。同一文件多次修改只交付最终内容；工作区文件优先于 Driver 的 diff 片段。
   */
  private async collectFinalArtifacts(
    input: RoleAutonomyEngineRequest,
    workspaceBefore: WorkspaceBaseline | undefined,
    prior: readonly ArtifactRef[],
  ): Promise<ArtifactRef[]> {
    const driverArtifacts = prior.filter(isDriverArtifact);
    let workspaceArtifacts: ArtifactRef[] = [];
    try {
      workspaceArtifacts = await collectWorkspaceArtifactsFromContent(
        {
          task_id: input.task_id,
          ...(input.workspace_path !== undefined ? { workspace_path: input.workspace_path } : {}),
        },
        workspaceBefore?.files,
        input.role_id,
      );
    } catch (error) {
      throw new RoleTerminationError(
        {
          code: 'host_failed',
          actor: 'host',
          message: `failed to collect final workspace artifacts: ${errorMessage(error)}`,
          details: { reason: 'workspace_artifact_collection_failed' },
        },
        error,
      );
    }
    return mergeArtifacts(driverArtifacts, workspaceArtifacts);
  }

  // ── 结果映射与持久化 ──────────────────────────────────────

  private async writeTranscript(
    runDir: string,
    input: RoleAutonomyEngineRequest,
    outcome: RoleLoopOutcome,
    usage: RoleUsage,
    artifacts: readonly ArtifactRef[],
    lateReceiptErrors: readonly string[] = [],
  ): Promise<void> {
    const payload = {
      engine_version: ROLE_AUTONOMY_ENGINE_VERSION,
      run_id: input.run_id,
      task_id: input.task_id,
      role_id: input.role_id,
      status: outcome.status,
      finish: outcome.finish,
      usage,
      zero_dispatch: outcome.zero_dispatch,
      plan: outcome.plan,
      // 产物清单持久化：恢复时据此取回已产生的交付物（不重跑 LLM/Driver）。
      artifacts: artifacts.map((artifact) => ({ ...artifact })),
      // 迟到结果回执未能对账的可诊断事实（不静默丢弃；receipt 文件仍在 run 目录）。
      ...(lateReceiptErrors.length > 0
        ? { late_result_receipt_errors: [...lateReceiptErrors] }
        : {}),
      dispatches: outcome.dispatches.map((dispatch) => ({
        dispatch_id: dispatch.dispatch_id,
        status: dispatch.status,
        evidence_ref: dispatch.evidence_ref,
        evidence_sha256: dispatch.evidence_sha256,
        violations: dispatch.violations,
      })),
    };
    await writeJsonFile(path.join(runDir, 'role-autonomy', 'transcript.json'), payload, {
      indent: 2,
    });
  }

  private async transcriptArtifact(
    runDir: string,
    input: RoleAutonomyEngineRequest,
  ): Promise<ArtifactRef> {
    const target = path.join(runDir, 'role-autonomy', 'transcript.json');
    let sha256: string | undefined;
    try {
      sha256 = sha256Hex(await fs.readFile(target));
    } catch {
      sha256 = undefined;
    }
    return {
      artifact_id: createId('artifact'),
      type: 'transcript',
      uri: pathToFileURL(target).href,
      ...(sha256 !== undefined ? { sha256 } : {}),
      producer_id: input.role_id,
      task_id: input.task_id,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }

  /**
   * 阶段 4：低频生命周期事件的唯一出口。
   *
   * 事件只是投影：出口未注入时静默跳过（单测/嵌入式使用零副作用）；出口抛错也不能把一次
   * 已经发生的派工改写成失败——只留一行 stderr 诊断。
   */
  private emitLifecycle(input: RoleAutonomyEngineRequest, event: RoleLifecycleEvent): void {
    if (input.emit_event === undefined) return;
    try {
      input.emit_event(event);
    } catch (error) {
      process.stderr.write(
        `[role-autonomy] lifecycle event ${event.type} was not projected: ${errorMessage(error)}\n`,
      );
    }
  }

  /**
   * 阶段 4 修复 R4-01：恢复入口把 Journal 已 durable 的当前 Run 派工事实补发成低频投影。
   *
   * 触发条件：入口折叠后当前 Run 已有派工记录（正常首次执行时为空），也就是这是一次恢复。
   * 只补投影——不派工、不碰预算/游标/Task/Run 终态；载荷带 `recovered: true` 标明来源是
   * 恢复补发。投影按 `dispatch_id` 幂等合并，重复恢复不会放大计数；已落账终态不被覆盖。
   * 父链事实不在这里重发（走 inherited），因此补投影不会把继承派工算进当前 Run。
   */
  private emitRecoveredDispatches(
    input: RoleAutonomyEngineRequest,
    records: readonly DispatchRecord[],
  ): void {
    for (const record of records) {
      const dispatchId = record.dispatch_id;
      const kind = record.brief.kind;
      this.emitLifecycle(input, {
        type: ROLE_DISPATCH_EVENT.accepted,
        subject_id: dispatchId,
        payload: {
          dispatch_id: dispatchId,
          kind,
          read_only: record.brief.read_only,
          session_mode: record.brief.session.mode,
          sequence: record.sequence,
          recovered: true,
          ...(record.brief.retry_of !== undefined ? { retry_of: record.brief.retry_of } : {}),
        },
      });
      if (record.dispatched_at !== undefined) {
        this.emitLifecycle(input, {
          type: ROLE_DISPATCH_EVENT.started,
          subject_id: dispatchId,
          payload: {
            dispatch_id: dispatchId,
            kind,
            started_at: record.dispatched_at,
            recovered: true,
          },
        });
      }
      if (record.phase === 'settled') {
        this.emitLifecycle(input, {
          type: ROLE_DISPATCH_EVENT.settled,
          subject_id: dispatchId,
          payload: {
            dispatch_id: dispatchId,
            kind,
            // 原始 settled 状态照实补发（unknown 仍是 unknown）；可信对账由下一条
            // reconciled 事件表达，投影按同一有效状态规则收束（R4-02）。
            status: record.status,
            violations: [...record.violations],
            ...(record.settled_at !== undefined ? { settled_at: record.settled_at } : {}),
            ...(record.evidence_sha256 !== undefined
              ? {
                  evidence_ref: {
                    path: `${DISPATCH_JOURNAL_DIR}/${DISPATCH_EVIDENCE_DIR}/${dispatchId}.json`,
                    sha256: record.evidence_sha256,
                  },
                }
              : {}),
            recovered: true,
          },
        });
      }
      if (record.reconciled !== undefined) {
        this.emitLifecycle(input, {
          type: ROLE_DISPATCH_EVENT.reconciled,
          subject_id: dispatchId,
          payload: {
            dispatch_id: dispatchId,
            status: record.reconciled.status,
            source: 'journal_recovery',
            recovered: true,
          },
        });
      }
    }
  }

  /**
   * 父链派工事实的只读投影：每个祖先 Run 一条（空 Journal 不发）。
   *
   * 不逐条复制父链 dispatch 事件：那会让「父链事实」看起来像本 Run 的执行记录，也会把
   * 计数放大。这里只给**计数 + 未决 id + 违规摘要**，逐条身份走 Journal 分页读取。
   * 状态计数与当前 Run / Journal RPC 共用有效状态规则（原始 unknown + 可信 reconciled）。
   */
  private emitInheritedDispatches(
    input: RoleAutonomyEngineRequest,
    ancestors: readonly AncestorJournal[],
  ): void {
    for (const ancestor of ancestors) {
      const records = ancestor.readRecords;
      if (records.length === 0) continue;
      const byStatus: Record<string, number> = {};
      const violationKinds = new Set<string>();
      let violationCount = 0;
      for (const record of records) {
        const status = effectiveDispatchRecordStatus(record);
        byStatus[status] = (byStatus[status] ?? 0) + 1;
        violationCount += record.violations.length;
        for (const violation of record.violations) violationKinds.add(violation);
      }
      this.emitLifecycle(input, {
        type: ROLE_DISPATCH_EVENT.inherited,
        subject_id: ancestor.run_id,
        payload: {
          source_run_id: ancestor.run_id,
          dispatch_count: records.length,
          by_status: byStatus,
          unresolved_dispatch_ids: resolveUnresolvedDispatchIds(records),
          violations: { count: violationCount, kinds: [...violationKinds].sort() },
        },
      });
    }
  }

  /** 迟到回执对账成功的投影（只对账，不重放；已发终态不被覆盖）。 */
  private emitReconciled(
    context: LateResultContext,
    dispatchId: string,
    status: 'succeeded' | 'failed' | 'unknown' | undefined,
  ): void {
    if (status === undefined) return;
    context.emit({
      type: ROLE_DISPATCH_EVENT.reconciled,
      subject_id: dispatchId,
      payload: { dispatch_id: dispatchId, status, source: 'late_result' },
    });
  }

  private async completedResult(
    input: RoleAutonomyEngineRequest,
    runDir: string,
    journal: RunDispatchJournal,
    policy: RoleFrozenPolicy,
    outcome: RoleLoopOutcome,
    transcript: ArtifactRef,
    usage: RoleUsage,
    artifacts: readonly ArtifactRef[],
    records: readonly DispatchRecord[],
    memoryUsed: readonly BufferMemoryUsedEntry[],
  ): Promise<AgentExecutionResult> {
    // 阶段 3：buffer_v2 打开时，把这次 finish 登记成 v2 学习输入（落盘 + 在线登记 Context
    // Delivery）。只登记、不提取；失败降级为 diagnostics 事实，不把已完成任务报成失败。
    const learningInput = policy.buffer_v2
      ? await this.persistLearningInput(input, runDir, journal, outcome, memoryUsed, records)
      : undefined;
    const withDriverResult = [...outcome.dispatches]
      .reverse()
      .find((dispatch) => dispatch.evidence.driver_run_result_id !== undefined);
    return {
      agent_run_id: createId('agent_run'),
      agent_id: input.role_id,
      role_id: input.role_id,
      context_pack_ref: createId('context_pack'),
      driver_run_result_id:
        withDriverResult?.evidence.driver_run_result_id ??
        withDriverResult?.dispatch_id ??
        'no_driver_invocation',
      artifact_refs: artifacts.map((artifact) => ({ ...artifact })),
      transcript_ref: transcript,
      session_id: input.session_id ?? '',
      response: outcome.response,
      tool_events: [],
      diagnostics: {
        execution_engine: 'role_autonomy',
        role_autonomy: {
          engine_version: ROLE_AUTONOMY_ENGINE_VERSION,
          finish_status: outcome.status,
          usage,
          zero_dispatch: outcome.zero_dispatch,
          unresolved_dispatches: outcome.unresolved_dispatches,
          plan: outcome.plan,
          dispatches: outcome.dispatches.map((dispatch) => ({
            dispatch_id: dispatch.dispatch_id,
            status: dispatch.status,
            violations: dispatch.violations,
          })),
        },
        ...(learningInput !== undefined ? { learning_input: learningInput } : {}),
      },
      status: 'completed',
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// 内部辅助
// ─────────────────────────────────────────────────────────────

/** 迟到回执对账的最大重试次数（只重试写者不可用，其它错误立即交给排空算法）。 */
const LATE_RECONCILE_ATTEMPTS = 8;

type RoleDispatchJournalPortView = Pick<
  RunDispatchJournal,
  'read' | 'fold' | 'appendInit' | 'appendFinish' | 'appendRoleRound' | 'registerEvidenceRef'
> &
  RoleJournalPort;

/** 祖先 Run 的只读 journal 快照（由近到远）。 */
interface AncestorJournal {
  run_id: string;
  journal: RunDispatchJournal;
  read: DispatchJournalReadResult;
  readRecords: readonly DispatchRecord[];
}

/**
 * 同一次逻辑执行的工作区基线：相对路径 → 文件内容 sha256。
 * 阶段 2 早期的 size:mtime metadata 格式已退役（R10 盘点无数据依赖），不再保留双格式分支。
 */
interface WorkspaceBaseline {
  workspace_path: string;
  files: WorkspaceContentSnapshot;
}

/** 迟到结果对账的 run 级上下文（跨 run() 生命周期存活，用于 engine 结束后重新取写者所有权）。 */
interface LateResultContext {
  runDir: string;
  identity: { run_id: string; task_id: string; role_id: string };
  journal: RunDispatchJournal;
  journalClosed: boolean;
  /** 该 Run 是否仍在 run() 内；已结束的上下文只在保留上限内供显式 drain。 */
  active: boolean;
  /** 对账失败/回执写入失败的可诊断事实（进入 transcript diagnostics，不静默）。 */
  receipt_errors: string[];
  /**
   * 阶段 4：该 Run 自己的生命周期事件出口。迟到回执回调发生在 run() 之外，
   * 必须把出口随上下文绑定到**派工所属 Run**，不能读「当前/最近一次 run」猜归属。
   */
  emit: (event: RoleLifecycleEvent) => void;
}

/** durable 迟到回执；`pending` 表示尚未成功追加 reconciled（后续 drain 可补偿）。 */
interface LateResultReceipt {
  version: 1;
  dispatch_id: string;
  execution: DriverRunResult;
  received_at: string;
  status: 'pending' | 'reconciled' | 'unreadable';
  attempts?: number;
  error?: string;
}

function isJournalUnavailable(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = Reflect.get(error, 'code');
  return code === 'journal_not_open' || code === 'journal_locked';
}

/** restoreConsumedBudget 只需要 read 出来的行。 */
type DispatchJournalReadResultView = Pick<DispatchJournalReadResult, 'lines'>;

function recordToObservation(record: DispatchRecord): RoleDispatchObservation {
  if (record.evidence === undefined || record.evidence_sha256 === undefined) {
    // 折叠出 settled 记录时必有 evidence；缺失说明 journal 损坏，恢复到这里的调用方会 fail closed。
    throw new RoleTerminationError({
      code: 'host_failed',
      actor: 'host',
      message: `settled dispatch ${record.dispatch_id} has no evidence in the journal`,
      details: { reason: 'journal_record_without_evidence', dispatch_id: record.dispatch_id },
    });
  }
  const status = record.status;
  if (status === 'not_executed') {
    // accepted-only 记录没有 evidence 侧车；走到这里说明折叠结果自相矛盾。
    throw new RoleTerminationError({
      code: 'journal_corrupt',
      actor: 'host',
      message: `settled dispatch ${record.dispatch_id} has status not_executed`,
      details: { dispatch_id: record.dispatch_id },
    });
  }
  return {
    dispatch_id: record.dispatch_id,
    status,
    evidence: record.evidence,
    evidence_ref: {
      path: `${DISPATCH_JOURNAL_DIR}/${DISPATCH_EVIDENCE_DIR}/${record.dispatch_id}.json`,
      sha256: record.evidence_sha256,
    },
    evidence_sha256: record.evidence_sha256,
    violations: [...record.violations] as JournalViolation[],
    attempts: 1,
    record,
  };
}

type WorkspaceDeltaObservation =
  | { changed_paths: string[]; coverage: 'complete' | 'partial' | 'unavailable' }
  | undefined;

/**
 * Driver 公开报告回传给 Role 的截断长度。默认 2,000 字符；实验/部署可用
 * `NEWIDE_ROLE_RESPONSE_EXCERPT_CHARS` 放大，让 Role 能读到报告里的失败与限制段落
 * （报告后段的限制往往决定下一步决策）。非法值回落到默认值。
 */
const DEFAULT_RESPONSE_EXCERPT_CHARS = 2_000;

function responseExcerptChars(): number {
  const raw = process.env.NEWIDE_ROLE_RESPONSE_EXCERPT_CHARS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RESPONSE_EXCERPT_CHARS;
}

/**
 * 由既有 ADP 证据化映射生成观察：`succeeded/failed/cancelled` 走 `result`，
 * 映射为 `unknown`（已收到结果但结局不明）时只声明独立事实 `result_received=true`，
 * 不把 unknown 塞进不允许 unknown 的 `result.status`，也不从 status 反推收到与否。
 */
function resultObservation(input: {
  mapped: AdpMappedOutcome;
  execution: DriverRunResult;
  delta: WorkspaceDeltaObservation;
  checks: readonly ExecutionCheck[];
}): DriverAttemptObservation {
  const { mapped, execution, delta, checks } = input;
  const common = {
    transport: { evidence: 'execution_unconfirmed' as const },
    checks: [...checks],
    ...(delta !== undefined ? { workspace_delta: delta } : {}),
    ...(execution.response !== undefined
      ? { response_excerpt: execution.response.slice(0, responseExcerptChars()) }
      : {}),
    ...(execution.usage !== undefined ? { usage: execution.usage } : {}),
    duration_ms: execution.diagnostics.duration_ms,
  };
  if (mapped.status === 'unknown') {
    return {
      ...common,
      result_received: true,
      ...(mapped.error !== null ? { error: mapped.error } : {}),
    };
  }
  return {
    ...common,
    result: {
      status: mapped.status,
      driver_id: execution.diagnostics.driver_id,
      driver_run_result_id: execution.driver_run_result_id,
      session_id: execution.session_id,
      ...(execution.response !== undefined ? { response: execution.response } : {}),
      ...(execution.usage !== undefined ? { usage: execution.usage } : {}),
      ...(mapped.error !== null ? { error: mapped.error } : {}),
      duration_ms: execution.diagnostics.duration_ms,
    },
  };
}

function failureObservation(input: {
  mapped: AdpMappedOutcome;
  transportEvidence: DriverExecutionEvidence;
  delta: WorkspaceDeltaObservation;
  checks: readonly ExecutionCheck[];
}): DriverAttemptObservation {
  return {
    transport: { evidence: input.transportEvidence },
    checks: [...input.checks],
    result_received: false,
    ...(input.mapped.error !== null ? { error: input.mapped.error } : {}),
    ...(input.delta !== undefined ? { workspace_delta: input.delta } : {}),
  };
}

/** 超时/取消的在途结果：无法确认结局 → unknown；不重放、不伪造 received。 */
function unknownObservation(
  signal: string,
  errorCode: string,
  delta: WorkspaceDeltaObservation,
): DriverAttemptObservation {
  return {
    transport: { evidence: 'execution_unconfirmed', signal },
    result_received: false,
    error: {
      code: errorCode,
      message: `driver outcome unconfirmed (${signal})`,
      retryable: false,
    },
    ...(delta !== undefined ? { workspace_delta: delta } : {}),
  };
}

/** 单 dispatch 有效超时 = min(模型请求, 冻结上限, 总墙钟剩余)；恢复也不能扩大上限。 */
function resolveDispatchTimeoutMs(
  requestedMs: number | undefined,
  policy: RoleFrozenPolicy,
  remainingWallClockMs: number,
): number {
  const frozen = policy.budget.limits.dispatch_timeout_ms;
  const requested = requestedMs ?? frozen;
  const remaining = Number.isFinite(remainingWallClockMs)
    ? Math.max(1, Math.floor(remainingWallClockMs))
    : frozen;
  return Math.max(1, Math.min(frozen, requested, remaining));
}

/** 祖先记录 → 当前 Journal 的 retry 锚点（只带可验证的受控 ref，不带执行事实）。 */
function foreignRetryAnchors(ancestors: readonly AncestorJournal[]): ForeignRetryAnchor[] {
  const anchors: ForeignRetryAnchor[] = [];
  for (const ancestor of ancestors) {
    for (const record of ancestor.readRecords) {
      const evidenceRefs: EvidenceRef[] = [];
      if (record.evidence_sha256 !== undefined) {
        evidenceRefs.push({
          path: `${DISPATCH_JOURNAL_DIR}/${DISPATCH_EVIDENCE_DIR}/${record.dispatch_id}.json`,
          sha256: record.evidence_sha256,
        });
      }
      if (record.evidence !== undefined) {
        for (const ref of evidenceRefsOf(record.evidence)) evidenceRefs.push(ref);
      }
      anchors.push({
        dispatch_id: record.dispatch_id,
        status: record.status,
        evidence_refs: evidenceRefs,
      });
    }
  }
  return anchors;
}

/**
 * 迟到 Driver 结果的唯一对账写盘点：只追加 `reconciled`，不改写已 settle 的终态、
 * 不调用 driver；冲突/关闭由 journal 抛错，调用方（engine）吞掉后保持终态。
 * 导出用于确定性回归（不依赖真实时钟竞争）。
 */
export async function reconcileLateDriverResult(
  journal: Pick<RunDispatchJournal, 'appendReconciled'>,
  dispatchId: string,
  execution: DriverRunResult,
): Promise<'succeeded' | 'failed' | 'unknown' | undefined> {
  // 复用同一 ADP 证据化映射：迟到结果仍按「明确未执行/确定失败/结局不明」分类，
  // interrupted + 副作用 → unknown，不因为「结果迟到」就升级成成功或降级成确定失败。
  const mapped = mapAdpOutcome({
    kind: 'result',
    evidence: {
      dispatched: true,
      effects_observed: execution.tool_events.length > 0 || execution.artifacts.length > 0,
      result_received: true,
      cancel_requested: false,
    },
    execution,
  });
  const evidence = buildExecutionEvidence({
    dispatch_id: dispatchId,
    evidence_id: `evd_late_${dispatchId}`,
    observation:
      mapped.status === 'unknown'
        ? {
            result_received: true,
            transport: { evidence: 'execution_unconfirmed' },
            ...(mapped.error !== null ? { error: mapped.error } : {}),
          }
        : {
            result_received: true,
            transport: { evidence: 'execution_unconfirmed' },
            result: {
              status: mapped.status,
              driver_id: execution.diagnostics.driver_id,
              driver_run_result_id: execution.driver_run_result_id,
              session_id: execution.session_id,
              ...(execution.response !== undefined ? { response: execution.response } : {}),
              ...(execution.usage !== undefined ? { usage: execution.usage } : {}),
              ...(mapped.error !== null ? { error: mapped.error } : {}),
              duration_ms: execution.diagnostics.duration_ms,
            },
          },
  });
  const status = evidence.status;
  if (status !== 'succeeded' && status !== 'failed' && status !== 'unknown') return undefined;
  await journal.appendReconciled({
    dispatch_id: dispatchId,
    status,
    reason: 'late driver result reconciled after timeout/cancel (no replay)',
    evidence,
    evidence_sha256: hashExecutionEvidence(evidence),
  });
  // 返回对账状态供上层发低频投影事件（只对账、不重放，不改变已发终态）。
  return status;
}

function evidenceRefsOf(evidence: ExecutionEvidence): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  for (const artifact of evidence.artifacts) refs.push(artifact.ref);
  if (evidence.transcript_ref !== undefined) refs.push(evidence.transcript_ref);
  if (evidence.tool_events_ref !== undefined) refs.push(evidence.tool_events_ref);
  if (evidence.transport.stderr_ref !== undefined) refs.push(evidence.transport.stderr_ref);
  for (const check of evidence.checks) {
    if (check.stdout_ref !== undefined) refs.push(check.stdout_ref);
    if (check.stderr_ref !== undefined) refs.push(check.stderr_ref);
  }
  return refs;
}

async function writeBoundedObservationFile(
  runDir: string,
  directory: string,
  name: string,
  content: string,
): Promise<EvidenceRef> {
  const bounded = content.slice(0, DRIVER_COMMAND_OBSERVATION_MAX_OUTPUT_CHARS);
  const bytes = Buffer.from(bounded, 'utf8');
  const target = path.join(directory, name);
  await fs.writeFile(target, bytes);
  return {
    path: path.relative(runDir, target).split(path.sep).join('/'),
    sha256: sha256Hex(bytes),
  };
}

/**
 * 读取 JSON 的机械步骤：ENOENT → `undefined`；其它读取/解析失败交给调用方的稳定错误映射。
 */
async function readJsonFile<T>(
  target: string,
  failure: (error: unknown, phase: 'read' | 'parse') => RoleTerminationError,
): Promise<T | undefined> {
  let text: string;
  try {
    text = await fs.readFile(target, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return undefined;
    throw failure(error, 'read');
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw failure(error, 'parse');
  }
}

/** 原子写 JSON：创建目录 → 同目录临时文件 → rename；失败默认原样抛出，调用方可传 `failure` 包装。 */
async function writeJsonFile(
  target: string,
  payload: unknown,
  options: { indent?: number; failure?: (error: unknown) => RoleTerminationError } = {},
): Promise<void> {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(payload, null, options.indent), 'utf8');
    await fs.rename(temporary, target);
  } catch (error) {
    throw options.failure?.(error) ?? error;
  }
}

function appendArtifacts(target: ArtifactRef[], incoming: readonly ArtifactRef[]): void {
  for (const artifact of incoming) {
    if (target.some((existing) => existing.artifact_id === artifact.artifact_id)) continue;
    const incomingTarget = artifact.content?.target_path;
    if (
      incomingTarget !== undefined &&
      target.some((existing) => existing.content?.target_path === incomingTarget)
    ) {
      continue;
    }
    target.push(artifact);
  }
}

/** 内容基线指纹：文件字节 sha256（与检查证据/交付指纹同一口径）。 */
const CONTENT_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

const ARTIFACT_TYPES = new Set([
  'patch',
  'diff',
  'test_log',
  'review',
  'decision_packet',
  'checkpoint',
  'context',
  'transcript',
  'driver_result',
  'audit',
  'merge_authorization',
]);

const ARTIFACT_CONTENT_KINDS = new Set(['text', 'file', 'patch', 'metadata']);

/**
 * 工作区基线成员校验：`[相对路径, 内容 sha256]` 两元组必须完整、路径安全、指纹合法。
 * 任一成员损坏 → 返回问题描述，调用方 fail closed（不静默丢成员）。
 */
function baselineEntryProblem(entry: unknown): string | undefined {
  if (!Array.isArray(entry) || entry.length !== 2)
    return 'entry is not a [path, fingerprint] tuple';
  const [file, fingerprint] = entry as [unknown, unknown];
  if (typeof file !== 'string' || file.length === 0) return 'entry path is not a non-empty string';
  if (!isSafeWorkspaceRelativePath(file))
    return `entry path is not a safe workspace-relative path: ${file}`;
  if (typeof fingerprint !== 'string' || !CONTENT_FINGERPRINT_PATTERN.test(fingerprint)) {
    return `entry fingerprint is not a content sha256: ${String(fingerprint)}`;
  }
  return undefined;
}

function parseWorkspaceBaselineEntries(
  raw: readonly unknown[],
  runDir: string,
): Map<string, string> {
  const files = new Map<string, string>();
  for (let index = 0; index < raw.length; index += 1) {
    const problem = baselineEntryProblem(raw[index]);
    if (problem !== undefined) {
      throw hostFailure(`workspace baseline member ${index} is invalid: ${problem}`, {
        reason: 'workspace_baseline_corrupt',
        run_dir: runDir,
        index,
        problem,
      });
    }
    const [file, fingerprint] = raw[index] as [string, string];
    if (files.has(file)) {
      throw hostFailure(`workspace baseline has a duplicate path: ${file}`, {
        reason: 'workspace_baseline_corrupt',
        run_dir: runDir,
        index,
      });
    }
    files.set(file, fingerprint);
  }
  return files;
}

/** ArtifactRef 契约校验：身份/类型/URI/生产者/时间/内容引用缺一不可。 */
function artifactRefProblem(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'artifact is not an object';
  }
  const record = value as Record<string, unknown>;
  const required = (key: string): string | undefined => {
    const candidate = record[key];
    return typeof candidate === 'string' && candidate.length > 0
      ? undefined
      : `${key} is not a non-empty string`;
  };
  for (const key of ['artifact_id', 'uri', 'producer_id', 'created_at', 'schema_version']) {
    const problem = required(key);
    if (problem !== undefined) return problem;
  }
  if (typeof record.type !== 'string' || !ARTIFACT_TYPES.has(record.type)) {
    return 'type is not a known artifact type';
  }
  if (Number.isNaN(Date.parse(record.created_at as string))) {
    return 'created_at is not a valid timestamp';
  }
  if (record.sha256 !== undefined) {
    if (typeof record.sha256 !== 'string' || !CONTENT_FINGERPRINT_PATTERN.test(record.sha256)) {
      return 'sha256 is not a content hash';
    }
  }
  if (record.task_id !== undefined && typeof record.task_id !== 'string') {
    return 'task_id is not a string';
  }
  if (
    record.metadata !== undefined &&
    (record.metadata === null ||
      typeof record.metadata !== 'object' ||
      Array.isArray(record.metadata))
  ) {
    return 'metadata is not an object';
  }
  if (record.content !== undefined) {
    const content = record.content;
    if (content === null || typeof content !== 'object' || Array.isArray(content)) {
      return 'content is not an object';
    }
    const fields = content as Record<string, unknown>;
    if (typeof fields.kind !== 'string' || !ARTIFACT_CONTENT_KINDS.has(fields.kind)) {
      return 'content.kind is not a known content kind';
    }
    if (typeof fields.content_ref !== 'string' || fields.content_ref.length === 0) {
      return 'content.content_ref is not a non-empty string';
    }
    if (fields.target_path !== undefined && typeof fields.target_path !== 'string') {
      return 'content.target_path is not a string';
    }
    if (fields.media_type !== undefined && typeof fields.media_type !== 'string') {
      return 'content.media_type is not a string';
    }
  }
  return undefined;
}

/** 工作区相对路径安全校验（与 finish 的检查目标路径口径一致）。 */
function isSafeWorkspaceRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  if (normalized.length === 0 || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    return false;
  }
  return normalized.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

/** 恢复产物里的 Driver 产物：工作区文件由基线重算，不保留旧的 workspace-change 快照。 */
function isDriverArtifact(artifact: ArtifactRef): boolean {
  const metadata = artifact.metadata;
  if (metadata === null || typeof metadata !== 'object') return true;
  return Reflect.get(metadata, 'source') !== 'workspace-change';
}

/** 恢复摘要：有大小上限的既有派工事实；只读、不重放，证据引用可直接 read_evidence。 */
function renderRecoverySummary(input: {
  current_run_id: string;
  current: readonly DispatchRecord[];
  ancestors: ReadonlyArray<{ run_id: string; records: readonly DispatchRecord[] }>;
}): string {
  const MAX_CHARS = 12_000;
  const lines: string[] = ['Recovered work (read-only facts; do not replay automatically):'];
  const append = (label: string, records: readonly DispatchRecord[]): void => {
    if (records.length === 0) {
      lines.push(`- ${label}: no prior dispatch`);
      return;
    }
    lines.push(`- ${label}: ${records.length} prior dispatch(es)`);
    for (const record of records) {
      const evidenceRef =
        record.evidence_sha256 !== undefined
          ? JSON.stringify({
              path: `journal/evidence/${record.dispatch_id}.json`,
              sha256: record.evidence_sha256,
            })
          : 'none';
      lines.push(
        `  - ${record.dispatch_id} [${record.phase}/${record.status}] kind=${record.brief.kind} ` +
          `instruction="${record.brief.instruction.slice(0, 300)}" evidence_ref=${evidenceRef}` +
          (record.violations.length > 0 ? ` violations=${record.violations.join(',')}` : ''),
      );
    }
  };
  append(`current run ${input.current_run_id}`, input.current);
  for (const ancestor of input.ancestors) {
    append(`ancestor run ${ancestor.run_id} (read-only)`, ancestor.records);
  }
  const unresolved = resolveUnresolvedDispatchIds([
    ...input.current,
    ...input.ancestors.flatMap((ancestor) => ancestor.records),
  ]);
  lines.push(
    unresolved.length > 0
      ? `Unresolved unknown dispatches (completed requires trusted reconciliation/retry): ${unresolved.join(', ')}`
      : 'No unresolved unknown dispatch.',
  );
  const text = lines.join('\n');
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…[truncated]` : text;
}

function readToolCallUsage(result: {
  usage?: unknown;
}): { input_tokens: number; output_tokens: number } | undefined {
  const usage = result.usage;
  if (usage === undefined || usage === null || typeof usage !== 'object') return undefined;
  const input = Reflect.get(usage, 'input_tokens');
  const output = Reflect.get(usage, 'output_tokens');
  if (
    typeof input !== 'number' ||
    !Number.isFinite(input) ||
    typeof output !== 'number' ||
    !Number.isFinite(output)
  ) {
    return undefined;
  }
  return { input_tokens: input, output_tokens: output };
}

function renderBriefInstruction(brief: ExecutionBrief): string {
  const lines = [brief.instruction];
  if (brief.acceptance.length > 0) {
    lines.push('', 'Acceptance criteria:', ...brief.acceptance.map((item) => `- ${item}`));
  }
  if (brief.constraints.length > 0) {
    lines.push('', 'Constraints:', ...brief.constraints.map((item) => `- ${item}`));
  }
  return lines.join('\n');
}

function renderPersona(persona: PersonaDef): string {
  const lines = [`Persona v${persona.version}: ${persona.summary}`.trim()];
  if (persona.skills_overview.trim()) lines.push(`Skills overview: ${persona.skills_overview}`);
  if (persona.experience_coverage.trim()) {
    lines.push(`Experience coverage: ${persona.experience_coverage}`);
  }
  if (persona.recent_performance.trim()) {
    lines.push(`Recent performance: ${persona.recent_performance}`);
  }
  if (persona.notes.trim()) lines.push(`Notes: ${persona.notes}`);
  return lines.join('\n');
}

function renderRecall(
  skills: readonly { name?: string; content: string }[],
  experiences: readonly { summary?: string; content: string }[],
): string {
  const lines: string[] = [];
  if (skills.length > 0) {
    lines.push('Skills:');
    lines.push(...skills.map((skill) => `- ${skill.name ?? 'skill'}: ${skill.content}`));
  }
  if (experiences.length > 0) {
    lines.push('Experiences:');
    lines.push(...experiences.map((experience) => `- ${experience.summary ?? experience.content}`));
  }
  return lines.join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** host 侧基础事实失败的 typed termination（JSON 读写等多个调用点共用，原因/details 由调用方给）。 */
function hostFailure(
  message: string,
  details: Record<string, unknown>,
  cause?: unknown,
): RoleTerminationError {
  return new RoleTerminationError({ code: 'host_failed', actor: 'host', message, details }, cause);
}

/** Journal 损坏/不可读：fail closed 的 typed termination（原因码可区分）。 */
function journalFailure(
  code: 'journal_corrupt' | 'journal_unreadable',
  message: string,
  cause?: unknown,
): RoleTerminationError {
  return new RoleTerminationError(
    {
      code,
      actor: 'host',
      message,
      details: { cause: errorMessage(cause) },
    },
    cause,
  );
}

function isErrnoCode(error: unknown, code: string): boolean {
  if (error === null || typeof error !== 'object') return false;
  return Reflect.get(error, 'code') === code;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('role autonomy execution aborted');
  error.name = 'AbortError';
  return error;
}
