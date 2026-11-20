# src/driver — Driver 运行时与 ADP 接入(A1 / issue #149)

本模块负责外部 ACP Driver 的调用链(transport → runtime → invoker → return
converter),以及 **ADP(Agent-Driver Protocol)v1 的 System 内代理 endpoint**:
把每次驱动调用包装成 `driver.invoke` / `driver.cancel` / `driver.invocation_result`
协议 exchange,落实副作用与结果未知语义。协议契约以 P0(`src/core/protocol-adp.ts`

- `fixtures/protocol`)为唯一权威,投递底座复用 P1(`src/persistence`
  `ProtocolDeliveryStore`),本模块不复制任何 schema 或存储实现。

## ADP endpoint 组成

| 文件                        | 职责                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adp-driver-endpoint.ts`    | invoke/result/cancel 的 exchange 生命周期:帧构造(P0 校验)、P1 落账、判重、回执经宿主内回调交还 Agent                                                                                                                                                                                                                                                          |
| `adp-status-mapping.ts`     | 驱动结局 → ADP status 的证据化映射(纯函数)。阶段 2 role 引擎的派工观察**复用本映射**（`mapAdpOutcome`），不维护第二套语义：`DRIVER_OUTCOME_UNKNOWN` / `EXTERNAL_DRIVER_TRANSPORT_ERROR` / `DRIVER_RUNTIME_INVOKER_ERROR` 等保持 unknown，interrupted + 副作用保持 unknown，启动失败才是 failed+not_executed；`isDriverEffectEvent` 供 role 侧识别副作用证据。 |
| `adp-invocation-state.ts`   | 单次 exchange 的状态机与证据模型(dispatched / 副作用活动 / transport 阶段证据)                                                                                                                                                                                                                                                                                |
| `adp-retry-policy.ts`       | 部署级 `auto_retry[side_effect]` 读取与判定                                                                                                                                                                                                                                                                                                                   |
| `driver-transport-error.ts` | 传输层失败的阶段证据载体(`not_executed` / `execution_unconfirmed`)                                                                                                                                                                                                                                                                                            |

## 状态映射(与 P0 冻结枚举同版)

| 结局                                   | 证据条件                    | ADP status                           | 自动重跑                     |
| -------------------------------------- | --------------------------- | ------------------------------------ | ---------------------------- |
| 启动失败(spawn 失败、dispatch 前抛错)  | 明确证据:从未执行           | `failed`(code=`DRIVER_START_FAILED`) | 看 `auto_retry[side_effect]` |
| `DriverRunResult` `succeeded`          | 确定                        | `succeeded`                          | —                            |
| `DriverRunResult` `failed`(业务码)     | 确定失败                    | `failed`                             | 看 `auto_retry[side_effect]` |
| `DriverRunResult` `cancelled`          | 驱动确认取消生效            | `cancelled`                          | 否                           |
| `DriverRunResult` `interrupted`        | 无副作用活动 / 有副作用活动 | `cancelled` / `unknown`              | 否 / 永不                    |
| 断连、超时、传输错误(dispatch 后)      | 无法确认执行或副作用状态    | `unknown`                            | **永不**                     |
| 取消生效(明确未执行)/ 取消后副作用不明 | —                           | `cancelled` / `unknown`              | 否 / 永不                    |

判定原则:**只有明确证据(状态机停在 `dispatched` 之前,或 transport 报出
`not_executed`)才能判「未执行」**;无法确认执行或副作用状态时一律 `unknown`。
未类型化的传输错误保守按「执行状态不明」处理。

## 重试语义与配置

- `unknown` **永不自动重跑**(协议语义,配置也压不过它);`cancelled` / `succeeded`
  同样不重跑。
- `failed` 的自动重跑只看部署级 `auto_retry[side_effect]`,按 invoke 帧携带的
  `side_effect`(`read_only | workspace_write | external`)分档:

  ```bash
  NEWIDE_ADP_AUTO_RETRY_READ_ONLY=false
  NEWIDE_ADP_AUTO_RETRY_WORKSPACE_WRITE=false
  NEWIDE_ADP_AUTO_RETRY_EXTERNAL=false
  ```

  缺省全 false(保守)。策略重试在同一 exchange 内重新执行,每次执行记
  `driver.invoke_attempt` 调用行(调用不进因果图),回执只发一次。

- `error.retryable` **仅是提示字段**,不驱动任何重试。
- **部署配置绝不进入协议帧**:P0 schema `.strict()` 会拒收 `auto_retry` 等多余键。

## 判重、对账与回执

- **重复 exchange**:同一 `exchange_id` 重复 invoke 返回既有状态/结果(执行中
  返回 `in_flight`),绝不重复启动副作用。
- **崩溃恢复对账**(进程内 registry 缺失但 P1 有记录):从未投递 → 明确未执行 →
  收束 `failed`;已投递无回执 → 执行状态不明 → 收束 `unknown`;已有回执 → 原样
  返回。均为对账收束,不启动任何副作用。
- **迟到结果**:`unknown` 收束后迟到的真实结果只补记 `driver.invocation_late_result`
  调用行,不改已发回执、不触发重跑。
- **回执交还**:收束后经 `onReceipt` 宿主内回调交还 Agent(该步不是 SAP 消息);
  invoke 的 `causation_id` 指向外层 SAP execute(无则 `null`),宿主调用意图以
  `host.intent` 调用行单独留档、`causation` 恒空。
- **取消**:目标 invoke 的终态回执(`cancelled`/`unknown`)即取消的对账结果,
  `driver.cancel` 不单独发回执帧,其 outbox 停在 `sent` 不重投(设计稿 §7.1)。
- **降级**:P1 落账不可用(如 task/run 行缺失)时降级为进程内记账
  (`journal_degraded: true`),留档绝不打断业务路径。

## 装配

- `DriverRuntimeAgentExecutionFacade` 的 `adp` 选项开启后,`invoke_driver` 走
  ADP endpoint;缺省保持历史行为。生产装配点:`src/app/backend-rpc-stdio.ts`。
- 历史的「artifact-free retryable 重试」(按 `error.retryable` 启发式)只保留在
  非 ADP 路径;ADP 路径的重试语义完全由 `auto_retry[side_effect]` 支配。

## Driver 档案、自动发现与路由

「有哪些 driver、每个 driver 是什么、哪个 role 用哪个」这一半由下面几个文件承担，与上面的
ADP 调用链是两条独立的关注点：

| 文件                                         | 职责                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `profile.ts`                                 | 档案与配置的模型（zod 单一来源），`resolveRoleDriver` 是「role → driver」的唯一取值入口                                |
| `profile-loader.ts`                          | 分层加载：内置 → 用户级 → 用户本地 → 项目级 → 项目本地 → **自动发现层** → UI routing 层，最后叠 env 覆盖（env 永远赢） |
| `driver-discovery-catalog.ts`                | 探测事实的唯一出口：稳定身份、合并规则、stale 判定、runtime 注册结果                                                   |
| `driver-discovery-file-store.ts`             | 自动 profile 与 discovery state 的原子落盘（`.agent` 锁 + 临时文件 + fsync + rename）                                  |
| `driver-discovery-service.ts`                | 编排「探测 → 合并 → 落盘 → 注册」，并对并发刷新去重                                                                    |
| `driver-registry.ts`                         | 档案 → runtime 句柄；手工档案 fail-fast，自动发现走可捕获失败的动态注册                                                |
| `driver-routing-service.ts`                  | 有效映射、revision/CAS、Run 冻结快照、可选择性投影                                                                     |
| `agent-dir-lock.ts` / `atomic-file-write.ts` | 上面两个存储层共用的 `.agent` 目录锁与原子写                                                                           |

边界（改动前先读这几条）：

- **`src/app` 之外不碰文件系统以外的装配**：模块只提供纯逻辑与存储适配，`backend-rpc-stdio.ts`
  负责顺序——探测 → 落盘 → `loadDriverConfig` → registry → routing → system status。顺序反了
  会让 registry 与 routing 各执一份真相。
- **配置事实与探测事实分权**：`loadManualDriverConfig()` 给出「用户配了什么」（自动发现层与
  UI routing 层都不算），catalog 给出「本机探测到了什么」，registry 给出「执行事实」。任何一处
  都不许拿另一处的结论冒充自己的。它是一份**残缺层集**的投影，因此只做形状校验：UI 里选中的
  `discovered:` driver 由被排除的那一层提供，对它做全量引用校验会把「用户存下的选择」误判成
  配置错误。
- **两类 driver 的失败语义不同**：手工档案装配失败 = 启动失败（用户要立刻知道）；自动发现的
  失败 = 那个 driver 不可选择（记录原因码）。共用同一套装配代码，差别只在失败的处理方式。
- **敏感信息不出模块**：`DriverProbe.launch`（启动命令、参数）只用于探测诊断，不写进自动 profile、
  不进 routing 快照、不进 discovery state。前端能看到的是 driver_id / agent / 可选择性 / 原因码。

## 执行契约、写屏障与回执对账（阶段 1，未接生产 role-loop）

role/driver 职责完善：让每次派工有身份、有证据、有可对账状态。
阶段 2 的 role-loop 已在**显式 `NEWIDE_ROLE_AUTONOMY=1`** 时由组合根使用；默认运行路径不变。

| 文件                             | 职责                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execution-contract.ts`          | Brief / Evidence / Journal 行 / `DispatchRecord` 的**唯一 zod schema 来源**：宿主身份（`dispatch_id`/`task_id`/`run_id`/`role_id`/sequence/`accepted_at`）只能由 `buildExecutionBrief` 填；role 请求 `.strict()` 拒收身份键；`investigate` 强制只读、`execute` 非只读、`verify` 显式声明；`reuse` 必须命中宿主确认的本 role/run Session。Evidence 的 transport 是两个正交字段 `transport.evidence`（`not_executed \| execution_unconfirmed`）+ `transport.result_received`（布尔），**不能互相推导**：`result_received` 表示**是否收到过 `DriverRunResult`**，不等于「结局已确认」——driver 返回 failed + `EXTERNAL_DRIVER_TRANSPORT_ERROR` 时 ADP 结局是 `unknown`，但 result 确实收到，因此 `unknown + true + execution_unconfirmed` 合法；启动失败才是 `failed + false + not_executed`。旧数据缺该事实时用 `transport.result_received_missing: true` 显式表达缺失。真矛盾（result 与 not_executed、succeeded 却无结果、missing 又声称收到）抛 `evidence_inconsistent`。`unknown` 的副作用不确定语义不变、禁止自动重放、不得改写成 failed。宿主 `status_override` 只能把成功降级（如只读违规），不改写原始 receipt/result 事实。runner 退出码只进 transport，不能冒充 `checks[].exit_code`；usage 缺失记 `missing: true`/`source: 'none'`，不填 0。 |
| `command-observation.ts`         | 阶段 2 复审修复：**受支持 Driver 的命令级观察事件协议** `driver.command_observed`（strict schema：`command`/`exit_code`/`stdout`/`stderr`/`truncated`/`target_paths`/`checked_workspace_sha256`/`observed_at`）。driver runtime 的命令执行端在命令结束时经 `NEWIDE_DRIVER_EVENT` 通道上报；host 只据此生成 `host_observed + complete + exit_code` 的检查证据（原始输出写受控 evidence 文件、hash 绑定）。**最新复审：受支持 Driver 必须在命令结束、交还 agent 控制权之前计算工作区 canonical 内容指纹（与宿主 `hashWorkspaceContent` 同一算法）并随事件上报；宿主在收到事件时独立重算同一指纹比对，只把校验通过的指纹写成检查的 `workspace_sha256`。** 事件接收时刻的快照不能直接当被检查版本，driver 自报 hash 也不能未经校验直接信任；缺失/截断/不一致 → `observation=partial`（明确证据缺口），finish 不会把它当通过。driver 自述与 runner 进程退出码都不能冒充；没有该事件的 Driver 是明确的证据缺口，真实 ACP runner 仍是该证据缺口（不是假通过）。                                                                                                                                                                                                                                                                                             |
| `abortable-driver-run.ts`        | 可中止的 driver 调用包装：abort 时**同步 reject** 并 fire-and-forget 发出 `driver.interrupt`，不再等待 `interrupt` 返回（它可能永不返回）；interrupt 的同步抛错/迟到 settle 都被消费，不阻塞宿主超时收束、不产生未处理 rejection。abort 后底层 `sendPrompt` 的迟到真实结果经 `onLateResult` 交还上层对账（不改变中止结局）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `dispatch-attempt.ts`            | 阶段 1 写屏障：`accepted durable → dispatched durable → 调用 driver → evidence durable → settled durable → 返回`。accepted/dispatched 写失败**不调用 driver**；evidence/settled 写失败抛 `DispatchJournalBarrierError`（`driver_invoked` + `side_effect_state`），调用方不得继续或成功返回；一次 dispatch 一次 attempt；只读派工产生工作区改动时通过 `status_override` 降级为 failed（violation 入账、不回滚副作用），返回/evidence/settled/恢复折叠状态一致。只依赖 `DispatchJournalPort` 抽象，不 import persistence 运行时。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `adp-receipt-reconciler.ts`      | 把 ADP `AdpReceiptDelivery` / 迟到结果对账进 Dispatch Journal：receipt status 权威（经 `adp_receipt` 传给 `buildExecutionEvidence`），只追加 `reconciled` 行，**绝不执行 driver**；重复 receipt 幂等；已 settled 的可信终态冲突时 fail closed、不改写；`unknown` 可被迟到可信结果升级；把 `result_received` 与旧数据 `result_received_missing` 原样带入 evidence；journal 写失败向上抛（不吞）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `adp-driver-endpoint.ts`（增量） | 回执有两个明确分工的回调：`request.onReceipt`（per-invoke **通知**，同步 fire-and-forget）与 `request.onReceiptReconciled`（per-invoke **写屏障/对账**：invoke 必须 await，失败以 `AdpReceiptReconciliationError` 从 invoke 抛出）；首次 settle 与已 settled 判重重放/崩溃恢复两条路径遵守同一完成条件，重放不重执行。**settle 时把 `result_received`/`transport_evidence` 等阶段证据作为 `driver.invocation_evidence` 调用行持久化**，重启回放优先读该事实，不再从 receipt.status 反推；旧数据缺该行时按回执做有依据的保守回退并标记 `result_received_missing`。可选 `options.lateResultObserver` 允许异步，其 Promise 被跟踪、不产生未处理 rejection，由 `flushLateResultObservers()` 等待并重抛。未提供这些回调时行为与基线一致（生产当前未提供）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

