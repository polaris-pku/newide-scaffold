# AGENTS.md

> **newIDE-BCD** —— 智能体级 IDE 的后端组合层（A/B/C/D 四方向）。
> 本文件是任何 AI 编程助手 / 新人在本仓开工前的**第一份读物**：只写"读代码前必须先知道的"，
> 细节指向各模块自带的 README 与本地 `docs/`。改完代码请回来同步本文件。

---

## 0. 30 秒定位

- **单包 TypeScript 后端**（不是 monorepo），Node `22.22.1`（`.nvmrc`）、pnpm `11.5.1`（`packageManager` 钉版）。
- **生产路径是真的**：外部 ACP Driver 子进程、持久化的 role/persona/memory、落盘的 Task/Run 状态、
  Council 提案/评审/合成/交付。Mock 仍在，但**不是**生产跑的那条路。
- **最该先懂的一件事**：Task Run 不是调用栈，是**逐阶段推进的持久化游标**（见 §2）。
- **这个仓不止一个人（也不止一个 Agent）在改**。任何会话开始先跑一次
  `git fetch origin main && git log --oneline -5 origin/main && git status --porcelain`，
  别直接相信别人（或其他会话）递过来的文件名、行号和"当前状态"。

---

## 1. 系统是什么：A / B / C / D

| 方向 | 归属目录 | 职责 |
| --- | --- | --- |
| **A** Driver | `src/driver/` | 运行时边界：把 coding agent 拉起来、收它的结果。ACP / ADP 协议在这里。 |
| **B** Memory | `src/memory/` | 长期记忆：Agent 注册、role/persona/Skill/Experience、Context Pack、离线维护。 |
| **C** Coordination | `src/coordination/`（+ `src/council/`） | Task/Run 生命周期、持久游标、Council 会议。 |
| **D** Hook / Gate | `src/hook/` `src/gate/` | D.1 决定**何时**触发评估；D.2 决定**怎么**评估（`deny > ask > defer > allow`）。 |

一条 Task 的主干：
`Task 创建 → select_agent → execute_agent → {council | gate} → deliver → done`。

---

## 2. 核心机制：持久化游标循环

**这一节没读懂，后面所有改动都会写错地方。**

`src/coordination/task-execution-loop.ts` 每轮迭代都**从存储重新读** Run 状态，然后按当前游标分派。
游标取值域（`src/persistence/coordination-state-store.ts` 的 `TaskResumeCursor`）：

```
select_agent → execute_agent → { mailbox_wait | council | gate } → deliver → done
```

每个阶段固定三拍：

1. `TaskProcessor.startStage` 写 `active_stage` + `invocation_id`，提交 `handler.started` 事件；
2. 执行器跑完，产出**证据**（evidence）；
3. `TaskProcessor.advanceStage` **原子地**提交新游标 + task 状态 + artifact refs + 事件。
   **终态是在这里写的，不是后端 service 写的。**

两条派生规则：

- **权威游标在 coordination SQLite 的 `resume_cursor`**，不在 run 目录里。run 目录只有 `request.json`
  说明它连第一个游标都没推进过。
- 耗时 span 名与 token 归属的 stage 名**必须同源**——`runStageWithAttribution` 用同一个游标字符串同时
  生成两者。分开写就会出现"报告里 token 和耗时对不上"，且不报错。

五个阶段执行器都在 `src/app/production-stage-executors.ts`（`createProductionStageExecutors`）。

---

## 3. 目录地图

