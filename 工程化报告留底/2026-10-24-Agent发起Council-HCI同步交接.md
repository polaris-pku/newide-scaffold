# Agent 发起 Council：HCI 同步交接

本 PR 只交付 newide-scaffold 后端。HCI 仓库的界面、协议类型及内置后端更新由相关同学实施。本文件可直接转交，不代表已经完成桌面端集成验收。

## 启动参数

`task.create` 和 `run.create` 新增可选布尔字段 `allow_agent_council`，默认关闭。现有 `mode` 枚举不变。

| 界面选项 | mode | allow_agent_council |
| --- | --- | --- |
| Solo | single_agent | false 或省略 |
| Solo，允许发起 Council | single_agent | true |
| 直接 Council | council | false 或省略 |

不要把 `single_agent_with_council` 当作新的后端 mode 值。它可以是前端本地选项，提交前必须映射成上述两字段。

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "task.create",
  "params": {
    "spec": "实现需求，必要时进行独立方案比较",
    "completion_criteria": ["验证并交付结果"],
    "workspace_path": "/absolute/path/to/project",
    "mode": "single_agent",
    "allow_agent_council": true
  }
}
```

## 后端行为与状态

- 顶层 Agent 在允许升级的 Solo 执行中获得 `invoke_council({reason?: string})`，可在 Driver 执行前或得到结果后调用。
- 默认 Solo 不展示该工具；handler 同时校验权限。Council 参与者不允许递归发起 Council。
- 调用结束当前 Solo 阶段，Coordinator 在原 Task/Run 上进入 Council，触发原因是 `agent_request`。这不是创建一个新任务，也不需要前端额外调用 `task.startCouncil`。
- 原运行的 mode 仍表示启动方式；不能仅凭 `mode === council` 判断当前是否正在合议。应使用 TaskSnapshot 的 Council 状态及后端事件/游标。
- `council.started` 携带 trigger 和本次 `council_request` 原因；后续继续使用现有 Council 生命周期、Gate 和 Deliver 事件。
- `TaskSnapshot.task.allow_agent_council` 是可选布尔字段。开关写入请求和持久化运行状态，恢复时保留。未提供字段按关闭处理。
- Solo 中间结果仅作为证据，Council 重新生成正式提案。现有 classic/adaptive_lead/plan_first 策略继续生效；不会因调用工具自动授权合并。

## HCI 同学实施清单

1. 在任务创建请求类型和 TaskSnapshot.task 类型中增加可选字段 `allow_agent_council?: boolean`。
2. 新建任务显示三种选项，按表格提交。默认 Solo；重置表单时一并重置开关，避免下一次任务继承选择。
3. 两种需要 Council 的选项都应检查 `council.execute` 能力（available/degraded 可选），不可用时显示原因。
4. 将参数贯穿创建任务的 store/API，避免解构或字段白名单丢失开关。保留现有订阅、快照重载、事件去重与排序逻辑。
5. 后端 PR 合并后，更新 `packages/newide-bcd` 对应源码并重建 backend bundle；保留 HCI 仓库独有的 workspace/Mailbox 修复，不要整目录覆盖。
6. 验收三种启动请求；确认普通 Solo 不升级、允许模式能自动进入 Council、直接 Council 维持原流程。补测中断恢复、最终产物交付和 Council 不可用提示。

## 验证边界

后端确定性测试已覆盖开关透传、默认关闭、Driver 前/后升级、禁止递归、持久化重建，以及 Plan-first 升级后的提案、评审、综合、实现、Gate、文件交付。全量回归记录为 2672 passed / 44 skipped；最后的会话修正另跑生产阶段测试通过。lint、typecheck、CLI build 通过。

尚未执行真实外部模型 Council 验收。HCI 的实际同步、桌面端联调和安装包验收由接入同学完成。

此前本地曾修改 HCI 同名功能分支并重建本地 bundle，未提交、未推送；用户明确要求后已停止操作该仓库。本 PR 不包含这些文件或声称 HCI 已交付。
