/**
 * 基于 repository 的任务前记忆检索（MemoryQueryStrategy 实现）
 *
 * AgentRunDeps.queryMemory 的生产实现：将 AgentTaskRequest 转为检索输入，
 * 委托 memory-retrieval 返回完整 exp/skill 实体。
 *
 * ## 职责边界
 *
 * - 使用 task.spec 作检索 query（顶层 Agent 视角的完整任务）
 * - 不读取 Persona，不产出 task_instruction，不组装 DriverContext
 * - 返回结果供 services/driver-context 组装
 *
 * ## 注入点
 *
 * default-agent-run-deps.ts → defaultMvpAgentRunDeps.queryMemory
 */
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { AgentTaskRequest } from '../agent-types';
import type { MemoryRetrievalResult } from '../services/memory-query';
import { retrieveMemoriesForTask, type MemoryRetrievalOptions } from './memory-retrieval';

/**
 * 任务执行前的记忆检索策略（MemoryQueryStrategy）。
 *
 * 由 prepareTaskContext / buildDriverContext 内部调用；返回结果供 DriverContext 记忆部分使用。
 *
 * @param memory  - 当前 Agent 的记忆作用域
 * @param task    - 含 spec（作检索 query），不含 Driver 指令
 * @param _task_id - 任务 ID（检索逻辑暂不使用，保留接口一致性）
 * @param options - 可选检索策略（含消融 selection）
 */
export async function repositoryRetrieveMemoryForTask(
  memory: AgentMemoryScope,
  task: AgentTaskRequest,
  _task_id: string,
  options?: MemoryRetrievalOptions,
): Promise<MemoryRetrievalResult> {
  void _task_id;
  return retrieveMemoriesForTask(memory, { task_query: task.spec }, options);
}
