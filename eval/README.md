# F 方向评测

这个目录放 NewIDE 的 F 方向初步评测管线。当前阶段不自建完整数据集，先直接使用外部 benchmark 作为数据源；`newide-scaffold` 只记录固定子集和评测产物，不复制完整数据集。

- **SWE-EVO**（本目录根下脚本）：§1 记忆纵向 / 通用出分
- **CooperBench**（`eval/cooperbench/`）：§2 P1-A 协调主效应；详见 [cooperbench/README.md](./cooperbench/README.md)

## 埋点：结果层最低要求

与 `src/telemetry/埋点清单.md` §0 对齐——本目录服务**先出分**：

| 必达                                      | 说明                                                              |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `run-meta.json` / `dataset-manifest.json` | `run_id`、subset、mode、instance 列表可复现                       |
| `predictions.jsonl`                       | 交给 harness 的答案                                               |
| `summary.json`                            | 评测摘要；接入 harness 后应含 resolved/applied/f2p/p2p 等 L1 字段 |

| 推荐非阻塞                  | 说明                                      |
| --------------------------- | ----------------------------------------- |
| `telemetry.jsonl`           | 联调与归因；**没有也能先出 summary 分数** |
| Proxy / memory-cycle 细事件 | 经济性或 §1 消融时再要求                  |

`stub` 验管线，`oracle` 验判卷（**不等于** NewIDE 能力），`real` 才用于能力向出分。全量 §2/§3/§4 埋点见清单归因层，不作为本目录冒烟验收项。

## 数据集子集

- `v0-smoke`：最小冒烟子集，用来确认评测链路能跑通。
- `v0-dev`：早期开发子集，用来在扩大规模前做稳定迭代。
- `v0-repo-full`：整仓覆盖切片（conan 2 + dask 8 + requests 4 = 14）；入选 repo 全部 instance，无半截仓。
- `v0-repo-full-prctx`：同上 14 题，但 `problem_statement` 为 release-note + 离线 PR/Issue body（论文 Appendix N.1）；先跑 `pnpm eval:build-pr-context -- --subset v0-repo-full`。
- `verified-30`：RFC §4.1 打榜集（`frozen_adapted_v1`；flask 库存适配，见下方说明）。

子集元数据在 `eval/datasets/` 下。每个文件记录来源版本、来源 JSONL、筛选规则、环境要求和固定的 instance id 列表。完整 SWE-EVO JSONL 路径由 `eval/manifest.json` 声明（`default_subset` → `subsets`）。

### 准备 SWE-EVO 数据（`eval:smoke` 依赖）

本仓不自带 SWE-EVO。`eval/manifest.json` 默认指向同级目录：

`../SWE-EVO/hf_out/hf_jsonl/test.jsonl`

获取方式（任选其一）：

1. 从 Hugging Face 镜像只拉 JSONL（推荐，约 13MB）：

```powershell
New-Item -ItemType Directory -Force -Path ..\SWE-EVO\hf_out\hf_jsonl | Out-Null
curl.exe -L -o ..\SWE-EVO\hf_out\hf_jsonl\test.jsonl `
  https://hf-mirror.com/datasets/Fsoft-AIC/SWE-EVO/resolve/main/SWE-EVO/hf_jsonl/test.jsonl
