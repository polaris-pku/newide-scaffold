# correctness 角色 skills

> 状态：2026-09-07 完成维度重构（蓝图：`spec/docs/skills-角色维度重构蓝图.md`），同日另下载并入 2 个新技能（扩展提案：`spec/docs/skills-各维度技能扩展提案.md`）。现 12 个目录：**活动 10 / 指针 2**。唯一能力 7（原 5 + 新增 2：coverage-gap-auditor、concurrency-correctness-review）：code-reasoning 推理协议（agentic-code-reasoning，收编 logic-review 轻入口）、bugsweep 猎杀管线（收编 harden-code 会话模式；bug-hunter 三件套为其议会部署形态）、fp-check 单点真伪裁决、spec-to-code-compliance 规格符合、variant-analysis 同源变体。simplify-swarm 已于重构日**移至 maintainability**（清扫族宿主）。下表为来源映射（目录 ↔ 来源仓库 ↔ 源路径）；指针行的能力已并入宿主（见宿主新增章节与各指针文件），蒸馏说明仍以各指针/宿主 Provenance 为准。

| 目录 | 来源仓库 | 源路径 | 状态 | 说明 |
|---|---|---|---|---|
| `agentic-code-reasoning` | [KunihiroS/agentic-code-reasoning-skills](https://github.com/KunihiroS/agentic-code-reasoning-skills) | `.` | **活动（宿主）** | 行为推理唯一协议（compare/diagnose/explain/audit-improve 证书模板）；收编 logic-review 为「Light Entry」双入口 |
| `logic-review` | [hyhmrright/logic-lens](https://github.com/hyhmrright/logic-lens) | `skills/logic-review` | **指针 → agentic-code-reasoning** | 单文件/单函数逻辑评审（五字段 + 0-100 分）已并入宿主 Light Entry 章节 |
| `bugsweep` | [shanemhamilton/bugsweep](https://github.com/shanemhamilton/bugsweep) | `.` | **活动（宿主）** | 全仓/计划级对抗式猎杀 + 自动修复唯一管线（Hunter→Skeptic→Referee 内置） |
| `harden-code` | [LinardsLiepenieks/honecode](https://github.com/LinardsLiepenieks/honecode) | `skills/harden-code` | **指针 → bugsweep（会话模式）** | 原属 reliability；"最近改动加固"（崩溃/数据丢失/契约）已并入 bugsweep Session Mode |
| `bug-hunter-hunter` | [codexstar69/bug-hunter](https://github.com/codexstar69/bug-hunter) | `skills/hunter` | 活动（议会部署形态） | 与 bugsweep 共享同一 H-S-R 协议；仅当外部 orchestrator 把三个角色拆成独立 agent 时使用 |
| `bug-hunter-skeptic` | codexstar69/bug-hunter | `skills/skeptic` | 活动（议会部署形态） | 同上（质疑阶段契约） |
| `bug-hunter-referee` | codexstar69/bug-hunter | `skills/referee` | 活动（议会部署形态） | 同上（终审契约） |
| `fp-check` | [trailofbits/skills](https://github.com/trailofbits/skills) | `plugins/fp-check/skills/fp-check` | **活动** | 单点真伪裁决：对"某个具体疑似 bug/漏洞"出 TRUE/FALSE POSITIVE（单人独立验证用；多人形态对应 skeptic） |
| `spec-to-code-compliance` | trailofbits/skills | `plugins/spec-to-code-compliance/skills/spec-to-code-compliance` | **活动** | 代码 vs 规格/文档六种裁决 |
| `variant-analysis` | trailofbits/skills | `plugins/variant-analysis/skills/variant-analysis` | **活动** | 已知根因 → 全仓同源变体（可被 security 审计复用） |
| `coverage-gap-auditor` | [jeremylongshore/claude-code-plugins-plus-skills](https://github.com/jeremylongshore/claude-code-plugins-plus-skills) | `plugins/testing/test-coverage-analyzer/skills/analyzing-test-coverage` | **活动（新增 2026-09-07）** | 测试覆盖缺口审计：diff 路径 → 已有测试映射 → 未覆盖清单与补测建议（测试充分性维度，区别于 spec 符合/找 bug） |
| `concurrency-correctness-review` | [decebals/claude-code-java](https://github.com/decebals/claude-code-java) | `skills/concurrency-review` | **活动（新增 2026-09-07）** | 并发正确性专项（race/TOCTOU/死锁/锁序/原子性）；= bugsweep 的深度并发补充通道 |
| `simplify-swarm` | [Sahil-SS9/hermes-simplify-swarm](https://github.com/Sahil-SS9/hermes-simplify-swarm) | `.` | ~~已移至 maintainability（2026-09-07）~~ | 清扫族宿主（light/strict/swarm 三模式），溯源见 maintainability README |

## 触发路由（选技能前先查这表；同角色技能不叠跑）

| 用户请求 | 唯一技能 |
|---|---|
| "找 bug / 审计代码 / 上线前深查 / 跑一夜自动查"（整仓或计划范围） | bugsweep（默认只检出；`--fix/--approve/--autonomous` 控制是否改） |
| "harden / 最近改动加固 / 别把数据搞丢"（只扫本轮改动） | bugsweep → Session Mode（原 harden-code） |
| orchestrator 想拆 3 个独立 agent 做 H-S-R 分工 | bug-hunter-hunter → bug-hunter-skeptic → bug-hunter-referee |
| 指着某行问 "这是真 bug 吗 / 可被利用吗"，要确认真假 | fp-check（不主动找 bug） |
| 贴单文件/单函数含糊问 "review this / 对不对 / 测试过但线上炸" | agentic-code-reasoning → Light Entry |
| "两实现等价吗 / 哪步导致失败 / 返回什么 / 执行顺序 / 是否安全"（小范围） | agentic-code-reasoning（证书协议深入口） |
| 已确认一个 bug，查"别处还有没有同根因的" | variant-analysis |
| "实现是否满足需求文档 / 代码做了文档没提的事" | spec-to-code-compliance |
| "哪些路径没被测试锁住 / diff 的测试覆盖够吗" | coverage-gap-auditor |
| "审这段并发/多线程/异步代码的竞态与死锁" | concurrency-correctness-review（对高并发模块可在 bugsweep 之后追加跑） |
| 只动结构的简化/去 slop | maintainability（simplify-swarm/clean-code/refactoring/structurize…） |
| 只谈可利用性/攻击面/密钥/供应链 | security 角色 |
| 只谈快慢/资源/预算 | performance 角色 |
| 故障模式/SLO/回滚/容灾/发布就绪 | reliability 角色 |

## 角色内职责划分速记

- **猎杀家族归一**：bugsweep（单人/自动/整仓）↔ bug-hunter 三件套（多人议会）↔ harden-code（会话级轻量）= 同一 H-S-R 协议的三种部署形态，勿重复维护。
- **验证归一双轨**：fp-check（独立单点）↔ bug-hunter-skeptic（议会内质疑）同属"对抗式证伪"。
- **推理归一双入口**：agentic-code-reasoning = 深入口（证书协议）+ 轻入口（单文件评分报告）。
- 原 logic-review 路由到的 logic-health/locate/diff/fix-all 与本语料的 bugsweep 内嵌模式**均未单独收录**，遇到目录级/已确认失败/两版对比请求改走宿主深入口或 bugsweep。
