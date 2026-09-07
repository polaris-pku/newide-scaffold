# maintainability 角色 skills

> 状态：2026-09-07 完成维度重构（蓝图：`spec/docs/skills-角色维度重构蓝图.md`），同日另下载并入 3 个新技能（扩展提案）。现 14 个目录：**活动 9 / 指针 5**。唯一能力 9（原 6 + 新增 3：module-boundary-reviewer、api-contract-review、tech-debt-planner）。清扫族已四合一：simplify-swarm（自 correctness 移入，2026-09-07）为唯一宿主，收编 simplify-code（Light）、cleanup（Light 死代码路径）、code-humanizer（Strict）为三模式；clean-code 收编 anti-patterns（Smell Catalog）；refactoring 收编 cyclomatic-complexity-refactor（复杂度战术）。structurize / evolutionary-naming / clean-architecture-reviewer 为互不替代的专项。下表为来源映射（目录 ↔ 来源仓库 ↔ 源路径）；指针行的能力已并入宿主。

| 目录 | 来源仓库 | 源路径 | 状态 | 说明 |
|---|---|---|---|---|
| `clean-code` | [Teqqles/cleanerCodeAISkills](https://github.com/Teqqles/cleanerCodeAISkills) | `skills/clean-code` | **活动（宿主）** | 写码原则；文末 Smell Catalog 收编 anti-patterns 10 类反模式目录 + 语言惯用法 |
| `anti-patterns` | Teqqles/cleanerCodeAISkills | `skills/anti-patterns` | **指针 → clean-code** | 反模式识别已并入 clean-code Smell Catalog 章节 |
| `refactoring` | Teqqles/cleanerCodeAISkills | `skills/refactoring` | **活动（宿主）** | 安全小步重构；文末 Cyclomatic Complexity Tactic 收编圈复杂度专项 |
| `cyclomatic-complexity-refactor` | [saurabhkumar8112/cyclomatic-complexity-skill](https://github.com/saurabhkumar8112/cyclomatic-complexity-skill) | `skills/cyclomatic-complexity` | **指针 → refactoring** | 圈复杂度测量/战术/硬规则已并入 refactoring 的 Cyclomatic Complexity Tactic 章节 |
| `simplify-swarm` | [Sahil-SS9/hermes-simplify-swarm](https://github.com/Sahil-SS9/hermes-simplify-swarm) | `.` | **活动（宿主，自 correctness 移入）** | 清扫族唯一入口：Light（原 simplify-code+cleanup）/ Strict（原 code-humanizer）/ Swarm（原三 agent 流程）三模式 |
| `simplify-code` | [LinardsLiepenieks/honecode](https://github.com/LinardsLiepenieks/honecode) | `skills/simplify-code` | **指针 → simplify-swarm（Light）** | 一次过简化流程已并入宿主 Mode 1 |
| `cleanup` | honecode | `skills/cleanup` | **指针 → simplify-swarm（Light）** | 死代码删除细则已并入宿主 Mode 1 |
| `code-humanizer` | [LeonardNJU/code-humanizer](https://github.com/LeonardNJU/code-humanizer) | `.` | **指针 → simplify-swarm（Strict）** | deslop/Iron rules/5 层目录已并入宿主 Mode 2 |
| `structurize` | honecode | `skills/structurize` | **活动（专项）** | 给"藏起来的重复"命名并抽取（与清扫族互补：它删可见重复，这个问重复该变成什么） |
| `evolutionary-naming` | [kawasima/evolutionary-naming](https://github.com/kawasima/evolutionary-naming) | `skills/evolutionary-naming` | **活动（专项）** | Audit/Improve 渐进式命名 |
| `clean-architecture-reviewer` | [PanGan21/clean-architecture-claude-skills](https://github.com/PanGan21/clean-architecture-claude-skills) | `skills/clean-architecture-reviewer` | **活动（专项）** | 架构分层依赖/业务逻辑错位审查（PR/架构审计用） |
| `module-boundary-reviewer` | [pertrai1/eslint-plugin-llm-core](https://github.com/pertrai1/eslint-plugin-llm-core) | `.agents/skills/architecture-boundary-reviewer` | **活动（新增 2026-09-07）** | 模块/包依赖边界：循环依赖、反向依赖、隐式耦合 → 拆包/去环方案（无分层假设，区别于 clean-arch） |
| `api-contract-review` | [decebals/claude-code-java](https://github.com/decebals/claude-code-java) | `skills/api-contract-review` | **活动（新增 2026-09-07）** | REST 对外契约审查：HTTP 语义/版本化/向后兼容/响应一致性（= 对外契约维度，区别于内部结构审查） |
| `tech-debt-planner` | [Asixa/codemap-skill](https://github.com/Asixa/codemap-skill) | `SKILL.md`（repo 根） | **活动（新增 2026-09-07）** | 技术债测绘（按模块评分）与还债路线图（规划导向，区别于 simplify-swarm 的直接清理） |

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
| 行为正确性 / 崩溃根因（最近改动） | correctness 角色（bugsweep Session Mode——原 honecode/harden-code 职责） |
| 性能 / 安全 / 故障运维 | performance / security / reliability 角色 |

## 角色内职责划分速记

- **清扫族唯一入口** = simplify-swarm（三模式按触发词路由）；simplify-code/cleanup/code-humanizer 目录保留为指针，不再作为并列技能。
- **honecode 家族跨角色分工**：simplify（本角色，simplicity only）↔ 正确性检查（correctness/bugsweep Session Mode，原 harden-code）；改动代码的"简化—加固"回路分居两角色，互相 hand-off，不叠跑。
