---
name: feature-flags-architect
description: Architects feature-flag systems for progressive delivery - flag design, rollout and retire lifecycles, and audits - as the controlled-release mechanism. Use when adding, retiring or auditing feature flags.
---

# Feature Flags Architect

End-to-end discipline for feature flags: classify them, ship them, ramp them, and retire them. Most teams treat flags as throwaway `if`-statements; this skill treats them as a controlled lifecycle with measurable debt.

## When to use

- Adding a new flag and need a rollout plan
- Auditing a codebase for stale or orphaned flags
- Choosing a flag provider (LaunchDarkly vs GrowthBook vs Statsig vs Unleash vs Flipt vs build-your-own)
- Designing a kill-switch path for a risky launch
- Cleaning up flag debt before a release freeze
- Reviewing whether a feature should ship behind a flag at all

## Core principle: flags are a lifecycle, not an `if`

```
request → design → ship → ramp → cleanup → archive
```

Flags that skip cleanup become debt: dead branches, stale defaults, untested code paths, unbounded blast radius. The three disciplines below — debt scan, rollout plan, kill-switch audit — enforce the lifecycle.

> **Asset note.** The original skill bundled `scripts/flag_debt_scanner.py`, `scripts/rollout_planner.py`, and `scripts/kill_switch_audit.py`. They are **not distributed with this corpus**; the "Flag lifecycle methods" section below inlines the rules they encoded.

## Quick start

Three moves, in order: **scan** the repo for flag debt, **plan** a progressive rollout for any new flag, and **audit** that every flag has a documented kill switch. The rules for each are inlined under "Flag lifecycle methods".

## The 4 flag types (taxonomy)

Different flag types have different lifespans and ownership. Misclassifying creates debt.

| Type | Purpose | Typical lifespan | Owner | Cleanup trigger |
|---|---|---|---|---|
| **Release** | Hide unfinished features in production | days–weeks | Eng | 100% rollout reached |
| **Experiment** | A/B test variants | weeks | Product/Marketing | Test concluded; winner picked |
| **Operational** | Circuit breakers, perf toggles, kill switches | months–years | Eng/SRE | Replaced by autoscaling/feature retirement |
| **Permission** | Entitlements per user/account/plan | years (permanent) | Product | Plan/role removed |

Only Release and Experiment flags belong on a debt watchlist. Operational and Permission flags are by design long-lived.

## Flag lifecycle methods

### 1. Flag-debt scan

Find flags that are old and barely used — the cleanup candidates.

**Detection heuristic:**
1. Walk the repo for code references matching common flag-call patterns:
   - `flag("...")`, `isFlagEnabled("...")`, `featureFlag("...")`, `getFlag("...")`
   - `client.variation("...", ...)`, `unleash.isEnabled("...")`, `growthbook.feature("...")`
2. For each unique flag identifier, find the oldest commit that introduced it (`git log --diff-filter=A -S <name>`).
3. Mark as DEBT if introduced more than `max-age-days` ago (default 90) AND used in ≤ `min-uses` places.

Report, per flag: name, age in days, file references, and a suggested action. Render as text for humans or JSON for CI.

### 2. Rollout plan

Derive a phased rollout schedule from population size, target percent, duration, and strategy.

**Strategies:**
- `ring`: 1% → 5% → 25% → 50% → 100%, evenly spaced. Default for risky launches.
- `linear`: constant rate per day. Default for medium-risk.
- `log`: rapid early, slow tail. Default for low-risk launches with confidence.
- `cohort`: by named cohort (internal → beta → free → paid → all).

Produce a table with, per phase: date, percent, expected user count, abort criteria, and verification step.

### 3. Kill-switch audit

Cross-reference code-discovered flags against documentation to verify each has a written kill-switch path.

**What it checks:**
1. Every code-discovered flag has an entry in the flag doc.
2. Each entry declares: owner, type, kill-switch trigger, monitoring dashboard.
3. Report flags missing documentation (FAIL) or missing fields (WARN).

Run it as a pre-merge gate before any new flag ships.

## Provider chooser (5 + DIY)

