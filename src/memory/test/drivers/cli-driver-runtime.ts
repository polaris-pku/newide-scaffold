/**
 * CliDriverRuntime — A 侧 DriverRuntimeHandle 实现
 *
 * 将本地 CLI 命令行工具包装为方向 A 的 DriverRuntimeHandle 接口。
 * 支持任意 CLI（Claude Code、Kimi Code 等），通过 cliCommand 参数切换。
 *
 * 与 createLlmDriver ({mode:'cli'}) 的关键区别：
 * - createLlmDriver 返回 B 侧 DriverHandler（直接返回 DriverReturn）
 * - 本类实现 A 侧 DriverRuntimeHandle（返回 DriverRunResult）
 * - 必须通过 DriverBridge 才能接入 B 侧的 InvokeDriverTool
 *
 * 用法（在集成测试中）：
 * ```ts
 * // 使用 Claude Code
 * const driver = new CliDriverRuntime({ cliCommand: 'claude' });
 *
 * // 使用 Kimi Code
 * const driver = new CliDriverRuntime({ cliCommand: 'kimi' });
 *
 * const bridge = new DriverBridge({ driver });
 * const tool = new InvokeDriverTool(bridge.createHandler());
 * ```
 */
import { spawnSync } from 'node:child_process';
import { SCHEMA_VERSION, createId, nowTimestamp } from '../../../core';
import type { ArtifactRef } from '../../../core';
import type {
  DriverCapabilities,
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle,
} from '../../../driver/contract';

// ──────────────────────────────────────────────
// 配置选项
// ──────────────────────────────────────────────

export interface CliDriverRuntimeOptions {
  /** CLI 命令路径（默认 'claude'） */
  cliCommand?: string;
  /**
   * 传给 CLI 进程的额外参数，在 promptArgs 之前插入。
   * 与 CommandDriverTransport 的 args 字段语义一致。
   * 例如 `['--dangerously-skip-permissions']` 或 `['-y']` 跳过权限检查。
   */
  args?: string[];
  /**
   * CLI 参数列表（在 prompt 之前传入）。
   * 例如 Kimi 的 `-p` 模式：`['-p']` 会将 prompt 作为参数而不是 stdin 传入，
   * 适用于需要非交互式纯文本输出的 CLI。
   */
  promptArgs?: string[];
  /** 超时时间（毫秒，默认 120_000） */
  timeoutMs?: number;
  /** Driver ID（默认 'cli-driver'） */
  driverId?: string;
  /**
   * CLI 进程的工作目录。必须设置，否则默认 process.cwd() 会导致 AI driver
   * 生成的文件污染项目根目录。集成测试应传入临时目录并在测试后清理。
   */
  cwd: string;
}

// ──────────────────────────────────────────────
// 实现
// ──────────────────────────────────────────────

export class CliDriverRuntime implements DriverRuntimeHandle {
  readonly driver_id: string;
  readonly session_id: string;
  readonly capabilities: DriverCapabilities = {
    supports_acp_extension: false,
    supports_structured_output: true,
    supports_session_load: false,
    supports_tool_events: false,
    supports_permission_events: false,
  };

  private readonly cliCommand: string;
  private readonly args: readonly string[];
  private readonly promptArgs: string[];
  private readonly timeoutMs: number;
  private readonly cwd: string;
  /** 最近一次 CLI 输出的原始文本 */
  private lastStdout = '';
  private lastTaskId = '';

  constructor(options: CliDriverRuntimeOptions) {
    this.driver_id = options?.driverId ?? 'cli-driver';
    this.session_id = `${this.driver_id}:session`;
    this.cliCommand = options?.cliCommand ?? 'claude';
    this.args = options?.args ?? [];
    this.promptArgs = options?.promptArgs ?? [];
    this.timeoutMs = options?.timeoutMs ?? 120_000;
    this.cwd = options.cwd;
  }

  /**
   * 返回最近一次 CLI 输出的原始文本。
   * 供 DriverBridge.transcriptLoader 使用。
   */
  getTranscriptText(): string {
    return this.lastStdout;
  }

  async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    const startedAt = Date.now();
    this.lastTaskId = input.task_id;

