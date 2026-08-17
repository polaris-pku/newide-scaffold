# Eval ↔ Backend 契约（`--backend-summary`）

评测层**不**通过 HTTP 调后端。能力向出分用文件契约。

## Summary 必填字段

后端 run 目录下的 `summary.json`（`IntegrationV0Summary`）至少包含：

| 字段              | 用途                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `worktree_path`   | eval `--backend-summary` 唯一强依赖；须为**绝对或可解析**路径                                 |
| `memory_ablation` | 可选；`B0`–`B3`。写入 summary / `memory.context_pack_built` 事件，供与 eval `--ablation` 对齐 |
| `token_usage`     | 可选；`newide.token_usage.v1`。LiteLLM proxy +（如有）Claude session 汇总；消融脚本优先读此字段 |

## Worktree 规则（能力向）

`worktree_path` 必须指向：

1. 真实 Git 仓库根（或 worktree）；
2. 已 checkout 到该 instance 的 `base_commit`（或能 `git rev-parse` 到该 commit）；
3. Agent 改完后的树通常是脏的 → eval 侧加 `--allow-dirty-worktree`。

**能力向标准跑法**：`run.create` 的 `workspace_path` 就是已检出的 SWE worktree；agent **直接在该树写文件**。后端若传入 `workspacePath`，`summary.worktree_path` 会绑定到该路径（不再用 materializer 产物目录冒充源码树）。评测收 patch：对 `base_commit` 做 `git diff`（`collectWorktreePatch` / `--backend-summary` + `--allow-dirty-worktree`）。

Integration v0 默认 `WorktreeMaterializer` 仍只写 artifact JSON，**不是** SWE checkout。未传 `workspacePath` 的 demo 路径下 `summary.worktree_path` 仍指向 materializer 目录。接 eval 时也可：

- 跳过 `--backend-summary`，改用 `--worktree-path <agent-tree> --allow-dirty-worktree`；或
- `--ephemeral-from` + `--patch-file`（seed 已知 patch，不经 agent）。

## Ablation

| 层                        | 行为                                                                |
| ------------------------- | ------------------------------------------------------------------- |
| Eval CLI `--ablation`     | 写入 eval `run-meta` / summary / telemetry 标签                     |
| Backend `memory_ablation` | 写入 `summary.json` 与 `memory.context_pack_built.payload.ablation` |
| MockMemoryProvider        | **不**按 B0–B3 切换检索；真实 B Memory 实现须自行解释该字段         |

推荐联调：eval 与 backend 使用同一 ablation 标签，避免对照实验串台。

## 推荐命令

```powershell
# 后端跑完后
pnpm eval:instance -- --instance-id <id> --mode real --model <name> `
  --ablation B2 `
  --backend-summary .newide/runs/<backend-run>/summary.json `
  --allow-dirty-worktree `
  --run-harness --harness-dry-run

# 校验契约（不启 Docker）
pnpm eval:verify-backend-contract -- --summary .newide/runs/<backend-run>/summary.json
```
