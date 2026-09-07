# skills 目录 — 并行角色的单文件 Agent Skills

来源：从 GitHub 公开仓库逐仓库下载并筛选，随后归一化为单文件格式（2026-09-07 下载；同日蒸馏）。
授权说明：各 skill 版权归原作者仓库所有，使用时请核对各仓库 LICENSE（目录内无 LICENSE 文件的标注 `unknown — see repo`，见各角色 README 与文件内 Provenance）。

## 2026-09-07 维度重构（重要）

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

## 统一规格（当前 75 个目录，全部一致）

- **目录结构**：`skills/<角色>/<skill>/SKILL.md`，每目录只有这一个文件。
- **frontmatter 最小集**：仅两键——`name`（=目录名）；`description` 严格单行、动词开头（指针目录以 `Routes …` 开头路由到宿主）。全部通过 `yaml.safe_load` 校验。
- **正文**：活动技能保留原蒸馏骨架（When to Use / Core Principles / Workflow / Checklist / Output Format / Provenance，深工具包按角色 README 溯源说明文字化）；指针目录仅含路由说明 + Provenance。正文无本地文件引用、无图片。
- **校验**：`verify.py` 等价脚本全量通过（当前 **75/75，0 问题**，2026-09-07 终态复验）：YAML 可解析、键集 = {name, description}、name=目录名、description 单行 ≤250、无 `](./`、`](../`、图片嵌入、无遗留文件。

## 角色与数量（目录数 = 活动 + 指针；体积为 SKILL.md 合计，2026-09-07 终态实测：重构 + 扩展并入后）

| 角色 | 目录 | 活动 | 指针 | 技能体积 | 唯一能力 | 说明 |
|---|---|---|---|---|---|---|
| **correctness** | 12 | 10 | 2 | ~229 KB | 7 | 重构 5（code-reasoning 双入口、bugsweep 猎杀（含议会形态/会话模式）、fp-check、spec-to-code-compliance、variant-analysis）+ 新增 2（coverage-gap-auditor 测试覆盖缺口、concurrency-correctness-review 并发专项） |
| **maintainability** | 14 | 9 | 5 | ~162 KB | 9 | 重构 6（clean-code、refactoring、simplify-swarm 三模式、structurize、evolutionary-naming、clean-architecture-reviewer）+ 新增 3（module-boundary-reviewer、api-contract-review、tech-debt-planner） |
| **performance** | 12 | 11 | 1 | ~169 KB | 11 | 重构 8（backend-performance-review 方法论+附录、sql/caching/CWV/load-test/budget、rust/swift 语言分区）+ 新增 3（golang-performance、android-performance、react-performance 语言/机制层分区） |
| **reliability** | 12 | 12 | 0 | ~126 KB | 12 | 重构 8（SRE 族 5 + ship-check 门禁 + Agent 运维 2）+ 新增 4（observability-designer、feature-flags-architect、chaos-engineering、incident-response） |
| **security** | 25 | 24 | 1 | ~244 KB | 24 | 重构 11（审计/变更门/专项族/方法论/Agent 2/红队）+ 新增 13（crypto/cloud-IaC/container/mobile 4 专项 + Tencent Agent 检测家族 9） |

合计：**目录 75（活动 66 / 指针 9）· 唯一能力 63 · SKILL.md 体积约 930 KB**（角色 README 另计约 41 KB）。

## 蒸馏的含义与能力边界（沿用，指针语义更新）

- **A 类**：原本单文件 → 归一 frontmatter，正文保留原样。
- **B 类**：单文件 + 辅助 md → 辅助文档内联，无损。
- **C 类（深工具包）**：脚本逻辑文字化为步骤/信号/判定规则；需要原始脚本/精确阈值时按文件内 Provenance 的 repo URL 回上游仓库取用。
- **2026-09-07 并入目录**：内容以"宿主新章节"形式保留高保真要点（模式/目录/规则），完整历史与更细规则按指针文件的 Provenance 回上游仓库；被并入目录本体只留路由指针，**注入时请勿把指针当独立技能使用**。

## 使用方法提示

1. **先读目标角色 README 的"触发路由"表**：同一角色的技能已按维度去重，选型冲突由路由表消解；跨角色重叠（同一代码多透镜评审）是设计特性，按 hand-off 顺序执行。
2. 指针目录不注入；它只在"想找回原技能完整历史/规则"时指向宿主章节与上游仓库。
3. 多数活动技能是"评审/检查清单/方法论"式；作为**并行角色**使用时应以该 SKILL 的质量标准为准绳产出完整方案/代码（角色保真由 harness 逐轮重申）。

## 溯源

- **角色 README.md**：目录 ↔ 来源仓库 URL ↔ 源路径 ↔ 状态（活动/指针-宿主）映射表。
- **SKILL.md 内 Provenance 段**：Source repo、Original path、License、蒸馏/并入说明。
- 重构前的 2026-09-07 基线快照在重构执行时备份（`%TEMP%/skills-backup-20260907-120824`），评估与重构依据见 `spec/docs/skills-五角色技能内聚性评估.md` 与 `spec/docs/skills-角色维度重构蓝图.md`。
