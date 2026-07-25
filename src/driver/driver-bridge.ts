/**
 * DriverBridge — 接通方向 B 和方向 A 的 Driver 适配桥
 *
 * 将方向 A 的 DriverRuntimeHandle（底层 Driver 执行接口）封装为
 * 方向 B 的 DriverHandler（InvokeDriverTool 的插槽函数签名）。
 *
 * 核心职责：
 * 1. 接收 DriverTask（方向 B 的子任务描述）
 * 2. 转换为 DriverPrompt（方向 A 的执行提示词）
 * 3. 调用 DriverRuntimeHandle.sendPrompt() 获取 DriverRunResult
 * 4. 通过 DriverReturnConverter 将结果转换为 DriverReturn（六字段报告）
 *
 * ── 架构位置 ──
 *
 *   方向 B (Memory)                    方向 A (Driver)
 *   ┌──────────────────┐              ┌─────────────────────┐
 *   │ InvokeDriverTool │── 调用 ──→  │  DriverRuntimeHandle │
 *   │   (DriverHandler)│              │  (sendPrompt)        │
 *   │                  │              │                      │
 *   │     ↑            │              │  MockDriver           │
 *   │     │            │              │  ExternalDriverRuntime│
 *   │  DriverBridge ◄──┼── 桥接 ──── │  (CommandDriver...)   │
 *   │  (本模块)         │              │                      │
 *   └──────────────────┘              └─────────────────────┘
 *
 * ── 使用示例 ──
 *
 * ```ts
 * import { MockDriver } from './mock-driver';
 * import { DriverBridge } from './driver-bridge';
 * import { InvokeDriverTool } from '../memory/runtime/tools/invoke-driver-tool';
 *
 * // 1. 创建方向 A 的 Driver
 * const mockDriver = new MockDriver();
 *
 * // 2. 创建桥接
 * const bridge = new DriverBridge({ driver: mockDriver });
 *
 * // 3. 创建 InvokeDriverTool（注入 handler）
 * const driverTool = new InvokeDriverTool(bridge.createHandler());
 *
 * // 4. 顶层 Agent 通过 tool-calling 使用
 * const result = await driverTool.execute({
 *   instruction: 'Fix the build: TypeScript compilation errors in src/',
 *   context: { skills: ['typescript', 'build-system'] },
 * });
 * // result 是 DriverReturn（六字段报告）
 * ```
 */

import { createId, nowTimestamp, SCHEMA_VERSION } from '../core';
import type { DriverRuntimeHandle, DriverPrompt, DriverRunResult } from './contract';
import {
  createDefaultDriverReturnConverter,
  type DriverReturnConverter,
  type DriverReturnConverterOptions,
} from './driver-return-converter';
import type { DriverReturn } from '../memory/schemas';
import type { DriverTask, DriverHandler } from '../memory/runtime/tools/invoke-driver-tool';

// ──────────────────────────────────────────────
// DriverBridge 配置
// ──────────────────────────────────────────────

export interface DriverBridgeOptions {
  /** 方向 A 的 Driver 运行时句柄（MockDriver / ExternalDriverRuntime 等） */
  driver: DriverRuntimeHandle;

  /**
   * 可选：DriverRunResult → DriverReturn 的自定义转换器。
   * 默认使用 createDefaultDriverReturnConverter()。
   *
   * 自定义场景：
   * - 使用特定 Driver 的已知输出格式
   */
  converter?: DriverReturnConverter;

  /**
   * 可选：是否加载 transcript 文本用于解析结构化报告。
   * 默认 false。
   *
   * 启用后，DriverBridge 在转换前会尝试加载 transcript 文本，
   * 以便从 <<<DRIVER_RETURN>>> 标记块中解析六字段报告。
   */
  loadTranscript?: boolean;

  /**
   * 可选：transcript 加载器。
   * 如果不提供且 loadTranscript 为 true，将尝试通过
   * driver.collectTranscript() 获取引用后自行加载。
   */
  transcriptLoader?: (transcriptRef: string) => Promise<string>;
}

// ──────────────────────────────────────────────
// DriverBridge 实现
// ──────────────────────────────────────────────

export class DriverBridge {
  private readonly driver: DriverRuntimeHandle;
  private readonly converter: DriverReturnConverter;
  private readonly loadTranscript: boolean;
  private readonly transcriptLoader: ((transcriptRef: string) => Promise<string>) | undefined;

