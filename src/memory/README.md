# Memory

`src/memory` 提供基于 tool-calling 的 Agent 运行时，以及与 Agent 绑定的长期记忆和任务 Buffer。当前实现覆盖：

- Agent 注册、加载、参选声明和指定派发；
- 顶层 LLM 的多轮工具调用；
- 当前 Agent 私有 Skill / Experience 的检索；
- Driver 调用结果写入 pending Buffer；
- 离线经验提取、技能晋升和 Persona 演化；
- 内存、文件和 PostgreSQL 存储适配器；
- 面向 Coordinator 和前端的查询契约。

本模块不负责选择竞标赢家，不提供后台任务调度器，也不会在任务完成后自动执行经验提取或技能晋升。

## 当前执行链路

`Agent` 目前只有 tool-calling 执行模式。创建 `AgentManager` 时必须提供实现了 `ToolCallingClient` 的 LLM：

```text
dispatchTask(role_id, task)
  -> Agent.executeTask(task)
  -> LLM.completeWithTools(...)
  -> 调用 query_memory / invoke_driver / 自定义工具
  -> LLM 返回完成文本，或达到 maxToolCalls
  -> 写入一条 pending Buffer
  -> 返回 DispatchTaskResult
```

`AgentManager` 会为每个 Agent 自动注册一个绑定其 `role_id` 的 `query_memory` 工具。`invoke_driver` 只有在调用方提供 `InvokeDriverTool` 或在 `createAgentRuntime()` 中配置 `tools.driver` 时才存在。

任务完成通过文本启发式判断，例如回复包含 `task complete`、`finished`、`[done]`、`任务完成` 或 `已完成`。默认最多执行 20 轮。LLM 未调用 `invoke_driver` 时仍会写入占位 Buffer，但派发状态为 `no_driver_invocation`。

在线链路只负责写 Buffer：

```text
pending Buffer
  -> ExperienceExtractorProcessor
  -> ExperienceRecord
  -> SkillPromotionProcessor
  -> SkillRecord
```

两个 Processor 没有内置定时器或 worker，调用方需要自行决定何时运行。`ExperienceExtractorProcessor` 处理成功后会把 Buffer 从 `pending` 移到 `processed`；技能晋升独立扫描已经保存的 Experience。

## 快速开始

以下示例使用内存存储和一个确定性的 `ToolCallingClient`，不需要数据库或 API key：

```ts
import {
  AgentManager,
  InMemoryBufferRepository,
  InMemoryRepository,
  InvokeDriverTool,
  toMemoryTaskProjection,
  type ToolCallingClient,
} from './memory';

const repository = new InMemoryRepository();
const buffers = new InMemoryBufferRepository();

let round = 0;
const llm: ToolCallingClient = {
  async completeWithTools() {
    round += 1;
    if (round === 1) {
      return {
        content: null,
        tool_calls: [
          {
            id: 'driver_call_1',
            type: 'function',
            function: {
              name: 'invoke_driver',
              arguments: JSON.stringify({ instruction: '实现并验证登录页窄屏布局修复' }),
            },
          },
        ],
      };
    }
    return { content: '任务完成 [done]', tool_calls: undefined };
  },
};

const driver = new InvokeDriverTool(async (task) => ({
  artifacts: [{ type: 'patch', path: 'src/login.tsx', summary: task.instruction }],
  summary: '已完成窄屏布局修复并通过验证。',
  decisions: [],
  blockers: [],
  referenced_experiences: [],
  assumptions: [],
}));

const manager = await AgentManager.create(repository, buffers, {
  tools: { llm, tools: [driver] },
});

await manager.createAgent({
  role_id: 'role_frontend',
  name: 'Frontend Developer',
  tags: ['frontend', 'typescript'],
});

const task = {
  task_id: 'task_001',
  call_id: 'call_001',
  source_driver: 'example-driver',
  spec: '修复登录页在窄屏下的布局问题，并说明验证方式。',
};

const claims = await manager.collectCompetitionClaims(task);
const selected = claims.claims[0]; // 赢家由上层选择

if (selected) {
  const result = await manager.dispatchTask(selected.role_id, task);
  console.log(result.status, toMemoryTaskProjection(result));
}
```

注意：Manager 当前没有开放 `CompetitionClaimEvaluator` 注入项。默认 evaluator 会让所有可用 Agent 返回 `participate`；`collectCompetitionClaims()` 只保留这些声明并按 `role_id` 排序。能力评分和赢家选择仍由上层实现。

## 公开入口

统一导出位于 `src/memory/index.ts`。

### Agent 运行时

| API                                                | 当前行为                                                     |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `AgentManager.create(repo, buffers, options)`      | 创建 Manager，并加载仓库中已有的 Agent；`options.tools` 必填 |
| `manager.createAgent(spec)`                        | 初始化持久化数据、Buffer 目录和运行时 Agent                  |
| `manager.collectCompetitionClaims(task, options?)` | 并行收集声明，只返回 `participate` 项，不执行任务            |
| `manager.dispatchTask(role_id, task)`              | 同步运行 tool-calling 循环并写 pending Buffer                |
| `manager.getAgent(role_id)`                        | 返回当前进程中的 `Agent` 实例                                |
| `manager.listAgentHandles()`                       | 返回所有已加载 Agent 的持久化句柄                            |
| `toMemoryTaskProjection(result)`                   | 生成供 Council / 前端使用的稳定任务投影                      |
| `createAgentRuntime(config)`                       | 按配置选择存储并装配 Manager、Driver 和附加工具              |

`dispatchTask()` 当前实际会返回 `completed`、`no_driver_invocation`、`blocked` 或 `failed`。类型中还保留了 `cancelled`、`max_rounds_exceeded` 等状态，但当前实现没有对应返回分支；达到最大轮次后会完成循环，再按是否调用 Driver 返回状态。

`retireAgent(role_id, options?)` 执行优雅退休（draining → 资产处置 → retired），可选创建替代 Agent（clean_slate / seeded_slate）；对已退休 Agent 幂等。运行时没有公开的 `start()`、`stop()`、`wakeAll()` 或 `tickAll()` 调度 API；`dispatchTask()` 会在一次调用内同步跑完整个循环。

### 工具

| API                                                        | 作用                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `AgentQueryMemoryTool`                                     | 运行时的 `query_memory` 工具；Manager 会自动为每个 Agent 注入                                    |
| `InvokeDriverTool`                                         | 把外部 `DriverHandler` 包装成 `invoke_driver` 工具                                               |
| `ToolRegistry`                                             | 注册工具并转换为 OpenAI function-calling 定义                                                    |
| `DeepSeekToolCallingClient`                                | （已废弃）内置的 DeepSeek/OpenAI 兼容 tool-calling 客户端，推荐迁移到 `LiteLLMToolCallingClient` |
| `LiteLLMToolCallingClient`                                 | 基于 LiteLLM + Vercel AI SDK 的 tool-calling 客户端，支持多 Provider 和 YAML 模型路由            |
| `QueryMemoryTool` / `SaveMemoryTool` / `createMemoryTools` | 另一套基于 `MemoryStore` 的 LiteLLM 工具，不参与 `AgentManager` 的自动注入                       |

