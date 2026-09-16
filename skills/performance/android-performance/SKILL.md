---
name: android-performance
description: Runs a Measure-Diagnose-Fix-Verify audit of Jetpack Compose Android runtime performance using release-mode builds, recomposition and stability analysis, lazy lists and baseline profiles. Use for sluggish Compose apps or perf sprints.
---

# Auditing Compose Performance — the Measure → Diagnose → Fix → Verify orchestrator

This is the highest-level entry point for a broad Compose performance audit. When the developer's symptom is broad — "the app feels sluggish", "scroll is rough everywhere", "we're starting a perf sprint", "where do we even start?" — start here. It runs the four-phase loop below and produces a written audit report at the end.

Perf work without measurement is guessing. The goal is `FrameTimingMetric` and `StartupTimingMetric` improvement on a real device — never a number read off the compiler report.

## When to use this skill

- The developer reports broad sluggishness with no specific surface ("the app feels heavy", "everything is slow").
- A team is kicking off a performance sprint and wants a structured plan.
- A new team member needs onboarding to a perf-troubled codebase.
- A pre-release perf gate is required before shipping.
- The user asks for an "audit", "perf review", or a written deliverable.
- The user has no idea where to start and wants Claude to triage.

## When NOT to use this skill

- A specific symptom is already named (scroll jank in `LazyColumn`, `derivedStateOf` not firing, custom modifier recomposing) — fix that surface directly instead of running the full audit.
- The developer only wants to fix one issue and does not want a written report — this audit always produces one, so do the targeted fix without it.
- No release build is possible (e.g. broken signing config). Resolve that first; this audit MUST measure release.

## Prerequisites

- Project builds the release variant successfully (`./gradlew assembleRelease`).
- At least one physical Android device for measurement. Emulator numbers are not representative.
- A Macrobenchmark module is present, or willingness to add one.
- Willingness to commit Baseline Profile and stability baseline files to the repo.
- Compose Compiler 1.5.5+ for `stabilityConfigurationFile`. Kotlin 2.0.20+ for Strong Skipping default. AGP 8.2+ for the Baseline Profile Generator template.
- Optional but recommended: a feature branch to land each fix as its own PR.

## Workflow

Run all four phases in order. **DO NOT** skip ahead. After each Phase 3 fix, return to Phase 1 to re-measure and Phase 2 to re-diagnose before applying the next fix.

### Phase 1 — Measure (establish baseline numbers BEFORE changing any code)

- [ ] Confirm the release variant builds and is the measurement target.
- [ ] Confirm R8 is enabled correctly (full mode, `proguard-android-optimize.txt`, resource shrinking on).
- [ ] Generate or refresh the Baseline Profile via the Baseline Profile Generator module.
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

- [ ] Enable Compose Compiler reports for the **release** variant.
- [ ] Read `<module>-composables.txt`. List every restartable-but-not-skippable composable and the unstable parameter that blocks skipping.
- [ ] Read `<module>-classes.txt`. List every unstable class with the offending field (a `var`, an unstable field type, an interface, etc.).
- [ ] For surprising verdicts (`runtime`, `unknown`, "this looks stable but the compiler disagrees"), re-inspect the field types and mutability by hand before trusting the report.
- [ ] Layout Inspector pass on the suspect surfaces: enable recomposition counts and skip counts. Identify hotspots with high counts and low skips.
- [ ] For release-grade tracing (Layout Inspector cannot reach release builds), instrument the top hotspots with `@TraceRecomposition`.
- [ ] Triage: rank issues by **frequency × cost**. A recomposition in a hot `LazyColumn` row beats a 10× recomposition on a one-off settings screen. **DO NOT** rank by compiler-report severity alone.
- [ ] Write the Diagnosis section of the audit report: top-5 hotspots, count of restartable-not-skippable composables, count of unstable classes, count of phase-misplaced reads.

### Phase 3 — Fix (apply targeted, minimal-diff changes — one cause per PR)

For each ranked issue, apply the targeted fix. **PREFERRED:** one PR per fix cause, so the diff is reviewable and bisectable. After **each** fix, re-run Phase 1 (measure) and Phase 2 (diagnose) to confirm the change moved the right needle and did not regress another.

