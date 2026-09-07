---
name: production-autopsy
description: Audits a deployed ML/LLM/agent system that passes evals but fails in production; reproduces the failure, quantifies the gap by slice, tests calibration under shift, ablates to root cause, and emits a prioritized diagnostic report with next steps.
---

# production-autopsy

> 边界标注（2026-09-07）：面向 ML/LLM/agent 系统的 eval→prod 差距剖析；原插件内"校准/轨迹"深度 skill 本语料未收录，需要时按 Provenance 回上游。经典应用故障（非模型域）走 SRE 族或 correctness/bugsweep。
> Boundary (2026-09-07): eval-to-production gap autopsies for ML/LLM/agent systems; the plugin's deeper calibration/trajectory skills are not in this corpus (see Provenance). Classic app failures (non-model) go to the SRE family or correctness/bugsweep.

> 蒸馏自 ByteStack-Labs/claude-plugins（repo 内路径 `agent-reliability/skills/production-autopsy`）。原含 SKILL.md 与 scripts/finalize.py 两个文件；finalize.py 的自动化步骤已文字化并内联。文中提到的校准/轨迹等深度 skill 是该插件内其它 skill，未并入本文件。
> Distilled from ByteStack-Labs/claude-plugins (path `agent-reliability/skills/production-autopsy`); originally 2 files (SKILL.md + the finalize.py scaffolder), now merged into one file with the script's automation described as text.

## When to Use

Use this when someone says a model or agent "passes every benchmark but fails in prod", "the eval numbers don't hold up", is "confidently wrong", or "works in the demo and breaks with real users" — or asks to investigate silent failures, distribution shift, calibration problems, a benchmark-vs-reality discrepancy, or why a fine-tuned model or agent degraded after deployment. Trigger even when the user only describes the symptom (good offline metrics, bad real-world behavior) without naming a method.

A system that scores 99.75% on evaluation can still be wrong 10% of the time in production. That is not a contradiction: it means the evaluation measured something other than what deployment requires. This skill exists to find what the model or agent actually learned, why it fails where it fails, and to prove both with numbers that anyone can reproduce.

The output is a diagnostic, not a fix. The goal is a defensible root cause, backed by measurement, that a team can act on. Resist the pull to jump to remediation before the failure is reproduced and explained.

## How to Run It

This is the start-here skill. Point your coding agent at the system and let it work the procedure:

> Run production-autopsy on this system. Treat the eval set and the production behavior as separate distributions. Reproduce the failure on production-realistic inputs, quantify the gap by slice, test confidence calibration under the shift, and isolate root cause by ablation. Verify every number with runnable code, separate measured from inferred, and produce the prioritized report. Where a finding needs depth, use the matching skill in this plugin.

If you are new to this or inheriting a system you did not build, run the full audit. If you already know which failure you are chasing, skip to the matching deep skill listed under "Triage and hand-off" below.

## Core Principles

These are non-negotiable and define the methodology:

- **Every number is verified, never asserted.** Each quantitative claim in the report must trace to a specific measurement produced by runnable code. If a figure cannot be reproduced, it does not go in the report. No estimated, remembered, or "approximately" numbers.
- **Measure the gap, not the headline.** A single aggregate score (accuracy, exact match, win rate, task success) is the thing that hid the failure in the first place. Always decompose: by input slice, by distribution, by confidence band, and for agents, by step in the trajectory.
- **Separate measured from inferred.** State plainly which conclusions are directly measured and which are hypotheses still to be tested. Calibrate the confidence of the diagnosis itself.
- **Reproducibility is part of the deliverable.** The diagnosis is only as good as the script that regenerates it. Seed everything. Report the compute envelope.
- **Never regenerate committed fixture data.** If the target already ships a fixture (committed data/, results/, or equivalent), treat it as immutable ground truth and measure against it as-is. Synthesize new data only when none exists, and say so explicitly. Re-deriving committed numbers is the job; overwriting the inputs that produced them is never permitted.

## Workflow: The Diagnostic Procedure

Work these in order. Do not skip ahead to root cause before the failure is reproduced.

### Step 0 - Frame the gap

Before measuring anything, write down two things explicitly:

1. **What the evaluation measures**: the exact eval set, its input distribution, its metric, and how it was constructed.
2. **What deployment requires**: the real input distribution in production, the failure the user is actually seeing, and the metric that would have caught it.

The gap between these two is the whole investigation. If they are identical, the model is not the problem and you should say so. Most of the time they differ in a way the team has not named. That difference is the lead.

### Step 1 - Reproduce the production failure

Before constructing inputs, check whether the target already ships a canonical fixture. If it does, use it unchanged and do not regenerate it. Build new inputs only when the production distribution is genuinely unavailable.

You cannot diagnose what you cannot reproduce. Construct or obtain inputs that match the production distribution where the failure occurs, not the eval distribution. Common axes of divergence to probe: formatting and whitespace, field ordering, length, locale and encoding, prompt framing, the distribution of edge cases, tool and API responses for agents, and any preprocessing applied in eval but not in prod or the reverse.

