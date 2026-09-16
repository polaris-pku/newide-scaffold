# correctness 角色 skills

> 状态：2026-09-07 完成维度重构（蓝图：`spec/docs/skills-角色维度重构蓝图.md`），同日另下载并入 2 个新技能（扩展提案：`spec/docs/skills-各维度技能扩展提案.md`）。**2026-09-11 移除 `coverage-gap-auditor`**：整体是覆盖率工具教程（含臆造的 80%/70% 阈值），与角色内 bugsweep / bug-hunter-hunter 声明的"missing tests 属 out-of-scope"正面冲突，且不服务本角色第一问。**同日剥离核心技能夹带的 security 内容**（hunter 的 security checklist 与 CWE/STRIDE、referee 的 CVSS/PoC/exploitability、bugsweep 的 security FIND 类目、fp-check 的可利用性判据、agentic-code-reasoning 的 security-audit 子模式），一律从本技能正文剥离——因为实验要求分歧可归因到维度，correctness 的 plan 必须与 security 的 plan 可区分。**同日第二轮「判据收敛」**：把判据从"话题是否沾安全"换成"**同一份代码，correctness 与 security 会不会给出同一个判断**"——会（纯异维度判据）则删，不会（同源异问，如"未校验输入流向操作"→本维度问行为是否错、安全问能否被利用）则保留行为问法、剥离可利用性问法。据此 9 个活动技能中 6 个有残留需改：`bugsweep`（反模式目录 generic 2 类 + architectural 7 条 + 7 个语言目录逐条筛选，原先 :228 已声明移交但 :236-266 仍在为这些类别预热，属自相矛盾）、`bug-hunter-skeptic`（14 条硬排除计 8 条安全类；FP 清单；**5 个校准示例全是安全类**，与 Hunter 已收敛的 in-scope 声明对不上）、`variant-analysis`（整篇 source/sink/barrier + 可利用性 triage，会把 agent 推向 security 倾向）、`fp-check`（Bug-Class Verification 8 类中 4 类纯安全）、`spec-to-code-compliance`（severity rubric 的 attacker model）、`concurrency-correctness-review`（SecurityContext 段 + 一处编造统计）；`bug-hunter-referee` 与 `agentic-code-reasoning` 首轮已干净，未动。**2026-09-11 指针移除 + `harden-recent-changes` 增补（当前口径）**：指针目录 `logic-review`、`harden-code` 已删除（`Routes …` 指针机制从语料与代码中彻底移除）；`harden-recent-changes` 作为独立技能加入——会话级加固，只审本轮改动，由 data safety / crashes / contracts 三个只读专家并行执行、最终判断归用户，自 bugsweep 原 Session Mode 拆出。**现 10 个目录，全部为独立技能、无指针**：agentic-code-reasoning（推理协议双入口）、bugsweep（猎杀管线）、bug-hunter-hunter/skeptic/referee（议会部署形态）、harden-recent-changes（会话级加固）、fp-check（单点真伪裁决）、spec-to-code-compliance（规格符合）、variant-analysis（同源变体）、concurrency-correctness-review（并发专项）。simplify-swarm 已于重构日**移至 maintainability**（清扫族宿主）。下表为来源映射（目录 ↔ 来源仓库 ↔ 源路径）；各技能正文自足，不再互指。

> **2026-09-11 第三轮「段落级判据收敛」**：对 9 个活动技能做 H2/H3 段落级分类（共 167 段），结果 **155 本维度核心 / 0 纯安全判据段 / 10 异维度段 / 2 DUAL**——前两轮剥离已生效，correctness 已无成规模污染。唯一异维度段落集中在 `concurrency-correctness-review`（10 段 Java 21/25 采用指南），本轮按"采用指南 ≠ 审查协议"判据删 8 缩 2（501→379 行；description 未改，故嵌入向量不变）；`bugsweep` 另修 4 处**行级**安全泄漏（敏感操作命名、`trust boundaries`、`documented insecurity`、React 跨用户缓存改为行为读法）；`fp-check` 修 1 处措辞。**关键副产品**：逐类核查其余四角色的承接点后发现若干内容类型**无落点**（分语言 source/sink/barrier 目录、内存破坏可利用性验证、特权转发、Java 采用指南、文档质量、覆盖率政策）——即"搬不删"只在有落点处成立。流程、分类表与缺口清单见 `spec/docs/skills-判据收敛流程与落点清单.md`。

