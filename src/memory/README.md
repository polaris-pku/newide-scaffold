# Memory

`src/memory` 提供基于 tool-calling 的 Agent 运行时，以及与 Agent 绑定的长期记忆和任务 Buffer。当前实现覆盖：

- Agent 注册、加载、参选声明和指定派发；
- 顶层 LLM 的多轮工具调用；
- 当前 Agent 私有 Skill / Experience 的检索；
- Driver 调用结果写入 pending Buffer；
- 离线经验提取和技能晋升；
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

`retireAgent()` 目前是空实现。运行时也没有公开的 `start()`、`stop()`、`wakeAll()` 或 `tickAll()` 调度 API；`dispatchTask()` 会在一次调用内同步跑完整个循环。

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

技能晋升候选必须同时满足：`type === 'positive'`、`confidence > 0.95`、尚未设置 `promoted_to`。是否真正生成 Skill 仍由注入的晋升实现决定。

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

### PostgreSQL

`PgMemoryRepository` 使用 PostgreSQL 和 `pgvector`。默认 `autoMigrate: true`，首次访问时会调用 `ensurePgMemorySchema()` 创建扩展、表和索引；数据库用户需要具备相应权限。默认嵌入实现是确定性的 `HashEmbeddingProvider`，用于本地开发和测试，不是语义嵌入模型。生产环境应通过 `PgMemoryRepository` 构造参数注入合适的 `EmbeddingProvider`。

## Embedding Provider 接入

嵌入向量化是经验/技能语义检索的基础。Memory 模块通过 `ports/embedding-provider.ts` 的 `EmbeddingProvider` 接口抽象，支持切换不同实现。

### 接口

```ts
interface EmbeddingProvider {
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  cosineSimilarity(a: number[], b: number[]): number;
}
```

### 实现

| 实现     | 类名                       | 用途                                                       |
| -------- | -------------------------- | ---------------------------------------------------------- |
| 哈希嵌入 | `HashEmbeddingProvider`    | FNV-1a 确定性哈希，本地开发/测试用，**不具备语义检索能力** |
| 真实嵌入 | `LiteLLMEmbeddingProvider` | 通过 Vercel AI SDK 调用 embedding API，生产环境使用        |

### LiteLLMEmbeddingProvider 配置

支持环境变量和构造参数两种方式：

```bash
# .env 或环境变量
OPENAI_API_KEY=sk-xxx              # API key
OPENAI_BASE_URL=https://api.deepseek.com/v1  # 兼容国内 API（可选）
EMBEDDING_MODEL=text-embedding-3-small      # 模型名（可选）
EMBEDDING_DIMENSIONS=1536                   # 向量维度（可选）
```

DeepSeek 用户：设置 `LLM_PROVIDER=deepseek` + `DEEPSEEK_API_KEY` 后自动映射为 `OPENAI_API_KEY` + `OPENAI_BASE_URL`。

构造参数覆盖环境变量：

```ts
const embedding = new LiteLLMEmbeddingProvider({
  apiKey: 'sk-xxx',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'text-embedding-3-small',
  dimensions: 1536,
});
```

### 注入到 PgMemoryRepository

```ts
import { LiteLLMEmbeddingProvider } from './memory';
import { PgMemoryRepository } from './memory';

const embedding = new LiteLLMEmbeddingProvider();
const repository = new PgMemoryRepository({
  pool,
  embedding, // 注入真实嵌入实现
});
```

`PgMemoryRepository` 使用注入的 `EmbeddingProvider` 进行 `searchExperiences()` / `searchSkills()` 的向量检索和余弦相似度计算。未注入时默认为 `HashEmbeddingProvider`。

### 在测试中使用

单元测试始终使用 `HashEmbeddingProvider`（确定性的 1024 维，不依赖外部 API）：

```ts
import { HashEmbeddingProvider } from './memory';
const embedding = new HashEmbeddingProvider();
```

集成测试可见 `test/integration/embedding-smoke.test.ts`，它使用 `LiteLLMEmbeddingProvider` 验证：

- `embed()` 返回正确维度的向量
- 相同文本的 `cosineSimilarity` 等于 1
- 相似文本的相似度高于不相关文本

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

