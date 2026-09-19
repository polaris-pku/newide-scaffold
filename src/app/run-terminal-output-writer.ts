/** Writes fallback terminal artifacts when the integration flow cannot finalize itself. */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunLatency, RunLatencyTotals } from '../telemetry';
import type { AppRunSnapshot } from './run-registry';
import { projectRunSnapshot } from './run-snapshot-projector';
import {
  isDriverStreamUsage,
  preferDriverUsage,
  projectTaskDriverUsage,
  type TaskDriverUsage,
} from './driver-usage-projector';
import {
  mergeBilledTokenUsage,
  type CollectClaudeSessionUsage,
} from './run-token-usage-merge';
import { collectClaudeSessionUsage } from '../telemetry';

export interface RunTerminalOutputWriter {
  finalize(snapshot: AppRunSnapshot): Promise<RunTerminalOutputEvidence | void>;
}

export interface RunTerminalOutputEvidence {
  artifact_ref: string;
  sha256: string;
}

/**
 * 一个环节（stage）的消耗。
 *
 * token 字段与账本（`LlmUsageTotals`）同名同义：`total_tokens` 含 cache，因此**不等于**
 * `input_tokens + output_tokens`。沿用账本口径而不是在此另立一套，是为了让
 * `summary.consumption` 与账本汇总可对齐；`summary.token_usage` 是另一条更早的口径，
 * 两者的差异见类文档。
 */
export interface RunConsumptionMetrics {
  events: number;
  llm_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** input + cache_creation + cache_read + output，与账本一致。 */
  total_tokens: number;
  /** 该 stage 的 span 合计耗时；没有 span 时为 0（不是「瞬间完成」）。 */
  duration_ms: number;
}

export interface RunConsumptionSummary {
  schema_version: 'newide.run_consumption.v1';
  totals: RunConsumptionMetrics;
  /** 按 stage 归集；无法归属到任何 stage 的事件落在 `unattributed`。 */
  by_stage: Record<string, RunConsumptionMetrics>;
  /** 全部 span 的按名合计；没有 span 时整个键省略。 */
  latency_by_name?: RunLatencyTotals['by_name'];
}

/** 归属不到 stage 的事件的桶名，与账本汇总里的桶同名。 */
const UNATTRIBUTED_STAGE = 'unattributed';

export class FileRunTerminalOutputWriter implements RunTerminalOutputWriter {
  constructor(
    private readonly runsRoot = '.newide/runs',
    /**
     * 耗时聚合的来源。`snapshot()` 会释放该 run 的内存缓冲，所以每个 run 只能取一次，
     * 而 `finalize` 每个 run 恰好跑一次首写（`summary.json` 用 `wx` 只建不改）。
     * 不注入时 `consumption` 里没有耗时，只剩事件与 token。
     */
    private readonly runLatency?: RunLatency,
    /**
     * driver 侧计费 token 的来源。默认刮 Claude Code 的 session JSONL；注入点是给
     * 测试用，免得碰真实的 `~/.claude`。
     */
    private readonly collectClaudeUsage: CollectClaudeSessionUsage = collectClaudeSessionUsage,
  ) {}