`LiteLLMClientAdapter` 实现普通文本补全接口 `LlmClient`，用于上下文清理、经验提取和技能晋升等 LLM 适配器；它不实现 `ToolCallingClient`，不能直接作为顶层 Agent LLM。

### Buffer 后处理

| API                                                    | 作用                                                      |
| ------------------------------------------------------ | --------------------------------------------------------- |
| `ExperienceExtractorProcessor.extractAll(memory)`      | 提取所有 pending Buffer、保存 Experience 并标记 processed |
| `ExperienceExtractorProcessor.checkAndExtract(memory)` | 先检查 `BufferTriggerPolicy`，满足条件后执行提取          |
| `SkillPromotionProcessor.promoteAll(memory)`           | 晋升所有符合条件的 Experience                             |
| `SkillPromotionProcessor.checkAndPromote(memory)`      | 先检查 `PromotionTriggerPolicy`，满足条件后执行晋升       |
| `processPendingBuffer(memory, seq, input)`             | 对单条 Buffer 执行“提取 + 晋升 + processed”旧式组合流程   |
| `extractBuffer(memory, seq, llm)`                      | 使用 LLM 提取并保存，但不会把 Buffer 标记为 processed     |
| `promoteExperiences(memory, llm)`                      | 使用 LLM 扫描并晋升当前 Agent 的合格 Experience           |
| `reviewSkill(repository, { role_id, skill_id, decision, reviewer })` | 对 pending 状态 Skill 做人工审批（approved / rejected 严格状态机，拒绝时清除来源经验 promoted_to） |

技能晋升候选必须同时满足：`type === 'positive'`、`confidence > 0.95`、尚未设置 `promoted_to`。是否真正生成 Skill 仍由注入的晋升实现决定。

这里的 `SkillPromotionProcessor` 与维护通道里的 **Skill 晋升 Job**（见「Skill 晋升 Job」一节）不是同一套：Processor 是同步的、由调用方在 Buffer 流程里直接调；job 是带 claim/lease、批上限与 run 审计的批量外壳。新接入的调度器应当用 job。

**触发策略与降级**：`checkAndExtract` / `checkAndPromote` 在**执行前**用策略端口评估是否触发——`BufferTriggerPolicy`（`BatchBufferTriggerPolicy`：pending ≥3 / 最老 ≥6h / 含 ineffective；`AlwaysExtractPolicy`：无条件）+ `PromotionTriggerPolicy`（`DefaultPromotionTriggerPolicy`：eligible ≥5 / 高信 >0.98 / 距上次 ≥24h）。两个 Processor 均无内置调度器，**触发方是外部调用者**（后台 Worker / 定时器 / 前端主动）。LLM 版提取/晋升/归纳（`LlmExperienceExtractor` / `LlmSkillPromotion` / `LlmPersonaInduction`）内部在 LLM 失败或空结果时**降级到规则版**（`RuleBasedExperienceExtractor` / `ruleBasedSkillPromotion` / `ruleBasedPersonaInduction`），规则版仅作兜底，主线全走 LLM。

### Persona 演化

| API                                                    | 作用                                                      |
| ------------------------------------------------------ | --------------------------------------------------------- |
| `PersonaEvolutionProcessor.evolveAll(memory)`          | 手动触发 Persona 归纳（无条件，version++）                |
| `PersonaEvolutionProcessor.checkAndEvolve(memory)`     | 先检查 `PersonaTriggerPolicy`，满足条件后触发归纳         |
| `ruleBasedPersonaInduction(memory, input)`             | 规则版归纳（内部调 `memory.savePersona` 写入）            |
| `LlmPersonaInduction(llm).induce(memory, input)`       | LLM 版归纳，失败降级规则版                                |
| `DefaultPersonaTriggerPolicy`                          | 技能增长 ≥3 / ≥7 天定期（有新经验）/ ≥30 天强制刷新       |
| `savePersona(persona)`（`AgentMemoryScope` / `MemoryRepository`） | Persona 写入 API，同步 `AgentHandle.persona`   |

Persona 演化与 Agent 解耦：Agent 只读 `getPersona()`，演化由外部主动触发；演化后新 Persona 从下一次 `buildAgentSystemPrompt` 生效。版本处理为简单覆盖 version++（不保留历史）。漂移-余弦门控 / 技能收缩门控待 drift-embedding 能力，属 future work。

上表是**同步**那条路径（Processor + 归纳实现）。带 claim/lease、版本条件写、输入快照与 run 审计的
**批量维护 job** 是另一条：见「Persona 演化 Job（Memory Maintenance Phase 4）」。两条路径的产物都是
`PersonaDef`（版本 +1），差别在于谁来触发、依据什么判、以及重复执行会不会多出一个版本。

### 查询和跨模块契约

- `RepositoryAgentBoardQuery`：提供 `listAgents()`、`getAgent()`、`listSkills()` 和 `listExperiences()` 只读查询。
- `RepositoryMemoryProvider`：实现 Coordinator 使用的 `MemoryProvider.buildContextPack()`。
- `MockMemoryProvider`：不接仓库的测试实现。
- `contract.ts`：定义 `ContextPack`、`MemoryPolicy`、`BuildContextPackInput` 和 `MemoryProvider`。
- `schemas.ts`：定义并校验 `AgentHandle`、`PersonaDef`、`DriverReturn`、`BufferSnapshot`、`ExperienceRecord`、`SkillRecord` 等持久化实体。

## 存储

长期记忆和任务 Buffer 使用两个独立端口：

| 端口               | 内存实现                   | 持久化实现             | 内容                                                    |
| ------------------ | -------------------------- | ---------------------- | ------------------------------------------------------- |
| `MemoryRepository` | `InMemoryRepository`       | `PgMemoryRepository`   | Agent、Persona、Metrics、Skill、Experience 和向量检索   |
| `BufferRepository` | `InMemoryBufferRepository` | `FileBufferRepository` | pending、processed、dead-letter Buffer 和可选上下文快照 |

`createAgentMemoryScope(repository, buffers, role_id)` 把两个仓库绑定到单个 Agent，供工具、Processor 和服务层使用。

### PostgreSQL / 嵌入式 PGlite

`PgMemoryRepository` 使用 PostgreSQL 和 `pgvector`，但只依赖最小 `SqlPool` 端口，
因此同一个仓库实现可对接两种引擎：

- **外部 PostgreSQL**：`NEWIDE_B_DATABASE_URL` 指向自托管/云托管（Neon、Supabase、RDS）实例；
- **嵌入式 PGlite**：不设置 `NEWIDE_B_DATABASE_URL` 时，`createProductionBRuntime` 自动使用
  `PGlitePool`（WASM PostgreSQL + pgvector），进程内运行、零安装、无需 Docker，
  数据持久化到 `<appStateRoot>/b/pglite`（可用 `NEWIDE_B_PGLITE_DATA_DIR` 覆盖，`:memory:` 表示内存）。

两者共享同一套 SQL 与 `ensurePgMemorySchema()` 建表逻辑。默认 `autoMigrate: true`，首次访问时自动建表；
数据库用户需要具备相应权限。默认嵌入实现是确定性的 `HashEmbeddingProvider`，用于本地开发和测试，
不是语义嵌入模型。生产环境应通过 `PgMemoryRepository` 构造参数注入合适的 `EmbeddingProvider`。

