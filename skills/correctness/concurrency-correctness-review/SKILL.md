---
name: concurrency-correctness-review
description: Reviews concurrency constructs for races, TOCTOU, deadlocks, lock ordering, atomicity and memory-model violations with per-finding verdicts. Use when reviewing threaded, async or parallel code as the deep concurrency pass.
---

# Concurrency Review Skill

Review threaded, async, or parallel code for concurrency correctness and safety. The protocol below applies to any concurrent code (Java, Kotlin, Go, Rust, C++, JS/TS async, …); the code samples use Java and are illustrative, not a Java-only scope.

## Why This Matters

> Concurrency bugs surface as intermittent, load-dependent failures rather than deterministic ones — which is what makes them expensive: they pass review, pass the test suite, and fail in production.

This skill helps catch issues **before** they reach production.

## When to Use
- Reviewing code with `synchronized`, `volatile`, `Lock`
- Checking `@Async`, `CompletableFuture`, `ExecutorService`
- Validating thread safety of shared state
- Any code accessed by multiple threads

---

## Per-Finding Verdict Contract

The deliverable is a **verdict per finding** — not a checklist of suspicions. For every concurrency issue you report, emit a finding block with all four fields:

- **Trigger window / timing** — the exact interleaving: what thread/callback A does between thread B's check and its act, which `await`/IO boundary opens the window, or which two writes race. If you cannot name a concrete window, it is not a finding.
- **Reachability** — whether that window can actually occur here: which callers, under what load/schedule, and whether an existing lock, atomic, or confined dispatcher already closes it. Reachable → report; unreachable (single-threaded init, an already-synchronized context) → drop.
- **Evidence** — `file:line` anchors for every step of the window: the read, the check, the write, the shared state, and the missing or insufficient guard.
- **Verdict** — one of `REAL_RACE` / `REAL_DEADLOCK` / `REAL_VISIBILITY_BUG` / `NEEDS_REVIEW` (window plausible, reachability unconfirmed) / `NOT_A_BUG` (name the guard that closes it).

Verdicts are per finding (per root cause), not per file; two sightings of one root cause share a single finding and a single verdict.

---

## Spring @Async Pitfalls

### 1. Forgetting @EnableAsync

```java
// ❌ @Async silently ignored
@Service
public class EmailService {
    @Async
    public void sendEmail(String to) { }
}

// ✅ Enable async processing
@Configuration
@EnableAsync
public class AsyncConfig { }
```

### 2. Calling Async from Same Class

```java
@Service
public class OrderService {

    // ❌ Bypasses proxy - runs synchronously!
    public void processOrder(Order order) {
        sendConfirmation(order);  // Direct call, not async
    }

    @Async
    public void sendConfirmation(Order order) { }
}

// ✅ Inject self or use separate service
@Service
public class OrderService {
    @Autowired
    private EmailService emailService;  // Separate bean

    public void processOrder(Order order) {
        emailService.sendConfirmation(order);  // Proxy call, async works
    }
}
```

### 3. @Async on Non-Public Methods

```java
// ❌ Non-public methods - proxy can't intercept
@Async
private void processInBackground() { }

@Async
protected void processInBackground() { }

// ✅ Must be public
@Async
public void processInBackground() { }
```

### 4. Default Executor Creates Thread Per Task

Default `SimpleAsyncTaskExecutor` creates a new thread for every task with no bound. Under load it creates threads faster than they retire and can exhaust memory (OutOfMemoryError). Configure a bounded pool (`ThreadPoolTaskExecutor` with core/max/queue limits) instead.

### 5. ThreadLocal-Bound Context Not Propagating

Any context kept in a `ThreadLocal` — MDC/logging context, transaction or request context, a framework's security context — does not follow work handed to another thread. The async task reads either `null`, or worse on a pooled thread, a stale value left behind by a previous task.

```java
// ❌ The ThreadLocal is bound to the submitting thread, not the async one
@Async
public void recordAction() {
    // MDC.get("requestId") / RequestContextHolder / SecurityContextHolder are NULL or stale here
    String requestId = MDC.get("requestId");
    auditLog.write(requestId, ...);   // writes null, or another request's id
}
```

