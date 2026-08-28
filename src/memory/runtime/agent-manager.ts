/**
 * AgentManager 运行时（Boss）
 *
 * 管理 Agent 生命周期：createAgent、竞标派单 dispatchTask。
 * 持有共享 MemoryRepository 与 BufferRepository，为每个 Agent 创建独立 AgentMemoryScope。
 * 通过 AgentManagerOptions.tools 配置 LLM tool-calling。
 */
import {
  MARKET_POOL_ROLE_ID,
  type AgentHandle,
  type CreateAgentSpec,
  type RetiredReason,
} from '../schemas';
import type { BufferRepository } from '../ports/buffer-repository';
import type { MemoryRepository } from '../ports/memory-repository';
import type { AgentTaskRequest } from '../agent-types';
import type { MemoryCycleResult } from '../types';
import type { AgentToolConfig } from './agent';
import type { CompetitionClaimBatch, CollectCompetitionClaimsOptions } from '../competition-types';
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type { TaskOutcome } from '../services/metrics';
import type { RetireOptions, RetireResult } from '../services/retirement';
import {
  RetirementDetector,
  type RetirementEvaluator,
  type RetirementScanResult,
} from '../services/retirement-detection';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { QueryMemoryTool } from './tools/query-memory-tool';
import { recordBid, recordTaskOutcome } from '../services/metrics';
import {
  buildAgentArchive,
  createReplacementAgent,
  disposeRetiredAssets,
} from '../services/retirement';
import { Agent } from './agent';
import { createId, nowTimestamp } from '../../core';

/**
 * AgentManager 构造选项
 *
 * - `tools`: LLM tool-calling 配置（必选）
 * - `embedding`: 透传给 QueryMemoryTool，确保查询向量与写入向量维度一致
 * - `retirementEvaluator`: 三重门控退休检测的 LLM 层评估器（可选）。不注入则
 *   scanForRetirements 只跑统计层 + Persona 漂移层。
 * - `retirementDetector`: 退休检测器（可选，覆盖默认构建；测试注入用）。
 */
export interface AgentManagerOptions {
  tools: AgentToolConfig;
  embedding?: EmbeddingProvider;
  retirementEvaluator?: RetirementEvaluator;
  retirementDetector?: RetirementDetector;
}

/**
 * deleteAgent 的选项。
 *
 * - `force`: 删除未退休 Agent 时必传。未退休 Agent 的 skills 尚未迁移
 *   市场池、experiences 尚未分级处置，强制删除会级联丢弃其名下全部
 *   资产且不可恢复——仅应在用户明确二次确认后置 true。已退休 Agent
 *   删除无需该标志。
 */
export interface DeleteAgentOptions {
  force?: boolean;
}

/**
 * dispatchTask 的返回结果。
 *
 * - 不包含 winner_role_id 和 scores（Memory 不负责选赢家）
 * - role_id 即 dispatchTask 指定的目标 Agent
 * - status 反映任务执行结果
 */export interface DispatchTaskResult {
  role_id: string;
  status:
    | 'completed'
    | 'failed'
    | 'blocked'
    | 'cancelled'
    | 'no_driver_invocation'
    | 'max_rounds_exceeded';
  /** 记忆周期结果（执行完成后的完整结果） */
  cycle: MemoryCycleResult;
}

/**
 * 稳定的公开任务投影，供 Council / frontend 使用。
 * 从 DispatchTaskResult 派生，不触发额外存储读取。
 *
 * 移除了 winner_role_id 和 scores（上层负责选赢家记录）。
 * Council 如需这些信息应在调用 dispatchTask 前自行保存决策记录。
 */
export interface MemoryTaskProjection {
  task_id: string;
  role_id: string;
  driver_summary: string;
  context: {
    skill_count: number;
    experience_count: number;
  };
  extraction: {
    experiences_created: number;
    experiences_updated: number;
    negative_experiences: number;
    skills_promoted: number;
  };
  promoted_skill_ids: string[];
  buffer_seq: number;
}

