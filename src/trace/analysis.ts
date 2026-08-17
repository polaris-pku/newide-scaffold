/**
 * Trajectory analysis: replay-time diagnostics over a run's linear trajectory
 * records that turn raw spans into problem-localizing findings.
 *
 * 面向 SWE-EVO council 实验暴露的失败模式（mailbox 路由卡死、最终报告六字段
 * 格式损坏、计划未物化、上下文爆掉收尾失忆），在回放层做可自动判定的检查：
 * - 消息链重建：mailbox sent/acked 按 message_id 配对，悬空消息即路由卡死点；
 * - 阶段统计：按 span kind 聚合阶段，失败段（error/timeout/cancelled）高亮；
 * - 最终消息六字段 schema 校验：artifacts 必须为数组，违规即格式损坏；
 * - 上下文用量曲线：agent.llm 点 → >70% 报警（上下文爆掉风险）；
 * - 物化检查：run 成功结束却无 worktree 文件写入 / artifact.delivered。
 * 本模块只做纯数据推导，渲染（ASCII 视图）在 render.ts。
 */
import type { MergedTrajectorySpan, TrajectorySpanRecord } from './types';
import { buildSpanTree, mergeSpans, type TrajectoryTreeNode } from './replay';

export type FindingSeverity = 'error' | 'warning' | 'info';

export interface TrajectoryFinding {
  severity: FindingSeverity;
  /** Stable machine-readable code, e.g. `message.unacked`. */
  code: string;
  span_id?: string;
  summary: string;
  /** Long text (full final message, violation details); expanded on demand. */
  detail?: string;
}

export type TrajectoryMessageStatus = 'acked' | 'waiting';

/** One mailbox message reconstructed from sent/acked agent.message records. */
export interface TrajectoryMessage {
  message_id: string;
  message_type: string;
  from_agent_id?: string;
  to_agent_id?: string;
  requires_ack: boolean;
  sent_at: string;
  acked_at?: string;
  acked_by?: string;
  status: TrajectoryMessageStatus;
  /** Sent→acked elapsed ms; undefined while waiting. */
  wait_ms?: number;
}

/** One LLM round's context usage point (agent.llm record). */
export interface ContextUsagePoint {
  round: number;
  agent_id?: string;
  tokens_in?: number;
  tokens_out?: number;
  context_size?: number;
  context_limit?: number;
  /** 0..100; derived from size/limit when the source only reports those. */
  context_pct: number;
  created_at: string;
}

/** Result of validating the run's final message against the six-field report schema. */
export interface FinalReportCheck {
  found: boolean;
  /** Span kind that carried the final message (agent.turn / driver.run / ...). */
  kind?: string;
  /** Final message full text, ready for one-key expansion. */
  message?: string;
  parsed?: Record<string, unknown>;
  violations: string[];
}

/** Per-kind stage statistics over merged spans (point records included). */
export interface TrajectoryStage {
  name: string;
  spanCount: number;
  pointCount: number;
  failedCount: number;
  total_ms?: number;
  spans: MergedTrajectorySpan[];
}

/** One step of the top-level stage timeline (direct children of the run span). */
export interface TrajectoryStageTimelineItem {
  name: string;
  status: 'ok' | 'failed' | 'open';
  failedCount: number;
  spans: MergedTrajectorySpan[];
}

export interface TrajectoryDiagnostics {
  findings: TrajectoryFinding[];
  messages: TrajectoryMessage[];
  usagePoints: ContextUsagePoint[];
  finalReport: FinalReportCheck;
  stages: TrajectoryStage[];
  stageTimeline: TrajectoryStageTimelineItem[];
}

/**
 * Message types that require an explicit mailbox ack before the flow proceeds.
 * Kept for events that omit the `requires_ack` payload field; the payload flag
 * (when present) always wins. Note: task.assigned is NOT acked in the v0 flow
 * (only driver.requested carries an acked_delivery), so it is not listed.
 */
const ACK_REQUIRED_TYPES: readonly string[] = ['driver.requested'];

/** Context usage alarm threshold (percent). */
export const CONTEXT_USAGE_ALARM_PCT = 70;

