# 角色分歧实验（编码任务）

同任务、同 base model 下，让 5 个质量维度角色分别**生成 plan**、**评审 plan**，观察分歧出现在哪些决策维度上。

差异来源**只有**每个角色 `role_id` 作用域的记忆（skills / experiences / persona）。任务定义性信息（repo、问题陈述）对所有角色逐字一致。只取**问题陈述**，只产 plan / 评审——不跑测试、不打补丁、不 checkout 仓库。

上游设计与规模见 `spec/multiagent-disagreement-coding-role-diversity.md`。

---

## 与旧实验的区别（别混淆）

远端 `feat/eval-role-diversity-prompts` 上另有一套**同名但机制相反**的实验：它把角色提示硬写进任务指令、用 `B0`（记忆关闭）、用 32 维 hash 向量，隔离的是**提示词**效应。

本目录隔离的是**记忆**效应：真实种子角色、记忆开启、1024 维真实向量。两者的 `run.ts` 核心不共用。

---

## 执行链路

```
run.create → coordinator → facade 组装 DriverContext（技能全文，无截断）
           → 顶层 Agent（persona + 检索记忆 + 工具）
           → InvokeDriverTool → ACP 编码 Driver → 写出 plan.md / review.md
```

记忆注入是被测对象本身，所以 `memory_ablation` 固定 **B2**（`include_skills` 开）。代码里对此有硬断言：写成 B0/B1 会直接报错，而不是静默跑出一个无效实验。

**driver 工作区是空 scratch 目录**（`<result_root>/workspaces/<cell_id>/`），只放产出文件。因此 plan 基于问题陈述，不掺入仓库状态这个干扰变量。

**工作区与结果根都必须落在仓库之外**（默认 `../role-divergence-runs/`）。原因是实测出来的：driver 是个有完整 Bash 的编码 agent，早先把工作区放在 `.newide/` 下（仓库目录树内部）时，它 `pwd` 一照就知道自己在仓库里，随后执行了 ——

```
git log --oneline -5; git status | head -20      # 拿到 skills/<维度>/*/SKILL.md 路径清单
cd <repo> && find . -maxdepth 4 -iname "*dask*"  # 在仓库里找数据
cat experiment-config.json; ls -la cells/        # 读实验配置与格子目录
ls -la <另一个格子的 workspace>                   # 读到别的角色的 plan
```

两条要害因此被打穿：**角色隔离**（任何角色的 driver 都能 `cat` 任意维度的技能，绕过记忆系统）与**格子独立性**（交叉评审的审者能直接读到被审 plan，匿名化与打乱作废）。挪到仓外切断的是**发现路径**——`git status` 在仓外直接失败，`cells/`、`experiment-config.json`、别格 workspace 都不在可达相对路径上。

**但挪位置只是削弱，不是隔离**。实测过：把结果根挪到 `spec/` 下之后，driver 改成**往上走**，`ls -la ../../workspaces/`、`ls -la ../../../role-divergence-runs/` 一路读到 `experiment-config.json`、`summary.json`、`cells.jsonl`，甚至读了自己那格的 `run-summary.json`；再上一层是 `spec/`，`newide-scaffold` 作为兄弟目录可见（该轮轨迹里出现 12 次）。**往上走总能到**，摆位置解决不了。

### 真正生效的闸门：workspace 内的 `.claude/settings.json`