`src/memory/test/integration/agent-loop-via-bridge.test.ts` 和 `src/memory/test/integration/real-agent-e2e.test.ts` 使用 `CliDriverRuntime`（`test/drivers/cli-driver-runtime.ts`）包装本地 CLI（Claude/Kimi）为 A 侧 `DriverRuntimeHandle`，通过 `DriverBridge` 转换为 `DriverReturn`，走完整的 A→B 侧管线。这些测试依赖本地 CLI 命令和 API key，不满足条件时自动跳过。

> **注意**：`test/drivers/` 下的 `cli-driver-runtime.ts` 和 `llm-driver.ts` 是 Memory 模块**内部集成测试专用**的辅助实现，只负责在单模块测试中模拟 Driver 调用链路。**其他模块（Coordinator、Council、Hook/Gate 等）使用 Driver 时无需 import 这些文件**，应通过 `src/driver/` 模块的正式接口（`DriverRuntimeHandle`、`DriverBridge`、`CommandDriverTransport` 等）接入。

其余测试使用内存仓库和 Mock 客户端，不需要外部服务。

## 目录结构

```text
	memory/
	  adapters/   Repository、LLM、检索、策略等端口实现
	  ports/      存储、LLM、提取、查询等接口
	  prompts/    Agent、上下文清理、经验提取和技能晋升 Prompt
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

当前嵌入实现的已知问题：

- 默认 `HashEmbeddingProvider` 使用 FNV-1a 确定性哈希生成向量，**不具备语义搜索能力**，仅适用于本地开发和测试；
- 经验提取器（`llm-experience-extractor.ts`、`rule-based-experience-extractor.ts`）中 embedding 硬编码为 `[0.1, 0.2, 0.3]` 占位值；
- `LiteLLMEmbeddingProvider` 已可用（基于 Vercel AI SDK），但未集成到 `LiteLLMClientAdapter` 的统一路由中，需独立配置 embedding API key 和模型。

后续目标是将 embedding 能力统一到 LiteLLM 配置体系，通过 YAML 路由和共享 API key 管理嵌入模型。

### 3. Driver 未真实接入

`InvokeDriverTool` 是对外部 `DriverHandler` 函数（`(task) => DriverReturn`）的简单包装，**没有真正的 Driver 运行时**。接入方需要自行实现 Driver 适配器，处理实际的 ACP/PTY 集成、Driver 会话管理、流式结果等。当前 `invoke_driver` 工具的回调由 `createAgentRuntime()` 的 `tools.driver` 或 `AgentManager.create()` 的 `tools.tools` 注入，本质上仍是 mock 行为。

> **测试用临时方案**：`src/memory/test/drivers/llm-driver.ts` 提供了一个基于本地 `claude` CLI 的简单 `DriverHandler` 实现，用于集成测试。它不适用于生产环境，仅用于在缺少真实 Driver 时验证 Agent → Driver 的完整调用链路。

### 4. Agent 生命周期管理不完整

`AgentManager.retireAgent()` 当前为**空实现**（仅含 `// TODO` 注释），调用后不会执行任何清理操作（如移除 Agent 状态、释放资源、通知存储层等）。退役 Agent 的完整生命周期管理尚未实现。

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

### 10. PG + File 组合的集成测试缺失

当前 `PgMemoryRepository` 和 `FileBufferRepository` 各有独立的单元测试，但**没有**同时使用 PG + File 的组合集成测试（即 `createAgentRuntime({ storage: { pg: {...}, agentStateRoot: '...' } })` 跑完整 Agent loop 的测试）。生产环境使用 PG + File 时，Agent 从 dispatchTask 到写 Buffer 的完整链路没有自动化回归覆盖。

### 11. PG Repository 测试未纳入 CI

`pg-memory-repository.test.ts` 整个测试套件在缺少 `MEMORY_PG_TEST_URL` 环境变量时**完全跳过**（使用 `describe.skip`）。由于 CI 环境通常不提供 PostgreSQL 实例，这些测试从未在 CI 中运行，`PgMemoryRepository` 的回归无法被自动化捕获。
