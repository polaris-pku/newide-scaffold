# Memory 对外接口完善 — 方案书（评审稿）

> 分支：`feat/memory-api-surface`　状态：**待你审核，审核通过前不再改动代码**
> 相关文档：`src/memory/memory-api-surface-plan.md`（已提交 520de0c，英文计划）；
> 本地参考（git 忽略）：`src/memory/docs/对外接口局限分析.md`、`src/memory/docs/对外接口完善计划.md`

---

## 1. 背景与目标

前后端联调时，前端对 agent memory 模块几乎只能"读"，不能"写"：
当前 `memory.*` RPC 仅 13 个，写通道只有晋升 / 市场引入 / 审核 / 退休四条，
全部依赖"先有任务 → 先有晋升产物 → 先有市场技能"的前置链条，没有任何
"从零手动写入"的通道。

**目标**：补齐 memory 对外写接口，让前端可以手动管理 Agent、技能、经验、
Persona，并打通评分反馈与 buffer 可观测，同时把生产 Agent 目录从硬编码
allowlist 改为动态（否则新建的 Agent 无法参与选人/议会/邮箱协作）。

## 2. 问题清单（已确认）

### 你提出的三点
1. 无法手动创建 / 删除 Agent（`AgentManager.createAgent` 存在但零暴露；端口层无 deleteAgent；生产目录硬编码 4 个 Agent）
2. 无法手动导入 Skill（唯一通道 `marketImport` 要求源技能已上架市场；且 `description_embedding` 必填，前端无法生成向量）
3. 无法手动修改 Persona（capabilities 明示 `update_persona: unavailable`；生产链路甚至未接入 Persona 演化，persona 创建后即冻结）

### 新发现（分析轮，共 9 项 + UX）
| # | 局限 |
|---|---|
| L1 | **用户评分链路整体缺失**：`user_rating` 字段存在但全仓零写入点，置信度无法被用户纠正 |
| L2 | 经验/技能 curation 零写入口：update/delete 在 repo 层全有实现，0 个暴露 |
| L3 | Buffer 不可见、失败不可处置：pending/dead-letter 不可查，提取失败无法重试/重新入队 |
| L4 | 列表无分页/过滤/文本检索：全量返回，经验多了前端不可用 |
| L5 | Agent 不能改名/改标签、无硬删除、无复活；退休 Agent 仍显示在列表 |
| L6 | Persona 无版本历史、无按需重新生成 |
| L7 | capabilities 声明不完整：operations 里根本没有 create/update/delete 等项，前端按声明渲染 UI |
| L8 | 生产 Agent 目录硬编码 allowlist（结构性约束，见 §3.2） |
| L9 | 一致性/幂等隐患：手动写必须走 AgentManager 门面，saveSkill 无幂等键 |
| UX | 长操作无进度；maintenance 证据无任务关联；手动写入需服务端生成 embedding；缺一键运维 |

## 3. 总体方案

### 3.1 新增 RPC（`memory.*`，共 16 个，分 7 组）
| 组 | RPC |
|---|---|
| A. Agent 生命周期 | `createAgent` / `updateAgent` / `deleteAgent` / `reactivateAgent` |
| B. Skill 管理 | `createSkill` / `updateSkill` / `deleteSkill` / `publishSkillToMarket` |
| C. Experience 管理 | `updateExperience` / `deleteExperience` |
| D. Persona | `updatePersona` / `regeneratePersona` |
| E. 评分反馈 | `rateTask`（打通 rating → confidence → buffer 最小闭环） |
| F. Buffer 可观测/重试 | `getBufferState` / `getPendingBuffer` / `retryExtraction` |
| G. 列表增强/检索 | `listSkills`/`listExperiences` 加分页过滤；`searchMemory` |

### 3.2 前置改造：Agent 目录动态化
- `MARKET_AGENT_CATALOG` 从硬编码改为 **DB 驱动 + env 种子**（启动时播种，`listAgentIds()` 为准）
- 选人（`BAgentProjectionAdapter`）、议会（`AgentBoardCouncilParticipantResolver`）、
  邮箱（facade mailbox）、stage executors 的 allowlist 改为**动态提供者**（每次使用时查询）
- 效果：`memory.createAgent` 新建的 Agent **无需重启**即可参与竞标/议会/邮箱协作

### 3.3 关键设计约束
1. **写操作服务端补全派生字段**（embedding / id / 时间戳），前端只提交业务文本
2. **写操作统一走门面**（facade 持 AgentManager / BMemoryBackendService 组合 repo+service）
3. **硬删除安全边界**：`deleteAgent` 仅允许 **retired** 状态（skills 已在退休时迁移市场，
   名下保留 experiences 随删除级联清理）；活跃 Agent 必须先 `retireAgent`
4. **capabilities 与 RPC 一一对应**，前端按声明渲染
5. **幂等**：skill 内容哈希去重、市场引入 `imported_from`、重试 `(role_id, seq, task_id)`

