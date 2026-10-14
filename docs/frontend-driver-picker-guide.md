# 前端接入指南：driver 探测与选择器

> 读者：Electron 前端的 driver 设置页 / 状态面板。目标是把「本机有哪些 coding agent、哪些**能被路由
> 执行**」显示正确、可刷新、可保存，并且不谎报。
>
> 字段级契约在别处，本文只讲**怎么用**：
> - `docs/driver-routing.md` —— 有效 driver 列表与路由（`driver-routing.v1`）的字段、错误码、CAS 语义；
> - `docs/frontend-driver-probe-api.md` —— 原始探测（`driver-probe.v1`）的字段。
>
> 本文内容按当前实现核对过（`src/rpc/driver-methods.ts`、`src/protocol/driver-routing.ts`、
> `src/driver/driver-probe-service.ts`）。

## 0. 心智模型：三条数据、两个通道

| 数据 | 方法 | 说的是什么 | 前端拿它做什么 |
| --- | --- | --- | --- |
| 原始探测结果 `DriverProbeResult` | `driver.list` / `driver.probe` | 「ACP 认为本机能拉起哪些 agent」，含启动命令与握手结果 | 诊断面板（可选）。**不要**拿它填选择器 |
| 有效 driver 列表 `snapshot.drivers[]` | `driver.getConfig` / `driver.refresh` | 「后端现在允许选哪些 driver」，每项带**后端算出的** `selectable` | 选择器的唯一数据源 |
| 路由映射 `snapshot.roles[]` | 同上 | 「哪个 role 用哪个 driver」 | role 表；保存时要回传的完整映射 |

三条边界，任何一条搞错都会写出「看起来对、用起来不对」的界面：

1. **探测到 ≠ 可选**：探测成功只说明 CLI 能被拉起并完成握手；要成为可选项还需要档案 + 进程里有
   runtime。
2. **可选 ≠ 能跑完一次 Run**：本机实测 gemini 探测通过却在认证处失败、codebuddy 起不来、
   opencode 探测到的是旧二进制——这些在列表里都是 `selectable: true` + `degraded`，这是**设计如此**。
3. **原始探测 ≠ 执行方式**：执行走 A 侧自己的 `${AGENT_ID}_CLI_COMMAND` / adapter 默认值，
   `driver.list` 返回的 `launch.command/args` 只用于诊断，前端不要展示、不要使用。

## 1. 方法一览

| 方法 | 参数 | 返回 | 何时调 | 代价 |
| --- | --- | --- | --- | --- |
| `driver.getConfig` | `{}`（必须为空对象） | `driver-routing.v1` 快照 | 首屏；保存后；收到 `-32021` 后重拉 | 便宜（读内存 + 与磁盘对齐） |
| `driver.refresh` | 下面那套 probe 参数 | `driver-routing.v1` 快照 | 用户点「刷新」 | **贵**：真起子进程探测，本机 6 个 agent 约 8 秒 |
| `driver.updateRouting` | `{expected_revision, default_driver, roles}` | 快照 | 保存 | 便宜（写文件 + 重载） |
| `driver.resetRouting` | `{expected_revision}` | 快照 | 「恢复默认」 | 便宜（删文件 + 重载） |
| `driver.list` / `driver.probe` | 同 `driver.refresh` | `driver-probe.v1` 原始探测 | 诊断面板 | 贵，同 refresh |

probe 参数（strict，出现未声明字段一律 `-32602`）：

```jsonc
{
  "agent_ids": ["claude", "codex"], // 可选；只探这些 agent
  "timeout_ms": 5000,               // 可选；1–120000，每个 agent 的等待上限（不传用 ACP 侧默认）
  "concurrency": 3,                 // 可选；1–32，探测并发
  "force": true                     // 可选；忽略 ACP 侧缓存，重新解析入口
}
```

`driver.list` 与 `driver.probe` 是同一个实现的两个名字，契约完全一致。

## 2. 返回结构（只列前端要用的）

### 2.1 `driver.getConfig` / `driver.refresh`

```jsonc
{
  "schema_version": "driver-routing.v1",
  "revision": "sha256:…",              // 下一次保存必须带回它
  "scope": "project",
  "default_driver": "acp-external",
  "drivers": [
    {
      "driver_id": "discovered:copilot-3ea125d0", // 以 discovered: 开头的是自动发现的
      "agent": "copilot",                          // 发给 A 侧的值，与 driver_id 不同是正常的
      "display_name": "GitHub Copilot CLI",        // 可选，只有探测到的才有
      "description": "GitHub Copilot CLI",         // 可选
      "selectable": true,                          // 后端算的，唯一的选择判据
      "status": "degraded",                        // configured | degraded | unavailable
      "reason_code": "AGENT_CLI_READINESS_NOT_VERIFIABLE", // status != configured 时才有
      "limitations": ["…"]                         // 可选，档案自报 + 探测证据
    }
  ],
  "roles": [
    { "role_id": "reviewer", "driver_id": "codex", "effective_driver_id": "codex",
      "source": "role_override", "known_role": true }   // source: default | role_override
  ],
  "orphan_roles": []                   // 是 roles 的子集：配置里写了、当前目录里没有的 role
}
```

