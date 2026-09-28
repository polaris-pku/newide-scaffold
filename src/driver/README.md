# src/driver — Driver 运行时与 ADP 接入(A1 / issue #149)

本模块负责外部 ACP Driver 的调用链(transport → runtime → invoker → return
converter),以及 **ADP(Agent-Driver Protocol)v1 的 System 内代理 endpoint**:
把每次驱动调用包装成 `driver.invoke` / `driver.cancel` / `driver.invocation_result`
协议 exchange,落实副作用与结果未知语义。协议契约以 P0(`src/core/protocol-adp.ts`
+ `fixtures/protocol`)为唯一权威,投递底座复用 P1(`src/persistence`
`ProtocolDeliveryStore`),本模块不复制任何 schema 或存储实现。

## ADP endpoint 组成

| 文件 | 职责 |
| --- | --- |
| `adp-driver-endpoint.ts` | invoke/result/cancel 的 exchange 生命周期:帧构造(P0 校验)、P1 落账、判重、回执经宿主内回调交还 Agent |
| `adp-status-mapping.ts` | 驱动结局 → ADP status 的证据化映射(纯函数) |
| `adp-invocation-state.ts` | 单次 exchange 的状态机与证据模型(dispatched / 副作用活动 / transport 阶段证据) |
| `adp-retry-policy.ts` | 部署级 `auto_retry[side_effect]` 读取与判定 |
| `driver-transport-error.ts` | 传输层失败的阶段证据载体(`not_executed` / `execution_unconfirmed`) |

## 状态映射(与 P0 冻结枚举同版)

| 结局 | 证据条件 | ADP status | 自动重跑 |
| --- | --- | --- | --- |
| 启动失败(spawn 失败、dispatch 前抛错) | 明确证据:从未执行 | `failed`(code=`DRIVER_START_FAILED`) | 看 `auto_retry[side_effect]` |
| `DriverRunResult` `succeeded` | 确定 | `succeeded` | — |
| `DriverRunResult` `failed`(业务码) | 确定失败 | `failed` | 看 `auto_retry[side_effect]` |
| `DriverRunResult` `cancelled` | 驱动确认取消生效 | `cancelled` | 否 |
| `DriverRunResult` `interrupted` | 无副作用活动 / 有副作用活动 | `cancelled` / `unknown` | 否 / 永不 |
| 断连、超时、传输错误(dispatch 后) | 无法确认执行或副作用状态 | `unknown` | **永不** |
| 取消生效(明确未执行)/ 取消后副作用不明 | — | `cancelled` / `unknown` | 否 / 永不 |

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

## 测试映射

| 文件 | 场景 |
| --- | --- |
| `adp-status-mapping.test.ts` | 五类结局的映射与 unknown 判定 |
| `adp-retry-policy.test.ts` | unknown 永不重跑、按档位查配置 |
| `adp-driver-endpoint.test.ts` | 故障注入:执行前/写工作区后/返回结果前断连、同 exchange 重复 invoke、副作用执行中取消、interrupted 适配、迟到结果对账、崩溃恢复对账、真实 runtime 链路的阶段证据、契约断言(帧过 P0 校验、配置不入帧)、降级记账 |
| `test/app/driver-runtime-agent-execution-facade.test.ts` | facade 接线:落账与回执回调、unknown 不重跑、failed 按策略重执行 |

## 边界(不在本卡)

多帧 progress、`observed_effects`、ADP → SAP 状态机械映射、外部 Driver 仓库改造;
需调整共享字段时先统一更新 P0 schema、fixture 与设计稿,不创建 ADP 私有变体。
