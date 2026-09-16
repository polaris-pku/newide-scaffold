# maintainability 角色 skills

> 状态：2026-09-07 完成维度重构（蓝图：`spec/docs/skills-角色维度重构蓝图.md`），同日另下载并入 3 个新技能（扩展提案）。**2026-09-11 指针移除（当前口径）**：5 个指针目录 `anti-patterns`、`cleanup`、`code-humanizer`、`cyclomatic-complexity-refactor`、`simplify-code` 已删除（`Routes …` 指针机制从语料与代码中彻底移除）。**现 9 个目录，全部为独立技能、无指针**。simplify-swarm（自 correctness 移入，2026-09-07）是清扫族唯一入口，其 **Light / Strict / Swarm 是同一个技能的三种模式**（按触发词路由，不是指针目标）：Light 覆盖一次过简化（含死代码删除路径）、Strict 覆盖 deslop/人味化、Swarm 覆盖分层清理；反模式识别以 clean-code 文末的 Smell Catalog 章节承担，圈复杂度战术以 refactoring 文末的 Cyclomatic Complexity Tactic 章节承担——都是各自技能自身的章节。structurize / evolutionary-naming / clean-architecture-reviewer / module-boundary-reviewer / api-contract-review / tech-debt-planner 为互不替代的专项。下表为来源映射（目录 ↔ 来源仓库 ↔ 源路径）；各技能正文自足，不再互指。

> **2026-09-11 判据收敛 + 事实/一致性修正**：段落级分类（约 153 段）结果 **149 本维度核心 / 0 纯异维度段 / 4 DUAL**——维度纯度已达标，本轮修的是另外两类问题。(1) **异维度残留 2 处**：`tech-debt-planner` 的 HIGH 严重度定义含 "or a latent correctness hazard"（把正确性判据折进可维护性评分），已剥离并显式移交 correctness；`simplify-swarm` 的 pitfall 10（`find -path` vs `Path.glob` 的 glob 深度差异）讲的是编排器自身工具行为，不是本角色的代码质量判据，已删并重编号。(2) **无出处数字**：删掉 `simplify-swarm` 两处**编造的现场统计**（"~30% 的严重度判断在二次阅读后会改变"、"在一个真实的 13.4k-LOC agent 生成的仓库里……得分为零"）与 "~80 duplicated lines"；`clean-code` 的 "2–3 层嵌套 / 5+ 参数 / 3–4 参数 / 5+ 文件" 改为定性表述；`refactoring` 的 CC 分档标注为"本技能的起始默认、非标准，以项目自身 linter 为准"。(3) **角色内冲突**：原报 5 处，核实后 **1 处为误报**——`simplify-swarm:120`（single-use helpers vs 有含义的命名函数）与 `refactoring:59` 本就一致，未动。其余 3 处已修：抽取重复的时机按"模块内第二次 / 跨模块第三次"分域并互引；`evolutionary-naming` Phase 1 补上导出/公开符号改名的契约例外（原先与 `simplify-swarm:132` 的公开 API 规则冲突）；测试前置规则区分"可证惰性删除"（语法+冒烟即可）与"行为相邻重构"（必须有测试），`refactoring:36` 与 `simplify-swarm:98` 两侧同步。(4) 顺带修 `clean-architecture-reviewer` 的悬空引用（命名为"未内联"的上游同族技能）。口径与流程见 `spec/docs/skills-判据收敛流程与落点清单.md`。

