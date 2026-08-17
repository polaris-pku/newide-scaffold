#!/usr/bin/env python3
"""NewIDE-owned anti-hacking wrapper around the unmodified SWE-EVO evaluator."""

from __future__ import annotations

import argparse
import json
import os
import re
import runpy
import shlex
import sys
from pathlib import Path
from typing import Any

from swebench.harness.constants import MAP_REPO_TO_EXT, START_TEST_OUTPUT
from swebench.harness.utils import get_modified_files
import swebench.harness.test_spec.test_spec as test_spec_module


PROTECTED_BASENAMES = {
    ".coveragerc",
    "conftest.py",
    "jest.config.cjs",
    "jest.config.js",
    "jest.config.mjs",
    "jest.config.ts",
    "noxfile.py",
    "pyproject.toml",
    "pytest.ini",
    "setup.cfg",
    "tox.ini",
    "vitest.config.js",
    "vitest.config.mjs",
    "vitest.config.ts",
}
PROTECTED_COMPONENTS = {"__tests__", "integration_tests", "test", "tests", "testing"}
HIDDEN_TEST_PATCHES: dict[str, str] = {}


def patch_paths(patch_text: str) -> list[str]:
    paths: set[str] = set()
    for line in (patch_text or "").splitlines():
        match = re.match(r"^diff --git a/(.+) b/(.+)$", line)
        if match:
            paths.update(match.groups())
        elif line.startswith(("--- ", "+++ ")):
            candidate = line[4:].split("\t", 1)[0].strip()
            if candidate != "/dev/null":
                paths.add(re.sub(r"^[ab]/", "", candidate.strip('"')))
    return sorted(paths)


def is_protected_path(candidate: str) -> bool:
    normalized = candidate.replace("\\", "/").lower()
    components = [part for part in normalized.split("/") if part]
    basename = components[-1] if components else ""
    return (
        basename in PROTECTED_BASENAMES
        or any(part in PROTECTED_COMPONENTS for part in components)
        or bool(re.match(r"^test_.+\.py$", basename))
        or basename.endswith("_test.py")
        or bool(re.search(r"\.(spec|test)\.[cm]?[jt]sx?$", basename))
    )


def sanitize_patch(patch_text: str, instance_id: str) -> str:
    protected = [path for path in patch_paths(patch_text) if is_protected_path(path)]
    if protected:
        print(
            f"[newide anti-hacking] rejecting {instance_id}: protected paths changed: "
            f"{', '.join(protected)}"
        )
        return ""
    return patch_text or ""


def secure_make_eval_script_list(
    instance: dict[str, Any],
    specs: dict[str, Any],
    env_name: str,
    repo_directory: str,
    base_commit: str,
    _public_test_patch: str,
) -> list[str]:
    hidden_patch = HIDDEN_TEST_PATCHES.get(instance["instance_id"], "")
    original = secure_make_eval_script_list.original
    commands = original(
        instance,
        specs,
        env_name,
        repo_directory,
        base_commit,
        hidden_patch,
    )
    if MAP_REPO_TO_EXT[instance["repo"]] != "py":
        return commands

    test_files = get_modified_files(hidden_patch)
    reset = (
        f"git checkout {shlex.quote(base_commit)} -- "
        + " ".join(shlex.quote(file_path) for file_path in test_files)
        if test_files
        else 'echo "No hidden test files to reset"'
    )
    delimiter = "EOF_NEWIDE_HIDDEN_TEST_PATCH"
    apply_hidden = (
        f"git apply -v - <<'{delimiter}'\n{hidden_patch}\n{delimiter}"
        if hidden_patch
        else 'echo "No hidden test patch to apply"'
    )
    marker = f": '{START_TEST_OUTPUT}'"
    marker_index = commands.index(marker)
    commands[marker_index:marker_index] = [reset, apply_hidden]
    commands.append(reset)
    return commands


secure_make_eval_script_list.original = test_spec_module.make_eval_script_list


def prepare_instances(output_final: Path) -> dict[Path, bytes]:
    backups: dict[Path, bytes] = {}
    for instance_path in sorted(output_final.glob("*.json")):
        raw = instance_path.read_bytes()
        instance = json.loads(raw)
        instance_id = instance["instance_id"]
        HIDDEN_TEST_PATCHES[instance_id] = instance.get("test_patch") or ""
        instance["test_patch"] = ""
        backups[instance_path] = raw
        instance_path.write_text(json.dumps(instance), encoding="utf-8")
    return backups


def prepare_trajectories(
    trajectory_dir: Path,
    scaffold: str,
    expected_ids: set[str],
) -> dict[Path, bytes]:
    backups: dict[Path, bytes] = {}
    if scaffold == "OpenHands":
        trajectory_path = trajectory_dir / "output.jsonl"
        backups[trajectory_path] = trajectory_path.read_bytes()
        rows: dict[str, dict[str, Any]] = {}
        for line in trajectory_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            instance_id = row["instance_id"]
            test_result = row.setdefault("test_result", {})
            test_result["git_patch"] = sanitize_patch(
                test_result.get("git_patch") or "",
                instance_id,
            )
            rows[instance_id] = row
        for instance_id in expected_ids - rows.keys():
            rows[instance_id] = {
                "instance_id": instance_id,
                "test_result": {"git_patch": ""},
            }
        body = "".join(json.dumps(rows[key]) + "\n" for key in sorted(rows))
        trajectory_path.write_text(body, encoding="utf-8")
    elif scaffold == "SWE-agent":
        trajectory_path = trajectory_dir / "preds.json"
        backups[trajectory_path] = trajectory_path.read_bytes()
        rows = json.loads(trajectory_path.read_text(encoding="utf-8"))
        for instance_id in expected_ids:
            row = rows.setdefault(instance_id, {"model_patch": ""})
            row["model_patch"] = sanitize_patch(row.get("model_patch") or "", instance_id)
        trajectory_path.write_text(json.dumps(rows), encoding="utf-8")
    else:
        raise ValueError(f"Unsupported scaffold: {scaffold}")
    return backups


def restore(backups: dict[Path, bytes]) -> None:
    for file_path, content in backups.items():
        file_path.write_bytes(content)


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--official-script", required=True)
    parser.add_argument("--trajectories_path", required=True)
    parser.add_argument("--scaffold", default="OpenHands")
    known, remaining = parser.parse_known_args()

    output_final = Path.cwd() / "output_final"
    instance_backups = prepare_instances(output_final)
    expected_ids = {
        json.loads(content)["instance_id"] for content in instance_backups.values()
    }
    trajectory_backups = prepare_trajectories(
        Path(known.trajectories_path),
        known.scaffold,
        expected_ids,
    )
    test_spec_module.make_eval_script_list = secure_make_eval_script_list

    sys.argv = [
        known.official_script,
        "--trajectories_path",
        known.trajectories_path,
        "--scaffold",
        known.scaffold,
        *remaining,
    ]
    try:
        runpy.run_path(known.official_script, run_name="__main__")
    finally:
        restore(trajectory_backups)
        restore(instance_backups)


if __name__ == "__main__":
    main()
