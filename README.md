# newIDE-BCD

`newIDE-BCD` is the backend composition for the newIDE A/B/C/D flow. The
production path now includes a real external Driver, persistent B role/persona/memory,
durable Task/Run state, and Council proposal/review/synthesis/delivery.

## 评审消融分支：Council 开 / 关评审对照

> 本分支只服务一件事：在其余环节完全相同的前提下，比较 **有一次评审** 与 **没有评审** 的
> Council 结果。`NEWIDE_COUNCIL_REVIEW` 与 `NEWIDE_COUNCIL_REPLAY_DIR` 默认都不生效，
> 未设置时行为与分支基线 `7c085e6` 相同；除这两个开关及它们写进结果的留档字段
> （`review_mode`、`proposal_replay_dir`）外，本分支没有其他运行时行为改动。做消融以外的
> 功能开发不要基于本分支。

| 臂 | 设置 | 提案 | 评审 |
| --- | --- | --- | --- |
| R（有评审） | 不设置 | 本轮生成 | 执行 reviewer |
| R0-b（无评审，配对） | `NEWIDE_COUNCIL_REVIEW=off` + `NEWIDE_COUNCIL_REPLAY_DIR=<冻结包>` | 回放 R 的冻结包 | 不执行 reviewer |

冻结包就是一次已完成 Council 的 synthesizer pack（`cp_s0_*`：`proposals.json` 与 `inputs/`）。
回放时 `agent_id` 已在冻结提案里的提案者被跳过，冻结的 `council-plan.md` 原样落到评审者工作区，
于是两臂共享同一份提案，差异只剩评审。缺 `proposals.json`、提案缺 `agent_id`、产物不是恰好一个
落盘文件时直接报错，不猜。

```bash
# 臂 R：先跑，产出提案并留下冻结包
pnpm eval:sweevo-ablation -- --subset <subset> --ablations B4 --mode council --review on --run-harness
# 臂 R0-b：回放同 repeat 的 R 提案，关掉评审
pnpm eval:sweevo-ablation -- --subset <subset> --ablations B4 --mode council --review off \
  --replay-proposals '<exp>/runs/{instance}/repeat-N/A2/experiment/B4/state' --run-harness
```

`{instance}` 按实例替换，并在 `council/*/cp_s0_*` 下找唯一的 pack；多于一个报错。**顺序不能反**：
R0-b 的冻结包来自 R。单任务直接跑时用同名的两个环境变量，见 `.env.example`。

跑完必须核对（缺一即该次作废）：

| 判据 | R | R0-b |
| --- | --- | --- |
| `role_code_reviewer` 是否有驱动会话 | 有 | **无** |
| council 目录 | 含 `cp_r0_*` | 无 `cp_r0_*`；回放时提案者也无会话 |
| `council.review.completed` | ≥1 | 0 |
| `cp_s0/reviews.json` | 评审原文 | `[]` |
| 两臂 `proposal_id` 集合与计划文件 sha256 | 配对时必须相等 | 同 |

合成阶段照常执行（`council.synthesis.completed` → `final-plan.md` → primary 实现计划），无论评审
开关如何；无评审时 `council quality` 恒为 `best_effort`（`verified` 需要至少一条评审，这是设计
后果而非失败）。2026-10-06 本地双跑各 1 次已验证：`off` 侧 `review_count=0`、reviewer 无会话、
合成与实现照常；`on` 侧 `review_count=2`、`quality=verified`。

## Quick Start

只保留两个正式入口：后端 CLI 和 Polaris Electron。需要 Node.js `>=22.22.1`、
pnpm `>=11.8.0`。B 记忆存储默认使用嵌入式 PGlite（WASM PostgreSQL + pgvector），
零安装、无需 Docker；只有显式选择外部 PostgreSQL 时才需要 Docker 或云数据库。

### Backend CLI

B/C/D 后端和 ACP Client 可以位于任意目录。先安装两个仓库的依赖：

```bash
pnpm --dir /path/to/acp-client install
pnpm install
```

复制本仓库的 `.env.example` 为 `.env.local`，至少配置 B/Council 模型和实际 coding
agent：

```dotenv
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=replace-with-your-key
ACP_AGENT_ID=claude
NEWIDE_B_EMBEDDING_PROVIDER=hash
NEWIDE_B_EMBEDDING_DIMENSIONS=32
# NEWIDE_COUNCIL_STRATEGY=plan_first
```

固定 Council 工作流（主/副出方案 + 评审 + 合成，主最后实现计划）：设
`NEWIDE_COUNCIL_STRATEGY=plan_first`、`NEWIDE_DEFAULT_RUN_MODE=council`，
并用 `NEWIDE_COUNCIL_SEATS` 固定 4 个席位；关闭竞标用
`NEWIDE_AUCTION_ENABLED=0` + `NEWIDE_PRIMARY_AGENT_ID`。详见 `.env.example`。