边界：

- `JournalVerificationClaimSchema` 同时定义工具输入与 finish 持久化的验证陈述字段；app 只添加
  输入默认值，persistence 引用派生类型，不再各维护一份字段表。- 契约 schema 是单一来源；persistence 的 journal 只做文件 I/O 与折叠，不复制 schema；实例内
  所有修改经**单一串行临界区**执行，`close()` 排空已准入修改后才释放写锁（生命周期与锁协议见
  `src/persistence/README.md`）。
- `DispatchRecord` 折叠显式区分 `not_executed`（accepted 无 dispatched、无交付证据）与
  `unknown`（dispatched 无 settled/可信 receipt）；可信 ADP receipt 优先于本地猜测。
- 迟到结果只能对账，不能触发新执行或悄悄改写已发出的终态回执。
- 阶段 1 边界：本阶段不新增 role-loop、不新增 Agent 工具、不改变任何生产选路；阶段 2 已另行在
  `src/app` 接入（默认关闭，仅显式 `NEWIDE_ROLE_AUTONOMY=1`）。

## evidence-only 派工分支（阶段 3，默认关闭）

`driver-runtime-invoker.ts` 的 `DriverRuntimeInvokerInput.report_mode` 是唯一分叉点：

- `six_field`（默认）：行为与历史一致——prompt 追加六字段报告 + 报告文件指令（受
  `ACP_WRITE_REPORT_FILE` 控制），结果经 `DriverReturnConverter` 转成 `DriverReturn`；
  legacy/Council 路径全部走这一支。
