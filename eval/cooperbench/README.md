# CooperBench F-eval 接入（§2 P1-A）

本目录把 CooperBench 接到 NewIDE F 评测产物约定，与 SWE-EVO 管线平行：

- `stub`：假 patch，只验写产物 / log 布局
- `oracle`：回放数据集 `featureN/feature.patch` 金标（验判卷链路，≠ NewIDE 能力）
- `real`：传入真实 agent patch 后出分

本仓**不复制** CooperBench 全量数据；默认指向同级 `../CooperBench`。

## 前置

1. 同级有 CooperBench 仓库且已 `cooperbench prepare`（或已有 `dataset/`）
2. 真判卷需要 Docker（`--backend docker`，默认）以及可调用的 `python -m cooperbench.cli`

推荐在 WSL 安装独立 venv（勿用系统 Python）：

```bash
bash eval/scripts/setup-cooperbench-venv.sh
bash eval/scripts/check-harness-env.sh
```

环境变量（可选）：

- `NEWIDE_COOPERBENCH_ROOT`
- `NEWIDE_COOPERBENCH_DATASET_DIR`
- `NEWIDE_COOPERBENCH_VENV`（默认 `../CooperBench/.venv`）
- `NEWIDE_COOPERBENCH_PYTHON`（覆盖 harness 使用的解释器）

Harness adapter 会优先使用 `CooperBench/.venv/bin/python`。

## 子集

| subset     | 说明                            |
| ---------- | ------------------------------- |
| `v0-smoke` | 2 pair（core 前两题），管线冒烟 |
| `core`     | 官方 core 10 pair，短程协调对照 |

`case_id` 格式：`{repo}__{task_id}__f{n}_f{m}`  
例：`dottxt_ai_outlines_task__1655__f1_f3`

## 常用命令

```powershell
# stub 冒烟（无需 Docker）
pnpm eval:cooperbench-smoke -- --subset v0-smoke --mode stub --setting coop

# oracle 单题 + harness dry-run（生成 cooperbench eval 命令，不启 Docker）
pnpm eval:cooperbench-case -- --case-id dottxt_ai_outlines_task__1655__f1_f3 `
  --mode oracle --setting coop --run-harness --harness-dry-run

# real coop：两份 agent patch
pnpm eval:cooperbench-case -- --case-id dottxt_ai_outlines_task__1655__f1_f3 `
  --mode real --setting coop --model my-agent `
  --agent1-patch path\to\a1.patch --agent2-patch path\to\a2.patch --run-harness

# 对已有 run 目录跑 / dry-run harness
pnpm eval:cooperbench-harness -- --run-dir .newide\eval\<run> --dry-run
```

## 产物

每个 run 目录：

- `dataset-manifest.json` / `run-meta.json` / `predictions.jsonl` / `summary.json` / `telemetry.jsonl`
- `cooperbench-logs/newide/<setting>/<repo>/<task>/<fN_fM>/`（供 `cooperbench eval` 发现）
- `--run-harness` 成功后：`harness-report.json`（按 `case_id` 聚合的 `eval.json`）

`summary` 含 `both_passed_count`、`coordination_deficit_sum`；telemetry 写入 `harness.cooperbench_evaluated`。

## 指标说明

| 字段                   | 含义                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `both_passed`          | CooperBench `eval.json` 原字段                                                                        |
| `coordination_deficit` | 若报告带 `solo_both_passed`：solo 过且 coop 不过 → 1；否则单 setting 时用「未 both_passed → 1」作代理 |
| `failure_taxonomy`     | 由 feature/merge/error 粗分类（非论文完整 taxonomy）                                                  |

真 P1-A 对照需要同 case 的 **solo + coop** 两趟；scaffold 先保证单 setting 管线与埋点可复现。