Produce a minimal reproducing set: the smallest collection of inputs that reliably elicits the failure. Confirm the system behaves correctly on eval-style inputs and incorrectly on production-style inputs. If you cannot reproduce it, stop and widen the search for the real production distribution. A diagnosis built on an unreproduced failure is fiction.

### Step 2 - Quantify the eval-to-production gap

Run the same task metric on both distributions and report both numbers side by side (for example, exact match on eval vs. on production-realistic inputs). Then slice: which input categories drive the drop? A 10-point aggregate fall is often a 40-point fall on one slice masked by perfect performance on others. Find the slice. (A deeper, automated coverage check of eval vs. live distribution is planned as **coverage-audit**; until it ships, do this slice analysis inline.)

### Step 3 - Test confidence calibration under distribution shift

A model that fails is recoverable if it knows it is failing. A model that is confidently wrong is dangerous, because nothing downstream flags the error. Measure:

- The system's confidence (token logprobs, sequence probability, verbalized confidence, or an appropriate proxy) on correct vs. incorrect predictions.
- How the gap between those two shifts as you move from the eval distribution to the production distribution.

The signature failure mode: under distribution shift the confidence gap between correct and incorrect predictions narrows, or the system stays highly confident while accuracy collapses. Quantify it. If the system is confidently wrong, that is a headline finding and belongs near the top of the report. (For a focused calibration workup and a confidently-wrong detector you can wire into monitoring, use **calibration-guard**.)

### Step 4 - Isolate root cause by ablation

Now form a hypothesis about what the system actually learned and test it adversarially. The central question is almost always: did it learn the task, or a proxy that correlates with the task on the eval distribution but breaks under shift? Classic proxies: positional or formatting-dependent associations standing in for semantic understanding, a spurious feature, label leakage in eval, or memorization of eval-like patterns.

Design ablations that would break a proxy-learner but not a true task-learner, and run them. For example: permute field order, strip formatting cues, substitute semantically-equivalent but surface-different inputs, or hold out the suspected spurious feature. If performance collapses exactly where the proxy is removed, you have evidence (not proof) for the mechanism. State the strength of that evidence honestly.

### Step 5 - Add mechanistic evidence where feasible

Where the system and access allow, corroborate the behavioral root cause with mechanism:

- **Attention or activation patterns**: does the model attend to the tokens a true task-solver would, or to positional and formatting anchors?
- **Output-distribution divergence**: measure KL-divergence or another appropriate divergence between the output distribution on eval vs. production inputs to quantify how far behavior moves under shift.

Mechanistic evidence is corroborating, not required. Do not let its absence block a well-supported behavioral diagnosis, and do not let its presence inflate a weak one.

### Step 6 - Package for reproducibility

Bundle everything needed to regenerate every number: data generation or sourcing, the eval and production-realistic input sets, the measurement scripts, and the failure reproduction. Seed all stochastic steps. Report the compute envelope (hardware, runtime, cost) so the team knows what it takes to rerun. End-to-end reproducibility on commodity hardware is the standard to aim for.

## Triage and Hand-off

As you work the procedure, classify each finding into a reliability area and assign a severity (blocking, major, minor). For areas that need more depth than the audit gives, hand off to the matching skill and fold its result back into the report:

| If the audit surfaces...                                              | Hand off to        |
| -------------------------------------------------------------------- | ------------------ |
| The system is confident while wrong; calibration narrows under shift | calibration-guard  |
| The eval set does not cover the live input distribution              | coverage-audit (planned) |
| An agent passes per-step but the trajectory degrades                 | trajectory-eval    |
| Latency or throughput will not hold under real concurrency           | load-readiness (planned) |
| Quality or judge agreement decays over time on live traffic          | drift-watch (planned)    |

Only calibration-guard and trajectory-eval ship today. The other three skills named above (coverage-audit, load-readiness, drift-watch) are planned for later releases. If a skill is not installed, do the equivalent work inline using the procedure and note it.

## Checklist

- [ ] Step 0: eval measured vs. deployment required both written down explicitly before any measurement
- [ ] Step 1: failure reproduced on production-realistic inputs; correct-on-eval-style vs. incorrect-on-production-style confirmed; canonical fixture used unchanged if one exists
- [ ] Step 2: same task metric reported side by side on both distributions and sliced; the slice driving the drop is identified
- [ ] Step 3: confidence on correct vs. incorrect predictions measured, and its shift under distribution change quantified
- [ ] Step 4: root-cause hypothesis tested by ablation designed to break a proxy-learner; evidence strength stated honestly
- [ ] Step 5 (optional): mechanistic corroboration (attention/activations, output-divergence) reported when available
- [ ] Step 6: reproduction packaged (inputs, scripts, seeds, compute envelope) so every number regenerates
- [ ] Findings triaged by reliability area with severity (blocking/major/minor); deep-skill hand-offs folded back in
- [ ] Every quantitative claim traces to runnable code — no estimated, remembered, or "approximately" numbers
- [ ] Measured vs. inferred separated throughout; the diagnosis's own confidence is calibrated
- [ ] Remediation not reached for before the failure was reproduced and explained
- [ ] Receipt certified: REPORT.md + verify.py finalized (see next section); verify.py reproduces

