---
name: audit-context-building
description: Understands a codebase before hunting for bugs, capturing what each function assumes, guarantees, and depends on elsewhere. Use when starting an audit, threat model, or architecture review on unfamiliar code, and before a vulnerability-hunting pass.
---

# audit-context-building

> 边界标注（2026-09-07）：审计/威胁建模/找 bug 前理解代码库的前置工具；correctness 的 bugsweep 猎杀与 security 审计均可复用本技能做 preflight。
> Boundary (2026-09-07): pre-work for audits, threat models and bug hunts — reusable as preflight by correctness bugsweep and by security audits.

> 蒸馏自 trailofbits/skills（仓库内路径 plugins/audit-context-building/skills/audit-context-building）。原为 6 文件（SKILL.md + 3 篇 resources + agents/openai.yaml + 品牌 svg）；resources 已全文内联，openai.yaml/svg 仅为界面配置已省略。
> Distilled from trailofbits/skills (`plugins/audit-context-building/skills/audit-context-building`); originally 6 files with three resource documents now inlined.

Build understanding, not verdicts. This runs **before** anyone hunts for bugs, and feeds that work.

## When to Use

- At the start of an audit, a threat model, or an architecture review, when the code is unfamiliar.
- When an earlier pass produced findings nobody could judge, because no one had mapped out how the system fits together.
- It is not worth the tokens on code you already understand.

## When NOT to Use

- Do **not** name vulnerabilities, suggest fixes, write proofs-of-concept, or rate severity. Those belong to the hunting phase, which runs next and with the whole picture in hand.
- When the code counts on something and nothing checks it, record that plainly and move on — whether it matters is decided later.
- Skip this context for code you already understand.

## How the analysis runs (context routing)

The analysis is long, and the working context needs to survive to use it — dispatch the work so only compact records return:

- **A codebase, or more than one function:** orient first, then analyze each function in its own subagent/context. Persist a full dossier plus one record per function (to a working file when a filesystem is available), and return only compact records to the main context.
- **A single function:** dispatch one focused analysis at it; write its prose out and return a record.

Then work from what comes back: the index, the unenforced assumptions, the open questions. Read a function's file when you need its detail.

Tooling note: this workflow uses subagent dispatch plus read-only code tools (`Workflow`/`Task`, `Read`, `Grep`, `Glob` — original frontmatter `allowed-tools: Workflow Task Read Grep Glob`). A subagent bound to a return schema cannot return prose, so the workflow enforces the routing: treat this section as routing, and route.

## What comes back, and how to read it

Each record lists what must always be true (with the line that shows it), what the function takes on faith (with whatever establishes it), which functions it calls and what it needs from each, and anything still unclear. The dossier adds the rules that span several functions, who can reach what, and where the complicated parts cluster.

Two things matter more than the rest:

- **Assumptions marked `nothing found`.** The code counts on something being true and nothing anywhere makes it true. This is the most useful thing to hand the hunting phase.
- **The open questions.** An honest list of what is still unclear beats a confident answer that turns out to be wrong. Carry them forward instead of closing them out.

Where two records disagree, both are quoted rather than quietly reconciled. That is a fact about the code, not a flaw in the analysis.

**The rule that matters most: follow the calls.** Whether a function is correct usually depends on something another function does, and you cannot see that from the caller alone. A limit looks enforced because the value came back from a function whose name suggests it was checked. So read the function being called, follow every path through it rather than only the one that succeeds, and say what makes each assumption true. When nothing does, use those words: `nothing found`. Every claim cites a line, or becomes an open question.

## Per-Function Analysis Format (output schema)

One document per function, sections in this order, separated by `---`:

```markdown
## `functionName` in path/to/file.ext (L40-L88)

**Purpose:** Its role in the system and what breaks without it.

**Inputs & Assumptions:**
- `param` (type): what it is. Trust: untrusted | semi-trusted | trusted.
- Implicit: state read, caller identity, environment, clock.
- Preconditions: what must hold on entry, and what establishes each.

**Outputs & Effects:**
- Returns, state writes, events or messages, external interactions, postconditions.

**Block-by-Block:**

​```language
// L52-L54
<the code>
​```
- **What:** one sentence.
- **Why here:** what its position in the order buys.
- **Assumes:** what must hold for it to be correct.
- **Establishes:** the invariant it creates, if any.
- **Depended on by:** the later logic that rests on it.

**Cross-Function Dependencies:**
- Callee `name` (internal | external-source-available | external-black-box): what this function depends on it
  to establish, and on which paths.
- Callers: who reaches this, and what they assume it enforces.
- Shared state: which other functions touch it.
- Invariant couplings: how this function's invariants interact with the system's.

**Open Questions:**
- unclear; need to inspect X
```

