# newIDE-BCD

`newIDE-BCD` is the v0 TypeScript scaffold for running a minimal A/B/C/D end-to-end flow:

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

The first version uses mock implementations, but the objects, interfaces, event names, and module boundaries are real v0 contracts.

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
pnpm typecheck
pnpm lint
pnpm format
pnpm example:basic
```

`pnpm example:basic` prints the v0 flow timeline and IDs.

## F Eval Real Harness Setup

The F-eval TypeScript pipeline is committed in this repository, but the real
SWE-EVO/SWE-bench Docker harness depends on local data and tools that are not
checked in. Stub smoke tests only need the JSONL data; real harness evaluation
also needs a Linux Python environment and Docker access.

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

2. Prepare SWE-EVO outside this repository. The default expected layout is:

```text
D:\SWE-EVO\SWE-bench\evaluate_instance.py
D:\SWE-EVO\hf_out\hf_jsonl\test.jsonl
```

The JSONL can be downloaded from the public Hugging Face mirror:

```powershell
New-Item -ItemType Directory -Force -Path D:\SWE-EVO\hf_out\hf_jsonl | Out-Null
curl.exe -L -o D:\SWE-EVO\hf_out\hf_jsonl\test.jsonl `
  https://hf-mirror.com/datasets/Fsoft-AIC/SWE-EVO/resolve/main/SWE-EVO/hf_jsonl/test.jsonl
```

Clone or download `SWE-EVO/SWE-EVO` so that `D:\SWE-EVO\SWE-bench` exists.

3. Install the SWE-bench harness in WSL:

```powershell
wsl -d Ubuntu-22.04 --user root --exec /bin/sh -lc "python3 -m pip install -U pip setuptools wheel"
wsl -d Ubuntu-22.04 --user root --exec /bin/sh -lc "cd /mnt/d/SWE-EVO/SWE-bench && python3 -m pip install ."
wsl -d Ubuntu-22.04 --user root --exec /bin/sh -lc "cd /mnt/d/SWE-EVO/SWE-bench && python3 evaluate_instance.py --help"
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
`sweevo-work` directory, using `/mnt/d/...` paths and `--max_workers 1` for the
first case. A successful real harness run should pull or reuse a Docker image,
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

`src/memory` owns Direction B's runtime-facing context contract. v0 builds auditable `ContextPack` objects for driver, gate, and council use. It does not implement long-term memory, skill promotion, persona induction, agent splitting, or skill markets.

`src/hook` owns Direction D.1 hook system. Hook decides when to trigger gate evaluation based on events.

`src/gate` owns Direction D.2 gate evaluation system. Gate decides how to evaluate requests. The v0 implementation supports explicit `GateResult.decision` and aggregation priority `deny > ask > defer > allow`.

`src/council` owns the Council contract from Direction C. v0 accepts proposals and evidence, then returns a structured decision. It does not merge code, bypass gates, write long-term memory, or perform multi-agent debate.

`src/coordinator` owns Direction C coordination layer. It manages task state machine, checkpoints, event store, artifact store, and orchestration. Current stores are in-memory and intentionally small.

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