  async finalize(snapshot: AppRunSnapshot): Promise<RunTerminalOutputEvidence | undefined> {
    if (snapshot.status === 'running') return;
    const runDir = path.join(this.runsRoot, snapshot.run_id);
    await fs.mkdir(runDir, { recursive: true });
    const resultPath = path.join(runDir, 'result.json');
    const summaryPath = path.join(runDir, 'summary.json');
    const timelinePath = path.join(runDir, 'timeline.json');
    const frontendSnapshotPath = path.join(runDir, 'frontend-snapshot.json');

    const projected = projectRunSnapshot(snapshot);
    const tokenUsage = await projectTaskDriverUsage(this.runsRoot, snapshot.task_id);
    const consumption = summarizeRunConsumption(
      projected.timeline,
      this.runLatency?.snapshot(snapshot.run_id),
    );
    const fallbackWrites = [
      writeJsonIfMissing(resultPath, {
        ...projected,
        result_path: resultPath,
        summary_path: summaryPath,
        timeline_path: timelinePath,
        audit_path: path.join(runDir, 'audit.jsonl'),
        frontend_snapshot_path: frontendSnapshotPath,
      }),
      writeJsonIfMissing(
        summaryPath,
        buildBackendSummary(
          projected,
          {
            result_path: resultPath,
            summary_path: summaryPath,
            timeline_path: timelinePath,
            audit_path: path.join(runDir, 'audit.jsonl'),
            frontend_snapshot_path: frontendSnapshotPath,
          },
          tokenUsage,
          consumption,
        ),
      ),
      writeJsonIfMissing(timelinePath, snapshot.events),
    ];
    const serializedSnapshot = JSON.stringify(projected, null, 2);
    await Promise.all([
      ...fallbackWrites,
      fs.writeFile(frontendSnapshotPath, serializedSnapshot, 'utf-8'),
    ]);
    await mergeSummaryExtras(summaryPath, { driverUsage: tokenUsage, consumption });
    // driver 侧真实 coding agent 的计费 token 不进事件流，只能等 summary 落盘后从
    // Claude Code 的 session JSONL 刮取再并进来。放在这里而不是 B maintenance：
    // maintenance 由 buffer 触发，跑在 run 收尾之前，读不到 summary.json。
    await mergeBilledTokenUsage(summaryPath, this.collectClaudeUsage);
    return {
      artifact_ref: pathToFileURL(path.resolve(frontendSnapshotPath)).href,
      sha256: createHash('sha256').update(serializedSnapshot).digest('hex'),
    };
  }
}

function buildBackendSummary(
  projected: ReturnType<typeof projectRunSnapshot>,
  paths: {
    result_path: string;
    summary_path: string;
    timeline_path: string;
    audit_path: string;
    frontend_snapshot_path: string;
  },
  tokenUsage: TaskDriverUsage,
  consumption: RunConsumptionSummary,
): Record<string, unknown> {
  const delivery = projected.delivery_report;
  const finalOutput = projected.final_output;
  const worktreePath = delivery?.worktree_path;
  const filesWritten = finalOutput?.files_written ?? delivery?.files_written ?? [];
  const changedFiles = finalOutput?.changed_files ?? delivery?.changed_files ?? [];
  const artifactRefs = finalOutput?.artifact_refs ?? [];
  const memoryAblation = resolveMemoryAblation(projected.timeline);
  const proxyTokenUsage = resolveTokenUsageFromTimeline(projected.timeline);
  const outcome =
    finalOutput?.outcome ??
    delivery?.outcome ??
    (projected.status === 'completed' ? 'completed_response' : 'failed');

  return {
    run_id: projected.run_id,
    task_id: projected.task_id,
    mode: projected.mode,
    status: projected.status,
    outcome,
    ...(projected.quality ? { run_outcome: projected.quality } : {}),
    ...(delivery?.session_id ? { session_id: delivery.session_id } : {}),
    ...(delivery?.response ? { response: delivery.response } : {}),
    ...(worktreePath ? { worktree_path: worktreePath } : {}),
    files_written: [...filesWritten],
    changed_files: [...changedFiles],
    artifact_refs: [...artifactRefs],
    artifacts_materialized: projected.artifacts.length,
    ...(proxyTokenUsage ? { token_usage: proxyTokenUsage } : {}),
    consumption,
    ...(tokenUsage.available ? { driver_usage: tokenUsage } : {}),
    ...(memoryAblation ? { memory_ablation: memoryAblation } : {}),
    result_path: paths.result_path,
    summary_path: paths.summary_path,
    timeline_path: paths.timeline_path,
    audit_path: paths.audit_path,
    frontend_snapshot_path: paths.frontend_snapshot_path,
  };
}

