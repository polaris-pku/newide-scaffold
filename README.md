# newIDE-BCD

`newIDE-BCD` is the backend composition for the newIDE A/B/C/D flow. The
production path now includes a real external Driver, persistent B role/persona/memory,
durable Task/Run state, and Council proposal/review/synthesis/delivery.

```text
TaskCreateRequest
-> RunCreated
-> DriverSessionStarted
-> ContextPackBuilt
-> DriverRunResult
-> ArtifactRegistered
-> TaskCompletedEvent
-> HookMatched
-> GateRequest
-> GateResult
-> CouncilDecision
-> MergeAuthorization
-> CheckpointSaved
-> RunCompleted
```

Legacy mock/demo implementations still exist for deterministic development tests; they are not
the production CLI composition. Query `system.readiness` and `system.capabilities` instead of
inferring production support from source files.

## Repository Shape

This is intentionally a single-package TypeScript project. It does not use `packages/core`, `packages/runtime`, Nx, Turborepo, or a multi-package workspace. The v0 goal is to keep TypeScript project complexity low while the team proves the first end-to-end flow.

The RFC files live beside this repository in `../RFC`. They are design inputs and should not be migrated into this repository.

```text
src/
  core/         shared contracts only
  coordinator/  Direction C coordination layer (task state, checkpoint, stores)
  council/      Direction C council contracts plus MockCouncil
  driver/       Direction A driver contract plus MockDriver
  memory/       Direction B context pack contract plus MockMemoryProvider
  hook/         Direction D.1 hook system
  gate/         Direction D.2 gate evaluation system
  examples/     runnable demos
```

## Install And Run

```bash
pnpm install
pnpm build
pnpm pack --pack-destination .newide/packages
```

The tarball exposes a `newide` binary. It can run the JSON-RPC service or a one-shot Council
evaluation:

```bash
newide serve --stdio --state-root /absolute/state/root

newide council run \
  --workspace /absolute/task/workspace \
  --state-root /absolute/state/root \
  --prompt "Implement the requested change" \
  --allow-degraded
```

`council.execute` is currently reported as `degraded`, so the one-shot command requires explicit
`--allow-degraded`. It still executes real model calls and writes real artifacts; the terminal JSON
preserves the capability status and result quality. stdout contains one
`newide.eval.council.v1` terminal JSON object with `run_id`, `task_id`, `status`, `quality`,
`council_capability`, `result_path`, `summary_path`, `frontend_snapshot_path`, `audit_path`, decision
summary, and errors. Progress and lifecycle diagnostics use stderr. A terminal production run also
publishes `summary.json` under its run directory; Eval consumes its top-level `worktree_path`.

Runtime configuration is loaded from the caller's `.env.local` plus process environment. Required
external dependencies are explicit:

- `NEWIDE_B_DATABASE_URL` for the B PostgreSQL repository;
- a real model provider/API key;
- `ACP_DRIVER_RUNNER_DIR` when the A runner is not in the default sibling checkout;
- a real semantic embedding provider for non-degraded memory evaluation. Setting
  `NEWIDE_B_EMBEDDING_PROVIDER=hash` is an explicit local/degraded mode.

### One-command Council benchmark

For the current delivery baseline, copy `.env.example` to `.env.local` and set only the paths that
differ on the evaluator's machine. The backend automatically loads the real ACP model credentials
from `${ACP_DRIVER_RUNNER_DIR}/.env`; the default runner directory is the sibling
`../acp-client-prototype`. `NEWIDE_B_EMBEDDING_PROVIDER=hash` requires no embedding model or API
key.

```bash
pnpm eval:council:smoke
```

This command always runs the real Council path with the `B2` memory policy on
`psf__requests_v2.27.0_v2.27.1`, collects the produced patch, and invokes the real SWE-EVO harness.
Configure `NEWIDE_B_DATABASE_URL` and `NEWIDE_SWE_EVO_ROOT` in `.env.local`; set
`ACP_DRIVER_RUNNER_DIR` only when the ACP checkout is not the default sibling. Results are written
under `.newide/eval/`; `summary.json` identifies the backend Run, Council usage, timing, tokens,
harness result, and the explicit `degraded_non_semantic` embedding quality.

## F Eval Real Harness Setup

The F-eval TypeScript pipeline is committed in this repository. SWE-EVO lives
under `eval/`; CooperBench (§2 P1-A) lives under `eval/cooperbench/` and
defaults to the sibling `../CooperBench` checkout. Real Docker harnesses for
either bench are not checked in.

Stub smoke tests only need local dataset files; real harness evaluation also
needs a Linux Python environment and Docker access.

### Windows + WSL + Docker Desktop

On Windows, run the SWE-EVO harness from Ubuntu WSL. The harness imports Linux
modules such as `resource`, so Windows Python is not enough even when Docker
Desktop is installed.

1. Enable Ubuntu WSL and make Docker Desktop available inside it:

```powershell
wsl --install -d Ubuntu-22.04
wsl --set-default Ubuntu-22.04
wsl -d Ubuntu-22.04 --user root --exec /bin/sh -lc "apt update && apt install -y python3 python3-pip python3-venv git"
```

