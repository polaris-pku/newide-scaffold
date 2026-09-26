/**
 * Agent 运行时 DTO 类型
 *
 * 定义任务派发请求（AgentTaskRequest）和执行循环状态机（AgentLoopState）。
 * 仅在内存中流转，不持久化；与 schemas.ts 中的 AgentHandle 等互补。
 *
 * ## 任务文本的两个层次
 *
 * - spec：Coordinator → 顶层 Agent，完整任务规格
 * - task_instruction：顶层 Agent → Driver，由 planTaskInstruction 在运行期产出，不在此 DTO 中
 */

/**
 * 协调层派发给顶层 Agent 的一次工作任务请求。
 *
 * 不含 task_instruction —— Driver 指令由 Agent 运行期调用 planTaskInstruction 生成。
 */
export interface AgentTaskRequest {
  /**
   * 协调层 → 顶层 Agent 的完整任务规格。
   * 用于顶层 Agent 阅读、竞标、记忆检索 query；不直接传给 Driver。
   */
  spec: string;
  /** 任务唯一标识；缺省则在 runOnce 内自动生成 */
  task_id?: string;
  /** 本次执行所属 run；进程内调用留档（CallJournalPort）的 journal 外键前提 */
  run_id?: string;
  /** 本次执行的工作区（绝对路径）；Session 绑定键 (task, workspace, role) 之一 */
  workspace_path?: string;
  /** Driver 调用 ID，写入 AgentContextSnapshot.driver_calls 供溯源 */
  call_id?: string;
  /** 执行该任务的 Driver 标识；缺省为 "mock-driver" */
  source_driver?: string;
  /**
   * 测试/演示场景标记，控制晋升等行为分支：
   * - "default"           — 常规流程
   * - "promotion_ready"   — 触发技能晋升
   * - "promotion_blocked" — 验证晋升阻塞
   */
  scenario?: 'default' | 'promotion_ready' | 'promotion_blocked';
  /** Demo 用：覆盖经验置信度，生产环境不应设置 */
  demo_confidence_override?: number;
}

/**
 * Agent 执行循环的生命周期状态。
 *
 * 转换：idle ↔ sleeping ↔ running；任意活跃态 → stopped。
 */
export type AgentLoopState = 'idle' | 'sleeping' | 'running' | 'stopped';