### 3.4 里程碑
| # | 内容 | 状态 |
|---|---|---|
| M1 | 目录动态化 + Agent 生命周期（create/update/delete/reactivate） | **代码已写（未提交），见 §4** |
| M2 | Skill / Experience 管理写入口 | 未开始 |
| M3 | Persona 手动更新 + 按需重生成 | 未开始 |
| M4 | 评分链路（rateTask） | 未开始 |
| M5 | Buffer 可观测 / 重试 | 未开始 |
| M6 | 列表过滤 / 分页 / 文本检索 | 未开始 |
| M7 | capabilities v2 + 文档 + 集成验证 | 未开始 |

## 4. 当前进度（重要：已落地但**未提交**的 M1 改动）

上一轮我按计划直接开始了 M1 实现，改动全部在工作区（未 commit）。逐项列出：

| 文件 | 改动 |
|---|---|
| `src/memory/ports/memory-repository.ts` | +`updateAgentMeta`（名称/标签）、+`deleteAgent`（级联删除） |
| `src/memory/ports/buffer-repository.ts` | +`deleteAgent`（清理 buffer 存储） |
| `src/memory/adapters/in-memory-repository.ts` | 实现 updateAgentMeta / deleteAgent（含市场池保护） |
| `src/memory/adapters/pg-memory-repository.ts` | 实现 updateAgentMeta / deleteAgent（FK ON DELETE CASCADE） |
| `src/memory/adapters/in-memory-buffer-repository.ts` | 实现 deleteAgent（静默） |
| `src/memory/adapters/file-buffer-repository.ts` | 实现 deleteAgent（`rm -rf` Agent 状态目录） |
| `src/memory/runtime/agent-manager.ts` | +`deleteAgent`（**仅 retired 可删** + 内存 map 移除） |
| `src/memory/index.ts` | 顶层导出 `AgentHandle` / `CreateAgentSpec` |
| `src/app/agent-catalog.ts`（新增） | `createAgentCatalogProvider`：动态目录提供者（剔除 retired / council_only） |
| `src/app/driver-runtime-agent-execution-facade.ts` | +`createAgent`/`updateAgent`/`deleteAgent`；mailbox `allowedRoleIds` 支持动态提供者 |
| `src/app/production-stage-executors.ts` | `bootstrapAgentIds` 支持动态提供者 |
| `src/app/production-b-runtime.ts` | `market_agent_ids` 改为 `listAgentIds()`（DB 为准） |
| `src/app/backend-rpc-stdio.ts` | 5 处 allowlist 消费点接动态目录；lifecycle 接线 |
| `src/app/b-memory-backend-service.ts` | lifecycle 端口 +3 方法；capabilities +`create_agent`/`update_agent`/`delete_agent` |
| `src/app/newide-backend-service.ts` | +3 透传方法 |
| `src/rpc/memory-methods.ts` | +`memory.createAgent` / `updateAgent` / `deleteAgent`（Zod 严格校验） |
| `test/rpc/memory-methods.test.ts` | 扩展 6 个 RPC 用例（含参数校验失败） |
| `test/council/council-participant-resolver.test.ts` | +动态提供者用例（运行时新增 Agent 可参与议会） |
| `src/memory/test/agent-lifecycle.test.ts`（新增） | repo / manager 生命周期 + 目录提供者测试 |

### 验证状态
| 项 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 通过 |
| `pnpm vitest run <M1 相关 4 个测试文件>` | ❌ **被沙箱阻断**（vite 内部 spawn 子进程报 EPERM；申请 danger-full-access 被你拒绝） |

## 5. 需要你决策的关键点

- **D1 未提交的 M1 改动怎么处理**：保留继续（在你审核通过后提交/续改）？还是 `git restore` 全部还原，从零按你审定的方案重做？
- **D2 测试运行方式**（沙箱阻断 vitest 的 spawn）：
  - a. 由你本人或 CI 运行 `pnpm test` / `pnpm verify`（我不跑测试，只跑 typecheck）
  - b. 每次跑测试时临时授权 danger-full-access 升级
  - c. 其他方式（如你在本机跑后把结果告诉我）
- **D3 硬删除安全边界**：仅允许 retired 状态 Agent 被删除（活跃 Agent 须先退休）——是否认可？
- **D4 目录动态化范围**：会改动 `src/council/council-participant-resolver.ts` 等兄弟模块接口
  （memory CLAUDE.md 允许"明确处理跨模块接口"）——是否认可？
- **D5 节奏**：每个里程碑完成即停下汇报等你确认，还是连续完成 M1–M7 后统一汇报？

## 6. 风险与依赖

- **vitest 沙箱限制**：本会话内无法独立验证测试（需你或 CI 跑）——已如实标注
- **目录动态化影响面**：选人/议会/邮箱是生产关键路径，改动有回归风险；
  本方案保持向后兼容（静态数组仍可用），并已加动态提供者单测
- **评分链路（M4）**依赖 repo 新增 `findExperiencesBySourceTask`（M2 一并落地）
- **Persona 重生成（M3）**需要后端注入 LlmClient（现 memoryMaintenance 已有 llm，可复用）

## 7. 明确不做（本期范围外）

- Buffer claim/lease 原子状态机与崩溃恢复
- Persona 版本历史持久化与回滚（本期仅 PATCH + 按需重生成）
- 事件式指标接口全量（本期只打通 rating → confidence 最小闭环）
- `memory.createExperience` 手动造经验（与提取语义冲突）