| Provider | Best for | Pricing model | Lock-in risk | OSS option |
|---|---|---|---|---|
| **LaunchDarkly** | Enterprise, complex targeting, audit/compliance | Per-MAU, expensive | High | No |
| **GrowthBook** | Mid-market, A/B testing focused, OSS-friendly | Per-MAU + OSS | Low | Yes (self-host) |
| **Statsig** | Growth/product teams, advanced experimentation | Free tier + per-MAU | Medium | No |
| **Unleash** | OSS-first, self-hosted, dev-friendly | OSS + Enterprise | Low | Yes |
| **Flipt** | Lightweight, k8s-native, simple needs | OSS-only | None | Yes |
| **DIY** | <100 flags, no targeting, full control | None | None | N/A |

Decision rules:
- <50 flags + no targeting → DIY with config file or env vars
- Need analytics + experimentation → Statsig or GrowthBook
- Compliance/SOC2 audit logs required → LaunchDarkly
- Self-hosting required (data residency / air-gapped) → Unleash or Flipt

## Workflows

### Workflow 1: Ship a new feature behind a flag

```
1. Classify: which of the 4 flag types?
   → Release (most common for engineering work)
2. Design the ramp (Flag lifecycle methods §2)
3. Add the flag entry to docs/feature-flags.md BEFORE writing code:
   - name, owner, type, kill-switch trigger, dashboard URL
4. Write the code with the flag
5. Run the kill-switch audit (§3) — must pass before merge
6. Deploy at 0%; verify the kill switch works
7. Execute the rollout schedule; abort if abort criteria met
8. At 100% for 7+ days: remove flag, delete dead branch, archive doc entry
```

### Workflow 2: Quarterly flag cleanup

```
1. Run the debt scan (§1) at max-age-days 90; keep the output as the worklist
2. For each flagged item:
   a. Confirm it reached 100% (or was killed)
   b. Find the issue/PR that introduced it; verify the owner agrees to remove
   c. Delete dead branches; remove flag config
   d. Re-run the kill-switch audit (§3) — it should now show one fewer flag
3. Update CHANGELOG: "Removed N stale flags"
```

### Workflow 3: Choose a provider

```
1. Estimate flag count (current + 12-month projection)
2. Required features:
   - Targeting rules (user, account, geo, %)?
   - A/B testing + stats?
   - Audit log / SOC2?
   - Self-hosting / data residency?
3. Pricing budget (MAU * cost-per-MAU)
4. Apply the provider decision rules above
5. Build a 30-day proof-of-concept before signing
```

### Workflow 4: Design a kill switch

```
1. Identify the failure modes:
   - Latency spike (which threshold?)
   - Error rate spike (which threshold?)
   - Business metric regression (which threshold?)
2. Wire each to an abort:
   - Manual: dashboard link + on-call playbook
   - Automated: alert threshold flips flag back to 0%
3. Test the kill switch in staging BEFORE production rollout
4. Document it in the flag doc; pass the kill-switch audit (§3)
```

## Flag lifecycle methods reference

The original skill's companion docs (`references/flag_taxonomy.md`, `references/provider_comparison.md`, `references/rollout_strategies.md`, `references/flag_lifecycle.md`), its `assets/flag_request_template.md`, and its `/flag-cleanup` slash command were not bundled with this corpus. Their content is inlined above: the 4 flag types and ownership (taxonomy table), the provider trade-offs (Provider chooser), the rollout strategies and abort criteria (§2), and the lifecycle stages (Core principle).

## Anti-patterns

- **Permanent flag with `if (FLAG_FOO)` 50 places** — should be a Permission flag with a runtime config, not a Release flag
- **Flag with no owner** — when the original engineer leaves, no one cleans it up
- **No kill switch documented** — when the feature breaks, no one knows how to disable it
- **A/B test that ran 6 months** — pick a winner; running indefinitely is debt
- **Flags as feature toggles for cosmetic changes** — ship via deploy, not flag

## Verifiable success

A team using this skill should achieve:
- 100% of new flags pass the kill-switch audit at merge time
- A debt scan at max-age-days 90 returns ≤5 stale flags repo-wide
- Every flag has a documented owner, type, and kill switch
- Mean time to retire a Release flag: <60 days from 100% rollout

## Provenance

- Source repo: https://github.com/alirezarezvani/claude-skills
- Original path: engineering/skills/feature-flags-architect/SKILL.md
- License: MIT
- 并入说明（2026-09-07）：下载并归一为单文件（frontmatter 仅 name/description）；原仓库配套技能/辅助文件未随附，需要时回上游取用。
- Integration note (2026-09-07): fetched and normalized to single-file; sibling skills and auxiliary files of the source repo are not bundled - see upstream.