const SIX_FIELD_KEYS: readonly string[] = [
  'artifacts',
  'summary',
  'decisions',
  'blockers',
  'referenced_experiences',
  'assumptions',
];

// ────────────────────────────────────────────
// 消息链重建
// ────────────────────────────────────────────

interface SentMessage {
  message_id: string;
  message_type: string;
  from_agent_id?: string;
  to_agent_id?: string;
  requires_ack: boolean;
  sent_at: string;
  /** True when the sent record carried a real mailbox message_id (not a fallback). */
  hasPayloadMessageId: boolean;
}

interface AckRecord {
  message_id: string;
  message_type?: string;
  acked_by?: string;
  acked_at: string;
}

function payloadOf(span: MergedTrajectorySpan): Record<string, unknown> {
  return span.payload ?? {};
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function buildMessages(records: TrajectorySpanRecord[]): TrajectoryMessage[] {
  const sent = new Map<string, SentMessage>();
  for (const record of records) {
    if (record.kind !== 'agent.message' || record.phase !== 'point') continue;
    const payload = record.payload ?? {};
    const messageType = stringField(payload, 'message_type');
    if (!messageType) continue;
    const payloadMessageId = stringField(payload, 'message_id');
    const messageId = payloadMessageId ?? record.source_event_id ?? record.span_id;
    const ackedBy = stringField(payload, 'acked_by');
    if (ackedBy !== undefined) continue; // ack records are matched below
    const requiresAck =
      payload.requires_ack === true || ACK_REQUIRED_TYPES.includes(messageType);
    const fromAgentId = stringField(payload, 'from_agent_id');
    const toAgentId = stringField(payload, 'to_agent_id');
    sent.set(messageId, {
      message_id: messageId,
      message_type: messageType,
      ...(fromAgentId ? { from_agent_id: fromAgentId } : {}),
      ...(toAgentId ? { to_agent_id: toAgentId } : {}),
      requires_ack: requiresAck,
      sent_at: record.created_at,
      hasPayloadMessageId: payloadMessageId !== undefined,
    });
  }
  const acks: AckRecord[] = [];
  for (const record of records) {
    if (record.kind !== 'agent.message' || record.phase !== 'point') continue;
    const payload = record.payload ?? {};
    const messageId = stringField(payload, 'message_id');
    if (!messageId) continue;
    const ackedBy = stringField(payload, 'acked_by');
    if (ackedBy === undefined && payload.status !== 'acked') continue;
    const ackMessageType = stringField(payload, 'message_type');
    acks.push({
      message_id: messageId,
      ...(ackMessageType !== undefined ? { message_type: ackMessageType } : {}),
      ...(ackedBy ? { acked_by: ackedBy } : {}),
      acked_at: record.created_at,
    });
  }
  // Exact match first; fall back to type + recipient when the sent record was
  // written before payload message_id augmentation (older trajectory files).
  const matchAck = (message: SentMessage): AckRecord | undefined => {
    const exact = acks.find((ack) => ack.message_id === message.message_id);
    if (exact) return exact;
    if (message.hasPayloadMessageId) return undefined;
    return acks.find(
      (ack) =>
        ack.message_type === message.message_type &&
        message.to_agent_id !== undefined &&
        ack.acked_by === message.to_agent_id,
    );
  };
  const messages: TrajectoryMessage[] = [];
  for (const [messageId, message] of sent) {
    const ack = matchAck(message);
    const waitMs =
      ack !== undefined ? timestampDiffMs(message.sent_at, ack.acked_at) : undefined;
    messages.push({
      message_id: messageId,
      message_type: message.message_type,
      ...(message.from_agent_id ? { from_agent_id: message.from_agent_id } : {}),
      ...(message.to_agent_id ? { to_agent_id: message.to_agent_id } : {}),
      requires_ack: message.requires_ack,
      sent_at: message.sent_at,
      ...(ack ? { acked_at: ack.acked_at } : {}),
      ...(ack?.acked_by ? { acked_by: ack.acked_by } : {}),
      status: ack ? 'acked' : 'waiting',
      ...(waitMs !== undefined && Number.isFinite(waitMs) ? { wait_ms: waitMs } : {}),
    });
  }
  return messages.sort((left, right) => left.sent_at.localeCompare(right.sent_at));
}

function timestampDiffMs(from: string, to: string): number | undefined {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return undefined;
  const diff = toMs - fromMs;
  return diff >= 0 ? diff : undefined;
}

function findingsForMessages(messages: TrajectoryMessage[]): TrajectoryFinding[] {
  const findings: TrajectoryFinding[] = [];
  for (const message of messages) {
    if (message.status !== 'waiting') continue;
    const route = [message.from_agent_id, message.to_agent_id]
      .filter((id): id is string => id !== undefined)
      .join(' → ');
    const routePart = route.length > 0 ? ` (${route})` : '';
    if (message.requires_ack) {
      findings.push({
        severity: 'error',
        code: 'message.unacked',
        summary:
          `mailbox message "${message.message_type}"${routePart} sent at ` +
          `${message.sent_at} never acked — 路由卡死：接收方会话可能没有 mailbox 工具，` +
          `wait_for_reply 永远等不到回复`,
        detail:
          `message_id: ${message.message_id}\n` +
          `requires_ack: true\n` +
          `sent_at: ${message.sent_at}\n` +
          `status: waiting (no ack record found)`,
      });
    } else {
      findings.push({
        severity: 'info',
        code: 'message.unanswered',
        summary: `mailbox message "${message.message_type}"${routePart} has no ack record`,
        detail: `message_id: ${message.message_id}\nsent_at: ${message.sent_at}`,
      });
    }
  }
  return findings;
}

// ────────────────────────────────────────────
// 阶段统计 + 阶段条
// ────────────────────────────────────────────

function isFailed(span: MergedTrajectorySpan): boolean {
  return (
    span.phase === 'span' &&
    (span.status === 'error' || span.status === 'timeout' || span.status === 'cancelled')
  );
}

function buildStages(spans: MergedTrajectorySpan[]): TrajectoryStage[] {
  const byKind = new Map<string, MergedTrajectorySpan[]>();
  for (const span of spans) {
    const group = byKind.get(span.kind) ?? [];
    group.push(span);
    byKind.set(span.kind, group);
  }
  const stages: TrajectoryStage[] = [];
  for (const [name, group] of byKind) {
    const spansOfKind = [...group].sort((a, b) => a.sequence - b.sequence);
    const totalMs = sumDurationMs(spansOfKind);
    stages.push({
      name,
      spanCount: spansOfKind.filter((span) => span.phase === 'span').length,
      pointCount: spansOfKind.filter((span) => span.phase === 'point').length,
      failedCount: spansOfKind.filter(isFailed).length,
      ...(totalMs !== undefined ? { total_ms: totalMs } : {}),
      spans: spansOfKind,
    });
  }
  return stages.sort((left, right) => left.name.localeCompare(right.name));
}

function sumDurationMs(spans: MergedTrajectorySpan[]): number | undefined {
  const durations = spans
    .map((span) => span.duration_ms)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  return durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) : undefined;
}