### 文件 Buffer

`FileBufferRepository({ agentStateRoot })` 使用以下布局：

```text
{agentStateRoot}/{role_id}/buffer/
  buffer_meta.json
  pending/
    report_{seq}.json
    context_{seq}.json     # 可选
  processed/
  dead_letter/
```

`role_id` 不能包含 `/`、`\\` 或 `..`。

### 运行时工厂

`createAgentRuntime()` 的存储选择规则如下：

- 提供 `storage.pg`：使用 `PgMemoryRepository`，否则使用 `InMemoryRepository`；
- 提供 `storage.agentStateRoot`：使用 `FileBufferRepository`，否则使用 `InMemoryBufferRepository`；
- 提供 `tools.driver`：自动包装成 `InvokeDriverTool`；
- `query_memory` 始终由 Manager 在加载或创建 Agent 时注入。

```ts
const manager = await createAgentRuntime({
  storage: {
    pg: { connectionString: process.env.DATABASE_URL },
    agentStateRoot: './agent-state',
  },
  llm: toolCallingClient,
  tools: {
    driver: async (task) => runDriver(task),
    additional: [],
  },
});
```

`DeepSeekToolCallingClient` 从构造参数或 `DEEPSEEK_API_KEY` 读取密钥，默认模型为 `deepseek-chat`，默认地址为 `https://api.deepseek.com`。它本身不读取 `.env` 文件；需要由应用启动层加载环境变量。

## Skill 晋升 Job（Memory Maintenance Phase 3）

`DefaultSkillPromotionJob` 是独立的晋升 job：批量扫描 Experience 候选、逐条问策略、按结论落库
（写 Skill / 只记结论 / 记拒绝），失败按退避重投或进死信。它与上面「Buffer 后处理」里的
`SkillPromotionProcessor` 是**两条不同的路径**——Processor 是同步的、由调用方在 Buffer 流程里
直接调的旧式组合；job 是带 claim/lease、批上限与 run 审计的批量外壳，供调度器独立触发。两条
都没有内置定时器。

### 配置策略

策略实现 `PromotionStrategy`（`version` / `config` / `evaluate`），默认实现 `DefaultPromotionStrategy`：

| 配置项 | 含义 | 缺省 |
| --- | --- | --- |
| `version` | 策略版本，**判据的一部分**（见「为什么不会重复晋升」） | `promotion-threshold.v1` |
| `min_confidence` | 置信度门槛，判据是**严格大于** | `0.95` |
| `min_referenced_count` | 被引用次数门槛 | `0`（不设门槛） |
| `min_age_ms` | 时间窗口 | `0`（不设窗口） |
| `min_user_rating` | 来源用户评分门槛（`resolved` / `partially_resolved` / `unresolved` / `not_rated`） | `null`（不设门槛） |
| `approval` | `manual_review`：判定合格只记 `pending_review`；`auto_approve`：判定合格即写 Skill | `manual_review` |

三个「有代价的开关」（引用次数 / 时间窗口 / 用户评分）缺省都是关的——打开会让晋升更晚发生，
必须是显式的。`min_confidence` 与 `services/skill-promotion.ts` 的 `PROMOTION_CONFIDENCE_THRESHOLD`
同值同判据（严格大于），两条路径对同一条经验不会给出相反结论。

阈值只在策略对象上；批量与运行上限在 job 侧：

| 参数 | 位置 | 缺省 |
| --- | --- | --- |
| 批量上限 | `jobOptions.batch_size`，`run({ batchSize })` 覆盖 | `DEFAULT_SKILL_PROMOTION_BATCH_SIZE`（20） |
| 墙钟上限 | `jobOptions.max_duration_ms`，`run({ maxDurationMs })` 覆盖 | `DEFAULT_SKILL_PROMOTION_MAX_DURATION_MS`（60s） |
| 租约时长 | `jobOptions.lease_ms` | `DEFAULT_DELIVERY_LEASE_MS`（60s） |
| 重试预算 | `DEFAULT_PROMOTION_RETRY_POLICY`：5 次投递，30s 起指数退避，上限 15min | job 没有覆盖项；要改用 repository 的 `claimNextPromotionCandidate` / `failPromotion` 请求上的 `policy` |

**策略版本是一道断言，不是开关**：`run({ strategy_version })` 与注入策略的 `version` 不一致时
job 拒绝启动（抛错），且在开 run **之前**拒绝——审计里记下的版本必须就是真正判定用的那一个。

### 手动跑一次

```ts
import { DefaultSkillPromotionJob, DefaultPromotionStrategy } from './memory';

const job = new DefaultSkillPromotionJob({
  repository,               // MemoryRepository
  runStore,                 // MaintenanceRunStore
  strategy: new DefaultPromotionStrategy({ approval: 'auto_approve' }),
  worker_id: 'cron-skill-promotion',
  role_id: 'role_frontend', // 省略则跨 role
  batch_size: 20,
});

const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());

const result = await job.run({
  batchSize: 50,          // 覆盖 job 配置
  approval: 'auto_approve',
  dryRun: false,
  restoreExpired: true,   // 缺省 true：跑之前先把过期租约放回队列
  signal: controller.signal,
});

result.stop_reason; // no_work | batch_size | max_duration | aborted | worker_error
result.counts;      // claimed / completed / retried / dead_letter / skipped / failure
result.outcomes;    // 逐条：status、decision、failure、skill_id、warnings
```

- **优雅停止**（`signal`）只影响「要不要再 claim 下一条」：在途的那条照常跑完。停止判据固定按
  「停止信号 → 到量 → 超时」的顺序判断。
- **`restoreExpired: false`** 只是少做一次「跑之前先捞一遍」的扫描，不是让过期持有卡住：
  claim 自己会回收过期租约。
- **`dryRun: true`** 照常筛候选、照常问策略，但**不 claim、不写任何状态**，连启动恢复都不做；
  结论只作为投影留在 `outcomes` 里（每条带 `Dry run:` 开头的 warning），run 的六个计数**一律为 0**
  ——一次什么都没写的运行不该在吞吐指标里留下数字。演练同样做判定契约校验，一份自相矛盾的
  判定记成 `failed`，不会伪装成 promoted / pending_review / rejected 里的任何一个。

### 查一次晋升运行

run 记在注入的 `MaintenanceRunStore` 上，`job_type` 是 `skill_promotion`：

```ts
const runs = await runStore.list({ job_type: 'skill_promotion', worker_id: 'cron-skill-promotion' });
const run = await runStore.get(result.run.run_id);
```

`MaintenanceRun` 的字段：`run_id` / `job_type` / `status`（`running` / `completed` / `failed`）/
`worker_id` / `started_at` / `finished_at`（终止态才有）/ 六个计数 / `audit`（可选，见下一节）/
`last_error`。

- **`status: 'completed'` 不代表这一批全都晋升了**：一次「3 条晋升、1 条死信」的运行是正常的运行，
  它说的是「外壳自己没出故障」。逐条的成败看计数。
- **`failed` 只有一种成因**：外壳自己读不动存储（例如 claim 抛错）。候选自己的失败不会把 run
  标成 failed。
