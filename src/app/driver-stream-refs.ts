/**
 * payload_ref 的取回工具：事件载荷超限字段指回 driver-stream.jsonl 的原始行，
 * 这里按引用把完整事件取回来。
 *
 * 引用形如 `driver-stream.jsonl#sequence=<n>`，相对 run 目录解析：
 * `<runsRoot>/<runId>/driver-stream.jsonl` 里 `event.sequence === n` 的那一行。
 * 文件被保留策略截断、或 run 目录不存在时返回 undefined——引用是尽力而为的
 * 观测通道，取不到不应让调用方失败。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DriverStreamEvent } from '../driver/contract';

export interface DriverStreamAuditLine {
  schema_version: string;
  run_id: string;
  task_id: string;
  recorded_at: string;
  /** 保留策略截断标记行：没有 event 字段，读取方跳过即可。 */
  truncated?: boolean;
  event?: DriverStreamEvent;
}

const REF_PATTERN = /^driver-stream\.jsonl#sequence=(\d+)$/;

/** 解析引用里的 sequence；引用形状不对返回 undefined。 */
export function parseDriverStreamRef(ref: string): number | undefined {
  const match = REF_PATTERN.exec(ref);
  return match ? Number(match[1]) : undefined;
}

/** 读取一个 run 的全部审计行（含截断标记行）。文件不存在返回空数组。 */
export async function readDriverStreamAuditLines(
  runsRoot: string,
  runId: string,
): Promise<DriverStreamAuditLine[]> {
  const filePath = path.join(runsRoot, runId, 'driver-stream.jsonl');
  const raw = await fs.readFile(filePath, 'utf8').catch(() => undefined);
  if (raw === undefined) return [];
  const lines: DriverStreamAuditLine[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as DriverStreamAuditLine;
      if (parsed && typeof parsed === 'object') lines.push(parsed);
    } catch {
      // 坏行跳过：审计文件是追加写的，不能因一行脏数据放弃整份。
    }
  }
  return lines;
}

/** 按引用取回原始事件；取不到返回 undefined。 */
export async function resolveDriverStreamRef(
  runsRoot: string,
  runId: string,
  ref: string,
): Promise<DriverStreamEvent | undefined> {
  const sequence = parseDriverStreamRef(ref);
  if (sequence === undefined) return undefined;
  const lines = await readDriverStreamAuditLines(runsRoot, runId);
  for (const line of lines) {
    if (line.event?.sequence === sequence) return line.event;
  }
  return undefined;
}