function buildStageTimeline(tree: TrajectoryTreeNode[]): TrajectoryStageTimelineItem[] {
  const runRoot = tree.find(
    (node) => node.span.kind === 'run' || node.span.kind === 'task.run',
  );
  const timelineNodes = runRoot ? runRoot.children : tree;
  return timelineNodes.map((node) => {
    const failedCount = countFailed(node);
    const status: TrajectoryStageTimelineItem['status'] =
      failedCount > 0 ? 'failed' : node.span.status === 'open' ? 'open' : 'ok';
    return {
      name: node.span.kind,
      status,
      failedCount,
      spans: [node.span],
    };
  });
}

function countFailed(node: TrajectoryTreeNode): number {
  let count = isFailed(node.span) ? 1 : 0;
  for (const child of node.children) count += countFailed(child);
  return count;
}

// ────────────────────────────────────────────
// 最终消息六字段校验
// ────────────────────────────────────────────

/** Validate a message against the six-field report schema (SWE-EVO council contract). */
export function checkSixFieldReport(text: string): {
  parsed?: Record<string, unknown>;
  violations: string[];
} {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { violations: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const looksLikeReport =
      trimmed.includes('artifacts') ||
      trimmed.includes('referenced_experiences') ||
      trimmed.includes('blockers');
    return {
      violations: looksLikeReport
        ? ['final message looks like a structured report but is not valid JSON']
        : [],
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      violations: ['final message must be a JSON object (six-field report)'],
    };
  }
  const report = parsed as Record<string, unknown>;
  const violations: string[] = [];
  if ('artifacts' in report) {
    const artifacts = report.artifacts;
    if (!Array.isArray(artifacts)) {
      violations.push(
        `artifacts must be an array of paths or {type,path,summary} objects ` +
          `(got ${typeof artifacts === 'object' && artifacts !== null ? JSON.stringify(Object.keys(artifacts)) : typeof artifacts})`,
      );
    } else {
      const badItem = artifacts.findIndex(
        (item) => typeof item !== 'string' && (typeof item !== 'object' || item === null),
      );
      if (badItem >= 0) {
        violations.push(`artifacts[${badItem}] must be a path string or {type,path,summary} object`);
      }
    }
  }
  for (const key of SIX_FIELD_KEYS) {
    if (key === 'artifacts' || !(key in report)) continue;
    const value = report[key];
    if (value === null || (typeof value !== 'string' && !Array.isArray(value))) {
      violations.push(`${key} must be a string or array (got ${typeof value})`);
    }
  }
  return { parsed: report, violations };
}

