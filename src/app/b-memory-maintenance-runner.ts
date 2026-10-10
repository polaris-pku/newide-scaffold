import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCHEMA_VERSION, nowTimestamp } from '../core';
import {
  applyUsageFeedback,
  buildContextDeliveryItem,
  buildDriverUsageFeedbackRecords,
  createAgentMemoryScope,
  contextDeliveryId,
  contextDeliveryKey,
  LlmExperienceExtractor,
  LlmSkillPromotion,
  processPendingBuffer,
  promoteExperiencesForAgent,
  resolveMemoryAblationPolicy,
  type BufferRepository,
  type CallJournalPort,
  type DriverReferencedExperience,
  type ExperienceExtractor,
  type LlmClient,
  type MemoryAblation,
  type MemoryDeliveryRepository,
  type MemoryRepository,
} from '../memory';
import type {
  ContextDeliveryItem,
  DriverFeedbackRecord,
  SkillRecord,
} from '../memory/schemas';
import type { UsageFeedbackEntry } from '../memory';
import {
  isDriverStreamUsage,
  preferDriverUsage,
  projectTaskDriverUsage,
} from './driver-usage-projector';
import { runWithLlmUsageLedger } from '../telemetry';

export interface BMemoryMaintenanceRequest {
  task_id: string;
  run_id: string;
  role_id: string;
  buffer_seq: number;
  /** RFC §1.2 ablation; B2/B3 enable inline skill promotion with auto-approve. */
  memory_ablation?: MemoryAblation;
  /** 工作区绝对路径（Session 绑定键之一）；extract 留档（B1）解析真实 Session 用 */
  workspace_path?: string;
}

/**
 * Driver 使用反馈的提交请求（任务完成时由执行 facade 调用）。
 *
 * `references` 直接来自 DriverReturn.referenced_experiences：反馈只记录「Agent
 * 说它用了什么」，不检查那条经验是否存在——引用不存在的经验是正常情况，
 * 交给下游按 experience_id 归并。
 */
export interface BDriverFeedbackRequest {
  task_id: string;
  run_id: string;
  role_id: string;
  buffer_seq?: number;
  references: readonly DriverReferencedExperience[];
}

/**
 * 任务完成后的记忆加工归属。
 *
 * - `delivery`（生产默认）：本进程只提交上下文交付项与反馈 outbox，
 *   Experience 提取 / Skill 晋升 / Persona 演化由外部 Memory Maintenance 系统负责。
 * - `in_process_emulation`（实验专用）：放行 processBuffer —— 由调用方显式调用它，在
 *   本进程内模拟下游系统的提取与（B2/B3 的）晋升。只有消融臂需要它——没有真的记忆
 *   演化，各臂之间就没有可比较的记忆差。
 *
 * **它不改变 scheduleBuffer 的行为**：那条在线任务路径在两个模式下都只登记交付项。
 * 归属**只在构造 runner 时决定**（见 BMemoryMaintenanceRunnerOptions.mode），不看请求字段：
 * 请求里的 `memory_ablation` 是实验运行的标签，普通任务流程也能填，若拿它去切换路径，
 * 「任务流程只生产输入」这条边界就被一个请求字段捅穿了。
 */
export type BMemoryMaintenanceMode = 'delivery' | 'in_process_emulation';

export interface BSkillPromotionRequest {
  role_id: string;
  requested_by: string;
}

export type BMemoryMaintenanceStatus =
  | 'scheduled'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'failed';

export interface BMemoryMaintenanceEvidence {
  maintenance_ref: string;
  kind: 'experience_extraction' | 'skill_promotion' | 'context_delivery';
  status: BMemoryMaintenanceStatus;
  role_id: string;
  task_id?: string;
  run_id?: string;
  buffer_seq?: number;
  requested_by?: string;
  experiences: unknown[];
  skills: unknown[];
  warnings: string[];
  error?: string;
  /**
   * 上下文交付证据（kind='context_delivery' 时）：交付项 id 与它引用的 Buffer 位置。
   *
   * 下游据此从 `memory.getContextDelivery` 或交付存储里取回完整
   * DriverReturn + AgentContextSnapshot；这里只留引用，不留 payload 副本。
   */
  context_delivery?: {
    delivery_id: string;
    delivery_key: string;
    memory_buffer_ref: string;
    context_snapshot_ref?: string;
  };
  /** 用后验证回写明细：逐条列出置信度增长 before/after（写入磁盘 evidence JSON） */
  usage_feedback?: UsageFeedbackEntry[];
  evidence_uri?: string;
  created_at: string;
  completed_at: string;
  schema_version: string;
}