| 目录 | 来源仓库 | 源路径 | 状态 | 说明 |
|---|---|---|---|---|
| `clean-code` | [Teqqles/cleanerCodeAISkills](https://github.com/Teqqles/cleanerCodeAISkills) | `skills/clean-code` | **独立技能** | 写码原则；文末 Smell Catalog 承担反模式识别（10 类反模式目录 + 语言惯用法，2026-09-07 并入 anti-patterns 内容） |
| `refactoring` | [Teqqles/cleanerCodeAISkills](https://github.com/Teqqles/cleanerCodeAISkills) | `skills/refactoring` | **独立技能** | 安全小步重构；文末 Cyclomatic Complexity Tactic 承担圈复杂度战术（2026-09-07 并入 cyclomatic-complexity 内容） |
| `simplify-swarm` | [Sahil-SS9/hermes-simplify-swarm](https://github.com/Sahil-SS9/hermes-simplify-swarm) | `.` | **独立技能（自 correctness 移入）** | 清扫族唯一入口，含 Light（一次过简化 + 死代码路径）/ Strict（deslop/人味化）/ Swarm（分层双 agent 清理）三种模式；默认 Swarm 现为 Hygiene + Clarity |
| `structurize` | [LinardsLiepenieks/honecode](https://github.com/LinardsLiepenieks/honecode) | `skills/structurize` | **独立技能（专项）** | 给"藏起来的重复"命名并抽取（与清扫族互补：它删可见重复，这个问重复该变成什么） |
| `evolutionary-naming` | [kawasima/evolutionary-naming](https://github.com/kawasima/evolutionary-naming) | `skills/evolutionary-naming` | **独立技能（专项）** | Audit/Improve 渐进式命名 |
| `clean-architecture-reviewer` | [PanGan21/clean-architecture-claude-skills](https://github.com/PanGan21/clean-architecture-claude-skills) | `skills/clean-architecture-reviewer` | **独立技能（专项）** | 架构分层依赖/业务逻辑错位审查（PR/架构审计用） |
| `module-boundary-reviewer` | [pertrai1/eslint-plugin-llm-core](https://github.com/pertrai1/eslint-plugin-llm-core) | `.agents/skills/architecture-boundary-reviewer` | **独立技能（新增 2026-09-07）** | 模块/包依赖边界：循环依赖、反向依赖、隐式耦合 → 拆包/去环方案（无分层假设，区别于 clean-arch） |
| `api-contract-review` | [decebals/claude-code-java](https://github.com/decebals/claude-code-java) | `skills/api-contract-review` | **独立技能（新增 2026-09-07）** | REST 对外契约审查：HTTP 语义/版本化/向后兼容/响应一致性（= 对外契约维度，区别于内部结构审查） |
| `tech-debt-planner` | [Asixa/codemap-skill](https://github.com/Asixa/codemap-skill) | `SKILL.md`（repo 根） | **独立技能（新增 2026-09-07）** | 技术债测绘（按模块评分）与还债路线图（规划导向，区别于 simplify-swarm 的直接清理） |

## 触发路由（选技能前先查这表；本角色不再有同任务并行技能）

| 用户请求 | 唯一技能 |
|---|---|
| 写/改/审代码时的原则与反模式对照 | clean-code（原则 + Smell Catalog） |
| "重构 / 清理 / 简化既有代码"（不动行为） | refactoring（含圈复杂度战术章节） |
| 某函数/模块复杂度爆表要拆 | refactoring → Cyclomatic Complexity Tactic |
| 本轮改完代码，轻量简化一遍（一次过） | simplify-swarm → Mode 1 Light |
| "deslop / 人味化 / 审 AI 生成的 PR / 防 AI slop" | simplify-swarm → Mode 2 Strict |
| 未指明 / 要三 agent 分层清理（SAFE→CAREFUL→RISKY） | simplify-swarm → Mode 3 Swarm（原正文流程） |
| "这段重复该抽成公共模块吗 / structurize" | structurize |
| 烂命名要改善 / 想不出好名字 | evolutionary-naming |
| 审 PR 架构分层 / 依赖方向 | clean-architecture-reviewer |
| 循环依赖 / 模块包边界 / import 卫生 | module-boundary-reviewer |
| "review API / check endpoints / 发布前 REST 契约检查" | api-contract-review |
| "技术债盘点 / 重构路线图 / janitor" | tech-debt-planner |
| 行为正确性 / 崩溃根因（最近改动） | correctness 角色（harden-recent-changes——原 honecode/harden-code 职责） |
| 性能 / 安全 / 故障运维 | performance / security / reliability 角色 |

## 角色内职责划分速记

- **清扫族唯一入口** = simplify-swarm；其 Light / Strict / Swarm 是同一技能的三种模式（按触发词路由），不是并列技能，也无指针目录。
- **honecode 家族跨角色分工**：simplify（本角色，simplicity only）↔ 正确性检查（correctness/harden-recent-changes，原 harden-code）；改动代码的"简化—加固"回路分居两角色，各自依自身维度独立判断、不叠跑。