```
src/
  core/         共享协议层（ID / 状态 / 事件 / artifact / checkpoint / 决策…）。不得 import 其它模块。
  protocol/     前端可见的稳定 schema（task/run 快照、run 事件、system 状态）
  coordination/ ★ 现行 C 应用层：游标循环、TaskProcessor、SAP/AAP 桥
  checkpoint/   safepoint / file anchor / resume package
  mailbox/      消息与投递状态、ACK/reply、Agent 唤醒
  persistence/  SQLite / 文件适配器（实现上层端口，不含领域策略）
  app/          ★ 生产组合根（无 barrel 导出，允许直接引用模块内部）
  rpc/          行分隔 JSON-RPC：只做参数校验与传输映射
  driver/       Driver 档案、探测、路由、ADP endpoint
  memory/       Agent 运行时 + 长期记忆 + 离线维护（有自己的 CLAUDE.md）
  council/      参与者解析、提案/评审/合成/裁决契约
  market/       Agent 竞标与评分
  hook/ gate/   D.1 / D.2
  litellm/      LLM 客户端、模型路由、method/tool registry
  telemetry/    延迟 span、LLM 用量账本、事件目录
  cli/          newide CLI
  coordinator/  ⚠ 遗留 IntegrationV0 兼容实现，见 §3.2
eval/           SWE-EVO / CooperBench 评测流水线
scripts/        报告、冒烟、验收、run-task.sh
```

### 3.1 边界规则

- 跨模块 import 走**模块 barrel**（`src/<module>/index.ts`）。现状并非处处遵守：
  `src/app`（组合根）与 `src/protocol` 没有 barrel，`src/council` 直接深路径 import
  `src/coordinator/artifact-content`，几乎所有模块都直接 import `src/protocol/*`。
  **这是已知现状，不是待办任务**——顺手"修"是一次有独立评审的 refactor。
- `src/core` 是共享协议层，**不得 import 任何其它模块**。

### 3.2 `src/coordination` vs `src/coordinator`（最容易踩的坑）

名字相近，性质完全不同：

- **`src/coordination` 是现行的 C 应用层。** 新的生产协调行为写这里。
- **`src/coordinator` 是遗留兼容实现**，但**不是死代码**——里面混着两类东西：
  - **共享库**（生产大量依赖）：`artifact-content`、`changeset-manifest`、`workspace-change-detector`、
    `task-state-machine`、`completion-criteria-evaluator`、`gate-executor`、`run-result`、
    `frontend-run-snapshot`、`handlers/*`。
    注意依赖方向：`src/coordination/task-processor.ts` 从这里 import `task-state-machine`，
    `src/council/` 从这里 import `artifact-content`。
  - **死掉的遗留编排器**：`orchestrator` / `integration-v0-flow` / `coordinator-runner` 与四个内存 store，
    只有 `NewideBackendService.startLegacyRun` 够得着，而 `startRun` 永远不会选它。

  **删除"遗留 coordinator"前必须先把上面两组分开**——删掉共享库会打断所有阶段。

### 3.3 模块 README（受 git 跟踪，权威）

`src/coordination/README.md`（游标循环的所有权表 + 依赖方向图，改协调代码前必读）、
`src/driver/README.md`、`src/memory/README.md`、`src/mailbox/README.md`、`src/checkpoint/README.md`、
`src/persistence/README.md`、`src/telemetry/README.md`、`src/litellm/README.md`、`src/coordinator/README.md`、
`eval/README.md`、`CONTRIBUTING.md`。

---

## 4. 命令

```bash
pnpm install            # 依赖
pnpm build              # tsc -b → scripts/build-cli.mjs → dist/newide.mjs
pnpm verify             # ★ CI 的门：lint + typecheck + test
pnpm typecheck          # tsc --noEmit
pnpm lint               # eslint .
pnpm format             # prettier --check .（format:fix 写回）
pnpm test               # vitest run（两个 project）
pnpm vitest run --project default <file>   # 单文件，跳过 pg-serial
```

运行与观测：

```bash
pnpm backend:rpc                    # JSON-RPC over stdio
pnpm rpc:smoke                      # 唯一端到端跑通生产组合的 harness
pnpm acceptance:real                # 真实 driver 验收
pnpm task:run -- --workspace ./ws --prompt "..."   # 脚本化跑一次 council
pnpm report:consumption --all       # token / 延迟 / 事件表（读 .newide/runs/）
pnpm report:driver-stream --all     # 回放 driver-stream.jsonl 并与 timeline.json 对账
```