- `last_error` 是给人看的一句话：优先写最后一条带失败的候选（`role_id/experience_id: code: message`），
  没有候选失败时才写外壳自己的故障。
- 逐条的诊断面在 `result.outcomes` 里、不落 run：`decision`（策略判了什么）、`failure`（规范化
  失败码与可重试性）、`skill_id`、`warnings`。run 只留计数与一句结论。
- 策略版本**不在晋升的 run 记录上**：它在 `result.strategy_version` 与每条 Experience 的
  `promotion.strategy_version` 上。`MaintenanceRun` 上有一格通用的 `audit` 承载这类事实，但
  **晋升这条通道目前不写它**（写它的是 Persona 演化，见下一节），因此读晋升的 run 时 `audit`
  是缺席。

### `pending_review` 怎么办

`approval: 'manual_review'` 下判定合格的候选落成 `pending_review`：**不写任何 Skill**，只把结论
记在经验的晋升标记上。它不会永远等下去——后续一次 `auto_approve` 的运行会把同一条候选**重新
评估**并晋升：

```ts
await job.run({ approval: 'manual_review' }); // → pending_review，不写 Skill
await job.run({ approval: 'manual_review' }); // 同一模式再跑：不重复 claim 已判过的
await job.run({ approval: 'auto_approve' });  // → 重新评估，这一次写出 Skill
```

四种状态怎么区分（`promotionStateLabel(experience)` 把存储上的两列派生出一个词）：

| 标签 | 存储上的形状 | 含义 | 谁来推进 |
| --- | --- | --- | --- |
| `pending_review` | `status='processed'` + `outcome='pending_review'` | 判定合格，等人工放行 | 下一次 `auto_approve` 运行 |
| `retryable` | `status='pending'` + `attempt_count > 0` | 上次失败，等退避到期 | 自动（退避窗口过后） |
| `processing` | `status='processing'` | 正被某个 worker 持有 | 持有者；租约过期后由恢复/claim 回收 |
| `dead_letter` | `status='dead_letter'` | 用满次数或不可重试 | **只由人工** `retryDeadLetterPromotion` |

### 失败与死信

失败一律带规范化分类（`code` + `message` + `retryable`），落盘在经验的 `promotion.last_error` 上，
同时出现在 `outcome.failure` 与 run 的 `last_error` 里。

| 情形 | 分类 | 去向 |
| --- | --- | --- |
| 连接 / 超时类 errno | `downstream_unavailable` | 退避重投 |
| 其余未知 | `unknown` | 退避重投（有上限） |
| Agent 不在了 | `delivery_missing` | 死信 |
| 载荷解析不了 / 策略判定违反契约 | `payload_unreadable` | 死信 |
| 权限、路径类 errno / 技能引用不成立 | `storage_error` | 死信 |
| Skill 写了、经验没回写 | `storage_error`（显式可重试） | 退避重投，复用同一条 Skill |
| 用满 `max_attempts`（可重试也一样） | —— | 死信 |

**死信只由人工放回**，自动路径不会再碰它：

```ts
const revived = await repository.retryDeadLetterPromotion({ role_id, experience_id, now });
```

排查看三处：经验标记上的 `last_error`（最近一次的原因）、`attempt_count`（投递了几次）、
`strategy_version`（上一次结论按哪一版判据落的）。判定契约错误还在错误对象上带稳定标识
（`contract_code` / `violation` / `expected` / `actual`），聚合「策略到底错在哪」时读它们，
不要读 message 文本。

### 为什么不会重复晋升

三条独立的防线，缺一条都会攒出重复技能：

1. **幂等键 `(role_id, promoted_from)`**：一条经验最多对应一条技能，由存储的唯一约束保证
   （Pg 是部分唯一索引，内存实现走同一份判据）。写入走 `saveSkillIfAbsent()`：命中已有条目就
   原样返回它并报 `created: false`，不新建、不覆盖、不重复计数。
2. **两段写的顺序**：先写 Skill、再回写经验。第二步失败时整条重投，重投会在第一步命中同一条
   Skill——「同一 Experience 不产生第二条 Skill」的依据在这里，而不是靠调用方记住上一轮写过什么。
   经验的 `promoted_to` 与晋升结论由 `completePromotion()` **一次**条件写落定，因此不存在
   「Skill 已存在、经验还没绑上」这个可被读到的中间态。
3. **claim token fencing**：每次 claim 发一个新 token，`completePromotion()` / `failPromotion()`
   都要求原样带回。token 不匹配、租约过期或状态已变，写回**什么都不做**（返回 `undefined`）——
   落盘的责任归当前持有者，旧持有者盖不掉新持有者的结论。

多 worker 并发跑同一批时，同一条候选只会被一个 worker claim 到（claim 是条件写），因此技能数
不变，也不会出现两条经验绑到同一个 Skill。

### 后端支持边界

| 后端 | Skill Promotion | 说明 |
| --- | --- | --- |
| `InMemoryRepository` | 支持 | **测试用途**。它不假装持久化——进程重启等于清空 |
| `PgMemoryRepository`（PGlite 或外部 PostgreSQL） | 支持，**生产用这个** | 晋升状态嵌在 Experience 载荷里；幂等键是 `memory_skills.promoted_from` 上的部分唯一索引 |
| File 适配器 | **不支持完整 Skill Promotion** | 缺 `FileMemoryRepository`，见下 |

**File 后端当前不支持 Skill Promotion，缺的是 `FileMemoryRepository`。** 三个 File 适配器实现的是
另外三个端口——`FileBufferRepository`（Buffer）、`FileMemoryDeliveryRepository`（交付 / 反馈 outbox）、
`FileMaintenanceRunStore`（run 审计）。晋升要的读写面（`claimNextPromotionCandidate` /
`completePromotion` / `saveSkillIfAbsent` / `listSkills` …）长在 `MemoryRepository` 上，而
`MemoryRepository` 只有 InMemory 与 Pg 两个实现。生产装配正是这样混用的：Buffer 走
`FileBufferRepository`，经验与技能那半边接 `PgMemoryRepository`。

因此 **`FileMaintenanceRunStore` 只负责 run 审计，不能当晋升存储用**。把 File 适配器接进
`DefaultSkillPromotionJob` 在类型层就不通过（相对端口缺 35 个成员），运行时也会如实收成
`worker_error` / `run.status='failed'`，不会退化成看起来健康的空跑。这条边界由
`test/file-maintenance-boundary.test.ts` 钉住。

### 架构边界

- **没有改在线 Driver API**，也没有新增前端接口：晋升不经过 RPC 面，调用方是进程内的维护 runner。
- **Context consumer 不触发晋升，Feedback consumer 也不触发**：四条维护通道各自独立，靠调度器
  分别触发；`scheduleBuffer()` 只登记交付项。
- **晋升仍由独立 job 触发**：`DefaultSkillPromotionJob.run()` 是唯一入口，它不调用上面两条通道，
  也不被它们调用。
- **Persona 演化是另一条通道**：见下一节「Persona 演化 Job（Memory Maintenance Phase 4）」。
  两条通道互不调用，也都不调用上面那两条消费者；把任一条 job 接进调度器（谁在什么时候跑它）
  属于后续阶段。

