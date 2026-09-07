---
name: android-performance
description: Runs a Measure-Diagnose-Fix-Verify audit of Jetpack Compose Android runtime performance using release-mode builds, recomposition and stability analysis, lazy lists and baseline profiles. Use for sluggish Compose apps or perf sprints.
---

# Auditing Compose Performance — the Measure → Diagnose → Fix → Verify orchestrator

This is the highest-level entry point in the `compose-performance-skills` library. When the developer's symptom is broad — "the app feels sluggish", "scroll is rough everywhere", "we're starting a perf sprint", "where do we even start?" — Claude enters here. The orchestrator does **NOT** replace the 25 focused skills; it sequences them through a four-phase loop and produces a written audit report at the end.

The phases are **Measure → Diagnose → Fix → Verify**, run in order, never skipped. Phase 1 establishes baseline numbers from a release + R8 build on a real device, because anything else is fiction. Phase 2 turns symptoms into named causes from the Compose Compiler reports, Layout Inspector, and runtime tracing. Phase 3 applies one targeted fix at a time, re-measuring between fixes so the delta of each change is provable. Phase 4 regenerates the Baseline Profile, locks in a CI stability gate, and commits the baseline files so regressions cannot slip back.

Perf work without measurement is guessing. Skydoves hot take #1 applies throughout: **DO NOT** chase 100% skippability — that is a diagnostic on a compiler report, not the goal. The goal is `FrameTimingMetric` and `StartupTimingMetric` improvement on a real device.

## When to use this skill

- The developer reports broad sluggishness with no specific surface ("the app feels heavy", "everything is slow").
- A team is kicking off a performance sprint and wants a structured plan.
- A new team member needs onboarding to a perf-troubled codebase.
- A pre-release perf gate is required before shipping.
- The user asks for an "audit", "perf review", or a written deliverable.
- The user has no idea where to start and wants Claude to triage.

## When NOT to use this skill

