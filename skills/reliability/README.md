# reliability 角色 skills

> 状态：2026-09-07 完成维度重构（蓝图：`spec/docs/skills-角色维度重构蓝图.md`；harden-code 已移至 correctness，现为独立技能 `harden-recent-changes`），同日另下载并入 4 个新技能（扩展提案）。**2026-09-11 角色纯度调整**：移除 `ship-check`（安全+性能+可靠性三合一发布门禁，非可靠性单一视角）、`evals-ops-guardrails` 与 `production-autopsy`（LLM/Agent 系统运维，属另一语义维度，与本角色 SRE 族零共同词汇），本角色收敛为单一「经典 SRE / 韧性」主题。**同日第二轮**：移除 `incident-response`——其正文是网络安全事件响应（ransomware / MITRE 技术号 / chain-of-custody / GDPR 72h 合规通知），不是可用性事件，与"管故障恢复、绝不管纯审计"的契约冲突；并修掉本角色 6 个技能的**不可执行伪步骤**（`scripts/*.py|.sh|.ts` 均未随语料分发，改为方法论描述）与 2 处事实错误（PG12+ 的 PITR 流程、docker 回滚标签）。现 **8 个目录，全部为独立技能、无指针**。子分区：SRE 族（设计/编码/发布/容灾/演练/可观测性/发布控制/混沌）。下表为来源映射（目录 ↔ 来源仓库 ↔ 源路径）；各技能正文自足，不再互指。

> **2026-09-11 判据收敛 + 事实/一致性修正**：段落级分类（约 136 段）结果 **132 本维度核心 / 1 异维度段 / 2 DUAL**——维度纯度达标，本轮修另外两类。(1) **异维度 1 处**：`observability-designer` 的 `Cost Optimization for Observability` 加范围说明——成本效率判断（这笔采集开销值不值）归 performance，本技能保留"在有限遥测预算下保住信号"的可靠性读法。(2) **无出处数字**：核实后本角色远好于初报——`backup-restore-runbook` 已有 Derivation 纪律（RTO 由恢复步骤求和推导、RPO 由实际保留的最频捕获推导、未演练的值须标注为估计），`feature-flags-architect` 已把 `max-age-days` 显式写成可配置默认值（default 90），**二者非缺陷，未动**。真正需处理的是三处以权威口吻给出的模板数字：`observability-designer` 的"80/20 黄金比"与"7±2 面板上限"改为定性表述；`rollback-workflow-builder`（回滚触发阈值）、`chaos-engineering`（爆炸半径分档）、`reliability-strategy-builder`（SEV 响应时间）各加"示意默认值，按自身服务校准"说明。(3) **冲突**：`chaos-engineering`（在生产跑实验）vs `data-resiliency-failure-injection`（优先非生产）按**分域 + 互相引用**裁定——生产是环境阶梯的**成熟档**（须先具备 abort criteria、有界爆炸半径、on-call 覆盖），非生产是数据类演练的**入门档**；两边各加说明并互指。`observability-designer` 与 `reliability-strategy-builder` 的 SLO 归属重复：observability 本已声明"不定义 SLO"，本轮把其 math 小节改写为"消费 SLO 拥有者的定义、只负责接线"。(4) 顺带：`error-handling-standardizer` 的 Safe Client Messages 补可靠性读法（稳定契约优先，信息披露读法归 security）；`rollback-workflow-builder` 的 kubeconfig 写入补 `chmod 600` 与"用后清理"。口径见 `spec/docs/skills-判据收敛流程与落点清单.md`。