driver 侧**没有** ACP 沙箱实现。核对过：`acp-client-prototype` 的 driver 只读 9 个 env（`ACP_AGENT_ID`/`ACP_WORKSPACE`/`AUTO_APPROVE`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY`/`RUN_MOCK_DRIVER`/`LOCALAPPDATA`/`USERPROFILE`），`ACP_DENY_PATH_SUBSTRINGS_JSON`、`ACP_PROCESS_SANDBOX`、`ACP_DENY_NETWORK_TOOLS`、`CLAUDE_CLI_COMMAND/ARGS` **一个都不读**——scaffold `backend-rpc-stdio.ts:157-186` 对它们的转发是死接线。SWE-EVO 消融脚本要求存在的 `dist/src/security/package-index-block.js` 在全部 git 历史里都搜不到，它那道 bwrap 检查在本机只会抛错，故当时 `NEWIDE_EVAL_FS_JAIL` 必然是关的。

可用的闸门是 Claude Code 自己的权限系统：`claude-agent-acp` 的 `SettingsManager` 监视 `<session cwd>/.claude/settings.json`，而 session cwd 就是 `ACP_WORKSPACE`。所以 harness 在启动 driver 前把 deny 列表写进**工作区**（`cache.ts` 的 `writeDriverWorkspaceSettings`）：

```json
{ "permissions": { "deny": ["Bash", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Write(./.claude/**)", "Edit(./.claude/**)"] } }
```

本任务只需**写出**一个 plan / review 文件——问题陈述与待审 plan 都由 prompt 送进来，既不读文件也不跑命令——所以越界通道可以整条关掉。**只关 `Bash` 不够**：`Read ../../../role-divergence-runs/cells.jsonl` 照样通，读工具必须一起关。**网络工具也要关**：本任务无网络需要，但 `WebFetch` 抓得到 dask 的 issue / 上游修复，等于把金标喂进 plan（SWE-EVO 消融封网也是这个理由）。写保护 `.claude/**` 是防止 agent 反手改掉这份 deny 列表。

> **`--repo-checkout` 形态下这份列表不同**：`Read`/`Glob`/`Grep` 必须放开（否则 driver 读不到代码，实验就退回"凭题目文本猜"），`Bash` 与网络工具继续封，另加 `Write(./repo/**)`/`Edit(./repo/**)` 明示仓库只读。见「两种实验形态：driver 有没有仓库」。

**实测一格的结局**（`trajectory.jsonl` 的 `tool_call` / `tool_call_update`）：

| 工具 | 次数 | 终态 |
|---|---:|---|
| `Bash`（`ls -la <workspace>`、`find <workspace> …`） | 3 | `failed` |
| `Glob` | 5 | `failed` |
| `Read` / `Grep` | 各 1 | `failed` |
| `WebFetch`（`file:///D:/…`） | 1 | `failed` |
| `Write`（plan.md） | 1 | `completed` |

越界命令是被**拒绝**而不是被执行，任务照常产出。这仍是克制而非内核隔离（deny 由 agent 侧执行），但它是 driver 真正消费的配置，且不依赖 Linux。要内核级隔离得上容器：只把单格 workspace `-v` 进 driver 容器、其余什么都不挂，容器内 `ls ..` 到根也一无所获。

#### 但"挡住"不等于"说明白"——只上 deny 会烧穿预算

只加 deny 不说明工作区里其实什么都没有，agent 会持续去找不存在的仓库。实测 security 角色（语料最大、技能最强调"先读代码再下结论"）连续两次撞墙：第一次 17 次调用**全是**读/探索（`Glob dask/**/*.py`、还起了子 agent "Explore dask repo for plan"）全部被拒、一次 `Write` 都没发出，45 分钟预算掐断；第一次则是 `Write` 卡在 `pending` 未完成（10.5 分钟）。同一配置下 correctness 被拒 14 次后放弃探索并成功写出——**失败率与角色相关，这会变成系统性的样本缺失**。

修法在 `prompts.ts` 的两个模板里各加一行，明说工作区是空的：

```
- The repository is not checked out in the working directory and it is empty: no source
  files are available. Base the plan on the problem statement alone.
```

效果是决定性的：security 从 17 次调用 / 45 分钟超时变成 **1 次调用（`Write`）/ 3 分钟**。两个模板仍跨角色字节相同，控制不变；且这一行忠实于设计（本来就不 checkout 仓库）。

**改 prompt 会让已有单元失效**——`CellEvidence.prompt_sha256` 变了，重跑矩阵才可比。

每次改完隔离都应抽一次 driver 实际执行的命令复验（见「产物」一节）。

---

## 固定控制变量

| 变量 | 值 | 由谁固定 |
|---|---|---|
| 记忆消融档 | `B2`（技能开、经验开） | `config.ts` 断言 |
| 检索 `recall_top_k` | 20 | 生产默认，`assertRetrievalPolicy` 断言 |
| 检索 `min_embedding_similarity` | 0.5 | 同上 |
| 检索 `max_memory_items` | 5（**只按条数、不按长度**） | 同上 |
| 检索 `min_tag_overlap` | 1 | 同上 |
| 语料嵌入 | `text-embedding-v3` @1024d | `skill-embeddings.json` |
| 查询嵌入 | 同模型同维度 | 后端 env 钉死 1024 |
| 提示词模板 | `prompts.ts` 内三个模板，**不含角色名** | 字节同一性由单测守住 |
| 运行模式 | `single_agent` + 竞价关闭 → 单候选短路 | 后端 env |
| 运行后经验提取 | **关闭**（`NEWIDE_B_DISABLE_EXTRACTION=1`） | 后端 env |
| 启动时待处理重放 | **关闭**（同一开关一并管） | 后端 env |
| 市场自学习 | **关闭**（`NEWIDE_B_AUTO_LEARN=0`） | 后端 env |
| 注入路径 | **只走 agent 自查**（`NEWIDE_B_DISABLE_PRE_RETRIEVAL=1`，关掉 facade 预检索） | 后端 env |
| Agent 工具输出上限 | 16000（`NEWIDE_AGENT_LLM_MAX_TOKENS`；默认 2000 会截断工具参数） | 后端 env |
| 采样参数 | driver / agent 侧配置 | 见下 |

`B2` 档默认会在每次运行后调度经验提取（`b-memory-maintenance-runner.ts` 的 `scheduleBuffer` 不是仅入队，而是立即 `processBuffer`），于是角色记忆会随实验推进自己长出来；加上 `include_recent_experience` 开，这些经验会进入注入，**格子之间就不再是独立样本**，且漂移量与该角色跑过的内容耦合。为此给生产接线加了 opt-in 开关 `NEWIDE_B_DISABLE_EXTRACTION`，它同时关掉两条自动路径：

1. facade 每轮运行后的 `processMemoryMaintenance`；
2. 后端启动时的 `memoryMaintenance.replayPending()`。

第二条必须一起关——只关第一条的话，本格写入的 pending buffer 会在下一个后端启动时被补做，等于没关。显式的 memory 维护 RPC 不受影响。

`top_p` 本仓原先无法设置：`src/litellm` 的契约与 client 只有 temperature / maxTokens。本轮给 `CompletionRequest` 补了 `topP` 透传。注意 **plan 的采样由 driver 侧配置决定**（`ANTHROPIC_*`），scaffold 侧的这一条不作用于 driver。

---

## 前置条件

1. **数据集**：`eval/data/sweevo-v0-repo-full-prctx.jsonl`（**本仓不带**）。三条路：
   - 构建：`pnpm eval:build-pr-context -- --subset v0-repo-full`（需要 `GITHUB_TOKEN` 与 `../SWE-EVO/`）
   - 你提供现成文件
   - **离线回收**（推荐先用这条打通）：`pnpm eval:role-divergence:recover`，从 `evalResult/` 里历史消融跑留下的 `state/runs/<run_id>/request.json` 切出三份 `problem_statement`，产出 `eval/data/sweevo-v0-dask-3-prctx.recovered.jsonl` 与 provenance 侧车，再用 `--jsonl` 指过去。不触网、不需要 token。

   回收的原理：历史运行的提示是「固定头部 + `Problem statement:` + **原样**的问题陈述」，标记只出现一次且其后无追加，所以切出来即该字段原文。同一 instance 若在多份归档里都命中，脚本会**比对 sha256**，不一致直接失败而不是悄悄取一个截断变体（本机实测三份各有约 20 份归档互相印证）。

   回收文件是**派生数据，不入仓**（见 `.gitignore`）。要让 harness 读它必须显式给 `--jsonl`——子集元数据里的 `source_jsonl` 保持指向规范路径不动，避免把「本地重建」伪装成「规范产物」。
2. **Driver**：`ACP_DRIVER_RUNNER_DIR`（默认 `../acp-client-prototype`）已 build，即存在 `dist/src/driver/contract-runner.js`。
3. **凭据**：
   - driver：`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL`
   - 嵌入：`EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` / `EMBEDDING_DIMENSIONS=1024`
   - 顶层 agent：`NEWIDE_AGENT_LLM_MODEL`
4. **存储**：PGlite 嵌入式，数据目录 `<result_root>/pglite`（可用 `NEWIDE_B_PGLITE_DATA_DIR` 覆盖）。**单进程文件锁**，所以后端串行启停。

---

## 运行

```bash
# 规范化 jsonl 不在手边时，先从本地归档回收问题陈述
pnpm eval:role-divergence:recover

# 阶段 0：离线就绪检查（种子、每角色语料计数、检索策略断言；不触网）
pnpm eval:role-divergence -- --stage=probe

# 先看结构，不发任何调用（数据集缺失也能跑）
pnpm eval:role-divergence -- --stage=full --dry-run

# 阶段 1：实验一 × 单实例 × 5 角色（5 次调用）
pnpm eval:role-divergence -- --stage=minimal

# 阶段 2：全量 108 格
pnpm eval:role-divergence -- --stage=full
```

用回收文件跑时，给**每一条**命令都带上 `--jsonl`：

```bash
pnpm eval:role-divergence -- --stage=minimal --jsonl=eval/data/sweevo-v0-dask-3-prctx.recovered.jsonl
```

常用开关：`--instances=id1,id2`、`--roles=correctness,security`、`--jsonl=<path>`、`--force`（重跑已完成的格）、`--allow-empty-injection`（明知某角色注入为空仍继续）、`--repo-checkout`（见下）、`--repo-source=<本地 clone>`、`--max-context-tokens=N`、`--max-cell-cost-usd=N`、`--max-run-cost-usd=N`（见「花费闸门」）、`--allow-zero-cache`（放行零缓存命中的格，慎用）、`--timeout-ms=N`。

---

## 成本：为什么有仓库形态贵，以及怎么刹住

**成本结构**：driver 每一轮都重发整个上下文，所以一格的计费输入量 ≈

```
Σ(起始上下文 + r·n) ≈ N·C₀ + r·N²/2     N=工具调用轮数, C₀≈74k, r≈654
```

`C₀≈74k` 是实测的起始上下文（44,448 字符的 prompt ≈ 11–15k token + 顶层 Agent 内联的技能/经验），`r≈654` 是实测的每次工具调用平均增量。**N 是主导项**：

| N | 计费输入量（上界估算） |
|---:|---:|
| 121（实测那次） | ~1360 万 token |
| 25（预算内） | ~150 万 token |

> 这张表是**量级判断**，不是金额预测：它对每轮上下文取上界，实测偏高（N=79 的实测见下一节，9.0M）。**真实金额一律以磁盘台账为准**，用 `pnpm eval:role-divergence:cost` 读。

所以「贵」不是起始上下文的问题，是**轮数**的问题——而轮数失控是因为 agent **没有停止判据**。

**实测事故**（有仓库形态第一次开跑，correctness 一格）：**121 次工具调用（Read 72 / Grep 34 / Glob 14 / Bash 1）、0 次 Write**，峰值上下文 **151,706 / 200,000（75.9%）**，23 分钟仍在爬，最后人工停掉。这与 README 早年的记录（security 连续 17 次调用全是探索、一次 `Write` 都没发出、45 分钟预算掐断）是同一个病。第一版 prompt 只写了 *"Search efficiently rather than reading the whole tree"* 这类**软建议，agent 不照做**。

**两道闸门**：

1. **prompt 里的硬预算**（`prompts.ts` 的 `CONSTRAINTS_WITH_REPO`）：先 Glob/Grep 定位再 Read、禁止重读、**至多读 8 个文件**、**至多 15 条检索命令**、说明"能点出要改的文件与函数就够了，然后动笔，别为了消除不确定性一直读"。措辞强调 *"Every file you read stays in your context for the rest of the task, so reading is not free."*
2. **harness 的硬上限**（`--max-context-tokens`，默认 **120,000**）：`waitForTerminal` 每秒轮询驱动轨迹的 `usage_update.used`，**超过就 `run.cancel` 并判该格失败**。这条不依赖 agent 自觉——它只在 prompt 被无视时生效，而 prompt 被无视正是实测发生的事。

   > 读数用增量方式（`createContextUsageReader`）：轨迹会长到几 MB，每秒整份重读会让"成本守卫"自己变成成本。它记住读到哪里、只解析新增部分，并把半行留到下一轮——半行处理由 `temp/verify-context-usage-reader.cjs` 离线守住。

**两个操作含义**：

- 上限触发时该格**判失败且无产出**，会白花掉已达上限的那些 token。要更省就调低 `--max-context-tokens`。
- 想先探路，用**最小的实例**：`dask__dask_2024.3.1_2024.4.0` 的 problem_statement 只有 15,292 字符（vs 43,408），检索空间小得多。三个实例的规模：

  | 实例 | problem_statement | PR 数 | F2P |
  |---|---:|---:|---:|
  | `2023.3.2_2023.4.0` | 43,408 | 73 | 61 |
  | `2023.6.0_2023.6.1` | 18,849 | 11 | 105 |
  | `2024.3.1_2024.4.0` | 15,292 | 18 | **2** |

---

## 缓存命中率：实测为 0，这才是花费的主因

上面那张表是**估算**。真实计费记录在 driver 自己的会话文件里，埋点后已经能直接读出来。有仓库形态第一次开跑（correctness 一格，人工停掉）的**实测**：

| 读数 | 值 |
|---|---:|
| 真实推理次数 | **79**（另有 159 条流式分片被剔除，见下） |
| 计费输入（全价当量） | **9,001,086** |
| 其中缓存写（1.25x） | **0** |
| 其中缓存读（0.1x） | **0** |
| 输出 | 13,744 |
| **缓存命中率** | **0.00%** |
| 缓存节省 | **0** |
| 峰值单次调用输入 | 153,070 |

**结论：9,001,086 token 全部按全价计费，缓存一分钱没省。** 这不是"命中率偏低"，是缓存从未命中。若这些输入全部命中，加权花费会降到约 1/10。

**成因已确证：驱动客户端的构建把每请求都变的一个字段放在了 prompt 的第 0 位。** 抓下 driver 实际发出的请求体后逐字节对比——同一个 run 内相邻两次调用，`tools`、`sys[1]`、`sys[2]`、模型参数、消息历史**全部逐字节相同**，唯一变化的是 `sys[0]`：

```
x-anthropic-billing-header: cc_version=2.1.156.31e; cc_entrypoint=claude-desktop-3p; cch=1affb;
```

`cch` 每请求都变。前缀缓存从第一个 token 起匹配，所以整条前缀永远作废——不是"命中率低"，是结构上不可能命中。交互式 `claude`（2.1.268）不发这个字段，**同一条路由、同一分钟内第二轮就命中 16,896**。

版本来自依赖链：`@agentclientprotocol/claude-agent-acp@0.39.0` → `@anthropic-ai/claude-agent-sdk@0.3.156` → Claude Code 2.1.156。`^0.39.0` 在 semver 里等价于 `>=0.39.0 <0.40.0`，升不到 0.40 以上，所以一直钉在这个老构建上。

> **逐条修正早先的判断。** 第一，"会话文件里 `cache_control` 出现 0 次"**确实**不能定性——命中的那些会话里它同样是 0 次；要看的是出站请求体。第二，"这是请求/网关侧的事"只对了一半：**带着**那个块，SCNet 的匹配在块之后断掉（只复用约 2k），DeepSeek 官方端点则忽略该块、照样命中；**去掉**该块，SCNet 也完全正常（第二轮命中 19,200）。所以根因在客户端构建，网关只是决定你会不会侥幸躲过。第三，早先"64k 以上不缓存"的猜想是错的，SCNet 有 15 万 token 全程命中的记录。

> 口径修正：早先 README 用 `N·C₀ + r·N²/2` 估出 N=121 时约 1360 万。实测表明该式**高估**（它对每轮上下文取的是上界而非实际值）。真实口径以本节的磁盘台账为准，公式只用来判断"轮数是不是主导项"，不用于预测金额。

### 花费闸门：三道，跑起来就生效

上一节那类失效是**静默**的——产出照常有、终态照常 `completed`、单元证据照常落盘，只有账单是十倍。所以闸门必须自己把这件事喊出来：

| 闸门 | 判据 | 动作 | 开关 |
|---|---|---|---|
| **缓存** | 某格 driver 有 ≥2 次推理、缓存读却为 0 | **停整轮**（跑完第一格就见效） | `--allow-zero-cache` 放行 |
| **单格花费** | driver 自报累计 `cost.amount` 超上限 | `run.cancel` 该格并判失败 | `--max-cell-cost-usd=N`（默认 **10**） |
| **整轮花费** | 本轮累计花费超上限 | 停在当前格 | `--max-run-cost-usd=N`（默认 **3 × 待跑格数**，下限 20） |

几个刻意的选择：

- **账单口径用 driver 自报的 USD**，不用估算公式。`usage_update` 里本来就有 `cost.amount`（会话累计值，所以取峰值而非求和），这是实测数；上下文闸拦不住缓存失效——那种情况下 `used` 涨得并不快。
- **整轮上限的基数是「待跑」格数**，不是总格数：已完成单元会被跳过、不再花钱，用总格数会让续跑一开局就被自己判超限。超限停下是**无损**的，调高上限重跑即续。
- **取不到读数一律放行**。缺台账不等于零花费，那是 `driver_tokens_error` 的职责；闸门不该因为读不到数就把实验判死。
- 默认值取自实测：13 个格子的 driver 自报花费中位 **$1.45**、最高 **$3.39**，单格默认 $10 留约 3 倍余量。缓存一旦失效，同样的序列会到 $15–35，这道闸在第一格就能拦住。

> `cacheGuard` 是三道里最该留着的那道：另外两道只是止损，这道能在**第一格**就把根因级别的故障挑出来。它唯一的误判风险是「两次推理但前缀本就不同」（例如一次主调用加一次独立的辅助调用），`--allow-zero-cache` 是给这种情况的准备。

### 怎么读账：三条链路，各管一段

| 链路 | 记什么 | 记在哪 | 能回答 |
|---|---|---|---|
| `driver-stream.jsonl` | `usage_update.{size,used}` | 轨迹 | 上下文占用曲线（**没有缓存字段**） |
| `~/.claude/projects/<编码工作区>/<sessionId>.jsonl` | 每次推理的 `input/output/cache_creation/cache_read` | driver 会话文件 | **真实计费与缓存命中率** |
| AI SDK `LanguageModelUsage` | `inputTokenDetails.{noCache,cacheRead,cacheWrite}Tokens` | 顶层 Agent 与记忆侧调用 | 另一条大模型路径的缓存命中 |

取数要按 `sessionId` + **run 时间窗**双重过滤：project 目录下同一工作区可能躺着多次跑的会话文件，而工作区是复用的，同一份文件会持续追加。只按路径取数会把上一轮的开销算进这一轮（实测已用未来时间窗反证过滤生效）。

埋点落点：

- `eval/role-divergence/driver-usage.ts` —— 从会话文件取数，折成 `driver_tokens` 写进单元证据：每次调用的原始行、累计曲线、加权花费、命中率。**口径**：`billed = 全价 + 缓存写 + 缓存读`；加权按 `1 / 1.25 / 0.1`。
- `src/telemetry/collect-claude-session-usage.ts` —— 解析器（`parseClaudeSessionUsageText` 是纯函数，可离线复算）。**剔除流式分片**：Claude Code 每个 content block 写一行 `assistant`，带全零 usage 且 `stop_reason: null`，只有收尾那行才有真数。实测 238 行里 79 行真计费、159 行分片；不剔除会让 `call_count` 虚高约 3 倍、把命中率分母做小，结论会朝"比实际便宜"偏。
- `src/litellm/client.ts` —— 所有 LiteLLM 调用的收口点，把 `inputTokenDetails` 的缓存读写带回 `TokenUsage`。**拆分规则**在 `splitCachedPromptUsage`：`prompt_tokens` 是整个 prompt，缓存读写是它的子集，全价部分 = `prompt - read - write`；把三者直接相加会把同一批 token 记两次。
- `eval/role-divergence/cost-analysis.ts` + `report-cost.ts` —— 汇总与报告。

### 对已有结果算账

```bash
pnpm eval:role-divergence:cost -- --root=<结果根>
# 只读单元证据，不触网、不启动后端；明细写 <结果根>/cost-analysis.json
```

报告给出总计、按实验、按角色、最贵格，并单列**取不到台账的格**——缺省与"零花费"是两回事，前者会让任何"每格平均成本"偏小，所以它必须显式可见而不是静默算成 0。

> 埋点之前的格子没有 `driver_tokens`，会被归入"缺台账"并以原因 `predates this instrumentation` 计数。**不要**把旧格和新格混在一张成本表里比。

---

## 两种实验形态：driver 有没有仓库

`--repo-checkout` 决定 driver 能否读到代码。**两种形态的 prompt 字节不同，所以同一轮实验不要混跑**；已完成的单元只对产生它的那种形态有效。

| | 默认（无仓库） | `--repo-checkout`（有仓库） |
|---|---|---|
| driver 工作区 | 空 scratch 目录 | 空 + `repo/`（只读仓库副本） |
| `Read`/`Glob`/`Grep` | **deny** | **放开** |
| `Bash` | deny | deny（**当年烧穿预算的元凶**：agent 会无限 `ls`/`find` 找东西） |
| `WebFetch`/`WebSearch` | deny | deny（抓得到上游 PR diff，等于把金标喂进 plan） |
| plan 的依据 | 只有问题陈述（release-changelog 文本） | 问题陈述 + **真实代码** |
| 证据里的 `driver_tools.repo_reads` | 恒为 0 | **必须 > 0，否则说明仓库白挂了** |
| `plan.md` 自称 | "File paths are the expected locations" | 应当给出真实文件与符号 |

仓库副本的产出方式：`ensureDriverRepo` → `ensureRepoMirror`（镜像，缺则联网 clone）→ `prepareEphemeralWorktree`（`--no-tags --single-branch`，删 remote/reflog/gc）。**这个组合刻意让 agent 无法通过 git 历史读到目标 release 的 diff**——即金标不可达。副本放在 `<result_root>/driver-repos/<owner__name>@<sha12>/`，再用 junction 挂到每格的 `<workspace>/repo`。**目录名必须带 `base_commit` 后缀**：全量阶段的三个实例都是 `dask/dask`，只是 base_commit 不同；只按仓库名取名会让三份副本争同一个目录，于是每换一个实例就把副本整个拆掉联网重建一次（批次按角色切、每批都含全部实例，这种抖动会落在几乎每一格上）。

为什么用 junction 而不是复制：`snapshotWorkspaceFiles` 对 Windows junction 报
`isSymbolicLink()=true, isDirectory()=false`（本机实测），而它只收 `entry.isFile()`，
所以**不跟随链接**——既省掉每格两次全仓 stat 扫描，也不会把仓库文件当成交付物。
`workspace-change-detector.ts` 已显式 `if (entry.isSymbolicLink()) continue;` 把这条性质固定下来。

首次开跑需要能访问 GitHub（取 dask/dask）。有本地 clone 时用
`--repo-source=<path>` 直接指定，可完全离线：

```bash
pnpm eval:role-divergence -- --stage=full \
  --instances=dask__dask_2023.3.2_2023.4.0 \
  --jsonl=eval/data/sweevo-v0-dask-3-prctx.recovered.jsonl \
  --repo-checkout --repo-source=/path/to/dask-clone
```

**两种形态不要混在同一个结果根里**。每格证据都带 `run_form: 'with-repo' | 'no-repo'`；
若结果根里已有的已完成格属于另一种形态，批次开始时会**直接抛错**而不是静默跳过——
混着比较等于把 prompt 差异算进角色差异。切形态时用新结果根（`ROLE_DIVERGENCE_ROOT`），
或者对同一根跑 `--force` 把每格都换掉。

**轨迹**：每个格的 driver 流式轨迹落在 `cells/<cell_id>/trajectory.jsonl`（源自后端的
`driver-stream.jsonl`，含每次工具调用、thought/message 分片、usage）。跑后由
`summarizeDriverToolCalls` 汇总进证据的 `driver_tools`，并把路径记进 `trajectory_path`。
**有仓库形态下先看 `driver_tools.repo_reads`**：它是 0，就说明 plan 仍是凭题目文本写的，
哪怕仓库挂在那儿。

---

## 注入门禁

**注入门禁在跑后**。注入由顶层 agent 自行决定（它按需调 `query_memory`），跑前无从得知——按问题陈述预检索那条路既已被 `NEWIDE_B_DISABLE_PRE_RETRIEVAL` 关掉，又会撞上嵌入的 8192 token 窗口。所以每一格跑完从它的 context pack 读回真实注入集合，落进 `injection/<cell_id>.json`；**该格注入为空、或取不到 context pack，即判失败**——产出照常有，但它证明不了任何角色效应。`--allow-empty-injection` 是显式放行的开关。

**例外：白板对照格（`role_neutral`）的零注入不是失败**，是控制条件本身。它的 agent 名下按定义没有任何技能（`seed.ts`: `skills_overview: '无预置技能'`），所以 `query_memory` 命中 0 条完全正确；该格证据里记 `control_zero_injection: true`。判定逻辑单列在 `injection-gate.ts`，由 `test/eval/role-divergence.test.ts` 离线守住。

> 这条例外是被一次真事故逼出来的：早期版本不分角色地套用零注入断言，于是 `plan_neutral` 明明**已跑完并写出 19 KB `plan.md`**，却被判 `failed`；接着 `reviewedPlanText()` 在第一个 plan 格就抛 `Upstream plan cell not completed`，`review_neutral` / `review_role` 全被连坐，整轮 exit 1。**教训：控制格的"空"必须与实验格的"空"分开判**——前者是设计，后者才是事故。

这条门禁不是形式主义，它抓过一次真事故：一版 prompt 措辞让顶层 agent 认定"不必用别的东西"，于是它根本没调 `query_memory`，那一格注入为 0 却照常产出了 plan 与一份像模像样的报告。跑前的预计算探针看不见这种事——它算的是"本该如何"，不是"实际如何"。

---

## 阶段规模

| 阶段 | 格数 | 组成 |
|---|---:|---|
| probe | 1 | 离线就绪检查（种子 + 语料计数 + 策略断言；不触网、不发调用） |
| minimal | 5 | 实验一 × 单实例 × 5 角色 |
| full | 108 | 白板 plan 3 + 角色 plan 15 + 评审白板 15 + 交叉评审 75 |

实验三 = 5 审者 × 5 被审 plan × 3 实例。审者拿不到作者身份，25 格的**执行顺序**由实例 id 播种打乱（避免位置效应被误读成角色差异）；作者映射只写进证据。

「白板 plan」由 `role_neutral` 产出——一个无技能、中性 persona 的对照 agent，走**同一条** facade → driver 链路，唯一差别是记忆为空。

---

## 产物

默认落在 **仓库之外** 的 `../role-divergence-runs/`（`ROLE_DIVERGENCE_ROOT` 可覆盖）。刻意不放仓内 `.newide/`——driver 是从工作区出发探索的，把结果根放在它可达的相对路径上等于把实验配置、格子目录与别格产出都递过去。**不要改回去。**

```
experiment-config.json     本次用的全部旋钮与实例
pglite/                    B 记忆（种子写入，后端读取）
injection/<cell_id>.json   注入证据（跑后从该格 context pack 读回）
cells/<cell_id>.json       单元证据
cells/<cell_id>/prompt.txt 送进 run.create 的任务提示原文
cells/<cell_id>/agent-tools.jsonl   顶层 Agent 的每次工具调用（query_memory / invoke_driver）
cells/<cell_id>/trajectory.jsonl    driver 自己的流式轨迹（工具调用 / thought / usage）
workspaces/<cell_id>/      driver 的 scratch 工作区（plan.md / review.md；--repo-checkout 时多一个 repo/ 链接）
driver-repos/<owner__name>@<sha12>/ 只读仓库副本（--repo-checkout；一个 base_commit 一份，跨格共享）
backend/<role>/           后端 state_root 与 runs/
cells.jsonl / summary.json 汇总
```

**driver 工具轨迹**（`trajectory.jsonl`）与顶层 Agent 的 `agent-tools.jsonl` 是两层东西：前者是 **driver 在代码树里做了什么**，后者是**顶层 Agent 查了什么记忆**。单元证据里的 `driver_tools` 是前者的摘要（`repo_reads` / `repo_reads_ok` / `failed` / `writes` / `stream_events`），并附 `trajectory_path`。

这条摘要存在的理由是：`--repo-checkout` 只是把仓库放到 driver 手边，**它读没读是另一回事**。`repo_reads === 0` 就等于"仓库挂着、plan 仍是凭题目文本写的"——没有这个读数，两种情形在证据里无法区分。`failed` 记的是真实终态（`status === 'failed'`），不是"工具名在黑名单里就算失败"：后者在 deny 列表失效时会给出假的安全读数。

**Agent 工具轨迹**（`agent-tools.jsonl`，由 `NEWIDE_B_AGENT_TRACE_DIR` 打开）记录**顶层 Agent**——不是 driver——每次工具调用的名字、入参摘要、成功与否，以及 `query_memory` 返回的技能条数与字符数。单元证据里的 `agent_tools` 是它的摘要。

这条轨迹存在的唯一理由是**给"注入为空"定性**。没有它时，「Agent 压根没去查」与「查了但没命中」在证据里长得一模一样，只能靠猜：

| 轨迹长相 | 成因 | 该动哪里 |
|---|---|---|
| `query_memory: 0` | Agent 没查 | 提示词 / Agent 系统提示词 |
| `query_memory: N`、`skill_counts` 全 0 | 查了没命中 | 语料、嵌入、相似度门槛 |

driver 侧的执行轨迹是另一回事，见下面的隔离复验。

#### 实测抓到的失败模式：工具参数被输出上限截断

开观测后第一轮就抓到一次真事故，值得记下来——它把三个各自合理的设计叠成了陷阱：

1. 顶层 Agent 把 5×9k 字符的技能正文**贴进 `invoke_driver` 的参数**；
2. agent 侧 LLM 的输出上限是 2000 token（`NEWIDE_AGENT_LLM_MODEL` 覆盖模型时那条分支里写死），约 6–8k 字符；
3. 于是流式输出**在字符串中间断掉**，`agent.ts` 的 `JSON.parse(toolCall.function.arguments)` 抛
   `Unterminated string in JSON at position 6049`，工具调用**根本没进 facade**。

后果是一串误导性的现象：pack 里没有 `driver_invocation_context`（合并那步从未执行）、
`skill_count` 为 0、看起来像"记忆没注入"，其实是"工具调用没发出去"。实测 security 连续
5 次 `invoke_driver` 全部同样报错，其中一次侥幸写短了才成功——所以表现为**偶发、且与语料
大小相关**（语料越大，Agent 越想内联，越容易撞上限）。

两处修：

- `AgentToolConfig.onSkillsRetrieved` 已经把技能原文**自动**送达 driver，所以
  `buildAgentSystemPrompt` 里那条"把检索到的技能作为 context 传给 invoke_driver"是过时的，
  改成了明确要求**不要**把正文贴进参数。这条单独不够——Agent 仍会内联。
- `NEWIDE_AGENT_LLM_MAX_TOKENS`（harness 设 16000）抬高输出上限。`maxTokens` 在
  `litellm-tool-calling-client.ts` 的模型覆盖分支里原先是硬编码的 2000。

**判据**：`cells/<cell_id>/agent-tools.jsonl` 里 `invoke_driver` 出现
`Unterminated string in JSON` 就是撞上了这个；正常应当一次成功。

**注入证据**（`InjectionEvidence`）是「隔离真的发生」的凭据，**跑后**从该格 context pack 的 `driver_invocation_context.skills` 读回（与生产 `toDriverMemoryItems` 同口径）：技能 `{id, slug, description, content_chars, est_tokens}` 列表、条数、字符数、估算 token（散文字符/4 + 代码字符/3），以及当时生效的检索策略。它记的是**实际注入了什么**，不是"本该如何检索"——后者是跑前预计算的产物，已被 agent 自查路径取代。

**单元证据**（`CellEvidence`）记录：单元 id、角色、档位、模型标签、提示词 sha256、产出 sha256、评审裁决（`VERDICT:` 首行宽容提取，提不到记 `review_parse_failed`）、run/task id、终态、token 用量、墙钟、错误。

其中两个**账目字段**要分清（名字相近，口径不同）：

| 字段 | 来源 | 内容 |
|---|---|---|
| `driver_usage` | 驱动轨迹 `usage_update` | 上下文占用（`size`/`used`），**无缓存信息** |
| `driver_tokens` | driver 会话文件 | 每次推理的输入/输出/缓存读写 + 加权花费 + 命中率 |
| `driver_tokens_error` | harness | 取账失败的原因。**缺省 ≠ 零花费** |

已完成的单元默认跳过，**这是防 API 漂移的手段**——重跑不会重复取样。要重新取用 `--force`。

**隔离复验**：每格 `cells/<cell_id>/` 下的 `trajectory.jsonl`（driver 自己的轨迹）与 `audit.jsonl` 记录了 driver 实际做过什么。改动隔离方式后，把它的 Bash 命令抽出来看一遍——抽法见 `spec/temp/cmds.mjs`。命令里出现任何 <result_root> 或仓库路径的兄弟目录，就说明隔离还是漏的。

---

## 本目录不做什么

- **不实现 LLM-as-Judge 与打分聚合**（上游文档把度量层标为「未定」）。评审裁决词表已与 council 的 `Review.verdict` 对齐，后续接 judge 时可直接消费。
- 不产 patch、不建 worktree、不跑测试。
- 不修改旧分支 `feat/eval-role-diversity-prompts`。

## 单测

```bash
npx vitest run test/eval/role-divergence.test.ts test/eval/role-divergence-cost.test.ts
```

全离线。守住：阶段规模与交叉矩阵形状、提示词模板逐字一致且不含角色名、检索策略与生产默认值不漂移、消融档拒绝被降级、缓存语义、打乱确定性、问题陈述切片的边界（CRLF / 重复标记 / 无标记 / 空切片）。

`role-divergence-cost.test.ts` 守的是**计费口径**，三条错了都会让实验显得比实际便宜且不会自曝：流式分片必须剔除（否则 `call_count` 虚高、命中率分母变小）、三分量不许双计（否则花费与命中率同时失真）、缺台账必须显式可见（否则被静默当成 0）。
