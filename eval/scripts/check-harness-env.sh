#!/usr/bin/env bash
# Check F-eval harness prerequisites from WSL.
# Usage: bash eval/scripts/check-harness-env.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SWE_BENCH_ROOT="${NEWIDE_SWE_EVO_ROOT:-$ROOT/../SWE-EVO}/SWE-bench"
COOPER_ROOT="${NEWIDE_COOPERBENCH_ROOT:-$ROOT/../CooperBench}"
SWE_VENV="$SWE_BENCH_ROOT/.venv-swebench"
COOPER_VENV="${NEWIDE_COOPERBENCH_VENV:-}"
if test -z "$COOPER_VENV"; then
  if test -x "$HOME/.venvs/cooperbench/bin/python"; then
    COOPER_VENV="$HOME/.venvs/cooperbench"
  else
    COOPER_VENV="$COOPER_ROOT/.venv"
  fi
fi

ok=0
fail=0

check() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "OK   $label"
    ok=$((ok + 1))
  else
    echo "FAIL $label"
    fail=$((fail + 1))
  fi
}

echo "== NewIDE F-eval harness env =="
echo "ROOT=$ROOT"

check "docker CLI" command -v docker
check "docker daemon" docker info
check "SWE-bench tree" test -d "$SWE_BENCH_ROOT"
check "evaluate_instance.py" test -f "$SWE_BENCH_ROOT/evaluate_instance.py"
check "SWE-bench venv" test -x "$SWE_VENV/bin/python"
if test -x "$SWE_VENV/bin/python"; then
  check "import swebench" "$SWE_VENV/bin/python" -c "import swebench"
fi
check "CooperBench tree" test -d "$COOPER_ROOT"
check "CooperBench dataset" test -d "$COOPER_ROOT/dataset"
if test -x "$COOPER_VENV/bin/python"; then
  check "import cooperbench" "$COOPER_VENV/bin/python" -c "import cooperbench"
else
  echo "FAIL cooperbench venv missing — run: bash eval/scripts/setup-cooperbench-venv.sh"
  fail=$((fail + 1))
fi
check "SWE-EVO test.jsonl" test -f "${NEWIDE_SWE_EVO_ROOT:-$ROOT/../SWE-EVO}/hf_out/hf_jsonl/test.jsonl"

echo "-- summary: ok=$ok fail=$fail --"
if test "$fail" -gt 0; then
  exit 1
fi