CLI 只有三个子命令（`src/cli/newide.ts`）：`newide council run`、`newide serve --stdio`、
`newide memory drain`。**没有 `newide task run`。**

### 4.1 Windows 上不要用 `pnpm task:run`

Git-Bash/MSYS 会把 POSIX 形状的路径参数（`/d/...` → `D:/...`）改写掉，`run-task.sh` 解析到的不是你敲的路径。
自己构建两个仓库，然后直接调 CLI：

```powershell
$env:ACP_DRIVER_RUNNER_DIR='D:\path\to\acp-client-prototype'
node dist/newide.mjs council run --workspace 'D:\path\to\ws' --state-root 'D:\path\to\state' --allow-degraded --prompt "..."
```

`pnpm task:run` 会带 `--allow-degraded`，所以脚本化 council 运行一律带这个标志。

### 4.2 评测

`pnpm eval:*` 需要同级 checkout（`../SWE-EVO`、`../CooperBench`）加 Linux Python + Docker。
Windows 上这些 harness **必须**从 Ubuntu WSL 跑（README 的 "F Eval Real Harness Setup" 有完整步骤）。
`stub` / `oracle` 模式不需要 Docker。

---

## 5. 配置

配置来自**四个地方，不是一个**：

| 位置 | 管什么 |
| --- | --- |
| 本仓 `.env.local` | 后端模型、B 存储、Council、Gate |
| ACP Client 仓的 `.env` | coding agent 凭据（`ACP_DRIVER_ENV_FILE` 可覆盖） |
| `.agent/drivers.yaml` | Driver 档案（示例见 `.agent/drivers.example.yaml`） |
| `<stateRoot>/settings.yaml` | **本仓当前没有实现**（见 §9） |

`.env.example` 是所有开关的权威清单。**会改变一次 run 行为的**那些：

| 变量 | 作用 |
| --- | --- |
| `NEWIDE_DEFAULT_RUN_MODE` | `single_agent`（默认）/ `council`（也可在 `run.create` / `task.create` 里逐次指定 `mode`） |
| `NEWIDE_COUNCIL_STRATEGY` | `classic`（默认）/ `adaptive_lead` / `plan_first` |
| `NEWIDE_COUNCIL_SEATS` / `NEWIDE_COUNCIL_PROPOSERS` | 钉死席位，取代竞标分配 |
| `NEWIDE_AUCTION_ENABLED` + `NEWIDE_PRIMARY_AGENT_ID` | 关竞标、固定 primary |
| `NEWIDE_B_EMBEDDING_PROVIDER` | `hash` 是显式降级（无语义）；不设 = 真实 provider |
| `NEWIDE_GATE_COMMAND` | 不设 → `BestEffortGateExecutor` 放行一切（但 manifest 构建/物化照跑） |
| `NEWIDE_DRIVER` | 设 driver 档案的 `default_driver` |
| `NEWIDE_MAINTENANCE_INTERVAL_MS` | 退休/技能学习调度周期（默认 1h） |
| `NEWIDE_B_AUTO_RETIRE` / `NEWIDE_B_AUTO_LEARN` | 该 tick 是真动手还是只出报告（retire 默认关，learn 默认开） |
| `NEWIDE_B_DELIVERY_DRAIN_INTERVAL_MS` | 离线维护抽干周期（默认同 maintenance 间隔） |

CLI 会把 `process.env` 叠在 `.env.local` 之上，**shell 里已导出的变量优先**。

### 5.1 Driver 档案分层（后加载覆盖先加载）

```
内置 → ~/.agent/drivers.yaml → ~/.agent/drivers.local.yaml
     → <repo>/.agent/drivers.yaml → <repo>/.agent/drivers.local.yaml
     → 自动发现层(.agent/drivers.detected.local.yaml) → drivers.ui.local.yaml → env
```

