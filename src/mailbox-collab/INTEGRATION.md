# mailbox-collab 接入状态

> **状态：已合入仓库，未接入生产，未参与构建。**
>
> 本目录代码与原始提交 `6c94d3c` **逐字节一致**，未做任何修改。
> 编译、lint、测试均已显式排除，见本文末尾"排除配置"。
>
> 本文件由主线维护者添加，不属于原作者交付内容。

## 来源

| 项 | 值 |
|---|---|
| 分支 | `feat/mailbox-collaboration` |
| Commit | `6c94d3c` feat: mailbox collaboration v0 |
| 作者 | Capitain \<2300013187@pku.stu.edu.cn\> |
| 日期 | 2026-07-26 |
| 分叉基线 | `65ecf96` |
| 合入方式 | `git merge`，零冲突（1402 insertions / 0 deletions） |

合入时对主线共享代码的唯一改动是 `src/core/event.ts` **+6 行**，
向 `EventType` union 追加 6 个 mailbox 事件名。该 union 原本就有 `| (string & {})`
兜底，因此这 6 行是补全提示，语义无侵入，已随 merge 保留。

## 为什么合入但不接入

### 1. 架构方向需按审计计划收敛

`工程化报告留底/2026-7-27-current-project-audit/00-技术债务收敛总路线.md` 5.2 节
将本分支判为 `blocked`，明确列出不能带入生产的部分：

- 第二套 `persisted_mailbox_messages` / `persisted_mailbox_deliveries` 表
- 第二套 `mailbox.send/inbox/ack/reply` RPC
- 内存 event side-path
- 只递增 `retry_count`、不真正唤醒执行器的"重试"
- 不属于当前 delivery 状态机的 `blocked` / `failed` / `waiting_input`

主线已有持久化 Mailbox（`MailboxStateStore` / `SqliteCoordinationStore` /
`PersistentMailboxService` / `MailboxRpcMethods`）。本模块是在其旁边另建
`MailboxServiceEnhanced` 包装层 + 独立 timeout 表 + 独立 event emitter，
直接接入会加深审计中"Mailbox 双轨"这条技术债务。

### 2. 对当前主线存在 API 漂移

按 `65ecf96` 编写，与当前 HEAD 不兼容。`tsc --noEmit` 实测 20 处错误，
全部集中在本目录，**均为机械性适配，不涉及算法或架构逻辑**：

| 文件 | 问题 | 主线现状 |
|---|---|---|
| `agent-mailbox-tool.ts`<br>`mailbox-service-enhanced.ts`<br>`mailbox-tool-rpc-methods.ts` | 从 `../persistence` 导入 `MailboxReplyInput` / `MailboxSendInput` | 两者存在，但在 `../app/persistent-mailbox-service` |
| `mailbox-event-types.ts` | 从 `../core` 导入 `DeliveryId` | 不存在；主线 `delivery_id` 用裸 `string` |
| `mailbox-event-handler.ts`<br>`coordinator-mailbox-integration.ts` | 从 `../coordinator/event-store` 导入 `EventStore` 接口 | 只有具体类 `InMemoryEventStore`，无同名接口 |
| `coordinator-mailbox-integration.ts` | `NodeJS.Timer` 与 `clearInterval` 签名不匹配；`exactOptionalPropertyTypes` 违规 | 应为 `ReturnType<typeof setInterval>` |
| `mailbox-service-enhanced.ts` | 读 `PersistedMailboxDelivery.requires_ack` | 该字段在 `PersistedMailboxMessage` 上，不在 delivery 上 |
| `mailbox-service-enhanced.ts` | `eventEmitter` 可选属性赋值 | `exactOptionalPropertyTypes: true` 需显式 `\| undefined` |
| `mailbox-tool-rpc-methods.ts` | `inbox(recipient, limit)` 第二参传数字 | 主线签名为 `inbox(recipient, afterDeliveryId?: string)`，是游标不是条数 |
| `sqlite-mailbox-timeout-store.ts`<br>`examples.ts` | 依赖 `better-sqlite3` | 主线用 `node:sqlite` 的 `DatabaseSync` |
| `examples.ts` | 相对路径整体错一层（`../../app/...`、`../index`） | 应为 `../app/...`、`./index` |

其中 `inbox` 的 limit/cursor 混淆和 `requires_ack` 的归属是**真实语义差异**，
接入时需要决策，不能机械改签名了事。

## 有效的设计输入

以下四个语义是正确的，应在主线现有 Mailbox 基础设施上实现：

1. **thread 内协作** — 用 `thread_id` 串起多轮 send/reply
2. **delivery deadline** — `deadline_at` 可判定超时
3. **timeout / retry / wake** — 重试必须把 delivery 放回可领取队列并真正唤醒
   task runner，不能只递增计数器
4. **等待消息的任务进入阻塞态** — 对应主线 cursor `mailbox_wait`

`README.md` 中的 6 个事件命名（`mailbox.sent` / `delivery_read` / `delivery_acked` /
`delivery_replied` / `delivery_timeout` / `delivery_failed`）可直接沿用，
已随 merge 进入 `src/core/event.ts` 的 `EventType`。

## 接入路径

对应审计计划 `02-可信执行-Checkpoint-Mailbox-实施计划.md` **Task 4**：

- [ ] 扩展现有 `messages` / `deliveries` 表，**不新建第二套表**
- [ ] envelope/delivery 增加 `task_id`、`run_id`、`thread_id`、`attempt`、
      `available_at`、`deadline_at`
- [ ] 状态机固定为 `pending -> delivering -> delivered -> acknowledged`；
      timeout/retry 是 transition + event，不新造无实现状态
- [ ] retry 把 delivery 放回可领取队列并真正 wake task runner；
      达上限进 terminal dead-letter
- [ ] RPC 继续用现有 `mailbox.send/inbox/ack/reply`，仅向后兼容地扩字段
- [ ] 决策 `inbox` 分页语义：保留游标，还是同时支持 limit
- [ ] 决策 `requires_ack` 读取路径：从 envelope 的 message 侧取
- [ ] 重启验收：发 `requires_ack` 消息 → 关 backend → 重启后 inbox 可见 →
      ack/reply 状态延续

改动应落在主线文件，**不在本目录**：

```
src/persistence/mailbox-state-store.ts
src/persistence/sqlite-coordination-store.ts
src/app/persistent-mailbox-service.ts
src/rpc/mailbox-methods.ts
```

Task 4 完成后删除本目录及 `test/mailbox-collab/`，并移除下述排除配置。

## 排除配置

| 文件 | 排除项 |
|---|---|
| `tsconfig.json` | `exclude: ["src/mailbox-collab/**"]` |
| `eslint.config.js` | `ignores: [..., 'src/mailbox-collab/**', 'test/mailbox-collab/**']` |
| `vitest.config.ts` | `exclude: [..., 'test/mailbox-collab/**']` |

排除是为了让代码以原样进入仓库历史、保持 diff 可审，同时不破坏 `pnpm build` /
`pnpm verify`。这不是长期状态。

## 相关

同批整合的 checkpoint/resume core 走的是另一条路径：那部分是新文件、无冲突、
且能编译，已直接进 `src/checkpoint/` 并接入 `TaskProcessor`（commit `68172fc`）。
两者处理方式不同的原因就是本文第 2 节的 API 漂移。
