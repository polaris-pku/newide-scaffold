# skills 目录 — 并行角色的单文件 Agent Skills

来源：从 GitHub 公开仓库逐仓库下载并筛选，随后归一化为单文件格式（2026-09-07 下载；同日蒸馏）。
授权说明：各 skill 版权归原作者仓库所有，使用时请核对各仓库 LICENSE（目录内无 LICENSE 文件的标注 `unknown — see repo`，见各角色 README 与文件内 Provenance）。

> **当前状态（2026-09-11 判据收敛后）**：`skills/` 共 **60 个技能目录，全部是独立技能，目录与技能 1:1**。**指针机制已彻底移除**——`Routes …` 指针目录、把目录当"路由指针"的旧口径、以及"活动 / 指针"拆分计数**全部作废**（`harden-code`、`logic-review`、`anti-patterns`、`cleanup`、`code-humanizer`、`cyclomatic-complexity-refactor`、`simplify-code`、`backend-latency-profiler-helper`、`anthropic-claude-code-security-review` 九个指针目录已删除）。各角色：**correctness 10 · maintainability 9 · performance 10 · reliability 8 · security 23**。以下各「日期」小节是**历史轮次记录**，只描述其当时的口径；**现状一律以「统一规格」与「角色与数量」两节为准**。

以下「2026-09-07」「2026-09-11」各小节为历史记录（含当时存在的指针口径）。

## 2026-09-07 维度重构（历史）

依据 `spec/docs/skills-角色维度重构蓝图.md` 完成一次**去重重构**，目标：**每个角色 = 一个质量维度，维度内技能互不重复**。手段与结果：

- **7 组内容合并**：宿主收编同任务技能并保留其高保真要点（含 Provenance 血缘），例如 bugsweep 收编 harden-code（会话模式）并归一 bug-hunter 三件套（议会部署形态）、simplify-swarm 收编 simplify-code/cleanup/code-humanizer（Light/Strict 模式）、code-security-audit 收编 anthropic 官方适配件（Official Lineage）等。
- **9 个目录指针化**（活动技能降为"路由指针"，内容并入宿主；目录保留以维持"目录 ↔ 上游仓库"1:1 溯源）：logic-review、harden-code、anti-patterns、cyclomatic-complexity-refactor、simplify-code、cleanup、code-humanizer、backend-latency-profiler-helper、anthropic-claude-code-security-review。
- **2 个技能跨角色归位**：simplify-swarm → maintainability（清扫族宿主）；harden-code → correctness（并入 bugsweep 会话模式）。
- **角色内加"触发路由表"**（各角色 README：trigger → 唯一技能）与逐技能边界标注（文件内 hand-off 说明），消除同任务多技能并行触发的选型冲突。
- **结果（重构）**：目录 50（活动 41 / 指针 9）；唯一能力 38。随后**同日**完成"扩展下载并入"（见下节），当前全库统计见「角色与数量」。

## 2026-09-07 扩展：下载并入新技能（重构后同日）

依据 `spec/docs/skills-各维度技能扩展提案.md`，为五个维度各补入不重复的新技能，共 **25 个目录**（全部活动，无指针）：

- **correctness +2**：coverage-gap-auditor（测试覆盖缺口）、concurrency-correctness-review（并发正确性专项）。
- **maintainability +3**：module-boundary-reviewer（模块/循环依赖边界）、api-contract-review（REST 契约审查）、tech-debt-planner（技术债测绘与还债路线）。
- **performance +3**：golang-performance、android-performance（skydoves Compose 运行时审计）、react-performance（框架机制层）——语言分区/机制层与现有指标层不重叠。
- **reliability +4**：observability-designer、feature-flags-architect（渐进放量）、chaos-engineering、incident-response（SEV 分诊/升级/取证）。
- **security +13**：cryptography-reviewer、cloud-iac-posture-auditor、container-security-auditor、mobile-app-security（4 平台/领域专项）+ **9 个 Agent 检测家族补全**（indirect-injection / tool-abuse / authorization-bypass / data-leakage / agentic-supply-chain / unexpected-code-execution / inter-agent-comm-security / cascading-failure / human-agent-trust-exploit，均出自 Tencent/AI-Infra-Guard，补全 owasp-asi 引用的上游探测技能）。

