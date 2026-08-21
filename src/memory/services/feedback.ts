/**
 * Feedback — 用户评分反馈服务（memory.rateTask）
 *
 * 打通评分 → 置信度 / 溯源的最小闭环（局限 L1、实现顺序文档「阶段 8」）：
 *   1. 按 source_task_id 定位该任务派生的 Experiences，写入 source_user_rating，
 *      并按评分调整置信度（resolved +0.05 / partially_resolved 0 / unresolved −0.1，
 *      下限 0 上限 1），追加 confidence_history（reason='user_rating'），同步 avg_confidence
 *   2. 若该任务的 buffer 仍处于 pending，写入 BufferSnapshot.user_rating（供后续提取器消费）
 *
 * 与 memory-writer 同模式：纯函数式，repository / bufferRepository 直接注入。
 * 说明：经验定位暂用 listExperiences 过滤（内联查询），经验量极大时可升级为
 * 仓库层 findExperiencesBySourceTask 索引查询。
 */
import { nowTimestamp } from '../../core';
import type { BufferRepository } from '../ports/buffer-repository';
import type { MemoryRepository } from '../ports/memory-repository';
import type { UserRating } from '../schemas';

/** rateTask 入参 */
export interface RateTaskInput {
  role_id: string;
  /** 任务 ID（匹配 ExperienceRecord.source_task_id 与 BufferSnapshot.task_id/source_task_id） */
  task_id: string;
  /** 用户评分（resolved / partially_resolved / unresolved / not_rated） */
  rating: UserRating;
  /** 可选评分备注（写入 confidence_history 的 reason） */
  note?: string;
}

/** rateTask 结果 */
export interface UserRatingResult {
  /** 被更新评分的经验条数 */
  updated_experiences: number;
  /** 是否已把评分写入仍 pending 的缓冲区 */
  buffer_updated: boolean;
}

/** 各评分对应的置信度增量 */
const CONFIDENCE_DELTA: Record<UserRating, number> = {
  resolved: 0.05,
  partially_resolved: 0,
  unresolved: -0.1,
  not_rated: 0,
};

/**
 * 应用一次用户评分。
 *
 * @throws 当 role_id 不存在时由 repository 抛错；buffer 未找到匹配 pending 项时
 *         仅返回 buffer_updated=false（评分仍已作用于经验）。
 */
export async function applyUserRating(
  repository: MemoryRepository,
  bufferRepository: BufferRepository,
  input: RateTaskInput,
): Promise<UserRatingResult> {
  const { role_id, task_id, rating, note } = input;
  const now = nowTimestamp();
  const reason = note ? `user_rating:${rating} (${note})` : `user_rating:${rating}`;
  const delta = CONFIDENCE_DELTA[rating];

  // ① 该任务派生的经验：写 source_user_rating + 调整置信度
  const experiences = (await repository.listExperiences(role_id)).filter(
    (experience) => experience.source_task_id === task_id,
  );
  let updatedExperiences = 0;
  for (const experience of experiences) {
    const nextConfidence = round3(clamp01(experience.confidence + delta));
    await repository.updateExperience(role_id, {
      ...experience,
      source_user_rating: rating,
      confidence: nextConfidence,
      confidence_history: [
        ...experience.confidence_history,
        { value: nextConfidence, updated_at: now, reason },
      ],
      updated_at: now,
    });
    updatedExperiences += 1;
  }
  if (updatedExperiences > 0) {
    await recomputeAvgConfidence(repository, role_id);
  }

  // ② 该任务的 buffer 若仍 pending，写入 user_rating（供提取器溯源）
  //    无 buffer 存储（Agent 从未产生过 buffer）视为无 pending 项，评分不因此失败
  let bufferUpdated = false;
  try {
    for (const seq of await bufferRepository.listPendingBufferSeqs(role_id)) {
      const pending = await bufferRepository.getPendingBuffer(role_id, seq);
      if (
        pending &&
        (pending.snapshot.task_id === task_id || pending.snapshot.source_task_id === task_id)
      ) {
        await bufferRepository.updateBufferRating(role_id, seq, rating);
        bufferUpdated = true;
        break;
      }
    }
  } catch {
    bufferUpdated = false;
  }

  return { updated_experiences: updatedExperiences, buffer_updated: bufferUpdated };
}

/** 重算 avg_confidence = 全部经验置信度均值（写入 updateMetrics，保持聚合根一致） */
async function recomputeAvgConfidence(
  repository: MemoryRepository,
  role_id: string,
): Promise<void> {
  const experiences = await repository.listExperiences(role_id);
  const average =
    experiences.length > 0
      ? experiences.reduce((sum, experience) => sum + experience.confidence, 0) /
        experiences.length
      : 0;
  await repository.updateMetrics(role_id, (metrics) => ({
    ...metrics,
    avg_confidence: round3(average),
  }));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
