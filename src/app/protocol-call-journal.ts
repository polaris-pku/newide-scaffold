/**
 * ProtocolCallJournal — CallJournalPort 的 journal 落地实现（应用装配层）
 *
 * 职责边界：memory 只产出身份与结局字段，这里负责——
 * 1. 按 (task_id, workspace_path, role_id) 经 ParticipantSessionRegistry 解析真实
 *    Session，查不到（或事件不带 workspace / 注册表缺省）记 null，不新建 Session 表；
 * 2. 经唯一入口 store.withProtocolTransaction(tx => tx.appendCall(...)) 落行：
 *    kind='call'、causation_id 恒空、无 frame——principal 属帧装配职责，本实现不拼
 *    信封，随帧构造卡（#151 SAP 侧）落地；
 * 3. best-effort：缺 task_id/run_id（journal 外键前提，如 council 席位、
 *    `replay:${task}` 这类不在 runs 表的 run）、嵌套事务守卫、库锁等一律静默丢弃，
 *    绝不向调用方抛错——留档绝不打断业务路径。
 *
 * 与 audit/latency 的职责边界、seq 括号推断的成立条件见
 * src/memory/ports/call-journal.ts 文件头。
 */
import type { CallJournalEvent, CallJournalPort } from '../memory';
import type { ParticipantSessionRegistry } from '../coordination/participant-session-registry';
import type { ProtocolDeliveryStore } from '../persistence';

export interface ProtocolCallJournalOptions {
  /** 协议投递存储；只需事务入口（appendCall 挂在事务对象上） */
  store: Pick<ProtocolDeliveryStore, 'withProtocolTransaction'>;
  /** Session 绑定注册表；缺省时 session_id 恒 null */
  sessionRegistry?: ParticipantSessionRegistry;
}

export class ProtocolCallJournal implements CallJournalPort {
  constructor(private readonly options: ProtocolCallJournalOptions) {}

  record(event: CallJournalEvent): void {
    try {
      const runId = event.run_id;
      if (!event.task_id || !runId) return; // journal 外键前提不满足 → 丢弃
      // 先在事务外解析 Session：既避开 withProtocolTransaction 的嵌套守卫，
      // workspace 口径也与 facade 注册时一致（注册侧已 path.resolve 归一化）。
      const session_id =
        event.workspace_path && this.options.sessionRegistry
          ? (this.options.sessionRegistry.get(
              event.task_id,
              event.workspace_path,
              event.role_id,
            ) ?? null)
          : null;
      this.options.store.withProtocolTransaction((tx) =>
        tx.appendCall({
          task_id: event.task_id,
          run_id: runId,
          call_id: event.call_id,
          role_id: event.role_id,
          event: event.event,
          status: event.status,
          summary: event.summary,
          completed_at: event.completed_at,
          session_id,
          duration_ms: event.duration_ms,
        }),
      );
    } catch {
      // best-effort：FK 缺行 / 嵌套事务守卫 / DB 锁 —— 全部吞掉，不打断调用方
    }
  }
}
