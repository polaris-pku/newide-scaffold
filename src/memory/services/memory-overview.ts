/**
 * Memory 全局总览（memory.getOverview）
 *
 * 跨所有已注册 Agent 聚合记忆系统的规模与健康信号：
 * Agent 数量/状态分布、技能（含待审核与市场在架）、经验总量、
 * buffer 积压/死信、跨 Agent 平均置信度。纯只读，无副作用。
 * 实现基于现有 MemoryRepository / BufferRepository 端口方法逐 Agent
 * 遍历聚合（v0 规模可接受；数据量大时可后续下沉为 DB 聚合查询）。
 */
import type { MemoryRepository } from '../ports/memory-repository';
import type { BufferRepository } from '../ports/buffer-repository';
import type { AgentStatus } from '../schemas';

/** 全局记忆总览 DTO（memory.getOverview 返回值） */
export interface MemoryOverview {
  agents: {
    total: number;
    /** 各生命周期状态下的 Agent 数（created/active/idle/draining/retired） */
    by_status: Partial<Record<AgentStatus, number>>;
  };
  skills: {
    total: number;
    /** 待人工审核的技能数（review_status='pending'） */
    pending_review: number;
    /** 市场在架技能数（market_status='available'，含退休时迁移入池的） */
    in_market: number;
  };
  experiences: {
    total: number;
  };
  buffer: {
    /** 全部 Agent 的 pending buffer 总数 */
    pending: number;
    /** 全部 Agent 的死信 buffer 总数 */
    dead_letters: number;
  };
  quality: {
    /** 跨 Agent 所有经验的简单平均置信度（无经验时为 0） */
    avg_confidence: number;
  };
}

/**
 * 计算全局记忆总览。
 *
 * 遍历 listAgentIds()（自动排除市场池 Agent），逐 Agent 聚合
 * handle 状态、skills / experiences、buffer meta。未初始化过
 * buffer 的 Agent 按 0 计数（getBufferMeta 抛错时容错跳过）。
 */
export async function computeMemoryOverview(
  repository: MemoryRepository,
  bufferRepository: BufferRepository,
): Promise<MemoryOverview> {
  const agentIds = await repository.listAgentIds();

  const byStatus: Partial<Record<AgentStatus, number>> = {};
  let skillsTotal = 0;
  let pendingReview = 0;
  let inMarket = 0;
  let experiencesTotal = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;
  let bufferPending = 0;
  let bufferDead = 0;

  for (const roleId of agentIds) {
    const handle = await repository.getAgent(roleId);
    byStatus[handle.status] = (byStatus[handle.status] ?? 0) + 1;

    const [skills, experiences] = await Promise.all([
      repository.listSkills(roleId),
      repository.listExperiences(roleId),
    ]);
    skillsTotal += skills.length;
    experiencesTotal += experiences.length;
    for (const skill of skills) {
      if (skill.review_status === 'pending') {
        pendingReview += 1;
      }
      if (skill.market_status === 'available') {
        inMarket += 1;
      }
    }
    for (const experience of experiences) {
      confidenceSum += experience.confidence;
      confidenceCount += 1;
    }

    try {
      const meta = await bufferRepository.getBufferMeta(roleId);
      bufferPending += meta.pending_count;
      bufferDead += meta.total_dead_letters;
    } catch {
      // Agent 未初始化 buffer 目录 → 视为无积压
    }
  }

  return {
    agents: { total: agentIds.length, by_status: byStatus },
    skills: { total: skillsTotal, pending_review: pendingReview, in_market: inMarket },
    experiences: { total: experiencesTotal },
    buffer: { pending: bufferPending, dead_letters: bufferDead },
    quality: {
      avg_confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : 0,
    },
  };
}
