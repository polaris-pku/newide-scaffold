---
name: evals-ops-guardrails
description: Establishes reliability, safety, and release readiness for LLM-driven agents. Use for eval suites, adversarial testing, observability, budgets, policy gates, prompt-injection defenses, and rollout controls.
---

> 边界标注（2026-09-07）：Agent 运维门禁（评估/护栏/发布）；提示注入的进攻探测见 security/direct-injection-detection，分类见 security/owasp-asi。
> Boundary (2026-09-07): agent-ops release gates (evals/guardrails/rollout); offensive prompt-injection probing is security/direct-injection-detection, classification is owasp-asi.

Treat reliability as part of the product, not as cleanup after implementation.

This skill defines how an agent system earns the right to ship.

> Invocation argument: `[system or feature]` — name the system (or the specific feature) whose reliability, safety, and release readiness is being assessed. The original skill restricted itself to the tools Read, Write, Edit, Bash, Grep, Glob; that tool-runtime constraint is not carried over into this distilled version.

## Use this skill when
- the task involves evals, safety, observability, release, or hardening
- the user asks whether an agent is production ready
- the system needs measurable gates instead of confidence-based claims
- prompt injection, tool misuse, or cost/risk control must be addressed

## Minimum production controls
Every meaningful agent system should have:
- strict tool schemas
- time, step, and cost budgets
- bounded retries and timeouts
- idempotency for side effects
- approval gates for risky actions
- structured receipts and trace logs
- replay capability
- golden, adversarial, and regression evals

## Eval design procedure
### 1. Define the capability surface
List:
- representative user tasks
- allowed tools and actions
- key constraints and policies
- expected outputs or side effects

### 2. Build golden-path evals
Golden evals should cover the product's core promises.
For each eval, specify:
- input prompt or scenario
- starting context
- allowed tools
- expected task outcome
- success criteria
- max cost or latency if relevant

### 3. Build adversarial evals
At minimum include:
- prompt injection trying to override policy
- malicious or misleading retrieval content
- tool misuse with wrong or over-broad arguments
- exfiltration attempts targeting secrets or tenant data
- hallucinated claims with no supporting evidence
- approval bypass attempts
- runaway loop or budget exhaustion scenarios

### 4. Build regression evals
Keep a stable suite that runs on:
- prompt changes
- tool schema changes
- runtime logic changes
- model changes
- memory or retrieval changes

### 5. Define metrics and thresholds
Minimum metrics:
- task success rate
- tool selection accuracy
- argument validity rate
- policy adherence rate
- approval compliance rate
- failure recovery rate
- cost per successful task
- p95 latency

Do not ship on averages alone if tail behavior matters.

## Observability specification
For each run and step, log:
- run id and tenant scope
- state transitions
- tool calls with validated and redacted args
- tool results with structured outputs
- retries and error classification
- approval requests and decisions
- token, latency, and cost estimates if available
- final disposition: success, graceful failure, blocked by policy, canceled

Traces must support:
- replay
- incident debugging
- eval triage
- user-facing receipt generation

## Safety and governance rules
Guard against:
- prompt injection changing objectives or policy
- data leakage across users or tenants
- tool dispatch outside permission scope
- irreversible changes without approval
- hidden cost escalation

Require explicit policy boundaries for:
- network access
- filesystem or data access
- external communications
- deletion or mutation actions
- spending money

## Rollout and release
Prefer staged release:
1. local or sandbox validation
2. internal dogfood
3. small canary
4. controlled expansion
5. full release

Every stage should define:
- gating metrics
- rollback triggers
- incident owner

## Output contract
Return:
1. **Capability surface**
2. **Golden-path eval plan**
3. **Adversarial eval plan**
4. **Regression strategy**
5. **Metrics and thresholds**
6. **Logging and tracing spec**
7. **Release gates**
8. **Rollback criteria**

## Anti-patterns
Avoid:
- only evaluating final text quality
- no adversarial coverage
- relying on manual spot checks as the primary release gate
- logging too little to explain incidents
- calling a system production-ready because a demo worked

## Done criteria
This skill is done only when:
- core product promises are covered by evals
- known threat classes have explicit tests
- release blocking thresholds are defined
- traces are sufficient for replay and incident analysis