| 目录 | 来源仓库 | 源路径 | 状态 | 说明 |
|---|---|---|---|---|
| `agentic-code-reasoning` | [KunihiroS/agentic-code-reasoning-skills](https://github.com/KunihiroS/agentic-code-reasoning-skills) | `.` | **独立技能** | 行为推理唯一协议（compare/diagnose/explain/audit-improve 证书模板）；文末 Light Entry 为单文件逻辑评审（2026-09-07 并入 logic-lens 内容） |
| `bugsweep` | [shanemhamilton/bugsweep](https://github.com/shanemhamilton/bugsweep) | `.` | **独立技能** | 全仓/计划级对抗式猎杀 + 自动修复唯一管线（Hunter→Skeptic→Referee 内置） |
| `harden-recent-changes` | [LinardsLiepenieks/honecode](https://github.com/LinardsLiepenieks/honecode) | `skills/harden-code` | **独立技能（新增 2026-09-11）** | 会话级加固：只审本轮改动，三个只读专家（data safety / crashes / contracts）并行，最终判断归用户；自 bugsweep 原 Session Mode 拆出 |
| `bug-hunter-hunter` | [codexstar69/bug-hunter](https://github.com/codexstar69/bug-hunter) | `skills/hunter` | 独立技能（议会部署形态） | 与 bugsweep 共享同一 H-S-R 协议；仅当外部 orchestrator 把三个角色拆成独立 agent 时使用 |
| `bug-hunter-skeptic` | codexstar69/bug-hunter | `skills/skeptic` | 独立技能（议会部署形态） | 同上（质疑阶段契约） |
| `bug-hunter-referee` | codexstar69/bug-hunter | `skills/referee` | 独立技能（议会部署形态） | 同上（终审契约） |
| `fp-check` | [trailofbits/skills](https://github.com/trailofbits/skills) | `plugins/fp-check/skills/fp-check` | **独立技能** | 单点真伪裁决：对"某个具体疑似缺陷"出 TRUE/FALSE POSITIVE（单人独立验证用；多人形态对应 skeptic）；可利用性判断不在此 |
| `spec-to-code-compliance` | trailofbits/skills | `plugins/spec-to-code-compliance/skills/spec-to-code-compliance` | **独立技能** | 代码 vs 规格/文档六种裁决 |
| `variant-analysis` | trailofbits/skills | `plugins/variant-analysis/skills/variant-analysis` | **独立技能** | 已知根因 → 全仓同源变体。抽象阶梯机制维度中性；本技能判据与目录是正确性的 |
| `coverage-gap-auditor` | [jeremylongshore/claude-code-plugins-plus-skills](https://github.com/jeremylongshore/claude-code-plugins-plus-skills) | `plugins/testing/test-coverage-analyzer/skills/analyzing-test-coverage` | ~~已移除（2026-09-11）~~ | 覆盖率工具教程（含臆造的 80%/70% 阈值）；与 bugsweep / bug-hunter-hunter 的"missing tests 属 out-of-scope"冲突。内容保留在 git 历史中 |
| `concurrency-correctness-review` | [decebals/claude-code-java](https://github.com/decebals/claude-code-java) | `skills/concurrency-review` | **独立技能（新增 2026-09-07）** | 并发正确性专项（race/TOCTOU/死锁/锁序/原子性）。2026-09-11 精简：删 Java 21/25 采用指南 8 段、缩 2 段到缺陷内核（默认 executor 无界建线程致 OOM；无 timeout 的 future 永久挂起） |
| `simplify-swarm` | [Sahil-SS9/hermes-simplify-swarm](https://github.com/Sahil-SS9/hermes-simplify-swarm) | `.` | ~~已移至 maintainability（2026-09-07）~~ | 清扫族宿主（light/strict/swarm 三模式），溯源见 maintainability README |

## 触发路由（选技能前先查这表；同角色技能不叠跑）

| 用户请求 | 唯一技能 |
|---|---|
| "找 bug / 审计代码 / 上线前深查 / 跑一夜自动查"（整仓或计划范围） | bugsweep（默认只检出；`--fix/--approve/--autonomous` 控制是否改） |
| "harden / 最近改动加固 / 别把数据搞丢"（只扫本轮改动） | harden-recent-changes |
| orchestrator 想拆 3 个独立 agent 做 H-S-R 分工 | bug-hunter-hunter → bug-hunter-skeptic → bug-hunter-referee |
| 指着某行问 "这是真 bug 吗"，要确认真假 | fp-check（不主动找 bug；问"可被利用吗 / 影响面多大"→ security） |
| 贴单文件/单函数含糊问 "review this / 对不对 / 测试过但线上炸" | agentic-code-reasoning → Light Entry |
| "两实现等价吗 / 哪步导致失败 / 返回什么 / 执行顺序"（小范围） | agentic-code-reasoning（证书协议深入口） |
| 已确认一个 bug，查"别处还有没有同根因的" | variant-analysis |
| "实现是否满足需求文档 / 代码做了文档没提的事" | spec-to-code-compliance |
| "审这段并发/多线程/异步代码的竞态与死锁" | concurrency-correctness-review（对高并发模块可在 bugsweep 之后追加跑） |
| 只动结构的简化/去 slop | maintainability（simplify-swarm/clean-code/refactoring/structurize…） |
| 只谈可利用性/攻击面/密钥/供应链 | security 角色 |
| 只谈快慢/资源/预算 | performance 角色 |
| 故障模式/SLO/回滚/容灾/发布就绪 | reliability 角色 |

## 角色内职责划分速记

- **猎杀家族归一**：bugsweep（单人/自动/整仓）↔ bug-hunter 三件套（多人议会）↔ harden-recent-changes（会话级轻量）= 同一 H-S-R 协议的三种部署形态，勿重复维护。
- **验证归一双轨**：fp-check（独立单点）↔ bug-hunter-skeptic（议会内质疑）同属"对抗式证伪"。
- **推理归一双入口**：agentic-code-reasoning = 深入口（证书协议）+ 轻入口（单文件评分报告）。
- 原 logic-lens 的 logic-health/locate/diff/fix-all 模式**均未单独收录**，遇到目录级/已确认失败/两版对比请求走 agentic-code-reasoning 深入口或 bugsweep。
