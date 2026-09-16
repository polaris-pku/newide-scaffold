---
name: swift-performance-engineering
description: 'Designs, generates, modifies, and reviews Swift and iOS code with performance as
  a first-class constraint: startup time, UI responsiveness, memory use, battery,
  throughput, concurrency. Use for Swift/SwiftUI/UIKit reviews and profiling follow-up.'
---

# swift-performance-engineering

> Distilled from codeanurag/swift-performance-engineering-Skill (repo root `.`); originally multi-file with auxiliary docs and metadata, now inlined as text.

## When to Use

Use this skill to shape Swift, SwiftUI, UIKit, and iOS code while it is being designed, generated, modified, or reviewed. Trigger whenever an agent is: writing new Swift or iOS code; modifying or refactoring Swift/SwiftUI/UIKit code; implementing latency- or launch-sensitive features; investigating UI hitches, startup issues, memory churn, or contention; or performing a performance-focused code review, profiling follow-up, startup analysis, rendering investigation, allocation analysis, or threading/contention diagnosis.

Optimize for lower CPU time, fewer allocations, tighter memory behavior, faster startup, less main-thread work, smoother rendering, and lower contention — without trading away correctness or maintainability.

Best fit: feed screens, timelines, lists, and grids; app launch and first-frame optimization; async image loading and caching; state-heavy SwiftUI views; UIKit screens with layout or scrolling pressure; async/await adoption and contention analysis.

## Working Mode

Start with the execution path the user cares about: launch, first render, scrolling, animation, networking, persistence, background work, or a specific regression. The skill is meant to stay active while code is written, changed, or reviewed.

Two modes:

- **Build mode**: when generating or modifying Swift code. Design the code to avoid predictable performance problems *before* they are introduced; incorporate the checklist into the implementation, not as a post-pass.
- **Review mode**: when auditing existing code or profiler output. Identify and prioritize bottlenecks and cleanup opportunities.

Label every claim in one of three buckets:

- **Measured**: backed by profiler output, metrics, traces, or a reproducible benchmark.
- **Likely**: strongly implied by code structure and known platform behavior.
- **Possible**: plausible but not yet verified — keep these clearly labeled.

Prefer changes that:

- Remove work instead of relocating it.
- Reduce repeated allocations, copying, diffing, decoding, layout, or synchronization.
- Move non-UI work off the main actor without breaking isolation or ordering guarantees.
- Tighten lifecycle ownership so expensive resources are created once and released predictably.

## Core Principles

- Favor stable, measurable improvements over speculative micro-optimizations.
- Keep hot paths allocation-light, branch-light, and synchronization-light.
- Do not create work on the main thread that can be prepared, cached, batched, or deferred.
- Prefer the simplest data structure that matches lookup, mutation, ordering, and memory needs.
- Avoid hidden copying, repeated formatting, repeated decoding, and repeated view recomputation.
- Use structured concurrency and actor isolation deliberately; do not introduce gratuitous task creation or actor hopping.
- Align performance fixes with quality gates: correctness, testability, readability, lifecycle safety, and observability.

## Workflow

1. Identify the hottest path or likely-sensitive path before writing code.
2. Read the relevant code and trace object lifetimes, thread hops, data movement, invalidation scope, and rendering triggers.
3. Apply the review checklist (below) systematically.
4. If generating or editing code, incorporate the checklist into the implementation itself.
5. Ground platform-specific advice in current official Apple/Swift sources (see Official Sources section) when citations are needed.
6. When reviewing, return findings ordered by impact: startup, frame drops, contention, memory pressure, battery, then cleanup opportunities.
7. For every recommendation or code change, state the expected win, the tradeoff, and how to verify it with Instruments, benchmarks, or production telemetry.

## Build Rules

When writing or modifying code, apply these by default:

- Keep expensive work out of `body`, cell configuration, view lifecycle callbacks, and launch paths unless the feature strictly requires it.
- Reuse expensive helpers and shared resources when configuration is stable.
- Choose data structures and ownership patterns before writing loops and transforms.
- Avoid main-actor work for parsing, decoding, image preparation, persistence, and other non-UI computation.
- Design cancellation, batching, caching, and lazy initialization into the first implementation when the feature is latency-sensitive.
- Prevent accidental quadratic work, repeated diffing, repeated decoding, and avoidable copy-on-write before it lands in the codebase.
- If a simpler implementation is slightly slower but clearly outside any hot path, keep it simple and note that the path is not performance critical.
- Make main-thread, allocation, and lifecycle costs explicit in architecture decisions.
- Add measurement hooks, performance tests, or profiling notes when a change could affect startup, rendering, memory, or concurrency behavior.

## Focus Areas

Inspect these areas whenever relevant:

- **Object creation discipline**: repeated formatter creation, per-cell view model creation, transient wrapper objects, unnecessary boxing, repeated `Task` or closure allocation, avoidable bridging to Foundation.
- **Resource lifecycle safety**: caches without eviction; observers/timers not invalidated; tasks that outlive owners; images/data loaded too early; expensive singletons initialized on launch.
- **Loop and hot-path efficiency**: nested loops; repeated sorting/filtering/mapping in render or scroll paths; repeated date/number formatting; repeated regex/JSON decoding; redundant copy-on-write triggers.
- **Data-structure fit**: `Array.contains` where `Set`/dictionary lookup matches usage; ordered collections used where hashing is appropriate; large value types copied repeatedly; `String`/`Data` slicing and bridging mistakes.
- **Algorithmic efficiency**: accidental quadratic work; repeated whole-collection diffs; N+1 fetches; redundant layout passes; avoidable database or disk churn.
- **Memory management**: retain cycles; large temporary buffers; autorelease-heavy bridging; image inflation; cache growth; actor/task retention chains.
- **Concurrency and threading**: main-actor overuse; priority inversions; lock contention; serial queue bottlenecks; unbounded task fan-out; ignored cancellation; data races hidden behind `nonisolated` or unsafe shared state.
- **UI rendering and responsiveness**: expensive `body` recomputation; unstable identity in SwiftUI lists; synchronous image decoding; layout thrash; work in lifecycle callbacks that blocks first interaction; repeated diffing or invalidation.
- **Startup and first-frame time**: eager dependency construction; synchronous disk/network work; migration or logging work in launch path; oversized initial view models; work that can move behind first frame.

## Checklist

Use both when generating/modifying Swift/iOS code and when reviewing existing code. Build mode: prevent bottlenecks from landing. Review mode: explain and prioritize issues already present.

### Object Creation Discipline

- [ ] Expensive objects hoisted out of loops, cell configuration, `body`, and frequently-called callbacks
- [ ] `DateFormatter`/`ISO8601DateFormatter`/`NumberFormatter`/`JSONDecoder`/`JSONEncoder`/regex builders/layout helpers reused when configuration is stable
- [ ] No per-render creation of detached tasks, view models, caches, or wrappers unless lifecycle truly requires it
- [ ] Bridging between Swift value types and Foundation reference types flagged in hot paths

### Resource Lifecycle Safety

- [ ] Observers, timers, display links, and tasks cancelled/invalidated with owner lifetime
- [ ] Caches checked for limits, eviction policy, and key granularity
- [ ] Heavyweight initialization moved out of app launch/first render unless essential for first interaction
- [ ] Expensive shared resources created lazily and released when their owning feature disappears
- [ ] Ownership and teardown visible in the API shape (not bolted on later)

### Loop And Hot-Path Efficiency

- [ ] Repeated derived work inlined once per pass; precomputed when inputs are stable
- [ ] `filter` + `first`, repeated sorting, repeated formatting/parsing, and repeated `contains` scans on large arrays inside loops flagged
- [ ] Accidental copy-on-write from mutation of shared arrays/dictionaries/strings/data buffers checked
- [ ] No logging, allocation, decoding, or synchronization in animation, scroll, or layout paths

### Data Structure Fit

- [ ] `Set`/dictionary used for membership and keyed access
- [ ] Contiguous arrays used for small ordered collections and predictable iteration
- [ ] Large structs copied across async boundaries, closures, or collection transforms called out
- [ ] Cache/ring buffer/heap/ordered dictionary considered when a plain array does not match the access pattern

### Algorithmic Efficiency

- [ ] Complexity estimated at the call site, not just inside a helper
- [ ] Repeated whole-list transforms during incremental updates flagged
- [ ] Quadratic diffing, nested scans, redundant fetches, repeated layout invalidation looked for
- [ ] Duplicate work reduced before proposing lower-level micro-optimizations

### Memory Management

- [ ] Capture lists, delegate ownership, task retention, and actor ownership checked for leaks
- [ ] Image decode size, decompression timing, and unnecessary full-resolution retention watched
- [ ] Temporary buffers or copied payloads exceeding steady-state memory budget flagged
- [ ] Streaming, chunking, or incremental parsing preferred for large inputs

### Concurrency And Threading

- [ ] UI state changes kept on the main actor; parsing, mapping, persistence, and image work moved off it
- [ ] Actor ping-pong, serial-queue funnels, lock convoys, priority mismatches, and task explosions watched for
- [ ] Explicit cancellation handling required for search, scrolling, prefetching, and view-bound async work
- [ ] Structured concurrency preferred over detached work unless ownership is clearly external
- [ ] Actor boundaries, task ownership, and cancellation semantics chosen before adding parallel work

### UI Rendering And Responsiveness

- [ ] SwiftUI: identity stability, observable granularity, invalidation scope, and repeated work in `body` inspected
- [ ] UIKit: layout passes, cell reuse discipline, image decoding, text measurement, synchronous main-thread I/O inspected
- [ ] Launch and first-interaction paths free of nonessential work
- [ ] Below-the-fold work deferred; updates batched; derived presentation state cached when safe

### Quality Gate Alignment

- [ ] No change that improves speed by weakening correctness, cancellation, testability, or lifecycle ownership
- [ ] Fixes measurable, local, and easy to verify in CI or Instruments
- [ ] Missing metrics, regression tests, and observability called out when they block confidence
- [ ] Intended verification path documented so later agents can confirm the design performs as expected