```

2. 或 clone [SWE-EVO/SWE-EVO](https://github.com/SWE-EVO/SWE-EVO) 到同级 `../SWE-EVO`（若网络可达）；仓库内 `hf_out` 主要是 Arrow，`hf_jsonl` 仍可能需按上式补齐。

### Verified 30 状态（frozen_adapted_v1）

| 项                 | 状态                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 规格（RFC 目标）   | django 9 / scikit-learn 9 / requests 6 / flask 6；easy/medium/hard 各 10；镜像 `python:3.10-slim`                |
| 正式 instance 清单 | **已冻结（adapted）**：`eval/datasets/verified-30.json`（`list_status=frozen_adapted_v1`）                       |
| 适配决策           | [`eval/datasets/verified-30.DECISION.md`](./datasets/verified-30.DECISION.md)：接受 flask=1，django/sklearn 补齐 |
| 库存硬缺口         | SWE-bench Verified 中 `pallets/flask` **仅 1 条**；requests 有 8 条可取 6                                        |
| 原生依赖           | `may_need_native_ext` **硬排除**                                                                                 |
| Solo 冒烟地板剔除  | 延后；结果写入 `eval/data/solo-smoke-results.jsonl` 后重跑选择脚本即可应用                                       |
| 状态报告           | `eval/datasets/verified-30.status.json`                                                                          |
| 冻结 JSONL         | `eval/data/swebench-verified-30.jsonl`（`*.draft.jsonl` 为兼容别名）                                             |
| 重算脚本           | `python eval/scripts/select_verified30.py`（需本机 parquet：`../SWE-bench-Verified/test.parquet`）               |

草案时代的 flask 不足用 django 补齐策略已写入冻结决策；solo 冒烟剔除仍可选延后，不阻塞 `frozen_adapted_v1`。

## 预测模式

- `stub`：默认基线，生成一个固定的假 patch，只用来验管线。
- `oracle`：回放 SWE-EVO 金标 patch，只用来检查 harness 和数据链路。
- `real`：使用真实 patch。可通过 `--patch-file` 直接传入，也可从后端
  `summary.json` 的 `worktree_path`（或显式 `--worktree-path`）自动执行
  `git diff` 收集；推荐用 `--ephemeral-from` 建一次性干净 worktree，再 seed patch。

注意：`oracle` 是“拿标准答案去判卷”，不能当作 NewIDE 能力指标。真正看能力时应使用 `real`，并显式传 `--model <name>`（默认 `unspecified` 仅作占位）。

`--ablation B0|B1|B2|B3` 写入 eval run 元数据与 telemetry 标签；后端可通过
`memory_ablation` / CLI `--ablation` 把同一标签写入 `summary.json`（见
[BACKEND_CONTRACT.md](./BACKEND_CONTRACT.md)）。MockMemory 不切换检索行为；真实 B Memory
实现须自行解释该字段。

## Worktree 复用规则（重要）

**禁止**长期复用已脏的共享目录（例如 `sweevo-workspaces/conan-*`）直接出 `real` 分——脏树里的旧改动会污染 diff。

| 方式                                             | 行为                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `--worktree-path` / `--backend-summary`          | 默认要求工作区 **干净**；脏树直接失败                                                                                     |
| `--allow-dirty-worktree`                         | 显式允许从已改动的树收 patch（agent 改完后的 opt-in）                                                                     |
| `--ephemeral-from <sourceRepo>` + `--patch-file` | 在 `.newide/eval-workspaces/<run_id>/repo` 检出 `base_commit`，灌入 patch，收 diff 后默认删除（`--keep-worktree` 可保留） |

推荐能力向流程：

```powershell
# 一次性干净树 + seed 真实 patch（或金标 patch 做链路自检）
pnpm eval:instance -- --instance-id conan-io__conan_2.0.14_2.0.15 --mode real `
  --model claude-acp-real `
  --ephemeral-from ../sweevo-workspaces/conan-2.0.14-2.0.15 `
  --patch-file path\to\agent.patch --run-harness
```

Agent 直接改盘时：先指向干净 ephemeral/clone，改完后再：

```powershell
pnpm eval:instance -- --instance-id ... --mode real --model claude-acp-real `
  --worktree-path <ephemeral-or-clone> --allow-dirty-worktree --run-harness
