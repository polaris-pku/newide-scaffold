# F 方向 Telemetry（观测层）

本模块为 **F 方向评测** 提供统一观测出口，负责把 B/C 运行时产生的信号（以及外部 Harness 的 L1 结果）写入 `TelemetrySink`。

**边界**：F 只**观测**，不补 B/C 业务逻辑。EventStore 里该 emit 什么、ResumePackage 怎么构建、Buffer 门控策略等，仍由 B/C 方向负责；缺失部分见文末「依赖 B/C 的缺口」。

依据文档：同目录 `埋点清单.md`（RFC §1–§4；文首 **§0 结果层 vs 归因层**）。

**执行优先级**：若目标是「能跑出评测结果」，只保证 **L1 harness 判卷**经 `FHarnessTelemetryPort`（或 `eval/` 的 `summary.json`）可落盘即可；§2/§3 细事件与全量 adapter 接线属归因层，不阻塞出分。评测命令与产物见 `eval/README.md`。

---

## 架构

```text
┌──────────────────────────────────────────────────────────────┐
│ L1 外部 Harness（SWE-EVO / CooperBench / Proxy / P2 Kill）    │
│   FHarnessTelemetryPort ──────────────────────► TelemetrySink │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ scaffold 运行时                                               │
│                                                               │
│  RuntimeOrchestrator.appendEvent()                            │
│    ├─► EventStore（C 事实，不变）                             │
│    └─► mirrorEventToTelemetry() ──► TelemetrySink           │
│                                                               │
│  RuntimeOrchestrator.saveCheckpoint()                         │
│    ├─► appendEvent('checkpoint.saved')  ──► mirror            │
│    └─► observeCheckpoint()            ──► TelemetrySink (L3)  │
│                                                               │
│  runTaskMemoryCycle() / Agent.runOnce()                       │
│    └─► recordMemoryCycleTelemetry()   ──► TelemetrySink (B)   │
└──────────────────────────────────────────────────────────────┘
```

### 模块职责

| 文件                         | 职责                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `event-catalog.ts`           | 清单中所有 event_type 的注册表与 owner（`F` / `B-owned-observed` / `C-owned-observed`）        |
| `telemetry-sink.ts`          | `TelemetrySink` 接口、`InMemoryTelemetrySink`、`emitTelemetry`、`mirrorEventToTelemetry`       |
| `event-builders.ts`          | F 自有 L1/L2 信号 builder（Harness、P2 kill 等）                                               |
| `adapters/b-memory.ts`       | 从 B 实体/返回值**观测**记忆管道信号（不写入 B 存储）                                          |
| `adapters/c-coordination.ts` | 从 C Event / Checkpoint / ResumePackage 等**观测**协调信号                                     |
| `adapters/c-council.ts`      | 从 Council 轮次 / Decision Packet / 审计字段**观测**互决策信号（adapter 就绪，等 C emit 接线） |
| `memory-cycle-observer.ts`   | 将 `runTaskMemoryCycle` 各阶段产物批量转为 B 观测记录                                          |
| `harness-port.ts`            | 外部 Harness 写入 L1 的统一端口                                                                |
| `emit.ts`                    | `emitTelemetryBatch` 批量写入辅助                                                              |

---

## 快速使用

### 1. Coordinator demo（C 事件自动 mirror）

```typescript
import { runBasicFlow } from '../coordinator';
import { InMemoryTelemetrySink } from '../telemetry';

const sink = new InMemoryTelemetrySink();
await runBasicFlow({ telemetry: sink });

console.log(sink.list().map((r) => r.event_type));
// task.created, memory.context_pack_built, driver.run_result,
// checkpoint.saved, coord.checkpoint_observed, ...
```

或直接构造 orchestrator：

```typescript
import { RuntimeOrchestrator } from '../coordinator';
import { InMemoryTelemetrySink } from '../telemetry';

const sink = new InMemoryTelemetrySink();
const orchestrator = new RuntimeOrchestrator({ telemetry: sink });

orchestrator.createTask({ spec: 'example' });
// sink 中自动出现 task.created（C-owned-observed）
```