## Output Format

When **reviewing** code, report findings in this shape:

1. `Issue`: concise statement of the bottleneck or risk.
2. `Why it matters`: user-visible impact or systems impact.
3. `Evidence`: measured, likely, or possible.
4. `Recommendation`: the smallest credible change.
5. `Verification`: Instruments view, benchmark, metric, or regression test to run.

If nothing is clearly wrong, say so explicitly and list residual risks or missing measurements.

When **generating or modifying** code, also explain:

1. `Performance-sensitive choices`: data structures, ownership, caching, batching, or concurrency decisions baked into the implementation.
2. `Risk avoided`: the bottleneck or anti-pattern prevented by the design.
3. `Verification`: what should be profiled or benchmarked after the change lands.

## Evidence Expectations

- When profiling is missing, say what should be measured before approving a risky refactor.
- Do not promise wins you cannot explain mechanically.

## Agent Compatibility

Keep the workflow tool-agnostic (Codex, Claude Code, Cursor, and similar agents):

- Do not rely on vendor-specific commands or UI affordances.
- Use repo-local tooling when available; otherwise reason directly from source.
- Cite official docs with plain links or titles so any agent can reuse them.
- Keep recommendations actionable even when Instruments screenshots or traces are unavailable.

## Official Sources

Ground platform-specific advice in current official Apple and Swift pages. Prefer direct canonical pages; use search anchors when Apple moves a page title or URL. Index last reviewed for this skill: 2026-03-08.

**Apple Developer (direct):**
- developer.apple.com/documentation/swiftui/performance-analysis — SwiftUI responsiveness, hangs, hitches
- developer.apple.com/documentation/xcode/understanding-and-improving-swiftui-performance — long/overly frequent view updates
- developer.apple.com/tutorials/instruments/analyzing-main-thread-activity — main-thread diagnosis workflow
- developer.apple.com/documentation/xcode/reducing-your-app-s-launch-time — launch-time reduction
- developer.apple.com/documentation/xcode/gathering-information-about-memory-use — memory profiling entry point
- developer.apple.com/documentation/xcode/reducing-your-app-s-memory-use — memory reduction guidance
- developer.apple.com/documentation/xcode/diagnosing-memory-thread-and-crash-issues-early — sanitizers and runtime diagnostics
- developer.apple.com/documentation/xcode/analyzing-the-performance-of-your-shipping-app — Organizer metrics (launch, memory, responsiveness, battery)
- developer.apple.com/documentation/metrickit/mxapplaunchmetric — post-release launch metric API

**Swift.org (direct):**
- swift.org/documentation/ — documentation index
- swift.org/documentation/tspl/ — The Swift Programming Language
- swift.org/documentation/concurrency/ — concurrency checking and migration guidance
- swift.org/documentation/api-design-guidelines/ — API design guidelines
- swift.org/documentation/standard-library/ — standard library overview
- swift.org/blog/announcing-swift-6/ — Swift 6 data-race safety context

**Search anchors** (recover a moved page): `site:developer.apple.com` with "Improving app responsiveness", "Reducing your app's launch time", "Understanding and improving SwiftUI performance", "Analyzing main thread activity", "Gathering information about memory use", "Reducing your app's memory use", "Diagnosing memory, thread, and crash issues early", "Analyzing the performance of your shipping app", "MXAppLaunchMetric", "Instruments Time Profiler", "Instruments Allocations", "Instruments Leaks"; and `site:swift.org` with "The Swift Programming Language", "Enabling Complete Concurrency Checking", "API Design Guidelines", "Standard Library", "Swift 6" concurrency data-race.

**How to use:** in build mode, cite direct pages to justify architecture decisions before code lands (actor isolation, startup deferral, memory ownership, rendering updates, measurement strategy); in review mode, use them to support findings and fixes. Prefer Apple Developer docs for Instruments workflows, launch time, SwiftUI rendering, main-thread rules, MetricKit, and memory profiling; prefer Swift.org for concurrency, `Sendable`, language semantics, API design, and standard-library concepts. Prefer a short paraphrase plus a link over long quotations. If a source conflicts with current measured behavior, treat the recommendation as `possible` until profiled locally.

**Source quality notes:** the direct-link lists are official Apple/Swift documentation. This skill is a curated index, not an official document. Avoid retired Apple archive pages except as historical background (label them archived and non-current; e.g. the archived LaunchTime library page is background only).

**Minimum evidence by topic:**
- Startup time: launch trace, signposts, Organizer or MetricKit launch metrics, plus Apple launch guidance.
- UI latency: frame pacing, main-thread analysis, SwiftUI or UIKit rendering evidence.
- Memory: allocations, memory graphs, leak evidence, or Organizer metrics plus an ownership explanation.
- Contention: thread state, lock wait, actor hop, queue backlog, or hang diagnostics.
- Algorithms: complexity analysis tied to collection sizes, frequency, and user-visible paths.

## Provenance

- Source repo: https://github.com/codeanurag/swift-performance-engineering-Skill
- Original path: `.` (repo root)
- License: MIT (in-repo LICENSE; created by Anurag Pandit)