如需让 Council 成员由真实 Agent Market 竞标选择，可设置
`NEWIDE_COUNCIL_AUCTION_ENABLED=1`。首次 `select_agent` 的赢家固定为 proposer 0，
其余 proposer、reviewer 和 synthesizer 席位各进行一次独立竞标；可用
`NEWIDE_COUNCIL_PROPOSERS` 调整 proposer 数量（默认 2）。未开启时保持原固定席位逻辑；
显式设置 `NEWIDE_COUNCIL_SEATS` 时固定映射优先。

在 ACP Client 仓库的 `.env` 中配置对应 agent 的凭据。例如 `ACP_AGENT_ID=claude` 时：

```dotenv
ANTHROPIC_API_KEY=replace-with-your-key
```

运行一次真实 Council 任务（省略 `--local-postgres` 时使用嵌入式 PGlite，无需 Docker）：

```bash
pnpm task:run -- \
  --workspace ./task-workspace \
  --prompt "实现需求并把最终文件写入 workspace"
```

脚本会构建 ACP Client 和后端 CLI。需要外部 PostgreSQL（自托管或云托管）时，在
`.env.local` 设置 `NEWIDE_B_DATABASE_URL` 并加 `--local-postgres` 启动开发容器。
ACP Client 不在默认相邻目录时传 `--driver-runner /path/to/acp-client`。

过程日志写到 stderr，终态 JSON 写到 stdout；运行证据默认位于
`.newide/task-runs/<timestamp>/`，生成文件位于 `--workspace`。完整参数见：

```bash
pnpm task:run -- --help
```

Council 默认使用 `classic`，各角色直接产生候选实现。设置
`NEWIDE_COUNCIL_STRATEGY=plan_first` 后，Primary 与 Council 角色只生成和审阅 Plan，
Synthesizer 选出 `final-plan.md`，再由原 Primary Agent 在同一 Session 和隔离 workspace
中实施；Task/Run RPC、Gate 和交付入口不变。

评审消融：设置 `NEWIDE_COUNCIL_REVIEW=off` 后，Council 只跑提案者与合成者，reviewer
席位不执行、`reviews.json` 为空数组，席位映射、提案输入与合成契约都不变。该开关用于
"同流程、开/关评审"的对照实验，默认 `on`。批量测评脚本对应 `--review off`（仅
`--mode council` 有效）。

提案回放：设置 `NEWIDE_COUNCIL_REPLAY_DIR` 指向一次已完成 Council 运行的 synthesizer
pack（含 `proposals.json` 与 `inputs/`）后，本轮不再生成提案——`agent_id` 已在冻结提案
里的提案者被跳过，冻结的 `council-plan.md` 作为候选产物落到评审者工作区。这样开评审与
关评审的两次运行共享同一份提案，差异只剩评审环节；未设置时行为与原先一致。批量测评
脚本对应 `--replay-proposals <pack|含 {instance} 的模板>`。

`.env.local`、ACP Client 的 `.env` 和 API key 均不得提交到 Git。

### Polaris Electron

Electron 使用 Polaris 仓库内打包的 A/B/C/D 后端：

```bash
cd /path/to/polaris
pnpm install
pnpm build:backend
pnpm electron:dev
```

在应用设置中配置 provider、model、API key 和 B 数据库连接。后端包变化后重新执行
`pnpm build:backend`；日常前端联调直接运行 `pnpm electron:dev`。

```text
TaskCreateRequest
-> RunCreated
-> DriverSessionStarted
-> ContextPackBuilt
-> DriverRunResult
-> ArtifactRegistered
-> TaskCompletedEvent
-> HookMatched
-> GateRequest
-> GateResult
-> CouncilDecision
-> MergeAuthorization
-> CheckpointSaved
-> RunCompleted
```

Query `system.readiness` and `system.capabilities` to inspect production support.

## Repository Shape

This is intentionally a single-package TypeScript project. It does not use `packages/core`, `packages/runtime`, Nx, Turborepo, or a multi-package workspace. The v0 goal is to keep TypeScript project complexity low while the team proves the first end-to-end flow.

The RFC files live beside this repository in `../RFC`. They are design inputs and should not be migrated into this repository.

```text
src/
  core/         shared contracts only
  coordinator/  Direction C coordination layer (task state, checkpoint, stores)
  council/      Direction C council contracts and implementations
  driver/       Direction A driver contracts and adapters
  memory/       Direction B context pack contracts and providers
  hook/         Direction D.1 hook system
  gate/         Direction D.2 gate evaluation system
  examples/     runnable demos
```

## F Eval Real Harness Setup

The F-eval TypeScript pipeline is committed in this repository. SWE-EVO lives
under `eval/`; CooperBench (§2 P1-A) lives under `eval/cooperbench/` and
defaults to the sibling `../CooperBench` checkout. Real Docker harnesses for
either bench are not checked in.

Stub smoke tests only need local dataset files; real harness evaluation also
needs a Linux Python environment and Docker access.

### Windows + WSL + Docker Desktop

On Windows, run the SWE-EVO harness from Ubuntu WSL. The harness imports Linux
modules such as `resource`, so Windows Python is not enough even when Docker
Desktop is installed.