export interface BMemoryMaintenancePort {
  /**
   * 在线任务路径的入口：为这条 Buffer 登记一条**上下文交付项**，交给外部 Memory
   * Maintenance 系统。
   *
   * 结果是 context_delivery；本方法在任何 mode 下都不提取、不晋升。加工由维护/实验方
   * 显式调用 processBuffer 触发（见 BMemoryMaintenanceRunner）。失败证据也因此永远属于
   * 交付路径——调用方不必（也无法）从实现里反推「这条失败是哪条路径的」。
   */
  scheduleBuffer(input: BMemoryMaintenanceRequest): Promise<BMemoryMaintenanceEvidence>;
  /**
   * 记录 Driver 对既有经验的使用反馈，进 durable outbox 等下游归并。
   *
   * 与提取解耦：反馈不要求经验已经提取出来，也不在本进程改置信度。
   */
  recordDriverUsageFeedback(input: BDriverFeedbackRequest): Promise<DriverFeedbackRecord[]>;
}

export interface BMemoryMaintenanceEvidenceStore {
  save(evidence: BMemoryMaintenanceEvidence): Promise<{ uri: string }>;
  get(maintenanceRef: string): Promise<BMemoryMaintenanceEvidence | undefined>;
  list(roleId?: string): Promise<BMemoryMaintenanceEvidence[]>;
}

export interface BMemoryMaintenanceRunnerOptions {
  repository: MemoryRepository;
  bufferRepository: BufferRepository;
  llm: LlmClient;
  evidenceStore: BMemoryMaintenanceEvidenceStore;
  /**
   * 上下文交付与反馈 outbox 的存储。
   *
   * 不注入时 delivery 模式仍能跑，但 scheduleBuffer 会返回一条明确说明
   * 「本进程没有交付存储」的 failed evidence——不装配交付存储是配置错误，
   * 不该伪装成静默跳过。in_process_emulation 模式不需要它。
   */
  deliveryRepository?: MemoryDeliveryRepository;
  /**
   * 加工归属。缺省 `delivery`（生产：只交付，不加工）。
   *
   * `in_process_emulation` 是**实验专用入口**，只能从这里打开——请求字段打不开它。它放行
   * 显式的 processBuffer 调用；scheduleBuffer 在两种模式下都只登记交付项。消融臂的脚手架
   * 在构造 runner 时显式传它、并显式调用 processBuffer，生产组合根（backend-rpc-stdio）不传。
   */
  mode?: BMemoryMaintenanceMode;
  /** When set, completed maintenance rewrites summary.json token_usage for the run. */
  runsRoot?: string;
  /** 可选提取器注入（默认 LlmExperienceExtractor + 规则版降级）；测试注入失败提取器用。 */
  extractor?: ExperienceExtractor;
  /** 进程内调用留档（B1）：注入后 extract 收尾写 P1 journal；缺省不留档 */
  callJournal?: CallJournalPort;
  /**
   * 技能晋升配置（全自动化测评用）：
   * - confidenceThreshold：晋升置信度门槛（默认 0.95；无人评分时经验置信度难达标，
   *   测评侧可调低让晋升真正发生）
   * - autoApprove：晋升产出的 pending Skill 直接置 approved（进入检索资格），
   *   替代人工审核；对齐 B 服务 NEWIDE_B_SKILL_AUTO_APPROVE 语义
   */
  promotion?: {
    confidenceThreshold?: number;
    autoApprove?: boolean;
  };
}

export class BMemoryMaintenanceRunner implements BMemoryMaintenancePort {
  /** 本运行时实际走的加工归属。构造时定死，请求字段改不动它。 */
  readonly mode: BMemoryMaintenanceMode;
  private readonly promotionConfidenceThreshold: number;
  private readonly promotionAutoApprove: boolean;
  private readonly roleQueues = new Map<string, Promise<void>>();
  private readonly scheduleFlights = new Map<string, Promise<BMemoryMaintenanceEvidence>>();
  /**
   * 提取器与晋升器按需构造：生产 delivery 模式从不碰它们，也就没必要为一个
   * 不会被调用的下游模拟器持有 LLM 适配器。
   */
  private lazyExtractor: ExperienceExtractor | undefined;
  private lazyPromoter: LlmSkillPromotion | undefined;

  constructor(private readonly options: BMemoryMaintenanceRunnerOptions) {
    this.mode = options.mode ?? 'delivery';
    this.promotionConfidenceThreshold = options.promotion?.confidenceThreshold ?? 0.95;
    this.promotionAutoApprove = options.promotion?.autoApprove === true;
  }

  private get extractor(): ExperienceExtractor {
    this.lazyExtractor ??= this.options.extractor ?? new LlmExperienceExtractor(this.options.llm);
    return this.lazyExtractor;
  }

  private get promoter(): LlmSkillPromotion {
    this.lazyPromoter ??= new LlmSkillPromotion(this.options.llm, {
      confidenceThreshold: this.promotionConfidenceThreshold,
    });
    return this.lazyPromoter;
  }