/**
 * Prefer context_pack_built, but fall back to earlier ablation-tagged events.
 * Council rescue paths may skip context_pack_built when primary status !== completed.
 */
function resolveMemoryAblation(
  timeline: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>,
): string | undefined {
  const preferredTypes = [
    'memory.context_pack_built',
    'agent.execution_requested',
    'agent.execution_completed',
  ];
  for (const type of preferredTypes) {
    const value = timeline
      .filter((event) => event.type === type)
      .map((event) => event.payload.ablation ?? event.payload.memory_ablation)
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
    if (value) return value;
  }
  return timeline
    .map((event) => event.payload.ablation ?? event.payload.memory_ablation)
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
}

function resolveTokenUsageFromTimeline(
  timeline: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>,
):
  | {
      schema_version: 'newide.token_usage.v1';
      source: 'proxy';
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      total_input_tokens: number;
      total_tokens: number;
      call_count: number;
      sources: ['proxy'];
      by_source: {
        proxy: {
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          total_input_tokens: number;
          total_tokens: number;
          call_count: number;
        };
      };
    }
  | undefined {
  const usageEvents = timeline.filter((event) => event.type === 'proxy.llm_usage_recorded');
  if (usageEvents.length === 0) return undefined;
  let input = 0;
  let output = 0;
  for (const event of usageEvents) {
    const nextInput = Number(event.payload.input_tokens ?? 0);
    const nextOutput = Number(event.payload.output_tokens ?? 0);
    if (!Number.isFinite(nextInput) || !Number.isFinite(nextOutput)) continue;
    input += nextInput;
    output += nextOutput;
  }
  const proxy = {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_input_tokens: input,
    total_tokens: input + output,
    call_count: usageEvents.length,
  };
  return {
    schema_version: 'newide.token_usage.v1',
    source: 'proxy',
    ...proxy,
    sources: ['proxy'],
    by_source: { proxy },
  };
}

/**
 * 把终态才知道的块并进 `summary.json`。
 *
 * 首写用 `wx` 只建不改（见 `writeJsonIfMissing`），所以「文件已由别人先建好」时首写是
 * 空操作，这些块必须在写完之后再并一次，不能只依赖 `buildBackendSummary`。
 */
