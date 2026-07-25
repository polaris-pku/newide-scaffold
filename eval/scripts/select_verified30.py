#!/usr/bin/env python3
"""Build a provisional SWE-bench Verified 30-case slice per RFC §4.1 quotas.

Reads local Verified parquet (default D:/SWE-bench-Verified/test.parquet) and
writes draft subset + status JSON under eval/. Marked draft because Verified
inventory cannot satisfy flask×6.
"""

from __future__ import annotations

import argparse
import collections
import json
import re
from pathlib import Path

import pyarrow.parquet as pq

REPO_QUOTA = {
    "django/django": 9,
    "scikit-learn/scikit-learn": 9,
    "psf/requests": 6,
    "pallets/flask": 6,
}
TIER_QUOTA = {"easy": 10, "medium": 10, "hard": 10}
TIER_MAP = {
    "<15 min fix": "easy",
    "15 min - 1 hour": "medium",
    "1-4 hours": "hard",
    ">4 hours": "hard",
}


def word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9_]+", text or ""))


def patch_files(patch: str) -> int:
    return len(re.findall(r"^diff --git ", patch or "", flags=re.M))


def normalize_list_field(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else [value]
        except Exception:
            return [value]
    return []


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--parquet",
        default=r"D:\SWE-bench-Verified\test.parquet",
        help="Local SWE-bench Verified parquet path",
    )
    parser.add_argument(
        "--eval-root",
        default=str(Path(__file__).resolve().parents[1]),
        help="eval/ directory",
    )
    args = parser.parse_args()

    parquet_path = Path(args.parquet)
    eval_root = Path(args.eval_root)
    datasets_dir = eval_root / "datasets"
    data_dir = eval_root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    datasets_dir.mkdir(parents=True, exist_ok=True)

    rows = pq.read_table(parquet_path).to_pylist()

    pool = []
    excluded = []
    for row in rows:
        repo = row["repo"]
        if repo not in REPO_QUOTA:
            continue
        tier = TIER_MAP.get(row.get("difficulty") or "", "unknown")
        reasons = []
        wc = word_count(row.get("problem_statement") or "")
        if wc < 30:
            reasons.append("problem_statement_lt_30_words")
        soft_flags = []
        problem = (row.get("problem_statement") or "").lower()
        if any(token in problem for token in ("cython", "pybind", "cffi", "swig")):
            soft_flags.append("may_need_native_ext")
        item = {
            "instance_id": row["instance_id"],
            "repo": repo,
            "difficulty_raw": row.get("difficulty"),
            "tier": tier,
            "problem_word_count": wc,
            "gold_patch_files": patch_files(row.get("patch") or ""),
            "version": row.get("version"),
            "base_commit": row["base_commit"],
            "soft_flags": soft_flags,
            "excluded_reasons": reasons,
        }
        if reasons:
            excluded.append(item)
        else:
            pool.append(item)

    avail = collections.Counter(item["repo"] for item in pool)
    avail_tier = collections.Counter((item["repo"], item["tier"]) for item in pool)

    selected: list[dict] = []
    repo_counts = {repo: 0 for repo in REPO_QUOTA}
    tier_counts = {tier: 0 for tier in TIER_QUOTA}
    repo_order = sorted(REPO_QUOTA.keys(), key=lambda repo: (avail[repo], REPO_QUOTA[repo]))
    candidates = sorted(pool, key=lambda item: (item["repo"], item["tier"], item["instance_id"]))

    for repo in repo_order:
        need = REPO_QUOTA[repo]
        for tier in ("hard", "medium", "easy"):
            for candidate in candidates:
                if repo_counts[repo] >= need:
                    break
                if (
                    candidate["repo"] != repo
                    or candidate["tier"] != tier
                    or candidate in selected
                    or tier_counts[tier] >= TIER_QUOTA[tier]
                ):
                    continue
                selected.append(candidate)
                repo_counts[repo] += 1
                tier_counts[tier] += 1

    for repo in repo_order:
        need = REPO_QUOTA[repo]
        for candidate in candidates:
            if repo_counts[repo] >= need:
                break
            if candidate["repo"] != repo or candidate in selected:
                continue
            selected.append(candidate)
            repo_counts[repo] += 1
            if candidate["tier"] in tier_counts:
                tier_counts[candidate["tier"]] += 1

    selected_ids = {item["instance_id"] for item in selected}
    if len(selected) < 30:
        for candidate in candidates:
            if len(selected) >= 30:
                break
            if candidate["instance_id"] in selected_ids:
                continue
            if candidate["repo"] not in ("django/django", "scikit-learn/scikit-learn"):
                continue
            selected.append(candidate)
            selected_ids.add(candidate["instance_id"])
            repo_counts[candidate["repo"]] += 1
            if candidate["tier"] in tier_counts:
                tier_counts[candidate["tier"]] += 1

    selected = sorted(selected, key=lambda item: item["instance_id"])

    gaps = {
        "repo_quota_shortfall": {
            repo: max(0, REPO_QUOTA[repo] - avail[repo]) for repo in REPO_QUOTA
        },
        "notes": [
            "SWE-bench Verified 中 pallets/flask 仅 1 条，无法满足 RFC flask×6。",
            "psf/requests 仅 8 条，可满足 requests×6。",
            "solo Driver 冒烟剔除（地板效应）需跑 harness 后才能落地，本草案未执行。",
            "python:3.10-slim 原生依赖剔除目前仅软标记 soft_flags，未强排除。",
        ],
    }

    status = {
        "bench": "SWE-bench Verified",
        "source_parquet": str(parquet_path),
        "rfc_repo_quota": REPO_QUOTA,
        "rfc_tier_quota": TIER_QUOTA,
        "pool_available_by_repo": dict(avail),
        "pool_available_by_repo_tier": {
            f"{repo}|{tier}": count for (repo, tier), count in sorted(avail_tier.items())
        },
        "excluded_lt_30_words": len(excluded),
        "selected_count": len(selected),
        "selected_by_repo": dict(collections.Counter(item["repo"] for item in selected)),
        "selected_by_tier": dict(collections.Counter(item["tier"] for item in selected)),
        "gaps": gaps,
        "list_status": "draft_provisional",
        "blocker_for_formal_list": (
            "flask Verified 库存不足（1 < 6）；正式清单需组长确认是否改配额或换数据源。"
        ),
    }

    selected_jsonl = data_dir / "swebench-verified-30.draft.jsonl"
    by_id = {row["instance_id"]: row for row in rows}
    with selected_jsonl.open("w", encoding="utf-8") as handle:
        for item in selected:
            row = by_id[item["instance_id"]]
            handle.write(
                json.dumps(
                    {
                        "repo": row["repo"],
                        "instance_id": row["instance_id"],
                        "base_commit": row["base_commit"],
                        "patch": row["patch"],
                        "test_patch": row.get("test_patch") or "",
                        "problem_statement": row["problem_statement"],
                        "FAIL_TO_PASS": normalize_list_field(row.get("FAIL_TO_PASS")),
                        "PASS_TO_PASS": normalize_list_field(row.get("PASS_TO_PASS")),
                        "difficulty": row.get("difficulty"),
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

    subset = {
        "subset_id": "verified-30",
        "description": (
            "RFC §4.1 provisional 30-case slice from SWE-bench Verified "
            "(DRAFT; flask quota unmet)."
        ),
        "source_dataset_version": "SWE-bench_Verified-hf",
        "source_jsonl": "eval/data/swebench-verified-30.draft.jsonl",
        "selection_rule": (
            "Filter repos django/sklearn/requests/flask; drop problem_statement <30 words; "
            "fill RFC quotas with deterministic instance_id order; top up django/sklearn "
            "if flask shortfall keeps total <30."
        ),
        "environment_notes": [
            "Sandbox image target: python:3.10-slim",
            "Full Verified parquet local cache expected at D:/SWE-bench-Verified/test.parquet",
            "Formal list pending team confirmation due to flask inventory=1 in Verified.",
        ],
        "list_status": "draft_provisional",
        "rfc_target": {
            "django": 9,
            "scikit-learn": 9,
            "requests": 6,
            "flask": 6,
            "easy": 10,
            "medium": 10,
            "hard": 10,
        },
        "actual_counts": {
            "by_repo": status["selected_by_repo"],
            "by_tier": status["selected_by_tier"],
        },
        "instance_ids": [item["instance_id"] for item in selected],
        "instances": selected,
    }

    (datasets_dir / "verified-30.status.json").write_text(
        json.dumps(status, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (datasets_dir / "verified-30.json").write_text(
        json.dumps(subset, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(f"selected_jsonl={selected_jsonl} n={len(selected)}")
    print(f"selected_by_repo={status['selected_by_repo']}")
    print(f"selected_by_tier={status['selected_by_tier']}")
    print(f"shortfall={gaps['repo_quota_shortfall']}")


if __name__ == "__main__":
    main()