  scheduleBuffer(input: BMemoryMaintenanceRequest): Promise<BMemoryMaintenanceEvidence> {
    const maintenanceRef = extractionRef(input);
    const inFlight = this.scheduleFlights.get(maintenanceRef);
    if (inFlight) return inFlight;

    const scheduling = this.scheduleBufferOnce(input, maintenanceRef);
    this.scheduleFlights.set(maintenanceRef, scheduling);
    const clearSchedule = () => {
      if (this.scheduleFlights.get(maintenanceRef) === scheduling) {
        this.scheduleFlights.delete(maintenanceRef);
      }
    };
    void scheduling.then(clearSchedule, clearSchedule);
    return scheduling;
  }

  /**
   * 在线任务路径的唯一动作：把这条 Buffer 登记成一条上下文交付项。
   *
   * **无论 mode 是什么，这里都不提取、不晋升。** 进程内模拟曾经挂在这一步上，那正是要拆掉的
   * 形状：一个「登记交付」的调用顺手在调用方眼皮底下跑了提取与晋升，任务流程与记忆演化的
   * 边界就只剩一句注释。实验/维护方要跑加工，显式调 processBuffer（那是另一个入口，由
   * 构造 runner 时的 mode 决定是否放行）。
   */
  private async scheduleBufferOnce(
    input: BMemoryMaintenanceRequest,
    maintenanceRef: string,
  ): Promise<BMemoryMaintenanceEvidence> {
    const evidence = await this.submitContextDelivery(input, maintenanceRef);
    return this.withWarning(evidence, emulationUnavailableNotice(input, this.mode));
  }

  /** 把一条补充警告挂到已经落盘的证据上（同一 maintenance_ref，不新建证据）。 */
  private async withWarning(
    evidence: BMemoryMaintenanceEvidence,
    warning: string | undefined,
  ): Promise<BMemoryMaintenanceEvidence> {
    if (!warning) return evidence;
    return this.persist({ ...evidence, warnings: [...evidence.warnings, warning] });
  }

  /**
   * 生产路径：把这次 Buffer 上下文登记成一条交付项，交给外部 Memory Maintenance 系统。
   *
   * 不做任何加工、不调用 LLM。已经交付过的键直接返回既有交付项（幂等命中），
   * 因此重放不会产生第二条交付，也不会把下游已推进的状态拽回 pending。
   */
  private async submitContextDelivery(
    input: BMemoryMaintenanceRequest,
    maintenanceRef: string,
  ): Promise<BMemoryMaintenanceEvidence> {
    const startedAt = nowTimestamp();
    const outbox = this.options.deliveryRepository;
    if (!outbox) {
      return this.persist({
        maintenance_ref: maintenanceRef,
        kind: 'context_delivery',
        status: 'failed',
        ...input,
        experiences: [],
        skills: [],
        warnings: [
          'No MemoryDeliveryRepository is configured, so this context could not be handed to the downstream system.',
        ],
        error: 'Memory delivery repository is not configured.',
        created_at: startedAt,
        completed_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      });
    }

    const deliveryKey = contextDeliveryKey({
      role_id: input.role_id,
      buffer_seq: input.buffer_seq,
    });
    const deliveryId = contextDeliveryId(deliveryKey);
    const existing = await outbox.getContextDelivery(input.role_id, deliveryId);
    if (existing) {
      return this.persist(this.deliveryEvidence(input, maintenanceRef, existing, startedAt, false));
    }

    if (!Number.isInteger(input.buffer_seq) || input.buffer_seq <= 0) {
      return this.persist({
        maintenance_ref: maintenanceRef,
        kind: 'context_delivery',
        status: 'skipped',
        ...input,
        experiences: [],
        skills: [],
        warnings: ['Agent execution did not produce a durable pending Buffer.'],
        created_at: startedAt,
        completed_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      });
    }

    const memory = createAgentMemoryScope(
      this.options.repository,
      this.options.bufferRepository,
      input.role_id,
    );
    const pending = await memory.getPendingBuffer(input.buffer_seq);
    if (!pending) {
      return this.persist({
        maintenance_ref: maintenanceRef,
        kind: 'context_delivery',
        status: 'skipped',
        ...input,
        experiences: [],
        skills: [],
        warnings: ['Pending Buffer is no longer available for delivery.'],
        created_at: startedAt,
        completed_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      });
    }

    // 声明过 context_snapshot_ref 却读不出上下文：这是一条坏掉的输入，不是「本次没有上下文」。
    // 首次交付也必须拦下它——否则半份 payload（只有 DriverReturn）会被写进 outbox，下游拿到
    // 手还以为输入是完整的。返回 failed evidence 并带上原因，不登记交付项。
    // replayPending 对同一形态的处理与此一致（见那里的逐条隔离），首次与重放因此行为统一。
    if (pending.agentContextStatus === 'unreadable') {
      const reason =
        pending.agentContextError ??
        `Agent context for Buffer ${input.role_id}:${String(input.buffer_seq)} could not be read.`;
      return this.persist({
        maintenance_ref: maintenanceRef,
        kind: 'context_delivery',
        status: 'failed',
        ...input,
        experiences: [],
        skills: [],
        warnings: [reason],
        error: reason,
        created_at: startedAt,
        completed_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      });
    }

    const item = buildContextDeliveryItem({
      role_id: input.role_id,
      task_id: input.task_id,
      buffer_seq: input.buffer_seq,
      source_driver: pending.snapshot.source_driver,
      context_snapshot_ref: pending.snapshot.context_snapshot_ref,
    });
    const submitted = await outbox.submitContextDelivery(item);
    return this.persist(
      this.deliveryEvidence(input, maintenanceRef, submitted.item, startedAt, submitted.created),
    );
  }

