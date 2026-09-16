---
name: chaos-engineering
description: Plans and runs chaos engineering experiments with steady-state hypotheses, blast-radius control and game-day playbooks, then turns findings into resilience work.
---

# Chaos Engineering

Design experiments that surface real weaknesses in production systems — without becoming outages. Most "chaos engineering" attempts skip steady-state measurement, define no abort criteria, and have no blast-radius bound. This skill enforces the discipline that makes chaos experiments safe and useful.

## When to use

- Planning a chaos experiment (what to break, where, when, how to abort)
- Calculating blast radius before running the experiment
- Reviewing an existing experiment plan for safety
- Choosing a chaos tool (Chaos Toolkit / Chaos Mesh / Litmus / Gremlin / AWS FIS)
- Writing a chaos experiment postmortem
- Running a Game Day exercise

## When NOT to use

- Operational incident response / SEV triage (out of scope here — use your on-call incident process)
- Threat hunting / red-team offensive security work (out of scope here)
- Performance load testing (different goal — chaos is about failure modes, not capacity)
- Production debugging (chaos discovers weaknesses preemptively, not after-the-fact)

## Core principle: chaos without abort criteria is an outage

The 4 Principles of Chaos Engineering (Netflix, 2016):

1. **Build a hypothesis around steady-state behavior.** Not "what breaks?" but "X holds; will it still hold under fault Y?"
2. **Vary real-world events.** Inject realistic failures: kill nodes, slow networks, lose cache, throttle dependencies.
3. **Run experiments in production** — once abort criteria, a bounded blast radius, and on-call coverage exist. Staging never has the same failure modes, so a staging-only program proves little; production is the *mature* rung, not the entry point. (Drills whose first concern is protecting real data instead default to non-production first.)
4. **Automate experiments to run continuously.** One-off chaos is a press release; continuous chaos is engineering.

Add a fifth: **Define abort criteria up front.** A chaos experiment with no abort criteria is an outage by another name.

## Experiment design protocol

The three original helper programs (`scripts/experiment_designer.py`, `scripts/blast_radius_calculator.py`, `scripts/experiment_postmortem.py`) are **not distributed with this corpus**. Their rules are inlined here so an experiment can be designed, bounded, and written up without running a bundled tool.

### 1. Experiment plan

Every plan must contain these sections — a plan missing any of them is not runnable:

| Section | What it must state |
|---|---|
| Hypothesis | "X holds; will it still hold under fault Y?" — e.g. "p99 latency stays <500ms when payment-svc is slow" |
| Steady-state metric | The measurable baseline, captured *before* the experiment |
| Attack | Which of the 7 taxonomy attacks, against which target |
| Magnitude | The injected amount (e.g. +200ms) |
| Duration | A bounded window (e.g. 15 min) |
| Blast radius | The bounded scope (e.g. 5% of US traffic) |
| Abort criteria | Concrete and measurable, e.g. "p99 > 1000ms OR error_rate > baseline + 1pp" |
| Rollback | How the fault is removed and the system returned to baseline |
| Monitoring | The dashboards/open panels watched during the run |
| Learning question | The specific uncertainty the experiment resolves |

### 2. Blast-radius calculation

The bands below are a starting default — calibrate them to your service's error budget and traffic before relying on them.

Before proceeding, bound the blast radius from traffic share, user population, duration, and the availability delta (baseline vs. expected impact). Derive:

- **Expected affected users** = population × traffic share.
- **Error budget consumed** (in minutes) = the extra unavailability over the window, expressed against the SLO budget.
- **Risk score**: GREEN = <1% of error budget; YELLOW = 1–10%; RED = >10%.
- **Recommendation**: PROCEED (GREEN) / REDUCE (YELLOW) / ABORT (RED).

Never run an experiment that scores RED; REDUCE means lower the traffic share or shorten the window first.

### 3. Experiment postmortem

Write up the result with: summary; hypothesis — confirmed or refuted; what was learned; what surprised us; follow-up actions with owners; and a link to the next experiment. Guard against the classic failure modes: no learning recorded, no follow-up actions, blame-laden language.

## The 7 attack types (taxonomy)

Different attacks reveal different weaknesses:

