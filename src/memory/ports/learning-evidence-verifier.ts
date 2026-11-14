/**
 * LearningEvidenceVerifier 端口 — 离线学习输入的受控证据核验
 *
 * Buffer v2 里保存的是**引用**（Journal 前缀 + 各派工 evidence ref/hash）与**摘要计数**，
 * 不是执行事实本身。离线消费前必须回到事实源核对：引用是否还在、边界是否一致、hash 是否
 * 匹配、摘要计数是否能由真实证据重建。这个端口把「怎么找到并读取事实源」留在组合根
 * （知道 runs root 的地方），把「核验结论怎么影响来源分级」留给 memory 侧的
 * `learning-input-grade`（规则版与 LLM 版提取器共用同一份实现）。
 *
 * 核验结论只有三种可降级的结果：
 * - `verified`：前缀/边界/hash 与每个派工 evidence ref 都核对通过，`dispatches` 是由
 *   Journal/evidence 重建的摘要（调用方不得再直接信任 Buffer 里的计数）；
 * - `missing`：Run 目录、Journal 或 evidence 文件已经不存在（例如用户删除了 Task/Run）——
 *   属于内容缺失，不是暂时性存储故障；
 * - `mismatch`：前缀边界/hash、dispatch 集合/状态或 evidence hash 与事实源不一致。
 *
 * 暂时性存储故障（连接/超时/瞬时 I/O）**不**映射成这三种结论，而是由实现直接抛出原始错误：
 * 那应该走既有交付重试/死信生命周期，而不是把一次抖动写成一类低置信度经验。
 */
import type { BufferDispatchSummary, BufferSnapshotV2, BufferRoleStatus } from '../schemas';

export type LearningInputEvidenceStatus = 'verified' | 'missing' | 'mismatch';

export interface LearningInputEvidenceVerification {
  status: LearningInputEvidenceStatus;
  /** 进入维护证据 warnings 的可读诊断（缺失/失配时必须说明原因）。 */
  warnings: string[];
  /**
   * 仅当 `status='verified'` 时提供：从受控 Journal/evidence 重建的派工摘要。
   * 分级与提取必须以它为事实来源，而不是 Buffer 里未经核对的计数。
   */
  dispatches?: readonly BufferDispatchSummary[];
  /**
   * 仅当 `status='verified'` 时提供：受控 Journal finish 行的 Role 结束状态。
   * 用于兼容没有 `role_reflection.status` 的旧 v2（补回值也要留诊断）。
   */
  finish_status?: BufferRoleStatus;
}

export interface LearningEvidenceVerifier {
  verify(snapshot: BufferSnapshotV2): Promise<LearningInputEvidenceVerification>;
}
