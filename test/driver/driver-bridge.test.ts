/**
 * DriverBridge 测试
 *
 * 覆盖：
 * - DriverBridge 基本创建和 handler 生成
 * - MockDriver 集成：invokeDriver 返回正确六字段报告
 * - DriverReturnConverter 的默认转换策略
 * - 从 transcript 解析结构化 DriverReturn
 * - Driver.sendPrompt() 异常时的降级处理
 * - FailingMockDriver 场景
 * - bridge 级别 metadata 增强
 */

import { describe, it, expect } from 'vitest';
import { MockDriver } from '../../src/driver/mock-driver';
import { DriverBridge } from '../../src/driver/driver-bridge';
import {
  constructDriverReturnFromResult,
  parseDriverReturnFromTranscript,
  createDefaultDriverReturnConverter,
} from '../../src/driver/driver-return-converter';
import { InvokeDriverTool } from '../../src/memory/runtime/tools/invoke-driver-tool';
import { SCHEMA_VERSION, createId } from '../../src/core';
import type { DriverRuntimeHandle, DriverPrompt, DriverRunResult } from '../../src/driver';
import type { ArtifactRef } from '../../src/core';
import type { DriverReturn } from '../../src/memory/schemas';

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/** 创建一个返回失败结果的 Mock Driver */
class FailingMockDriver implements DriverRuntimeHandle {
  readonly driver_id = 'mock-failing-driver';
  readonly session_id = 'failing-session';
  readonly capabilities = {
    supports_acp_extension: false,
    supports_structured_output: false,
    supports_session_load: false,
    supports_tool_events: false,
    supports_permission_events: false,
  };

  async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    return {
      driver_run_result_id: createId('driver_result'),
      session_id: this.session_id,
      status: 'failed',
      artifacts: [],
      transcript_ref: {
        artifact_id: createId('artifact'),
        type: 'transcript',
        uri: 'artifact://transcript/failing',
        producer_id: this.driver_id,
        task_id: input.task_id,
        created_at: new Date().toISOString(),
        schema_version: SCHEMA_VERSION,
      },
      tool_events: [],
      diagnostics: {
        driver_id: this.driver_id,
        duration_ms: 100,
        notes: ['Driver failed intentionally'],
      },
      error: {
        code: 'MOCK_DRIVER_FAILED',
        message: 'Driver failed intentionally',
        retryable: false,
      },
      created_at: new Date().toISOString(),
      schema_version: SCHEMA_VERSION,
    };
  }

  async collectTranscript(): Promise<ArtifactRef> {
    return {
      artifact_id: createId('artifact'),
      type: 'transcript',
      uri: 'artifact://transcript/failing',
      producer_id: this.driver_id,
      task_id: 'task',
      created_at: new Date().toISOString(),
      schema_version: SCHEMA_VERSION,
    };
  }

  async interrupt(_reason: string): Promise<void> {}
}

/** 创建一个抛出异常的 CrashMockDriver */
class CrashMockDriver implements DriverRuntimeHandle {
  readonly driver_id = 'mock-crash-driver';
  readonly session_id = 'crash-session';
  readonly capabilities = {
    supports_acp_extension: false,
    supports_structured_output: false,
    supports_session_load: false,
    supports_tool_events: false,
    supports_permission_events: false,
  };

  async sendPrompt(_input: DriverPrompt): Promise<DriverRunResult> {
    throw new Error('Driver process crashed unexpectedly');
  }

  async collectTranscript(): Promise<ArtifactRef> {
    return {
      artifact_id: createId('artifact'),
      type: 'transcript',
      uri: 'artifact://transcript/crash',
      producer_id: this.driver_id,
      task_id: 'task',
      created_at: new Date().toISOString(),
      schema_version: SCHEMA_VERSION,
    };
  }

  async interrupt(_reason: string): Promise<void> {}
}

