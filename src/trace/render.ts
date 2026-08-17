/**
 * Trajectory diagnostics rendering: ASCII views over analyzeTrajectory output.
 *
 * 与 replay 的水瀑布互补，诊断视图面向“定位失败”而非“通读过程”：
 * - findings：按严重度排序的问题清单（错误红色标记 ✗、警告 ⚠）；
 * - stage timeline：run 顶层阶段条，失败段标 [FAIL]；
 * - message flow：mailbox 消息链，卡死消息标 ⏳ WAITING；
 * - context usage：上下文用量条形曲线，>70% 标 ⚠；
 * - final report：最后一条消息全文展开 + 六字段校验违规明细。
 */
import {
  CONTEXT_USAGE_ALARM_PCT,
  type ContextUsagePoint,
  type FinalReportCheck,
  type TrajectoryDiagnostics,
  type TrajectoryFinding,
  type TrajectoryMessage,
} from './analysis';

const SEVERITY_GLYPH: Record<TrajectoryFinding['severity'], string> = {
  error: '✗',
  warning: '⚠',
  info: '·',
};

/** ASCII bar for a 0..100 percentage (8-level ramp). */
export function renderPercentBar(pct: number, width = 8): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const ramp = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const bar = ramp[Math.max(0, Math.min(width - 1, filled - 1))] ?? '▁';
  return bar.repeat(Math.max(1, filled)) + '▁'.repeat(Math.max(0, width - filled));
}

export function renderFindings(findings: TrajectoryFinding[]): string {
  if (findings.length === 0) return '── findings ──\n(no findings — run looks healthy)';
  const lines = ['── findings ──'];
  for (const finding of findings) {
    const glyph = SEVERITY_GLYPH[finding.severity];
    lines.push(
      `${glyph} ${finding.severity} ${finding.code}: ${finding.summary}` +
        (finding.span_id ? ` [span ${finding.span_id}]` : ''),
    );
    if (finding.detail) {
      for (const detailLine of finding.detail.split('\n')) lines.push(`    ${detailLine}`);
    }
  }
  return lines.join('\n');
}

export function renderStageTimeline(
  timeline: TrajectoryDiagnostics['stageTimeline'],
): string {
  const lines = ['── stage timeline ──'];
  if (timeline.length === 0) {
    lines.push('(no top-level stages)');
    return lines.join('\n');
  }
  for (const [index, item] of timeline.entries()) {
    const badge =
      item.status === 'failed'
        ? `[FAIL] ${String(item.failedCount)} failed span(s)`
        : item.status === 'open'
          ? '[open]'
          : '[ok]';
    const duration =
      item.spans[0]?.duration_ms !== undefined ? ` ${String(item.spans[0].duration_ms)}ms` : '';
    lines.push(`${String(index + 1).padStart(2)} ${badge.padEnd(22)} ${item.name}${duration}`);
  }
  return lines.join('\n');
}

export function renderStages(stages: TrajectoryDiagnostics['stages']): string {
  const lines = ['── stages (by span kind) ──'];
  if (stages.length === 0) {
    lines.push('(no spans)');
    return lines.join('\n');
  }
  for (const stage of stages) {
    const flag = stage.failedCount > 0 ? ' ✗ FAIL' : '';
    const duration =
      stage.total_ms !== undefined ? ` ${String(stage.total_ms)}ms` : '';
    lines.push(
      `  ${stage.name.padEnd(20)} spans=${String(stage.spanCount)} points=${String(stage.pointCount)}` +
        ` failed=${String(stage.failedCount)}${duration}${flag}`,
    );
  }
  return lines.join('\n');
}

export function renderMessageFlow(messages: TrajectoryMessage[]): string {
  const lines = ['── message flow ──'];
  if (messages.length === 0) {
    lines.push('(no mailbox messages in trajectory)');
    return lines.join('\n');
  }
  for (const message of messages) {
    const route = [message.from_agent_id, message.to_agent_id]
      .filter((id): id is string => id !== undefined)
      .join(' → ');
    const routePart = route.length > 0 ? `${route}  ` : '';
    const waitPart =
      message.status === 'acked'
        ? message.wait_ms !== undefined
          ? `acked in ${String(message.wait_ms)}ms`
          : 'acked'
        : `⏳ WAITING${message.requires_ack ? ' (never acked — deadlock risk)' : ''}`;
    lines.push(
      `  ${routePart}${message.message_type.padEnd(18)} ${waitPart}` +
        (message.acked_by ? ` by ${message.acked_by}` : ''),
    );
  }
  return lines.join('\n');
}

