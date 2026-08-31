#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CALLER_DIR="$(pwd -P)"

WORKSPACE_INPUT=''
PROMPT=''
PROMPT_FILE_INPUT=''
STATE_ROOT_INPUT=''
DRIVER_RUNNER_INPUT="${ACP_DRIVER_RUNNER_DIR:-$REPO_ROOT/../acp-client-prototype}"
# A four-role plan-first Council has five real ACP turns (two Plans, review,
# synthesis, and implementation). Fifteen minutes can terminate a healthy M3
# run during the final implementation turn.
RUN_TIMEOUT_MS='1800000'
# Backward-compatible option name for the maximum silent interval of an ACP turn.
DRIVER_TIMEOUT_MS="${ACP_DRIVER_INACTIVITY_TIMEOUT_MS:-${ACP_DRIVER_TIMEOUT_MS:-300000}}"
USE_LOCAL_POSTGRES=0
SKIP_BUILD=0

usage() {
  cat <<'EOF'
Run one real newIDE Council task from the command line.

Usage:
  pnpm task:run -- --workspace PATH --prompt TEXT [options]
  pnpm task:run -- --workspace PATH --prompt-file FILE [options]

Required:
  --workspace PATH          Existing task workspace, or a directory to create
  --prompt TEXT             Task prompt
  --prompt-file FILE        Read the task prompt from a file

Options:
  --state-root PATH         Runtime state and evidence directory
  --driver-runner PATH      ACP client checkout (default: sibling directory)
  --timeout-ms NUMBER       Whole-task timeout (default: 1800000)
  --driver-timeout-ms NUM   Maximum silent interval for an ACP turn (default: 300000)
  --local-postgres          Start/reuse the repository's local PostgreSQL container
  --skip-build              Use existing backend and ACP client build output
  -h, --help                Show this help

Configuration:
  Backend model and B storage:  .env.local in this repository
  ACP coding-agent credentials: .env in the ACP client repository

The command writes lifecycle diagnostics to stderr and one terminal JSON object
to stdout. Run artifacts are stored under --state-root.
EOF
}

fail() {
  printf '[newide] %s\n' "$*" >&2
  exit 2
}

require_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    fail "$option requires a value"
  fi
}

