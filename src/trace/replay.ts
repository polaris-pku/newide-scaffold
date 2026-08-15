/**
 * Trajectory replay: merge append-only records into spans, rebuild the
 * parent/child tree, detect parallel siblings, and render a reviewable
 * waterfall — the 复盘 view over a run's trajectory.jsonl.
 *
 * Parallelism is detected structurally: siblings whose intervals overlap by
 * record order (start before the previous sibling ended) are rendered as a
 * parallel group, matching the DeepSeek Harness render-time projection.
 */
import type { RunId } from '../core';
import type { MergedTrajectorySpan, TrajectorySpanRecord } from './types';

export interface TrajectoryTreeNode {
  span: MergedTrajectorySpan;
  children: TrajectoryTreeNode[];
  /** True when this node runs in parallel with its previous sibling. */
  parallel: boolean;
}

export interface TrajectoryReplayResult {
  run_id: string;
  records: TrajectorySpanRecord[];
  spans: MergedTrajectorySpan[];
  tree: TrajectoryTreeNode[];
  rendered: string;
}

/** Internal merged span carrying the append-stream ordinals used for overlap detection. */
interface InternalMergedSpan extends MergedTrajectorySpan {
  ordinal: number;
  endOrdinal: number;
}

/** Merge start/end records by span_id; points pass through. Order follows the append stream. */
export function mergeSpans(records: TrajectorySpanRecord[]): MergedTrajectorySpan[] {
  interface MergedBuilder {
    start?: TrajectorySpanRecord;
    end?: TrajectorySpanRecord;
    endOrdinal?: number;
    ordinal: number;
  }
  const builders = new Map<string, MergedBuilder>();
  const order: string[] = [];

  records.forEach((record, ordinal) => {
    let builder = builders.get(record.span_id);
    if (!builder) {
      builder = { ordinal };
      order.push(record.span_id);
    }
    if (record.phase === 'start' && !builder.start) builder.start = record;
    else if (record.phase === 'end') {
      builder.end = record;
      builder.endOrdinal = ordinal;
    } else if (record.phase === 'point' && !builder.start && !builder.end) {
      builder.start = record;
      builder.end = record;
      builder.endOrdinal = ordinal;
    }
    builders.set(record.span_id, builder);
  });

  const spans: InternalMergedSpan[] = [];
  for (const spanId of order) {
    const builder = builders.get(spanId)!;
    const start = builder.start ?? builder.end;
    if (!start) continue;
    const end = builder.end;
    const isSpan = end === undefined ? start.phase === 'start' : end !== start;
    const ordinal = builder.ordinal;
    const base: MergedTrajectorySpan = {
      span_id: spanId,
      kind: start.kind,
      phase: isSpan ? 'span' : 'point',
      ...(start.run_id ? { run_id: start.run_id } : {}),
      ...(start.task_id ? { task_id: start.task_id } : {}),
      ...(start.parent_span_id ? { parent_span_id: start.parent_span_id } : {}),
      ...(start.parallel_group_id ? { parallel_group_id: start.parallel_group_id } : {}),
      ...(start.agent_id ? { agent_id: start.agent_id } : {}),
      ...(start.summary ? { summary: start.summary } : {}),
      ...(start.started_at ? { started_at: start.started_at } : {}),
      sequence: start.sequence,
      created_at: start.created_at,
    };
    if (isSpan) {
      spans.push({
        ...base,
        ...(end?.status ? { status: end.status } : {}),
        ...(end?.ended_at ? { ended_at: end.ended_at } : {}),
        ...(end?.duration_ms !== undefined ? { duration_ms: end.duration_ms } : {}),
        ...(end?.summary && end.summary !== start.summary ? { summary: end.summary } : {}),
        ...(end?.payload ? { payload: end.payload } : {}),
        ordinal,
        endOrdinal: builder.endOrdinal ?? ordinal,
      });
    } else {
      spans.push({ ...base, ordinal, endOrdinal: ordinal });
    }
  }
  return spans.sort((left, right) => left.ordinal - right.ordinal);
}