    let stdout: string;
    try {
      if (this.promptArgs.length > 0) {
        // CLI 通过参数接收 prompt（如 kimi -p "prompt"）
        // 用 spawnSync 避免 shell 转义问题
        const args = [...this.args, ...this.promptArgs, input.prompt];
        const spawned = spawnSync(this.cliCommand, args, {
          cwd: this.cwd,
          encoding: 'utf-8',
          timeout: this.timeoutMs,
          maxBuffer: 1024 * 1024,
        });
        if (spawned.error) throw spawned.error;
        if (spawned.status !== 0) {
          throw new Error(
            `CLI exited with code ${spawned.status}: ${spawned.stderr?.slice(0, 500) || spawned.stdout?.slice(0, 500)}`,
          );
        }
        stdout = spawned.stdout;
      } else {
        // CLI 通过 stdin 接收 prompt（默认，如 claude）
        const spawned = spawnSync(this.cliCommand, [...this.args], {
          cwd: this.cwd,
          input: input.prompt,
          encoding: 'utf-8',
          timeout: this.timeoutMs,
          maxBuffer: 1024 * 1024,
        });
        if (spawned.error) throw spawned.error;
        if (spawned.status !== 0) {
          throw new Error(
            `CLI exited with code ${spawned.status}: ${spawned.stderr?.slice(0, 500) || spawned.stdout?.slice(0, 500)}`,
          );
        }
        stdout = spawned.stdout;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.buildErrorResult(input, message, Date.now() - startedAt);
    }

    this.lastStdout = stdout;
    const elapsed = Date.now() - startedAt;
    const created_at = nowTimestamp();

    const result: DriverRunResult = {
      driver_run_result_id: createId('driver_result'),
      session_id: this.session_id,
      status: 'succeeded',
      artifacts: this.buildArtifacts(input, stdout, created_at),
      transcript_ref: this.buildTranscriptRef(input, stdout, created_at),
      tool_events: [
        {
          tool_event_id: createId('tool_event'),
          tool_name: 'cli.exec',
          status: 'completed',
          summary: `CLI \`${this.cliCommand}\` executed task ${input.task_id} (${elapsed}ms)`,
          created_at,
          schema_version: SCHEMA_VERSION,
        },
      ],
      diagnostics: {
        driver_id: this.driver_id,
        duration_ms: elapsed,
        notes: [
          `CLI via \`${this.cliCommand}\``,
          `prompt length: ${input.prompt.length} chars`,
          `---CLI OUTPUT---`,
          stdout.slice(0, 2000),
          `---END CLI OUTPUT---`,
        ],
      },
      created_at,
      schema_version: SCHEMA_VERSION,
    };

    return result;
  }

  async interrupt(_reason: string): Promise<void> {
    // CLI 进程已退出，无需中断
  }

  async collectTranscript(): Promise<ArtifactRef> {
    if (!this.lastStdout) {
      throw new Error('No transcript available — sendPrompt has not been called');
    }
    return this.buildTranscriptRef(
      { task_id: this.lastTaskId } as DriverPrompt,
      this.lastStdout,
      nowTimestamp(),
    );
  }

  // ──────────────────────────────────────────
  // 内部方法
  // ──────────────────────────────────────────

  private buildArtifacts(input: DriverPrompt, stdout: string, created_at: string): ArtifactRef[] {
    return [
      {
        artifact_id: createId('artifact'),
        type: 'transcript' as const,
        uri: `artifact://transcript/${input.task_id}/${this.driver_id}`,
        producer_id: this.driver_id,
        task_id: input.task_id,
        metadata: {
          prompt_length: input.prompt.length,
          output_length: stdout.length,
        },
        content: {
          kind: 'text' as const,
          content_ref: `data:text/plain,${encodeURIComponent(stdout)}`,
          media_type: 'text/plain',
        },
        created_at,
        schema_version: SCHEMA_VERSION,
      },
    ];
  }

  private buildTranscriptRef(
    input: DriverPrompt,
    _stdout: string,
    created_at: string,
  ): ArtifactRef {
    return {
      artifact_id: createId('artifact'),
      type: 'transcript' as const,
      uri: `artifact://transcript/${input.task_id}/${this.driver_id}`,
      producer_id: this.driver_id,
      task_id: input.task_id,
      created_at,
      schema_version: SCHEMA_VERSION,
    };
  }

  private buildErrorResult(
    input: DriverPrompt,
    errorMessage: string,
    elapsedMs: number,
  ): DriverRunResult {
    const created_at = nowTimestamp();
    return {
      driver_run_result_id: createId('driver_result'),
      session_id: this.session_id,
      status: 'failed',
      artifacts: [],
      transcript_ref: this.buildTranscriptRef(input, '', created_at),
      tool_events: [],
      diagnostics: {
        driver_id: this.driver_id,
        duration_ms: elapsedMs,
        notes: [`CLI error: ${errorMessage}`],
      },
      error: {
        code: 'CLI_DRIVER_ERROR',
        message: errorMessage,
        retryable: true,
      },
      created_at,
      schema_version: SCHEMA_VERSION,
    };
  }
}
