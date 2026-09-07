---
name: rust-performance-core
description: 'Use for core Rust performance optimization: profiling, benchmarking, Cargo profiles,
  allocations, copies, cache behavior, type sizes, bounds checks, inlining, hashing,
  iterators, I/O, logging overhead, and data layout.'
---

# rust-performance-core

> 蒸馏自 madebyhost/rust-performance-skills（skills/rust-performance-core）。原为多文件（含附属文档与 agent 元数据），已合并为单文件。
> Distilled from madebyhost/rust-performance-skills (skills/rust-performance-core); originally multi-file with auxiliary docs, now inlined as text.

## When to Use

Use this skill for **measured** Rust optimization — never optimize blind. Trigger on core Rust performance work: profiling, benchmarking, Cargo profile tuning, allocations, copies, cache behavior, type sizes, bounds checks, inlining, hashing, iterators, I/O, logging overhead, and data layout. Companion skills from the same repo cover adjacent territory: use the sibling skill `rust-memory-simd-io-performance` when allocator choice, SIMD, mmap, io_uring, huge pages, NUMA, or zero-copy byte layout dominates the change; use the sibling skill `rust-expert-rulebook` when choosing or reviewing one concrete optimization rule.

## Core Principles

- **Measurement first**: every change must be justified by evidence (benchmark, flamegraph, allocation profile, cache profile, tracing, or production telemetry) and re-verified with the same measurement afterward.
- **Algorithm and data-layout changes beat micro-optimizations**; prefer them before instruction-level tweaks.
- **Tradeoffs are explicit**: Cargo profile flags and other aggressive settings trade build time, debuggability, binary size, and runtime speed — do not apply them blindly.
- Prefer the smallest measured change that moves the metric.

## Workflow

1. **Establish the metric**: latency, throughput, CPU, memory, code size, or compile time.
2. **Identify evidence**: benchmark, flamegraph, allocation profile, cache profile, tracing, or production telemetry.
3. **Classify the bottleneck**: algorithm, data structure, allocation, copy, cache, lock, I/O, logging, serialization, or compiler profile.
4. **Apply the smallest measured change.**
5. **Re-run the same measurement** and report before/after.

### Measurement toolkit

- Use **Criterion** for statistical microbenchmarks.
- Use **flamegraphs or `perf`** for CPU hotspots.
- Use **heap profilers or allocation counters** for allocation pressure.
- Keep representative inputs and **release-mode builds**.

### Cargo profiles — inspect, don't assume

```toml
[profile.release]
opt-level = 3
lto = "thin"
codegen-units = 1
debug = "line-tables-only"
strip = "symbols"
```

These settings trade build time, debuggability, binary size, and runtime speed. Apply them only with build-time and debugging tradeoffs documented.

## Defaults

- Prefer algorithm/data-layout changes before micro-optimizations.
- Prefer iteration and slices over repeated indexed bounds checks in hot loops.
- Prefer preallocation and buffer reuse when sizes are known.
- Tune `profile.release` only with build-time and debugging tradeoffs documented.

## Hot Path Tactics

- Replace repeated indexing with iterators or slices when it removes bounds checks.
- Preallocate `Vec`, `String`, and buffers when bounds are known.
- Split hot and cold fields.
- Prefer contiguous data and predictable access patterns.
- Avoid formatting/logging in inner loops.
- Benchmark hashing choices for hash-heavy paths (default `HashMap` is not always the fastest for tiny or fixed key sets).

## Checklist

- [ ] Metric defined (latency / throughput / CPU / memory / code size / compile time) before starting
- [ ] Evidence gathered: benchmark, flamegraph, allocation profile, cache profile, tracing, or production telemetry
- [ ] Bottleneck classified (algorithm, data structure, allocation, copy, cache, lock, I/O, logging, serialization, compiler profile)
- [ ] Cargo profile inspected; any `profile.release` change documented with build-time/debug tradeoffs
- [ ] Hot loops use iterators/slices instead of repeated indexed bounds checks
- [ ] Preallocation / buffer reuse applied where sizes are known
- [ ] No `clone`, `to_string`, or `collect` inside hot loops
- [ ] No formatting/logging inside inner loops
- [ ] Hashing choice benchmarked for hash-heavy paths
- [ ] No `LinkedList` chosen for performance
- [ ] No `HashMap` for tiny fixed sets without benchmarking
- [ ] Smallest measured change applied, same measurement re-run
- [ ] Before/after numbers reported

## Red Flags

- Benchmarking in **debug mode**.
- Optimizing **without profiling**.
- `clone`, `to_string`, or `collect` inside hot loops.
- `HashMap` for tiny fixed sets.
- `LinkedList` for performance.
- Stripping symbols **before** profiling.

## Output Format

Report: bottleneck class, recommendation, applicable rule IDs, complexity cost, verification command, and expected measurement.

## Provenance

- Source repo: https://github.com/madebyhost/rust-performance-skills
- Original path: skills/rust-performance-core
- License: unknown — see repo
- 蒸馏说明：原含 3 文件（SKILL.md + 附属参考 performance-core.md + agents/openai.yaml agent 元数据）。附属参考已内联为 Measurement toolkit / Cargo profiles / Hot Path Tactics / Red Flags 章节；agent 元数据（display name、短描述、default prompt "Use $rust-performance-core to optimize this Rust hot path with measurement-first reasoning."）仅作触发说明，未逐字保留。相邻 skill（rust-memory-simd-io-performance、rust-expert-rulebook）仅以名称提及，其细节见原仓库。