function buildFinalReportCheck(spans: MergedTrajectorySpan[]): FinalReportCheck {
  const messageCandidates = spans
    .filter((span) => span.phase === 'span')
    .sort((a, b) => a.sequence - b.sequence)
    .reverse();
  for (const span of messageCandidates) {
    const payload = payloadOf(span);
    const output = payload.output;
    const outputContent =
      typeof output === 'object' && output !== null && !Array.isArray(output)
        ? stringField(output as Record<string, unknown>, 'content')
        : undefined;
    const content =
      span.kind === 'agent.turn' || span.kind === 'driver.run'
        ? stringField(payload, 'content') ?? outputContent
        : undefined;
    if (content === undefined) continue;
    const check = checkSixFieldReport(content);
    return {
      found: true,
      kind: span.kind,
      message: content,
      ...(check.parsed ? { parsed: check.parsed } : {}),
      violations: check.violations,
    };
  }
  return { found: false, violations: [] };
}

// ────────────────────────────────────────────
// 上下文用量
// ────────────────────────────────────────────

function buildUsagePoints(records: TrajectorySpanRecord[]): ContextUsagePoint[] {
  const points: ContextUsagePoint[] = [];
  for (const record of records) {
    if (record.kind !== 'agent.llm' || record.phase !== 'point') continue;
    const payload = record.payload ?? {};
    const round = typeof payload.round === 'number' ? payload.round : points.length + 1;
    const size = numberField(payload, 'context_size');
    const limit = numberField(payload, 'context_limit');
    const rawPct = numberField(payload, 'context_pct');
    const contextPct =
      rawPct ??
      (size !== undefined && limit !== undefined && limit > 0 ? (size / limit) * 100 : 0);
    const tokensIn = numberField(payload, 'tokens_in');
    const tokensOut = numberField(payload, 'tokens_out');
    points.push({
      round,
      ...(record.agent_id ? { agent_id: record.agent_id } : {}),
      ...(tokensIn !== undefined ? { tokens_in: tokensIn } : {}),
      ...(tokensOut !== undefined ? { tokens_out: tokensOut } : {}),
      ...(size !== undefined ? { context_size: size } : {}),
      ...(limit !== undefined ? { context_limit: limit } : {}),
      context_pct: contextPct,
      created_at: record.created_at,
    });
  }
  return points.sort((a, b) => a.round - b.round);
}