## Persona 演化 Job（Memory Maintenance Phase 4）

`DefaultPersonaEvolutionJob` 是独立的演化 job：按**角色**claim 一条演化流，把该角色已批准 /
已生效的技能与已落定的经验算成一份输入快照，问策略这次该不该演化出一版新 Persona，按结论落库
（写新版本 / 只记待审核 / 记拒绝），失败按退避重投或进死信。

它与上面「公开入口 · Persona 演化」里的 `PersonaEvolutionProcessor` 是**两条不同的路径**：
Processor 是同步的、由调用方直接调的旧式组合（策略与 handler 构造注入，配 `PersonaTriggerPolicy`）；
job 是带 claim/lease、父版本条件写与 run 审计的批量外壳，供调度器独立触发。两条都没有内置定时器。
判定那一步走的是**判定端口** `PersonaEvolutionStrategy`——计划 §11 说的是「调用
`PersonaEvolutionProcessor` **或等价领域服务**」，默认策略自己从快照算正文（复用规则版归纳的
两段文案逻辑），因此这条通道既不依赖 Processor，也不依赖它那条同步链路。

### 输入范围

判定**只能**依据 claim 那一刻从库里读出来并算好的输入快照。快照只收两类事实：

| 来源 | 参与演化 | 排除 |
| --- | --- | --- |
| 技能 | `review_status='approved'` 且 `market_status≠'superseded'` | 等人工审核的（`pending`）、已被拒的（`rejected`）、已被取代的 |
| 经验 | 从未评估过（没有 `promotion` 标记）、`processed` + `promoted`、`processed` + `rejected` | `processing`（别人正在改）、投递过又退回队列的、`dead_letter`、`processed` + `pending_review`（还没被批准） |

技能的判据与**技能检索的资格过滤逐字一致**（「一条技能算不算这个 Agent 的能力」在这个模块里
只有一个答案），`rejected` 的经验参与是刻意的：「不适合晋升为技能」是关于**晋升**的判断，不是
「这条经验无效」，Persona 本来就同时描述正经验与负经验。

快照的 hash 覆盖它的全部内容（按 `id` 升序，字段用不可打印分隔符拼成规范串再 sha256），
**当前 Persona 不在快照里**——它是产物，算进 hash 会让「演化出一版」本身改变输入，于是下一次
运行必然算出新 hash、必然再演化一版，永远收敛不了。反馈聚合（已归并条数 / 平均置信度 / 最近
时刻）由**参与演化的那些经验**自己推导，不读 `AgentMetrics.avg_confidence`（那是全量聚合，会让
判定被一批它看不到的经验左右）；没有反馈痕迹时它是**缺席而不是 0**，策略要么不设反馈门槛、
要么显式拒绝。上一次的结论另作历史喂给策略（`last_evolution`），它必须在重评**重置标记之前**
读出来——重评的第一步就是把结论字段清掉。

### 配置策略

策略实现 `PersonaEvolutionStrategy`（`version` / `config` / `evaluate`），默认实现
`DefaultPersonaEvolutionStrategy`：

| 配置项 | 含义 | 缺省 |
| --- | --- | --- |
| `version` | 策略版本，**判据的一部分**（见「为什么相同 snapshot 不会重复生成 Persona」） | `persona-threshold.v1` |
| `approval` | `manual_review`：判定合格只记 `pending_review`；`auto_approve`：判定合格即写出新版本 | `manual_review` |
| `min_approved_skills` | 已批准技能条数门槛 | `0`（不设门槛） |
| `min_experiences` | 可参与演化的经验条数门槛 | `0`（不设门槛） |
| `min_average_confidence` | 反馈质量门槛；`null` 表示不设门槛**且不要求反馈聚合存在** | `null` |

三个门槛缺省都是关的——它们是有代价的开关（会让演化更难发生），打开必须是显式的。缺省审核模式
是**人工审核**：不得默认绕过人工。阈值只在策略对象上，批量与运行上限在 job 侧：

| 参数 | 位置 | 缺省 |
| --- | --- | --- |
| 批量上限 | `jobOptions.batch_size`，`run({ batchSize })` 覆盖 | `DEFAULT_PERSONA_EVOLUTION_BATCH_SIZE`（20） |
| 墙钟上限 | `jobOptions.max_duration_ms`，`run({ maxDurationMs })` 覆盖 | `DEFAULT_PERSONA_EVOLUTION_MAX_DURATION_MS`（60s） |
| 租约时长 | `jobOptions.lease_ms` | `DEFAULT_DELIVERY_LEASE_MS`（60s） |
| 重试预算 | `DEFAULT_PERSONA_EVOLUTION_RETRY_POLICY`：5 次投递，30s 起指数退避，上限 15min | job 没有覆盖项；要改用 repository 的 `claimNextPersonaEvolutionCandidate` / `failPersonaEvolution` 请求上的 `policy` |

**策略版本是一道断言，不是开关**：`run({ strategy_version })` 与注入策略的 `version` 不一致时
job 拒绝启动（抛错），且在开 run **之前**拒绝——审计里记下的版本必须就是真正判定用的那一个。
`run({ approval })` 是运行时值，同样在开 run 前校验合法性：放过去的话，一个拼错的模式会被计划
当成「人工审核」，本该自动演化的运行静默地一件都不做。

### 手动跑一次

```ts
import { DefaultPersonaEvolutionJob, DefaultPersonaEvolutionStrategy } from './memory';

const job = new DefaultPersonaEvolutionJob({
  repository,               // MemoryRepository
  runStore,                 // MaintenanceRunStore
  strategy: new DefaultPersonaEvolutionStrategy({ approval: 'auto_approve' }),
  worker_id: 'cron-persona-evolution',
  role_id: 'role_frontend', // 省略则跨角色（候选就是一个角色一条演化流）
  batch_size: 20,
});

const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());

const result = await job.run({
  batchSize: 50,          // 覆盖 job 配置
  approval: 'auto_approve',
  dryRun: false,
  restoreExpired: true,   // 缺省 true：跑之前先把过期租约放回队列
  signal: controller.signal,
});

result.stop_reason; // no_work | batch_size | max_duration | aborted | worker_error
result.counts;      // claimed / completed / retried / dead_letter / skipped / failure
result.outcomes;    // 逐条：status、decision、input_snapshot_hash、parent_version、persona_version、failure、skip_reason、warnings
```

- **优雅停止**（`signal`）只影响「要不要再 claim 下一条」：在途的那条照常跑完。停止判据固定按
  「停止信号 → 到量 → 超时」的顺序判断。
- **`dryRun: true`** 照常筛候选、照常算快照与判定，但**不 claim、不写任何状态**，连启动恢复都
  不做。它与真跑的分工是：真跑是「claim 一条看一条」，演练按 `listAgentIds()` 逐角色读、算、判，
  因此**连跳过都报得出来**（`skip_reason`：`already_evolved_for_snapshot` /
  `evaluated_under_current_strategy` / `waiting_for_manual_review` / `in_flight` / `not_due` /
  `dead_letter` / `attempts_exhausted`）。演练的 `batchSize` 只算「真跑会 claim 的」那些，跳过行
  不占名额。run 的六个计数**一律为 0**——一次什么都没写的运行不该在吞吐指标里留下数字。演练的读
  **不是原子的**（真跑是，因为那是 claim 的语义），因此它是一份投影，不是快照。