### Conventions

- Cite lines as `L45` or `L98-L102`. Label code blocks with the language.
- For every assumption, say what makes it true — and write `nothing found` when nothing does.
- Spend words where the code earns them. Branches, calls out, and anything that changes stored data deserve real attention; three lines that copy a value deserve three lines back. There is no minimum number of anything. Padding a section to hit a count produces text that looks like analysis and isn't.
- Leave a section out only when it is genuinely empty, and say so: "No external calls." A missing section could mean "none" or "never checked", and the reader cannot tell which.

### Before you finish

- Check that every claim either cites a line or sits in Open Questions.
- Check that you followed every path through each function called, not just the one that succeeds.
- If something you wrote earlier turns out to be wrong, fix it where it stands and say what changed.
- Cut the hedges: "Probably", "seems to", and "should be" each become either a claim with a line number or an open question.
- Finishing with open questions is a complete analysis. Finishing with open questions you never wrote down is not.

## What counts as a call you cannot see inside — by domain

The format never changes. Whatever the target, always ask the same four questions up front — what are the pieces, how does the outside world get in, who is on the other side, and what data survives between calls — and then, per function, what must be true, what it takes on faith, and what it calls.

What changes is the answers, and what counts as a call you cannot see inside:

| Domain | ways in | who's on the other side | data that sticks around | calls you can't see inside |
| --- | --- | --- | --- | --- |
| Smart contracts | `external` / `public` function | caller, owner, relayer, oracle, other protocols | storage slots | an address whose code isn't in the project |
| C / C++ source | exported function, parser, syscall or IPC handler | remote peer, local user, other threads | globals, statics, long-lived heap | a linked library shipped without source |
| Decompiled / firmware | task entry, interrupt handler, protocol handler | radio peer, LAN host, serial console | fixed addresses, NVRAM, DMA regions | a symbol the decompiler never resolved |
| Web services (Go, Rust, Python) | route handler, RPC method, queue consumer | logged-in user, anonymous caller, internal service | database rows, cache entries, sessions | a third-party API |

### Smart contracts

The original target of this plugin, and the one where "external call" carries the most weight. A call to an address whose code is not in scope is the black-box case: record the value and calldata sent, and the outcomes not excluded — revert, a hostile return value, and re-entry into the caller before its own state writes land. Whether the write lands before or after the call is usually the whole question in "why here".

Implicit inputs are larger than they look: the caller identity, the block timestamp, the gas left, and anything read from another contract. Under effects, storage writes and emitted events are separate lines, because indexers depend on the events and solvency depends on the writes.

Watch for `unchecked` blocks and assembly. Both suspend guarantees the surrounding code is written as though it still has, which is exactly the shape the continuity rule exists to catch — a caller relies on a checked subtraction that a callee performs unchecked.

### C and C++ source

Bounds, lifetimes, and integer width carry most of the invariants. An out-parameter is the classic continuity trap: the caller checks the return code and uses the out-parameter, and one path through the callee returns success without writing it, or writes it without bounding it.

Record who owns each pointer and until when. `free` on one path and not another, a borrow that outlives the lock that protected it, and a length in `int` compared against a `size_t` are all structural facts, not findings. Note which calls are behind `#ifdef` — a path that only exists in one build configuration is still a path, and orientation should say which configuration was read.

### Decompiled binaries and firmware

Three things differ, and they all land in orientation.

1. **Function boundaries are themselves a finding.** Before anything can be ranked, the functions have to be recovered, and the recovery is fallible. Say which entry points were identified, how, and what was left unattributed. `FUN_80104a2c` is a name that tells you nothing — the rule against inferring behavior from a name is not a caution here, it is the default condition.
2. **Go top-down from task entry points.** Starting at RTOS task entries, interrupt handlers, and protocol handlers and working downward beats exploring outward from whatever looked interesting. The entrypoint list is the work queue.
3. **Most callees are black boxes, and that is the normal case rather than an exception.** A call to an address with no recovered body — a ROM thunk, a syscall, a library the decompiler did not resolve — gets the same treatment as an unknown external contract: what is passed, what is assumed, what is not excluded. A bound that is never established in the visible listing is an assumption with `establishedBy: "nothing found"`, and that is a complete and useful answer, not a failure to finish.

Keep a coverage record alongside the dossier: which tasks and handlers have been analyzed and which have not. Without it there is no way to tell a clean subsystem from an unread one.

### Services (Go, Rust, Python, web)