## Output Format: Report Structure

ALWAYS produce the report in this structure. Lead with the finding, support with numbers, end with what is still uncertain.

```markdown
# [System] Production Autopsy

## Summary
One paragraph: the gap in plain terms, the root cause, and the headline number. State the single
most important finding first (for example, "confidently wrong, not uncertain").

## Prioritized findings
The triaged list, highest severity first. Each item: the finding, the area, the severity, the number
that supports it, and the next step.

## The gap
What evaluation measured vs. what deployment required, stated explicitly.

## Reproduction
The minimal reproducing set and confirmation: correct on eval-style, incorrect on production-style.

## Measurements
Eval vs. production metrics, side by side, sliced. Every figure traceable to a script.
- Confidence calibration finding (correct vs. incorrect, and its shift under distribution change).

## Root cause
The mechanism, the ablations that test it, and an explicit statement of how strong the evidence is.
Distinguish measured from inferred.

## Mechanistic corroboration (if available)
Attention, activation, or divergence evidence.

## Reproducibility
What is bundled, the seeds, and the compute envelope to rerun end to end. Reference
the verification script by a path relative to this report (`python3 verify.py` from
its own directory), never a repo-rooted path, so the receipt survives any move.

## Open questions
What is not yet established, and what measurement would resolve it.
```

## Finalizing the Receipt

This section is an instruction to you, the agent. It is not part of the report you produce.

Do not choose an output directory yourself. Write `REPORT.md` and a `verify.py` to a scratch location, then hand both to the finalize scaffolder — the single authority on where artifacts land and whether they are allowed to ship. In the source repo this is `scripts/finalize.py` (https://github.com/ByteStack-Labs/claude-plugins); run it as:

```
python3 finalize.py <fixture> <path-to-REPORT.md> <path-to-verify.py>
```

What the scaffolder does (textified; do the same by hand if the script is unavailable):

1. **Validate inputs**: exactly three arguments; both the report source and the verify source must exist, else it fails.
2. **Resolve the target repo root**: nearest ancestor directory containing a `.git` entry (no git binary needed); falls back to the current working directory.
3. **Place the pair**: destination is `<repo-root>/<out-dir>/<fixture>/`, where `<out-dir>` defaults to `receipts` and can be overridden with the environment variable `AR_OUT_DIR`. The report and verify script are moved in as `REPORT.md` and `verify.py`.
4. **Guard against rooted paths**: the report text is scanned for a repo-rooted reference to its own verify script (pattern `receipts|recipes|diagnostics/<...>/verify.py`). If found, finalization fails with the instruction to reference verify.py relative to the report itself (e.g. `python3 verify.py`).
5. **Certify reproduction**: `verify.py` is executed in the destination directory with output suppressed. Any non-zero exit fails with "verify.py did not reproduce; receipt NOT certified." A receipt that does not certify does not get committed.
6. **Report**: on success it prints the relative path of the placed, certified receipt.

The scaffolder is standard-library Python only — no shell, no git binary, no non-stdlib imports — and runs identically on Windows, macOS, and Linux.

## Guardrails

- **Do not reach for remediation early.** "Here is how to fix it" before the failure is reproduced and explained is the premature-convergence failure mode this methodology exists to prevent.
- **One slice can be the whole story.** Always check whether an aggregate number is hiding a concentrated failure before concluding the system is uniformly degraded.
- **Correlation in an ablation is evidence, not proof.** Name the strength of each inference. A clean ablation collapse is strong. A suggestive attention map alone is weak.
- **If you cannot reproduce it, say so** and report what you would need (the real production distribution, logs, access) rather than manufacturing a plausible-sounding cause.
- **The diagnosis has a confidence level too.** Calibrate it the same way you would expect the system to calibrate its own.

## Examples

A deliberately format-fragile extractor scored 100% exact match on evaluation but about 86% on the same eleven fields once the formatting shifted. Slicing by the saved shift type located the failure precisely: order-preserving changes (different delimiters, extra whitespace) held at 100%, while every change that moved fields (reordering, single-line compaction, decorative extra lines) collapsed to zero. Because the per-record shift type was persisted, the drop could be attributed to its cause rather than guessed. The root cause was positional: the extractor assigned values by line position rather than by the label beside them, so it read layout instead of meaning. The whole thing reproduces from the standard library with no model and no GPU, every number regenerating from a fixed seed. That is the target shape of an autopsy: the gap reproduced, quantified by slice, and traced to a mechanism anyone can rerun. (The full worked example lives in the agent-reliability-receipts companion repo, https://github.com/ByteStack-Labs/agent-reliability-receipts.)

## Provenance

- Source repo: https://github.com/ByteStack-Labs/claude-plugins
- Original path: `agent-reliability/skills/production-autopsy`
- License: unknown — see repo
- 蒸馏说明：原含 2 个文件（SKILL.md + scripts/finalize.py），无 LICENSE/README；finalize.py 的 CLI、放置规则、路径守卫与 certify 逻辑已按脚本逐行文字化。正文加入 When to Use（自原 description 提炼）与 Checklist（自原文原则/守则重组），未新增内容。脚本中无其它阈值或判定规则被省略。