**规则**：只有 `event-catalog.ts` 中登记过的 `event_type` 才会 mirror；`run.created`、`hook.matched` 等实现细节事件会被跳过。

### 2. Memory cycle（B 管道观测）

```typescript
import { runTaskMemoryCycle } from '../memory';
import { defaultMvpAgentRunDeps } from '../memory/mvp/default-agent-run-deps';
import { InMemoryTelemetrySink } from '../telemetry';

const sink = new InMemoryTelemetrySink();

await runTaskMemoryCycle(
  memoryScope,
  { spec: 'fix the bug', scenario: 'promotion_ready' },
  { ...defaultMvpAgentRunDeps, telemetry: sink },
  { memory_ablation: 'B2', run_id: 'run_123' }, // 可选 MemoryCycleOptions
);

// sink 中出现：memory.context_pack_built → driver.run_result →
// buffer.report_received → memory.extraction_triggered →
// memory.extraction_completed → metrics.updated [→ memory.skill_promoted]
```

也可通过 `AgentRunDeps.telemetry` 注入，`Agent.runOnce()` 会自动沿用。

**说明**：memory-cycle 路径**不写 EventStore**（B 正式 EventStore 契约尚未冻结），F 通过 adapter 直接从 cycle 产物观测。

### 3. 外部 Harness（L1）

```typescript
import { InMemoryTelemetrySink, createFHarnessTelemetryPort } from '../telemetry';

const port = createFHarnessTelemetryPort(new InMemoryTelemetrySink());

await port.recordSweEvoEvaluation({
  instance_id: 'django__django-1234',
  instance_seq: 2,
  resolved: true,
  applied: true,
  p2p_regression: false,
  memory_ablation: 'B2',
});

await port.recordAgentCrash({
  task_id: 'task_1',
  kill_at: 'after_tool_call',
  progress_pct: 50,
  tool_call_count: 5,
  had_checkpoint: true,
  kill_at_status: 'running',
});
```

L1 记录 `owner === 'F'`，不进 EventStore；Harness 自行落盘或导出 `TelemetryRecord[]`。

### 4. 自定义 Sink

实现 `TelemetrySink` 接口即可对接 JSONL、Parquet、远程采集等：

```typescript
import type { TelemetryRecord, TelemetrySink } from '../telemetry';

class JsonlTelemetrySink implements TelemetrySink {
  emit(record: TelemetryRecord): void {
    console.log(JSON.stringify(record));
  }
}
```

---

## TelemetryRecord 形状

每条记录包含：

- `telemetry_id`, `event_type`, `owner`, `subject_id`
- 可选 `subject_type`, `run_id`, `task_id`
- `payload`（观测字段）
- `source`（`harness` / `event_store` / `b_memory` / `c_coordination` 等）
- `created_at`, `schema_version`

`owner` 区分信号归属：

| owner              | 含义                                   |
| ------------------ | -------------------------------------- |
| `F`                | F Harness 或评测控制器产生             |
| `B-owned-observed` | B 域数据，F 只读观测                   |
| `C-owned-observed` | C 域 EventStore 事件或实体，F 只读观测 |

---

## 已接入 vs 未接入（相对 `埋点清单.md`）

### 已接入（§1/§2 + §3/§4 本 PR）