- **`restoreExpired: false`** 只是少做一次「跑之前先捞一遍」的扫描，不是让过期持有卡住：
  claim 自己会回收过期租约。

### 查一次演化运行

run 记在注入的 `MaintenanceRunStore` 上，`job_type` 是 `persona_evolution`：

```ts
const runs = await runStore.list({ job_type: 'persona_evolution', worker_id: 'cron-persona-evolution' });
const run = await runStore.get(result.run.run_id);
```

字段与晋升同形（`run_id` / `status` / `worker_id` / `started_at` / `finished_at` / 六个计数 /
`last_error`），**外加一格结构化审计 `audit`**。`status: 'completed'` 不代表这一批都演化了——它
说的是「外壳自己没出故障」；逐条看计数与 `outcomes`。`failed` 只有一种成因：外壳自己读不动存储。
`last_error` 是给人看的一句话：优先写最后一条带失败的角色（`role_id: code: message`）。

`audit` 是给定这次运行的事实，形状是对象而不是拼好的一句话（要能被聚合，而不是只能被人读）：

| 字段 | 含义 |
| --- | --- |
| `strategy_version` / `approval` / `dry_run` | 这次真正生效的判据、审核模式，以及是否只是演练 |
| `input_snapshot.digest` | 覆盖本次全部候选的稳定 digest（逐候选 hash 排序后聚合；没处理候选时缺席） |
| `input_snapshot.candidate_count` / `counts` | 处理了几个候选（演练时是「考虑过几个」）、各通道自己的输入规模合计（`skills` / `experiences`） |
| `parent_version_range` | 本次处理到的候选所依据的父版本范围（最小 / 最大） |
| `parent_conflict_count` | 本次运行里被父版本条件写挡下的次数合计 |
| `candidates[]` | 逐候选摘要：`candidate_id`（就是 role）、`input_snapshot_hash`、`parent_version`、`result_version`、`input_counts`、`outcome`、`parent_conflict_count` |

为什么要在 run 上再记一份：演化标记（上面那张状态表）是**活状态**，下一次演化会把它覆盖掉，
于是「上一次用的是哪一版判据、哪份输入」就没了；run 记录只写不改，`run_id` 因此能事后自证。
策略版本在**开跑时就先落一次**（不是等收尾），因此一条跑到一半被杀的 run 也说得清这件事。
审计的字段全部可选，旧 run 读作缺席——**缺席就是缺席**，不会被填成 0 或空对象。

反过来，演化自己那份**当前**状态在角色的演化标记上（`personaEvolutionStateLabel` 把存储上的两列
派生出一个词）：

| 标签 | 存储上的形状 | 含义 | 谁来推进 |
| --- | --- | --- | --- |
| `evolved` / `pending_review` / `rejected` | `status='processed'` + 同名 `outcome` | 已出结论 | —— |
| `retryable` | `status='pending'` + `attempt_count > 0` | 上次失败，等退避到期 | 自动（退避窗口过后） |
| `processing` | `status='processing'` | 正被某个 worker 持有 | 持有者；租约过期后由恢复 / claim 回收 |
| `dead_letter` | `status='dead_letter'` | 用满次数或不可重试 | **只由人工** `retryDeadLetterPersonaEvolution` |
| `unevaluated` | 没有标记，或退回队列且从未投递过 | 还没人碰过 | 下一次运行 |

除状态外，标记上还留着这一版是怎么来的：`parent_version` → `persona_version`、`strategy_version`、
`input_snapshot_hash`、`source_run_id`、`evaluated_at`、`reasons`、`change_summary`、`reviewed_by`。
标记是**当前**那一版的说法，会被下一次演化覆盖；**那一次运行**用的是哪一版判据与哪份输入，看 run
记录上的 `audit`（同一批事实在开跑时就先落了一次，见上一节）。

### `pending_review` 怎么办

`approval: 'manual_review'` 下判定合格的角色落成 `pending_review`：**不写 Persona**，只把结论记在
标记上。它不会永远等下去——后续一次 `auto_approve` 的运行会**重新评估**并写出新版本：

```ts
await job.run({ approval: 'manual_review' }); // → pending_review，不写 Persona
await job.run({ approval: 'manual_review' }); // 同一模式再跑：不重复 claim 已判过的
await job.run({ approval: 'auto_approve' });  // → 重新评估，这一次写出 v+1
```

查「有哪些在等放行」：把每个角色的标记读出来按 `personaEvolutionStateLabel(marker) === 'pending_review'`
过滤即可，不需要另一张队列表——状态是派生的（生命周期 + 结论两列算出来），不是又一个要对账的字段。

### 失败与死信

失败一律带规范化分类（`code` + `message` + `retryable`），落盘在标记的 `last_error` 上，同时出现
在 `outcome.failure` 与 run 的 `last_error` 里。分类比晋升多一维——**是判定那一层抛的，还是存储
那一层抛的**：这条通道的判定允许调模型，而两边抛出来的异常在形状上没有区别，因此由调用点显式
传、不猜。

| 情形 | 分类（码 / 可重试） | 去向 |
| --- | --- | --- |
| 判定违反契约（形状 / 结论 / 角色 / 版本 / 父版本 / 快照 / 数组 / 结论与审核模式配对） | `malformed_decision`（`payload_unreadable` / 否） | 死信——同一次判定重投多少次都是同一份 |
| 判定抛出且通用分类说可重试 | `model_failure`（`model_error` / 是） | 退避重投 |
| 判定抛出且通用分类说不可重试（含权限、路径类 errno） | `policy_failure`（`policy_rejected` / 否） | 死信——策略在声明「这份输入我不判」 |
| 父版本已经不是当前版本 | `storage_conflict`（`storage_error` / 是） | 退避重投（重投会重新读再判） |
| 归属 Agent 不在了 | `missing_input`（`delivery_missing` / 否） | 死信 |
| 其余存储异常 | `storage_failure`（`storage_error` / 是） | 退避重投（有上限，用满进死信） |

**死信只由人工放回**，自动路径不会再碰它（清零投递次数＝再给满额机会）：

```ts
const revived = await repository.retryDeadLetterPersonaEvolution({ role_id, now });
```

排查看三处：标记上的 `last_error`（最近一次的原因）、`attempt_count`（投递了几次）、
`strategy_version` + `input_snapshot_hash`（上一次结论按哪一版判据、依据哪份输入落的）。判定契约
错误还在错误对象上带稳定标识（`contract_code` / `violation` / `expected` / `actual`），聚合「策略
到底错在哪」时读它们，不要读 message 文本。

### 为什么相同 snapshot 不会重复生成 Persona

四条独立的防线，缺一条都会攒出重复版本（或永远停不下来）：

1. **幂等键 `(role_id, input_snapshot_hash, strategy_version)`** 判「要不要做这件事」。
   `parent_version` **刻意不在键里**：演化成功后父版本就从 v1 变成 v2，把它放进键等于每次重跑都
   算「新键」→ 永远产出新版本。父版本改当**写回的前置条件**（下一条）。