/** 将 DispatchTaskResult 映射为公开投影 */
export function toMemoryTaskProjection(result: DispatchTaskResult): MemoryTaskProjection {
  const { cycle } = result;
  return {
    task_id: cycle.buffer_snapshot.task_id,
    role_id: result.role_id,
    driver_summary: cycle.buffer_snapshot.driver_return.summary,
    context: {
      skill_count: cycle.driver_context.skills?.length ?? 0,
      experience_count: cycle.driver_context.experiences?.length ?? 0,
    },
    extraction: {
      experiences_created: cycle.extraction.result.experiences_created,
      experiences_updated: cycle.extraction.result.experiences_updated,
      negative_experiences: cycle.extraction.result.negative_experiences,
      skills_promoted: cycle.extraction.result.skills_promoted,
    },
    promoted_skill_ids: cycle.promotion.skill ? [cycle.promotion.skill.id] : [],
    buffer_seq: cycle.buffer_seq,
  };
}

export class AgentManager {
  private readonly agents = new Map<string, Agent>();
  /** 预退休待完成意图（role_id → 退休选项）。dispatchTask 收尾时用于自动 finalize。 */
  private readonly pendingRetirement = new Map<string, RetireOptions>();

  constructor(
    private readonly repository: MemoryRepository,
    private readonly bufferRepository: BufferRepository,
    private readonly options: AgentManagerOptions,
  ) {}

  /**
   * 创建 AgentManager 实例并预加载所有已注册的 Agent。
   *
   * - `await AgentManager.create(repo, buf, { tools })` — 传入 LLM tool-calling 配置
   *
   * 创建时自动从 Repository 加载所有已注册的 Agent 实例到内存。
   */
  static async create(
    repository: MemoryRepository,
    bufferRepository: BufferRepository,
    options: AgentManagerOptions,
  ): Promise<AgentManager> {
    const manager = new AgentManager(repository, bufferRepository, options);
    await manager.loadAllAgents();
    return manager;
  }

  /**
   * 加载 Repository 中所有已注册的 Agent 到内存。
   *
   * 在 AgentManager.create() 时调用，确保 Manager 的 agents Map 与 DB 保持一致。
   */
  private async loadAllAgents(): Promise<void> {
    const registeredIds = await this.repository.listAgentIds();
    for (const role_id of registeredIds) {
      if (!this.agents.has(role_id)) {
        await this.repository.ensureAgent(role_id);
        await this.bufferRepository.ensureAgent(role_id);
        const memory = createAgentMemoryScope(this.repository, this.bufferRepository, role_id);
        const tools = {
          ...this.options.tools,
          tools: [new QueryMemoryTool(memory, this.options.embedding), ...this.options.tools.tools],
        };
        const agent = new Agent(memory, tools);
        this.agents.set(role_id, agent);
      }
    }
  }

  async createAgent(spec: CreateAgentSpec): Promise<AgentHandle> {
    await this.repository.initializeAgent(spec);
    const agent = await this.instantiateAgent(spec.role_id);
    this.agents.set(spec.role_id, agent);
    return agent.getHandle();
  }

  /**
   * 删除 Agent（硬删除，级联清理全部持久化记忆与 buffer 存储）。
   *
   * 默认安全前置条件：Agent 必须已 retired（skills 已在退休时迁移市场池，
   * 名下保留的 experiences 随删除级联清理）。活跃 / draining Agent 若确认要
   * 彻底移除（级联丢弃名下全部资产且不可恢复），可传 `{ force: true }`
   * 显式二次确认后删除；资产想保留应先 retireAgent（skills 进市场池）。
   *
   * 已归档角色（退休已完成、实体已删）→ 幂等成功（归档记录保留），不报错。
   * 市场池 Agent 禁止删除。
   */
  async deleteAgent(role_id: string, options: DeleteAgentOptions = {}): Promise<void> {
    if (role_id === MARKET_POOL_ROLE_ID) {
      throw new Error(`Cannot delete market pool agent: ${role_id}`);
    }
    const handle = await this.repository.getAgent(role_id).catch(() => null);
    if (!handle) {
      // 实体不存在：若已归档（退休已完成、实体已删）→ 幂等成功（归档保留）
      const archived = await this.repository.getAgentArchive(role_id).catch(() => null);
      if (archived) {
        return;
      }
      throw new Error(`Agent not found: ${role_id}`);
    }
    if (handle.status !== 'retired' && !options.force) {
      throw new Error(
        `Agent must be retired before deletion: ${role_id} ` +
          `(current status: ${handle.status}); ` +
          `pass force: true to delete it anyway — this permanently discards ` +
          `all of its skills, experiences and persona`,
      );
    }
    await this.repository.deleteAgent(role_id);
    await this.bufferRepository.deleteAgent(role_id);
    this.agents.delete(role_id);
  }