Logic and authorization carry more weight than memory safety. The trust boundary is usually a middleware chain, so the continuity rule points at the framework: a handler is safe because something upstream authenticated the request, and that something is a decorator, a route registration, or a config file rather than a call in the handler's body. Record where the check actually lives, and whether every route registered on that path gets it.

Concurrency is persistent state. Two handlers that read-modify-write the same row without a transaction are coupled even though neither calls the other; that belongs in shared state and invariant couplings.

## Worked Example

A complete per-function analysis. The subject is C; the format is language-neutral, and the notes at the end cover what changes for contract code. The point of this example is the callee: `session_acquire` looks safe read on its own, and the analysis only becomes accurate once `session_lookup` has been read.

### Example record (C)

#### `session_acquire` in src/session.c (L112-L138)

```c
// L112
int session_acquire(uint32_t id, struct session **out) {
    struct session *s = session_lookup(id);      // L113
    if (!s)                                       // L114
        return -ENOENT;
    s->refcount++;                                // L116
    *out = s;                                     // L117
    return 0;
}
```

**Purpose:** Hands a caller a borrowed reference to a live session and records that the borrow happened, so the session is not freed underneath it. Every caller that later calls `session_release` is paired with this function; the refcount discipline of the whole session table rests on that pairing.

**Inputs & Assumptions:**
- `id` (uint32_t): session identifier. Trust: **untrusted** — reaches this from the request parser at `src/proto.c:L88` without validation.
- `out` (struct session **): caller-provided storage for the result. Trust: trusted (internal callers only, per the caller list below).
- Implicit: the global session table `g_sessions` (`src/session.c:L31`) and the lock protecting it.
- Precondition: `out` is non-NULL. Nothing in this function establishes it and nothing checks it; both callers pass the address of a local (`src/proto.c:L94`, `src/admin.c:L51`).
- Precondition: the caller holds `g_session_lock`. Established by the callers, not here — see Open Questions.

**Outputs & Effects:**
- Returns `0` on success, `-ENOENT` when no session matches.
- State write: increments `s->refcount` (L116).
- State write: `*out` on the success path only. **On the error path `*out` is left untouched** (L114), so a caller that does not check the return value reads whatever was in its local.
- No external interactions, no events.
- Postcondition on success: the session's refcount is one higher and the caller owes a matching `session_release`.

**Block-by-Block:**

```c
// L113
struct session *s = session_lookup(id);
```
- **What:** Resolves the untrusted `id` to a session pointer.
- **Why here:** Nothing can proceed without the lookup, and it is the only place `id` is consumed.
- **Assumes:** `session_lookup` returns NULL rather than a stale pointer for an expired session.
- **Establishes:** nothing on its own — see the callee analysis below, which is where this gets interesting.
- **Depended on by:** L114 and L116 both.

```c
// L114-L115
if (!s)
    return -ENOENT;
```
- **What:** Rejects a lookup miss.
- **Why here:** Guards the dereference at L116.
- **Assumes:** NULL is the only failure representation `session_lookup` uses.
- **Establishes:** `s != NULL` for the remainder of the function.
- **Depended on by:** L116, L117.

```c
// L116-L117
s->refcount++;
*out = s;
```
- **What:** Records the borrow and publishes the pointer.
- **Why here:** After the NULL guard; the increment precedes publication so the caller never holds a pointer that has not been counted.
- **Assumes:** the caller holds `g_session_lock`, since `refcount++` is not atomic (`refcount` is a plain `int` at `src/session.h:L22`).
- **Establishes:** the borrow is accounted for.
- **Depended on by:** every subsequent `session_release`.

**Cross-Function Dependencies:**

- **Callee `session_lookup` (internal, src/session.c:L94-L110):** read in full. It walks `g_sessions` and returns the matching entry. Two properties matter here and neither is visible from `session_acquire`:
  1. It compares `s->id == id` (L102) but **does not check `s->state`**. An entry in state `SESSION_CLOSING` (set at L204 of `session_close`, which does not remove the entry from the table until L211) still matches. So `session_acquire` can take a reference to a session that is mid-teardown. `session_acquire` reads as though liveness were established; it is established nowhere.
  2. It returns NULL only when the walk falls off the end (L109). The expiry check at L104 `continue`s past expired entries rather than deleting them, so expiry is enforced only on the lookup path — an entry already borrowed by another caller stays reachable through that caller's pointer.