/** Rebuild the parent/child tree and mark parallel sibling groups. */
export function buildSpanTree(spans: MergedTrajectorySpan[]): TrajectoryTreeNode[] {
  const ordered = spans as InternalMergedSpan[];
  const byId = new Map<string, InternalMergedSpan>();
  for (const span of ordered) byId.set(span.span_id, span);

  // Resolve the effective parent: the explicit parent link when valid, else the
  // deepest lifecycle span that is still open at this span's ordinal. This keeps
  // parentless point records (checkpoint, artifact, ...) inside the enclosing
  // span instead of leaking to the root of the tree.
  const effectiveParents = new Map<string, string | undefined>();
  const openStack: InternalMergedSpan[] = [];
  for (const span of ordered) {
    while (openStack.length > 0 && openStack.at(-1)!.endOrdinal < span.ordinal) {
      openStack.pop();
    }
    const explicit =
      span.parent_span_id && byId.has(span.parent_span_id) ? span.parent_span_id : undefined;
    // Parentless point records (checkpoint, artifact, ...) attach to the deepest
    // open lifecycle span; lifecycle spans keep their explicit parent (or root).
    const parent =
      explicit ??
      (span.phase === 'point' && openStack.length > 0 ? openStack.at(-1)!.span_id : undefined);
    effectiveParents.set(span.span_id, parent);
    if (span.phase === 'span') openStack.push(span);
  }

  const byParent = new Map<string | undefined, InternalMergedSpan[]>();
  for (const span of ordered) {
    const parentKey = effectiveParents.get(span.span_id);
    const group = byParent.get(parentKey) ?? [];
    group.push(span);
    byParent.set(parentKey, group);
  }
  const buildChildren = (parentKey: string | undefined): TrajectoryTreeNode[] => {
    const siblings = byParent.get(parentKey) ?? [];
    const nodes: TrajectoryTreeNode[] = [];
    let groupEnd = -1;
    for (const span of siblings) {
      const parallel = span.ordinal < groupEnd;
      if (!parallel) groupEnd = span.endOrdinal;
      else groupEnd = Math.max(groupEnd, span.endOrdinal);
      nodes.push({
        span,
        parallel,
        children: buildChildren(span.span_id),
      });
    }
    return nodes;
  };
  return buildChildren(undefined);
}

/** Render the replay tree as a readable ASCII waterfall. */
export function renderTrajectory(tree: TrajectoryTreeNode[]): string {
  const lines: string[] = [];
  const renderNode = (node: TrajectoryTreeNode, depth: number, parallel: boolean): void => {
    const span = node.span;
    const indent = '  '.repeat(depth);
    const marker = parallel ? '∥' : span.phase === 'point' ? '•' : '›';
    const agent = span.agent_id ? ` [${span.agent_id}]` : '';
    const status = span.phase === 'span' && span.status ? ` ${span.status}` : '';
    const duration =
      span.phase === 'span'
        ? ` ${span.duration_ms !== undefined ? `${span.duration_ms}ms` : '—'}`
        : '';
    const summary = span.summary ? `  ${span.summary}` : '';
    lines.push(`${indent}${marker} ${span.kind}${agent}${status}${duration}${summary}`);
    for (const child of node.children) renderNode(child, depth + 1, child.parallel);
  };
  for (const node of tree) renderNode(node, 0, false);
  return lines.join('\n');
}

/** Full replay pipeline: records -> merged spans -> tree -> rendered text. */
export function replayTrajectory(records: TrajectorySpanRecord[], runId: RunId): TrajectoryReplayResult {
  const spans = mergeSpans(records);
  const tree = buildSpanTree(spans);
  return {
    run_id: runId,
    records,
    spans,
    tree,
    rendered: renderTrajectory(tree),
  };
}