| Attack | What it tests | Tooling |
|---|---|---|
| **Latency** | Timeouts, retries, circuit breakers | tc, Chaos Mesh `NetworkChaos` |
| **Error** | Error handling, fallback paths | Chaos Mesh `HTTPChaos`, Toxiproxy |
| **Resource** (CPU, memory, disk) | Saturation handling, autoscaling | Chaos Mesh `StressChaos`, stress-ng |
| **Network partition** | Split-brain, consensus, failover | Chaos Mesh `NetworkChaos` partition |
| **Dependency failure** | Graceful degradation, fallback | Service mesh fault injection |
| **Time** | Clock skew, NTP issues | libfaketime, Chaos Mesh `TimeChaos` |
| **Infrastructure** (kill instance) | Auto-recovery, failover | AWS FIS, Chaos Monkey |

Pick the attack that matches the hypothesis. "What happens if X is slow?" → latency. "What happens if X loses network?" → partition.

## Tooling chooser

| Tool | Best for | Pricing | Stack |
|---|---|---|---|
| **Chaos Toolkit** | Lightweight, language-agnostic, JSON experiments | OSS | Any |
| **Chaos Mesh** | Kubernetes-native, rich CRDs, in-cluster | OSS | Kubernetes |
| **Litmus** | Kubernetes, Argo-integrated, large library | OSS + Enterprise | Kubernetes |
| **Gremlin** | Enterprise SaaS, multi-cloud, audit | Paid | Any |
| **AWS FIS** | AWS-native, IAM-integrated, EC2/ECS/EKS | Paid (AWS) | AWS |
| **Custom** | Niche needs, single-cloud, low budget | None | Any |

Decision rules:
- k8s-only stack + OSS → Chaos Mesh or Litmus (Litmus has bigger experiment library)
- Multi-cloud + OSS → Chaos Toolkit
- AWS-heavy + simple needs → AWS FIS
- Enterprise + audit/compliance → Gremlin

## Workflows

### Workflow 1: Design and run a single experiment

```
1. State a hypothesis: "When [fault], steady-state metric X stays within Y."
2. Identify the steady-state metric — it must be measurable BEFORE the experiment.
3. Calculate the blast radius (Experiment design protocol §2) — confirm GREEN before proceeding.
4. Produce the experiment plan (protocol §1) with all required sections.
5. Get a peer review of the plan; confirm the abort criteria are concrete.
6. Notify the on-call team in #incidents (or whatever channel).
7. Run the experiment with monitoring open.
8. If abort criteria are hit, abort immediately; record what happened.
9. Write the postmortem (protocol §3) to capture learnings.
10. File follow-up actions; link to next experiment.
```

### Workflow 2: Game Day exercise

```
1. Pick a scenario (e.g., "primary database fails over").
2. Identify all dependent services that should keep working.
3. Build a multi-experiment plan covering each layer.
4. Schedule with stakeholders; on-call coverage required.
5. Run with a facilitator who manages the scenario.
6. Capture observations in a shared doc as they happen.
7. Single combined postmortem covering all observations.
8. Track follow-up actions in a board with owners.
```

### Workflow 3: Continuous chaos (game days → daily)

```
1. Start: weekly Game Day in staging.
2. Move to: weekly Game Day in production with limited blast radius.
3. Mature to: continuous chaos via scheduled experiments (Litmus chaos schedule, Gremlin scenarios).
4. Wire to deployment: every prod deploy triggers a baseline chaos sweep.
5. Track: experiments per week, weaknesses discovered, MTTR trend.
```

## Verifiable success

A team using this skill should achieve:

- 100% of chaos experiments have a written hypothesis, abort criteria, and blast-radius calculation
- Blast radius for any single experiment never exceeds 10% of error budget
- Mean time between chaos experiments <14 days (continuous, not one-off)
- Each experiment produces ≥1 follow-up action that gets shipped
- No chaos experiment escalates to a customer-impacting incident in trailing 90 days

## Provenance

- Source repo: https://github.com/alirezarezvani/claude-skills
- Original path: engineering/skills/chaos-engineering/SKILL.md
- License: MIT
- 并入说明（2026-09-07）：下载并归一为单文件（frontmatter 仅 name/description）；原仓库配套技能/辅助文件未随附，需要时回上游取用。
- Integration note (2026-09-07): fetched and normalized to single-file; sibling skills and auxiliary files of the source repo are not bundled - see upstream.