  /** 交付证据：引用交付项与它的 Buffer 位置，不复制 payload。 */
  private deliveryEvidence(
    input: BMemoryMaintenanceRequest,
    maintenanceRef: string,
    item: ContextDeliveryItem,
    startedAt: string,
    created: boolean,
  ): BMemoryMaintenanceEvidence {
    return {
      maintenance_ref: maintenanceRef,
      kind: 'context_delivery',
      status: 'scheduled',
      task_id: input.task_id,
      run_id: input.run_id,
      role_id: input.role_id,
      buffer_seq: input.buffer_seq,
      experiences: [],
      skills: [],
      warnings: created
        ? []
        : ['Context was already delivered under the same key; the existing delivery was kept.'],
      context_delivery: {
        delivery_id: item.delivery_id,
        delivery_key: item.delivery_key,
        memory_buffer_ref: item.memory_buffer_ref,
        ...(item.context_snapshot_ref !== undefined
          ? { context_snapshot_ref: item.context_snapshot_ref }
          : {}),
      },
      created_at: startedAt,
      completed_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }

  /**
   * 记录 Driver 的使用反馈到 durable outbox（生产与实验都走这里）。
   *
   * 与提取解耦：不要求经验已存在，也不在本进程改置信度；下游系统上线后按
   * `feedback_id` 归并。重复提交同一份 DriverReturn 命中幂等键，只留一条。
   *
   * 没有交付存储时**必须报错**，不能返回空数组：调用方拿到 `[]` 与拿到
   * 「写了 0 条反馈」是同一件事，于是「这台机器根本没配 outbox、Driver 的使用
   * 事实全丢了」会被伪装成「这次没有可记的反馈」。任务不会因此失败——执行 facade
   * 把它降级成 diagnostics 里的一条 error（见 driverFeedbackDiagnostics）。
   */
  async recordDriverUsageFeedback(
    input: BDriverFeedbackRequest,
  ): Promise<DriverFeedbackRecord[]> {
    const outbox = this.options.deliveryRepository;
    if (!outbox) {
      if (input.references.length === 0) return [];
      throw new Error(
        'Driver feedback outbox is not available: this runtime has no MemoryDeliveryRepository configured.',
      );
    }
    const records = buildDriverUsageFeedbackRecords({
      role_id: input.role_id,
      task_id: input.task_id,
      ...(input.buffer_seq !== undefined ? { buffer_seq: input.buffer_seq } : {}),
      references: input.references,
    });
    const stored: DriverFeedbackRecord[] = [];
    for (const record of records) {
      const submitted = await outbox.submitDriverFeedback(record);
      stored.push(submitted.item);
    }
    return stored;
  }

  /**
   * 在本进程内跑一次提取 +（B2/B3 的）晋升 —— **实验/维护专用入口，由外部显式调用**。
   *
   * 它模拟的是外部 Memory Maintenance 系统本来会做的事。生产运行不经过这里：生产只提交
   * 交付项（见 submitContextDelivery），scheduleBuffer 也不会顺手调它。实验脚手架在构造
   * runner 时把 `mode: 'in_process_emulation'` 打开，然后对每条 pending Buffer 显式调用
   * 本方法；没打开的运行时直接返回一条 failed evidence，说明本进程不做加工。
   *
   * 与 scheduleBuffer 的分工是这条边界的关键：一个**登记输入**，一个**消费输入**。
   */
  processBuffer(input: BMemoryMaintenanceRequest): Promise<BMemoryMaintenanceEvidence> {
    return this.enqueueRole(input.role_id, () => this.runInProcessMaintenance(input));
  }

  private async runInProcessMaintenance(
    input: BMemoryMaintenanceRequest,
  ): Promise<BMemoryMaintenanceEvidence> {
    const maintenanceRef = extractionRef(input);
    if (this.mode !== 'in_process_emulation') {
      const at = nowTimestamp();
      return this.persist({
        maintenance_ref: maintenanceRef,
        kind: 'experience_extraction',
        status: 'failed',
        ...input,
        experiences: [],
        skills: [],
        warnings: [
          'In-process memory emulation is not enabled in this runtime; Experience extraction did not run.',
        ],
        error:
          'BMemoryMaintenanceRunner was not constructed for in-process emulation (mode !== in_process_emulation).',
        created_at: at,
        completed_at: at,
        schema_version: SCHEMA_VERSION,
      });
    }
    const existing = await this.options.evidenceStore.get(maintenanceRef);
    if (existing?.status === 'completed') return existing;

    const startedAt = nowTimestamp();
    if (!Number.isInteger(input.buffer_seq) || input.buffer_seq <= 0) {
      return this.persist({
        maintenance_ref: maintenanceRef,
        kind: 'experience_extraction',
        status: 'skipped',
        ...input,
        experiences: [],
        skills: [],
        warnings: ['Agent execution did not produce a durable pending Buffer.'],
        created_at: startedAt,
        completed_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      });
    }

    const memory = createAgentMemoryScope(
      this.options.repository,
      this.options.bufferRepository,
      input.role_id,
    );
    const pending = await memory.getPendingBuffer(input.buffer_seq);
    if (!pending) {
      return this.persist({
        maintenance_ref: maintenanceRef,
        kind: 'experience_extraction',
        status: 'skipped',
        ...input,
        experiences: [],
        skills: [],
        warnings: ['Pending Buffer is no longer available for extraction.'],
        created_at: startedAt,
        completed_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      });
    }

    // in-process emulation 路径同样不许消费损坏上下文：声明过引用却读不出来时拒绝提取，
    // 如实报 failed evidence，而不是把半份输入（只有 DriverReturn）当完整输入喂给提取器。
    // 这里刻意不置死信——坏的是数据不是提取过程，让它留在 pending 上每次都被看见，
    // 由人去修（与 replayPending 对坏记录的处理一致）。
    if (pending.agentContextStatus === 'unreadable') {
      const reason =
        pending.agentContextError ??
        `Agent context for Buffer ${input.role_id}:${String(input.buffer_seq)} could not be read.`;
      return this.persist({
        maintenance_ref: maintenanceRef,
        kind: 'experience_extraction',
        status: 'failed',
        ...input,
        experiences: [],
        skills: [],
        warnings: [reason],
        error: reason,
        created_at: startedAt,
        completed_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      });
    }

    // 用后验证回写（方向 2）：把本次任务对已存经验的引用效果
    // （DriverReturn.referenced_experiences[].effectiveness）回写为置信度与
    // 引用计数——全自动测评中这是置信度增长的唯一真实信号（无人评分时提取
    // 自评不可靠），使真正被反复使用且有效的经验能滚雪球达到 0.95 晋升门槛。
    // best-effort：失败只记入 warnings，不阻断提取/晋升主流程。
    const usageWarnings: string[] = [];
    let usageFeedbackDetails: UsageFeedbackEntry[] = [];
    try {
      const usage = await applyUsageFeedback(
        this.options.repository,
        input.role_id,
        pending.snapshot.driver_return.referenced_experiences,
      );
      usageFeedbackDetails = usage.details;
      if (usage.updated_experiences > 0) {
        usageWarnings.push(
          `Usage feedback applied to ${usage.updated_experiences} referenced experience(s)` +
            ` (${usage.skipped_missing} missing skipped).`,
        );
      }
    } catch (error) {
      usageWarnings.push(
        `Usage feedback write-back skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const evidence = await runWithLlmUsageLedger(
        {
          case_id: input.task_id,
          run_id: input.run_id,
          task_id: input.task_id,
          scaffold_variant: 'full_system',
        },
        async () => {
          const ablationPolicy = resolveMemoryAblationPolicy(input.memory_ablation);
          const result = await processPendingBuffer(memory, input.buffer_seq, {
            task: {
              task_id: input.task_id,
              // extract 留档（B1）的 journal 外键与 Session 绑定键
              run_id: input.run_id,
              ...(input.workspace_path ? { workspace_path: input.workspace_path } : {}),
              call_id: `maintenance:${input.run_id}:${String(input.buffer_seq)}`,
              source_driver: pending.snapshot.source_driver,
              spec: pending.snapshot.task_description,
            },
            extractor: this.extractor,
            ...(this.options.callJournal ? { callJournal: this.options.callJournal } : {}),
            promote: async () => ({
              check: {
                eligible: false,
                auto_approved: false,
                reasons: ['Skill promotion is exposed as a separate application operation.'],
                blocking_rules: [],
              },
            }),
          });

          let skills: SkillRecord[] = [];
          const warnings: string[] = [...usageWarnings, ...(result.extraction.warnings ?? [])];
          if (ablationPolicy.promote_skills) {
            const outcomes = await promoteExperiencesForAgent(
              input.role_id,
              (role_id) =>
                createAgentMemoryScope(
                  this.options.repository,
                  this.options.bufferRepository,
                  role_id,
                ),
              this.promoter,
              { confidenceThreshold: this.promotionConfidenceThreshold },
            );
            skills = [];
            for (const outcome of outcomes) {
              if (!outcome.skill) continue;
              const approved: SkillRecord = {
                ...outcome.skill,
                review_status: 'approved',
              };
              await memory.updateSkill(approved);
              skills.push(approved);
            }
            if (skills.length === 0) {
              warnings.push('Ablation B2/B3 promote ran but no eligible Experience was promoted.');
            } else {
              warnings.push(
                'Ablation B2/B3 auto-approved promoted Skills so they are retrievable in subsequent tasks.',
              );
            }
          }

          return this.persist({
            maintenance_ref: maintenanceRef,
            kind: 'experience_extraction',
            status: 'completed',
            task_id: input.task_id,
            run_id: input.run_id,
            role_id: input.role_id,
            buffer_seq: input.buffer_seq,
            experiences: result.extraction.experiences,
            skills,
            warnings,
            ...(usageFeedbackDetails.length > 0 ? { usage_feedback: usageFeedbackDetails } : {}),
            created_at: startedAt,
            completed_at: nowTimestamp(),
            schema_version: SCHEMA_VERSION,
          });
        },
      );
      await this.refreshRunTokenUsage(input.run_id);
      return evidence;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // 自动死信闭环：提取失败 → buffer 从 pending 移入死信并记录原因，
      // 可经 memory.getBufferState 查看、memory.retryExtraction 恢复重试。
      // 置死信失败（如 buffer 已被处理/删除）不阻塞返回 failed evidence。
      await this.tryMarkDeadLetter(input.role_id, input.buffer_seq, errorMessage);
      return this.persist({
        maintenance_ref: maintenanceRef,
        kind: 'experience_extraction',
        status: 'failed',
        task_id: input.task_id,
        run_id: input.run_id,
        role_id: input.role_id,
        buffer_seq: input.buffer_seq,
        experiences: [],
        skills: [],
        warnings: [],
        error: errorMessage,
        created_at: startedAt,
        completed_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      });
    }
  }

  /** 提取失败自动置死信（best-effort：失败不阻塞返回 failed evidence）。 */
  private async tryMarkDeadLetter(roleId: string, seq: number, reason: string): Promise<void> {
    try {
      await this.options.bufferRepository.markBufferDeadLetter(roleId, seq, reason);
    } catch {
      // buffer 可能已被处理或删除（如并发清理），置死信失败可忽略
    }
  }

  promoteSkills(input: BSkillPromotionRequest): Promise<BMemoryMaintenanceEvidence> {
    return this.enqueueRole(input.role_id, () => this.promoteSkillsNow(input));
  }

  private async promoteSkillsNow(
    input: BSkillPromotionRequest,
  ): Promise<BMemoryMaintenanceEvidence> {
    const startedAt = nowTimestamp();
    const maintenanceRef = `b_maintenance_${randomUUID()}`;
    try {
      const outcomes = await promoteExperiencesForAgent(
        input.role_id,
        (role_id) =>
          createAgentMemoryScope(
            this.options.repository,
            this.options.bufferRepository,
            role_id,
          ),
        this.promoter,
        { confidenceThreshold: this.promotionConfidenceThreshold },
      );
      let skills = outcomes.flatMap((outcome) => (outcome.skill ? [outcome.skill] : []));
      const warnings: string[] = [];
      if (this.promotionAutoApprove && skills.length > 0) {
        // 全自动化测评：晋升即批准，进入检索资格（替代人工审核）。
        // 与 B 服务 autoApprovePromotedSkills 语义一致（reviewed_by=system:auto-approval），
        // 此处内聚在 runner，使 memory.promoteSkills RPC 路径无需依赖 B 服务包装层。
        const approved: SkillRecord[] = [];
        for (const skill of skills) {
          if (skill.review_status !== 'pending') {
            approved.push(skill);
            continue;
          }
          const now = nowTimestamp();
          const reviewed: SkillRecord = {
            ...skill,
            review_status: 'approved',
            reviewed_by: 'system:auto-approval',
            reviewed_at: now,
            updated_at: now,
          };
          await this.options.repository.updateSkill(input.role_id, reviewed);
          approved.push(reviewed);
        }
        skills = approved;
        warnings.push('Promoted Skills auto-approved for automated evaluation.');
      } else if (skills.length === 0) {
        warnings.push('No eligible Experience was promoted.');
      } else {
        warnings.push('Promoted Skills remain pending until B exposes an approval transition.');
      }
      return this.persist({
        maintenance_ref: maintenanceRef,
        kind: 'skill_promotion',
        status: 'completed',
        ...input,
        experiences: [],
        skills,
        warnings,
        created_at: startedAt,
        completed_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      });
    } catch (error) {
      return this.persist({
        maintenance_ref: maintenanceRef,
        kind: 'skill_promotion',
        status: 'failed',
        ...input,
        experiences: [],
        skills: [],
        warnings: [],
        error: error instanceof Error ? error.message : String(error),
        created_at: startedAt,
        completed_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      });
    }
  }

  /**
   * 启动恢复：为每一条 pending Buffer 补交一次上下文交付。
   *
   * 不跑提取（生产路径本来就不跑）；因为交付键稳定，重启重放只会补齐缺失的
   * 交付项，不会产生第二份。
   *
   * 逐条隔离：一条读不出来的 pending 记录只该影响它自己——报告损坏（getPendingBuffer
   * 抛错）与**声明了 context_snapshot_ref 却读不出上下文**都算，后者同样单独记一条 failed
   * evidence 并跳过，而不是降级成「本次没有上下文」把半份输入交给下游。启动恢复跑在
   * readiness 路径上（backend-rpc-stdio 把它的异常当作后端起不来的理由），而一条坏记录
   * 既不是这个进程的错、也不是它有能力修的——把整次恢复连坐掉只会让所有 Agent 一起起不来。
   * 因此每条失败单独记成一条 failed evidence（含 role / seq / 原因），余下的 Agent 与 Buffer
   * 照常重放；真的全局坏掉（如仓储列不出 Agent）仍然抛出。
   *
   * 重放不了的坏报告会留在 pending 上，于是每次启动都会再报一遍——这是刻意留的：
   * 它是需要人去修的现场，安静地跳过才是把故障藏起来。
   */
  async replayPending(): Promise<BMemoryMaintenanceEvidence[]> {
    const results: BMemoryMaintenanceEvidence[] = [];
    const roleIds = (await this.options.repository.listAgentIds()).sort(compareCodeUnits);
    for (const roleId of roleIds) {
      let seqs: number[];
      try {
        seqs = await this.options.bufferRepository.listPendingBufferSeqs(roleId);
      } catch (error) {
        results.push(await this.persistReplayFailure(roleId, undefined, error));
        continue;
      }
      for (const seq of seqs) {
        try {
          const pending = await this.options.bufferRepository.getPendingBuffer(roleId, seq);
          if (!pending) continue;
          // 声明了 context_snapshot_ref 却读不出上下文：这是**这一条**记录坏了，不是「本次
          // 没有上下文」。它照「坏记录」处理——单独记一条 failed evidence 并跳过，余下的
          // Agent 与 Buffer 照常重放；把它当成没有上下文放过，等于让下游拿到半份输入还以为
          // 是完整的。坏文件留在原地，所以每次启动都会再报一遍，等人去修。
          if (pending.agentContextStatus === 'unreadable') {
            results.push(
              await this.persistReplayFailure(
                roleId,
                seq,
                new Error(
                  pending.agentContextError ??
                    `Agent context for Buffer ${roleId}:${String(seq)} could not be read.`,
                ),
              ),
            );
            continue;
          }
          results.push(
            await this.scheduleBuffer({
              task_id: pending.snapshot.source_task_id,
              run_id: `replay:${pending.snapshot.source_task_id}`,
              role_id: roleId,
              buffer_seq: seq,
            }),
          );
        } catch (error) {
          results.push(await this.persistReplayFailure(roleId, seq, error));
        }
      }
    }
    return results;
  }

  /** 一条坏记录的重放诊断：任务流程照旧，故障及其原因如实留在重放结果里。 */
  private replayFailureEvidence(
    roleId: string,
    seq: number | undefined,
    error: unknown,
  ): BMemoryMaintenanceEvidence {
    const at = nowTimestamp();
    return {
      maintenance_ref: `b_maintenance_${randomUUID()}`,
      kind: 'context_delivery',
      status: 'failed',
      role_id: roleId,
      ...(seq !== undefined ? { buffer_seq: seq } : {}),
      experiences: [],
      skills: [],
      warnings: [
        seq === undefined
          ? 'Startup replay could not list pending Buffers for this Agent; other Agents were replayed.'
          : `Startup replay skipped Buffer ${roleId}:${String(seq)}; other Buffers were replayed.`,
      ],
      error: error instanceof Error ? error.message : String(error),
      created_at: at,
      completed_at: at,
      schema_version: SCHEMA_VERSION,
    };
  }

  private async persistReplayFailure(
    roleId: string,
    seq: number | undefined,
    error: unknown,
  ): Promise<BMemoryMaintenanceEvidence> {
    const evidence = this.replayFailureEvidence(roleId, seq, error);
    try {
      return await this.persist(evidence);
    } catch {
      // 证据存储本身写不进去时仍要把诊断交回调用方，别让它变成第二个异常
      return evidence;
    }
  }

  listEvidence(roleId?: string): Promise<BMemoryMaintenanceEvidence[]> {
    return this.options.evidenceStore.list(roleId);
  }

  async waitForIdle(): Promise<void> {
    while (this.scheduleFlights.size > 0 || this.roleQueues.size > 0) {
      await Promise.allSettled([
        ...this.scheduleFlights.values(),
        ...this.roleQueues.values(),
      ]);
    }
  }

  private enqueueRole<T>(roleId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.roleQueues.get(roleId) ?? Promise.resolve();
    const running = previous.then(operation, operation);
    const settled = running.then(
      () => undefined,
      () => undefined,
    );
    this.roleQueues.set(roleId, settled);
    void settled.then(() => {
      if (this.roleQueues.get(roleId) === settled) this.roleQueues.delete(roleId);
    });
    return running;
  }

  private async persist(
    evidence: BMemoryMaintenanceEvidence,
  ): Promise<BMemoryMaintenanceEvidence> {
    const saved = await this.options.evidenceStore.save(evidence);
    return { ...evidence, evidence_uri: saved.uri };
  }

  private async refreshRunTokenUsage(runId: string): Promise<void> {
    const runsRoot = this.options.runsRoot;
    if (!runsRoot) return;
    const summaryPath = path.join(runsRoot, runId, 'summary.json');
    try {
      const raw = JSON.parse(await fs.readFile(summaryPath, 'utf8')) as Record<string, unknown>;
      const taskId = typeof raw.task_id === 'string' ? raw.task_id : undefined;
      const driverUsage = preferDriverUsage(
        isDriverStreamUsage(raw.driver_context_usage)
          ? raw.driver_context_usage
          : isDriverStreamUsage(raw.driver_usage)
            ? raw.driver_usage
            : raw.token_usage,
        taskId ? await projectTaskDriverUsage(runsRoot, taskId) : undefined,
      );
      let changed = false;
      if (driverUsage && raw.driver_context_usage !== driverUsage) {
        raw.driver_context_usage = driverUsage;
        changed = true;
      }
      // 旧块名迁到新键：driver_context_usage 是「上下文占用」的正式口径名。
      if (raw.driver_usage !== undefined) {
        delete raw.driver_usage;
        changed = true;
      }
      if (isDriverStreamUsage(raw.token_usage)) {
        delete raw.token_usage;
        changed = true;
      }
      if (changed) await fs.writeFile(summaryPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
      // 计费 token（含 driver 侧）不在这里并：本轮 refresh 早于 run 收尾，Claude Code 的
      // session JSONL 还没写全，并进去只会低估；而且会和收尾那次并重复计数。统一由
      // FileRunTerminalOutputWriter.finalize 在 summary 落盘后并一次（见 run-token-usage-merge）。
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      // Non-fatal: maintenance evidence already persisted.
    }
  }
}

export class FileBMemoryMaintenanceEvidenceStore implements BMemoryMaintenanceEvidenceStore {
  constructor(private readonly root: string) {}

  async save(evidence: BMemoryMaintenanceEvidence): Promise<{ uri: string }> {
    await fs.mkdir(this.root, { recursive: true });
    const filePath = this.filePath(evidence.maintenance_ref);
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const uri = pathToFileURL(filePath).href;
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify({ ...evidence, evidence_uri: uri }, null, 2)}\n`,
      'utf8',
    );
    await fs.rename(temporaryPath, filePath);
    return { uri };
  }

  async get(maintenanceRef: string): Promise<BMemoryMaintenanceEvidence | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.filePath(maintenanceRef), 'utf8')) as BMemoryMaintenanceEvidence;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(roleId?: string): Promise<BMemoryMaintenanceEvidence[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const evidence = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => this.get(entry.slice(0, -'.json'.length))),
    );
    return evidence
      .filter((item): item is BMemoryMaintenanceEvidence => Boolean(item))
      .filter((item) => !roleId || item.role_id === roleId)
      .sort((left, right) => left.completed_at.localeCompare(right.completed_at));
  }

  private filePath(maintenanceRef: string): string {
    if (!/^b_maintenance_[a-zA-Z0-9-]+$/.test(maintenanceRef)) {
      throw new Error('Invalid B maintenance reference');
    }
    return path.join(this.root, `${maintenanceRef}.json`);
  }
}