并入纪律与重构一致：下载 → 单文件化（frontmatter 仅 {name, description}，description 单行 ≤250、动词开头）→ 去本地文件引用/图片 → 追加 Provenance（repo/path/license/并入说明）→ 校验全绿。**与提案的偏差**（下载时按实际内容修正）：复盘槽因无高质量现成"无指责复盘"单技能，改为并入 incident-response（事件响应全流程）；android 运行时性能槽采用 skydoves Compose 审计技能（非通用 Android perf）；API 槽采用 decebals REST 契约审查（非通用 api-design）；`wshobson/postmortem-writing` 仓库不存在（404）未采用。验收与逐项清单见 `spec/docs/skills-下载并入验收报告.md`。

## 2026-09-11 角色纯度调整（reliability 收敛）

依据 `spec/multiagent-disagreement-coding-role-diversity.md`（记忆隔离下的角色分歧实验）：五个角色必须各自是**单一视角**，否则实验中被注入的角色记忆无法产生可归因的差异。据此清理 reliability 中不属于「经典 SRE / 韧性」这一视角的成员：

- **移除 `ship-check`**：30 项清单是安全+性能+可靠性三合一发布门禁（1–5、8、10、13、16 标为 security-critical），不是可靠性单一视角。
- **移除 `evals-ops-guardrails`、`production-autopsy`**：面向 ML/LLM/Agent 系统的 eval 套件、护栏、校准与分布漂移剖析，属「Agent 系统运维」这一**独立语义维度**，与本角色 SRE 族零共同词汇。
- **`maintainability/simplify-swarm` 收窄**：移除其原三 agent 流程中的 Correctness agent（N+1/内存泄漏/并发/静默失败/性能）及配套的逐语言条款与 "Concurrency fix patterns" 一节——该职责属 correctness 角色，且与 bugsweep/bug-hunter 完全冗余。默认 swarm 模式现为 Hygiene + Clarity 双 agent。

**结果**：reliability 12 → 9（全部活动，无指针）；其余四角色不变。被移除内容保留在 git 历史中，需要时可回取。

## 2026-09-11 角色倾向修正（P0：可归因性前置修复）

依据 `spec/multiagent-disagreement-coding-role-diversity.md` 的实验要求——**角色分歧必须可归因到维度**——对全部 60 条活动技能做了一轮内容级审计，修掉三类会污染归因的缺陷：

- **跨维度渗漏**：`security` 事实上是所有人的公共子集，这解释了它在向量空间里充当"吸铁石"。逐条剥离：correctness 侧（bug-hunter-hunter 的 security checklist 与 CWE/STRIDE、bug-hunter-referee 的 CVSS 3.1/PoC/exploitability、bugsweep 的 security FIND 类目、fp-check 的可利用性判据、agentic-code-reasoning 的 security-audit 子模式）；security 侧（security-audit-owasp 的部署回滚/健康检查/上线编排、owasp-asi 的整改时限）；performance 侧（react-performance 的 authn/authz）；maintainability 侧（api-contract-review 的暴露面与 N+1）。一律改为显式 handoff。
- **不可执行的伪步骤**：`reliability` 是重灾区——8 个技能里有 6 个在正文命令式调用**未随语料分发**的脚本（另有 tech-debt-planner、load-test-scenario-builder）。全部从"跑脚本"改写为方法论描述，并注明原文件未分发。
- **局部事实错误**：sql-query-optimizer 的编造 benchmark（`990x faster` 等）与伪规则（EXISTS/IN、join 顺序）；backup-restore-runbook 的 `recovery.conf`（PG12 起已移除）；rollback-workflow-builder 的 `docker inspect …ContainerConfig.Labels`（现代 docker 无此字段）；threat-model-generator 的 `/process\.env\./` 假阳性启发式；core-web-vitals-tuner 与 performance-budget-setter 的废弃 FID；owasp-asi 的陈旧边界说明。

