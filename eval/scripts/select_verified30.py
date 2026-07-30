#!/usr/bin/env python3
"""Build the SWE-bench Verified 30-case slice per RFC §4.1 with adapted freeze policy.

Reads local Verified parquet (default ../SWE-bench-Verified/test.parquet
relative to newide-scaffold) and writes subset + status JSON under eval/.

Freeze policy (see eval/datasets/verified-30.DECISION.md):
  - Accept flask inventory shortfall: use all available flask (1) and top up
    django/sklearn to keep total=30 and tier 10/10/10.
  - Hard-exclude cases flagged may_need_native_ext (python:3.10-slim).
  - Solo Driver smoke floor-effect filter remains deferred until harness results
    land in eval/data/solo-smoke-results.jsonl.
"""

from __future__ import annotations

import argparse
import collections
import json
import re
from pathlib import Path

import pyarrow.parquet as pq

RFC_REPO_QUOTA = {
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
NATIVE_TOKENS = ("cython", "pybind", "cffi", "swig")
LIST_STATUS = "frozen_adapted_v1"
SOLO_SMOKE_STATUS = "deferred_pending_harness"
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PARQUET = REPO_ROOT / ".." / "SWE-bench-Verified" / "test.parquet"


def to_repo_relative(path: Path) -> str:
    """Prefer a path relative to newide-scaffold; fall back to as-given."""
    resolved = path.resolve()
    try:
        return resolved.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        pass
    try:
        return Path("..", resolved.relative_to(REPO_ROOT.parent)).as_posix()
    except ValueError:
        return path.as_posix()


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


def apply_solo_smoke_exclusions(
    pool: list[dict], solo_results_path: Path
) -> tuple[list[dict], list[str]]:
    """Drop instance_ids marked exclude=true in optional harness smoke results."""
    if not solo_results_path.is_file():
        return pool, []
    excluded_ids: list[str] = []
    with solo_results_path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if row.get("exclude") is True and row.get("instance_id"):
                excluded_ids.append(row["instance_id"])
    if not excluded_ids:
        return pool, []
    excluded = set(excluded_ids)
    return [item for item in pool if item["instance_id"] not in excluded], excluded_ids


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--parquet",
        default=str(DEFAULT_PARQUET),
        help="Local SWE-bench Verified parquet path (default: ../SWE-bench-Verified/test.parquet)",
    )
    parser.add_argument(
        "--eval-root",
        default=str(Path(__file__).resolve().parents[1]),
        help="eval/ directory",
    )
    parser.add_argument(
        "--solo-smoke-results",
        default="",
        help="Optional JSONL of {instance_id, exclude:bool} from solo Driver smoke",
    )
    args = parser.parse_args()

    parquet_path = Path(args.parquet)
    eval_root = Path(args.eval_root)
    datasets_dir = eval_root / "datasets"
    data_dir = eval_root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    datasets_dir.mkdir(parents=True, exist_ok=True)

    solo_results_path = (
        Path(args.solo_smoke_results)
        if args.solo_smoke_results
        else data_dir / "solo-smoke-results.jsonl"
    )

    rows = pq.read_table(parquet_path).to_pylist()

    pool = []
    excluded = []
    native_hard_excluded = []
    for row in rows:
        repo = row["repo"]
        if repo not in RFC_REPO_QUOTA:
            continue
        tier = TIER_MAP.get(row.get("difficulty") or "", "unknown")
        reasons = []
        wc = word_count(row.get("problem_statement") or "")
        if wc < 30:
            reasons.append("problem_statement_lt_30_words")
        soft_flags = []
        problem = (row.get("problem_statement") or "").lower()
        if any(token in problem for token in NATIVE_TOKENS):
            soft_flags.append("may_need_native_ext")
            reasons.append("hard_exclude_may_need_native_ext")
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
            if "hard_exclude_may_need_native_ext" in reasons:
                native_hard_excluded.append(item["instance_id"])
        else:
            pool.append(item)

    pool, solo_excluded_ids = apply_solo_smoke_exclusions(pool, solo_results_path)
    solo_smoke_status = (
        "applied" if solo_excluded_ids else SOLO_SMOKE_STATUS
    )

    avail = collections.Counter(item["repo"] for item in pool)
    avail_tier = collections.Counter((item["repo"], item["tier"]) for item in pool)

    # Effective quota: take min(RFC, available) per repo, then top up to 30.
    effective_quota = {
        repo: min(RFC_REPO_QUOTA[repo], avail[repo]) for repo in RFC_REPO_QUOTA
    }

    selected: list[dict] = []
    repo_counts = {repo: 0 for repo in RFC_REPO_QUOTA}
    tier_counts = {tier: 0 for tier in TIER_QUOTA}
    repo_order = sorted(
        RFC_REPO_QUOTA.keys(), key=lambda repo: (avail[repo], RFC_REPO_QUOTA[repo])
    )
    candidates = sorted(pool, key=lambda item: (item["repo"], item["tier"], item["instance_id"]))

    for repo in repo_order:
        need = effective_quota[repo]
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
        need = effective_quota[repo]
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
            # Prefer filling underfilled tiers first.
            if (
                candidate["tier"] in tier_counts
                and tier_counts[candidate["tier"]] >= TIER_QUOTA[candidate["tier"]]
            ):
                continue
            selected.append(candidate)
            selected_ids.add(candidate["instance_id"])
            repo_counts[candidate["repo"]] += 1
            if candidate["tier"] in tier_counts:
                tier_counts[candidate["tier"]] += 1

    # Final top-up if tiers already full but count still <30.
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
            repo: max(0, RFC_REPO_QUOTA[repo] - avail[repo]) for repo in RFC_REPO_QUOTA
        },
        "notes": [
            "Freeze policy: accept flask Verified inventory=1; django/sklearn top-up to 30.",
            "Hard-excluded may_need_native_ext for python:3.10-slim target.",
            (
                "solo Driver smoke floor-effect filter applied from "
                f"{solo_results_path.name}."
                if solo_excluded_ids
                else "solo Driver smoke floor-effect filter deferred until harness results "
                "are written to eval/data/solo-smoke-results.jsonl."
            ),
        ],
    }

    status = {
        "bench": "SWE-bench Verified",
        "source_parquet": to_repo_relative(parquet_path),
        "rfc_repo_quota": RFC_REPO_QUOTA,
        "effective_repo_quota": effective_quota,
        "rfc_tier_quota": TIER_QUOTA,
        "pool_available_by_repo": dict(avail),
        "pool_available_by_repo_tier": {
            f"{repo}|{tier}": count for (repo, tier), count in sorted(avail_tier.items())
        },
        "excluded_lt_30_words": sum(
            1 for item in excluded if "problem_statement_lt_30_words" in item["excluded_reasons"]
        ),
        "hard_excluded_native_ext": native_hard_excluded,
        "solo_smoke_excluded": solo_excluded_ids,
        "solo_smoke_filter": solo_smoke_status,
        "selected_count": len(selected),
        "selected_by_repo": dict(collections.Counter(item["repo"] for item in selected)),
        "selected_by_tier": dict(collections.Counter(item["tier"] for item in selected)),
        "gaps": gaps,
        "list_status": LIST_STATUS,
        "decision": "eval/datasets/verified-30.DECISION.md",
        "blocker_for_formal_list": None,
    }

    selected_jsonl = data_dir / "swebench-verified-30.jsonl"
    draft_alias = data_dir / "swebench-verified-30.draft.jsonl"
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
    # Keep draft filename as a compatibility alias for older docs/tools.
    draft_alias.write_text(selected_jsonl.read_text(encoding="utf-8"), encoding="utf-8")

    subset = {
        "subset_id": "verified-30",
        "description": (
            "RFC §4.1 30-case slice from SWE-bench Verified "
            "(frozen_adapted_v1; flask inventory adapted)."
        ),
        "source_dataset_version": "SWE-bench_Verified-hf",
        "source_jsonl": "eval/data/swebench-verified-30.jsonl",
        "selection_rule": (
            "Filter repos django/sklearn/requests/flask; drop problem_statement <30 words; "
            "hard-exclude may_need_native_ext; fill effective quotas (min(RFC, available)) "
            "with deterministic instance_id order; top up django/sklearn to 30 while "
            "preferring underfilled difficulty tiers."
        ),
        "environment_notes": [
            "Sandbox image target: python:3.10-slim",
            "Full Verified parquet local cache expected at ../SWE-bench-Verified/test.parquet",
            "Solo smoke floor-effect filter optional via eval/data/solo-smoke-results.jsonl",
        ],
        "list_status": LIST_STATUS,
        "solo_smoke_filter": solo_smoke_status,
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
    print(f"list_status={LIST_STATUS}")
    print(f"selected_by_repo={status['selected_by_repo']}")
    print(f"selected_by_tier={status['selected_by_tier']}")
    print(f"native_hard_excluded={len(native_hard_excluded)}")
    print(f"solo_smoke_filter={solo_smoke_status}")
    print(f"shortfall={gaps['repo_quota_shortfall']}")


if __name__ == "__main__":
    main()