- 角色没列在 `roles` 里 → 走 `default_driver`。
- `drivers.ui.local.yaml` 由前端的 `driver.updateRouting` / `driver.resetRouting` RPC 机器维护，
  **拥有整张 role 表，不要手改**；手工覆盖写 `drivers.local.yaml`。
- `DriverRegistry` 启动时校验每个声明的档案，**缺凭据就抛错**（故意如此），所以一个用不到的档案也能让启动失败。
- 探测层失败 = 该 driver 不可选（记原因码）；手工档案失败 = 启动失败。两者失败语义不同，别混。

---

## 6. RPC 面

`src/rpc/` 是行分隔 JSON-RPC over stdio，**前端和验收脚本的消费边界**；CLI 走进程内调用，绕过它。
已注册方法（按命名空间）：

- `task.*` — `create` `get` `list` `cancel` `delete` `interrupt` `resume` `startCouncil` `subscribe` `unsubscribe`
- `run.*` — `create` `getSnapshot` `subscribe` `unsubscribe` `getPayload` `getEvents` `getUsage` `cancel` `list` `restart`
- `memory.*` — Agent/Skill/Experience/Persona CRUD + 检索 + 市场 + 维护面
  （`claimDelivery` / `renewDeliveryClaim` / `ackDelivery` / `retryDelivery` /
  `restoreExpiredDeliveries` / `listMaintenance` / `listContextDeliveries` / `listDriverFeedback` …）
- `mailbox.*` — `send` `inbox` `ack` `reply`
- `artifact.*` — `getContent`
- `driver.*` — `getConfig` `updateRouting` `resetRouting` `list` `probe` `refresh`
- `system.*` — `ping` `liveness` `readiness` `capabilities` `version` `schema`

**判断能力状态请查 `system.readiness` / `system.capabilities`，不要从源码推断**——多个子系统是故意标
`degraded` / `unavailable` 的。

---

## 7. 运行证据在哪

状态根默认 `<repoRoot>/.newide`（`NEWIDE_STATE_ROOT` 覆盖，`NEWIDE_COORDINATION_DB` 覆盖里面的 SQLite 文件）：

```
.newide/coordination.sqlite      持久 Task/Run 状态——游标在这里
.newide/runs/<run_id>/
  request.json                   被接受的任务输入
  stages/<cursor>.json           每个已推进游标的证据——排查先看这里
  audit.jsonl                    追加式事件流（handler.started / advanced …）
  latency.jsonl                  每阶段 + 每轮 LLM 一个 span（run.loop_total 是根）
  summary.json / result.json     终态摘要（含 consumption 块）/ 完整终态
  changeset-manifest.json        gate 构建了什么
  delivery.json                  deliver 写了什么
  timeline.json                  Electron 前端渲染的东西
  frontend-snapshot.json         前端自己的视角
  production-stage-state.json    执行器自己的阶段状态
  telemetry.jsonl                本 run 的遥测（NEWIDE_TELEMETRY_JSONL=0 关闭）
  driver-stream.jsonl            原始 driver 事件流，8 MiB 封顶——truth source
  driver-usage.jsonl             每次 driver usage 观测一行，永不截断（NEWIDE_DRIVER_USAGE_JSONL=0 关闭）
```

三个 `.jsonl` 各自有开关、加入时间不同，所以**老 run 少一两个文件是正常的**。

`pnpm report:consumption` 与 `pnpm report:driver-stream` 是**降级而不是失败**的：
run 早于某个产物时，缺的东西写进 `missing`，不是报成 0。**读数字之前先读 `missing`。**

---

## 8. 代码风格与红线