- `evidence_only`（role 自主循环、`NEWIDE_DRIVER_EVIDENCE_ONLY=1`）：prompt **只给本次
  ExecutionBrief**（不含整批 skills/experiences 渲染、不含六字段/报告文件指令），不调用
  converter，`DriverRuntimeInvocationResult.report` 缺席（不伪造空报告）。执行事实由阶段 1
  Journal/evidence 记录，Role 的验证陈述与来源分级在 `src/app/role-learning-input.ts`。

`report` 缺席只可能来自 evidence-only；legacy 消费者（facade `invoke_driver`、ADP endpoint）
在缺席时显式失败，不会拿空壳当报告。测试：`test/driver/driver-runtime-invoker-evidence-only.test.ts`。

## 阶段 1：Run 内并发派工标识（默认关闭）

同一 Run 的多个只读调查可以并发，而 driver handle/transport 按 driver 共享，所以：

- `DriverPrompt.dispatch_id`（可选）是该次派工的并发身份。`CommandDriverTransport` 用它
  （缺省回退 `run_id`）区分活动子进程；同一 `run_id` 的第二个 legacy 调用仍会被拒绝。
- transport 发出的事件带 `dispatch_id`；`runDriverPromptWithSignal` 在事件自带
  `dispatch_id` 时按派工隔离订阅流，未标注的事件继续按 `run_id` 过滤（并发隔离取决于
  transport 是否标注，命令 transport 已标注）。