2. **父版本条件写**：`completePersonaEvolution()` 在**同一次原子写**里要求「凭据成立」且「写回
   那一刻的 `persona.version` 等于这次判定依据的那一版」。第二次调用时标记已经不是 `processing`
   （或 token 已换），因此什么都不写。
3. **claim token fencing**：每次 claim 发一个新 token，落在结论与落失败都要求原样带回。token
   不匹配、租约过期或状态已变，写回**什么都不做**——落盘的责任归当前持有者，旧持有者盖不掉新
   持有者的成果。
4. **判定层再确认一次**：即使因为「策略版本变了」而被放行重评（`reevaluate_then_claim`），默认
   策略还会拿 `last_evolution` 比一次输入快照，同一份输入明确回 `no_new_input` 拒绝。于是
   「换了判据」只会多问一次，**不会多产出一个版本**；标记记下「这份输入在 v2 判据下也是这个
   结论」，后续运行按 `evaluated_under_current_strategy` 跳过——判据换过一次就收敛。

多 worker 并发跑同一个角色时，同一条演化流只会被一个 worker claim 到（claim 是条件写），因此
版本号只前进一版。

### 父版本冲突怎么办

`parent_conflict` 不是失败，是「这份判定已经过期」：别的 worker 先写了一步，或前端 PATCH / 旧的
归纳入口改了 Persona（它们不经过这条通道，因此不会更新演化标记）。处置是**绝不覆盖**——这一条
结果记 `storage_conflict` 退回队列，重投会重新读、重算快照、重判一次。反复冲突说明有东西在持续
改同一个角色的 Persona，那时次数会用满并进死信，需要人看一眼。

### 后端支持边界

| 后端 | Persona 演化 | 说明 |
| --- | --- | --- |
| `InMemoryRepository` | 支持 | **测试用途**。它不假装持久化——进程重启等于清空 |
| `PgMemoryRepository`（PGlite 或外部 PostgreSQL） | 支持，**生产用这个** | 演化标记是 `memory_agents.persona_evolution`（可空 JSONB），条件写用一条带 `IS NOT DISTINCT FROM` 谓词的 UPDATE 兑现 |
| File 适配器 | **不支持** | 缺 `FileMemoryRepository`，与 Skill Promotion 同一个缺口 |

**File 后端不支持 Persona 演化**：演化要的读写面（`claimNextPersonaEvolutionCandidate` /
`completePersonaEvolution` / `restoreExpiredPersonaEvolutionClaims` …）长在 `MemoryRepository` 上，
而它只有 InMemory 与 Pg 两个实现。把 File 适配器接进 `DefaultPersonaEvolutionJob` 在类型层就不
通过，运行时也会如实收成 `worker_error` / `run.status='failed'`，不会退化成看起来健康的空跑。
边界由 `test/file-maintenance-boundary.test.ts` 钉住（两条通道各钉一遍）。

**验证边界**：演化的双后端契约跑在 `InMemoryRepository` 与 **PGlite**（嵌入式 WASM PostgreSQL）
上，因此 CI 里那条腿始终真的在跑；**外部 PostgreSQL 未验证**（`MEMORY_PG_TEST_URL` 未设置），与
Phase 3 的边界相同。真 LLM 版的策略也没有——默认策略是纯规则阈值，执行内核的 `model_failure`
路径只用「会抛错的策略替身」验过。

### 架构边界

- **没有改在线 Driver API**，也没有新增前端接口：演化不经过 RPC 面，调用方是进程内的维护 runner。
- **Context consumer 不触发演化，Feedback consumer 也不触发**：四条维护通道各自独立，
  `scheduleBuffer()` 只登记交付项、在线反馈只登记进反馈 outbox。
- **Experience 提取、Skill Promotion、Persona Evolution 由外部调度系统分别独立触发**：演化只读
  已经持久化的技能、经验与反馈结果，不调用它们，也不被它们调用（三条通道之间没有一条同步边）。
  这条「没有」由 `test/persona-evolution-barrel-exports.test.ts` 的绊线钉住：通道自己的模块不许
  import 两条消费者、Buffer / 交付 outbox、Skill Promotion 或在线装配，`src/app` 里也不许出现它。
- **调度器接线属于后续阶段**：`DefaultPersonaEvolutionJob` 目前没有任何生产构造点，`run()` 是唯一
  入口。

## 测试

在仓库根目录运行：

```bash
pnpm test -- src/memory/test
pnpm test -- src/memory/test/dispatch-task.test.ts
pnpm typecheck
pnpm lint
```

`src/memory/test/integration/agent-loop-integration.test.ts` 使用真实 DeepSeek API；没有 `DEEPSEEK_API_KEY` 时会跳过。`api-smoke.ts` 是可直接运行的真实 LLM 冒烟脚本：

```bash
pnpm exec tsx src/memory/test/integration/api-smoke.ts
```

`src/memory/test/integration/agent-loop-with-real-driver.test.ts` 使用本地 `claude` CLI 作为真实 Driver，与 `LiteLLMToolCallingClient`（Agent LLM）组合运行完整的 tool-calling 循环，验证 `invoke_driver` 调用能返回结构化 `DriverReturn`。需要本地安装 `claude` 命令和有效的 `DEEPSEEK_API_KEY`，不满足条件时自动跳过。

其余测试使用内存仓库和 Mock 客户端，不需要外部服务。

## 目录结构

```text
	memory/
	  adapters/   Repository、LLM、检索、策略等端口实现
	  ports/      存储、LLM、提取、查询等接口
	  prompts/    Agent、上下文清理、经验提取、技能晋升和 Persona 归纳 Prompt
	  runtime/    Agent、Manager、Tool 和离线 Processor
	  services/   Buffer 写入、记忆检索和后处理服务
	  mvp/        早期演示与 Mock 实现，不能代表当前运行时入口
	  test/       单元测试、集成测试和测试工具
	    drivers/          真实 LLM Driver 实现（供集成测试使用）
	    integration/      端到端集成测试（需 API key）
	  contract.ts 跨模块契约
	  schemas.ts  Zod 持久化数据结构
	  index.ts    统一公开导出
```

判断当前可用能力时，以 `index.ts` 的导出、`ports/` 的接口、运行时实现和测试为准；`docs/` 与 `mvp/` 中的设计稿或早期示例可能尚未同步。

## 有待实现的问题

当前实现已知的遗留问题和限制：

### 1. DeepSeekToolCallingClient 的遗留问题

`DeepSeekToolCallingClient` 是顶层 Agent tool-calling 的唯一实现，但它直接调用 DeepSeek API，不走 `LiteLLMClient` 的统一路由。这意味着：

- 需要单独配置 `DEEPSEEK_API_KEY`，无法复用 LiteLLM 的 provider 机制；
- `LiteLLMClientAdapter` 只实现了 `LlmClient`（文本补全），**不实现** `ToolCallingClient`，不能直接作为顶层 Agent LLM。

后续目标是将 tool-calling 能力合并到 `LiteLLMClientAdapter`，实现单一 LLM 适配器同时支持文本补全和工具调用。

### 2. EmbeddingProvider 的遗留问题