| 目录 | 来源仓库 | 源路径 | 子分区 | 说明 |
|---|---|---|---|---|
| `reliability-strategy-builder` | [patricio0312rev/skills](https://github.com/patricio0312rev/skills) | `architecture/reliability-strategy-builder` | SRE-设计 | 熔断/重试/降级/舱壁 + SLO/错误预算 + 故障模式分析 + 事件响应 |
| `error-handling-standardizer` | patricio0312rev/skills | `backend/error-handling-standardizer` | SRE-编码 | 错误分类/HTTP 映射/结构化日志/安全消息/异步错误（含启动失败显式化、健康检查配套） |
| `rollback-workflow-builder` | patricio0312rev/skills | `ci-cd/rollback-workflow-builder` | SRE-发布 | 自动/手动/K8s/Docker/DB 迁移回滚 + runbook |
| `backup-restore-runbook` | patricio0312rev/skills | `db-management/backup-restore-runbook-generator` | SRE-容灾 | PG/MySQL 备份、PITR、校验、DR 分工、RTO/RPO |
| `data-resiliency-failure-injection` | [vaquarkhan/data-engineering-agent-skills](https://github.com/vaquarkhan/data-engineering-agent-skills) | `skills/data-resiliency-testing-and-failure-injection` | SRE-演练 | 数据平台故障注入/恢复验证/故障切换/replay 安全 |
| `observability-designer` | [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills) | `engineering/skills/observability-designer` | SRE-可观测性（新增 2026-09-07） | SLI→埋点/日志结构/追踪/告警设计（"如何测量"，与 strategy-builder 的 SLO 定义互补） |
| `feature-flags-architect` | alirezarezvani/claude-skills | `engineering/skills/feature-flags-architect` | SRE-发布控制（新增 2026-09-07） | 渐进式放量（flags 架构/生命周期/审计）——预防侧，与 rollback-workflow-builder（反应侧）互补 |
| `chaos-engineering` | alirezarezvani/claude-skills | `engineering/skills/chaos-engineering` | SRE-演练（新增 2026-09-07） | 全栈故障注入/游戏日（稳态假设/爆炸半径）；与 data-resiliency-failure-injection（数据平台演练）互补 |
| `incident-response` | alirezarezvani/claude-skills | `engineering-team/skills/incident-response` | ~~已移除（2026-09-11）~~ | 正文为网络安全事件响应（14 类安全事件 / MITRE 技术号 / 取证 / 合规通知），非可用性事件。内容保留在 git 历史中 |

## 触发路由（选技能前先查这表）

| 用户请求 | 唯一技能 |
|---|---|
| "可靠性模式 / 熔断重试 / SLO / 故障分析 / 事件响应" 设计 | reliability-strategy-builder |
| "错误处理 / 日志 / 错误码标准化" | error-handling-standardizer |
| "回滚自动化 / 部署恢复 / 发布事故" | rollback-workflow-builder |
| "数据库备份 / 灾难恢复 / 备份演练" | backup-restore-runbook |
| 给数据管道/平台做故障演练 | data-resiliency-failure-injection |
| "把 SLO 变成可告警信号 / 埋点与告警设计" | observability-designer |
| "加/退役/审计 feature flags、渐进放量" | feature-flags-architect |
| "混沌实验 / 游戏日 / 爆炸半径" | chaos-engineering |
| "事件分级分诊升级 / SEV / 证据保全" | 已随 `incident-response` 移除（2026-09-11）；可用性事件处置并入 reliability-strategy-builder 的故障模式与 SEV 分级 |
| 找行为 bug / 崩溃根因（非运维侧） | correctness 角色（bugsweep / fp-check） |
| 安全可利用性 / 密钥 / 供应链 | security 角色 |

## 跨角色边界说明

- **harden-code 已移出**（→ correctness，现为独立技能 `harden-recent-changes`）："最近改动加固"是找 bug 维度；本角色只管故障工程与发布/运维。
- **发布前跨维度初筛不在本角色**：安全+性能+可靠性三合一的发布清单属跨角色门禁（2026-09-11 已移出）；本角色只保留可靠性单一视角的专项：策略/回滚/备份/韧性/可观测/放量/混沌。
- **事件响应已移出**（2026-09-11）：原 `incident-response` 正文是安全事件响应（取证/合规通知/MITRE），属 security 语义；可用性侧的 SEV 分级与故障处置由 reliability-strategy-builder 承担。
- **LLM/Agent 系统运维不在本角色**：eval 套件、护栏、校准与分布漂移剖析（原 evals-ops-guardrails / production-autopsy）属"Agent 系统运维"维度，2026-09-11 已移出；需要时回上游仓库（Jack-Pision、ByteStack-Labs）。