function extractionRef(input: BMemoryMaintenanceRequest): string {
  const digest = createHash('sha256')
    .update(`${input.role_id}\u0000${String(input.buffer_seq)}\u0000${input.task_id}`)
    .digest('hex')
    .slice(0, 24);
  return `b_maintenance_${digest}`;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * 请求带了消融标签、但本运行时是生产交付路径 —— 留一条警告，不悄悄降级。
 *
 * 消融臂没有进程内模拟就没有记忆演化，各臂之间也就没有可比较的记忆差；把这件事
 * 静默吞掉，实验结论会在事后完全无法解释。标签本身不改变行为：它只是请求方的意图，
 * 而进程内模拟只能由构造 runner 时显式打开（见 BMemoryMaintenanceRunnerOptions.mode）。
 */
function emulationUnavailableNotice(
  input: BMemoryMaintenanceRequest,
  mode: BMemoryMaintenanceMode,
): string | undefined {
  if (!input.memory_ablation || mode === 'in_process_emulation') return undefined;
  return (
    `Request carries memory_ablation=${input.memory_ablation} but in-process memory emulation is ` +
    `not enabled in this runtime; only the context delivery item was submitted. ` +
    `The ablation label does not switch paths: construct the runner with ` +
    `mode: 'in_process_emulation' and call processBuffer explicitly to run the experiment path.`
  );
}