**移除 3 个错位/空壳技能**：`correctness/coverage-gap-auditor`（覆盖率教程且与角色内 bugsweep 的 out-of-scope 声明冲突）、`reliability/incident-response`（正文是网络安全事件响应）、`security/container-security-auditor`（2.4KB 空壳）。内容保留在 git 历史中。

**结果**：目录 72 → 69（活动 63 → 60 / 指针 9 不变）；唯一能力 60 → 57；`skill-embeddings.json` 与 `skill-manifest.baseline.json` 已重算。

**尚未处理（P1）**：角色内同决策冲突（如 clean-code ↔ refactoring 对"单次出现是否抽取"、security-audit-owasp ↔ code-security-audit 的方法论重叠）；过时依赖（csurf / tfsec / trufflehog@main / checkov@master）；tool-abuse-detection ↔ unexpected-code-execution-detection 的命令注入探测重叠；bug-hunter-skeptic 内部 Step 0 与 Core Principle 1 的自相矛盾。

## 统一规格（当前 60 个目录，全部一致）

- **目录结构**：`skills/<角色>/<skill>/SKILL.md`，每目录只有这一个文件；**目录即技能、一一对应，不存在指针目录**。
- **frontmatter 最小集**：仅两键——`name`（=目录名）；`description` 严格单行、动词开头。全部通过 `yaml.safe_load` 校验。
- **正文自足（硬规则）**：每个技能正文只描述自己的方法（When to Use / Core Principles / Workflow / Checklist / Output Format / Provenance，深工具包按角色 README 溯源说明文字化）。**任何 SKILL.md 不得提及、引用或路由到另一个技能 / 角色 / 维度**——旧的跨技能 handoff、边界标注、council 部署注记已全部删除，文档不再把它们当作特性宣传。正文无本地文件引用、无图片。
- **校验**：`verify.py` 等价脚本全量通过（当前 **60/60，0 问题**）：YAML 可解析、键集 = {name, description}、name=目录名、description 单行 ≤250、无 `](./`、`../`、图片嵌入、无遗留文件。

## 角色与数量（目录数 = 技能数；体积为 SKILL.md 合计，2026-09-11 实测：判据收敛 + 指针移除 + 技能增删后）

