---
name: backend-performance-review
description: 'Audits backend codebases for performance bottlenecks with an evidence-first, workload-driven
  methodology: latency, throughput, slow queries, N+1, pool exhaustion, event-loop
  blocking, contention, memory/CPU pressure, queue lag, retry storms.'
---

# backend-performance-review

> 蒸馏自 Sanoy24/backend-performance-review（skills/backend-performance-review）。原为 51 文件深工具包（方法论/原则/分层/技术/数据库参考 + 报告模板 + Python 加速脚本），已合并为单文件。
> Distilled from Sanoy24/backend-performance-review (skills/backend-performance-review); originally a 51-file deep toolkit, now inlined as one file.

> 整合说明（2026-09-07）：本技能已收编 backend-latency-profiler-helper（快速配方：延迟埋点/慢端点初筛/三周路线图）作为附录；其目录保留为指针。想快速插桩测"哪些接口慢"时直接看文末附录，要严谨结论走本文方法论。
> Integration 2026-09-07: quick-recipe skill backend-latency-profiler-helper folded in as the appendix; its directory is now a pointer.

## When to Use

Reviews backend codebases for performance bottlenecks using an evidence-first, workload-driven methodology. Use when investigating latency, throughput, slow endpoints, database/query performance, N+1 queries, pool exhaustion, event-loop blocking, lock contention, memory/CPU pressure, queue lag, timeout/retry storms — or when asked to audit/review/improve the performance or scalability of a backend service, API, worker, or data layer.

**Trigger phrases**: "performance review", "why is this slow", "audit performance", "find bottlenecks", "will this scale", "review this service for performance", "perf review of this PR". Any language/framework/runtime/datastore. Requires read access to the target repo; no network access required.

**Modes**: **Full review** (whole repo, all phases). **Change-scoped review** (diff/branch/PR — Phases 0–3 shallow to place the change; then only touched paths + immediate callers + their queries; report only what the change introduces/worsens/sits adjacent to). Choose change-scoped when the user names a diff/branch/PR/commit or asks "does this change hurt performance"; else full. Ambiguous → ask once.

## Core Principles

Job: **find where time and resources actually go**, prove it from evidence, say honestly what cannot be proven — not list best practices.

**Reasoning order (non-negotiable)**: `Performance principle → observed implementation → technology manifestation → evidence → bottleneck → impact under stated workload → recommendation → validation`. Never `technology → generic best practice → recommendation`.

**Hard rules**

1. **Never invent numbers** (latency, throughput, CPU, memory, hit rates, plans, row counts, traffic, users). Every number traces to (a) a repo file, (b) a user-supplied measurement, or (c) an explicitly labelled derivation.
2. **Read-only.** No modifying code/config/data; nothing against production. Diagnostics are *recommendations in the validation plan*, labelled `safe-on-production` / `not-safe-on-production`.
3. **No secrets.** Never read `.env`, `*.pem`, `*.key`, `credentials*`, `*.tfvars` — note presence only. Never reproduce connection strings, credentials, tokens, internal hostnames, customer data; redact when quoting.
4. **Zero findings is valid and successful.** If nothing material surfaces, say so; deliver unknowns + the measurement plan that resolves them. Never manufacture findings.
5. **No cargo cult.** Never reflexively recommend caching, Redis, indexes, async, parallelism, sharding, denormalization, microservices, more servers, another language. Without a filled `Conditions` field the recommendation does not ship.
6. **Absent layers are silent.** No broker section for a project with no broker. Omit, do not stub.
7. **Unknown technology degrades, never fails.** Identify category → apply category principles → inspect config/usage → state what you can/can't infer → recommend what would determine it. No invented engine facts.
8. **Out-of-scope issues get no performance score but a full write-up.** Real security/correctness/maintenance issues found en route get full write-ups (Problem, Evidence, Recommendation, Trade-offs, Validation) under **`SEC-`/`COR-`/`MAINT-`** IDs (never `PERF-`), in a separate "Adjacent findings" section, with `Kind` + `Confidence` + plain-language `Risk` (Low/Med/High, one sentence) — never `Severity`/`Priority`/CVSS-style scores. Name the dedicated review/tool that would assess it.

## Workflow

### Phase 0 — Scope and safety
Confirm mode and read-only; set output budget.

### Phase 1 — Discovery
Detect stack, architecture, entry points. If the repo's bundled accelerator script (`detect_stack.py`, Python 3.8+, stdlib-only, read-only; emits JSON of detected languages/frameworks/datastores/caches/brokers/infrastructure + partial `references_to_load`) is available, run it on the repo path — accelerator only, **never a dependency**; if missing/erroring, inspect manifests manually. Its `references_to_load` is necessarily partial (signal-matched only); usage-pattern triggers (ORM/N+1, pooled clients, serialization) apply whenever the code does that thing.

**Inventory observability before anything else** — metrics, traces, logs, benchmarks, load tests, dashboards-as-code, SLOs. It caps the confidence of every finding. Classify: **well instrumented** (traces/profiles cover the critical path → `Confirmed` reachable), **partially** (some metrics, not for these paths → most findings cap `High`), **uninstrumented** (workload-dependent findings cap `Medium`; instrumentation itself is likely a top recommendation). State which in the report.

**Stack inventory** — manifests: Node `package.json`+lockfiles; Python `requirements*.txt`/`pyproject.toml`/`poetry.lock`/`Pipfile`/`uv.lock`; Go `go.mod`/`go.sum`; Rust `Cargo.toml`/`Cargo.lock`; JVM `pom.xml`/`build.gradle(.kts)`/`gradle.lockfile`; .NET `*.csproj`/`*.fsproj`/`*.sln`/`packages.lock.json`; PHP `composer(.lock)`; Ruby `Gemfile(.lock)`. **Read the lockfile, not just the manifest**, for actual presence/version. Also: Dockerfile/compose (services, base image, entrypoint, worker counts), k8s/Helm (replicas, requests/limits, probes, HPA), IaC (managed datastores, capacity), CI config, `Procfile`/Makefile/entrypoint (real production command line), connection-string schemes (`postgresql://` etc. — scheme only), migration dirs (schema = data model), ORM/ODM config (lazy/eager, pools, statement caching). Record versions; if undeterminable, say so.

**Architecture sketch** — entry points (routes, gRPC impls, GraphQL resolvers, consumers, scheduled jobs, CLIs); trace one representative request end-to-end first; identify **shared resources** (pools, event loop, global locks, single-writer primary, shared cache, shared-state limiters/breakers; tenant/account discriminator → multi-tenancy); external dependencies (uncontrolled latency, failure mode without timeout); deployment model (single/multi-process, containers, serverless).

**Layer gates** — present layers: API, Application, Data access, Cache, Distributed, Infrastructure, Observability (always — its absence is a finding). Change-scoped: only touched layers + called-into layers. Do **not**: form conclusions yet; assume declared deps are used (grep); assume code runs in production (flags, dead routes, vendored copies); read secrets; present inventory as analysis.

### Phase 2 — Workload
Mine the repo first — don't ask what it answers. Signals: load-test scripts; rate limits/quotas; autoscaling config; replica counts; worker/thread counts; pool size; timeouts. **Pool × workers is a highly informative pair** (pool 5 behind 32 workers claims few concurrent DB touches — test it). Growth signals: migrations, retention/archival jobs, TTL/expiry, pagination defaults **and maxima**, seeds/fixtures, batch sizes. A table written on every user action with no retention job grows unbounded — a documented fact; cite it. Latency expectations: SLO docs, alert thresholds (p99>500ms alert = stated target), dashboards-as-code, breaker/retry config. Read/write shape: count endpoint/query kinds. Scheduled/background: cron, consumers, prefetch, batch windows.

**Interview — at most 7 questions, once, in one message**: (1) peak request rate on busiest endpoints (order of magnitude)? (2) largest table/collection + growth rate? (3) read/write ratio on the primary datastore? (4) latency target/SLO — met? (5) instances/workers + CPU/memory limits? (6) user-blocking vs background ops? (7) is there a specific problem prompting this review? — *highest value; organize the review around it.* **If the user won't answer: proceed anyway.** Record unknowns; assumptions → each finding's `Conditions`; workload-dependent findings cap `Medium`; say in the exec summary which findings would move with workload data.