- 事件信封的 `run_id` 仍是真实 Run，`dispatch_id` 只是可选的附加字段；legacy/Council 不提供。
- 并发开关/上限在 role 选路时冻结进 Journal `init`，见 `.env.example` 与
  `docs/contracts/role-driver-autonomy.md` 的阶段 1 记录。

## 阶段 5：明确命令的 verify 派工

`dispatch_execution` 可在 `kind=verify`、`session.mode=fresh` 时携带
`verification_command: { executable, args }`。这条派工使用 Driver 模块的本地命令适配器，
直接运行 argv（不隐式启用 shell），不再调用 coding LLM。仍经过同一 accepted/dispatched/
evidence/settled 写屏障、取消、单派工超时、预算与只读约束；非零退出记真实失败，不能宣称通过。
输出按流限长，原文写入受控 evidence ref；命令结束、交还 Role 前由宿主取内容指纹，finish
沿用现有 host_observed/complete/exit 0/最终内容一致的校验。外部 Driver 自述和 runner 退出码
仍不能冒充检查。没有此字段的派工及 legacy/Council 行为保持原解释。

工作区三个快照入口统一排除根 `.claude/settings.local.json`（Claude Code 本地权限状态）；
`.claude/settings.json`、hooks 和嵌套同名文件仍参与变更与内容指纹。真实验收不再使用 junction
移出整个 `.claude`。受支持外部命令事件的指纹算法也须使用同一排除规则。