`drivers` 与 `roles` 都按 id 的 UTF-16 升序稳定排序。**快照里没有**启动命令、凭据、runner 路径、
探测时间戳——schema 没有字段能承载它们，前端不需要也不应该去别处拼。

### 2.2 `driver.list` / `driver.probe`

```jsonc
{
  "schema_version": "driver-probe.v1",
  "generated_at": "2026-10-14T06:12:53.000Z",
  "drivers": [
    {
      "agentId": "claude",
      "displayName": "Claude Code",
      "launch": { "command": "node", "args": ["…"] },   // 诊断用，不要渲染给用户
      "provenance": "local-entry",                       // env-override | local-entry | path | npx-on-demand
      "connectionType": "acp",                           // acp | pty
      "initialize": { "protocolVersion": 1, "authMethods": 0, "agentVersion": "0.39.0" },
      "probedAt": "2026-10-14T06:12:51.633Z"
    }
  ]
}
```

`drivers` 只含**探测成功**的 agent。缺席不等于没装（握手失败、adapter 不认识安装路径、超时都不出现；
本机 kimi 就是有二进制但 adapter 不认识它的路径）。

## 3. 推荐流程

### 3.1 首屏

后端**启动时已经探测过一轮**，前端不需要自己触发探测：

```ts
const snapshot = await rpc('driver.getConfig', {});   // 一次调用就够
renderPicker(snapshot.drivers);                        // 选择器
renderRoleTable(snapshot.roles, snapshot.default_driver);
remember(snapshot.revision);                           // 保存时要用
```

选择控件（下拉 / 弹层）里只提供 `selectable: true` 的项；而 driver **列表视图**要保留全部条目，把
不可选的置灰并给出原因（见 §4）——让不可选项从列表里消失，会让已有的 role 映射看起来凭空指向一个
不存在的 driver。

### 3.2 用户点「刷新」

```ts
setBusy(true);                                  // 8 秒量级，必须给进度与禁用态
try {
  const snapshot = await rpc('driver.refresh', { force: true });
  replaceAllState(snapshot);                    // 用返回值整体替换本地状态，不要自己拼
  toast('已同步本机可用的 driver');
} catch (error) {
  keepPreviousState();                          // 刷新失败时列表仍是上一次的结果
  toast(mapRefreshError(error));                // 见 §5
} finally {
  setBusy(false);
}
```

刷新是**唯一**会改变 `drivers[]` 集合的操作（新增发现到的 agent、或把失联的标成 stale）。它**不会**
增删任何 role 映射，也不会改 `revision`。

### 3.3 保存路由

```ts
const next = {
  expected_revision: revision,                  // 从最近一次 getConfig/refresh 的返回值里拿
  default_driver: pickedDefault,
  roles: completeRoleMap(editedRoles),          // 必须是**完整**表，不是 patch
};
const snapshot = await rpc('driver.updateRouting', next);
replaceAllState(snapshot);
```

`roles` 要给完整映射：用 `snapshot.roles` 逐行取 `role_id → driver_id`，再叠加用户改动即可（安全且
幂等）。与 `default_driver` 相同的条目会被后端规范化剔除，回传不会引起 revision 无谓变化。只想改默认
driver 时也要回传完整表——传 `{}` 会把所有 role 的显式映射抹掉。

## 4. 渲染与文案规则

| 状态 | UI |
| --- | --- |
| `selectable: true`, `status: "configured"` | 可选，无提示 |
| `selectable: true`, `status: "degraded"` | **可选**。可附一句「未验证它能否跑完一次 Run」。**不要**渲染成故障 |
| `selectable: false` | 置灰，按 `reason_code` 给文案（见下表） |

`selectable: false` 时的 `reason_code`：

| reason_code | 文案建议 |
| --- | --- |
| `DRIVER_RUNTIME_NOT_CONFIGURED` | 配置里有这个档案，但当前进程没有它的运行时 |
| `DRIVER_RUNTIME_REGISTRATION_FAILED` | 运行时装配失败（细节见 `limitations`） |
| `DRIVER_DISCOVERY_STALE` | 本轮探测没有再发现它（历史自动 driver 的常态，条目**故意保留**） |
| `DRIVER_CONNECTION_TYPE_UNSUPPORTED` | 该 agent 的连接类型（如 `pty`）当前执行链不支持 |

几条硬规则：

- `selectable` 只信后端。不要从 `status`、`limitations` 文案、或者 `driver_id` 前缀去推断。
- 不可选择的条目**不要从列表里删掉**：删了会让已有的 role 映射变成悬空引用。置灰即可。
- `display_name` 只有探测到的 driver 才有；缺失时退回 `driver_id`，不要自己编。
- `orphan_roles` 要和 `roles` 一起渲染（同一批条目），它们的存在不阻碍保存，但保存时漏掉就会丢映射。
- `limitations` 是给人读的措辞（可能含中文），直接展示，不要解析。