/** 验证 DriverReturn 六字段完整性 */
function assertValidDriverReturn(report: DriverReturn): void {
  expect(report).toBeDefined();
  expect(Array.isArray(report.artifacts)).toBe(true);
  expect(typeof report.summary).toBe('string');
  expect(report.summary.length).toBeGreaterThan(0);
  expect(Array.isArray(report.decisions)).toBe(true);
  expect(Array.isArray(report.blockers)).toBe(true);
  expect(Array.isArray(report.referenced_experiences)).toBe(true);
  expect(Array.isArray(report.assumptions)).toBe(true);

  // 验证每个 artifact 结构
  for (const a of report.artifacts) {
    expect(typeof a.type).toBe('string');
    expect(typeof a.path).toBe('string');
    expect(typeof a.summary).toBe('string');
  }

  // 验证每个 decision 结构
  for (const d of report.decisions) {
    expect(typeof d.point).toBe('string');
    expect(Array.isArray(d.options)).toBe(true);
    expect(typeof d.chosen).toBe('string');
    expect(typeof d.reason).toBe('string');
  }

  // 验证每个 blocker 结构
  for (const b of report.blockers) {
    expect(typeof b.blocker).toBe('string');
    expect(Array.isArray(b.attempts)).toBe(true);
    expect(typeof b.resolution).toBe('string');
    expect(typeof b.resolved).toBe('boolean');
  }

  // 验证每个 assumption 结构
  for (const a of report.assumptions) {
    expect(typeof a.assumption).toBe('string');
    expect(typeof a.risk_if_wrong).toBe('string');
  }
}

// ──────────────────────────────────────────────
// Tests: DriverBridge
// ──────────────────────────────────────────────