  constructor(options: DriverBridgeOptions) {
    this.driver = options.driver;
    this.converter = options.converter ?? createDefaultDriverReturnConverter();
    this.loadTranscript = options.loadTranscript ?? false;
    this.transcriptLoader = options.transcriptLoader;
  }

  /** 获取内部 Driver 句柄（只读） */
  getDriverHandle(): DriverRuntimeHandle {
    return this.driver;
  }

  /**
   * 创建 DriverHandler — InvokeDriverTool 的插槽函数。
   *
   * 返回的函数签名 (task: DriverTask) => Promise<DriverReturn>
   * 可直接注入 InvokeDriverTool 构造函数。
   */
  createHandler(): DriverHandler {
    return async (task: DriverTask): Promise<DriverReturn> => {
      return this.invokeDriver(task);
    };
  }

  /**
   * 调用 Driver 执行子任务，返回六字段报告。
   *
   * 完整流程：
   * ```
   * DriverTask → DriverPrompt → DriverRuntimeHandle.sendPrompt()
   *   → DriverRunResult → DriverReturnConverter → DriverReturn
   * ```
   *
   * @param task 方向 B 的子任务描述
   * @returns DriverReturn 六字段报告
   */
  async invokeDriver(task: DriverTask): Promise<DriverReturn> {
    const startedAt = nowTimestamp();

    // 1. 构造 DriverPrompt
    const prompt = this.buildDriverPrompt(task);

    // 2. 调用方向 A 的 Driver
    let driverResult: DriverRunResult;
    try {
      driverResult = await this.driver.sendPrompt(prompt);
    } catch (error) {
      // Driver 调用失败时构造一个失败的 DriverRunResult
      driverResult = this.buildErrorResult(prompt, error);
    }

    // 3. 准备转换选项（可选加载 transcript）
    const converterOptions: DriverReturnConverterOptions = {
      instruction: task.instruction,
      sourceDriver: this.driver.driver_id,
      taskId: prompt.task_id,
      workspace: process.env.ACP_WORKSPACE || process.cwd(),
    };

    if (this.loadTranscript) {
      try {
        const transcriptText = await this.loadTranscriptText(driverResult);
        if (transcriptText !== undefined) {
          converterOptions.transcriptText = transcriptText;
        }
      } catch {
        // transcript 加载失败不是致命错误，降级处理
      }
    }

    // 4. 转换 DriverRunResult → DriverReturn（converter 链内部已含
    //    struct 解析 → 元数据构造 两级降级）
    const driverReturn = await this.converter(driverResult, converterOptions);

    // 5. 增强：补充 driver 元信息
    return this.enrichDriverReturn(driverReturn, driverResult, startedAt);
  }

  // ──────────────────────────────────────────
  // 内部方法
  // ──────────────────────────────────────────