function numberField(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function findingsForUsage(points: ContextUsagePoint[]): TrajectoryFinding[] {
  const alarmed = points.filter((point) => point.context_pct > CONTEXT_USAGE_ALARM_PCT);
  if (alarmed.length === 0) return [];
  const rounds = alarmed.map((point) => point.round).join(', ');
  const max = Math.max(...alarmed.map((point) => point.context_pct));
  const agentPart =
    alarmed[0]?.agent_id !== undefined ? ` (agent ${alarmed[0].agent_id})` : '';
  return [
    {
      severity: 'warning',
      code: 'context.high_usage',
      summary:
        `context usage exceeded ${String(CONTEXT_USAGE_ALARM_PCT)}% at rounds [${rounds}]` +
        `${agentPart} (max ${Math.round(max)}%) — 上下文接近爆掉，收尾阶段可能失忆`,
      detail: alarmed
        .map(
          (point) =>
            `round ${point.round}: ${Math.round(point.context_pct)}%` +
            (point.context_size !== undefined ? ` (${point.context_size} tokens)` : ''),
        )
        .join('\n'),
    },
  ];
}

// ────────────────────────────────────────────
// 物化检查
// ────────────────────────────────────────────

function hasMaterializationEvidence(spans: MergedTrajectorySpan[]): boolean {
  for (const span of spans) {
    if (span.kind === 'artifact' && span.phase === 'point') {
      const payload = payloadOf(span);
      // Example flow: artifact.delivered (status ok). Production flow: the
      // deliver stage emits an artifact point carrying manifest references.
      if (span.status === 'ok') return true;
      if (payload.manifest_id !== undefined || payload.changeset_manifest_ref !== undefined) {
        return true;
      }
    }
    if (span.kind === 'worktree' && span.phase === 'point') {
      const payload = payloadOf(span);
      const filesWritten =
        typeof payload.files_written === 'number' ? payload.files_written : undefined;
      if (filesWritten !== undefined && filesWritten > 0) return true;
      // Production worktree.materialized carries a changeset manifest ref
      // instead of a file count.
      if (payload.changeset_manifest_ref !== undefined) return true;
    }
  }
  return false;
}

function runEndStatus(spans: MergedTrajectorySpan[]): TrajectorySpanRecord['status'] | undefined {
  const runSpans = spans
    .filter((span) => (span.kind === 'run' || span.kind === 'task.run') && span.phase === 'span')
    .sort((a, b) => a.sequence - b.sequence);
  return runSpans.at(-1)?.status;
}

// ────────────────────────────────────────────
// 入口
// ────────────────────────────────────────────

/** Run every replay-time diagnostic over a run's trajectory records. */
export function analyzeTrajectory(records: TrajectorySpanRecord[]): TrajectoryDiagnostics {
  const spans = mergeSpans(records);
  const messages = buildMessages(records);
  const usagePoints = buildUsagePoints(records);
  const finalReport = buildFinalReportCheck(spans);
  const stages = buildStages(spans);
  const tree = replayTree(records);
  const stageTimeline = buildStageTimeline(tree);

  const findings: TrajectoryFinding[] = [
    ...findingsForMessages(messages),
    ...findingsForUsage(usagePoints),
  ];

  if (finalReport.found && finalReport.violations.length > 0) {
    findings.push({
      severity: 'error',
      code: 'final_report.malformed',
      summary: `final message (${finalReport.kind ?? 'unknown'}) violates the report schema: ${finalReport.violations[0]}`,
      detail: finalReport.violations.join('\n'),
    });
  }

  const endStatus = runEndStatus(spans);
  const materialized = hasMaterializationEvidence(spans);
  if (endStatus === 'ok' && !materialized) {
    findings.push({
      severity: 'warning',
      code: 'materialization.missing',
      summary:
        'run completed ok but no worktree files were written and no artifact was delivered — ' +
        '计划/实现可能只产出了报告，交付物未物化',
    });
  }

  findings.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.code.localeCompare(b.code) ||
      a.summary.localeCompare(b.summary),
  );

  return {
    findings,
    messages,
    usagePoints,
    finalReport,
    stages,
    stageTimeline,
  };
}

function severityRank(severity: FindingSeverity): number {
  if (severity === 'error') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

function replayTree(records: TrajectorySpanRecord[]): TrajectoryTreeNode[] {
  return buildSpanTree(mergeSpans(records));
}