- Prettier：100 列、单引号、分号、尾逗号。ESLint 强制 `consistent-type-imports`——**类型 import 用 `import type`**。
- 未使用变量允许 `_` 前缀。
- 提交信息用 Conventional Commits（`feat:` / `fix:` / `docs:` …），husky + commitlint 校验。
- **新文件要有文件级注释**，说明职责与核心逻辑——本仓的注释密度很高是这个仓的风格，不是噪音。
- **不要把生产用的 Checkpoint / Mailbox / Task / Run 行为加进 `src/coordinator`**（见 §3.2）。
- **不要把生产协调代码加进 `src/coordinator`，要加进 `src/coordination`。**
- 跨模块 import 走 barrel；但**不要顺手重连现有 import**（见 §3.1）。
- **不要在日志、注释、提交信息里写密钥**。`.env` / `.env.local` / ACP Client 的 `.env` 全部 gitignore。
- 改对外契约时，同一提交里同步改 `docs/contracts/`（本仓是本地文档，不入 git）与本文件。

### 8.1 `.gitignore` 的两个坑

1. `docs/`、`design/`、`research/` 整体不入 git；`**/CLAUDE.md` 不入 git；`.claude/`、`.zcode/` 不入 git。
   → **本仓根目录的 `CLAUDE.md` 是本地文件，改它进不了 PR，也别把它算进变更集。**
2. `.gitignore` 结尾是 `*[^ -~]*` → **任何路径含非 ASCII 字符的文件会被静默忽略**。
   → 新建中文名文件前先 `git status --ignored` 确认，否则会以为提交成功了。

---

## 9. 已知会骗人的地方（先看这里再信别的话）

这一节是本仓**最容易让 LLM 写错代码**的地方。

1. **本仓没有实现 `config.*` 统一配置接口。** ADR-0002 / EPIC-C 只存在于本地 `docs/`，
   源码里**没有** `src/settings/`、没有 `src/rpc/config-methods.ts`、全仓 grep 不到
   `CONFIG_KEY_NOT_EDITABLE` / `config.manage`。**不要照着"配置项注册表"的描述写代码。**
   完整实现保留在 safepoint 引用里（`git show 2e18dc54:src/settings/entry-registry.ts` 等，2026-10-17）
   与 `stash@{0}`；要恢复从那里取，别从 `docs/` 的"已落地"措辞推断。`docs/README.md` §9.1 有清单。
2. **记忆维护的消费端已经接上线了。** `src/app/b-memory-delivery-consumers.ts` 的 `MemoryDeliveryConsumers`
   构造了 `ContextDeliveryWorker` / `DriverFeedbackWorker` / 技能晋升 job / persona 演化 job，
   并在 `src/app/backend-rpc-stdio.ts` 里随维护定时器启动。**别再说"这些 worker 没人构造"。**
3. **在线/离线两半要保持分离**：在线只登记（`scheduleBuffer` 写 Context Delivery outbox，
   Driver 反馈写另一条 outbox），离线才做经验提取、技能晋升、persona 演化。
   权威边界清单在 `docs/plans/active/memory-maintenance-implementation-plan.md` §3。
4. **有手动补跑口**：`newide memory drain`（`--dry-run` 可只看两个 job 通道不写盘）。
   定时抽干默认 1 小时——想立刻看到经验入库就用它。**它不新增 RPC 方法。**
5. **`src/memory/README.md` 自身有陈旧段落**（"两个 Processor 没有内置定时器或 worker"）。
   以 §9.2 / §9.3 为准。
6. **本地 `docs/` 很丰富，但它是"人读的材料"，不是规范**：
   `docs/README.md` 是它的索引，每份文件的状态（现行 / 已落地 / 已被取代 / 生成物）都标在那里。
   **文档有日期＝有陈旧风险，动手前拿源码复核。**
7. **Windows 上 `pnpm test` 会有十几个环境性失败**（路径分隔符、无 PostgreSQL、
   `%TEMP%` 权限、子进程超时），这不是代码缺陷。判断标准是 CI：`.github/workflows/ci.yml` 在
   `ubuntu-latest` 上跑 `pnpm verify`。**别因为本地红就说自己改坏了。**

