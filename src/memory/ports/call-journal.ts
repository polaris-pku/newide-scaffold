/**
 * CallJournalPort 端口
 *
 * 进程内调用（memory_query / extract）完成时的单点留档出口：调用**收尾时**记一行
 * 结局，成功与失败都记。调用行无状态要同步，不进因果图（causation 恒空、不带
 * frame），行 id 即调用标识。memory 只产出身份与结局字段；Session 解析与 journal
 * 持久化由应用层实现负责（src/app 的 ProtocolCallJournal）。
 *
 * 与既有观测面的职责边界（互不替代）：
 * - telemetry 流水（withRunLatencySpan → latency.jsonl）：按轮次/工具记耗时，
 *   进程内、尽力而为、无身份账本语义，可丢；
 * - 本端口 → 协议 journal（协议设计 §7.5：INSERT-only、全局 seq 全序）：按
 *   task/run/role 可定位真实角色与 Session，持久、可跨 run 对账；与逐 run 的
 *   audit.jsonl（run-audit-writer）是另一本账，互不覆盖。
 *
 * 并发下 seq 括号推断触发节点的适用条件：call 行在调用完成时单点 append；父触发
 * 节点取「同 task/run/role 过滤后、该行之前最近的协议行」。成立依赖同一 role 的
 * 执行被 facade `role:<roleId>` 队列、maintenance 被 runner roleQueues 串行化；
 * 跨 role/跨 task 的行在全局 seq 上交错，但按 (task_id, run_id, role_id) 过滤后
 * 括号仍唯一。
 *
 * principal（信封 {kind, role_id}）由 System/应用装配在构造协议帧时注入——call 行
 * 不携带帧，principal 注入随帧构造卡（#151 SAP 侧）落地，不在本端口范围。
 *
 * 契约：record 必须同步、不抛错；实现方对不满足持久化前提（缺 task_id/run_id、
 * 外键缺行、嵌套事务）的事件静默丢弃，留档绝不打断调用方业务路径。
 */

/** 进程内调用结局事件（memory → 应用层留档的唯一载荷） */
export interface CallJournalEvent {
  /** 调用标识：LLM 工具调用即 tool_call_id；extract 由 role/seq/时刻派生（每次尝试唯一） */
  call_id: string;
  /** 事件名：memory_query（工具检索）| extract（buffer 经验提取） */
  event: 'memory_query' | 'extract';
  /** 任务标识（journal 外键前提；缺失时实现方丢弃，上报方也不发） */
  task_id: string;
  /** 运行标识（journal 外键前提；缺失时实现方丢弃） */
  run_id?: string | undefined;
  /** 发起调用的角色 */
  role_id: string;
  /** 工作区绝对路径（Session 绑定键之一；缺失时 session 记 null） */
  workspace_path?: string | undefined;
  /** 调用结局 */
  status: 'ok' | 'error';
  /** 结果摘要或错误信息（上报方截断 ≤300 字符） */
  summary: string;
  /** 调用耗时（毫秒，wall clock） */
  duration_ms: number;
  /** 完成时刻（ISO 8601） */
  completed_at: string;
}

/** 进程内调用留档端口：调用完成（成功与失败）时单点上报；实现必须同步且不抛错。 */
export interface CallJournalPort {
  record(event: CallJournalEvent): void;
}
