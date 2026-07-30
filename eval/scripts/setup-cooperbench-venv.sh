#!/usr/bin/env bash
# Create CooperBench venv on the Linux filesystem (faster than /mnt/d) and
# install the editable package. Symlinks CooperBench/.venv -> this venv.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCAFFOLD_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COOPER_ROOT="${NEWIDE_COOPERBENCH_ROOT:-$SCAFFOLD_ROOT/../CooperBench}"
VENV="${NEWIDE_COOPERBENCH_VENV:-$HOME/.venvs/cooperbench}"

if test ! -d "$COOPER_ROOT"; then
  echo "CooperBench not found at $COOPER_ROOT" >&2
  exit 1
fi

mkdir -p "$(dirname "$VENV")"
if test ! -x "$VENV/bin/python"; then
  python3 -m venv "$VENV"
fi

"$VENV/bin/python" -m pip install -U pip
"$VENV/bin/python" -m pip install -e "$COOPER_ROOT"
"$VENV/bin/python" -c "import cooperbench; print('cooperbench OK', cooperbench.__file__)"

# Prefer this venv from Windows/WSL harness lookups.
if test -e "$COOPER_ROOT/.venv" || test -L "$COOPER_ROOT/.venv"; then
  if test ! -L "$COOPER_ROOT/.venv"; then
    echo "Replacing existing directory $COOPER_ROOT/.venv with symlink to $VENV"
    rm -rf "$COOPER_ROOT/.venv"
  else
    rm -f "$COOPER_ROOT/.venv"
  fi
fi
ln -sfn "$VENV" "$COOPER_ROOT/.venv"
echo "Linked $COOPER_ROOT/.venv -> $VENV"
echo "CLI: $VENV/bin/python -m cooperbench.cli --help"
