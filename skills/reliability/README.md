# reliability 角色 skills

> 状态：2026-09-07 完成维度重构（蓝图：`spec/docs/skills-角色维度重构蓝图.md`；harden-code 已移至 correctness 并入 bugsweep Session Mode），同日另下载并入 4 个新技能（扩展提案）。现 **12 个目录全部为活动技能**，唯一能力 12（原 8 + 新增 4：observability-designer、feature-flags-architect、chaos-engineering、incident-response）。子分区：**SRE 族**（设计/编码/发布/容灾/演练 + 新增 可观测性/发布控制/混沌/事件响应）、**发布门禁**（ship-check）、**Agent 运维族**（evals-ops/production-autopsy）。ship-check 30 项初筛的深审路由已内联为文末 "Item → Specialist Skill Map"。下表为来源映射（目录 ↔ 来源仓库 ↔ 源路径）。

| 目录 | 来源仓库 | 源路径 | 子分区 | 说明 |
|---|---|---|---|---|
| `reliability-strategy-builder` | [patricio0312rev/skills](https://github.com/patricio0312rev/skills) | `architecture/reliability-strategy-builder` | SRE-设计 | 熔断/重试/降级/舱壁 + SLO/错误预算 + 故障模式分析 + 事件响应 |
| `error-handling-standardizer` | patricio0312rev/skills | `backend/error-handling-standardizer` | SRE-编码 | 错误分类/HTTP 映射/结构化日志/安全消息/异步错误（含启动失败显式化、健康检查配套） |
| `rollback-workflow-builder` | patricio0312rev/skills | `ci-cd/rollback-workflow-builder` | SRE-发布 | 自动/手动/K8s/Docker/DB 迁移回滚 + runbook |
| `backup-restore-runbook` | patricio0312rev/skills | `db-management/backup-restore-runbook-generator` | SRE-容灾 | PG/MySQL 备份、PITR、校验、DR 分工、RTO/RPO |
| `data-resiliency-failure-injection` | [vaquarkhan/data-engineering-agent-skills](https://github.com/vaquarkhan/data-engineering-agent-skills) | `skills/data-resiliency-testing-and-failure-injection` | SRE-演练 | 数据平台故障注入/恢复验证/故障切换/replay 安全 |
| `ship-check` | [Prem95/ship-check](https://github.com/Prem95/ship-check) | `.` | 发布门禁 | 30 项发布初筛（安全+性能+可靠性）；文末含 30 项 → 各角色专项技能映射，深审不在此重复 |
| `evals-ops-guardrails` | [Jack-Pision/agentic-AI-development-skills-claude-code](https://github.com/Jack-Pision/agentic-AI-development-skills-claude-code) | `.claude/skills/evals-ops-and-guardrails` | Agent 运维 | agent 系统可发布资格：golden/adversarial/regression eval、观测、预算、策略门、提示注入防御 |
| `production-autopsy` | [ByteStack-Labs/claude-plugins](https://github.com/ByteStack-Labs/claude-plugins) | `agent-reliability/skills/production-autopsy` | Agent 运维 | "过 eval 但线上翻车"剖析：复现→切片差距→校准→消融→可复现诊断报告 |
| `observability-designer` | [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills) | `engineering/skills/observability-designer` | SRE-可观测性（新增 2026-09-07） | SLI→埋点/日志结构/追踪/告警设计（"如何测量"，与 strategy-builder 的 SLO 定义互补） |
| `feature-flags-architect` | alirezarezvani/claude-skills | `engineering/skills/feature-flags-architect` | SRE-发布控制（新增 2026-09-07） | 渐进式放量（flags 架构/生命周期/审计）——预防侧，与 rollback-workflow-builder（反应侧）互补 |
| `chaos-engineering` | alirezarezvani/claude-skills | `engineering/skills/chaos-engineering` | SRE-演练（新增 2026-09-07） | 全栈故障注入/游戏日（稳态假设/爆炸半径）；与 data-resiliency-failure-injection（数据平台演练）互补 |
| `incident-response` | alirezarezvani/claude-skills | `engineering-team/skills/incident-response` | SRE-事件响应（新增 2026-09-07） | 事件响应全流程：SEV 分级/分诊/升级/证据保全（NIST 800-61 风格；复盘深挖衔接 production-autopsy） |

## 触发路由（选技能前先查这表）

| 用户请求 | 唯一技能 |
|---|---|
| "可靠性模式 / 熔断重试 / SLO / 故障分析 / 事件响应" 设计 | reliability-strategy-builder |
| "错误处理 / 日志 / 错误码标准化" | error-handling-standardizer |
| "回滚自动化 / 部署恢复 / 发布事故" | rollback-workflow-builder |
| "数据库备份 / 灾难恢复 / 备份演练" | backup-restore-runbook |
| 给数据管道/平台做故障演练 | data-resiliency-failure-injection |
| "ship check / 审我的 app / 能上线吗" | ship-check（5 分钟初筛；命中项按文末映射转专项深审） |
| "agent 生产就绪吗 / 加 eval 与护栏 / 发布前门禁" | evals-ops-guardrails |
| "测试 99 分线上翻车 / 分布漂移 / 静默失败" | production-autopsy |
| "把 SLO 变成可告警信号 / 埋点与告警设计" | observability-designer |
| "加/退役/审计 feature flags、渐进放量" | feature-flags-architect |
| "混沌实验 / 游戏日 / 爆炸半径" | chaos-engineering |
| "事件分级分诊升级 / SEV / 证据保全" | incident-response |
| 找行为 bug / 崩溃根因（非运维侧） | correctness 角色（bugsweep / fp-check） |
| 安全可利用性 / 密钥 / 供应链 | security 角色 |

## 跨角色边界说明

- **harden-code 已移出**（→ correctness/bugsweep Session Mode）："最近改动加固"是找 bug 维度；本角色只管故障工程与发布/运维。
- **ship-check 不复制专项内容**：它只做 30 项初筛，命中项路由到 security（code-security-audit/auth/secrets/input-validation/offensive-api/security-audit-owasp）、performance（backend-performance-review/sql/caching）、reliability 各专项（strategy/error-handling/backup-restore）深审。
- **Agent 运维族与 security 的 Agent 安全子分区互引**：direct-injection-detection（security，进攻探测）发现 → evals-ops-guardrails（本角色，防护门禁）加固；owasp-asi（security）负责归类。