absolute_path() {
  local input="$1"
  if [[ "$input" = /* ]]; then
    printf '%s\n' "$input"
  else
    printf '%s/%s\n' "$CALLER_DIR" "$input"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --workspace)
      require_value "$1" "${2:-}"
      WORKSPACE_INPUT="$2"
      shift 2
      ;;
    --prompt)
      require_value "$1" "${2:-}"
      PROMPT="$2"
      shift 2
      ;;
    --prompt-file)
      require_value "$1" "${2:-}"
      PROMPT_FILE_INPUT="$2"
      shift 2
      ;;
    --state-root)
      require_value "$1" "${2:-}"
      STATE_ROOT_INPUT="$2"
      shift 2
      ;;
    --driver-runner)
      require_value "$1" "${2:-}"
      DRIVER_RUNNER_INPUT="$2"
      shift 2
      ;;
    --timeout-ms)
      require_value "$1" "${2:-}"
      RUN_TIMEOUT_MS="$2"
      shift 2
      ;;
    --driver-timeout-ms)
      require_value "$1" "${2:-}"
      DRIVER_TIMEOUT_MS="$2"
      shift 2
      ;;
    --local-postgres)
      USE_LOCAL_POSTGRES=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1 (run with --help for usage)"
      ;;
  esac
done

[[ -n "$WORKSPACE_INPUT" ]] || fail '--workspace is required'
if [[ -n "$PROMPT" && -n "$PROMPT_FILE_INPUT" ]]; then
  fail 'use either --prompt or --prompt-file, not both'
fi
if [[ -z "${PROMPT//[[:space:]]/}" && -z "$PROMPT_FILE_INPUT" ]]; then
  fail '--prompt or --prompt-file is required'
fi
[[ "$RUN_TIMEOUT_MS" =~ ^[1-9][0-9]*$ ]] || fail '--timeout-ms must be a positive integer'
[[ "$DRIVER_TIMEOUT_MS" =~ ^[1-9][0-9]*$ ]] || fail '--driver-timeout-ms must be a positive integer'

command -v node >/dev/null 2>&1 || fail 'Node.js was not found (version >=22.22.1 is required)'
command -v pnpm >/dev/null 2>&1 || fail 'pnpm was not found (enable Corepack or install pnpm)'

WORKSPACE="$(absolute_path "$WORKSPACE_INPUT")"
mkdir -p "$WORKSPACE"
WORKSPACE="$(cd "$WORKSPACE" && pwd -P)"

DRIVER_RUNNER="$(absolute_path "$DRIVER_RUNNER_INPUT")"
[[ -d "$DRIVER_RUNNER" ]] || fail "ACP client repository not found: $DRIVER_RUNNER"
DRIVER_RUNNER="$(cd "$DRIVER_RUNNER" && pwd -P)"
[[ -f "$DRIVER_RUNNER/package.json" ]] || fail "ACP client package.json not found: $DRIVER_RUNNER"

if [[ -n "$PROMPT_FILE_INPUT" ]]; then
  PROMPT_FILE="$(absolute_path "$PROMPT_FILE_INPUT")"
  [[ -f "$PROMPT_FILE" ]] || fail "prompt file not found: $PROMPT_FILE"
fi

if [[ -z "$STATE_ROOT_INPUT" ]]; then
  STATE_ROOT_INPUT="$REPO_ROOT/.newide/task-runs/$(date +%Y%m%d-%H%M%S)"
fi
STATE_ROOT="$(absolute_path "$STATE_ROOT_INPUT")"
mkdir -p "$STATE_ROOT"
STATE_ROOT="$(cd "$STATE_ROOT" && pwd -P)"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  [[ -d "$REPO_ROOT/node_modules" ]] || fail "backend dependencies are missing; run: pnpm --dir $REPO_ROOT install"
  [[ -d "$DRIVER_RUNNER/node_modules" ]] || fail "ACP client dependencies are missing; run: pnpm --dir $DRIVER_RUNNER install"
  printf '[newide] Building ACP client...\n' >&2
  (cd "$DRIVER_RUNNER" && corepack pnpm build) >&2
  printf '[newide] Building backend CLI...\n' >&2
  (cd "$REPO_ROOT" && corepack pnpm build) >&2
else
  [[ -f "$DRIVER_RUNNER/dist/src/driver/contract-runner.js" ]] || fail 'ACP client build output is missing; remove --skip-build'
  [[ -f "$REPO_ROOT/dist/newide.mjs" ]] || fail 'backend CLI build output is missing; remove --skip-build'
fi

export ACP_DRIVER_RUNNER_DIR="$DRIVER_RUNNER"
export ACP_DRIVER_INACTIVITY_TIMEOUT_MS="$DRIVER_TIMEOUT_MS"
# CLI overlays process.env on .env.local. Read the file first so a LiteLLM
# embedding config is not forced back to the local hash provider.
if [[ -z "${NEWIDE_B_EMBEDDING_PROVIDER:-}" && -f "$REPO_ROOT/.env.local" ]]; then
  NEWIDE_B_EMBEDDING_PROVIDER="$(
    grep -E '^NEWIDE_B_EMBEDDING_PROVIDER=' "$REPO_ROOT/.env.local" \
      | tail -n1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
  )"
fi
export NEWIDE_B_EMBEDDING_PROVIDER="${NEWIDE_B_EMBEDDING_PROVIDER:-hash}"
if [[ "$NEWIDE_B_EMBEDDING_PROVIDER" == 'hash' ]]; then
  export NEWIDE_B_EMBEDDING_DIMENSIONS="${NEWIDE_B_EMBEDDING_DIMENSIONS:-32}"
fi

if [[ "$USE_LOCAL_POSTGRES" -eq 1 ]]; then
  NEWIDE_B_DATABASE_URL="$("$REPO_ROOT/scripts/ensure-b-memory-postgres.sh")"
  export NEWIDE_B_DATABASE_URL
fi

printf '[newide] Workspace: %s\n' "$WORKSPACE" >&2
printf '[newide] State root: %s\n' "$STATE_ROOT" >&2
printf '[newide] ACP client: %s\n' "$DRIVER_RUNNER" >&2

CLI_ARGS=(
  council run
  --workspace "$WORKSPACE"
  --state-root "$STATE_ROOT"
  --timeout-ms "$RUN_TIMEOUT_MS"
  --allow-degraded
)
if [[ -n "$PROMPT_FILE_INPUT" ]]; then
  CLI_ARGS+=(--prompt-file "$PROMPT_FILE")
else
  CLI_ARGS+=(--prompt "$PROMPT")
fi

cd "$REPO_ROOT"
exec node "$REPO_ROOT/dist/newide.mjs" "${CLI_ARGS[@]}"
