/**
 * AgentManager 运行时（Boss）
 *
 * 管理 Agent 生命周期：createAgent、竞标派单 dispatchTask。
 * 持有共享 MemoryRepository 与 BufferRepository，为每个 Agent 创建独立 AgentMemoryScope。
 * 通过 AgentManagerOptions.tools 配置 LLM tool-calling。
 */
import type { AgentHandle, CreateAgentSpec } from '../schemas';
import type { BufferRepository } from '../ports/buffer-repository';
import type { MemoryRepository } from '../ports/memory-repository';
import type { AgentTaskRequest } from '../agent-types';
import type { MemoryCycleResult } from '../types';
import type { AgentToolConfig } from './agent';
import type { CompetitionClaimBatch, CollectCompetitionClaimsOptions } from '../competition-types';
import type { EmbeddingProvider } from '../ports/embedding-provider';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { QueryMemoryTool } from './tools/query-memory-tool';
import { Agent } from './agent';
import { createId, nowTimestamp } from '../../core';

/**
 * AgentManager 构造选项
 *
 * - `tools`: LLM tool-calling 配置（必选）
 * - `embedding`: 透传给 QueryMemoryTool，确保查询向量与写入向量维度一致
 */
export interface AgentManagerOptions {
  tools: AgentToolConfig;
  embedding?: EmbeddingProvider;
}

/**
 * dispatchTask 的返回结果。
 *
 * - 不包含 winner_role_id 和 scores（Memory 不负责选赢家）
 * - role_id 即 dispatchTask 指定的目标 Agent
 * - status 反映任务执行结果
 */
export interface DispatchTaskResult {
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
    await this.bufferRepository.ensureAgent(spec.role_id);
    const memory = createAgentMemoryScope(this.repository, this.bufferRepository, spec.role_id);

    // 自动注入 QueryMemoryTool（需要 AgentMemoryScope，只能在这里创建）
    const tools = {
      ...this.options.tools,
      tools: [new QueryMemoryTool(memory, this.options.embedding), ...this.options.tools.tools],
    };

    const agent = new Agent(memory, tools);
    this.agents.set(spec.role_id, agent);
    return agent.getHandle();
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

      if (noDriverInvocation) {
        return {
          role_id,
          status: 'no_driver_invocation',
          cycle,
        };
      }

      return {
        role_id,
        status: 'completed',
        cycle,
      };
    } catch (err) {
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

  async retireAgent(_role_id: string): Promise<void> {
    // TODO
  }
}