```

## 一次评测会留下什么

每个 run 目录至少应该包含：

- `dataset-manifest.json`：这次评测用了哪个数据集、哪些实例。
- `run-meta.json`：运行配置，如 prediction mode、模型名、ablation。
- `predictions.jsonl`：NewIDE 提交给 harness 的答案。
- `telemetry.jsonl`：F 方向埋点。
- `summary.json`：评测摘要（`--run-harness` 且报告非空时会写入 resolved/applied 等）。

如果这次已经接入 SWE-EVO harness，还会把 harness report 导入到 `summary.json` 和 `telemetry.jsonl` 中。

## 常用命令

生成单个实例的预测：

```powershell
pnpm eval:instance -- --instance-id conan-io__conan_2.0.14_2.0.15 --mode stub
```

跑固定冒烟子集：

```powershell
pnpm eval:smoke -- --subset v0-smoke --mode stub
```

跑 Verified 30 冻结集（stub 验管线；数据来自子集 `source_jsonl`）：

```powershell
pnpm eval:smoke -- --subset verified-30 --mode stub
```

校验后端 summary 契约 / harness 环境：

```powershell
pnpm eval:verify-backend-contract -- --fixture
pnpm eval:check-harness
# 或：wsl --cd . -e bash eval/scripts/check-harness-env.sh
```

后端对接细节见 [BACKEND_CONTRACT.md](./BACKEND_CONTRACT.md)。

跑金标冒烟，也就是用 SWE-EVO 标准答案验证评测链路：

```powershell
pnpm eval:smoke -- --subset v0-smoke --mode oracle --run-id oracle_smoke
```

把 NewIDE 的 `predictions.jsonl` 转成 SWE-EVO 当前脚本能吃的 harness 输入（独立入口，等价于 instance 上的 `--run-harness` 准备阶段）：

```powershell
pnpm eval:sweevo-harness -- --predictions .newide/eval/<run>/predictions.jsonl --run-id <run> --dry-run
```

去掉 `--dry-run` 后会真正调用 SWE-EVO harness。真实执行需要本机 SWE-EVO 环境和 Docker 可用。

**Windows 注意**：SWE-bench harness 依赖 Linux（`resource` 模块等）。在 PowerShell 里请走 WSL：

```powershell
$env:NEWIDE_SWE_EVO_PYTHON = "wsl"
# 可选：$env:NEWIDE_SWE_EVO_WSL_DISTRO = "Ubuntu-22.04"
# 可选：$env:NEWIDE_SWE_EVO_WSL_PYTHON = "python3"
pnpm eval:instance -- --instance-id <id> --mode oracle --run-harness
```

也可把 `NEWIDE_SWE_EVO_PYTHON` 设成任意本机 Python 可执行文件路径（例如 conda `py310`）。

从后端运行结果自动收集 patch，并直接交给 SWE-EVO（后端 worktree 必须干净，或加 `--allow-dirty-worktree`）：

```powershell
pnpm eval:instance -- --instance-id <instance-id> --mode real --model <name> `
  --backend-summary .newide/runs/<backend-run>/summary.json --run-harness
```

联调时可加 `--harness-dry-run`，只生成 `predictions.jsonl`、OpenHands trajectory
和 harness 命令，不启动 Docker。也可以用 `--worktree-path <dir>` 跳过
`summary.json` 解析。

已有外部 harness report 时可：

- 主路径：`--harness-report <report.json>`（与或不与 `--run-harness` 同用）
- 旁路导入整次 run：`pnpm eval:record-harness ...`（用于把外部判卷结果收进 F 产物约定）

自动收集使用临时 Git index，相对数据集实例的 `base_commit` 生成 binary diff；
它会包含已修改、已删除和未跟踪（但未被 `.gitignore` 忽略）的文件，同时不会改动
后端 worktree 的真实 Git index。worktree 必须位于 Git 仓库中，并且仓库中能解析
该 `base_commit`。共享脏树默认会被拒绝——见上文「Worktree 复用规则」。

## 方向一：SWE-EVO 记忆消融批跑（agent 直写 worktree）

能力向闭环：**按需懒 clone mirror（D 盘）→ ephemeral worktree @ `base_commit` → agent 直接改盘 → 结束后 `git diff` 收 patch → predictions（可选 harness）**。

不默认「先把 subset 里所有 repo 一次缓存满」。Mirror 根目录默认 `D:\newide-sweevo-mirrors`（`NEWIDE_SWE_MIRRORS_ROOT` 可改）。同 repo 多 instance / 多 ablation 共用 mirror；每任务另开 ephemeral，跑完默认删除 worktree。

