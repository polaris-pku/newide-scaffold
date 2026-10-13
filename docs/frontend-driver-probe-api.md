# 前端 Driver 探测接口

后端启动时把 ACP runner 的 `dist/src/driver-adapter/probe.js` 接入 JSON-RPC。前端可以调用
`driver.list` 探测本机当前可启动的 ACP driver：

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

如果 ACP runner 没有随新版本构建探针模块，接口返回 JSON-RPC `-32027`
（`DRIVER_PROBE_UNAVAILABLE`），前端应提示用户重新构建/更新 ACP runner。
探针进程启动失败或返回内容不符合 ACP 契约时返回 `-32028`
（`DRIVER_PROBE_FAILED`），前端可以提示重试。