- [ ] Stability fixes (unstable `data class`, `List`/`Set`/`Map` parameter, `java.time.LocalDateTime`).
- [ ] Strong Skipping audit (verify mode is on, find lambda capture sites that need `@DontMemoize` or `@NonSkippableComposable`).
- [ ] Phase-deferral fixes for animations and scroll (`Modifier.offset { }`, `Modifier.graphicsLayer { }`, `Modifier.drawBehind { }`).
- [ ] `derivedStateOf` misuse (missing `remember`, captured non-state vars, used where input frequency does not exceed output frequency).
- [ ] Lazy layout `key` and `contentType` for `LazyColumn`/`LazyRow`/`LazyVerticalGrid`, hoisting modifier chains out of the `items` lambda.
- [ ] Lazy prefetch tuning **only** if Compose Foundation 1.10+ defaults still drop frames at high scroll velocity.
- [ ] Custom modifier migrations from `Modifier.composed { }` to `Modifier.Node` + `ModifierNodeElement`.
- [ ] Modifier order bugs (background painted in wrong region, click area extends past visible button, `clip` after `background`).
- [ ] Flow collection safety (`collectAsState` → `collectAsStateWithLifecycle`, hoist `Flow<T>` parameters out of composables, add `.conflate()` / `.distinctUntilChanged()`).
- [ ] Effect API audit (`LaunchedEffect` vs `RememberedEffect` vs `DisposableEffect` vs `SideEffect`, stale callbacks via `rememberUpdatedState`).
- [ ] After each fix: re-run Phase 1 + Phase 2 and record the Macrobenchmark delta in the audit report's Phase 3 table.

### Phase 4 — Verify (lock it in)

- [ ] Re-generate the Baseline Profile so the now-faster code paths are captured.
- [ ] Compare Macrobenchmark numbers vs the Phase 1 baseline. Record P50/P90/P99 deltas in the "Verification (Phase 4)" section.
- [ ] Set up the CI stability gate so regressions fail the build (`stabilityDump` once, then `stabilityCheck` on every PR).
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
| Fix | Change | Files | Macrobench delta |
| --- | ------ | ----- | ---------------- |
| Stabilize list types | wrap List<Snack> with ImmutableList | feed/SnackList.kt | scroll P90 18ms → 12ms |
| Defer state reads | offset(x.dp) → offset { } | hero/Hero.kt | scroll P99 33ms → 19ms |
| ... | ... | ... | ... |

## Verification (Phase 4)
- Cold startup median: <ms> (Δ <ms>)
- Scroll FrameTimingMetric (P50/P90/P99): <ms> / <ms> / <ms> (Δ ...)
- Baseline Profile regenerated: yes
- CI stability gate active: yes / no

## Open items / follow-ups
- <list>
```

## Anti-patterns in your own output

Three smells this protocol exists to prevent — each restates a rule above, kept here as a recognizable failure mode during an audit:

- **Fixing before measuring.** "Scroll feels rough — let me wrap this `List` in `ImmutableList` and add `@Immutable` everywhere." With no baseline number recorded first, any later claim of improvement is unfalsifiable.
- **One mega-PR across several causes.** A PR that converts four data classes, migrates two modifiers, moves three reads down a phase, and adds a Baseline Profile module produces a mixed delta (startup faster, scroll slower) that cannot be attributed to any one change — bisect impossible. Scope each PR to one cause and give it its own before/after Macrobenchmark number.
- **Chasing 100% skippability.** "We got `composables.txt` skip rate from 71% to 100%. Audit complete." Skippability is a means, not the end; a 100% skippable app still drops frames when the work lands in Layout or Draw. Report `FrameTimingMetric` / `StartupTimingMetric` movement on a real device instead.

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
- **MUST NOT** apply a fix for a named cause without first checking that cause's prerequisites and verification approach.
- **PREFERRED:** one PR per fix cause — small diffs are reviewable and bisectable.
- **PREFERRED:** rank Phase 2 hotspots by frequency × cost, not by compiler-report severity.

## Verification

The Phase 1–4 checklists in the workflow are the verification protocol — every box in every phase must be ticked before the audit may be called complete. The single pass/fail gate they do not imply:

- [ ] Cold startup median and scroll P90 are both improved or held steady. If either regressed, the report's "Open items" section names the cause and the next action.

## External references

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
- 体量收敛（2026-09-11）：删除 39 行无信息量的 "companion skill …" 兄弟技能清单（归一化时技能名已丢失，只剩 URL 样板）、正文内 23 处同句内联引用、以及复述已述规则的 Patterns 代码块与 Verification 清单；intro 段中逐阶段复述 Workflow 的部分删除。5,556 → 3,900 token。