1. Enable Ubuntu WSL and make Docker Desktop available inside it:

```powershell
wsl --install -d Ubuntu-22.04
wsl --set-default Ubuntu-22.04
wsl -d Ubuntu-22.04 --user root --exec /bin/sh -lc "apt update && apt install -y python3 python3-pip python3-venv git"
```

In Docker Desktop, open `Settings -> Resources -> WSL Integration`, enable
`Ubuntu-22.04`, then apply and restart Docker Desktop.

Verify WSL can call Docker:

```powershell
wsl -d Ubuntu-22.04 --user root --exec /bin/sh -lc "docker --version && docker info"
```

2. Prepare SWE-EVO as a sibling of this repository. The default expected layout is:

```text
../SWE-EVO/SWE-bench/evaluate_instance.py
../SWE-EVO/hf_out/hf_jsonl/test.jsonl
```

The JSONL can be downloaded from the public Hugging Face mirror:

```powershell
New-Item -ItemType Directory -Force -Path ..\SWE-EVO\hf_out\hf_jsonl | Out-Null
curl.exe -L -o ..\SWE-EVO\hf_out\hf_jsonl\test.jsonl `
  https://hf-mirror.com/datasets/Fsoft-AIC/SWE-EVO/resolve/main/SWE-EVO/hf_jsonl/test.jsonl
```

Clone or download `SWE-EVO/SWE-EVO` so that `../SWE-EVO/SWE-bench` exists.

3. Install the SWE-bench harness in WSL (paths below assume the sibling layout under the same Windows drive):

```powershell
wsl -d Ubuntu-22.04 --user root --exec /bin/sh -lc "python3 -m pip install -U pip setuptools wheel"
wsl --cd ../SWE-EVO/SWE-bench -d Ubuntu-22.04 --user root --exec /bin/sh -lc "python3 -m pip install ."
wsl --cd ../SWE-EVO/SWE-bench -d Ubuntu-22.04 --user root --exec /bin/sh -lc "python3 evaluate_instance.py --help"
```

4. From this repository, generate a harness dry-run first:

```powershell
pnpm eval:instance -- `
  --instance-id conan-io__conan_2.0.14_2.0.15 `
  --mode oracle `
  --skip-scaffold `
  --run-harness `
  --harness-dry-run
```

The command writes `.newide/eval/<run>/harness-command.json`. To run the real
harness, execute the equivalent Linux command in WSL from the generated
`sweevo-work` directory (prefer `wsl --cd <dir>` so paths stay relative to the
Windows cwd). A successful real harness run should pull or reuse a Docker image,
run one instance, and print metrics such as `Applied rate` and `Resolved rate`.

Notes:

- `stub` validates the F-eval pipeline only; it does not run Docker.
- `oracle` replays the dataset gold patch and is useful for harness validation.
- `real` should use a patch from a case worktree or backend `summary.json`; do
  not use this repository's `git diff` as a benchmark patch.
- Local data, WSL setup, Docker images, and `.newide/` run outputs are not
  committed to this repository.

## Module Responsibilities

`src/core` owns shared contracts: IDs, timestamps, task/run state, events, artifacts, checkpoints, decisions, merge authorization, messages, role and memory refs, context pack refs, and file leases. It must not import `coordinator`, `driver`, `memory`, `hook`, `gate`, or `council`.

`src/driver` owns Direction A's runtime boundary. v0 defines `DriverRuntimeHandle`,
`DriverCapabilities`, `DriverPrompt`, `DriverRunResult`, and `DriverError`. ACP, adapter, and PTY
integrations live behind these contracts.

`src/memory` owns Direction B's role/persona/memory implementation and public ports. The
application composition consumes those ports and must not replace them with app-owned memory
models.

`src/hook` owns Direction D.1 hook system. Hook decides when to trigger gate evaluation based on events.

`src/gate` owns Direction D.2 gate evaluation system. Gate decides how to evaluate requests. The v0 implementation supports explicit `GateResult.decision` and aggregation priority `deny > ask > defer > allow`.

`src/council` owns Council participant resolution and proposal/review/synthesis contracts. The
current production flow is executable but remains `degraded` until participant identity reuse and
Driver Session continuation are closed.

`src/coordinator` owns Direction C coordination. Production Task/Run state uses the SQLite-backed
coordination store; in-memory stores remain test/demo implementations.

## Development Boundaries

Cross-module imports should go through module entrypoints. Avoid importing another module's
internal files directly.

`src/core` is the shared protocol layer. It must not import from other modules.

## Where Each Direction Works Next

Direction A should work in `src/driver`.

Direction B should work in `src/memory`.

Direction C coordination and long-running state should work in `src/coordinator` and shared types in `src/core`.

Direction C Council should work in `src/council`.

Direction D.1 should work in `src/hook`.

Direction D.2 should work in `src/gate`.

Shared object changes belong in `src/core` and should be reviewed by the relevant consuming direction.
