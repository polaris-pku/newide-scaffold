---
name: load-test-scenario-builder
description: Creates comprehensive load test plans with realistic scenarios, traffic models, k6 scripts, and success criteria. Use for "load testing", "performance testing", "capacity validation", or "stress testing".
---

# Load Test Scenario Builder

Validate system capacity with realistic load tests.

## Load Test Scenarios

Scenario *shapes* (baseline / peak / stress) are reusable; the *numbers* are not.
Virtual users, durations, and thresholds must be derived from your traffic and SLO -
see [Deriving Thresholds](#deriving-thresholds-do-not-hard-code-standard-numbers).

```typescript
interface LoadTestScenario {
  name: string;
  description: string;
  virtualUsers: number; // from expected concurrency, not a round constant
  duration: string;
  rampUp: string;
  successCriteria: {
    p95Latency: number; // from the SLO or a measured baseline (see below)
    errorRate: number;  // from the error budget
    throughput: number; // from expected peak RPS
  };
}

// The values below reference your environment's SLO / baseline - fill them in.
// Do NOT read the shapes' magnitudes as skill-provided defaults.
const scenarios: LoadTestScenario[] = [
  {
    name: "Baseline Load",
    description: "Normal traffic pattern",
    virtualUsers: expectedConcurrency.baseline,
    duration: "10m",
    rampUp: "2m",
    successCriteria: {
      p95Latency: SLO.p95Latency,     // e.g. the product SLA target
      errorRate: SLO.errorBudget,     // e.g. 0.01 for a 1% error budget
      throughput: baseline.steadyRps, // observed steady-state RPS
    },
  },
  {
    name: "Peak Load",
    description: "Expected seasonal peak (e.g. Black Friday)",
    virtualUsers: expectedConcurrency.peak,
    duration: "30m",
    rampUp: "5m",
    successCriteria: {
      p95Latency: SLO.p95Latency, // same SLO must hold under peak load
      errorRate: SLO.errorBudget,
      throughput: baseline.steadyRps * peakFactor,
    },
  },
  {
    name: "Stress Test",
    description: "Find the breaking point (raise load until the SLO breaks)",
    virtualUsers: expectedConcurrency.peak * 3,
    duration: "20m",
    rampUp: "10m",
    successCriteria: {
      p95Latency: SLO.p95Latency, // keep the SLO so you can locate the knee
      errorRate: SLO.errorBudget,
      throughput: baseline.steadyRps * peakFactor,
    },
  },
];
```

## Deriving Thresholds (do not hard-code "standard" numbers)

There is no universal "good" p95 or RPS - a threshold is meaningful only relative to
your SLO or a measured baseline. Derive each one:

1. **Latency** - take the product SLO ("search responds in <300ms p95") as the pass
   threshold, or run a baseline at expected load and set the threshold at the observed
   steady-state p95 plus deliberate headroom (e.g. +20%).
2. **Error rate** - derive from the error budget: a 1% budget becomes `rate<0.01`.
3. **Throughput** - derive from peak traffic: `historical_peak_rps × peak_factor`.
4. **Virtual users** - derive from expected concurrency, not a round number; confirm
   with Little's Law (`VUs ≈ RPS × avg_latency`).

Record the derivation next to each threshold so a failure is attributable to a
specific SLO rather than to an arbitrary number.

## K6 Load Test Script

```javascript
// load-tests/checkout-flow.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const errorRate = new Rate("errors");

export let options = {
  stages: [
    { duration: "2m", target: 100 }, // Ramp up
    { duration: "10m", target: 100 }, // Stay at 100
    { duration: "2m", target: 0 }, // Ramp down
  ],
  thresholds: {
    // Numbers must come from your SLO / baseline - see "Deriving Thresholds".
    http_req_duration: ["p(95)<500"], // example: SLO p95 = 500ms
    errors: ["rate<0.01"], // example: 1% error budget
  },
};

export default function () {
  // 1. Browse products
  let browseRes = http.get("https://api.example.com/products");
  check(browseRes, {
    "browse status 200": (r) => r.status === 200,
  }) || errorRate.add(1);
  sleep(1);

  // 2. Add to cart
  let addCartRes = http.post(
    "https://api.example.com/cart",
    JSON.stringify({
      productId: "123",
      quantity: 1,
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
  check(addCartRes, {
    "add cart status 201": (r) => r.status === 201,
  }) || errorRate.add(1);
  sleep(2);

  // 3. Checkout
  let checkoutRes = http.post(
    "https://api.example.com/checkout",
    JSON.stringify({
      paymentMethod: "card",
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
  check(checkoutRes, {
    "checkout status 200": (r) => r.status === 200,
    "checkout success": (r) => r.json("status") === "success",
  }) || errorRate.add(1);
  sleep(3);
}
```

## Traffic Models

```javascript
// Realistic traffic patterns
export const trafficModels = {
  // Steady state
  steadyState: {
    stages: [{ duration: "30m", target: 500 }],
  },

  // Gradual ramp
  gradualRamp: {
    stages: [
      { duration: "5m", target: 100 },
      { duration: "5m", target: 300 },
      { duration: "5m", target: 500 },
      { duration: "10m", target: 500 },
      { duration: "5m", target: 0 },
    ],
  },

  // Spike test
  spikeTest: {
    stages: [
      { duration: "2m", target: 100 },
      { duration: "1m", target: 2000 }, // Sudden spike
      { duration: "2m", target: 100 },
    ],
  },

  // Soak test (endurance)
  soakTest: {
    stages: [
      { duration: "5m", target: 500 },
      { duration: "4h", target: 500 }, // Long duration
      { duration: "5m", target: 0 },
    ],
  },
};
```

## Success Thresholds

Every value below is a placeholder - replace it with a number derived from your SLO or
a measured baseline (see [Deriving Thresholds](#deriving-thresholds-do-not-hard-code-standard-numbers)).

```javascript
export const thresholds = {
  // Latency: use the SLO percentiles (or baseline + agreed headroom).
  http_req_duration: [
    "p(50)<P50_SLO",
    "p(95)<P95_SLO",
    "p(99)<P99_SLO",
  ],

  // Error rate: the error budget, e.g. "rate<0.01" for 1%.
  http_req_failed: ["rate<ERROR_BUDGET"],

  // Throughput floor: expected peak RPS.
  http_reqs: ["rate>PEAK_RPS"],

  // Custom journey metrics: give each its own SLO.
  checkout_duration: ["p(95)<CHECKOUT_P95_SLO"],
  checkout_success_rate: ["rate>CHECKOUT_SUCCESS_SLO"],
};
```

## Running Load Tests

Invoke k6 directly on a scenario script whose `options` already define the load
profile:

```bash
# options.stages sets the load profile - add no VU/duration flags here.
k6 run --out json=results.json load-tests/checkout-flow.js
```

Do NOT combine `--vus`/`--duration` with a script that defines `options.stages`: k6
rejects it because the CLI flags and the script configure different executors. Pick
ONE source of truth for the load profile:

- **Script-defined (recommended):** encode ramp-up / steady / ramp-down as
  `options.stages`; run with no sizing flags.
- **CLI-defined:** only for a script with no `options` - use either constant
  `--vus N --duration Xm` OR staged `--stage 2m:100 --stage 10m:100`; never both.

## Result Analysis

```typescript
interface LoadTestResult {
  scenario: string;
  timestamp: Date;
  metrics: {
    p50Latency: number;
    p95Latency: number;
    p99Latency: number;
    errorRate: number;
    throughput: number;
    maxVUs: number;
  };
  passed: boolean;
  notes: string[];
}

function analyzeResults(results: LoadTestResult) {
  console.log(\`Load Test: \${results.scenario}\`);
  console.log(\`Status: \${results.passed ? '✅ PASS' : '❌ FAIL'}\`);
  console.log(\`p95 Latency: \${results.metrics.p95Latency}ms\`);
  console.log(\`Error Rate: \${(results.metrics.errorRate * 100).toFixed(2)}%\`);
  console.log(\`Throughput: \${results.metrics.throughput} req/s\`);

  if (!results.passed) {
    console.log('Failed criteria:');
    results.notes.forEach(note => console.log(\`  - \${note}\`));
  }
}
```