| 路径                                 | 清单信号                                                                                                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RuntimeOrchestrator.appendEvent`    | catalog 中所有 C/B L2 事件（随 EventStore 自动 mirror），含 **`council.decision`**                                                                                                                                   |
| `RuntimeOrchestrator.saveCheckpoint` | `checkpoint.saved` + L3 `coord.checkpoint_observed`                                                                                                                                                                  |
| `runTaskMemoryCycle`                 | `memory.context_pack_built`, `driver.run_result`, `memory.experience_referenced`, `buffer.report_received`, `memory.extraction_triggered`, `memory.extraction_completed`, `metrics.updated`, `memory.skill_promoted` |
| `FHarnessTelemetryPort`              | L1 `harness.*`（含 **`harness.swe_bench_verified_evaluated`** / **`harness.testbed_regression_checked`**）、`proxy.*`（含 Fair-Setup 字段）；L2 `eval.agent_crash`, `eval.cold_restart`                              |
| `adapters/c-council.ts`              | `observeCouncilRound` / `observeDecisionPacket` / `observeCoordinationTrace` / `observeTokenTracker`（单测验证 shape；运行时未接线）                                                                                 |

### 依赖 B/C、尚未接入（adapter 已备好或 catalog 已登记）

> 下表为**归因层**缺口，**不阻塞**「eval 出 summary / L1 判卷」。结果层验收见同目录 `埋点清单.md` §0.2。

| 缺口                                    | 说明                                                                                                  | F 侧准备                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Council 多轮 emit                       | `council.started` / `council.review_round_end` / `council.completed` / `council.extraction_completed` | catalog ✓；`observeCouncilRound()` 就绪；等 C emit        |
| Council 审计实体                        | Decision Packet / coordination_trace / token_tracker                                                  | `observeDecisionPacket()` 等 L3 adapter 就绪；等 C/B 产出 |
| `task.escalated`                        | B.2 死锁分子                                                                                          | catalog ✓；等 C Coordinator emit                          |
| `council.decision` payload 扩展         | `termination_reason`, `current_round_count`, `decision_packet_ref`                                    | mirror ✓；扩 payload 待 C                                 |
| C resume 链                             | `task.checkpoint_resume` → ResumePackage → `task.started`                                             | `observeResumePackage()`                                  |
| C 消息/租约                             | `agent.message_send/recv`, `MessageDelivery`, `FileLease`                                             | `observeMessageDelivery()`, `observeFileLease()`          |
| C 系统事件                              | `system.timeout`, `system.budget_exceeded`, `lifecycle.human_gate`                                    | catalog 已登记，等 C emit                                 |
| Checkpoint 七项                         | `message_thread`, `scheduling`, `se_domain_state`                                                     | `observeCheckpoint()` 已可承载，需 C 补 schema            |
| B 置信度/Persona                        | `memory.confidence_updated`, `memory.persona_updated`                                                 | `observeConfidenceUpdated()`, `observePersonaUpdated()`   |
| B 异步门控                              | `memory.extraction_triggered` 真实 trigger（capacity/time/priority）                                  | 当前 MVP 同步处理，trigger=`immediate`                    |
| B Agent 生命周期                        | `memory.agent_lifecycle`                                                                              | `observeAgentLifecycle()`                                 |
| Event `subject_type`                    | L2 信封可选字段                                                                                       | TelemetryRecord 已支持；core `Event` 未扩展               |
| `checkpoint.saved` → `agent.checkpoint` | C Spec 别名/双写                                                                                      | catalog 两者均已登记                                      |
| §4 评测侧工程                           | SWE-bench Verified 主控 / Testbed / Docker / 仿真模拟器                                               | L1 builder + port ✓；聚合脚本在 scaffold 外               |
| `.newide/run_audit.json`                | §3 B.1–B.5 审计落盘                                                                                   | 全无；Coordinator 实现 `dumpFEvalAudit`                   |

---

## 开发与测试

```bash
pnpm verify          # lint + typecheck + test
pnpm test test/telemetry*.ts
```

相关测试：

- `test/telemetry.test.ts` — catalog / adapter 单元测试
- `test/telemetry-integration.test.ts` — basic-flow mirror、memory-cycle、Harness port 集成测试

---

## 扩展指南

1. **新增 F 观测 event**：在 `event-catalog.ts` 登记 → 添加 builder 或 adapter → 在调用点 `emitTelemetry` / `mirrorEventToTelemetry`
2. **C 新增 EventStore emit**：只需保证 `event_type` 在 catalog 中；orchestrator mirror 会自动采集
3. **B 新增管道节点**：在对应 service 返回处调用已有 `observe*` 函数，**不要**在 telemetry 模块里写 B 业务逻辑
