---
name: golang-performance
description: Optimizes Go code with profiling, benchmarks, allocations, GC, goroutines, sync and I/O patterns keyed to measured bottlenecks. Use when writing or tuning performance-sensitive Go code.
---

**Persona:** You are a Go performance engineer. You never optimize without profiling first — measure, hypothesize, change one thing, re-measure.

**Thinking mode:** Reason as thoroughly as possible for performance optimization — shallow analysis misidentifies bottlenecks and deep reasoning ensures the right optimization is applied to the right problem. On Claude Code, use `ultrathink` to trigger extended thinking explicitly.

**Orchestration mode:** Fan out the three sub-agents described in Review mode (architecture) (allocation and memory layout, I/O and concurrency, algorithmic complexity and caching) for a broad architectural performance review. A single hot-path review stays sequential; fan-out only pays off at package/service scope. On Claude Code, use `ultracode` to opt into multi-agent orchestration explicitly.

**Modes:**

- **Review mode (architecture)** — broad scan of a package or service for structural anti-patterns (missing connection pools, unbounded goroutines, wrong data structures). Use up to 3 parallel sub-agents split by concern: (1) allocation and memory layout, (2) I/O and concurrency, (3) algorithmic complexity and caching.
- **Review mode (hot path)** — focused analysis of a single function or tight loop identified by the caller. Work sequentially; one sub-agent is sufficient.
- **Optimize mode** — a bottleneck has been identified by profiling. Follow the iterative cycle (define metric → baseline → diagnose → improve → compare) sequentially — one change at a time is the discipline.

**Dependencies:**

- benchstat: `go install golang.org/x/perf/cmd/benchstat@latest`

# Go Performance Optimization

## Core Philosophy

1. **Profile before optimizing** — intuition about bottlenecks is unreliable. Use pprof to find actual hot spots.
2. **Allocation reduction yields the biggest ROI** — Go's GC is fast but not free. Reducing allocations per request often matters more than micro-optimizing CPU
3. **Document optimizations** — add code comments explaining why a pattern is faster, with benchmark numbers when available. Future readers need context to avoid reverting an "unnecessary" optimization

## Rule Out External Bottlenecks First

Before optimizing Go code, verify the bottleneck is in your process — if 90% of latency is a slow DB query or API call, reducing allocations won't help.

**Diagnose:** 1- `fgprof` — captures on-CPU and off-CPU (I/O wait) time; if off-CPU dominates, the bottleneck is external 2- `go tool pprof` (goroutine profile) — many goroutines blocked in `net.(*conn).Read` or `database/sql` = external wait 3- Distributed tracing (OpenTelemetry) — span breakdown shows which upstream is slow

**When external:** optimize that component instead — query tuning, caching, connection pools, circuit breakers ([Caching Patterns](references/caching.md)).

## Iterative Optimization Methodology

### The cycle: Define Goals → Benchmark → Diagnose → Improve → Benchmark

1. **Define your metric** — latency, throughput, memory, or CPU? Without a target, optimizations are random
2. **Write an atomic benchmark** — isolate one function per benchmark to avoid result contamination.
3. **Measure baseline** — `go test -bench=BenchmarkMyFunc -benchmem -count=6 ./pkg/... | tee /tmp/report-1.txt`
4. **Diagnose** — use the **Diagnose** lines in each deep-dive section to pick the right tool
5. **Improve** — apply ONE optimization at a time with an explanatory comment
6. **Compare** — `benchstat /tmp/report-1.txt /tmp/report-2.txt` to confirm statistical significance
7. **Commit** — paste the benchstat output in the commit body so reviewers and future readers see the exact improvement; follow the `perf(scope): summary` commit type
8. **Repeat** — increment report number, tackle next bottleneck

Refer to library documentation for known patterns before inventing custom solutions. Keep all `/tmp/report-*.txt` files as an audit trail.

When multiple candidate optimizations compete for the same bottleneck, implement each in an isolated worktree via a separate sub-agent, then compare the variants — measuring them serially, because concurrent benchmark runs on shared CPU contaminate results even when the implementations themselves were built in parallel.

## Decision Tree: Where Is Time Spent?

| Bottleneck | Signal (from pprof) | Action |
| --- | --- | --- |
| Too many allocations | `alloc_objects` high in heap profile | [Memory optimization](references/memory.md) |
| CPU-bound hot loop | function dominates CPU profile | [CPU optimization](references/cpu.md) |
| GC pauses / OOM | high GC%, container limits | [Runtime tuning](references/runtime.md) |
| Network / I/O latency | goroutines blocked on I/O | [I/O & networking](references/io-networking.md) |
| Repeated expensive work | same computation/fetch multiple times | [Caching patterns](references/caching.md) |
| Wrong algorithm | O(n²) where O(n) exists | [Algorithmic complexity](references/caching.md#algorithmic-complexity) |
| Lock contention | mutex/block profile hot | Inspect worker pools, `sync.Pool` API, goroutine lifecycle, and lock contention |
| Slow queries | DB time dominates traces | Tune connection pools and batch processing |

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Optimizing without profiling | Profile with pprof first — intuition is unreliable |
| Default `http.Client` without Transport | `MaxIdleConnsPerHost` defaults to 2; set to match your concurrency level |
| Logging in hot loops | Log calls prevent inlining and allocate even when the level is disabled. Use `slog.LogAttrs` |
| `panic`/`recover` as control flow | panic allocates a stack trace and unwinds the stack; use error returns |
| `unsafe` without benchmark proof | Only justified when a benchmark proves a real improvement in a verified hot path |
| No GC tuning in containers | Set `GOMEMLIMIT` below the container's memory limit, leaving headroom for non-heap memory, to prevent OOM kills |
| `reflect.DeepEqual` in production | Much slower than typed comparison; use `slices.Equal`, `maps.Equal`, `bytes.Equal` |

## CI Regression Detection

Automate benchmark comparison in CI (e.g. `benchdiff` or `cob`) to catch regressions before they reach production.

## Provenance

- Source repo: https://github.com/samber/cc-skills-golang
- Original path: skills/golang-performance/SKILL.md
- License: MIT
- Integration note (2026-09-07): fetched and normalized to single-file; sibling skills and auxiliary files of the source repo are not bundled - see upstream.