当前的嵌入实现有以下不足：

- 默认 `HashEmbeddingProvider` 使用 FNV-1a 确定性哈希生成向量，**不具备语义搜索能力**，仅适用于本地开发和测试；
- 经验提取器（`llm-experience-extractor.ts`、`rule-based-experience-extractor.ts`）中 embedding 硬编码为 `[0.1, 0.2, 0.3]` 占位值；
- `PgMemoryRepository` 需要注入真正的 `EmbeddingProvider` 才能在生产环境进行语义检索；
- `LiteLLMClientAdapter` 未实现嵌入接口，无法使用 LiteLLM 统一管理嵌入模型。

后续应通过 `LiteLLMClient` 的嵌入能力或独立嵌入服务实现真正的语义嵌入。

### 3. Driver 未真实接入

`InvokeDriverTool` 是对外部 `DriverHandler` 函数（`(task) => DriverReturn`）的简单包装，**没有真正的 Driver 运行时**。接入方需要自行实现 Driver 适配器，处理实际的 ACP/PTY 集成、Driver 会话管理、流式结果等。当前 `invoke_driver` 工具的回调由 `createAgentRuntime()` 的 `tools.driver` 或 `AgentManager.create()` 的 `tools.tools` 注入，本质上仍是 mock 行为。

> **测试用临时方案**：`src/memory/test/drivers/llm-driver.ts` 提供了一个基于本地 `claude` CLI 的简单 `DriverHandler` 实现，用于集成测试。它不适用于生产环境，仅用于在缺少真实 Driver 时验证 Agent → Driver 的完整调用链路。

### 4. 退休检测管线不完整

`AgentManager.retireAgent()` 已实现优雅退休（状态迁移 + 资产处置 + 可选替代 Agent），Metrics 采集也已接入 `collectCompetitionClaims`（竞标）与 `dispatchTask`（任务结果）。但 week3 RFC 的**三层退休检测管线**（统计扫描 → Persona 漂移 → 全面评估）尚未实现——当前只有 `evaluateRetirementSignals()` 这个轻量统计层，调用方（维护 runner / 定时器）需要自行决定何时触发退休。Persona 漂移（`persona_drift`）字段也尚未被 Persona 演化填充。

### 5. 任务完成检测是简单启发式

`Agent.isTaskComplete()` 使用简单的字符串匹配（如 `"task complete"`、`"任务完成"`、`"[done]"`）判断 LLM 是否完成任务。这种方式：

- **误报**：回复中意外包含上述关键词会导致任务提前终止；
- **漏报**：LLM 表达了完成意图但未使用这些短语会导致无限循环（直到 `maxToolCalls`）；
- 注释中已标注"后续可优化为 LLM 判断"。

### 6. CompetitionClaimEvaluator 不可注入（应改为 LLM 参选）

当前参选机制的问题与改进方向：

- `AgentManagerOptions` 未暴露 `CompetitionClaimEvaluator` 配置项，始终使用默认的 `createMockCompetitionClaimEvaluator('participate')`，即所有可用 Agent 返回 `participate`，无法体现 Agent 的能力差异；
- **后续目标**：让每个 Agent 调用自己的 LLM 判断任务是否匹配其 persona / skill，自主决定参选或弃权。这与顶层 tool-calling LLM 可以是同一个实例，也可使用不同的轻量模型；
- 竞争声明的 `confidence` 和 `rationale` 字段为占位值（标注"待 bid 模块对齐"），待 LLM 参选落地后可填充 LLM 给出的置信度和推理过程；
- 能力评分和赢家选择完全由上层实现，Manager 本身不参与决策。

### 7. 离线 Processor 无内置调度

`ExperienceExtractorProcessor` 和 `SkillPromotionProcessor` 的 `extractAll()` / `promoteAll()` 方法需要调用方**手动触发**。当前没有内置定时器、cron 表达式或 worker 线程。调用方需要自行决定运行频率和策略（如任务完成后触发、定时轮询、事件驱动等）。

### 8. 派发状态变体未完全实现

`DispatchTaskResult.status` 的类型定义中包含 `'cancelled'` 和 `'max_rounds_exceeded'`，但当前实现中这两个分支**从不返回**。达到 `maxToolCalls` 后循环正常结束，最终状态取决于是否调用了 `invoke_driver`，而非进入 `max_rounds_exceeded` 分支。`cancelled` 状态尚无对应的取消机制。

### 9. `extractBuffer()` 不标记 Buffer 为 processed

`extractBuffer()` 使用 LLM 提取经验并保存，但**不会**把 Buffer 从 `pending` 标记为 `processed`。这与 `processPendingBuffer()` 的行为不一致——后者在保存经验后会更新 Buffer 状态。调用方如果不了解这一区别，反复调用 `extractBuffer()` 会导致同一条 Buffer 被重复提取。

### 10. PG + File 组合集成测试需 DB 环境

`PgMemoryRepository` + `FileBufferRepository` 的组合集成测试已存在（`src/memory/test/integration/pg-file-integration.test.ts`，跑 `AgentManager` 在双仓库组合下的完整流程），但整个套件在缺少 `MEMORY_PG_TEST_URL` 时**自动跳过**（见问题 #11）。由于 CI 通常不提供 PostgreSQL，该组合链路在生产 CI 中未自动化运行。

### 11. PG Repository 测试未纳入 CI

`pg-memory-repository.test.ts` 整个测试套件在缺少 `MEMORY_PG_TEST_URL` 环境变量时**完全跳过**（使用 `describe.skip`）。由于 CI 环境通常不提供 PostgreSQL 实例，这些测试从未在 CI 中运行，`PgMemoryRepository` 的回归无法被自动化捕获。

### 12. Skill Promotion 与 Persona Evolution 都不支持 File 后端

维护通道里需要 `MemoryRepository` 的两条通道——Skill Promotion（Phase 3）与 Persona Evolution（Phase 4）——都只能跑在实现了该端口的存储上，而现有实现只有 `InMemoryRepository`（测试用）与 `PgMemoryRepository`（生产用），**没有 `FileMemoryRepository`**。`FileBufferRepository` / `FileMemoryDeliveryRepository` / `FileMaintenanceRunStore` 分别是 Buffer、交付 outbox 与 run 审计存储，任何一个都不能当晋升或演化存储用：把 File 适配器接进 `DefaultSkillPromotionJob` 或 `DefaultPersonaEvolutionJob` 在类型层就不通过（前者相对端口缺 35 个成员），运行时也会如实收成 `worker_error` / `run.status='failed'`，不会退化成看起来健康的空跑。这条边界由 `test/file-maintenance-boundary.test.ts` 钉住（两条通道各一遍），详见「Skill 晋升 Job」与「Persona 演化 Job」两节的「后端支持边界」。若要让纯 File 部署也能晋升或演化，需要单独批准一个 FileMemoryRepository 的实现计划——本阶段刻意没有临时实现它。

顺带一条同源的边界：晋升与演化契约目前都只在 **PGlite** 上执行。外部 PostgreSQL 那条腿（`pg-memory-repository.test.ts`）不含这两条通道的用例，且缺 `MEMORY_PG_TEST_URL` 时整份跳过（见问题 #11）。