describe('DriverBridge', () => {
  describe('construction', () => {
    it('should create a bridge with a MockDriver', () => {
      const bridge = new DriverBridge({ driver: new MockDriver() });
      expect(bridge).toBeDefined();
      expect(bridge.getDriverHandle().driver_id).toBe('mock-driver');
    });

    it('should create a handler function', () => {
      const bridge = new DriverBridge({ driver: new MockDriver() });
      const handler = bridge.createHandler();
      expect(typeof handler).toBe('function');
    });
  });

  describe('invokeDriver with MockDriver', () => {
    it('should return a valid 六字段报告', async () => {
      const bridge = new DriverBridge({ driver: new MockDriver() });
      const report = await bridge.invokeDriver({
        instruction: 'Test instruction for mock driver',
      });

      assertValidDriverReturn(report);
    });

    it('should include artifacts from MockDriver', async () => {
      const bridge = new DriverBridge({ driver: new MockDriver() });
      const report = await bridge.invokeDriver({
        instruction: 'Produce a patch file',
      });

      expect(report.artifacts.length).toBeGreaterThan(0);
      expect(report.artifacts[0]!.type).toBe('patch');
      expect(report.artifacts[0]!.path).toContain('artifact://patch/');
    });

    it('should include summary with driver diagnostics', async () => {
      const bridge = new DriverBridge({ driver: new MockDriver() });
      const report = await bridge.invokeDriver({
        instruction: 'Test summary generation',
      });

      expect(report.summary).toContain('mock-driver');
      expect(report.summary).toContain('succeeded');
    });

    it('should include task instruction in summary', async () => {
      const bridge = new DriverBridge({ driver: new MockDriver() });
      const instruction = 'Fix the security vulnerability in auth.ts';
      const report = await bridge.invokeDriver({ instruction });

      expect(report.summary).toContain(instruction);
    });

    it('should include decisions from tool events', async () => {
      const bridge = new DriverBridge({ driver: new MockDriver() });
      const report = await bridge.invokeDriver({
        instruction: 'Test',
      });

      expect(report.decisions.length).toBeGreaterThan(0);
      const toolDecision = report.decisions.find((d) => d.point.includes('mock.write_patch'));
      expect(toolDecision).toBeDefined();
    });

    it('should include default assumptions', async () => {
      const bridge = new DriverBridge({ driver: new MockDriver() });
      const report = await bridge.invokeDriver({
        instruction: 'Test',
      });

      expect(report.assumptions.length).toBeGreaterThan(0);
      expect(report.assumptions[0]!.assumption).toContain('mock-driver');
    });

    it('should have empty referenced_experiences by default', async () => {
      const bridge = new DriverBridge({ driver: new MockDriver() });
      const report = await bridge.invokeDriver({
        instruction: 'Test',
      });

      expect(report.referenced_experiences).toEqual([]);
    });

    it('should pass context skills and experiences to driver prompt', async () => {
      // 创建一个记录 prompt 的 spy driver
      let capturedPrompt = '';
      class SpyMockDriver extends MockDriver {
        async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
          capturedPrompt = input.prompt;
          return super.sendPrompt(input);
        }
      }

      const bridge = new DriverBridge({ driver: new SpyMockDriver() });
      await bridge.invokeDriver({
        instruction: 'Test',
        context: {
          skills: ['Skill A: TypeScript patterns'],
          experiences: ['Exp 1: Be careful with async'],
        },
      });

      expect(capturedPrompt).toContain('Skill A: TypeScript patterns');
      expect(capturedPrompt).toContain('Exp 1: Be careful with async');
    });

    it('should include 六字段 format instructions in prompt', async () => {
      let capturedPrompt = '';
      class SpyMockDriver extends MockDriver {
        async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
          capturedPrompt = input.prompt;
          return super.sendPrompt(input);
        }
      }

      const bridge = new DriverBridge({ driver: new SpyMockDriver() });
      await bridge.invokeDriver({ instruction: 'Test' });

      expect(capturedPrompt).toContain('<<<DRIVER_RETURN>>>');
      expect(capturedPrompt).toContain('<<<END_DRIVER_RETURN>>>');
      expect(capturedPrompt).toContain('"artifacts"');
      expect(capturedPrompt).toContain('"summary"');
      expect(capturedPrompt).toContain('"decisions"');
      expect(capturedPrompt).toContain('"blockers"');
      expect(capturedPrompt).toContain('"referenced_experiences"');
      expect(capturedPrompt).toContain('"assumptions"');
    });
  });

  describe('invokeDriver with FailingMockDriver', () => {
    it('should return a valid report even when driver fails', async () => {
      const bridge = new DriverBridge({ driver: new FailingMockDriver() });
      const report = await bridge.invokeDriver({
        instruction: 'This should fail',
      });

      assertValidDriverReturn(report);
    });

    it('should include error info as blockers', async () => {
      const bridge = new DriverBridge({ driver: new FailingMockDriver() });
      const report = await bridge.invokeDriver({
        instruction: 'This should fail',
      });

      expect(report.blockers.length).toBeGreaterThan(0);
      const errorBlocker = report.blockers.find((b) => b.blocker === 'Driver failed intentionally');
      expect(errorBlocker).toBeDefined();
      expect(errorBlocker!.resolved).toBe(false);
    });

    it('should include error info in summary', async () => {
      const bridge = new DriverBridge({ driver: new FailingMockDriver() });
      const report = await bridge.invokeDriver({
        instruction: 'This should fail',
      });

      expect(report.summary).toContain('failed');
      expect(report.summary).toContain('MOCK_DRIVER_FAILED');
    });

    it('should have empty artifacts', async () => {
      const bridge = new DriverBridge({ driver: new FailingMockDriver() });
      const report = await bridge.invokeDriver({
        instruction: 'This should fail',
      });

      expect(report.artifacts).toEqual([]);
    });
  });

  describe('invokeDriver with CrashMockDriver', () => {
    it('should handle sendPrompt() throwing exception gracefully', async () => {
      const bridge = new DriverBridge({ driver: new CrashMockDriver() });
      const report = await bridge.invokeDriver({
        instruction: 'This will crash',
      });

      assertValidDriverReturn(report);
    });

    it('should include crash error as blocker', async () => {
      const bridge = new DriverBridge({ driver: new CrashMockDriver() });
      const report = await bridge.invokeDriver({
        instruction: 'This will crash',
      });

      expect(report.blockers.length).toBeGreaterThan(0);
      const crashBlocker = report.blockers.find((b) => b.blocker.includes('crashed'));
      expect(crashBlocker).toBeDefined();
    });

    it('should have DRIVER_BRIDGE_INVOKE_ERROR in decisions', async () => {
      const bridge = new DriverBridge({ driver: new CrashMockDriver() });
      const report = await bridge.invokeDriver({
        instruction: 'This will crash',
      });

      const errorDecision = report.decisions.find((d) => d.point.includes('Error handling'));
      expect(errorDecision).toBeDefined();
    });
  });

  describe('integration with InvokeDriverTool', () => {
    it('should work as a DriverHandler for InvokeDriverTool', async () => {
      const bridge = new DriverBridge({ driver: new MockDriver() });
      const tool = new InvokeDriverTool(bridge.createHandler());
      const result = await tool.execute({
        instruction: 'Test via InvokeDriverTool',
      });

      assertValidDriverReturn(result);
    });

    it('should pass full DriverTask through the bridge', async () => {
      const bridge = new DriverBridge({ driver: new MockDriver() });
      const tool = new InvokeDriverTool(bridge.createHandler());
      const result = await tool.execute({
        instruction: 'Complex task with context',
        context: {
          skills: ['Skill 1', 'Skill 2'],
          experiences: ['Experience 1'],
        },
      });

      assertValidDriverReturn(result);
      expect(result.summary).toContain('Complex task with context');
    });
  });

  describe('custom converter', () => {
    it('should allow custom DriverReturnConverter', async () => {
      const bridge = new DriverBridge({
        driver: new MockDriver(),
        converter: () => ({
          artifacts: [{ type: 'custom', path: '/custom/path', summary: 'Custom artifact' }],
          summary: 'Custom summary from converter',
          decisions: [
            {
              point: 'Custom decision',
              options: ['A', 'B'],
              chosen: 'A',
              reason: 'Custom reason',
            },
          ],
          blockers: [],
          referenced_experiences: [],
          assumptions: [],
        }),
      });

      const report = await bridge.invokeDriver({
        instruction: 'Test custom converter',
      });

      expect(report.artifacts[0]!.type).toBe('custom');
      expect(report.summary).toContain('Custom summary from converter');
      // Bridge appends metadata when converter output lacks diagnostics
      expect(report.summary).toContain('[Bridge: mock-driver');
      // Converter decisions are preserved
      const customDecision = report.decisions.find((d) => d.point === 'Custom decision');
      expect(customDecision).toBeDefined();
      // Bridge adds cross-bridge invocation decision
      const bridgeDecision = report.decisions.find((d) => d.point === 'Cross-bridge invocation');
      expect(bridgeDecision).toBeDefined();
    });
  });
});

