# Native Driver session recovery acceptance

Acceptance means a real production backend, a real configured Claude Code Driver,
interruption during a tool call, a new backend process, and native session reload.
Creating a new Driver session and replaying a prompt is **not** acceptance.
Unit tests and `RESUME_PROOF` smoke tasks are not release criteria.

## Implementation

- `task.interrupt` aborts the active execution, preserves its cursor and captures a
  checkpoint. SIGINT/SIGTERM use this path on graceful backend shutdown.
- Task identity stays stable. The interrupted execution attempt is retained as an
  interrupted Run; `task.resume` creates an audit attempt using the prior Driver
  session. Run identity and Driver session identity are different concepts.
- A blocked Task has no active execution and can be resumed explicitly.
- Driver routing is inherited. Unsupported session loading is rejected; a successful
  Driver response with a replacement session ID is rejected too.
- Council retains selected participants, initial proposal identities, role working
  directories, in-flight session IDs, workspace baselines and completed role results
  in an atomic `recovery.json` outside the role workspaces. Completed roles are reused;
  an interrupted role is invoked with its saved native session ID.
- Repeated resumes follow the persisted recovery lineage for workspaces and stage
  evidence. A new execution lineage must not consume a previous Council cache.

This does not claim bit-for-bit identical stochastic model output. The requirement
is native conversation continuity, retained work, and no silent new-session fallback.
Graceful interruption and abrupt process crashes are different acceptance cases.

## Reproduce

From the repository root, configure the existing ACP runner's `.env` for Claude
Code + MiniMax, including a persistent `CLAUDE_CONFIG_DIR`. Do not put keys in the
commands or tracked files. The runner must be built before starting the backend.

```sh
export ACP_DRIVER_ENV_FILE=../acp-client-prototype/.env
export ACP_AGENT_ID=claude
export NEWIDE_AGENT_LLM_MODEL=MiniMax-M3
export OPENAI_BASE_URL=https://api.minimax.io/v1
export ANTHROPIC_BASE_URL=''
export NEWIDE_B_EMBEDDING_PROVIDER=hash
export NEWIDE_AUCTION_ENABLED=0
export NEWIDE_PRIMARY_AGENT_ID=role_ts_engineer
export ACP_DRIVER_TIMEOUT_MS=300000
export NEWIDE_EPHEMERAL_ACP_SESSIONS=0

NEWIDE_ACCEPTANCE_MODE=single_agent node scripts/real-session-resume.mjs

NEWIDE_ACCEPTANCE_MODE=council \
NEWIDE_COUNCIL_SEATS=role_ts_engineer,role_fullstack_engineer,role_code_reviewer,role_synthesis_engineer \
NEWIDE_INTERRUPT_ROLE=role_code_reviewer \
node scripts/real-session-resume.mjs
```

The script creates an isolated Git workspace and state directory, runs a Snake
implementation task, sends SIGINT during a Driver tool call, waits for process exit,
starts a fresh production backend and calls `task.resume`. It preserves all evidence
and prints `EVIDENCE_ROOT`; nothing is deleted on success or failure.

It checks Task completion, the interrupted role's session ID, native Claude JSONL
parent links crossing the process restart, actual game files, and the generated
game tests. Council must have zero role failures and no fallback. A timeout is a
failure, not a reason to weaken assertions. Browser playability is checked separately.

## Observed on 2026-10-13

Real single-agent Snake task `task_2dda0090-fb94-4dc3-ae34-e5eac0161936`:

- Interrupted Run: `run_e6fed591-be83-424d-aec7-5b2d30d1a109`.
- Resumed Run: `run_a3dc0976-7352-4cf8-92d3-607c4e27b9fb`, completed.
- Native session before/after: `d2a9187a-d361-42df-9644-edf198844a73`.
- Native JSONL: 7 timestamped records before restart and 52 after. Resumed message
  `f7009ce5-f10a-4994-898b-bea34d15130e` links to pre-restart message
  `6d94399d-b90e-4492-b896-d34035a73b7a` through `parentUuid`.
- `node --test snake.test.mjs`: 16 passed.
- Real headless Chrome: pause, keyboard input, game over and restart checked; no
  page script errors. This used the delivered files, without editing the game.

This run used the earlier manual production-process harness. A subsequent committed
harness run (`task_3ccca2bb-7104-40da-87a6-6273bcaee241`) **failed**: native session
reload succeeded, but the model returned `No response requested.` and no files;
the backend incorrectly reported completion. The strict harness caught the missing
game. The follow-up fix makes the active instruction explicit after load and rejects
an artifact/tool-free no-response marker as `DRIVER_NO_PROGRESS`. Reverification is
in progress. Council reviewer interruption is also being exercised separately.
Do not infer release readiness or Council acceptance from the successful first run.