**Workload model** — separate KNOWN (repo/user, cited) / ASSUMED (stated, unverified — drives caps) / UNKNOWN (would change conclusions).

**Current vs future risk — keep separate**: current = measurably slow/saturated now; future = growth implies a limit (today's severity + `scalability-risk` tag + concrete trigger scale: "at ~10× current rows this scan leaves the index-only path").

**10× question** — per critical-path finding: what happens at 10× traffic and 10× data? Flat = non-issue; linear = budget; superlinear = cliff (incident). Usually decides `Medium` vs `Critical`; show it in `Impact`.

### Phase 3 — Critical paths
Any work a caller is blocked on. Trace from entry points: handler → business logic → data access → datastore + external calls + shared state. Record per path: blocking? datastore ops (scales with result size?)? external calls? shared state? bounded? instrumented?

**Rank by structural signals** without runtime data: unbounded result set; query count ∝ result size (N+1); fan-out; serial dependent calls; holds a shared resource; transaction spanning I/O; no timeout; missing pagination. With runtime data, use it; state the ranking method in the report.

**Latency composition**: `total ≈ queueing + app CPU + Σ(serial I/O waits) + max(parallel I/O waits) + serialization + network`. Most paths are I/O-dominated → CPU micro-optimization is usually wrong; establish CPU share (profile) first.

**Queueing**: invisible in code, dominant in incidents, grows non-linearly toward capacity at any bounded resource (worker slots, pool, event loop, DB CPU, disk, downstream). Can't measure statically — enumerate where it will occur; recommend wait-time instrumentation (an unmetered pool is a blind spot).

**Amplification**: per-item work in list responses (2ms×500 = 1s — show arithmetic as derivation); per-request costs paid 100k× in batch jobs; parallel fan-out tracks the slowest dependency (a rarely-slow backend is frequently-slow in aggregate); retries multiply load on a degraded dependency; GraphQL nesting multiplies resolver calls.

**Tail latency has its own causes**: GC/runtime pauses; pool waits under burst; cache misses on a warm path; lock-contention windows; cold starts/JIT warmup; one slow shard/replica; DNS/TLS on non-reused connections; retry storms. "Usually fast, sometimes terrible" = tail problem — check this list before algorithms.

**Exception — background work on shared resources** becomes critical-path-worthy when it contends for the path (nightly job exhausting the pool; batch saturating DB I/O; consumer blocking the shared event loop; analytics on the primary; unthrottled migration). Score `position: async` but `blast radius: system-wide`.

Record what was deliberately not analyzed and why.

### Phase 4 — Layer gates
Analyze present layers only, in order: `application → data access → database → cache → distributed → infrastructure` (observability throughout). No per-technology reference → apply category principles, note reduced depth.

### Phase 5 — Bottleneck analysis (Synthesis)
Four questions, in order:

1. **Where is work repeated?** — the most productive question. N+1 incl. ORM lazy loading (loop looks like pure iteration — hardest, most valuable variant); same value fetched twice per request; double serialization; repeated validation/auth/parsing per layer; per-request recomputation of derivables; retries repeating successful work.
2. **Where is work unbounded?** — queries without `LIMIT`; endpoints without max page size (**a default is not a bound**); loading full collections to count/filter/aggregate; unbounded fan-out; unbounded concurrency (task per item, no semaphore); unbounded buffering; uncapped recursion/retries.
3. **Where is work serialized needlessly?** — sequential independent I/O; lock across I/O; single-threaded stage in a parallel pipeline; one-consumer queue / one hot partition key; sync work on an event loop. Recommend parallelism only when calls are independent **and** downstream absorbs it.
4. **Where are resources saturated/misconfigured?** — pool vs workers vs datastore limit; container memory vs heap; CPU limit vs runtime parallelism; fd limits; pools sized for the wrong workload. Config inconsistencies = checkable from files → `High`, no runtime data.

**Symptoms → constraints** (trace to cause; merge):

| Symptom | Frequent underlying constraint |
|:--|:--|
| High application latency | Downstream I/O, or pool queueing |
| Pool exhaustion | Slow queries/transactions holding connections |
| High CPU | Serialization, compression, crypto, or algorithmic — profile to tell |
| Memory growth | Unbounded buffering/caching, or retention leak |
| Queue lag | Consumer throughput < producer rate, or poison-message retry loop |
| Timeouts firing | Slow dependency, or misallocated budget |
| Cache misses | Wrong key granularity, short TTL, or stampede |

**Merging is mandatory** — N+1 + pool exhaustion + slow endpoint from one cause = one finding naming the cause.

**Discard aggressively** — tests: workload (cost noticeable?); critical-path (blocking or contending? else `Informational`); evidence (point at the line? else `Low` → frame as question); alternative explanation (memoized upstream? index in an unread migration?); counterfactual (what measurably improves, roughly?); intent (would a competent engineer dismiss it in one sentence?).

**Recommendations that survive** — address cause, not symptom; state cost. Order: (1) **Remove** work; (2) **Bound** (pagination/limits/timeouts/caps/semaphores); (3) **Move** (background/precompute/stream); (4) **Make cheaper** (index/query/structure); (5) **Cache** — only with hit-rate reasoning + invalidation + acceptable staleness; (6) **Add capacity** — last, on saturation evidence. Indexes are a trade — write cost/storage/planner surface into `Trade-offs`.

**Found nothing?** Deliver: statement that static analysis found no material bottleneck; workload model incl. unknowns; observability gaps; the 2–3 measurements that would change the conclusion; `scalability-risk` observations clearly marked not-current.

### Phase 6 — Report and validation
**Validation — five parts**: `Baseline` (measure first, comparable conditions); `Measurement` (specific metric at the specific place — N+1: count queries; pool: wait time; e2e latency is noisy); `Expectation` (direction + rough magnitude — a prediction derived from code, never a fabricated "40% faster"); `Safety` (label); `Falsifier` (what result would refute the finding — the most-skipped, most-honest part).

**Match evidence to claim**: query count → query log/ORM counter/APM spans; slow query → plan/`EXPLAIN`; CPU → sampling profiler/flamegraph; memory → heap/allocation profiler; event loop → lag metric; pool → wait-time metrics; cross-service → distributed trace; load → defined-scenario load test; tail vs median → percentiles, never averages.

**Production safety**: safe = `EXPLAIN` without execution, engine stats views/slow logs, reading existing metrics/traces/dashboards, low-rate accepted sampling, query counting on staging with production-shaped data. Not safe without approval = `EXPLAIN ANALYZE` on side-effecting statements, production load tests, heap dumps, indexes without concurrent build, verbose logging on a busy system, sustained load on a suspected-saturated system. Give the safe alternative. The skill never runs these — it writes them down.

**Validate the mechanism, not just the outcome** (query count dropped — not cache warmth; plan uses the index; pool wait fell). Mechanism validation enables regression tests: query-count assertions aren't flaky; latency assertions are.

**Guards**: query-count test per path (best N+1 guard); bounded-result/`LIMIT` test; metric+alert on the mechanism signal; scheduled CI load test for critical paths; lint/architecture rule when mechanically detectable.

**Tools**: Python `py-spy` (attach, no restart — usually first), `cProfile`, `tracemalloc`/`memray`/`scalene`; Node `--cpu-prof`/`--heap-prof`/DevTools, event-loop lag first; Go `net/http/pprof` (often compiled in); JVM async-profiler + JFR (production-acceptable); .NET `dotnet-trace`/`dotnet-counters`/`dotnet-gcdump`; Rust `perf`+flamegraph, `pprof-rs`, `dhat`/heaptrack (debug symbols in profiled build); load: k6/Locust/Gatling/JMeter/Artillery/`wrk`/`oha`.

## Rubrics

Two scored axes; **Priority is derived, never chosen**. Effort never changes priority — a cheap fix may be tagged `quick-win` and sequenced early.

### Confidence — evidence grade

| Level | Meaning |
|:--|:--|
| `Confirmed` | Runtime evidence exists **and is cited** (profile, `EXPLAIN`, benchmark, trace, metrics export, load-test result). Uncited `Confirmed` = violation. |
| `High` | Follows unambiguously from code alone (query in a loop; blocking call in async handler; unbounded query, no `LIMIT`). |
| `Medium` | Code pattern + stated, unverified workload/data assumption — the assumption goes in `Conditions`. |
| `Low` | Plausible only under conditions nothing evidences — a risk/question, not an assertion. |

Workload-dependent findings with unknown workload cap at `Medium`; `Low` never P0/P1. A test that merely exercises the path is not evidence of cost. Stale artifacts (plan from a schema two migrations ago) drop to `High`. `Medium` is not a weak `High`; it is `High` with a dependency, and `Conditions` must be confirmable in one sentence — "under high load" is a shrug. The cap doesn't apply to workload-independent findings (a missing timeout is a defect at any traffic).

### Severity — from four factors
For every finding identify: **position** (critical-path / async / offline), **frequency** (per request / per item / per batch / rare), **growth** (O(1), O(log n), O(n), O(n·m), O(n²)+ in data or traffic), **blast radius** (endpoint / service / system-wide).

| Level | Criteria |
|:--|:--|
| `Critical` | On the critical path **and** (superlinear growth **or** shared-resource saturation). Plausible system-wide failure. |
| `High` | On the critical path, per-request, linear growth in data likely to grow; or async-path contention of a shared resource. |
| `Medium` | Measurable waste on the critical path with bounded growth; or high-frequency work off it. |
| `Low` | Bounded, local, small constant factor. |
| `Informational` | No current or projected impact. |

**Superlinear on the critical path is the strongest `Critical` signal** (a cliff, not a slope). `Informational` is a performance verdict, not a parking spot — route real security issues to adjacent findings (rule 8).

### Priority — derived

| Severity ＼ Confidence | Confirmed | High | Medium | Low |
|:--|:--|:--|:--|:--|
| Critical | P0 | P0 | P1 | P2 |
| High | P0 | P1 | P1 | P2 |
| Medium | P1 | P2 | P2 | P3 |
| Low | P2 | P3 | P3 | P3 |
| Informational | P3 | P3 | P3 | P3 |

Tags: `quick-win` (small, low-risk vs impact), `scalability-risk` (future, scored on today's conditions), `needs-measurement`.

**Worked examples** — A. N+1 list endpoint, no cap: critical-path/per-item/O(n·m)/system-wide → **Critical/High/P0**. B. Same N+1, hard page cap 20: bounded growth, endpoint blast → **Medium/High/P2** (`quick-win`). C. stdlib JSON vs faster library, payloads unknown, no profile: **Low/Medium/P3**, report as `Informational` + measurement. D. Missing timeout on an outbound call in a handler: critical-path but failure is blast (hung upstream holds a worker slot) → **Critical/High/P0** (`quick-win`), no workload cap. E. Nothing found (point lookups, thin handlers, sized pools, timeouts set): **no findings** — report unknowns + 3 measurements that would change the conclusion. A successful review.

## Finding Format

```
ID:            PERF-001
Severity:      Critical | High | Medium | Low | Informational
Confidence:    Confirmed | High | Medium | Low
Priority:      P0 | P1 | P2 | P3      (must match the matrix)
Category:      data-access | concurrency | serialization | io | memory |
               networking | infrastructure | observability | cost
Location:      path/to/file.ext:LINE
Tags:          quick-win | scalability-risk | needs-measurement   (optional)

Problem:              What is wrong, in one or two sentences.
Performance principle: The universal principle violated, stated technology-free.
Evidence:             Repo support — cite files/lines; say if no runtime evidence.
Impact:               Position, frequency, growth, blast radius — explicit.
Conditions:           The workload under which this matters; state the assumption if
                       unknown. Never empty; never "under high load".
Recommendation:       What to change and why it addresses the principle, not the symptom.
Trade-offs:           Complexity, memory, consistency, operational burden, failure modes.
Validation:           How to prove it worked; each measurement labelled safe/not-safe-on-production.
```

Merge findings sharing a root cause. Adjacent findings: SEC-/COR-/MAINT- IDs, Kind/Confidence/Risk (rule 8).

## Output Budget and Report Skeleton

Full format for the top 10–15 findings by priority; the rest in one ranked table (ID, severity, confidence, priority, location, one-line summary). Deduplicate *before* capping. Skeleton: **1. Executive summary** (assessment 2–4 sentences; ≤5 most important findings w/ ID+priority; highest-risk bottlenecks — current vs scalability risk; **major unknowns — mandatory**). **2. Scope and method** (reviewed / not reviewed + why; evidence class; ranking method; reference depth). **3. Architecture overview** (components + shared resources). **4. Workload model** (Known cited / Assumed → caps / Unknown → would-change). **5. Critical path analysis** (ranked table + amplification points + deliberately-not-analyzed). **6. Layer analysis** (subsections per present layer only). **7. Findings** (full top 10–15; remaining table; "considered and not reported" — proves a filter; adjacent findings — omit if none). **8. Prioritized action plan** (sequenced; effort may reorder — say why; "if only one thing is done:"). **9. Validation plan** (per recommendation; instrumentation gaps first). **10. Notes.**

## Layer Library — checkpoints per present layer

### API surface
- **Boundedness** (first question per read endpoint): largest possible response; enforced max page size vs overridable default; omittable filter → full collection; unbounded nested expansion; max depth (`?include=`, GraphQL); unbounded batch id lists. Unbounded response = latency+memory+datastore+bandwidth problem — top static finding, small fix. **Offset pagination degrades with depth**; keyset avoids it but loses random access — state the trade-off.
- **Payload**: over-fetching (unused fields cost everywhere; worst if blob/join); under-fetching (thin response → caller does N calls — N+1 in the caller, often an API fix); nested expansion (multiplies). Does shape match consumption?
- **API-layer N+1**: query per parent in serializers/resolvers (GraphQL naive resolvers — keyed batching/dataloader collapses it); client-level (insufficient list data); middleware-level (per-request lookups repeated per item).
- **Middleware** (runs on every request): datastore auth without short-lived caching; remote feature-flag eval; body logging on hot endpoints; validation walking payload twice; useless/double compression; high-cardinality labels. Ordering: expensive work before cheap rejection = invalid requests pay full cost.
- **Protocol**: connection reuse (keep-alive both ends); HTTP/2/gRPC multiplexing (no HOL blocking; per-stream flow control, possible pinning skew); compression CPU-vs-bytes; TLS termination point; **server-side** read/write/idle/header timeouts — absence = capacity risk.
- **Write path**: idempotency (else no safe retry); sync work the caller doesn't need (mail/thumbnails/index/analytics → background); **transaction across an external call** (severe); bulk writes available?
- **Cacheability** (what the API enables): correct method semantics; `ETag`/`Last-Modified`; personalization defeating shared caching; mixed stable/volatile data forcing shortest TTL (split the endpoint).

### Data access
- **Core question**: how many round trips, and how does that scale with data?
- **N+1, invisible ORM forms**: explicit query-in-loop easy; dangerous = lazy loading on attribute access (loop looks like pure iteration). Detect: relationship loading strategies; attribute access in loops/serializers; missing eager-loading on relationship paths; queries during rendering; query-count tests/logs turn `High`→`Confirmed`. Separate: **over-eager loading** (unused joins → wide sets); **cartesian explosion** (eager-joining two 1-to-many relations multiplies rows — looks like a fix, isn't).
- **Query shape**: `SELECT *` (kills index-only paths); filtering/sorting in app code the datastore could index; counting by materializing; existence by full fetch; row-by-row aggregation; join-in-loop vs keyed lookup (O(n·m)→O(n+m)).
- **Batching**: multi-key fetch, bulk writes, set-membership predicates, dataloader. Caveats: huge `IN` lists degrade planning — chunk; a bulk write is one failure unit unless partial failure handled.
- **Transactions** (scope = lock duration): across an external call (lock duration = third party's latency — severe); across user interaction/long computation; per-item in a loop (or one giant transaction); read-only work in a write tx; missing txs → partial retry. Stricter isolation → more blocking/retry.
- **Connections**: whole-request vs query-only hold; reads to replica + lag handling; prepared statements reused; connection-per-op instead of pool.
- **Schema ops**: table-locking migrations; unthrottled backfills; index builds without concurrent path; migrations at startup.
- Don't claim "slow query" without a plan/measurement — you *can* claim unbounded/repeated from code. Don't assume the ORM generates what you'd write.

### Connection pools
- **Two calculations** (highest value-per-effort static check; `High`, no runtime data): (1) concurrency required ≈ arrival rate × hold time (undersized → requests queue with an *idle-looking datastore* — misdiagnosed as slow DB); (2) pool × workers/instance × instances ≤ datastore `max_connections` (exceeding = outage; leave headroom for admin/migrations/monitoring/rolling deploys, which roughly double connections).
- **Hold time is the lever**: whole-request acquisition; tx across external call; slow queries (doubling query time halves effective capacity); leaks (not returned on error path); idle-in-transaction.
- **Sizing isn't bigger-is-better**: oversized pools move contention into the datastore. **Instrument acquisition wait time** — no specific number without it.
- **Config**: acquisition timeout (absent = wait forever → saturation becomes a hang — most consequential); max lifetime; idle timeout; validation (absent = broken connections handed out; per-acquisition checks add a round trip); min/warm size (zero = cold-start tail); queue bound.
- **HTTP client pools**: client per request (DNS+TCP+TLS each call; can exhaust ephemeral ports — frequent, high-value, easily verified); per-host limits silently serializing; keep-alive both ends.
- **Deployment**: multi-process multiplies; **serverless inverts advice** (concurrency → connection count; external pooler usually required); autoscaled → size against *max* replicas; external pooler modes (transaction pooling restricts session prepared statements/`SET`/advisory locks/`LISTEN`/`NOTIFY`).

### Async and blocking
- **What async does/doesn't**: serves many I/O-bound ops on one thread; doesn't speed individual ops, help CPU-bound work, add parallelism in single-threaded runtimes, or remove the need for bounds. "Make it async" = cargo cult without a mechanism (path I/O-bound, workers the constraint).
- **Critical finding — blocking in an async context**: stalls the executor; a single-threaded event loop stalls *everything*, incl. health checks. Missed blockers: sync datastore/HTTP clients in async handlers (identical at the call site); DNS; fs I/O incl. file logging; password hashing/kdf; compression/image/PDF; large JSON; catastrophic regex; sync `sleep`. Fix: async variant, or offload to a **bounded** pool — unbounded offload swaps a stall for exhaustion. Scoring: blast `system-wide` single-threaded, `High` confidence.
- **Partial/accidental async**: async that never awaits; sequential awaits of independent calls (win only if independent + downstream absorbs); fire-and-forget never-awaited tasks (errors vanish; lost at shutdown); unbounded task spawning; sync/async bridges.
- **Background work**: deferring improves user-perceived latency, not capacity — say which; separate processes move load (delivery guarantee); background sharing a request pool can starve it; per-request tasks with no coalescing exceed foreground work.
- **Cancellation**: does work stop on disconnect/timeout? Uncancelled work is pure waste, worst at overload (slow→timeout→retry spiral with abandoned work still consuming capacity). Check propagation to datastore/outbound.

### Serialization
- **Matters when**: large payloads; high-frequency cheap paths; serialize/parse > once per request; per-item; single-threaded event loop (cost = stall). On I/O-bound paths a faster serializer is a false positive without a profile. Establish payload size first.
- **Costs**: serializing discarded data; double work (parse→model→serialize unchanged — proxies/middleware); per-item serializer instantiation; validation separate from parsing; defensive deep copies; reflection in hot loops; **logging serialized payloads** (costs as much as returning them). Double/discarded work is removable, not just optimizable.
- **Formats** (neutral): text = debuggable, larger, costlier, loose evolution; binary/schema = smaller/cheaper, enforced evolution, build-step cost. Migration is a large change — only with evidence; state cost.
- **Streaming vs buffering**: buffering makes memory ∝ response size, delays first byte, holds memory for slow clients; streaming costs harder error handling + content-length/compression complications. For large exports/downloads buffering is a genuine finding.
- **Compression**: CPU for bytes; worth it for large compressible payloads over constrained links; wasteful on small/already-compressed and fast internal links.

### Datastores — universal
**Classify first** — category decides which access patterns are cheap:

| Category | Optimized for | Typically expensive |
|:--|:--|:--|
| Relational | Flexible querying, joins, transactional consistency | Very high write rates on one node; unbounded scans |
| Document | Whole-aggregate retrieval by key/indexed field | Cross-document joins; queries the shape didn't anticipate |
| Key-value | Point access by key | Anything not by key |
| Wide-column | High-volume writes; queries along partition/clustering key | Ad-hoc queries; cross-partition scans |
| Graph | Relationship traversal from a start point | Global scans; unbounded-depth traversal |
| Search | Ranked text, faceted retrieval | As system of record; frequent per-doc updates |
| Time-series | Append-heavy writes; time-range queries | High-cardinality dimensions; non-time queries |
| Vector | Approximate nearest-neighbour | Exact search at scale; heavy filter+search |
| Object store | Large immutable blobs | Small-object patterns; transactional anything |

**Used against its category's grain = design finding, not tuning finding.** Unrecognized engine → infer category, apply category principles, mark engine specifics unknown.

**Universal questions** (in order): how much data does the op *touch* (examined vs returned — the ratio is the most useful plan signal)? Is the touched amount bounded (key/index/limit/partition/time)? How many round trips (1×100-row ≠ 100×1-row)? What does the pattern do to the write path (every index/replica/durability guarantee costs writes)? What is shared (connections, cache memory, locks, I/O, single writer)?

**Indexes are a trade, always** — costs: write maintenance, storage/cache memory, build time/locking, planner options. Justified: high-selectivity predicate on unindexed field; sort matching no index; repeated join/lookup key. Not: tiny table, unselective predicate, covered prefix, rare query. **Index proliferation is a real failure mode** — "which indexes are unused" beats "which to add". **Selectivity/cardinality**: low-cardinality fields rarely warrant indexes; compound leading field decides usability (`(a,b)` serves `a` and `a+b`, not `b` alone); high-cardinality dimensions break time-series/metric labels; hot low-cardinality partition keys.

**Working set**: repeatedly-touched data in memory = fast regardless of storage; just-outgrown = sudden sharp degradation with no code change; narrower selects + data-avoiding indexes shrink the working set; one large scan can evict it and slow everything (why unthrottled analytics on a primary is shared-resource). Growth degrades in *steps* at memory boundaries.

**Writes/durability**: durability waits bound latency; write amplification (journal/index/compaction); background maintenance causes periodic spikes invisible in code; replicas trade consistency for read capacity (read-after-write lag); failover/leader election are latency events.

**Transactions/contention**: longer txs hold locks longer; stricter isolation trades throughput for consistency; retry-based concurrency control wastes work non-linearly under contention; **a single hot row/key/partition serializes everything touching it** — unsolvable by adding capacity.

**Evidence from any engine**: query plan; executed plan with actual counts; slow-op log; index-usage stats; connection/lock views; cache hit stats. Plan-only is generally safe on production; executing isn't for side-effecting statements. No evidence → observability finding capping the section's confidence.

### Datastore categories — distinctive checks
- **Relational**: the planner decides (perf change with no code change = plan change); stats drive estimates. Plan signals: scan where a predicate should narrow → missing/unusable index; examined ≫ returned → poor selectivity; estimate ≫ actual → stale stats; nested loop over large outer; sort where index supplies order; spill to disk. Index-defeating predicates (function on column, implicit cast, leading wildcard, `OR` across columns — findable from source). Patterns: `SELECT *`; deep offset; exact counts of big tables; cartesian from multiple 1-to-many joins; huge `IN`; `DISTINCT` compensating a row-multiplying join. Locking: tx over network call; long-running txs (block MVCC cleanup — whole-DB); inconsistent lock ordering → deadlocks; row hot spots; idle-in-transaction. **Unbounded tables with no retention = most common relational scalability risk.**
- **Document**: doc shape decides which queries are efficient — look at documents before queries. **Unbounded embedded arrays** (comments/events/order lines) = reliably severe: doc grows unbounded, every update rewrites a growing doc, every read transfers it all, eventual size-limit outage. Over-referencing → app-side joins (N+1 from the data model). Projection = biggest avoidable cost; atomic field updates vs read-modify-write (+ lost-update hazard). Nested-index paths must match exactly; array indexes write per element; flexible schemas invite index proliferation. Bad patterns: unindexed predicates; leading-wildcard text; deep offset; aggregation filtering late; app-side joins in a loop; queries the design never anticipated (design finding).
- **Key-value**: key design is the data model — keys constructible by the caller; composite keys enable prefix grouping; key size matters. **Access not by key = finding** (scanning, keyspace iteration, hand-maintained secondary indexes); iteration primitives are for maintenance. Large values (transfer + memory); serialized blobs force RMW (+ race); unbounded collection values. **Round trips dominate** — per-key ops in a loop is the characteristic bug; RMW = 2 round trips + race. Eviction: what happens when full (evict/reject/fail); TTL-less entries accumulate. Single-threaded semantics: one expensive command blocks every client. Skew: effective capacity = busiest node; monotonic keys concentrate writes. Durable-intended but configured otherwise = correctness finding.
- **Wide-column**: LSM storage — sequential writes; compaction is a periodic real cost; **deletes/updates are appends** (tombstones → read amplification until GC). Partition-oriented: partition key is the whole data model (query without it = rejected or cluster scan); clustering key sets on-disk order; **unbounded partitions** severe; secondary indexes usually wrong; consistency level is a direct checkable latency trade (do the RF arithmetic). Column-oriented analytical: cost ∝ columns+data read, not an index; physical order key is the primary lever; joins are the weak point; large batched inserts.
- **Graph**: index-free adjacency — traversal cost scales with the subgraph touched, not graph size. **Traversal depth is the dominant cost**; unbounded depth = cliff. **Supernodes** (huge-degree nodes) = graph hot-key. Bad shapes: cartesian products of independent patterns; traversing before filtering; returning whole nodes for few properties; counting by collecting; repeated identical sub-traversals; undirected traversal where direction known. Modeling is the primary lever: node vs property; relationship granularity; precomputed relationships. Long txs + global uniqueness constraints are whole-graph.
- **Search**: inverted index; ranking isn't free. **Filter context vs query context is the single highest-value distinction** — non-ranking filters in filter context (cacheable, unscored). **Deep pagination is worst here** — offset requires rank+skip; search-after/cursor with stable sort; scroll only for export. Mapping decided at index time is hard to undo: analyzed vs exact fields not interchangeable; nested structures change what queries can ask. Aggregations consume memory, not just CPU (approximate = standard). Per-write forced refresh is a bottleneck; more smaller segments = more per-query work. Returning full docs when few fields needed; leading-wildcard patterns bypass index efficiency. Sharding is an early capacity decision: too many small shards multiply overhead; too few oversized limit parallelism.
- **Time-series**: **time is the partition key** — narrow time bounds touch few chunks; no bound (or full-retention bound) touches everything. **Series cardinality is the defining failure mode** (distinct label/tag combinations; high-cardinality dimensions multiply structures — the classic "fails for no reason", usually created at schema time). Retention/downsampling: growth is the default; no retention = unbounded storage. Writes are optimized for append-in-time-order; out-of-order/broad writes expensive.
- **Vector**: **ANN is the mechanism; recall/latency/memory is the trade**. **Filter+search is the most common severe failure mode**: filter-then-search (correct but may scan nothing); search-then-filter (top-K then discard = silently <K results under selective filters — a correctness bug). Dimensionality is a cost multiplier fixed by the embedding model. ANN structures are memory-resident — not fitting = spill/degrade. Index build is expensive; incremental vs rebuild trades. Distance metric is a modeling fact, not a knob.
- **Object store**: **request count, not data volume, dominates cost** — loop-one-at-a-time where batch primitives exist. Key/prefix design is the only access structure. **Objects immutable — every update is a full replacement**. Large objects need multipart (a hard size limit). Listing doesn't scale like point lookup, filters only by prefix — broad/unbounded listing to find something = object-store N+1 ("belongs in a different store"). Request/egress cost are first-class; same large object served repeatedly with no cache/CDN; storage-tier mismatch. Read-after-write consistency is engine/op-specific — confirm.

### Distributed
**Timeouts and deadlines** — the most commonly missing performance control; leading cause of tail latency and cascading failure. Strong findings: visible in config, workload-independent (no cap), typically system-wide. A hung dependency holds worker slot/connection/memory indefinitely → local exhaustion → failure for *every* request — one degraded dependency takes down an unrelated system. Defaults are usually absent or very large. **Timeouts are plural**: connection; TLS handshake; read/socket (**the common gap: connected then silent**); total incl. retries; idle; server read/write/header; datastore statement; lock acquisition; pool acquisition. Per-attempt × retry count = worst case. **Deadline propagation**: each hop's timeout < caller's remaining budget; **inverted budgets** (inner > outer) = checkable config inconsistency, `High`. Values come from observed latency distribution, not intuition: too short → healthy slow requests fail + retry amplification; too long → no protection. Recommend the *presence* of a timeout (unambiguously right) over a specific value. **Cancellation**: a timeout without cancelling underlying work saves the caller, not the system; check end-to-end incl. client disconnects.

**Retries and backpressure** — retries help transient failures, destroy systems during sustained ones. **Retries amplify load exactly when capacity is lowest**; compounds with depth (4-layer × 3 retries = multiples at the bottom). Evaluate per whole chain. Config: attempt cap; backoff; exponential growth; **jitter — most commonly missing** (retries synchronize into waves); total budget; retryable-condition filter (**retrying non-retryable failures** — validation/auth/not-found; "retry on any exception" = finding); idempotency (retries on non-idempotent ops without idempotency keys = correctness finding surfaced by perf review); retry budget/circuit breaker (any ceiling?). Breakers fail fast after a threshold; costs = threshold tuning/half-open probing. Retry budgets cap retries as a fraction of total — simpler, smoother. **Backpressure** absence: unbounded in-memory queues; no admission control (accept-then-queue work nobody reads); consumers fetching more than processable (redelivery under overload). **Fast rejection beats slow acceptance.** Load shedding: reject a fraction (background over interactive, retried over first-attempt). **Queues**: consumer throughput must exceed producer rate (lag = primary health metric; absence from monitoring = finding); partition count bounds consumer parallelism; key skew; poison messages need DLQ + attempt cap; batch/prefetch sizes trade throughput vs redelivery/memory; strict per-key ordering = one consumer per key. Fan-out multiplies load and failure surface; no concurrency bound = unbounded; fan-out to a shared downstream = burst.

**Caching** — the most over-recommended optimization. Cache is step 5 of 6 — confirm remove/bound/move/cheapen first (a cache in front of an N+1 preserves it + adds invalidation). **Five questions a cache recommendation must answer** (missing one = incomplete): (1) **Hit rate** — why requested again? Repeated-within-lifetime data caches well; per-user-per-session doesn't; keyspace ≫ cache thrashes. Unprovable reuse → don't recommend; plausible-unproven → measure hit rate first. (2) **Invalidation** — TTL only (legitimate — state acceptable staleness and to whom); explicit on write (every write path must know every derived key — enumerate and check each); write-through; versioned keys; event-driven. (3) **Granularity** — too coarse invalidates mostly-valid data; too fine kills hit rate; wrong dimension (per-user key for shared data — split shared/personalized). (4) **Stampede** — popular key expires → all concurrent requests recompute (can exceed uncached load). Mitigations: single-flight, serve-stale-while-refresh, jittered TTLs, proactive refresh. **Uniform TTLs set together expire together** — synchronized stampede after deploys. (5) **Consistency** — who tolerates stale data? Read-after-write is the sharp case. Layers: in-process (one instance; **no size limit = memory leak with a friendly name**); shared remote (round trip per access); client/HTTP (invalidation impossible once served); CDN (cheapest hits, hardest invalidation); datastore internal. Reviewing existing caches: hit rate measured? TTL justified? every write path invalidating every derived key? size bound + eviction? behavior when unavailable (degrade to a slow path that carries full load)? anything cached that shouldn't be (per-user under shared key; user-visible staleness; data the datastore answers in microseconds)? Negative caching needs shorter TTL than positive. **Cache as system of record = data-loss risk** (correctness). Don't claim hit rate/speedup unmeasured; don't recommend a distributed cache where a bounded in-process cache suffices.

**Multi-tenancy** — only when one deployment serves multiple customers/accounts that don't trust each other (tenant/account/org discriminator, subdomain/path routing, shared pool). New question: **whose workload is this, and can one tenant's workload degrade another's?** Isolation model: **silo** (separate DB/deployment — noisy-neighbor findings mostly don't apply); **pool** (shared DB, tenant column — almost everything applies); **bridge** (shared hardware, tenant schema — contention at infra layer); **shared-everything** by FK (weakest). No discriminator = not multi-tenant — gate it out. **Noisy neighbors**: one tenant's spike/inefficient query/large data consumes a disproportionate share of a shared resource, degrading all tenants. Blast framing: "this tenant makes every other tenant slow". Vectors: pool exhaustion by one tenant's burst; unindexed/unbounded query saturating shared DB; shared cache without per-tenant sizing (one large tenant evicts everyone); background jobs sharing request workers; a single hot tenant when the partition key *is* the tenant. **Fairness/admission-control presence is the highest-value check** (rate limits, per-tenant caps, quotas, fair-share, per-tenant breakers); none = no isolation regardless of data model — report as root cause, not N symptoms. (Rate limits/quotas are where "consider adding X" isn't automatically cargo cult — but `Conditions` must state the at-risk resource and traffic shape.) Data-model: unindexed tenant discriminator → every tenant-scoped query scans others' rows (cost ∝ *total* data); **tenant size skew** (median-designed schema fails non-linearly at outliers); schema/DB-per-tenant multiplies pool arithmetic and migration cost; cross-tenant reporting must be isolated from serving. Cost attribution: per-tenant visibility; pricing assuming uniform tenant cost.

### Infrastructure
Containers/orchestration/autoscaling/serverless. **Core check: does the runtime's configured behavior fit inside the enforced limit?** Heap/cache vs container memory (mismatch → killed, not GC'd — abrupt, nothing in the log); workers × per-worker memory vs limit; runtime parallelism vs CPU quota (throttling); pool × workers × max replicas vs datastore limit; connections vs fd limit. All inputs usually in the repo → `High`, no runtime data. **Do this arithmetic in every containerized review.** CPU vs memory limits: exceeding CPU quota = throttling (**p99 spikes with unremarkable average CPU** — invisible to mean-utilization dashboards); exceeding memory usually = termination (restart with no app explanation). Requests vs limits: none set = scheduling/starving; request=limit = predictable but no headroom; limit≫request = throttling correlated with unrelated workloads. **Autoscaling**: size connections against the *maximum*; CPU-based autoscaling misses real constraints (pools/event loops/queue depth — CPU stays low while requests queue); scale-up isn't instant; scale-down drops in-flight work without graceful shutdown; aggressive down/up = constant cold starts. **Probes**: readiness checking only process-alive lets traffic hit cold instances; liveness failing under load restarts a busy instance and cascades; probes doing real work are load; startup work delays readiness. **Topology**: cross-zone/region hops add latency + cost (structural floor); sidecars add per-hop cost; LB algorithm matters under uneven service times; connection pinning (HTTP/2/gRPC) concentrates load after scale-up; DNS TTL/caching delays discovering instances. **Serverless inverts advice**: cold starts (drivers in repo: package size, dependencies, module-scope work, runtime); connections don't pool (concurrency → connection count; external pooler or connection-per-environment reuse); **state initialized outside the handler persists** — init inside the handler pays setup per invocation (checkable); concurrency limits cap throughput; **billing by duration and memory** — slow code costs directly, and memory allocation often sets CPU allocation, so *raising* memory can cut total cost. Storage: ephemeral exhaustion is abrupt; network storage has throttled IOPS (looks like a DB problem); log volume = disk + network + cost.

### Runtimes — universal taxonomy
Classify, and failure modes follow (per-runtime notes below; otherwise taxonomy + honest unknowns is correct):
- **Execution model**: interpreted / bytecode-with-JIT / compiled-AOT. JIT slow until warm (cold-start + tail; bad with aggressive autoscaling); interpreted higher constant per-op cost (hot loops only); compiled predictable from request one.
- **Parallelism**: multiple cores in one process? No → spread across processes or offload; per-process memory multiplies.
- **Concurrency model**: what happens when work blocks, and how many units exist.
- **Memory management**: tracing GC (pauses = whole-process tail event; **allocation rate matters as much as retained size** — reducing garbage on hot paths usually beats tuning the collector; heap size trades pause frequency vs duration; **heap must fit under the container limit** with room for non-heap; GC shows at p99, never averages); refcounting (spread costs, cycles); ownership/manual (no pauses; allocator contention).
- **Startup cost**: process start, dependency loading, framework init, connections, JIT warmup, at-boot migrations. Dominant serverless/aggressive-autoscaling; irrelevant long-lived.
- **Threads/stacks**: OS threads reserve stack; context switching rises with count; lightweight concurrency reduces per-unit cost, not the need for bounds; pool sizing: CPU-bound ≈ parallelism, I/O-bound = more (bounded downstream).
- **Container-awareness**: does the runtime see the container's quota/memory or the host's? Older versions often don't — record the **version**.
- **Profiling**: prefer attach-without-restart tools (Python `py-spy`; Node event-loop lag first; Go pprof often compiled in; JVM JFR; .NET `dotnet-counters`/`dotnet-trace`; Rust `perf`/flamegraph).

### Per-technology checks (condensed)
- **PostgreSQL**: MVCC dead rows → bloat; **a long-running or idle-in-transaction session blocks cleanup globally** (most Postgres-specific failure mode, invisible in app code); update-heavy tables need more aggressive autovacuum; index-only scans need vacuum-maintained visibility maps; TOAST — `SELECT *` on large text/JSONB pays de-TOASTing; connections are process-backed; **`work_mem` is per operation, not per connection** — raise per session/role. Check: whole DB gradually slowing → bloat from ineffective autovacuum (often idle-in-transaction); fast-then-slow overnight → plan flip; index unused → type mismatch/function/`LIKE '%...'`/low selectivity/stale stats. Key config: `shared_buffers`/`effective_cache_size`/`work_mem`/`random_page_cost`; **`statement_timeout` + `idle_in_transaction_session_timeout` + `lock_timeout` — cheap high-value defenses, unset in most deployments**; `jit`; `synchronous_commit` (data-loss trade). Diagnostics: `pg_stat_statements`, `EXPLAIN (ANALYZE, BUFFERS)`, `pg_stat_activity`. Poolers: transaction pooling restricts session prepared statements/`SET`/advisory locks/`LISTEN`/`NOTIFY`.
- **MySQL/MariaDB**: **InnoDB = clustered index by primary key** — secondary indexes store the PK, needing a second clustered lookup unless the index **covers** the query. **PK choice matters**: auto-increment appends; random keys (UUID/hash) force page splits on nearly every insert — fix = surrogate auto-increment PK + UUID as unique secondary index. **`REPEATABLE READ` default uses gap/next-key locking** — range updates lock gaps, causing "inexplicable" deadlocks; `READ COMMITTED` is a real trade. Buffer pool conventionally **70–80% of RAM on a dedicated host**. **Query cache (≤5.7) is a write-scalability hazard** — disable. Check: insert throughput down + size growing faster than rows → random PK; secondary query slower than selectivity → non-covering index. Key config: `innodb_buffer_pool_size`, `innodb_flush_log_at_trx_commit` (`0`/`2` = data-loss trade), isolation. **Record storage engine per table** — a MyISAM table on a write-heavy/transactional path is correctness-adjacent; MariaDB ≠ MySQL.
- **Redis**: **command execution effectively single-threaded** — one slow command blocks every client on every path; latency coupled across users (`system-wide`); app concurrency doesn't help. Find size-scaling commands (keyspace iteration, whole-large-collection ops, sorts, deleting huge structures, looping scripts) → incremental/bounded variants. Data structures are the point — opaque-string use forces RMW cycles native structures do atomically; unbounded structures = memory risk. Persistence has periodic costs (snapshot forks — "occasional inexplicable spikes"). Eviction policy decides whether it's a cache — a cache that *rejects* writes turns misses into errors. Cluster: multi-key ops need one slot; hash tags reintroduce hot-slot risk. Check: app-wide spikes → slow command or fork; write errors → `maxmemory` + non-evicting policy; cache not helping → low hit rate (`keyspace_hits` vs `misses`). Key config: `maxmemory` (**= container limit is a common misconfiguration** — needs headroom for buffers + fork); `maxmemory-policy` (`noeviction` right for durable data, wrong for caches); persistence + `appendfsync`.
- **MongoDB**: aggregation optimizer — stage order matters: `$match` early (first, index-served); `$project`/`$unset` early; `$sort` before `$limit` can stop early; **`$lookup` is expensive** (runs per input doc — filter before it); `$unwind` multiplies docs; once a stage blocks index use, nothing later recovers it. Sort has a hard memory limit (unindexed sort fails at scale). Storage-engine cache = working set — **outgrowing it degrades sharply**. Write concern/read concern/preference are explicit durability/consistency/latency dials (default write concern → majority in 5.0). Check: sort error at scale; aggregation slow → `$lookup`/`$unwind` before `$match`; `COLLSCAN` → no usable index; stale reads → secondary preference + lag. Key config: cache vs container, write concern, read preference/concern, `retryWrites`, `allowDiskUse` (usually signals a missing index), shard key (monotonic keys concentrate writes).
- **DynamoDB**: partition key determines physical throughput — hot/skewed partition throttles below aggregate capacity (Contributor Insights). **Query cheap; Scan charges per item examined.** A GSI has its own capacity and **its throttling propagates back to base-table writes**. Consistency per read: eventual costs half; strong only on base table/primary region, **never on a GSI**. **400 KB item size limit is a hard cap** (large payloads → S3 + pointer). **TTL deletion is best-effort** (background, up to ~48h). DAX = write-through cache with its own consistency window. LSI-backed patterns can hit the **10 GB per-partition-key limit**. Key config: capacity mode (Provisioned+autoscaling vs On-Demand), GSI capacity vs base, per-read consistency, DAX, TTL.
- **Elasticsearch/OpenSearch**: **circuit breakers make memory-exhaustion a named mechanism** — read which tripped (request/fielddata/parent). **Heap trades against the OS page cache Lucene depends on**. Storage layers: `_source` (original JSON), doc values (columnar, powers sort/agg without fielddata), stored fields (opt-in). Deep pagination: `scroll` (export only), `search_after` (needs stable unique sort), **PIT + `search_after` (recommended)**. Bulk API has its own queue — 429 = saturating it (`_cat/thread_pool`). Check: `CircuitBreakingException` → named breaker; steady degradation → segments outpacing merges or shard/node mismatch; deep-pagination error → `index.max_result_window`; slow aggregation → doc values disabled. Key config: heap vs node RAM, `refresh_interval`, shards/replicas, `index.max_result_window`, breaker limits, node roles. OpenSearch forked from ES 7.10.2 (2021) — confirm which.
- **Kafka**: **consumer-group rebalancing** = mechanism behind partition-bounded parallelism — group-wide collapse = rebalance storms; check `max.poll.interval.ms` being exceeded and protocol (eager vs **cooperative sticky** KIP-429 since 2.4; static membership KIP-345 avoids rebalances on restart). **Retention is time/size-based and independent of consumption — Kafka is a log, not a queue** (changelog topics need log compaction). Producer `acks` = durability/latency trade (`0`/`1` risk loss — check `min.insync.replicas` + RF); idempotent producers default in 3.0. **Raising partition count breaks key→partition assignment**. Check: group-wide collapse → rebalances; disk climbing → retention vs write rate; aggregate lag healthy but keys stale → key skew (per-partition lag). Key config: `acks`, `linger.ms`/`batch.size`, `max.poll.records`/`max.poll.interval.ms`, retention vs compaction, partition count (size up front). KRaft (no ZooKeeper) default 4.0.
- **Cassandra/ScyllaDB**: compaction strategy is workload-specific — STCS (default; read amplification grows), LCS (bounded reads, more write I/O), TWCS (time-series). **Tombstones have engine thresholds** — partition reads over `tombstone_failure_threshold` fail; tombstones persist until GC after `gc_grace_seconds` (deleted data reappears if repair missed the window). Read repair + hinted handoff trade consistency for background work. **LWTs are Paxos and Paxos is expensive**. `ALLOW FILTERING` and secondary indexes = checkable CQL red flags. **`BATCH` isn't a cross-partition optimization**. Scylla changes the resource story (shard-per-core, no JVM pauses) — confirm which. Check: tombstone rejection; intermittent read spikes → read repair or (Cassandra) GC pause; write timeouts → compaction falling behind; steady read worsening → compaction mismatch. Key config: compaction strategy, `gc_grace_seconds`, consistency vs RF, driver retry, token-aware vs round-robin LB, heap/GC (Cassandra).
- **RabbitMQ**: **a backed-up queue can trigger a cluster-wide memory alarm stalling every publisher**. **A single queue is not partitioned — the queue (one Erlang process) is its own throughput ceiling**; more consumers add nothing. Exchange routing has publish-time cost (broad topics multiply it). **Prefetch (`basic.qos`) is the throughput/fairness knob**: too high → one consumer hoards unacked messages; too low (1) → a round trip per message. **Manual ack is the durability control — a consumer that never acks/nacks is a checkable bug shape**. **`consumer_timeout` closes the channel outright**. Dead letters accumulate when the DLX queue has no consumer. Key config: prefetch; queue type (classic vs **quorum** [Raft — classic mirroring deprecated, removed in 4.0] vs **streams** [log-like, 3.9+]); `vm_memory_high_watermark`.
- **Node.js**: **event loop has phases** — timer/microtask floods starve other phases. The **libuv thread pool is small (default 4) and shared** — fs, crypto, DNS, zlib compete; fs/crypto endpoints slowing together = pool exhaustion (raise `UV_THREADPOOL_SIZE` deliberately). **Parallelism is an explicit architectural choice** — `cluster` or `worker_threads` for CPU offload. GC default ceiling `--max-old-space-size` vs container limit. Check: latency spikes with large bodies → sync `JSON.parse`/`stringify`; busy but unresponsive → recursive `process.nextTick`/unbounded promise chain; slow steady leak → closure/listener capturing request data in a long-lived cache. Key config: `UV_THREADPOOL_SIZE`, `--max-old-space-size`, `http.Agent` keepAlive/maxSockets.
- **Python (CPython)**: **the GIL is the mechanism behind the parallelism dimension** — threads give no CPU parallelism for pure Python ("added threads, no speedup" is expected); threads do give I/O concurrency (GIL released during I/O); CPU parallelism needs separate processes. **Refcounting is primary reclamation, not just generational GC** — the cycle collector walks large object graphs (periodic spikes with interlinked objects). **Monkey-patched cooperative concurrency (gevent/eventlet) fails on unpatched blocking dependencies**. ASGI: one loop = one core; a sync blocking call (sync DB driver, `requests`, `sleep`) inside `async def` stalls the loop. Key config: worker count (memory multiplies per process); worker class (sync/gthread/gevent/ASGI — changes blocking-correctness codebase-wide). 3.13 experimental free-threaded build (opt-in); PyPy = different GIL/memory model.
- **Go**: **goroutines give cheap concurrency *and* real parallelism** — but a CPU-bound goroutine in a tight loop with no calls/channel ops can starve others (pre-1.14 only). **Nothing bounds goroutine count** — per-request spawning without a worker pool is unbounded concurrency; **goroutine leaks are Go's most distinctive growth pattern** (channel op with no cancellation path; count climbs steadily). **`GOMAXPROCS` defaults to host CPU count — checkable container-mismatch risk** (throttling under quota; fix = `uber-go/automaxprocs`). GC: **`GOGC` (default 100) sets allowed heap growth — collection frequency driven by allocation rate**; `GOMEMLIMIT` (1.19+, soft) for fixed container limits. Escape analysis decides stack vs heap (`go build -gcflags="-m"`). Key config: `GOMAXPROCS`, `GOGC`, `GOMEMLIMIT`, worker-pool/semaphore bound.
- **JVM (Java/Kotlin)**: **the concurrency model changes the severity of the identical blocking call** — thread-per-request (blocking = capacity cost); reactive (WebFlux/Vert.x: blocking on the event-loop thread stalls unrelated requests); virtual threads (JDK 21+; `synchronized` can pin the carrier thread). **Warm-up is a first-class dimension** — worse latency in the first minutes after deploy is expected; JVM fits short-lived contexts poorly (GraalVM native image removes warm-up). **GC is a chosen trade-off**: Parallel (throughput, long pauses) vs G1 (default since JDK 9) vs ZGC/Shenandoah (latency). **Off-heap memory is invisible to heap-only monitoring**: OOM with healthy heap = metaspace growth (proxy/class generation), direct buffers, or thread stacks from an unbounded pool. Key config: heap vs container limit (**pre-8u191/JDK 10 the JVM ignored cgroup limits**), collector, thread-pool sizes. Kotlin coroutines sit on the JVM thread model — a `Dispatcher` running blocking work on a non-blocking dispatcher reproduces the event-loop finding.
- **.NET (CLR)**: **thread-pool starvation from sync-over-async is the core concurrency failure mode** (`.Result`, `.Wait()`, `.GetAwaiter().GetResult()` → progressive degradation; check `dotnet-counters` pool queue length); the sync-over-async deadlock needs a captured `SynchronizationContext` — less likely under ASP.NET Core (none installed by default). **Value types avoid allocation and GC pressure until boxed** (interface parameter, non-generic collection → elevated Gen0). Server GC (ASP.NET Core default) vs Workstation GC; container awareness since .NET Core 3.0, absent in legacy .NET Framework. **Native AOT trades JIT/warm-up for compile-time constraints** — production-stable .NET 7–8. Key config: Server vs Workstation GC, `ThreadPool.SetMinThreads` (lever against starvation), Native AOT vs JIT.
- **Rust**: **no GC — but reference cycles still leak** (`Rc`/`Arc` cycles never reclaimed; use `Weak`). **Async depends entirely on the chosen runtime — none ships in std**; a sync/blocking-I/O call inside `async fn` never moved to `spawn_blocking` stalls that runtime's tasks (whole service stops on a single-threaded `current_thread` runtime — confirm the flavor). **Static dispatch is default; pervasive `dyn Trait` in hot loops is slower**. No JIT = no warm-up; allocator is a swappable choice. Check: one worker's tasks stalling → blocking call not offloaded; steady heap growth with `Rc`/`Arc` → reference cycle; high contention "despite async" → coarse `Arc<Mutex<T>>`; benchmarks far worse than expected → confirm `--release`. Key config: Cargo release profile (`opt-level`, LTO, `codegen-units`), Tokio worker count, `spawn_blocking` pool size, allocator. `async fn` in traits ~1.75 (async-trait boxing may carry unnecessary dynamic dispatch).

## Anti-patterns in Your Own Output

- A finding with an empty or hand-waved `Conditions` field.
- A recommendation with no validation path.
- "Consider adding caching" with no hit-rate/invalidation/staleness analysis.
- Reporting a micro-optimization off the critical path above a shared-resource saturation on it.
- Any number you did not read from a file or receive from the user.
- A long report that avoids saying "I don't know".
- Self-check per finding: point at the line? all four severity factors written? `Conditions` confirmable? priority matches the matrix? would you still report it if scored on false positives?

## Appendix — Quick recipe: latency instrumentation and slow-endpoint triage (folded in from backend-latency-profiler-helper)

> 快速配方入口（并入自 backend-latency-profiler-helper，2026-09-07）：先用下方中间件埋点找出慢请求，再用 SQL 从请求日志初筛 Top 慢端点，按 PerformanceBottleneck 模板整理疑似原因与修复优先级，最后套用三周修复路线图。轻量、直觉优先的入口；需要严谨证据化结论时走上方方法论正文。
> Quick-recipe entry (folded in from backend-latency-profiler-helper, 2026-09-07): instrument slow requests with the middleware below, triage top slow endpoints from request logs via SQL, organize suspected causes with the PerformanceBottleneck template, then follow the three-week fix roadmap. A light, intuition-first entry — use the methodology above for evidence-based conclusions.

Find and fix API performance bottlenecks.

### Slow Endpoint Detection

```typescript
// Middleware to track latency
app.use((req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;

    if (duration > 1000) {
      logger.warn(
        {
          endpoint: req.path,
          method: req.method,
          duration_ms: duration,
          userId: req.user?.id,
        },
        "Slow request detected"
      );
    }
  });

  next();
});
```

### Top Slow Endpoints

```sql
-- Query from logs
SELECT
  endpoint,
  AVG(duration_ms) as avg_ms,
  MAX(duration_ms) as max_ms,
  COUNT(*) as requests
FROM request_logs
WHERE created_at > NOW() - INTERVAL '1 day'
GROUP BY endpoint
HAVING AVG(duration_ms) > 500
ORDER BY avg_ms DESC
LIMIT 10;
```

### Suspected Causes

```typescript
interface PerformanceBottleneck {
  endpoint: string;
  avgLatency: number;
  suspectedCauses: string[];
  fixPriority: "high" | "medium" | "low";
}

const bottlenecks: PerformanceBottleneck[] = [
  {
    endpoint: "GET /api/users/:id",
    avgLatency: 2500,
    suspectedCauses: [
      "N+1 query fetching user orders",
      "No database index on user_id",
      "Expensive JSON serialization",
    ],
    fixPriority: "high",
  },
];
```

### Fix Roadmap

```markdown
# Performance Fix Roadmap

## Week 1: Quick Wins

- [ ] Add database indexes
- [ ] Enable response caching
- [ ] Fix N+1 queries

## Week 2: Medium Effort

- [ ] Optimize slow database queries
- [ ] Implement Redis caching
- [ ] Add connection pooling

## Week 3: Long-term

- [ ] Database query optimization
- [ ] Service decomposition
- [ ] CDN integration
```

### Output Checklist

- [ ] Slow endpoints identified
- [ ] Causes analyzed
- [ ] Fix roadmap created
- [ ] Monitoring configured

- Provenance: 并入自 patricio0312rev/skills（repo: https://github.com/patricio0312rev/skills，path: performance/backend-latency-profiler-helper）

## Provenance

- Source repo: https://github.com/Sanoy24/backend-performance-review
- Original path: skills/backend-performance-review
- License: MIT (declared in original SKILL.md frontmatter)
- 蒸馏说明：原含 51 文件（SKILL.md + 5 方法论 + 5 原则 + 5 应用层 + 9 数据库类别 + 1 运行时通用 + 4 分布式 + 1 基础设施 + 15 技术参考 + 报告模板 + registry + Python 加速脚本 detect_stack.py）。方法论/rubrics/报告模板/判定标准尽量高保真内联；各技术参考压缩为"机制要点 + 症状→原因 + 关键配置"精华，完整诊断命令表与逐版本差异见原仓库对应文件。registry 的 tier 语义与信号路由已改为正文分层指引。detect_stack.py 检测逻辑未内联，仅保留文档化行为与降级规则。原 frontmatter 的 when_to_use/license/compatibility/allowed-tools/metadata 已并入正文。