  /**
   * 将 DriverTask 转换为 DriverPrompt。
   *
   * 组装规则：
   * - prompt 前缀固定为 "DRIVER TASK:\n" 便于 Driver 识别
   * - 附加 skill/experience 上下文（如果有）
   * - 附加格式指令，要求 Driver 产出六字段报告
   */
  private buildDriverPrompt(task: DriverTask): DriverPrompt {
    const taskId = createId('task');
    const runId = createId('run');

    let promptText = 'DRIVER TASK:\n';
    promptText += task.instruction;

    // 附加上下文
    if (task.context?.skills && task.context.skills.length > 0) {
      promptText += '\n\nRELEVANT SKILLS:\n';
      promptText += task.context.skills.map((s, i) => `[Skill ${i + 1}]\n${s}`).join('\n\n');
    }

    if (task.context?.experiences && task.context.experiences.length > 0) {
      promptText += '\n\nRELEVANT EXPERIENCES:\n';
      promptText += task.context.experiences
        .map((e, i) => `[Experience ${i + 1}]\n${e}`)
        .join('\n\n');
    }

    // 附加六字段报告格式指令
    promptText += '\n\n---\n';
    promptText +=
      'After completing the task, please output a structured report in the following JSON format:\n';
    promptText += '<<<DRIVER_RETURN>>>\n';
    promptText += JSON.stringify(
      {
        artifacts: [{ type: 'patch', path: '/path/to/file', summary: 'What was changed' }],
        summary: '3-5 sentence summary of execution',
        decisions: [
          {
            point: 'Decision point description',
            options: ['option A', 'option B'],
            chosen: 'option A',
            reason: 'Why this was chosen',
          },
        ],
        blockers: [
          {
            blocker: 'Blocker description',
            attempts: ['attempt 1', 'attempt 2'],
            resolution: 'How it was resolved',
            resolved: true,
          },
        ],
        referenced_experiences: [
          {
            experience_id: 'exp_xxx',
            applied: true,
            effectiveness: 'fully_effective',
            note: 'How the experience helped',
          },
        ],
        assumptions: [
          {
            assumption: 'What was assumed',
            risk_if_wrong: 'What happens if wrong',
          },
        ],
      },
      null,
      2,
    );
    promptText += '\n<<<END_DRIVER_RETURN>>>';

    if (process.env.ACP_WRITE_REPORT_FILE === '1' || process.env.ACP_WRITE_REPORT_FILE === 'true') {
      promptText += '\n\n---\n';
      promptText += 'FINAL STEP — After completing the task, you MUST write a report file:\n';
      promptText += `- File name: exactly \`${taskId}_report.txt\` in the workspace root directory.\n`;
      promptText +=
        '- File content: a JSON object containing the six-field report. ' +
        'The JSON MUST be the object inside the <<<DRIVER_RETURN>>> block above — ' +
        'DO NOT include the <<<DRIVER_RETURN>>> or <<<END_DRIVER_RETURN>>> markers themselves. ' +
        'The file MUST start with `{` and end with `}` and be valid JSON.\n';
      promptText +=
        '- Required fields: summary, artifacts, decisions, blockers, referenced_experiences, assumptions.';
    }

    return {
      task_id: taskId,
      run_id: runId,
      prompt: promptText,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }

  /**
   * 加载 Driver 的 transcript 文本。
   *
   * 当前版本 DriverRuntimeHandle.collectTranscript() 只返回 ArtifactRef，
   * 不直接返回文本内容。实际部署时 transcript 文本由外部加载器提供。
   */
  private async loadTranscriptText(result: DriverRunResult): Promise<string | undefined> {
    const loader = this.transcriptLoader;
    if (loader) {
      return loader(result.transcript_ref.uri);
    }

    // 默认行为：尝试 collectTranscript 获取引用，但不保证能加载内容
    try {
      await this.driver.collectTranscript();
    } catch {
      // 忽略加载失败
    }

    return undefined;
  }

  /**
   * 当 Driver.sendPrompt() 抛出异常时，构造一个表示失败的 DriverRunResult。
   */
  private buildErrorResult(prompt: DriverPrompt, error: unknown): DriverRunResult {
    const now = nowTimestamp();
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      driver_run_result_id: createId('driver_result'),
      session_id: this.driver.session_id,
      status: 'failed',
      artifacts: [],
      transcript_ref: {
        artifact_id: createId('artifact'),
        type: 'transcript',
        uri: `artifact://transcript/${prompt.task_id}/error`,
        producer_id: this.driver.driver_id,
        task_id: prompt.task_id,
        created_at: now,
        schema_version: SCHEMA_VERSION,
      },
      tool_events: [],
      diagnostics: {
        driver_id: this.driver.driver_id,
        duration_ms: 0,
        notes: ['DriverBridge caught exception during sendPrompt()'],
      },
      error: {
        code: 'DRIVER_BRIDGE_INVOKE_ERROR',
        message: errorMessage,
        retryable: true,
      },
      created_at: now,
      schema_version: SCHEMA_VERSION,
    };
  }

  /**
   * 增强 DriverReturn，补充 bridge 层面的元信息。
   */
  private enrichDriverReturn(
    driverReturn: DriverReturn,
    driverResult: DriverRunResult,
    startedAt: string,
  ): DriverReturn {
    const elapsedMs = new Date(driverResult.created_at).getTime() - new Date(startedAt).getTime();

    // 如果 summary 中已经包含 driver ID 和耗时，不需要重复添加 bridge 信息
    const hasDiagnosticInfo =
      driverReturn.summary.includes(driverResult.diagnostics.driver_id) &&
      driverReturn.summary.includes('ms');

    if (hasDiagnosticInfo) {
      return driverReturn;
    }

    // 补充 bridge 层面的元信息
    return {
      ...driverReturn,
      summary: `${driverReturn.summary} [Bridge: ${this.driver.driver_id}, ${elapsedMs}ms]`,
      decisions: [
        ...driverReturn.decisions,
        {
          point: 'Cross-bridge invocation',
          options: ['direct_driver_call', 'bridge_wrapped_call'],
          chosen: 'bridge_wrapped_call',
          reason: `Invoked via DriverBridge (${elapsedMs}ms round-trip)`,
        },
      ],
    };
  }
}