回滚新派工数据时，目标二进制必须能解析 `verification_command`，不能仅凭“≥ 阶段 3”
推断兼容；优先在当前二进制上同时关闭三个开关。旧 Journal 缺省字段仍可读取。

## 测试映射

| 文件                                                     | 场景                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `adp-status-mapping.test.ts`                             | 五类结局的映射与 unknown 判定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `adp-retry-policy.test.ts`                               | unknown 永不重跑、按档位查配置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `adp-driver-endpoint.test.ts`                            | 故障注入:执行前/写工作区后/返回结果前断连、同 exchange 重复 invoke、副作用执行中取消、interrupted 适配、迟到结果对账、崩溃恢复对账、真实 runtime 链路的阶段证据、契约断言(帧过 P0 校验、配置不入帧)、降级记账                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `test/app/driver-runtime-agent-execution-facade.test.ts` | facade 接线:落账与回执回调、unknown 不重跑、failed 按策略重执行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `test/driver/execution-contract.test.ts`                 | 阶段 1 契约：kind/只读、宿主身份防伪、Session reuse 确认、evidence 五态/transport 两字段/usage missing/runner 退码不冒充检查退码；阶段 2 复审修复：`result_received` 独立事实（含 unknown+true）、`host_observed` 检查可带 `target_paths`/`workspace_sha256`/`observed_at`、`command_observed` strict schema                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/app/role-autonomy-engine-dispatch.test.ts`         | 阶段 2 复审修复真实链路：真实 journal + fake driver/Driver 事件：unknown 语义、命令级 host_observed checks、产物、迟到 reconciled、恢复摘要、TaskBudget、跨 Run retry；复审 7 项：检查证据绑定被检查版本、恢复链祖先违规/基线/产物、单派工超时独立收束、迟到结果 durable 回执与安全对账；本轮 6 项：真实 `CommandDriverTransport`+子进程「先发事件再改、宿主延迟处理」拒绝旧证据/正确绑定可完成、迟到回执归属多 Run（顺序/并发/关闭/写锁 drain 不串）、产物索引与基线逐成员 fail closed（`artifact_index_corrupt`/`workspace_baseline_corrupt`）；第 3 轮：finish 检查义务（宿主抽取显式命令义务、`&&` 组合命令覆盖、验证对象覆盖方向）真实 engine/loop/finish 链路（`echo ok` 被拒→blocked、`pnpm test && pnpm lint`→completed）；第 4 轮：观测命令与完成要求统一到受限命令表示（` |     | true`/`--help`被拒后可补证据或 blocked、反引号组合标准 + 分次观察→completed、不含关键词的显式命令标准`tsc --noEmit` 拿别的命令冒充→blocked） |
| `test/driver/abortable-driver-run.test.ts`               | abort 立即收束、`interrupt` 永不返回/同步抛错不阻塞、不误伤正常完成、取消原因保留                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `test/driver/dispatch-attempt.test.ts`                   | 阶段 1 写屏障：顺序、各屏障失败不调用 driver/不成功返回、5 个崩溃窗口恢复折叠、真实 journal 集成与半写修复                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/driver/adp-receipt-reconciler.test.ts`              | 阶段 1 回执对账：receipt 优先、重复幂等、重启后迟到 receipt 只对账、settled 冲突不改写、journal 写失败向上抛                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/driver/adp-journal-reconciliation.test.ts`         | 真实 `RunDispatchJournal` + 真实 SQLite ADP 底座：receipt→reconciled 折叠、重启重放不重执行、accepted-only 时 receipt 优先；复审修复：failed+传输错误码 → unknown+result_received=true、interrupted+副作用、无结果抛错、启动失败、重启回放事实一致、旧数据 missing 回退                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `test/persistence/run-dispatch-journal.test.ts`          | 阶段 1 Journal：正常写序与折叠、append 校验、受控 evidence ref、半写修复/缺换行、故障注入、单写者锁与回收闸门；串行化复核：在途 append/evidence/repair 期间 close 不释放锁、同实例并发同 sequence 单成功、并发 close 共享关闭 Promise、修改失败不毒化队列、内部嵌套登记无死锁                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 派工生命周期投影与 driver 事件身份（阶段 4）

阶段 4 让 Role 的派工过程对前端可见，但不新增事实源：Journal 仍是唯一权威，driver 侧只多一个
**可选身份字段**和一组低频投影事件。

- `DriverStreamEvent.dispatch_id?`（`contract.ts`）：只有 role 自主循环在派工期间转发的事件带它；
  legacy/Council 调用没有这个概念，读的一侧必须容忍缺失（不得填假 id）。`driver-usage.jsonl`
  的观测行据此可按 dispatch 归组；无该字段的旧记录进 `unattributed`，不填 0。
- 低频生命周期事件（`src/app/run-dispatch-events.ts`，公共 source 仍是 `agent`）：
  `agent.dispatch_accepted` / `started` / `settled` / `reconciled` / `inherited`、
  `agent.plan_updated`、`agent.finish_requested`、`agent.role_terminated`。载荷只含
  dispatch_id/kind/status/violations/受控 evidence ref 等元数据，**不含**完整指令、对话或
  transcript；正文经 `run.getDispatchEvidence` 按受控 ref 分页读取。
- 投影口径：`src/app/run-dispatch-projection.ts` 按 `dispatch_id` 去重，accepted-only 折叠
  `not_executed`、started 无 settled 折叠 `unknown`；unknown/迟到回执/违规语义不变，
  `unknown` 仍禁止自动重放、不得改写 failed。父链派工只进 `inherited`，不伪造当前 Run 的 dispatch。
- 只读读取：`RunDispatchJournal.peek` 不取写锁、不修坏尾、不写盘；Journal 不存在的老 Run 是
  `absent` 而不是错误。

## 阶段 5：真实 Driver 证据能力与 evidence-only 清理（2026-11-15）

**evidence-only 不再构造六字段 converter。** `createDriverRuntimeInvoker(driver, converter?)` 的默认
converter 改为在 `six_field` 分支惰性创建（`converter ?? createDefaultDriverReturnConverter()`）；
evidence-only 路径连构造都不做。legacy/Council 行为不变（显式注入的 converter 仍生效，六字段四级
兜底未动）。回归：`test/app/role-autonomy-evidence-only-chain.test.ts`（真实 engine→invoker→fake
driver，converter 构造 0/调用 0、无报告文件；legacy 路径构造 1/调用 1）。

**真实 ACP Driver 的命令级证据缺口（阶段 5 真实验收发现，必须如实披露）：** 本仓没有修改外部
ACP 仓，真实 `contract-runner` 只上报会话/工具事件与最终 `DriverRunResult`，**不产生
`driver.command_observed`**。因此：

- 旧路径仍可工作：六字段报告由 `DriverReturnConverter` 从 ACP 返回 JSON / transcript 解析（真实
  验收中本次未走 LLM fallback，但要按实际 stderr 记录）。
- 新路径的 `finish_task` 要求 `passed` 陈述引用 `host_observed + complete + exit 0 +
最终内容指纹一致` 的检查证据；真实 ACP Driver 上这类证据**不存在**，所以“要求验证通过”的任务
  无法 completed（role 只能如实 blocked/failed，或在不要求验证时以 `not_run` 交付）。
- 真实 Claude Code 会话执行 shell 命令时会在 workspace 写 `.claude/settings.local.json`，可能让
  只读 verify 派工触发 `read_only_changed`，进而永久拒绝 `finish(completed)`。
- 本轮实际验证过的能力仅限：真实进程 spawn / turn 事件 / 文件修改 / 交付 / 多次派工。Session
  复用、命令级证据、超时/取消语义**未在真实 ACP Driver 上验证**，不宣称支持。详见阶段 5 报告
  §3 与 `RD-IMP-21`。

## 边界(不在本卡)

多帧 progress、`observed_effects`、ADP → SAP 状态机械映射、外部 Driver 仓库改造;
需调整共享字段时先统一更新 P0 schema、fixture 与设计稿,不创建 ADP 私有变体。