export function renderContextUsage(points: ContextUsagePoint[]): string {
  const lines = ['── context usage ──'];
  if (points.length === 0) {
    lines.push('(no usage points — LLM client did not report usage)');
    return lines.join('\n');
  }
  const rounds = points.map((point) => String(point.round).padStart(3)).join(' ');
  lines.push(`  round: ${rounds}`);
  const hasPct = points.some((point) => point.context_pct > 0);
  if (hasPct) {
    const maxPct = Math.max(...points.map((point) => point.context_pct));
    const maxRound = points.reduce((best, point) =>
      point.context_pct > best.context_pct ? point : best,
    ).round;
    const usage = points
      .map((point) => {
        const pct = Math.round(point.context_pct);
        const alarm = point.context_pct > CONTEXT_USAGE_ALARM_PCT ? ' ⚠' : '';
        return `${String(pct).padStart(3)}${alarm}`;
      })
      .join(' ');
    lines.push(`  usage: ${usage}`);
    lines.push(
      `  max ${Math.round(maxPct)}% at round ${String(maxRound)}` +
        (maxPct > CONTEXT_USAGE_ALARM_PCT
          ? ` ⚠ exceeds ${String(CONTEXT_USAGE_ALARM_PCT)}% alarm`
          : ''),
    );
    lines.push(`  bars: ${points.map((point) => renderPercentBar(point.context_pct)).join(' ')}`);
    return lines.join('\n');
  }
  // Token-only 曲线：LLM client 报了 tokens_in 但没有上下文窗口信息
  // （未配置 contextWindow）时，按 tokens_in 归一化画条形趋势。
  const maxTokens = Math.max(...points.map((point) => point.tokens_in ?? 0));
  const maxTokenRound = points.reduce((best, point) =>
    (point.tokens_in ?? 0) > (best.tokens_in ?? 0) ? point : best,
  ).round;
  const tokens = points
    .map((point) => String(point.tokens_in ?? 0).padStart(6))
    .join(' ');
  lines.push(`  tokens_in: ${tokens}`);
  lines.push(
    `  max ${String(maxTokens)} tokens in at round ${String(maxTokenRound)}` +
      ' (no context window configured)',
  );
  lines.push(
    `  bars: ${points
      .map((point) =>
        renderPercentBar(maxTokens > 0 ? ((point.tokens_in ?? 0) / maxTokens) * 100 : 0),
      )
      .join(' ')}`,
  );
  return lines.join('\n');
}

export function renderFinalReport(check: FinalReportCheck): string {
  const lines = ['── final report ──'];
  if (!check.found) {
    lines.push('(no final message content in trajectory)');
    return lines.join('\n');
  }
  const verdict =
    check.violations.length > 0
      ? `MALFORMED (${check.violations.length} violation(s))`
      : 'OK';
  lines.push(`  source: ${check.kind ?? 'unknown'} — ${verdict}`);
  for (const violation of check.violations) lines.push(`  ✗ ${violation}`);
  lines.push('  full message:');
  for (const messageLine of (check.message ?? '').split('\n')) {
    lines.push(`    ${messageLine}`);
  }
  return lines.join('\n');
}

/** Full diagnostics block: findings + stage views + message flow + usage + final report. */
export function renderDiagnostics(diag: TrajectoryDiagnostics): string {
  return [
    renderFindings(diag.findings),
    renderStageTimeline(diag.stageTimeline),
    renderStages(diag.stages),
    renderMessageFlow(diag.messages),
    renderContextUsage(diag.usagePoints),
    renderFinalReport(diag.finalReport),
  ].join('\n\n');
}

/** One-line summary used by --compare tables. */
export function summarizeDiagnostics(diag: TrajectoryDiagnostics): string {
  const errors = diag.findings.filter((finding) => finding.severity === 'error').length;
  const warnings = diag.findings.filter((finding) => finding.severity === 'warning').length;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${String(errors)} error(s)`);
  if (warnings > 0) parts.push(`${String(warnings)} warning(s)`);
  const mailWaiting = diag.messages.filter((message) => message.status === 'waiting').length;
  if (mailWaiting > 0) parts.push(`${String(mailWaiting)} message(s) waiting`);
  if (diag.finalReport.found && diag.finalReport.violations.length > 0) {
    parts.push('final report MALFORMED');
  }
  return parts.length > 0 ? parts.join(', ') : 'healthy';
}
