#!/usr/bin/env python3
"""Hidden test_patch must still drive pytest file selection."""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

SCAFFOLD = Path(__file__).resolve().parents[2]
swe_bench_root = Path(os.environ.get('NEWIDE_SWE_EVO_ROOT', '')).expanduser() / 'SWE-bench'
if swe_bench_root.is_dir():
    sys.path.insert(0, str(swe_bench_root))

WRAPPER_PATH = SCAFFOLD / "eval" / "harness" / "secure-sweevo-evaluate.py"
spec = importlib.util.spec_from_file_location("secure_sweevo_evaluate", WRAPPER_PATH)
assert spec and spec.loader
wrapper = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = wrapper
spec.loader.exec_module(wrapper)


HIDDEN = """diff --git a/dask/tests/test_base.py b/dask/tests/test_base.py
--- a/dask/tests/test_base.py
+++ b/dask/tests/test_base.py
@@ -1,0 +1,1 @@
+def test_hidden():
+    assert True
diff --git a/.github/workflows/tests.yml b/.github/workflows/tests.yml
--- a/.github/workflows/tests.yml
+++ b/.github/workflows/tests.yml
@@ -1,0 +1,1 @@
+# ci
"""


def test_hidden_copy_does_not_mutate_source() -> None:
    instance = {"instance_id": "x", "test_patch": "", "repo": "dask/dask"}
    copied = wrapper.instance_for_hidden_eval(instance, HIDDEN)
    assert instance["test_patch"] == ""
    assert copied["test_patch"] == HIDDEN
    assert copied is not instance


def test_pytest_command_includes_hidden_test_files() -> None:
    instance_id = "dask__dask_2022.9.2_2022.10.0"
    wrapper.HIDDEN_TEST_PATCHES[instance_id] = HIDDEN
    instance = {
        "instance_id": instance_id,
        "repo": "dask/dask",
        "version": "2022.9",
        "start_version": "2022.9.2",
        "end_version": "2022.10.0",
        "test_patch": "",
        "FAIL_TO_PASS": [],
        "PASS_TO_PASS": [],
        "base_commit": "abc123",
    }
    commands = wrapper.secure_make_eval_script_list(
        instance,
        {},
        "testbed",
        "/testbed",
        "abc123",
        "",
    )
    pytest_cmds = [cmd for cmd in commands if "pytest" in cmd]
    assert pytest_cmds, commands
    pytest_cmd = pytest_cmds[-1]
    assert "dask/tests/test_base.py" in pytest_cmd
    assert instance["test_patch"] == ""


def test_timeout_cli_overrides_env() -> None:
    previous = os.environ.get("NEWIDE_SWE_EVO_HARNESS_TIMEOUT")
    os.environ["NEWIDE_SWE_EVO_HARNESS_TIMEOUT"] = "1800"
    try:
        assert wrapper.resolve_timeout_seconds(10800) == 10800
        assert wrapper.resolve_timeout_seconds(None) == 1800
        del os.environ["NEWIDE_SWE_EVO_HARNESS_TIMEOUT"]
        assert wrapper.resolve_timeout_seconds(None) is None
    finally:
        if previous is None:
            os.environ.pop("NEWIDE_SWE_EVO_HARNESS_TIMEOUT", None)
        else:
            os.environ["NEWIDE_SWE_EVO_HARNESS_TIMEOUT"] = previous


if __name__ == "__main__":
    test_hidden_copy_does_not_mutate_source()
    test_pytest_command_includes_hidden_test_files()
    test_timeout_cli_overrides_env()
    print("ok")