// ──────────────────────────────────────────────
// Tests: DriverReturnConverter
// ──────────────────────────────────────────────

describe('DriverReturnConverter', () => {
  describe('constructDriverReturnFromResult', () => {
    it('should construct from a successful result', () => {
      const result: DriverRunResult = {
        driver_run_result_id: 'test-result',
        session_id: 'test-session',
        status: 'succeeded',
        artifacts: [
          {
            artifact_id: 'art-1',
            type: 'patch',
            uri: 'artifact://patch/test',
            producer_id: 'test-driver',
            task_id: 'task-1',
            created_at: new Date().toISOString(),
            schema_version: SCHEMA_VERSION,
          },
        ],
        transcript_ref: {
          artifact_id: 'art-transcript',
          type: 'transcript',
          uri: 'artifact://transcript/test',
          producer_id: 'test-driver',
          task_id: 'task-1',
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        },
        tool_events: [
          {
            tool_event_id: 'te-1',
            tool_name: 'write_file',
            status: 'completed',
            summary: 'Wrote patch to disk',
            created_at: new Date().toISOString(),
            schema_version: SCHEMA_VERSION,
          },
        ],
        diagnostics: {
          driver_id: 'test-driver',
          duration_ms: 42,
          notes: ['Test note'],
        },
        created_at: new Date().toISOString(),
        schema_version: SCHEMA_VERSION,
      };

      const report = constructDriverReturnFromResult(result, {
        instruction: 'Test instruction',
      });

      assertValidDriverReturn(report);
      expect(report.artifacts.length).toBe(1);
      expect(report.artifacts[0]!.type).toBe('patch');
      expect(report.summary).toContain('test-driver');
      expect(report.summary).toContain('succeeded');
      expect(report.summary).toContain('42ms');
      expect(report.decisions.length).toBeGreaterThan(0);
      expect(report.blockers).toEqual([]);
    });

    it('should construct from a failed result', () => {
      const result: DriverRunResult = {
        driver_run_result_id: 'test-result',
        session_id: 'test-session',
        status: 'failed',
        artifacts: [],
        transcript_ref: {
          artifact_id: 'art-transcript',
          type: 'transcript',
          uri: 'artifact://transcript/test',
          producer_id: 'test-driver',
          task_id: 'task-1',
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        },
        tool_events: [],
        diagnostics: {
          driver_id: 'test-driver',
          duration_ms: 500,
          notes: [],
        },
        error: {
          code: 'TEST_ERROR',
          message: 'Something went wrong',
          retryable: true,
        },
        created_at: new Date().toISOString(),
        schema_version: SCHEMA_VERSION,
      };

      const report = constructDriverReturnFromResult(result);

      assertValidDriverReturn(report);
      expect(report.blockers.length).toBeGreaterThan(0);
      expect(report.blockers[0]!.blocker).toBe('Something went wrong');
      expect(report.blockers[0]!.resolved).toBe(false);
    });

    it('should construct from a cancelled result', () => {
      const result: DriverRunResult = {
        driver_run_result_id: 'test-result',
        session_id: 'test-session',
        status: 'cancelled',
        artifacts: [],
        transcript_ref: {
          artifact_id: 'art-transcript',
          type: 'transcript',
          uri: 'artifact://transcript/test',
          producer_id: 'test-driver',
          task_id: 'task-1',
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        },
        tool_events: [],
        diagnostics: {
          driver_id: 'test-driver',
          duration_ms: 100,
          notes: [],
        },
        created_at: new Date().toISOString(),
        schema_version: SCHEMA_VERSION,
      };

      const report = constructDriverReturnFromResult(result);

      const cancelledBlocker = report.blockers.find(
        (b) => b.blocker === 'Driver execution was cancelled',
      );
      expect(cancelledBlocker).toBeDefined();
      expect(cancelledBlocker!.resolved).toBe(true);
    });
  });

  describe('parseDriverReturnFromTranscript', () => {
    it('should parse tagged block format', () => {
      const transcript = `
Some conversation text...

<<<DRIVER_RETURN>>>
{
  "artifacts": [{"type": "patch", "path": "/test.patch", "summary": "Fixed bug"}],
  "summary": "Successfully fixed the bug.",
  "decisions": [],
  "blockers": [],
  "referenced_experiences": [],
  "assumptions": []
}
<<<END_DRIVER_RETURN>>>

More text after...
`;

      const report = parseDriverReturnFromTranscript(transcript);
      expect(report).not.toBeNull();
      expect(report!.artifacts.length).toBe(1);
      expect(report!.artifacts[0]!.type).toBe('patch');
      expect(report!.summary).toBe('Successfully fixed the bug.');
    });

    it('should parse JSON code block format', () => {
      const transcript = `
Driver output:

\`\`\`json
{
  "artifacts": [{"type": "config", "path": "/config.yml", "summary": "Updated config"}],
  "summary": "Configuration updated.",
  "decisions": [
    {
      "point": "Use YAML or JSON",
      "options": ["YAML", "JSON"],
      "chosen": "YAML",
      "reason": "Team preference"
    }
  ],
  "blockers": [],
  "referenced_experiences": [],
  "assumptions": []
}
\`\`\`

Done.
`;

      const report = parseDriverReturnFromTranscript(transcript);
      expect(report).not.toBeNull();
      expect(report!.artifacts[0]!.type).toBe('config');
      expect(report!.decisions[0]!.point).toBe('Use YAML or JSON');
    });

    it('should return null for malformed JSON', () => {
      const transcript = `
<<<DRIVER_RETURN>>>
{ invalid json here }
<<<END_DRIVER_RETURN>>>
`;

      const report = parseDriverReturnFromTranscript(transcript);
      expect(report).toBeNull();
    });

    it('should return null when no report found', () => {
      const transcript = 'Just some plain text without any report.';
      const report = parseDriverReturnFromTranscript(transcript);
      expect(report).toBeNull();
    });

    it('should parse bare JSON with six-field structure', () => {
      const transcript = `
Here is my report:
{
  "artifacts": [{"type": "docs", "path": "/README.md", "summary": "Added docs"}],
  "summary": "Documentation added.",
  "decisions": [],
  "blockers": [],
  "referenced_experiences": [],
  "assumptions": [{"assumption": "Format is correct", "risk_if_wrong": "May need reformatting"}]
}
End of report.
`;

      const report = parseDriverReturnFromTranscript(transcript);
      expect(report).not.toBeNull();
      expect(report!.artifacts[0]!.type).toBe('docs');
      expect(report!.assumptions[0]!.assumption).toBe('Format is correct');
    });
  });

  describe('createDefaultDriverReturnConverter', () => {
    it('should use transcript when available', () => {
      const converter = createDefaultDriverReturnConverter();
      const result: DriverRunResult = {
        driver_run_result_id: 'test',
        session_id: 'test',
        status: 'succeeded',
        artifacts: [],
        transcript_ref: {
          artifact_id: 'art',
          type: 'transcript',
          uri: 'artifact://t/test',
          producer_id: 'test',
          task_id: 'task',
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        },
        tool_events: [],
        diagnostics: { driver_id: 'test', duration_ms: 1, notes: [] },
        created_at: new Date().toISOString(),
        schema_version: SCHEMA_VERSION,
      };

      const transcriptText = `
<<<DRIVER_RETURN>>>
{
  "artifacts": [{"type": "test", "path": "/t", "summary": "T"}],
  "summary": "From transcript",
  "decisions": [],
  "blockers": [],
  "referenced_experiences": [],
  "assumptions": []
}
<<<END_DRIVER_RETURN>>>
`;

      const report = converter(result, { transcriptText });
      expect(report.summary).toBe('From transcript');
    });

    it('should fall back to metadata when no transcript', () => {
      const converter = createDefaultDriverReturnConverter();
      const result: DriverRunResult = {
        driver_run_result_id: 'test',
        session_id: 'test',
        status: 'succeeded',
        artifacts: [],
        transcript_ref: {
          artifact_id: 'art',
          type: 'transcript',
          uri: 'artifact://t/test',
          producer_id: 'test',
          task_id: 'task',
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        },
        tool_events: [],
        diagnostics: { driver_id: 'test-driver-fallback', duration_ms: 1, notes: [] },
        created_at: new Date().toISOString(),
        schema_version: SCHEMA_VERSION,
      };

      const report = converter(result);
      expect(report.summary).toContain('test-driver-fallback');
    });

    it('should fall back when transcript is invalid', () => {
      const converter = createDefaultDriverReturnConverter();
      const result: DriverRunResult = {
        driver_run_result_id: 'test',
        session_id: 'test',
        status: 'succeeded',
        artifacts: [],
        transcript_ref: {
          artifact_id: 'art',
          type: 'transcript',
          uri: 'artifact://t/test',
          producer_id: 'test-meta',
          task_id: 'task',
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        },
        tool_events: [],
        diagnostics: { driver_id: 'test-meta', duration_ms: 1, notes: [] },
        created_at: new Date().toISOString(),
        schema_version: SCHEMA_VERSION,
      };

      const report = converter(result, {
        transcriptText: 'No valid report here.',
      });
      expect(report.summary).toContain('test-meta');
    });
  });
});