- **Callers:** `proto_handle_request` (`src/proto.c:L94`) — takes `g_session_lock` at L91, so the locking precondition holds. `admin_dump_session` (`src/admin.c:L51`) — **no lock acquisition anywhere in the function**; the increment at L116 races. That path assumes a precondition nothing establishes.
- **Shared state:** `g_sessions` with `session_lookup`, `session_close`, `session_reap`. `s->refcount` with `session_release`.
- **Invariant coupling:** the table's central invariant — every entry's refcount equals the number of outstanding borrows — holds only if every acquire is under the lock. One of the two callers breaks that.

**Open Questions:**
- unclear; need to inspect whether `g_session_lock` is documented as a caller precondition anywhere. Nothing in `session.h` states it, and only one of two callers honors it.
- unclear; need to inspect `session_reap` (`src/reap.c`) to know whether it can free an entry whose refcount is non-zero. That decides whether the `SESSION_CLOSING` window above is reachable in practice.

---

### What this example shows

The `SESSION_CLOSING` observation and the unlocked-caller observation are both invisible from `session_acquire` alone. Reading only the subject function, `session_lookup` returning non-NULL reads as though it established liveness. Reading the callee shows it establishes identity and nothing more.

Both are recorded as unenforced assumptions with the line that should have enforced them. Neither is called a use-after-free or a race condition, neither gets a severity, and no fix is proposed — the hunting phase makes those calls with the whole system model in front of it.

Note also what the record does *not* do: there is no invariant invented to reach a count, and blocks that do one thing get one line each.

### The same shape in Solidity

The format does not change between domains; the same callee trap appears in a different dialect:

```solidity
// L61
function withdraw(uint256 amount) external {
    require(_debit(msg.sender, amount), "insufficient");   // L62
    (bool ok, ) = msg.sender.call{value: amount}("");      // L63
    require(ok, "transfer failed");                        // L64
    totalDeposits -= amount;                               // L65
}
```

**Inputs & Assumptions:**
- `amount` (uint256): user-specified. Trust: **untrusted**.
- Implicit: `msg.sender`, `balanceOf[msg.sender]` (L12), `hasCreditLine[msg.sender]` (L13).
- Precondition: the caller's balance covers `amount`. **Established by `_debit`, and only on one of its two paths** — see below.

**Outputs & Effects:**
- Storage writes: `balanceOf[msg.sender]` inside `_debit` (L48, L52); `totalDeposits` at L65.
- External interaction: `msg.sender.call{value: amount}` (L63) — value transfer to an arbitrary address.
- No event emitted on withdrawal. Off-chain accounting cannot observe this path.

**Block-by-Block (L62-L65):**
- **What:** debits the balance, sends the ether, then decrements the running total.
- **Why here:** the debit precedes the transfer, which reads as checks-effects-interactions.
- **Assumes:** `_debit` returning true means the balance covered the amount.
- **Establishes:** nothing the later lines can rely on — `totalDeposits` at L65 lands *after* the external call at L63, so it is not in effect during re-entry.

**Cross-Function Dependencies:**
- **Callee `_debit` (internal, L44-L54):** read in full. Two paths, and they do not agree.
  - Default path (L50-L52): `if (balanceOf[account] < amount) return false;` then subtracts. The bound holds.
  - Credit-line path (L46-L49): when `hasCreditLine[account]` is set, it subtracts inside an `unchecked` block and returns true **without comparing balance to amount**. For those accounts the caller's precondition is established by nothing, and the subtraction wraps instead of reverting.
- **Invariant coupling:** `sum(balanceOf) == totalDeposits` is the contract's central invariant. It is maintained on the default path and not on the credit-line path.

**Open Questions:**
- unclear; need to inspect who can set `hasCreditLine` and whether it is ever cleared (`L13` declares it; no setter appears in this file).

Note what the record does *not* say: it does not call L63 a reentrancy vulnerability or the `unchecked` block an integer underflow, and it proposes no fix. It says where each precondition is established, and names the one that is established nowhere. The hunting phase takes it from there.

## Provenance

- Source repo: https://github.com/trailofbits/skills
- Original path: `plugins/audit-context-building/skills/audit-context-building`
- License: unknown — see repo
- 蒸馏说明：原 6 文件（SKILL.md + resources/ANALYSIS_FORMAT.md、DOMAIN_NOTES.md、FUNCTION_MICRO_ANALYSIS_EXAMPLE.md + agents/openai.yaml + assets/trail-of-bits-mark.svg）；三篇 resources 已全文内联为正文章节，openai.yaml 与 svg 仅为平台界面配置、无知识内容故省略；原文中指向本地 resources 文件的链接改为内联叙述。原仓库的 Claude Code workflow/agent 定义与路由实现见 [trailofbits/skills](https://github.com/trailofbits/skills)。