Capture the value on the submitting thread and pass it as an argument, or wrap the executor so it re-binds the context for each task:

```java
@Bean
public Executor taskExecutor() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    // ... configure ...
    return new DelegatingSecurityContextAsyncTaskExecutor(executor);  // same idea for MDC / request context
}
```

---

## CompletableFuture Patterns

### Error Handling

```java
// ❌ Exception silently swallowed
CompletableFuture.supplyAsync(() -> riskyOperation());
// If riskyOperation throws, nobody knows

// ✅ Always handle exceptions
CompletableFuture.supplyAsync(() -> riskyOperation())
    .exceptionally(ex -> {
        log.error("Operation failed", ex);
        return fallbackValue;
    });

// ✅ Or use handle() for both success and failure
CompletableFuture.supplyAsync(() -> riskyOperation())
    .handle((result, ex) -> {
        if (ex != null) {
            log.error("Failed", ex);
            return fallbackValue;
        }
        return result;
    });
```

### Timeout Handling

A future with no timeout hangs forever when the operation never completes. Set one (`orTimeout`, `completeOnTimeout`) on any asynchronous operation that can stall.

### Combining Futures

```java
// ✅ Wait for all
CompletableFuture.allOf(future1, future2, future3)
    .thenRun(() -> log.info("All completed"));

// ✅ Wait for first
CompletableFuture.anyOf(future1, future2, future3)
    .thenAccept(result -> log.info("First result: {}", result));

// ✅ Combine results
future1.thenCombine(future2, (r1, r2) -> merge(r1, r2));
```

## Classic Concurrency Issues

### Race Conditions: Check-Then-Act

```java
// ❌ Race condition
if (!map.containsKey(key)) {
    map.put(key, computeValue());  // Another thread may have added it
}

// ✅ Atomic operation
map.computeIfAbsent(key, k -> computeValue());

// ❌ Race condition with counter
if (count < MAX) {
    count++;  // Read-check-write is not atomic
}

// ✅ Atomic counter
AtomicInteger count = new AtomicInteger();
count.updateAndGet(c -> c < MAX ? c + 1 : c);
```

### Visibility: Missing volatile

```java
// ❌ Other threads may never see the update
private boolean running = true;

public void stop() {
    running = false;  // May not be visible to other threads
}

public void run() {
    while (running) { }  // May loop forever
}

// ✅ Volatile ensures visibility
private volatile boolean running = true;
```

### Non-Atomic long/double

```java
// ❌ 64-bit read/write is non-atomic on 32-bit JVMs
private long counter;

public void increment() {
    counter++;  // Not atomic!
}

// ✅ Use AtomicLong or synchronization
private AtomicLong counter = new AtomicLong();

// ✅ Or volatile (for single-writer scenarios)
private volatile long counter;
```

### Double-Checked Locking

```java
// ❌ Broken without volatile
private static Singleton instance;

public static Singleton getInstance() {
    if (instance == null) {
        synchronized (Singleton.class) {
            if (instance == null) {
                instance = new Singleton();  // May be seen partially constructed
            }
        }
    }
    return instance;
}

// ✅ Correct with volatile
private static volatile Singleton instance;

// ✅ Or use holder class idiom
private static class Holder {
    static final Singleton INSTANCE = new Singleton();
}

public static Singleton getInstance() {
    return Holder.INSTANCE;
}
```

### Deadlocks: Lock Ordering

```java
// ❌ Potential deadlock
// Thread 1: lock(A) -> lock(B)
// Thread 2: lock(B) -> lock(A)

public void transfer(Account from, Account to, int amount) {
    synchronized (from) {
        synchronized (to) {
            // Transfer logic
        }
    }
}

// ✅ Consistent lock ordering
public void transfer(Account from, Account to, int amount) {
    Account first = from.getId() < to.getId() ? from : to;
    Account second = from.getId() < to.getId() ? to : from;

    synchronized (first) {
        synchronized (second) {
            // Transfer logic
        }
    }
}
```