In Docker Desktop, open `Settings -> Resources -> WSL Integration`, enable
`Ubuntu-22.04`, then apply and restart Docker Desktop.

Verify WSL can call Docker:

```powershell
wsl -d Ubuntu-22.04 --user root --exec /bin/sh -lc "docker --version && docker info"
```

2. Prepare SWE-EVO as a sibling of this repository. The default expected layout is:

```text
../SWE-EVO/SWE-bench/evaluate_instance.py
../SWE-EVO/hf_out/hf_jsonl/test.jsonl
```

The JSONL can be downloaded from the public Hugging Face mirror:

```powershell
New-Item -ItemType Directory -Force -Path ..\SWE-EVO\hf_out\hf_jsonl | Out-Null
curl.exe -L -o ..\SWE-EVO\hf_out\hf_jsonl\test.jsonl `
  https://hf-mirror.com/datasets/Fsoft-AIC/SWE-EVO/resolve/main/SWE-EVO/hf_jsonl/test.jsonl
```

Clone or download `SWE-EVO/SWE-EVO` so that `../SWE-EVO/SWE-bench` exists.

3. Install the SWE-bench harness in WSL (paths below assume the sibling layout under the same Windows drive):

```powershell
wsl -d Ubuntu-22.04 --user root --exec /bin/sh -lc "python3 -m pip install -U pip setuptools wheel"
wsl --cd ../SWE-EVO/SWE-bench -d Ubuntu-22.04 --user root --exec /bin/sh -lc "python3 -m pip install ."
wsl --cd ../SWE-EVO/SWE-bench -d Ubuntu-22.04 --user root --exec /bin/sh -lc "python3 evaluate_instance.py --help"
```

4. From this repository, generate a harness dry-run first:

```powershell
pnpm eval:instance -- `
  --instance-id conan-io__conan_2.0.14_2.0.15 `
  --mode oracle `
  --skip-scaffold `
  --run-harness `
  --harness-dry-run
```

The command writes `.newide/eval/<run>/harness-command.json`. To run the real
harness, execute the equivalent Linux command in WSL from the generated
`sweevo-work` directory (prefer `wsl --cd <dir>` so paths stay relative to the
Windows cwd). A successful real harness run should pull or reuse a Docker image,
run one instance, and print metrics such as `Applied rate` and `Resolved rate`.

Notes:

- `stub` validates the F-eval pipeline only; it does not run Docker.
- `oracle` replays the dataset gold patch and is useful for harness validation.
- `real` should use a patch from a case worktree or backend `summary.json`; do
  not use this repository's `git diff` as a benchmark patch.
- Local data, WSL setup, Docker images, and `.newide/` run outputs are not
  committed to this repository.

## Module Responsibilities

`src/core` owns shared contracts: IDs, timestamps, task/run state, events, artifacts, checkpoints, decisions, merge authorization, messages, role and memory refs, context pack refs, and file leases. It must not import `coordinator`, `driver`, `memory`, `hook`, `gate`, or `council`.

`src/driver` owns Direction A's runtime boundary. v0 defines `DriverRuntimeHandle`, `DriverCapabilities`, `DriverPrompt`, `DriverRunResult`, `DriverError`, and `MockDriver`. Real ACP, adapter, and PTY integrations should be added behind these contracts later.

`src/memory` owns Direction B's role/persona/memory implementation and public ports. The
application composition consumes those ports and must not replace them with app-owned memory
models.

`src/hook` owns Direction D.1 hook system. Hook decides when to trigger gate evaluation based on events.

`src/gate` owns Direction D.2 gate evaluation system. Gate decides how to evaluate requests. The v0 implementation supports explicit `GateResult.decision` and aggregation priority `deny > ask > defer > allow`.

`src/council` owns Council participant resolution and proposal/review/synthesis contracts. The
current production flow is executable but remains `degraded` until participant identity reuse and
Driver Session continuation are closed.

`src/coordinator` owns Direction C coordination. Production Task/Run state uses the SQLite-backed
coordination store; in-memory stores remain test/demo implementations.

## Development Boundaries

Cross-module imports should go through module entrypoints:

```ts
import { Task, Event } from '../core';
import { MockDriver } from '../driver';
import { MockMemoryProvider } from '../memory';
import { HookEngine } from '../hook';
import { MockAllowGate } from '../gate';
```

Avoid importing another module's internal files directly. For example, prefer `../memory/mvp` for MVP code over deep paths like `../memory/mvp/mock-memory-provider`.

`src/core` is the shared protocol layer. It must not import from other modules.

## Where Each Direction Works Next

Direction A should work in `src/driver`.

Direction B should work in `src/memory`.

Direction C coordination and long-running state should work in `src/coordinator` and shared types in `src/core`.

Direction C Council should work in `src/council`.

Direction D.1 should work in `src/hook`.

Direction D.2 should work in `src/gate`.

Shared object changes belong in `src/core` and should be reviewed by the relevant consuming direction.
