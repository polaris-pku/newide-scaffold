# performance 角色 skills

> 状态：2026-09-07 完成维度重构（蓝图：`spec/docs/skills-角色维度重构蓝图.md`），同日另下载并入 3 个新技能（扩展提案）。现 12 个目录：**活动 11 / 指针 1**。唯一能力 11（原 8 + 新增 3：golang-performance、android-performance、react-performance）。backend-performance-review 为通用方法论唯一入口（收编 backend-latency-profiler-helper 快速配方为附录）；sql/caching/cwv/load-test/budget 为按触发词路由的专项；rust/swift 为**语言分区**（按项目语言激活，不与通用技能并列竞争）。下表为来源映射（目录 ↔ 来源仓库 ↔ 源路径）；指针行的能力已并入宿主。

| 目录 | 来源仓库 | 源路径 | 状态 | 说明 |
|---|---|---|---|---|
| `backend-performance-review` | [Sanoy24/backend-performance-review](https://github.com/Sanoy24/backend-performance-review) | `skills/backend-performance-review` | **活动（宿主）** | evidence-first 后端性能方法论（范围→发现→负载→关键路径→分层门→瓶颈综合→报告）；文末附录 = 快速配方 |
| `backend-latency-profiler-helper` | [patricio0312rev/skills](https://github.com/patricio0312rev/skills) | `performance/backend-latency-profiler-helper` | **指针 → backend-performance-review** | 延迟埋点/慢端点初筛/三周路线图已并入宿主 Appendix |
| `sql-query-optimizer` | patricio0312rev/skills | `db-management/sql-query-optimizer` | **活动（专项）** | EXPLAIN/索引/改写/压测；= 宿主 Data access/Datastores 层检查的领域特化 |
| `caching-cdn-strategy-planner` | patricio0312rev/skills | `performance/caching-cdn-strategy-planner` | **活动（专项）** | 多层缓存/CDN/失效策略 |
| `core-web-vitals-tuner` | patricio0312rev/skills | `performance/core-web-vitals-tuner` | **活动（专项）** | LCP/INP/CLS 定向改进与验证 |
| `load-test-scenario-builder` | patricio0312rev/skills | `performance/load-test-scenario-builder` | **活动（验证）** | 压测场景/k6/阈值/结果分析 |
| `performance-budget-setter` | patricio0312rev/skills | `architecture/performance-budget-setter` | **活动（护栏）** | 预算 + CI 强制 + RUM/合成监控 |
| `rust-performance-core` | [madebyhost/rust-performance-skills](https://github.com/madebyhost/rust-performance-skills) | `skills/rust-performance-core` | 活动（语言分区） | 按项目语言激活；写/调 Rust 热路径时加载 |
| `swift-performance-engineering` | [codeanurag/swift-performance-engineering-Skill](https://github.com/codeanurag/swift-performance-engineering-Skill) | `.` | 活动（语言分区） | 按项目语言激活；写/改任何 Swift/SwiftUI 代码时加载 |
| `golang-performance` | [samber/cc-skills-golang](https://github.com/samber/cc-skills-golang) | `skills/golang-performance` | **活动（新增，语言分区）** | 按项目语言激活；Go 热路径/分配/GC/goroutine/sync |
| `android-performance` | [skydoves/compose-performance-skills](https://github.com/skydoves/compose-performance-skills) | `audit/auditing-compose-performance` | **活动（新增，语言分区）** | 按项目语言激活；Jetpack Compose/Android 运行时 Measure→Diagnose→Fix→Verify 审计（配套 25 个细分技能在上游仓库，未随附） |
| `react-performance` | [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) | `skills/react-performance` | **活动（新增，框架机制层）** | React/Next 渲染机制层优化（hydration/memo/render 路径/流式/拆包）；CWV 是"指标层"，根因在框架层时用本技能 |

## 触发路由（选技能前先查这表）

| 用户请求 | 唯一技能 |
|---|---|
| 调查延迟/吞吐/慢端点/DB 性能，要一份严谨证据化报告 | backend-performance-review（方法论正文） |
| 只想快速插桩测"哪些接口慢、列个修复计划" | backend-performance-review → Appendix（原 helper 快速配方） |
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

- **定位层唯一入口**：backend-performance-review（深度）与其 Appendix（快速）覆盖"后端瓶颈定位"全部场景；专项技能只在用户点名对应领域（SQL/缓存/前端指标/压测/预算）时单独触发。
- **语言分区独立于通用技能**：rust/swift 属于"项目语言"激活维度，不参与通用触发竞争。
