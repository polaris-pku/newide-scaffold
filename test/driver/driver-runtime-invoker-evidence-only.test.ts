/**
 * 阶段 3 evidence-only 派工分支的行为测试（不依赖真实外部 Driver）。
 *
 * 断言的是可观察差异：evidence-only 的 prompt 只有本次 Brief、没有六字段报告/报告文件
 * 指令、不注入整批长期记忆、不调用六字段 converter；默认 six-field 分支保持原样
 * （legacy/Council 兼容）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '../../src/core';
import type {
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle,
  DriverStreamEventListener,
} from '../../src/driver/contract';
import {
  createDriverRuntimeInvoker,
  type DriverRuntimeInvokerInput,
} from '../../src/driver/driver-runtime-invoker';
import type { DriverReturnConverter } from '../../src/driver/driver-return-converter';

const previousReportFileEnv = process.env.ACP_WRITE_REPORT_FILE;

afterEach(() => {
  vi.restoreAllMocks();
  if (previousReportFileEnv === undefined) delete process.env.ACP_WRITE_REPORT_FILE;
  else process.env.ACP_WRITE_REPORT_FILE = previousReportFileEnv;
});

function driverResult(): DriverRunResult {
  return {
    driver_run_result_id: 'drr_evidence',
    session_id: 'session_evidence',
    status: 'succeeded',
    response: 'did the work',
    artifacts: [],
    transcript_ref: {
      artifact_id: 'artifact_transcript',
      type: 'transcript',
      uri: 'artifact://transcript/task_1/session_evidence',
      producer_id: 'driver_evidence',
      created_at: '2026-11-14T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    },
    tool_events: [],
    diagnostics: { driver_id: 'driver_evidence', duration_ms: 5, notes: [] },
    created_at: '2026-11-14T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

class CapturingDriver implements DriverRuntimeHandle {
  readonly driver_id = 'driver_evidence';
  readonly session_id = 'session_evidence';
  readonly capabilities = {
    supports_acp_extension: false,
    supports_structured_output: true,
    supports_session_load: false,
    supports_tool_events: false,
    supports_permission_events: false,
  };
  readonly prompts: DriverPrompt[] = [];
  private readonly listeners = new Set<DriverStreamEventListener>();

  async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    this.prompts.push(input);
    return driverResult();
  }

  async interrupt(): Promise<void> {
    return undefined;
  }

  async collectTranscript() {
    return driverResult().transcript_ref;
  }

  subscribeToEvents(listener: DriverStreamEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function invocationInput(
  overrides: Partial<DriverRuntimeInvokerInput> = {},
): DriverRuntimeInvokerInput {
  return {
    task_id: 'task_1',
    run_id: 'run_1',
    call_id: 'call_1',
    source_driver: 'driver_evidence',
    driver_context: {
      task_instruction: 'Fix the failing test in src/fix.ts',
      skills: [{ id: 'skill_1', description: 'Skill', content: 'Skill body' }],
      experiences: [{ id: 'exp_1', description: 'Experience', content: 'Experience body' }],
    },
    ...overrides,
  };
}

describe('evidence-only 派工分支', () => {
  it('不要求六字段报告、不写报告文件、不注入整批记忆', async () => {
    process.env.ACP_WRITE_REPORT_FILE = '1';
    const driver = new CapturingDriver();
    const output = await createDriverRuntimeInvoker(driver)(
      invocationInput({ report_mode: 'evidence_only' }),
    );

    const prompt = driver.prompts[0]?.prompt ?? '';
    expect(prompt).toContain('Fix the failing test in src/fix.ts');
    expect(prompt).not.toContain('<<<DRIVER_RETURN>>>');
    expect(prompt).not.toContain('report file');
    expect(prompt).not.toContain('_report.txt');
    expect(prompt).not.toContain('Skill body');
    expect(prompt).not.toContain('Experience body');
    // evidence-only 不产出六字段报告：缺席不是「空报告」。
    expect(output.report).toBeUndefined();
    expect(output.execution.status).toBe('succeeded');
  });

  it('不调用六字段 converter（即使注入的 converter 会抛错）', async () => {
    const converter = vi.fn(async () => {
      throw new Error('converter must not run in evidence-only mode');
    }) as unknown as DriverReturnConverter;
    const driver = new CapturingDriver();
    const output = await createDriverRuntimeInvoker(driver, converter)(
      invocationInput({ report_mode: 'evidence_only' }),
    );
    expect(converter).not.toHaveBeenCalled();
    expect(output.report).toBeUndefined();
  });

  it('默认 six-field 分支保持原样：报告指令 + converter + 记忆上下文', async () => {
    const driver = new CapturingDriver();
    const converter = vi.fn(async () => ({
      summary: 'converted',
      artifacts: [],
      decisions: [],
      blockers: [],
      referenced_experiences: [],
      assumptions: [],
    })) as unknown as DriverReturnConverter;
    const output = await createDriverRuntimeInvoker(driver, converter)(invocationInput());

    const prompt = driver.prompts[0]?.prompt ?? '';
    expect(prompt).toContain('<<<DRIVER_RETURN>>>');
    expect(prompt).toContain('Skill body');
    expect(converter).toHaveBeenCalledTimes(1);
    expect(output.report?.summary).toBe('converted');
  });

  it('恢复续跑（resume_session）同样不追加六字段报告指令', async () => {
    process.env.ACP_WRITE_REPORT_FILE = '1';
    const driver = new CapturingDriver();
    await createDriverRuntimeInvoker(driver)(
      invocationInput({
        report_mode: 'evidence_only',
        session_id: 'session_evidence',
        resume_session: true,
      }),
    );
    const prompt = driver.prompts[0]?.prompt ?? '';
    expect(prompt).toContain('Continue the interrupted task');
    expect(prompt).toContain('Fix the failing test in src/fix.ts');
    expect(prompt).not.toContain('<<<DRIVER_RETURN>>>');
    expect(prompt).not.toContain('_report.txt');
  });
});
