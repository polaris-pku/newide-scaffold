/**
 * DriverReturnConverter — 将方向 A 的 DriverRunResult 转换为方向 B 的 DriverReturn（六字段报告）
 *
 * 本模块解决 A→B 的数据形态转换问题：
 * - 方向 A 产出 DriverRunResult（artifacts + transcript + tool_events + diagnostics）
 * - 方向 B 需要 DriverReturn（artifacts + summary + decisions + blockers +
 *   referenced_experiences + assumptions）
 *
 * 提供多级转换策略，按优先级降级：
 * 1. tryReadReportFile — 从 workspace 下 {taskId}_report.txt 直接读取
 *    （Agent 被 ACP_WRITE_REPORT_FILE=1 指令写入的报告文件）
 * 2. parseDriverReturnFromTranscript — 从 transcript 中解析结构化 JSON 块
 *    （Driver 被 prompt 指示产出 <<<DRIVER_RETURN>>> 标记块）
 * 3. LLM 解析 — 调用 LLM 根据 transcript + DriverRunResult 生成六字段报告
 *    （可选：仅在提供 LlmClient 且 transcript 无结构化块时启用）
 * 4. constructDriverReturnFromResult — 从 DriverRunResult 元数据构造
 *    （最终降级：无 transcript 或前述策略全部失败时的基本报告）
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DriverReturnSchema, type DriverReturn } from '../memory/schemas';
import type { LlmClient } from '../memory/ports/llm-client';
import type { DriverRunResult } from './contract';
import type { ArtifactRef } from '../core';

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

/** DriverRunResult → DriverReturn 的转换函数签名（支持异步） */
export type DriverReturnConverter = (
  result: DriverRunResult,
  options?: DriverReturnConverterOptions,
) => DriverReturn | Promise<DriverReturn>;

/** 转换选项 */
export interface DriverReturnConverterOptions {
  /** 可选：Driver transcript 的文本内容（如果已加载） */
  transcriptText?: string;
  /** 可选：原始 DriverTask 指令 */
  instruction?: string;
  /** 可选：标记来源 Driver */
  sourceDriver?: string;
  /** 可选：任务 ID，用于定位 {taskId}_report.txt */
  taskId?: string;
  /** 可选：workspace 路径，Agent 写入 report.txt 的目录 */
  workspace?: string;
}

// ──────────────────────────────────────────────
// 策略0：从 Agent 写入的 report.txt 文件读取
// ──────────────────────────────────────────────

/**
 * 尝试从 workspace 目录下读取 {taskId}_report.txt 并解析为 DriverReturn。
 *
 * 这是最高优先级的转换策略：当 Agent 按照 ACP_WRITE_REPORT_FILE 指令
 * 将六字段报告写入了文件时，直接读取即可获得最准确的报告。
 *
 * @returns 解析出的 DriverReturn，文件不存在或解析失败则返回 null
 */
