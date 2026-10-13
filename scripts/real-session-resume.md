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
- Interrupted turns carry an explicit native-continuation flag. They reuse the
  session's own history and receive the current instruction, not another copy of
  the initial memory package. Initial task turns still receive that package.
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

## Final real acceptance on 2026-10-13

Both modes passed on source commit `458adcf8dd1935164e9b2a2e2d2f6522564a6cdd`,
including main `649521035bc0b4f4074bd9d630250b344d3b3247`. These runs used the
production backend, Claude Code + MiniMax-M3, persistent native sessions, real Git
workspaces, SQLite coordination and the supported hash embedding configuration.

| Check | single_agent | council |
| --- | --- | --- |
| Task | `task_c858f3f9-4e2e-46f9-90fb-6a7aa123ca15` | `task_10c18556-a416-483e-bf3b-3d2b5c71ed6f` |
| Backend PID before / after SIGINT | 93027 / 93557 | 93143 / 97794 |
| Preserved cursor | `execute_agent` | `council` / reviewer |
| Interrupted native session, same before / after | `554ff746-b242-441e-91fd-43ec80e4ded6` | `2fb030d6-f4b4-4924-ba16-cbe13fa30bb8` |
| Final Task state | completed | completed |
| Delivered game tests | 18 passed, 0 failed | 24 passed, 0 failed |
| Actual Chrome interactions | pause, keyboard, game over, restart | start, keyboard, game over, restart |

Native Claude JSONL parent links cross both restarts. In Council, primary and
completed proposer Driver calls did not repeat: reviewer resumed its existing
session, followed by the synthesizer's first invocation. The final Council result
has zero role failures, no fallback, no warnings and no unmet criteria.

Neither product files nor Task/checkpoint/session records were manually repaired.
The original Run remains interrupted for audit; the new Run continues the same
Task and native Driver conversation. See
[machine-readable evidence](acceptance-evidence/native-session-resume-2026-10-13.json)
for exact Run IDs, native message links, Driver calls, product and audit hashes.
Raw evidence directories `newide-session-reload-SMG8Cw` and
`newide-session-reload-Tlz1VJ` are preserved in the printed temporary root.

The subsequent event-coverage test correction changes tests only; the tested
application source above is unchanged. CI verification is tracked separately in PR #200.

## Earlier diagnostic runs

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
an artifact/tool-free no-response marker as `DRIVER_NO_PROGRESS`. The final runs
above include this fix. This earlier successful run alone was insufficient acceptance.

Council task `task_70747161-913c-4b65-ba32-d795cef346df` was interrupted during a
reviewer tool call. Its first resume was rejected by the old source-workspace-only
session lookup. After fixing that lookup and in-flight session indexing, the **same
unchanged persisted Task** resumed through the production `task.resume` RPC:

- Original Run: `run_63000ffe-0c84-4bc3-9d4d-6f53fc3f6df4`.
- Resumed Run: `run_a031f672-5780-4094-bf8b-eedc0bcd0002`, completed.
- Reviewer session on both sides: `42bf1c51-cc03-4784-b076-e4c9af4e65dd`.
- Native resumed message `309c7ce9-2577-4a06-bad9-cfcab63f0393` has pre-restart
  parent `16840101-67a4-4610-8230-687f126136c4`.
- Resumed Driver calls: reviewer, then synthesizer (its first invocation). Neither
  primary nor completed proposer ran again.
- Council reports zero role failures, no fallback, no warnings and no unmet criteria.
- Delivered game tests: 19 passed. Real Chrome: start, pause, keyboard input, game
  over and restart worked; no page script errors. No game files were manually fixed.

This was recovery-after-upgrade evidence. The final acceptance above subsequently
validated a fresh final-version Council Task.

The committed strict harness subsequently passed single-agent task
`task_6dc0bc6a-70b8-4998-86e6-6a290478a3b5` with no manual task/workspace edits:

- Backend PIDs: 45525 before SIGINT, 46040 after restart.
- Runs: `run_7b2aa72b-8187-4bdd-ad09-94723c484898` interrupted,
  `run_5e329bc5-2c97-4fbe-b847-51a425fc0063` completed.
- Native session: `d3e2beff-3d1c-468c-bace-8d55757f0b29` throughout.
- Native parent link: `181adcd4-6df0-4d62-ab47-3ea58c1d255e` →
  `cc53523f-9058-4ecd-95e9-62cc230d362b`; 5 pre-restart records, 86 after.
- Delivered Snake tests: 14 passed. The Driver encountered failing tests during
  execution and corrected its own code/tests before completion; the acceptance
  harness did not repair or substitute the product.
- Real Chrome: a direction key changed the snake's vertical movement, wall collision
  ended the game, and R restarted it; no page script errors.
- Evidence: `newide-session-reload-JKLb7r/acceptance.json` in the printed temporary root.

A fresh Council run (`task_6908071b-2209-47fb-9186-7f119b4dd46b`) subsequently
failed after correctly reloading reviewer session `d8f32bb9-8298-4995-95e7-1dd0a65df452`:
the reviewer reported a nonexistent reviews.json, then returned a no-response marker.
It was not counted as acceptance. The next revision separates native continuation
from initial context delivery to avoid replaying the full memory package. The final
single and Council runs above validated that behavior on the latest main.

Native session reload does not restore an operating-system process or an in-flight
tool's instruction pointer. Tools with external side effects need their own outcome
reconciliation; this Snake/SIGINT acceptance does not certify arbitrary external
tools, power loss, every Driver, or exact stochastic-output equivalence.
