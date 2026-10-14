# 前端 Driver 探测接口

后端启动时把 ACP runner 的 `dist/src/driver-adapter/probe.js` 接入 JSON-RPC。探测回答的是
「本机能拉起哪些 A 侧 agent」，它与「哪些 driver 现在可以被路由执行」是**两件事**，所以有
两条不同的通道：

| 方法 | 返回 | 用途 |
| --- | --- | --- |
| `driver.list` / `driver.probe` | ACP 原始探测结果 `DriverProbeResult` | 诊断用：看 ACP 解析出了哪些 adapter、启动方式来自哪里 |
| `driver.refresh` | 有效 driver 列表 `DriverRoutingSnapshot` | 产品用：让 driver 选择器同步到本机现状 |

## 1. 原始探测：`driver.list` / `driver.probe`

```json
{"jsonrpc":"2.0","id":1,"method":"driver.list","params":{
  "force":true,
  "timeout_ms":5000,
  "concurrency":3
}}
```

成功结果是：

```json
{
  "schema_version":"driver-probe.v1",
  "generated_at":"2026-10-13T00:00:00.000Z",
  "drivers":[
    {
      "agentId":"claude",
      "displayName":"Claude Code",
      "launch":{"command":"node","args":["..."]},
      "provenance":"local-entry",
      "connectionType":"acp",
      "initialize":{"protocolVersion":1,"authMethods":0},
      "probedAt":"2026-10-13T00:00:00.000Z"
    }
  ]
}
```

`drivers` 只包含 ACP 探测成功的 driver；ACP 的探针负责 adapter 注册表、命令来源、
initialize 握手、缓存和子进程清理。`driver.probe` 是同一接口的显式别名。

参数均可省略。`agent_ids` 可限制探测范围，`timeout_ms` 范围为 1–120000，
`concurrency` 范围为 1–32，`force` 会忽略 ACP 探针缓存并重新解析入口。

**这个结果不进入 driver 选择器**：`launch.command/args` 描述的是 A 侧自己的启动细节，
NewIDE 执行时不使用它（执行走 runner 的 `${AGENT_ID}_CLI_COMMAND` / adapter 默认值）。
探测成功只说明「这个 agent 在这台机器上能被拉起」。

如果 ACP runner 没有随新版本构建探针模块，接口返回 JSON-RPC `-32027`
（`DRIVER_PROBE_UNAVAILABLE`），前端应提示用户重新构建/更新 ACP runner。
探针进程启动失败或返回内容不符合 ACP 契约时返回 `-32028`
（`DRIVER_PROBE_FAILED`），前端可以提示重试。

## 2. 同步有效列表：`driver.refresh`

```json
{"jsonrpc":"2.0","id":1,"method":"driver.refresh","params":{
  "force":true,
  "timeout_ms":5000,
  "concurrency":3
}}
```

参数与 `driver.list` **完全同构**（同一套 strict schema：`agent_ids` / `timeout_ms` /
`concurrency` / `force`），但返回的是 `driver-routing.v1` 快照 —— 与 `driver.getConfig`
同一个结构，见 `docs/driver-routing.md`。

后端对一次刷新的完整动作是：

1. 探测一轮（并发调用会合并成一轮，不会起两批子进程）；
2. 把发现结果合并进 driver catalog；
3. 把「探测到但没有配置档案」的 agent 写成最小自动 profile，落在
   `<projectRoot>/.agent/drivers.detected.local.yaml`（该文件由后端维护，请勿手工编辑）；
4. 为它们注册 runtime；
5. 返回最新的 routing 快照。

因此刷新之后必须**用返回的 snapshot 整体替换前端状态**，不要自己拼。

错误映射：

| 情况 | code |
| --- | --- |
| ACP 探针模块缺失 | `-32027` `DRIVER_PROBE_UNAVAILABLE` |
| 探针执行失败 | `-32028` `DRIVER_PROBE_FAILED` |
| 自动 profile 落盘失败 | `-32029` `DRIVER_DISCOVERY_PERSIST_FAILED` |
| 另一个进程正在写自动发现文件 | `-32030` `DRIVER_DISCOVERY_LOCK_BUSY`（可重试） |

探测失败时**历史 driver 不会被删除**，只是在快照里变成 `selectable: false` 并带原因码
`DRIVER_DISCOVERY_STALE`；前端照常渲染列表，把不可选项置灰即可。

刷新只影响**之后创建**的 Run：已经跑起来的 Run 在创建时冻结了自己的 driver 映射。