---

## 10. 测试

Vitest 两个 project（`vitest.config.ts`）：

- `default` — `test/**/*.test.ts` + `src/**/*.test.ts` + `src/**/test/**/*.test.ts`，并行。
- `pg-serial` — 6 个共用一个 `memory_test` PostgreSQL 库的集成测试，`fileParallelism: false`
  （它们的 `afterAll` 会互相清库）。

```bash
pnpm vitest run <file>                    # 一个文件
pnpm vitest run --project default <file>  # 跳过 pg-serial
```

测试分布：`test/`（镜像 `src/`）、`src/driver/*.test.ts`、`src/memory/test/`（含 `integration/`）。
新行为要有测试，放在同模块既有 `*.test.ts` 旁边。

---

## 11. 继续往下读

| 我要做… | 读这里 |
| --- | --- |
| 摸清全局 | `README.md`（对外）→ `docs/architecture/系统架构-模块划分与依赖关系.md`（本地） |
| 看当前设计方向 | `design/role-driver-rebalance.md`（v3.0 现行设计稿，**未实现**；v2.0 存档同目录；§12 是 2026-11-13 阶段 0 核对记录；`design/` 为本地目录，不入 git） |
| 实施 role/driver 职责完善 | `docs/plans/role-driver-autonomy-development-plan.md`（2026-11-14，**阶段 0–1 已验收；阶段 2 复审修复链完成 + 第二轮精简/unknown 非成功收束修复 + 最后一轮局部精简完成、待用户审核/验收；阶段 3–5 未开始**；各阶段的目标、交付物与验收门槛，§6 末为 2026-11-14 三轮精简记录）→ 阶段 0 契约 `docs/contracts/role-driver-autonomy.md`（含 §11 阶段 1/2 实现与修复记录；**阶段 2 精简后 `RD-FIN-03` 重写为「Role 语义判断 + 宿主事实校验」**，`RD-IMP-14` 为精简重构的唯一实现入口/退役/保留项与残余风险，`RD-IMP-16` 为最后一轮局部精简：JSON 读写 helper、屏障映射统一、重复回合预算删除、冻结计划直传） + 测试矩阵 `docs/contracts/role-driver-autonomy-test-matrix.md`（含 §13/§14 执行记录，§14.14/§14.15/§14.16 为 2026-11-14 三轮精简回归） + 基线 `docs/reports/role-driver-autonomy-baseline-2026-11-13.md` + 精简依据 `docs/reports/role-driver-phase2-redundancy-review-2026-11-14.md`、`docs/reports/role-driver-phase2-further-simplification-report-2026-11-14.md` 与 `docs/reports/role-driver-phase2-final-simplification-report-2026-11-14.md` |
| 查本地文档索引 / 已删材料 | `docs/README.md`（§9 已知问题）+ `.newide/docs-backup-*.zip`（删除前快照） |
| 改协调/游标 | `src/coordination/README.md` → `src/coordination/task-execution-loop.ts` |
| 改 Driver | `src/driver/README.md`（含 ADP 状态映射表与未知态语义） |
| 改记忆 | `src/memory/README.md` + `src/memory/CLAUDE.md` + `docs/plans/active/memory-maintenance-implementation-plan.md` §3 |
| 改前端契约 | `docs/contracts/前端可访问数据面.md`（本地）→ `src/protocol/*` |
| 改埋点/用量 | `src/telemetry/README.md`（权威）→ `pnpm report:consumption` |
| 改配置 | `.env.example`（权威清单）→ `src/driver/profile-loader.ts`（分层） |
| 找"为什么这么设计" | `docs/adr/`（ADR-0001/0002）+ `docs/reports/` |

`docs/` 在本地且不入 git；**要版本化的工程文档请放回 `src/*/README.md`、`eval/README.md` 这类受跟踪位置**。