```powershell
# 可选：只预热当前要跑的那一条（不要对整个 subset 盲拉）
pnpm eval:ensure-mirrors -- --instance-id conan-io__conan_2.0.14_2.0.15 --subset v0-smoke

# 单条联调（B2 + harness dry-run）
pnpm eval:sweevo-ablation -- --subset v0-smoke `
  --instance-id conan-io__conan_2.0.14_2.0.15 --ablations B2 --harness-dry-run

# 默认 v0-smoke × B0,B1,B2（真 Claude + Postgres；耗时长）
pnpm eval:sweevo-ablation -- --subset v0-smoke

# 真 Docker 判卷时再加
pnpm eval:sweevo-ablation -- --subset v0-smoke --run-harness

# 整仓覆盖子集 × B0,B1,B2 + 真 Docker 判卷（14×3，耗时长）
pnpm eval:sweevo-ablation -- --subset v0-repo-full --ablations "B0,B1,B2" --run-harness
```

方向一批跑默认开启 `NEWIDE_SWE_EVO_BLOCK_INTERNET=1`（对齐 SWE-EVO 论文：生成阶段禁止外网检索）。实现为 ACP 权限门拒绝 `WebFetch`/`WebSearch`/出网 Bash，并在 ephemeral worktree 写入 `.claude/settings.json` deny 列表。工作区是只含 `base_commit` 的单提交浅克隆，不共享 mirror 的 tags、refs 或对象库，并在启动 Agent 前删除 remote，避免通过目标 release tag 提取 gold delta。数据集 `PRs[].patch_without_test` **不会**注入 prompt（避免泄漏金标 patch）。注意：PowerShell 下逗号参数需加引号 `"B0,B1,B2"`。

### 离线 PR/Issue context（论文默认设定）

公开 HF `problem_statement` 只有 release-note。要对齐论文「release-note + PR/issue context」：

```powershell
# 推荐设置 GITHUB_TOKEN / GH_TOKEN；无 token 时约 60 次/小时，可断点续跑
pnpm eval:build-pr-context -- --subset v0-repo-full

# 缓存：eval/data/pr-issue-cache/*.json
# 增强 JSONL：eval/data/sweevo-v0-repo-full-prctx.jsonl
# 随后批跑：
pnpm eval:sweevo-ablation -- --subset v0-repo-full-prctx --ablations "B0,B1,B2" --run-harness
```

产物：`../.newide-experiments/sweevo-ablation/<ts>/`（可用 `NEWIDE_SWEEVO_ABLATION_ROOT` 改根）。后端 `summary.worktree_path` 在传入 `workspace_path` 时绑定 agent 的 git 树；评测用 `--allow-dirty-worktree` 从该树相对 `base_commit` 收集 patch。契约见 [BACKEND_CONTRACT.md](./BACKEND_CONTRACT.md)。

## 怎么理解这套系统

人话版流程是：

1. NewIDE 先交答案，生成 `predictions.jsonl`。
2. SWE-EVO harness 负责判卷，判断 patch 是否能应用、是否解决问题、有没有 P2P 回归。
3. F 方向评测层把数据集、答案、判卷结果和 telemetry 收到同一个 run 目录里，方便复现和解释。

所以 `stub` 用来看管线，`oracle` 用来看判卷系统，`real` 才用于看 NewIDE 的真实能力。

## CooperBench（§2 P1-A）速查

```powershell
# stub 冒烟（无需 Docker；需同级 ../CooperBench/dataset）
pnpm eval:cooperbench-smoke -- --subset v0-smoke --mode stub --setting coop

# oracle + harness dry-run
pnpm eval:cooperbench-case -- --case-id dottxt_ai_outlines_task__1655__f1_f3 `
  --mode oracle --setting coop --run-harness --harness-dry-run
```

完整说明见 `eval/cooperbench/README.md`。
