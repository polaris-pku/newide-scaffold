---
name: harden-recent-changes
description: Hardens the code changed this round with a lightweight session-scoped review — three parallel read-only specialists covering data safety, crashes, and contract changes, with final judgment kept by the user. Use right after a refactor or code change.
---

# Harden recently-changed code

A lightweight, session-scoped hardening pass. It reviews **only the files changed this round** — no isolated worktree, no auto-commit, no whole-repo sweep. Reach for it right after a refactor or code change, when the question is "did this change break anything?" rather than "audit the codebase".

## When to Use

- Right after a refactor, migration, or feature change, before the change is called done.
- The user asks to "harden this change", "check what I just changed", "make sure this didn't break anything".
- As a fast pre-commit / pre-review pass over the session's diff.

## When NOT to Use

- A whole-repo or planned audit — that is a different, heavier task; this pass reads only this round's changes.
- Style, formatting, or naming review.
- Writing tests.

## The three angles

Each iteration runs three read-only specialists over the same files, one per angle:

- **A. Data safety** — lost writes, destructive migrations, races on persisted state.（丢写、破坏性迁移、持久化状态上的竞态）
- **B. Crashes** — null/undefined derefs, unhandled exceptions, broken control flow.（null/undefined 解引用、未捕获异常、控制流破损）
- **C. Contracts** — changed signatures, schemas, event payloads, config keys.（签名 / schema / 事件负载 / 配置键被改）

## Fan-out

Use an agent team with cross-examination when available (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` — one teammate per angle, persistent across rounds, cross-checking each other); otherwise 3 parallel sub-agents.（团队可用 agent-team 交叉质询，否则 3 个并行子代理）

## Triage — you keep final judgment

Fix only what is clearly safe to fix. Anything ambiguous, high-risk, or that could break another caller → STOP and ask the user, showing the file and the proposed change.（含糊 / 高风险 / 可能破坏其它调用方的要停下问用户并展示文件与改动）

## Exit conditions

- **Clean** — tests passed (the Stop hook confirms; no exit if tests fail).
- **5-iteration cap reached** — report what remains; never loop silently.
- **No convergence** — the open-findings count did not strictly decrease across two consecutive iterations → stop and escalate; a fix likely introduced a regression, or the findings are contested.

（干净 / 达 5 轮上限 / 连续两轮未收敛即升级上报）

## Prompt framing is defensive

Phrase specialist prompts as "verify the access check is correct", never "find a bypass" — attacker-hypothetical wording can trip safety checks even on your own code. Do not add a fourth angle.（提示措辞防御性）

## Provenance

- Source repo: https://github.com/LinardsLiepenieks/honecode
- Original path: skills/harden-code
- License: see upstream repo
- 独立说明（2026-09-11）：原为一个更大审计流程中的「会话模式」章节，同日抽出为独立技能，并改写为自足的触发条件与退出条件。