function tryReadReportFile(taskId: string, workspace: string): DriverReturn | null {
  const filePath = path.join(workspace, `${taskId}_report.txt`);
  if (!existsSync(filePath)) {
    console.error(`[DriverReturnConverter] report file not found: ${filePath}`);
    return null;
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (readError) {
    const reason = readError instanceof Error ? readError.message : String(readError);
    console.error(`[DriverReturnConverter] failed to read report file ${filePath}: ${reason}`);
    return null;
  }

  if (!content.trim()) {
    console.error(`[DriverReturnConverter] report file is empty: ${filePath}`);
    return null;
  }

  // 跳过前导非法字符，定位第一个 JSON 对象的起始 '{'
  const jsonStart = content.indexOf('{');
  if (jsonStart === -1) {
    console.error(
      `[DriverReturnConverter] report file contains no JSON object (no '{' found): ${filePath}`,
    );
    return null;
  }

  // 丢弃第一个 '{' 之前的全部内容（如 <<<DRIVER_RETURN>>> 标记等）
  const cleanedContent = jsonStart > 0 ? content.slice(jsonStart) : content;

  const jsonText = extractJsonObject(cleanedContent, 0);
  if (!jsonText) {
    console.error(
      `[DriverReturnConverter] report file contains unbalanced braces — could not extract a complete JSON object: ${filePath}`,
    );
    return null;
  }

  if (jsonText.length < cleanedContent.trimEnd().length) {
    const skipped = cleanedContent.trimEnd().length - jsonText.length;
    console.error(
      `[DriverReturnConverter] report file had ${skipped} trailing character(s) after the JSON object — stripped before parsing`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (jsonError) {
    const reason = jsonError instanceof Error ? jsonError.message : String(jsonError);
    console.error(
      `[DriverReturnConverter] report file extracted JSON is invalid (${filePath}): ${reason}`,
    );
    return null;
  }

  try {
    const report = DriverReturnSchema.parse(parsed) as DriverReturn;

    // 解析成功后，默认清理 report 文件（可通过 ACP_KEEP_REPORT_FILE=1 保留）
    const keepFile =
      process.env.ACP_KEEP_REPORT_FILE === '1' || process.env.ACP_KEEP_REPORT_FILE === 'true';
    if (!keepFile) {
      try {
        unlinkSync(filePath);
        console.error(
          `[DriverReturnConverter] report file deleted after successful parse: ${filePath}`,
        );
      } catch (deleteError) {
        const reason = deleteError instanceof Error ? deleteError.message : String(deleteError);
        console.error(
          `[DriverReturnConverter] failed to delete report file ${filePath}: ${reason}`,
        );
      }
    }

    return report;
  } catch (schemaError) {
    const reason = schemaError instanceof Error ? schemaError.message : String(schemaError);
    console.error(
      `[DriverReturnConverter] report file JSON failed schema validation (${filePath}): ${reason}`,
    );
    return null;
  }
}

// ──────────────────────────────────────────────
// 策略1：从 transcript 解析结构化报告
// ──────────────────────────────────────────────

/**
 * 尝试从 Driver 的 transcript 文本中解析 DriverReturn。
 *
 * 支持两种格式：
 * - 完整 JSON 块：```json { "artifacts": ..., "summary": ..., ... } ```
 * - 六字段分块标记：<<<DRIVER_RETURN>>> ... <<<END_DRIVER_RETURN>>>
 *
 * @returns 解析出的 DriverReturn，解析失败则返回 null
 */
export function parseDriverReturnFromTranscript(transcriptText: string): DriverReturn | null {
  // 策略 A：匹配 <<<DRIVER_RETURN>>> ... <<<END_DRIVER_RETURN>>> 标记块
  const taggedMatch = transcriptText.match(
    /<<<DRIVER_RETURN>>>\s*([\s\S]*?)\s*<<<END_DRIVER_RETURN>>>/,
  );
  if (taggedMatch?.[1]) {
    try {
      return JSON.parse(taggedMatch[1]) as DriverReturn;
    } catch {
      // 继续尝试其他策略
    }
  }

  // 策略 B：匹配 JSON 代码块
  const jsonBlockMatch = transcriptText.match(
    /```(?:json)?\s*(\{[\s\S]*?"artifacts"[\s\S]*?"summary"[\s\S]*?\})\s*```/,
  );
  if (jsonBlockMatch?.[1]) {
    try {
      return JSON.parse(jsonBlockMatch[1]) as DriverReturn;
    } catch {
      // 继续尝试其他策略
    }
  }

  // 策略 C：匹配裸 JSON 对象（包含六字段特征）
  const bareJsonMatch = transcriptText.match(
    /\{\s*"artifacts"\s*:\s*\[[\s\S]*?"summary"\s*:\s*"[\s\S]*?"decisions"\s*:\s*\[/,
  );
  if (bareJsonMatch) {
    // 从匹配位置开始找完整的 JSON 对象
    const startIndex = bareJsonMatch.index!;
    const jsonText = extractJsonObject(transcriptText, startIndex);
    if (jsonText) {
      try {
        return JSON.parse(jsonText) as DriverReturn;
      } catch {
        // 解析失败
      }
    }
  }

  return null;
}

/**
 * 从字符串的指定位置开始提取完整 JSON 对象。
 * 通过大括号计数确保提取到完整的闭合对象。
 */
function extractJsonObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i++) {
    const char = text[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

// ──────────────────────────────────────────────
// 策略2：从 DriverRunResult 元数据构造报告
// ──────────────────────────────────────────────

/**
 * 从 DriverRunResult 的元数据构造 DriverReturn。
 *
 * 这是当 Driver 没有产出结构化六字段报告时的降级策略：
 * - artifacts 直接映射
 * - summary 从 diagnostics + tool_events 拼接
 * - decisions 从 tool_events 推导基本决策链
 * - blockers 从 error / 失败状态推导
 * - referenced_experiences 和 assumptions 留空（无源数据）
 */
export function constructDriverReturnFromResult(
  result: DriverRunResult,
  options?: DriverReturnConverterOptions,
): DriverReturn {
  return {
    artifacts: mapArtifacts(result.artifacts),
    summary: buildSummary(result, options),
    decisions: buildDecisions(result, options),
    blockers: buildBlockers(result),
    referenced_experiences: [],
    assumptions: buildAssumptions(result),
  };
}

// ──────────────────────────────────────────────
// 策略3：调用 LLM 生成六字段报告
// ──────────────────────────────────────────────

const LLM_DRIVER_RETURN_SYSTEM_PROMPT = [
  'You are a DriverReturn report generator.',
  'Given a DriverRunResult, produce a structured six-field DriverReturn report in JSON.',
  '',
  'The six fields are:',
  '1. artifacts: produced artifacts with type, path, summary',
  '2. summary: natural language summary of task execution',
  '3. decisions: key decision points with options, chosen choice, and reason',
  '4. blockers: blockers encountered with attempts, resolution, and resolved status',
  '5. referenced_experiences: referenced experiences (empty array if none)',
  '6. assumptions: assumptions made and their risks if wrong',
  '',
  'Output JSON only with this exact format:',
  '{',
  '  "artifacts": [',
  '    { "type": "...", "path": "...", "summary": "..." }',
  '  ],',
  '  "summary": "...",',
  '  "decisions": [',
  '    { "point": "...", "options": ["..."], "chosen": "...", "reason": "..." }',
  '  ],',
  '  "blockers": [',
  '    { "blocker": "...", "attempts": ["..."], "resolution": "...", "resolved": true }',
  '  ],',
  '  "referenced_experiences": [],',
  '  "assumptions": [',
  '    { "assumption": "...", "risk_if_wrong": "..." }',
  '  ]',
  '}',
].join('\n');

function buildLlmPrompt(result: DriverRunResult, options?: DriverReturnConverterOptions): string {
  const sections: string[] = [];

  sections.push(`## Task Instruction\n${options?.instruction ?? '(not provided)'}`);

  sections.push(
    `## Driver Execution Result\n` +
      `- driver_id: ${result.diagnostics.driver_id}\n` +
      `- status: ${result.status}\n` +
      `- duration_ms: ${result.diagnostics.duration_ms}\n` +
      `- driver_run_result_id: ${result.driver_run_result_id}\n` +
      `- session_id: ${result.session_id}`,
  );

  if (result.artifacts.length > 0) {
    sections.push(
      `## Artifacts\n${result.artifacts
        .map(
          (a) => `- type: ${a.type}, uri: ${a.uri}, producer: ${a.producer_id}, task: ${a.task_id}`,
        )
        .join('\n')}`,
    );
  } else {
    sections.push('## Artifacts\n(none)');
  }

  if (result.tool_events.length > 0) {
    sections.push(
      `## Tool Events\n${result.tool_events
        .map((t) => `- ${t.tool_name}: ${t.status} (${t.summary})`)
        .join('\n')}`,
    );
  } else {
    sections.push('## Tool Events\n(none)');
  }

  if (result.diagnostics.notes.length > 0) {
    sections.push(
      `## Diagnostics Notes\n${result.diagnostics.notes.map((n) => `- ${n}`).join('\n')}`,
    );
  }

  if (result.error) {
    sections.push(
      `## Error\n` +
        `- code: ${result.error.code}\n` +
        `- message: ${result.error.message}\n` +
        `- retryable: ${result.error.retryable}`,
    );
  }

  return sections.join('\n\n');
}

function parseLlmDriverReturn(raw: string): DriverReturn {
  const parsed = JSON.parse(raw) as unknown;
  return DriverReturnSchema.parse(parsed);
}

/**
 * 创建基于 LLM 的 DriverReturnConverter。
 *
 * 委托到 createDefaultDriverReturnConverter(llm)，
 * 因此完整优先级为：report 文件 → transcript 直接解析 → LLM 解析 → 元数据构造。
 *
 * 使用示例：
 * ```ts
 * const llm = new LiteLLMClientAdapter('driver-return-generation');
 * const converter = createLlmDriverReturnConverter(llm);
 * const driverReturn = await converter(driverRunResult, { transcriptText, instruction, taskId, workspace });
 * ```
 */
export function createLlmDriverReturnConverter(llm: LlmClient): DriverReturnConverter {
  return createDefaultDriverReturnConverter(llm);
}

// ──────────────────────────────────────────────
// 默认转换器（策略组合）
// ──────────────────────────────────────────────

/**
 * 创建默认的 DriverReturnConverter。
 *
 * @param llm 可选的 LlmClient。提供后，当 transcript 无结构化 JSON 块时，
 *            会尝试用 LLM 从 transcript 推理生成六字段报告。
 *
 * 四级降级链（按优先级）：
 * 1. 从 workspace 下 {taskId}_report.txt 读取并解析（最高优先）
 * 2. 从 transcript 文本直接解析结构化 JSON 块
 * 3. 调用 LLM 根据 transcript + metadata 推理生成（仅在提供 llm 时启用）
 * 4. 从 DriverRunResult 元数据构造（最终降级）
 *
 * 使用示例：
 * ```ts
 * // 无 LLM — 两条降级路径
 * const converter = createDefaultDriverReturnConverter();
 *
 * // 有 LLM — 三条降级路径
 * const llm = new LiteLLMClientAdapter('driver-return-generation');
 * const converter = createDefaultDriverReturnConverter(llm);
 *
 * const driverReturn = await converter(driverRunResult, {
 *   transcriptText,
 *   instruction,
 *   taskId,
 *   workspace,
 * });
 * ```
 */
export function createDefaultDriverReturnConverter(llm?: LlmClient): DriverReturnConverter {
  return async (
    result: DriverRunResult,
    options?: DriverReturnConverterOptions,
  ): Promise<DriverReturn> => {
    const src = options?.sourceDriver ?? result.diagnostics.driver_id;

    // ── 优先级1：从 Agent 写入的 report.txt 文件读取 ──
    if (options?.taskId && options?.workspace) {
      const fromFile = tryReadReportFile(options.taskId, options.workspace);
      if (fromFile) {
        console.error(
          `[DriverReturnConverter] six-field report loaded from ${options.taskId}_report.txt (source: ${src})`,
        );
        return fromFile;
      }
    }

    // ── 优先级2：从 transcript 直接解析结构化 JSON ──
    if (options?.transcriptText) {
      const parsed = parseDriverReturnFromTranscript(options.transcriptText);
      if (parsed) {
        console.error(
          `[DriverReturnConverter] six-field report generated via JSON parsing (source: ${src})`,
        );
        return parsed;
      }
      console.error(
        `[DriverReturnConverter] transcript extraction failed: no structured report found in transcript (source: ${src})`,
      );
    }

    // ── 优先级3：LLM 推理（从 transcript 或 metadata 生成，仅在提供 llm 时启用）──
    if (llm) {
      try {
        const userPrompt = buildLlmPrompt(result, options);
        const raw = await llm.complete({
          messages: [
            { role: 'system', content: LLM_DRIVER_RETURN_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          responseFormat: { type: 'json_object' },
        });

        try {
          const driverReturn = parseLlmDriverReturn(raw);
          console.error(
            `[DriverReturnConverter] six-field report generated via LLM (source: ${src})`,
          );
          return driverReturn;
        } catch (parseError) {
          const reason = parseError instanceof Error ? parseError.message : String(parseError);
          console.error(
            `[DriverReturnConverter] LLM output was malformed (${reason}); falling back to construction (source: ${src})`,
          );
        }
      } catch (llmError) {
        const reason = llmError instanceof Error ? llmError.message : String(llmError);
        console.error(
          `[DriverReturnConverter] LLM call error (${reason}); falling back to construction (source: ${src})`,
        );
      }
    }

    // ── 优先级4（最终降级）：元数据构造 ──
    console.error(
      `[DriverReturnConverter] six-field report generated via construction (source: ${src})`,
    );
    return constructDriverReturnFromResult(result, options);
  };
}

function mapArtifacts(artifacts: ArtifactRef[]): DriverReturn['artifacts'] {
  return artifacts.map((a) => ({
    type: a.type,
    path: a.uri,
    summary: a.metadata?.prompt_length
      ? `Produced by ${a.producer_id}, task ${a.task_id}`
      : `${a.type} artifact from ${a.producer_id}`,
  }));
}

function buildSummary(result: DriverRunResult, options?: DriverReturnConverterOptions): string {
  const parts: string[] = [];

  // 任务指令摘要
  if (options?.instruction) {
    const shortInstruction =
      options.instruction.length > 100
        ? options.instruction.slice(0, 100) + '...'
        : options.instruction;
    parts.push(`Task: "${shortInstruction}"`);
  }

  // 执行状态
  parts.push(
    `Driver "${result.diagnostics.driver_id}" finished with status "${result.status}" ` +
      `in ${result.diagnostics.duration_ms}ms.`,
  );

  // 产物摘要
  if (result.artifacts.length > 0) {
    const artifactList = result.artifacts.map((a) => `${a.type}(${a.uri})`).join(', ');
    parts.push(`Produced ${result.artifacts.length} artifact(s): ${artifactList}.`);
  } else {
    parts.push('No artifacts produced.');
  }

  // 工具调用摘要
  if (result.tool_events.length > 0) {
    const toolSummary = result.tool_events
      .map((t) => `${t.tool_name}: ${t.status} (${t.summary})`)
      .join('; ');
    parts.push(`Tool events: ${toolSummary}.`);
  }

  // 诊断备注
  if (result.diagnostics.notes.length > 0) {
    parts.push(`Notes: ${result.diagnostics.notes.join('; ')}.`);
  }

  // 错误信息
  if (result.error) {
    parts.push(
      `Error: [${result.error.code}] ${result.error.message}` +
        `${result.error.retryable ? ' (retryable)' : ''}.`,
    );
  }

  return parts.join(' ');
}

function buildDecisions(
  result: DriverRunResult,
  options?: DriverReturnConverterOptions,
): DriverReturn['decisions'] {
  const decisions: DriverReturn['decisions'] = [];

  // 从 tool_events 推导基本决策点
  for (const event of result.tool_events) {
    decisions.push({
      point: `Tool execution: ${event.tool_name}`,
      options: ['execute', 'skip'],
      chosen: event.status === 'completed' ? 'execute' : 'skip',
      reason: event.summary || `Tool ${event.tool_name} ${event.status}.`,
    });
  }

  // Driver 级别的关键决策
  if (options?.instruction) {
    decisions.push({
      point: 'Task execution approach',
      options: ['delegate_to_driver', 'handle_directly'],
      chosen: 'delegate_to_driver',
      reason: `Task "${options.instruction.slice(0, 80)}" delegated to driver "${result.diagnostics.driver_id}".`,
    });
  }

  if (result.status === 'failed' && result.error) {
    decisions.push({
      point: 'Error handling',
      options: ['retry', 'fail'],
      chosen: result.error.retryable ? 'retry' : 'fail',
      reason: `Error [${result.error.code}]: ${result.error.message}`,
    });
  }

  return decisions;
}

function buildBlockers(result: DriverRunResult): DriverReturn['blockers'] {
  const blockers: DriverReturn['blockers'] = [];

  if (result.error) {
    blockers.push({
      blocker: result.error.message,
      attempts: result.diagnostics.notes,
      resolution: result.error.retryable
        ? 'Pending retry (error is retryable)'
        : 'Task failed (error is not retryable)',
      resolved: false,
    });
  }

  if (result.status === 'cancelled') {
    blockers.push({
      blocker: 'Driver execution was cancelled',
      attempts: [],
      resolution: 'Task cancelled externally',
      resolved: true,
    });
  }

  if (result.status === 'interrupted') {
    blockers.push({
      blocker: 'Driver execution was interrupted',
      attempts: [],
      resolution: 'Pending resumption or retry',
      resolved: false,
    });
  }

  return blockers;
}

function buildAssumptions(result: DriverRunResult): DriverReturn['assumptions'] {
  const assumptions: DriverReturn['assumptions'] = [];

  assumptions.push({
    assumption: `Driver "${result.diagnostics.driver_id}" correctly executed the task`,
    risk_if_wrong: 'Output may be incomplete or incorrect; requires manual review of artifacts',
  });

  if (result.artifacts.length > 0) {
    assumptions.push({
      assumption: `All ${result.artifacts.length} artifact(s) are valid and complete`,
      risk_if_wrong: 'Missing or corrupted artifacts could cause downstream failures',
    });
  }

  if (result.status !== 'succeeded') {
    assumptions.push({
      assumption: `Driver status "${result.status}" accurately reflects the execution outcome`,
      risk_if_wrong: 'Status mismatch could lead to incorrect flow decisions (retry vs. fail)',
    });
  }

  return assumptions;
}