async function mergeSummaryExtras(
  summaryPath: string,
  extras: { driverUsage: TaskDriverUsage; consumption: RunConsumptionSummary },
): Promise<void> {
  const { driverUsage, consumption } = extras;
  try {
    const raw = JSON.parse(await fs.readFile(summaryPath, 'utf8')) as Record<string, unknown>;
    const preferred = preferDriverUsage(
      isDriverStreamUsage(raw.driver_usage) ? raw.driver_usage : raw.token_usage,
      driverUsage,
    );
    let changed = false;
    if (preferred && raw.driver_usage !== preferred) {
      raw.driver_usage = preferred;
      changed = true;
    }
    if (isDriverStreamUsage(raw.token_usage)) {
      delete raw.token_usage;
      changed = true;
    }
    if (raw.consumption === undefined) {
      raw.consumption = consumption;
      changed = true;
    }
    if (!changed) return;
    await fs.writeFile(summaryPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function emptyConsumptionMetrics(): RunConsumptionMetrics {
  return {
    events: 0,
    llm_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_tokens: 0,
    duration_ms: 0,
  };
}

/**
 * 按 stage 归集事件、token 与耗时。
 *
 * timeline 上没有统一的 stage 字段，只有 `handler.started` 的 `payload.cursor` 标出
 * 边界，所以按顺序走一遍：遇到边界就切换当前 stage，其后没有显式归属的事件都算给它。
 * 用量事件自带 `payload.stage_cursor`（由 LLM 调用点绑定的归属域写入），优先用它——
 * 比「夹在哪两个 handler 之间」准，比如 gate 的 token 可能落在 handler 边界之外。
 *
 * 与 `resolveTokenUsageFromTimeline` 的区别：那个只汇总 input/output，这里按账本口径
 * 把 cache 也算进 `total_tokens`。两者在今天的生产出口上一致（唯一的记账点不传 cache
 * 字段），一旦有人开始传就会分叉，分叉是刻意的：这一版是完整口径。
 *
 * 任何一步都不抛错——它跑在终态写盘路径上，观测算不出来只该少一块，不该弄挂 run。
 */
export function summarizeRunConsumption(
  timeline: ReadonlyArray<{ type: string; payload?: Record<string, unknown> }>,
  latency?: RunLatencyTotals,
): RunConsumptionSummary {
  const byStage = new Map<string, RunConsumptionMetrics>();
  const bucketFor = (stage: string): RunConsumptionMetrics => {
    const existing = byStage.get(stage);
    if (existing) return existing;
    const created = emptyConsumptionMetrics();
    byStage.set(stage, created);
    return created;
  };

  let currentStage = UNATTRIBUTED_STAGE;
  for (const event of timeline) {
    const payload = event.payload ?? {};
    // 边界事件算在它界定的那一侧：started 归它开启的 stage，completed 归它关闭的 stage。
    if (event.type === 'handler.started') {
      const cursor = readNonEmptyString(payload.cursor);
      if (cursor) currentStage = cursor;
    }
    const metrics = bucketFor(readNonEmptyString(payload.stage_cursor) ?? currentStage);
    metrics.events += 1;
    if (event.type !== 'proxy.llm_usage_recorded') {
      // 关窗要在归属之后：stage 结束后的 run.completed 之类的生命周期事件属于 run，
      // 硬塞给最后一个 stage 会让那个 stage 的事件数虚高。
      if (event.type === 'handler.completed') currentStage = UNATTRIBUTED_STAGE;
      continue;
    }
    const input = readFiniteNumber(payload.input_tokens);
    const output = readFiniteNumber(payload.output_tokens);
    const cacheCreation = readFiniteNumber(payload.cache_creation_input_tokens);
    const cacheRead = readFiniteNumber(payload.cache_read_input_tokens);
    metrics.llm_calls += 1;
    metrics.input_tokens += input;
    metrics.output_tokens += output;
    metrics.cache_creation_input_tokens += cacheCreation;
    metrics.cache_read_input_tokens += cacheRead;
    metrics.total_tokens += input + cacheCreation + cacheRead + output;
  }

  if (latency) {
    for (const [name, bucket] of Object.entries(latency.by_name)) {
      if (!name.startsWith('stage.')) continue;
      // 建桶而不是只改已有的：stage 有 span 却没有任何事件归到它名下时（归属被显式
      // stage_cursor 带走），耗时仍是真实发生过的，不该因为没事件就消失。
      bucketFor(name.slice('stage.'.length)).duration_ms = bucket.total_duration_ms;
    }
  }

  const totals = emptyConsumptionMetrics();
  for (const metrics of byStage.values()) {
    totals.events += metrics.events;
    totals.llm_calls += metrics.llm_calls;
    totals.input_tokens += metrics.input_tokens;
    totals.output_tokens += metrics.output_tokens;
    totals.cache_creation_input_tokens += metrics.cache_creation_input_tokens;
    totals.cache_read_input_tokens += metrics.cache_read_input_tokens;
    totals.total_tokens += metrics.total_tokens;
    totals.duration_ms += metrics.duration_ms;
  }

  return {
    schema_version: 'newide.run_consumption.v1',
    totals,
    by_stage: Object.fromEntries(
      [...byStage.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
    ...(latency && latency.span_count > 0 ? { latency_by_name: latency.by_name } : {}),
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function writeJsonIfMissing(filePath: string, value: unknown): Promise<void> {
  try {
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), { encoding: 'utf-8', flag: 'wx' });
  } catch (error) {
    if (isAlreadyExistsError(error)) return;
    throw error;
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