## 5. 错误处理

| code | 场景 | 前端动作 |
| --- | --- | --- |
| `-32602` | 参数非法 / 带了未声明字段 | 代码 bug，按请求 schema 修 |
| `-32021` | 保存时 `expected_revision` 与磁盘不符 | 冲突：重拉 `getConfig`，保留用户编辑并提示，**不要**自动重放 |
| `-32022` | 引用了不存在的 driver | 用 `data.field` 定位控件 |
| `-32023` | 引用的 driver 不可选择 | 用 `data.field` + `data.reason_code` / `limitations` 给文案 |
| `-32024` | 读盘 / 写盘 / 重载失败 | 不是输入问题，把 `data.error_summary` 当诊断信息展示 |
| `-32025` | 想改 `default_driver` 但被 `NEWIDE_DRIVER` 部署锁定 | 把默认 driver 选择器设回 `data.locked_driver_id` |
| `-32026` | 等跨进程写锁超时 | 可重试，稍后重发同一请求 |
| `-32027` | ACP 探针模块缺失（runner 没构建 probe） | 提示重新构建 / 更新 ACP runner，**不是**「没装 agent」 |
| `-32028` | 探针执行失败 | 提示重试；列表仍是上一次的结果 |
| `-32029` | 自动发现文件写不进（权限等） | 本次刷新结果在重启后不会保留，如实提示 |
| `-32030` | 另一个进程正在写自动发现文件 | 可重试，稍后重发 |

`data` 里没有绝对路径、没有凭据。`-32024` / `-32026` 的 `data.path_category` 恒为 `"project_agent_dir"`。

## 6. 并发与生命周期

- **刷新不改 `revision`**：用户正在编辑映射时点刷新，不会让他手里的 `expected_revision` 失效。
- **并发刷新合并成一轮**：连点两次不会起两批探测子进程，两次调用拿到同一份结果。
- **运行中的 Run 不受保存与刷新影响**：Run 创建时冻结一份 routing 投影，之后该 Run 的所有解析都用
  这一份（含 council 的每个席位）。刷新只影响**之后**创建的 Run。
- **启动时的探测失败只降级**：那时后端照常起来，历史条目保留并标 `DRIVER_DISCOVERY_STALE`；
  而 `driver.refresh` 失败是**错误**——那说明用户按下去的动作没成功，必须提示重试。
- **多个后端实例共享同一 projectRoot** 时，配置写入与自动发现落盘都走 `.agent` 下的写锁；拿不到锁是
  `-32026` / `-32030`，都是「稍后重试」而不是失败。

## 7. 容易踩的坑

1. **拿 `driver.list` 的结果填选择器**：那份结果里没有 `selectable`，也没有「能不能执行」的信息。
2. **把 `degraded` 当作不可用**：默认形态就是 `degraded` + `AGENT_CLI_READINESS_NOT_VERIFIABLE`
   （本仓只能确认档案、runner 入口与凭据键，确认不了 A 侧 CLI 的安装与就绪）。
3. **自己算 `selectable` 或 `revision`**：两者都由后端算，前端只用返回值。
4. **刷新后自己拼状态**：用返回的快照整体替换，否则会出现「列表更新了、role 表还是旧的」。
5. **保存时只发改动过的那一条 role**：那是 patch 语义，后端要的是完整表。
6. **假设探测会变快**：不传 `force` 时 ACP 侧有缓存，但首次/强制探测是本机 8 秒量级，UI 要有进行中状态。
7. **把「探测缺席」读成「没装」**：握手失败、adapter 不认识路径、超时都不出现在结果里。
8. **把 `launch.command` / `args` 展示给用户**：那是 A 侧细节，NewIDE 执行时不使用它。
9. **依赖驱动条目的顺序**：按 id 升序是稳定排序，但 `discovered:` 条目的 id 带哈希后缀，不要按顺序
   做「第几个是默认」之类的判断，用 `default_driver`。
10. **在 UI 上把自动发现的条目做成可编辑档案**：`drivers.detected.local.yaml` 是后端维护的，用户要固定
    启动方式/凭据应写 `drivers.yaml` / `drivers.local.yaml`（本仓后端行为，前端只需在文案里说清）。

## 8. 本机实测期望值（便于自测与写用例）

- 探测一轮（`force: true`，6 个 agent，全 `local-entry` + 真握手）约 **8 秒**。
- 典型返回：`acp-external`（配置档，agent `claude`）+ 5 个 `discovered:`（codebuddy / codex / copilot /
  gemini / opencode），全部 `selectable: true` + `degraded`。
- 自动发现的 id 形如 `discovered:<规范化agentId>-<8 位 sha256>`，重启、重复探测、显示名变化都不产生
  新条目——可以放心当 key 持久化。
- 探针模块缺失时：`driver.list` 返回 `-32027`，`driver.refresh` 返回 `-32027`，而后端**照常启动**，
  `drivers[]` 里保留历史条目并标 stale。