---

## Thread-Safe Collections

### Choose the Right Collection

| Use Case | Wrong | Right |
|----------|-------|-------|
| Concurrent reads/writes | `HashMap` | `ConcurrentHashMap` |
| Frequent iteration | `ConcurrentHashMap` | `CopyOnWriteArrayList` |
| Producer-consumer | `ArrayList` | `BlockingQueue` |
| Sorted concurrent | `TreeMap` | `ConcurrentSkipListMap` |

### ConcurrentHashMap Pitfalls

```java
// ❌ Nested compute can deadlock
map.compute(key1, (k, v) -> {
    return map.compute(key2, ...);  // Deadlock risk!
});
```

---

## Concurrency Review Checklist

### 🔴 High Severity (Likely Bugs)
- [ ] No check-then-act on shared state without synchronization
- [ ] No `synchronized` calling external/unknown code (deadlock risk)
- [ ] `volatile` present for double-checked locking
- [ ] Non-volatile fields not read in loops waiting for updates
- [ ] `ConcurrentHashMap.compute()` doesn't call other map operations
- [ ] @Async methods are public and called from different beans

### 🟡 Medium Severity (Potential Issues)
- [ ] Thread pools properly sized and named
- [ ] CompletableFuture exceptions handled (exceptionally/handle)
- [ ] ThreadLocal-bound context (MDC / request context / security context) propagated to async tasks, or captured on the submitting thread and passed explicitly
- [ ] `ExecutorService` properly shut down
- [ ] `Lock.unlock()` in finally block
- [ ] Thread-safe collections used for shared data
- [ ] Asynchronous operations that can stall carry a timeout

---

## Analysis Commands

```bash
# Find synchronized blocks
grep -rn "synchronized" --include="*.java"

# Find @Async methods
grep -rn "@Async" --include="*.java"

# Find volatile fields
grep -rn "volatile" --include="*.java"

# Find thread pool creation
grep -rn "Executors\.\|ThreadPoolExecutor\|ExecutorService" --include="*.java"

# Find CompletableFuture without error handling
grep -rn "CompletableFuture\." --include="*.java" | grep -v "exceptionally\|handle\|whenComplete"

# Find ThreadLocal (context bound to one thread only)
grep -rn "ThreadLocal" --include="*.java"
```

## Provenance

- Source repo: https://github.com/decebals/claude-code-java
- Original path: skills/concurrency-review/SKILL.md
- License: unknown - see repo
- 并入说明（2026-09-07）：下载并归一为单文件（frontmatter 仅 name/description）；原仓库配套文件未随附，需要时回上游取用。
- Integration note (2026-09-07): fetched and normalized to single-file; auxiliary files of the source repo are not bundled - see upstream.
- 维度收敛（2026-09-11）：原 "SecurityContext Not Propagating" 改为 "ThreadLocal-Bound Context Not Propagating"——ThreadLocal 传播失败是行为缺陷（下游读到 null，或在线程池上读到上一个任务留下的值），Spring Security 只是典型实例，MDC/事务/请求上下文同理，故按本维度判据呈现并把通用修法（捕获后显式传递）放在框架包装器之前。另删去一处无出处的统计（"Nearly 60% of multithreaded applications … - ACM Study"，与 P0-3 同类缺陷），改写为不带引用的性质陈述。
- 段落级判据收敛（2026-09-11）：删去 Java 21/25 特性采用指南（Virtual Threads 何时用、Java 25 pinning 修复说明、ScopedValue 迁移、Structured Concurrency API 教程、executor 调参、Modern Patterns 与 Documentation checklist）——这些是"怎么写好并发代码"的采用指南，不是"怎么发现并发缺陷"的审查协议，且其缺陷面已由别处覆盖。保留并缩到缺陷内核的两处：默认 `SimpleAsyncTaskExecutor` 无界建线程致 OOM、无 timeout 的 future 永久挂起。