| 角色 | 目录 | 技能体积 | 说明 |
|---|---|---|---|
| **correctness** | 10 | ~200 KB | 重构 5（code-reasoning 双入口、bugsweep 猎杀管线、fp-check、spec-to-code-compliance、variant-analysis）+ 新增 2（concurrency-correctness-review 并发专项；**harden-recent-changes** 会话级加固，自 bugsweep 原 Session Mode 拆出、由三个只读专家并行执行）+ bug-hunter 三件套（议会部署形态）。2026-09-11 移除 coverage-gap-auditor（覆盖率教程，与 out-of-scope 声明冲突）并剥离各技能的 security 夹带；指针目录 harden-code / logic-review 已删除 |
| **maintainability** | 9 | ~137 KB | 重构 6（clean-code、refactoring、simplify-swarm、structurize、evolutionary-naming、clean-architecture-reviewer）+ 新增 3（module-boundary-reviewer、api-contract-review、tech-debt-planner）。simplify-swarm 的 Light / Strict / Swarm 是其**一个技能的三种模式**（非指针目标）；2026-09-11 剥离 api-contract-review 的 security/N+1 段，tech-debt-planner 的伪脚本调用改方法论；指针目录 anti-patterns / cleanup / code-humanizer / cyclomatic-complexity-refactor / simplify-code 已删除 |
| **performance** | 10 | ~90 KB | 重构 7（sql-query-optimizer、caching-cdn-strategy-planner、core-web-vitals-tuner、load-test-scenario-builder、performance-budget-setter、rust-performance-core、swift-performance-engineering）+ 新增 3（golang-performance、android-performance、react-performance 语言/机制层分区）。**2026-09-11 删除 backend-performance-review 整个技能**（其 Layer Library 一节即占超大文件的 61%），performance 角色保留其余性能技能；同日删 sql 的编造 benchmark 与伪规则、FID→INP、load-test 伪脚本改方法论；指针目录 backend-latency-profiler-helper 已删除 |
| **reliability** | 8 | ~65 KB | 重构 4（backup-restore-runbook、data-resiliency-failure-injection、error-handling-standardizer、rollback-workflow-builder）+ 新增 4（reliability-strategy-builder、observability-designer、feature-flags-architect、chaos-engineering）。2026-09-11 移除 ship-check / evals-ops-guardrails / production-autopsy / incident-response，收敛为单一「经典 SRE / 韧性」；同日修伪脚本调用与 2 处事实错误（PG12+ PITR、docker 回滚标签）。本角色从无指针 |
| **security** | 23 | ~216 KB | 重构 11（审计/变更门/专项族/方法论/Agent 2/红队）+ 新增 12（crypto / cloud-IaC / mobile 3 专项 + Tencent Agent 检测家族 9）。2026-09-11 移除 container-security-auditor（空壳，原属新增的 4 个平台/领域专项之一，故新增降为 12），剥离 security-audit-owasp 的部署门/回滚，修正 owasp-asi 边界说明与 threat-model 假阳性启发式；指针目录 anthropic-claude-code-security-review 已删除 |

合计：**60 个技能目录（= 60 个技能）· SKILL.md 体积约 710 KB**（角色 README 另计约 42 KB）。

## 蒸馏的含义与能力边界

- **A 类**：原本单文件 → 归一 frontmatter，正文保留原样。
- **B 类**：单文件 + 辅助 md → 辅助文档内联，无损。
- **C 类（深工具包）**：脚本逻辑文字化为步骤/信号/判定规则；需要原始脚本/精确阈值时按文件内 Provenance 的 repo URL 回上游仓库取用。
- **2026-09-07 曾并入的目录**：当时内容以"宿主新章节"形式保留高保真要点（模式/目录/规则），被并入目录本体只留路由指针。**该指针机制已于 2026-09-11 彻底移除**——这些指针目录现全部删除，要点留在宿主技能（现已各自独立）的正文中，完整历史与更细规则按宿主 SKILL.md 内 Provenance 回上游仓库。

## 使用方法提示

1. **先读目标角色 README 的"触发路由"表**：同一角色的技能已按维度去重，选型冲突由路由表消解；跨角色重叠（同一代码多透镜评审）是设计特性，各角色依自身维度独立判断，语料内不再有 handoff 注记。
2. 全部 60 个目录都是独立技能、都参与注入；已无指针目录，也没有"找回某技能完整历史"的指针入口。
3. 多数技能是"评审/检查清单/方法论"式；作为**并行角色**使用时应以该 SKILL 的质量标准为准绳产出完整方案/代码（角色保真由 harness 逐轮重申）。

## 溯源

- **角色 README.md**：目录 ↔ 来源仓库 URL ↔ 源路径 ↔ 状态映射表。
- **SKILL.md 内 Provenance 段**：Source repo、Original path、License、蒸馏/并入说明。
- 重构前的 2026-09-07 基线快照在重构执行时备份（`%TEMP%/skills-backup-20260907-120824`），评估与重构依据见 `spec/docs/skills-五角色技能内聚性评估.md` 与 `spec/docs/skills-角色维度重构蓝图.md`。