  /**
   * 为指定 role_id 装配运行时 Agent 实例：
   * 确保 buffer 目录存在、创建 AgentMemoryScope、自动注入 QueryMemoryTool。
   */
  private async instantiateAgent(role_id: string): Promise<Agent> {
    await this.bufferRepository.ensureAgent(role_id);
    const memory = createAgentMemoryScope(this.repository, this.bufferRepository, role_id);

    // 自动注入 QueryMemoryTool（需要 AgentMemoryScope，只能在这里创建）
    const tools = {
      ...this.options.tools,
      tools: [new QueryMemoryTool(memory, this.options.embedding), ...this.options.tools.tools],
    };

    return new Agent(memory, tools);
  }

  /**
   * 收集所有 Agent 对一次任务机会的参选声明。
   *
   * - 从 this.agents 中获取所有已加载的 Agent 实例（create 时已从 DB 预加载）
   * - 不可用状态（running/draining/retired）Agent → 直接返回 unavailable
   * - 可用 Agent 并行自评（participate / decline）
   * - **只返回 decision === 'participate' 的 Agent**，并丰富其能力信息供外部决策
   * - 超时/异常 Agent 分别转换为 timeout/error 声明，不阻塞其他
   * - 结果按 role_id 排序，保证调用方不依赖异步完成顺序
   * - 不占用任务槽、不改变 Agent 状态为 running
   */
  async collectCompetitionClaims(
    task: AgentTaskRequest,
    options?: CollectCompetitionClaimsOptions,
  ): Promise<CompetitionClaimBatch> {
    const correlation_id = createId('corr');
    const started_at = nowTimestamp();
    const timeout_ms = options?.timeout_ms ?? 10_000;

    // 并行收集声明
    const agentEntries = [...this.agents.entries()];

    const claimPromises = agentEntries.map(async ([role_id, agent]) => {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeout_ms),
      );

      try {
        const claim = await Promise.race([agent.createCompetitionClaim(task), timeoutPromise]);
        return claim;
      } catch (err) {
        const isTimeout = err instanceof Error && err.message === 'timeout';
        return {
          role_id,
          decision: (isTimeout ? 'timeout' : 'error') as 'timeout' | 'error',
          availability: {
            agent_status: 'created' as const,
            loop_state: agent.getState(),
          },
          generated_at: nowTimestamp(),
        };
      }
    });

    const allClaims = await Promise.all(claimPromises);

    // 统计全景摘要
    const summary = {
      total: allClaims.length,
      participated: 0,
      busy_participated: 0,
      declined: 0,
      unavailable: 0,
      timed_out: 0,
      errored: 0,
    };
    for (const c of allClaims) {
      switch (c.decision) {
        case 'participate':
          summary.participated++;
          if (c.availability.busy) summary.busy_participated++;
          break;
        case 'decline':
          summary.declined++;
          break;
        case 'unavailable':
          summary.unavailable++;
          break;
        case 'timeout':
          summary.timed_out++;
          break;
        case 'error':
          summary.errored++;
          break;
      }
    }

    // 只保留 participate 的 Agent（上层所需能力信息待后续补充）
    const participating = allClaims
      .filter((c) => c.decision === 'participate')
      .sort((a, b) => a.role_id.localeCompare(b.role_id));

    // Metrics：参与竞标 → tasks_bid++
    // （这些 Agent 已声明"我可以参选"，即使最终未中标也算一次竞标经历）
    // 指标采集失败不阻塞竞标收集（best-effort）
    for (const claim of participating) {
      try {
        await recordBid(this.repository, claim.role_id);
      } catch {
        // ignore — metrics must not break the bidding path
      }
    }

    return {
      correlation_id,
      task_id: task.task_id ?? createId('task'),
      claims: participating,
      summary,
      started_at,
      completed_at: nowTimestamp(),
    };
  }

  /**
   * 指定 Agent 执行任务（替代旧 submitTask 的指定派发方式）。
   *
   * 上层负责通过 collectCompetitionClaims 收集声明、比较并选择合适的 role_id，
   * 然后调用 dispatchTask 执行。
   *
   * 约束：
   * - 不包含 winner_role_id 和 scores
   * - 不存在、退役、draining 或正在忙的 Agent 明确返回 blocked
   * - 未调用 Driver 不会自动伪装为成功
   */
  async dispatchTask(role_id: string, task: AgentTaskRequest): Promise<DispatchTaskResult> {
    const agent = this.agents.get(role_id);
    if (!agent) {
      return {
        role_id,
        status: 'blocked',
        cycle: {
          agent_id: role_id,
          persona: await this.repository.getPersona(role_id).catch(() => ({
            role_id,
            version: 0,
            summary: '',
            skills_overview: '',
            experience_coverage: '',
            recent_performance: '',
            notes: '',
            generated_at: nowTimestamp(),
          })),
          skills_before: [],
          retrieval: { skills: [], experiences: [] },
          driver_context: {
            task_instruction: '',
            skills: [],
            experiences: [],
          },
          buffer_snapshot: {
            task_id: task.task_id ?? createId('task'),
            task_description: task.spec,
            driver_return: {
              artifacts: [],
              summary: 'Agent not found.',
              decisions: [],
              blockers: [],
              referenced_experiences: [],
              assumptions: [],
            },
            source_task_id: task.task_id ?? createId('task'),
            source_driver: task.source_driver ?? 'unknown',
            received_at: nowTimestamp(),
            retry_count: 0,
            extraction_status: 'pending',
          },
          buffer_seq: 0,
          extraction: {
            experiences: [],
            result: {
              experiences_created: 0,
              experiences_updated: 0,
              negative_experiences: 0,
              skills_promoted: 0,
            },
          },
          promotion: {
            check: {
              eligible: false,
              auto_approved: false,
              reasons: [],
              blocking_rules: ['Agent not found'],
            },
          },
        },
      };
    }

    const handle = await this.repository.getAgent(role_id).catch(() => null);
    if (handle && (handle.status === 'draining' || handle.status === 'retired')) {
      return {
        role_id,
        status: 'blocked',
        cycle: {
          agent_id: role_id,
          persona: await this.repository.getPersona(role_id).catch(() => ({
            role_id,
            version: 0,
            summary: '',
            skills_overview: '',
            experience_coverage: '',
            recent_performance: '',
            notes: '',
            generated_at: nowTimestamp(),
          })),
          skills_before: [],
          retrieval: { skills: [], experiences: [] },
          driver_context: { task_instruction: '', skills: [], experiences: [] },
          buffer_snapshot: {
            task_id: task.task_id ?? createId('task'),
            task_description: task.spec,
            driver_return: {
              artifacts: [],
              summary: `Agent status is ${handle.status}.`,
              decisions: [],
              blockers: [],
              referenced_experiences: [],
              assumptions: [],
            },
            source_task_id: task.task_id ?? createId('task'),
            source_driver: task.source_driver ?? 'unknown',
            received_at: nowTimestamp(),
            retry_count: 0,
            extraction_status: 'pending',
          },
          buffer_seq: 0,
          extraction: {
            experiences: [],
            result: {
              experiences_created: 0,
              experiences_updated: 0,
              negative_experiences: 0,
              skills_promoted: 0,
            },
          },
          promotion: {
            check: {
              eligible: false,
              auto_approved: false,
              reasons: [],
              blocking_rules: ['Agent not available'],
            },
          },
        },
      };
    }

    // 并发检查
    if (agent.hasPendingTask()) {
      return {
        role_id,
        status: 'blocked',
        cycle: {
          agent_id: role_id,
          persona: await this.repository.getPersona(role_id).catch(() => ({
            role_id,
            version: 0,
            summary: '',
            skills_overview: '',
            experience_coverage: '',
            recent_performance: '',
            notes: '',
            generated_at: nowTimestamp(),
          })),
          skills_before: [],
          retrieval: { skills: [], experiences: [] },
          driver_context: { task_instruction: '', skills: [], experiences: [] },
          buffer_snapshot: {
            task_id: task.task_id ?? createId('task'),
            task_description: task.spec,
            driver_return: {
              artifacts: [],
              summary: 'Agent is busy with another task.',
              decisions: [],
              blockers: [],
              referenced_experiences: [],
              assumptions: [],
            },
            source_task_id: task.task_id ?? createId('task'),
            source_driver: task.source_driver ?? 'unknown',
            received_at: nowTimestamp(),
            retry_count: 0,
            extraction_status: 'pending',
          },
          buffer_seq: 0,
          extraction: {
            experiences: [],
            result: {
              experiences_created: 0,
              experiences_updated: 0,
              negative_experiences: 0,
              skills_promoted: 0,
            },
          },
          promotion: {
            check: {
              eligible: false,
              auto_approved: false,
              reasons: [],
              blocking_rules: ['Agent busy'],
            },
          },
        },
      };
    }

    try {
      const cycle = await agent.executeTask(task);

      // 检测是否真的调用了 Driver：
      // 未调用 invoke_driver 时 writeToBuffer 使用占位 DriverReturn（所有数组为空且摘要含标记）
      const dr = cycle.buffer_snapshot.driver_return;
      const noDriverInvocation =
        dr.artifacts.length === 0 &&
        dr.decisions.length === 0 &&
        dr.blockers.length === 0 &&
        dr.referenced_experiences.length === 0 &&
        dr.assumptions.length === 0 &&
        dr.summary.includes('without driver invocation');

      const status = noDriverInvocation ? 'no_driver_invocation' : 'completed';
      await this.recordDispatchMetrics(role_id, status);
      // 任务完成收尾：若该 role 处于预退休（draining）且无在跑任务 → 自动 finalize
      await this.finalizeIfPreRetired(role_id);
      return { role_id, status, cycle };
    } catch (err) {
      await this.recordDispatchMetrics(role_id, 'failed');
      await this.finalizeIfPreRetired(role_id);
      return {
        role_id,
        status: 'failed',
        cycle: {
          agent_id: role_id,
          persona: await this.repository.getPersona(role_id).catch(() => ({
            role_id,
            version: 0,
            summary: '',
            skills_overview: '',
            experience_coverage: '',
            recent_performance: '',
            notes: '',
            generated_at: nowTimestamp(),
          })),
          skills_before: [],
          retrieval: { skills: [], experiences: [] },
          driver_context: { task_instruction: '', skills: [], experiences: [] },
          buffer_snapshot: {
            task_id: task.task_id ?? createId('task'),
            task_description: task.spec,
            driver_return: {
              artifacts: [],
              summary: `Task failed: ${err instanceof Error ? err.message : String(err)}`,
              decisions: [],
              blockers: [],
              referenced_experiences: [],
              assumptions: [],
            },
            source_task_id: task.task_id ?? createId('task'),
            source_driver: task.source_driver ?? 'unknown',
            received_at: nowTimestamp(),
            retry_count: 0,
            extraction_status: 'pending',
          },
          buffer_seq: 0,
          extraction: {
            experiences: [],
            result: {
              experiences_created: 0,
              experiences_updated: 0,
              negative_experiences: 0,
              skills_promoted: 0,
            },
          },
          promotion: {
            check: {
              eligible: false,
              auto_approved: false,
              reasons: [],
              blocking_rules: ['Task failed'],
            },
          },
        },
      };
    }
  }

  getAgent(role_id: string): Agent | undefined {
    return this.agents.get(role_id);
  }

  async listAgentHandles(): Promise<AgentHandle[]> {
    return Promise.all([...this.agents.values()].map((agent) => agent.getHandle()));
  }

  /**
   * 三重门控退休检测（week3 RFC §8.2 触发机制）。
   *
   * 委托给 RetirementDetector（默认构建，可注入覆盖）；不自动退休，
   * 只产出 recommended_action 与逐层证据，供上层决定是否调用 retireAgent。
   *
   * @param roleId 指定扫描单个 Agent；缺省扫描全部活跃 Agent。
   */
  async scanForRetirements(roleId?: string): Promise<RetirementScanResult[]> {
    const detector =
      this.options.retirementDetector ??
      new RetirementDetector(this.repository, {
        ...(this.options.retirementEvaluator ? { llm: this.options.retirementEvaluator } : {}),
      });
    if (roleId) {
      return [await detector.scan(roleId)];
    }
    return detector.scanAll();
  }

  /**
   * 优雅退休（week3 RFC §12.1）— 两阶段：
   *
   * Phase 1 — 预退休（draining）：状态置为 'draining'，不再参与竞标 / 不再被派发；
   *           若有在跑任务，返回 status='pre_retired'，等任务完成后由 dispatchTask
   *           收尾自动触发 finalize。
   * Phase 2 — finalize：资产处置（Skills 进入市场、Experiences 计数/删除）→
   *           归档最小字段 → 删除 Agent 实体（保留经验随实体级联删除）→ 从内存 map 驱逐。
   *
   * 可选创建替代 Agent（clean_slate / seeded_slate），须在删除源实体之前创建。
   *
   * 对已归档（退休完成、实体已删）Agent 幂等：返回归档摘要，不做重复处置。
   */
  async retireAgent(role_id: string, options: RetireOptions = {}): Promise<RetireResult> {
    // 已归档（退休完成、实体已删）→ 幂等返回归档摘要
    const archived = await this.repository.getAgentArchive(role_id).catch(() => null);
    if (archived) {
      return {
        role_id,
        status: 'retired',
        retired_at: archived.retired_at,
        retired_reason: archived.retired_reason,
        asset_disposition: archived.asset_disposition,
        ...(archived.replacement_role_id
          ? { replacement_role_id: archived.replacement_role_id }
          : {}),
      };
    }

    const handle = await this.repository.getAgent(role_id).catch(() => null);
    if (!handle) {
      throw new Error(`Agent not found: ${role_id}`);
    }
    if (role_id === MARKET_POOL_ROLE_ID) {
      throw new Error(`Cannot retire market pool agent: ${role_id}`);
    }

    // 记录退休意图（reason / replacement），供后续 finalize（含 dispatchTask 自动触发）读取
    this.pendingRetirement.set(role_id, options);

    // 兼容旧数据：实体仍为 retired（未归档）→ 直接归档并删除
    if (handle.status === 'retired') {
      return this.finalizeRetirement(role_id, handle);
    }

    // 已是预退休（draining）：无在跑任务则 finalize，否则保持预退休
    if (handle.status === 'draining') {
      if (this.agents.get(role_id)?.hasPendingTask()) {
        return preRetiredResult(role_id, options.reason ?? 'manual');
      }
      return this.finalizeRetirement(role_id, handle);
    }

    // Phase 1: 置预退休标记（不再接新任务/竞标）
    await this.repository.updateAgentStatus(role_id, 'draining');

    // 尚有在跑任务 → 保持预退休，等 dispatchTask 收尾自动 finalize
    if (this.agents.get(role_id)?.hasPendingTask()) {
      return preRetiredResult(role_id, options.reason ?? 'manual');
    }

    // 无在跑任务 → 立即 finalize
    return this.finalizeRetirement(role_id, handle);
  }

  /**
   * 退休 finalize：资产处置 → 归档 → 删除实体 → 驱逐内存实例。
   *
   * reason / replacement 从 pendingRetirement 读取（首次 retireAgent 调用时记录）。
   */
  private async finalizeRetirement(
    role_id: string,
    handle: AgentHandle,
  ): Promise<RetireResult> {
    const retireOptions = this.pendingRetirement.get(role_id) ?? {};
    const reason = retireOptions.reason ?? 'manual';
    const retiredAt = nowTimestamp();
    this.pendingRetirement.delete(role_id);

    // Phase 2: 资产处置（skills 入市；低置信经验删除，高置信经验随后随实体级联删除）
    const [skills, experiences] = await Promise.all([
      this.repository.listSkills(role_id),
      this.repository.listExperiences(role_id),
    ]);
    const assetDisposition = await disposeRetiredAssets(this.repository, {
      role_id,
      skills,
      experiences,
    });

    // 替代 Agent 必须在删除源实体之前创建（需要读取 source handle / experiences）
    let replacementRoleId: string | undefined;
    if (retireOptions.replacement && retireOptions.replacement !== 'none') {
      replacementRoleId = await createReplacementAgent(
        this.repository,
        handle,
        experiences,
        retireOptions.replacement,
      );
      // 让替代 Agent 立即进入内存 map，可被后续竞标/派发使用
      if (!this.agents.has(replacementRoleId)) {
        this.agents.set(replacementRoleId, await this.instantiateAgent(replacementRoleId));
      }
    }

    // Phase 3: 归档 + 删除实体 + 驱逐
    const archive = buildAgentArchive(handle, {
      retired_at: retiredAt,
      retired_reason: reason,
      asset_disposition: assetDisposition,
      ...(replacementRoleId ? { replacement_role_id: replacementRoleId } : {}),
    });
    await this.repository.archiveAgent(role_id, archive);
    await this.repository.deleteAgent(role_id);
    await this.bufferRepository.deleteAgent(role_id);
    this.agents.delete(role_id);

    return {
      role_id,
      status: 'retired',
      retired_at: retiredAt,
      retired_reason: reason,
      asset_disposition: assetDisposition,
      ...(replacementRoleId ? { replacement_role_id: replacementRoleId } : {}),
    };
  }

  /**
   * dispatchTask 收尾钩子：任务完成后，若该 role 处于预退休（draining）且无在跑任务，
   * 则自动触发 finalize。
   */
  private async finalizeIfPreRetired(role_id: string): Promise<void> {
    const agent = this.agents.get(role_id);
    if (agent?.hasPendingTask()) {
      return; // 仍有在跑任务，继续等待
    }
    const handle = await this.repository.getAgent(role_id).catch(() => null);
    if (handle && handle.status === 'draining') {
      await this.finalizeRetirement(role_id, handle);
    }
  }

  /**
   * 将一次派发结果落为 Metrics 增量。
   * blocked / cancelled / max_rounds_exceeded 不记录（Agent 未实际执行）。
   */
  private async recordDispatchMetrics(
    role_id: string,
    status: DispatchTaskResult['status'],
  ): Promise<void> {
    let outcome: TaskOutcome | undefined;
    if (status === 'completed') {
      outcome = 'succeeded';
    } else if (status === 'no_driver_invocation') {
      outcome = 'partial';
    } else if (status === 'failed') {
      outcome = 'failed';
    }
    if (!outcome) {
      return;
    }
    try {
      await recordTaskOutcome(this.repository, role_id, outcome);
    } catch {
      // 指标采集失败不影响任务派发结果（best-effort）
    }
  }
}

/** 预退休结果：标记退休意图但仍有在跑任务，等待任务完成后自动 finalize。 */
function preRetiredResult(role_id: string, reason: RetiredReason): RetireResult {
  return {
    role_id,
    status: 'pre_retired',
    retired_reason: reason,
    pending: true,
  };
}

export type { RetireOptions, RetireResult } from '../services/retirement';