- A specific symptom is already named (scroll jank in `LazyColumn`, `derivedStateOf` not firing, custom modifier recomposing). Go straight to the focused skill. See (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) for the symptom→skill map.
- The developer only wants to fix one issue and does not want a written report. Pick the focused skill from (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- No release build is possible (e.g. broken signing config). Resolve that first; this audit MUST measure release.

## Prerequisites

- Project builds the release variant successfully (`./gradlew assembleRelease`).
- At least one physical Android device for measurement. Emulator numbers are not representative.
- A Macrobenchmark module is present, or willingness to add one (see (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled)).
- Willingness to commit Baseline Profile and stability baseline files to the repo.
- Compose Compiler 1.5.5+ for `stabilityConfigurationFile`. Kotlin 2.0.20+ for Strong Skipping default. AGP 8.2+ for the Baseline Profile Generator template.
- Optional but recommended: a feature branch to land each fix as its own PR.

## Workflow

Run all four phases in order. **DO NOT** skip ahead. After each Phase 3 fix, return to Phase 1 to re-measure and Phase 2 to re-diagnose before applying the next fix.

### Phase 1 — Measure (establish baseline numbers BEFORE changing any code)

- [ ] Confirm the release variant builds and is the measurement target. Cross-link (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] Confirm R8 is enabled correctly (full mode, `proguard-android-optimize.txt`, resource shrinking on). Cross-link (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] Generate or refresh the Baseline Profile via the Baseline Profile Generator module. Cross-link (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] Capture **cold startup** numbers with `MacrobenchmarkRule` + `StartupTimingMetric` under `CompilationMode.Partial(BaselineProfileMode.Require)`. Run ≥10 iterations.
- [ ] Capture **scroll** numbers for the suspect surface with `FrameTimingMetric` (P50, P90, P99). Run ≥5 iterations on the same device.
- [ ] Record every number in the audit report's "Baseline (Phase 1)" section. **MUST** be done before any code change.

```kotlin
// Phase 1 baseline scroll measurement (record P50/P90/P99 of frameDurationCpuMs)
@Test fun feedScroll() = rule.measureRepeated(
    packageName = "com.example",
    metrics = listOf(FrameTimingMetric()),
    iterations = 5,
    startupMode = StartupMode.WARM,
    compilationMode = CompilationMode.Partial(BaselineProfileMode.Require),
) {
    startActivityAndWait()
    device.findObject(By.res("feed")).fling(Direction.DOWN)
}
```

### Phase 2 — Diagnose (turn symptoms into named causes)

- [ ] Enable Compose Compiler reports for the **release** variant. Cross-link (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] Read `<module>-composables.txt`. List every restartable-but-not-skippable composable and the unstable parameter that blocks skipping.
- [ ] Read `<module>-classes.txt`. List every unstable class with the offending field (a `var`, an unstable field type, an interface, etc.).
- [ ] For surprising verdicts (`runtime`, `unknown`, "this looks stable but the compiler disagrees"), run (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) to walk the 12-phase algorithm.
- [ ] Layout Inspector pass on the suspect surfaces: enable recomposition counts and skip counts. Identify hotspots with high counts and low skips. Cross-link (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] For release-grade tracing (Layout Inspector cannot reach release builds), instrument the top hotspots with `@TraceRecomposition`. Cross-link (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] Triage: rank issues by **frequency × cost**. A recomposition in a hot `LazyColumn` row beats a 10× recomposition on a one-off settings screen. **DO NOT** rank by compiler-report severity alone.
- [ ] Write the Diagnosis section of the audit report: top-5 hotspots, count of restartable-not-skippable composables, count of unstable classes, count of phase-misplaced reads.

### Phase 3 — Fix (apply targeted, minimal-diff changes — one cause per PR)

For each ranked issue, pick the matching focused skill and apply the fix. **PREFERRED:** one PR per skill, so the diff is reviewable and bisectable. After **each** fix, re-run Phase 1 (measure) and Phase 2 (diagnose) to confirm the change moved the right needle and did not regress another.

- [ ] Stability fixes (unstable `data class`, `List`/`Set`/`Map` parameter, `java.time.LocalDateTime`) → (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] Strong Skipping audit (verify mode is on, find lambda capture sites that need `@DontMemoize` or `@NonSkippableComposable`) → (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] Phase-deferral fixes for animations and scroll (`Modifier.offset { }`, `Modifier.graphicsLayer { }`, `Modifier.drawBehind { }`) → (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] `derivedStateOf` misuse (missing `remember`, captured non-state vars, used where input frequency does not exceed output frequency) → (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] Lazy layout `key` and `contentType` for `LazyColumn`/`LazyRow`/`LazyVerticalGrid`, hoisting modifier chains out of the `items` lambda → (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] Lazy prefetch tuning **only** if Compose Foundation 1.10+ defaults still drop frames at high scroll velocity → (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] Custom modifier migrations from `Modifier.composed { }` to `Modifier.Node` + `ModifierNodeElement` → (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] Modifier order bugs (background painted in wrong region, click area extends past visible button, `clip` after `background`) → (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] Flow collection safety (`collectAsState` → `collectAsStateWithLifecycle`, hoist `Flow<T>` parameters out of composables, add `.conflate()` / `.distinctUntilChanged()`) → (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] Effect API audit (`LaunchedEffect` vs `RememberedEffect` vs `DisposableEffect` vs `SideEffect`, stale callbacks via `rememberUpdatedState`) → (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] After each fix: re-run Phase 1 + Phase 2 and record the Macrobenchmark delta in the audit report's Phase 3 table.

### Phase 4 — Verify (lock it in)

- [ ] Re-generate the Baseline Profile so the now-faster code paths are captured. Cross-link (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] Compare Macrobenchmark numbers vs the Phase 1 baseline. Record P50/P90/P99 deltas in the "Verification (Phase 4)" section.
- [ ] Set up the CI stability gate so regressions fail the build (`stabilityDump` once, then `stabilityCheck` on every PR). Cross-link (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).
- [ ] Commit `app/src/main/generated/baselineProfiles/baseline-prof.txt` (or wherever the consumer module placed it).
- [ ] Commit `app/stability/*.stability` baseline files generated by `:stabilityDump`.
- [ ] Document the audit report (template below) and circulate. **MUST NOT** declare the audit complete without the written report.

## Audit report template

Claude **MUST** produce this file at the end of the audit. Save it under `docs/perf-audit-<date>-<module>.md` (or wherever the project stores reports).

```markdown
# Compose Performance Audit — <date> — <module>

## Environment
- Compose UI: <version>
- Compose Compiler: <version>
- Kotlin: <version>
- AGP: <version>
- Device: <model> / <API>

## Baseline (Phase 1)
- Cold startup median: <ms>
- Scroll FrameTimingMetric (P50/P90/P99): <ms> / <ms> / <ms>
- Baseline Profile present: yes/no

## Diagnosis (Phase 2)
- Restartable-not-skippable composables: <count>
- Unstable classes: <count>
- Top 5 recomposition hotspots: <list>
- Phase-misplaced reads: <count>

## Fixes applied (Phase 3)
| Skill | Change | Files | Macrobench delta |
| ----- | ------ | ----- | ---------------- |
| stability/stabilizing-compose-types | wrap List<Snack> with ImmutableList | feed/SnackList.kt | scroll P90 18ms → 12ms |
| recomposition/deferring-state-reads | offset(x.dp) → offset { } | hero/Hero.kt | scroll P99 33ms → 19ms |
| ... | ... | ... | ... |

## Verification (Phase 4)
- Cold startup median: <ms> (Δ <ms>)
- Scroll FrameTimingMetric (P50/P90/P99): <ms> / <ms> / <ms> (Δ ...)
- Baseline Profile regenerated: yes
- CI stability gate active: yes / no

## Open items / follow-ups
- <list>
```

## Patterns

### Pattern: Measure before you touch a single line

```kotlin
// WRONG
// "Scroll feels rough — let me wrap this List in ImmutableList and add @Immutable everywhere."
// WRONG because: no baseline number exists, so any later claim of improvement is unfalsifiable.
```

```kotlin
// RIGHT
// 1. Run MacrobenchmarkRule on the suspect surface. Record P50/P90/P99 in the report.
// 2. Read the Compose Compiler report for the same surface. Identify the named cause.
// 3. Apply ONE targeted fix from a sibling skill.
// 4. Re-run the same Macrobenchmark. Compute the delta. Record it.
```

### Pattern: One cause per PR

```text
WRONG: a single PR titled "perf improvements" that
  - converts 4 data classes to ImmutableList parameters
  - migrates 2 custom modifiers to Modifier.Node
  - moves 3 graphicsLayer reads down a phase
  - adds a Baseline Profile module
WRONG because: if the Macrobench delta is mixed (startup faster, scroll slower), the
audit cannot attribute the regression to a specific change. Bisect impossible.
```

```text
RIGHT: four PRs, each scoped to a single skill, each with its own Before/After
Macrobench number in the description. The audit report links to each PR in the
Phase 3 table.
```

### Pattern: Skippability is a diagnostic, not a KPI

```text
WRONG: "We got composables.txt skip rate from 71% to 100%. Audit complete."
WRONG because: skippability is a means. The end is FrameTimingMetric and
StartupTimingMetric improvement on a real device. A 100% skippable app can still
drop frames if the work happens in Layout or Draw.
```

```text
RIGHT: "Scroll P90 dropped from 18ms to 11ms. Cold startup median dropped from
820ms to 610ms. Skip rate improved as a side effect; we did not target it directly."
```

## Compose version requirements appendix

| Capability | Min version |
| --- | --- |
| Strong Skipping default ON | Kotlin 2.0.20+ |
| `LazyLayoutCacheWindow` | Compose Foundation 1.9+ |
| Pausable composition in lazy prefetch (default) | Compose Foundation 1.10+ |
| `stabilityConfigurationFile` DSL | Compose Compiler 1.5.5+ |
| Baseline Profile Generator template | AGP 8.2+ |
| R8 full mode default | AGP 8.0+ |
| `Modifier.animateItem()` GA | Compose UI 1.7+ |
| `rememberGraphicsLayer()` | Compose UI 1.7+ |

## Mandatory rules

- **MUST** complete all four phases in order — Measure → Diagnose → Fix → Verify. Never skip ahead.
- **MUST** record numbers BEFORE changing code; otherwise no claim of improvement is verifiable.
- **MUST** scope each Phase 3 fix to one named cause and re-measure between fixes so the delta of each change is provable.
- **MUST** commit the regenerated Baseline Profile and the stability baseline files at the end of Phase 4.
- **MUST** measure on release + R8 + a real physical device. Debug numbers and emulator numbers are not representative.
- **MUST NOT** declare the audit complete without producing the written report from the template above.
- **MUST NOT** chase 100% skippability (skydoves hot take #1) — the goal is `FrameTimingMetric` and `StartupTimingMetric` improvement, not a metric on the compiler report.
- **MUST NOT** apply a fix from a focused skill without first reading that skill's prerequisites and verification checklist.
- **PREFERRED:** one PR per fix skill — small diffs are reviewable and bisectable.
- **PREFERRED:** rank Phase 2 hotspots by frequency × cost, not by compiler-report severity.

## Verification

- [ ] Phase 1 numbers (cold startup median; scroll FrameTimingMetric P50/P90/P99) are recorded in the report before any code changed.
- [ ] Phase 2 diagnosis is written: restartable-not-skippable count, unstable class count, top-5 hotspots ranked.
- [ ] Each Phase 3 fix has its own row in the report with the specific skill applied, the files touched, and a measurable Macrobenchmark delta.
- [ ] Phase 4: Baseline Profile regenerated and committed; `app/stability/*.stability` files committed; CI `stabilityCheck` gate is active.
- [ ] Audit report saved (e.g. `docs/perf-audit-<date>-<module>.md`) and circulated.
- [ ] Cold startup median and scroll P90 are both improved or held steady; if either regressed, the report's "Open items" section names the cause and the next action.

## References

### Sibling skills (the 25 focused skills this orchestrator sequences)

Phase 1 — Measure:
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — debug builds lie; measure release + R8.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — Baseline Profile Generator + Macrobenchmark end-to-end.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — full mode, optimize ProGuard file, trust consumer rules.

Phase 2 — Diagnose:
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — enable and read the Compose Compiler reports.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — 12-phase algorithm, `$stable` field, generic bitmasks.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — IDE plugin for inline stability inspection.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — visualize how unstable parameters propagate through the composable tree.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — Layout Inspector counts and Argument Change Reasons.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — `@TraceRecomposition` for release-grade tracing.

Phase 3 — Fix:
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — three-tier waterfall: rewrite, annotate, configure.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — verify mode, audit lambda capture sites, escape hatches.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — push reads down to Layout/Draw via lambda modifiers.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — only when input frequency exceeds output frequency.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — recognize when `SubcomposeLayout` / `BoxWithConstraints` cost outweighs benefit.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — `key`, `contentType`, `Modifier.animateItem()`, hoisting.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — `LazyLayoutCacheWindow`, pausable prefetch, `NestedPrefetchScope`.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — `Modifier.Node` + `ModifierNodeElement` over `composed { }`.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — wrap-the-next-modifier mental model.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — `collectAsStateWithLifecycle`, hoist `Flow<T>` parameters.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — pick the cheapest correct effect API.

Phase 4 — Verify:
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — `stabilityDump` baseline + `stabilityCheck` CI gate.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — regenerate after fixes; commit `baseline-prof.txt`.

Hot-reload (developer-loop velocity, optional but recommended):
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — install and configure HotSwan for sub-second iteration.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — keep `remember`/`rememberSaveable` state through a reload.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — what reloads cleanly vs what forces a full rebuild.
- (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled) — pair HotSwan with an MCP-aware AI tool for tight loops.

Symptom and API lookup: (companion skill in https://github.com/skydoves/compose-performance-skills, not bundled).

### External references

- Android Developers — Performance overview: https://developer.android.com/develop/ui/compose/performance
- Android Developers — Stability overview: https://developer.android.com/develop/ui/compose/performance/stability
- Android Developers — Phases & perf: https://developer.android.com/develop/ui/compose/performance/phases
- Android Developers — Baseline Profiles: https://developer.android.com/develop/ui/compose/performance/baseline-profiles
- Ben Trengrove — Why test perf in release: https://medium.com/androiddevelopers/why-should-you-always-test-compose-performance-in-release-4168dd0f2c71
- Skydoves — "6 Jetpack Compose Guidelines to Optimize Your App Performance": https://medium.com/proandroiddev/6-jetpack-compose-guidelines-to-optimize-your-app-performance-be18533721f9
- Skydoves — "Optimize App Performance by Mastering Stability": https://medium.com/proandroiddev/optimize-app-performance-by-mastering-stability-in-jetpack-compose-69f40a8c785d
- Skydoves — compose-performance hub: https://github.com/skydoves/compose-performance
- Chris Banes — Composable metrics: https://chrisbanes.me/posts/composable-metrics/

## Provenance

- Source repo: https://github.com/skydoves/compose-performance-skills
- Original path: audit/auditing-compose-performance/SKILL.md
- License: Apache-2.0
- 并入说明（2026-09-07）：下载并归一为单文件（frontmatter 仅 name/description）；原仓库配套技能/辅助文件未随附，需要时回上游取用。
- Integration note (2026-09-07): fetched and normalized to single-file; sibling skills and auxiliary files of the source repo are not bundled - see upstream.
