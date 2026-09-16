# performance 角色 skills

> 状态：2026-09-07 完成维度重构（蓝图：`spec/docs/skills-角色维度重构蓝图.md`），同日另下载并入 3 个新技能（扩展提案）。**2026-09-11 指针移除 + `backend-performance-review` 删除（当前口径）**：指针目录 `backend-latency-profiler-helper` 已删除（`Routes …` 指针机制从语料与代码中彻底移除）；`backend-performance-review` 整个技能已删除（其 Layer Library 一节即占该超大文件的 61%）。**现 10 个目录，全部为独立技能、无指针**：sql/caching/cwv/load-test/budget 为按触发词路由的专项；rust/swift/golang/android 为**语言分区**（按项目语言激活）；react-performance 为框架机制层。下表为来源映射（目录 ↔ 来源仓库 ↔ 源路径）；各技能正文自足，不再互指。

> **2026-09-11 判据收敛 + 事实/一致性修正**：段落级分类（约 170 段）结果 **157 本维度核心 / 3 异维度段 / 6 DUAL**——维度纯度基本达标，本轮修另外两类。(1) **异维度 3 处**：`react-performance` 的服务端鉴权段（`Server Action authorization`）本就已写成显式 handoff，未动；`No mutable module-level state in RSC/SSR` 判为 DUAL，改写为性能读法（共享模块状态破坏按请求的去重/缓存）并移交正确性读法；`Ternary over &&` 是纯输出正确性缺陷、无性能含量，已从本技能移除，该 footgun 移入 `correctness/bugsweep` 的 React 目录。(2) **无出处数字**：删掉 `golang-performance` 的"直觉约 80% 的时候是错的"（两处）、"`reflect.DeepEqual` 慢 50-200×"、"`unsafe` 需 >10% 提升"、"`GOMEMLIMIT` 取容器内存 80-90%"；`react-performance` 的"省 200-800 ms"；`backend-performance-review` 的"buffer pool 占 RAM 70-80%"；`performance-budget-setter` 模板加"仅示意形状、非推荐值"声明、CWV 表标明 Good/Poor 为 Google 官方阈值而 Target 为自定；SQL 慢查询示例的 100 ms 改标为"按本库自身分布设定"。**事实修正**：`sql-query-optimizer` 的"外键必须建索引"改为"按计划需要建索引"（InnoDB 自动建、PG 不自动，且与其自身的选择性规则一致）；其基准对比示例补上固定 `ORDER BY` 与"两查询必须返回相同结果集"的前提，原比较不可信。(3) **冲突**：`backend-performance-review` 的「绝不反射式推荐缓存/索引」核心原则与其自身附录的 Fix Roadmap 模板（"第一周加索引、开缓存、上 Redis"）正面冲突，已把模板改为每条必须携带测量证据；p95 阈值冲突（`load-test-scenario-builder`"无普适默认值" vs 其余技能的硬编码）通过让后者明确"仅示意 / 按自身基线设定"而消解。(4) 顺带标注 `golang-performance`、`react-performance` 的悬空引用（`references/*.md`、`samber/cc-*`、上游 rules/agents/commands 均未随语料分发）。口径见 `spec/docs/skills-判据收敛流程与落点清单.md`。（注：本节所涉 `backend-performance-review` 已于 2026-09-11 连同其 Layer Library 整体删除。）

| 目录 | 来源仓库 | 源路径 | 状态 | 说明 |
|---|---|---|---|---|
| `sql-query-optimizer` | patricio0312rev/skills | `db-management/sql-query-optimizer` | **独立技能（专项）** | EXPLAIN/索引/改写/压测；Data access / Datastores 层的领域特化 |
| `caching-cdn-strategy-planner` | patricio0312rev/skills | `performance/caching-cdn-strategy-planner` | **独立技能（专项）** | 多层缓存/CDN/失效策略 |
| `core-web-vitals-tuner` | patricio0312rev/skills | `performance/core-web-vitals-tuner` | **独立技能（专项）** | LCP/INP/CLS 定向改进与验证 |
| `load-test-scenario-builder` | patricio0312rev/skills | `performance/load-test-scenario-builder` | **独立技能（验证）** | 压测场景/k6/阈值/结果分析 |
| `performance-budget-setter` | patricio0312rev/skills | `architecture/performance-budget-setter` | **独立技能（护栏）** | 预算 + CI 强制 + RUM/合成监控 |
| `rust-performance-core` | [madebyhost/rust-performance-skills](https://github.com/madebyhost/rust-performance-skills) | `skills/rust-performance-core` | 独立技能（语言分区） | 按项目语言激活；写/调 Rust 热路径时加载 |
| `swift-performance-engineering` | [codeanurag/swift-performance-engineering-Skill](https://github.com/codeanurag/swift-performance-engineering-Skill) | `.` | 独立技能（语言分区） | 按项目语言激活；写/改任何 Swift/SwiftUI 代码时加载 |
| `golang-performance` | [samber/cc-skills-golang](https://github.com/samber/cc-skills-golang) | `skills/golang-performance` | **独立技能（新增，语言分区）** | 按项目语言激活；Go 热路径/分配/GC/goroutine/sync |
| `android-performance` | [skydoves/compose-performance-skills](https://github.com/skydoves/compose-performance-skills) | `audit/auditing-compose-performance` | **独立技能（新增，语言分区）** | 按项目语言激活；Jetpack Compose/Android 运行时 Measure→Diagnose→Fix→Verify 审计（配套 25 个细分技能在上游仓库，未随附） |
| `react-performance` | [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) | `skills/react-performance` | **独立技能（新增，框架机制层）** | React/Next 渲染机制层优化（hydration/memo/render 路径/流式/拆包）；CWV 是"指标层"，根因在框架层时用本技能 |

## 触发路由（选技能前先查这表）

| 用户请求 | 唯一技能 |
|---|---|
| "查询优化 / 慢查询 / 数据库性能" | sql-query-optimizer |
| "缓存策略 / CDN / 缓存失效" 设计 | caching-cdn-strategy-planner |
| "Core Web Vitals / 页面卡顿" | core-web-vitals-tuner |
| React/Next 渲染慢的**机制层**优化（hydration/memo/列表/拆包） | react-performance |
| "压测 / 容量验证" | load-test-scenario-builder |
| "性能预算 / 防回归" | performance-budget-setter |
| 写/调 Rust 或 Swift 性能敏感代码 | rust-performance-core / swift-performance-engineering（语言分区） |
| 写/调 Go 或 Android/Compose 性能敏感代码 | golang-performance / android-performance（语言分区） |
| 审代码**改没改对**（非快慢） | correctness 角色（bugsweep / fp-check / agentic-code-reasoning） |

## 角色内职责划分速记

- **专项按触发词路由**：sql / caching / cwv / load-test / budget 各自覆盖明确领域；通用后端瓶颈定位原由 `backend-performance-review` 承担，该技能已于 2026-09-11 整体删除，本角色不再有单一通用方法论入口。
- **语言分区独立于通用技能**：rust / swift / golang / android 属于"项目语言"激活维度，react-performance 属框架机制层，均不参与通用触发竞争。
