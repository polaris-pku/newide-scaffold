# Verified-30 冻结决策（frozen_adapted_v1）

日期：2026-07-27  
范围：`eval/datasets/verified-30.json` / `eval/data/swebench-verified-30.jsonl`

## 决议

1. **接受 flask 库存缺口**：SWE-bench Verified 中 `pallets/flask` 仅 1 条，无法满足 RFC §4.1 的 flask×6。正式清单采用 **adapted 配额**：flask 全收（1），不足部分用 django/sklearn 确定性补齐到 30，并保持难度阶梯 10/10/10。
2. **原生依赖硬过滤**：问题描述含 cython/pybind/cffi/swig 的 case 标为 `may_need_native_ext` 并 **硬排除**（目标镜像 `python:3.10-slim`）。
3. **Solo Driver 冒烟地板剔除**：延后到真 harness 出结果。结果写入 `eval/data/solo-smoke-results.jsonl`（每行 `{ "instance_id", "exclude": true|false, "reason"? }`）后重跑 `python eval/scripts/select_verified30.py` 即可应用；在此之前 `solo_smoke_filter=deferred_pending_harness`，**不阻塞** `frozen_adapted_v1` 冻结。

## 非决议

- 不改 RFC 原文目标配额记录（仍保留在 `rfc_target` / `rfc_repo_quota` 字段供对照）。
- 不把 draft 清单继续当「未确认」；`list_status` 升级为 `frozen_adapted_v1`。

## 重算

```powershell
python eval/scripts/select_verified30.py
# 可选：先写 solo-smoke-results.jsonl 再重算
```
