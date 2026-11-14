/**
 * 阶段 3 Buffer v2 与学习输入迁移的行为测试。
 *
 * 覆盖：v1/v2 版本判别读取、零派工表示、文件/内存适配器读写、上下文交付项来源字段、
 * 提取器按来源分级（host_observed / role_declared / missing）、Role 自述不能变成高置信度
 * 成功经验、以及离线消费者对 v2 输入的真实提取落库。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUFFER_SNAPSHOT_V2_SCHEMA_VERSION,
  ContextDeliveryItemSchema,
  isBufferSnapshotV2,
  parseBufferSnapshot,
  type BufferDispatchSummary,
  type BufferSnapshot,
  type BufferSnapshotV2,
} from '../schemas';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { FileBufferRepository } from '../adapters/file-buffer-repository';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { RuleBasedExperienceExtractor } from '../adapters/rule-based-experience-extractor';
import { LlmExperienceExtractor } from '../adapters/llm-experience-extractor';
import type { LlmClient, LlmMessage } from '../ports/llm-client';
import {
  buildContextDeliveryItem,
  contextDeliverySourceFields,
} from '../services/context-delivery';
import {
  gradeLearningInput,
  sourceDriversLabel,
} from '../services/learning-input-grade';
import type { LearningInputEvidenceVerification } from '../ports/learning-evidence-verifier';
import { persistExtractedExperiences } from '../services/memory-cycle';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { DefaultContextDeliveryProcessor } from '../runtime/context-delivery-processor';
import { InMemoryMemoryDeliveryRepository } from '../adapters/in-memory-memory-delivery';
import type { DriverReturn } from '../schemas';

const ROLE = 'role_buffer_v2';
const TASK = 'task_buffer_v2';
const RUN = 'run_buffer_v2';
const NOW = '2026-11-14T00:00:00.000Z';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// ─────────────────────────────────────────────────────────────
//  Fixtures
// ─────────────────────────────────────────────────────────────

function emptyDriverReturn(overrides: Partial<DriverReturn> = {}): DriverReturn {
  return {
    summary: 'legacy summary',
    artifacts: [],
    decisions: [],
    blockers: [],
    referenced_experiences: [],
    assumptions: [],
    ...overrides,
  };
}

function v1Snapshot(overrides: Partial<BufferSnapshot> = {}): BufferSnapshot {
  return {
    task_id: TASK,
    task_description: 'legacy task',
    driver_return: emptyDriverReturn(),
    source_task_id: TASK,
    source_driver: 'legacy-driver',
    received_at: NOW,
    retry_count: 0,
    extraction_status: 'pending',
    ...overrides,
  };
}

function dispatchSummary(
  overrides: Partial<BufferDispatchSummary> = {},
): BufferDispatchSummary {
  return {
    dispatch_id: 'dsp_1',
    kind: 'execute',
    status: 'succeeded',
    driver_id: 'driver_a',
    checks: {
      host_observed_passed: 0,
      host_observed_failed: 0,
      driver_reported: 0,
      missing: 0,
    },
    ...overrides,
  };
}

function v2Snapshot(overrides: Partial<BufferSnapshotV2> = {}): BufferSnapshotV2 {
  return {
    schema_version: BUFFER_SNAPSHOT_V2_SCHEMA_VERSION,
    buffer_version: 2,
    task_id: TASK,
    task_description: 'role autonomy task',
    source_task_id: TASK,
    journal_ref: {
      run_id: RUN,
      path: 'journal/dispatches.jsonl',
      lines: 4,
      sha256: 'a'.repeat(64),
    },
    dispatches: [],
    role_reflection: {
      status: 'completed',
      summary: 'answered without touching the workspace',
      reflection: 'no dispatch was necessary',
      unresolved: [],
      verification: [],
      memory_used: [],
    },
    source_drivers: [],
    received_at: NOW,
    retry_count: 0,
    extraction_status: 'pending',
    ...overrides,
  };
}

/** 阶段 3 早期写下的 v2（没有 role_reflection.status）：只用于兼容行为测试。 */
function legacyV2Snapshot(overrides: Partial<BufferSnapshotV2> = {}): BufferSnapshotV2 {
  const snapshot = v2Snapshot(overrides);
  const reflection = { ...snapshot.role_reflection };
  delete (reflection as { status?: unknown }).status;
  return { ...snapshot, role_reflection: reflection };
}

/** 证据核验通过时的分级输入（dispatches 必须是从 Journal 重建的那一份）。 */
function verified(
  snapshot: BufferSnapshotV2,
  finishStatus: 'completed' | 'blocked' | 'failed' = 'completed',
): LearningInputEvidenceVerification {
  return {
    status: 'verified',
    warnings: [],
    dispatches: snapshot.dispatches,
    finish_status: finishStatus,
  };
}

// ─────────────────────────────────────────────────────────────
//  版本判别
// ─────────────────────────────────────────────────────────────

describe('Buffer v2 版本判别读取', () => {
  it('无 buffer_version 的旧数据按 v1 读取', () => {
    const parsed = parseBufferSnapshot(v1Snapshot());
    expect(isBufferSnapshotV2(parsed)).toBe(false);
    expect(isBufferSnapshotV2(parsed) ? undefined : parsed.driver_return.summary).toBe(
      'legacy summary',
    );
  });

  it('buffer_version=2 的输入按 v2 读取（不看 schema_version 判别）', () => {
    const parsed = parseBufferSnapshot(v2Snapshot());
    expect(isBufferSnapshotV2(parsed)).toBe(true);
    expect(isBufferSnapshotV2(parsed) ? parsed.role_reflection.summary : undefined).toContain(
      'answered',
    );
  });

  it('未知版本显式拒绝，不降级成 v1', () => {
    expect(() => parseBufferSnapshot({ ...v1Snapshot(), buffer_version: 3 })).toThrow(
      /unsupported BufferSnapshot buffer_version=3/,
    );
  });

  it('v2 缺 journal_ref 直接解析失败（不给缺失字段编默认值）', () => {
    const broken = { ...v2Snapshot() } as Record<string, unknown>;
    delete broken.journal_ref;
    expect(() => parseBufferSnapshot(broken)).toThrow();
  });

  it('零派工来源允许 [] 或 null，且不需要 source_driver', () => {
    expect(parseBufferSnapshot(v2Snapshot({ source_drivers: [] }))).toBeDefined();
    expect(parseBufferSnapshot(v2Snapshot({ source_drivers: null }))).toBeDefined();
    const parsed = parseBufferSnapshot(v2Snapshot());
    expect(isBufferSnapshotV2(parsed) ? parsed.source_driver : 'unexpected').toBeUndefined();
  });

  it('旧 v2 缺 role_reflection.status 仍可读（缺省 = 状态未知，不补默认 completed）', () => {
    const parsed = parseBufferSnapshot(legacyV2Snapshot());
    expect(isBufferSnapshotV2(parsed)).toBe(true);
    expect(isBufferSnapshotV2(parsed) ? parsed.role_reflection.status : 'unexpected').toBeUndefined();
    const parsedCurrent = parseBufferSnapshot(v2Snapshot());
    expect(
      isBufferSnapshotV2(parsedCurrent) ? parsedCurrent.role_reflection.status : 'unexpected',
    ).toBe('completed');
  });
});

// ─────────────────────────────────────────────────────────────
//  适配器：v1/v2 混合
// ─────────────────────────────────────────────────────────────

describe('Buffer 适配器 v1/v2 混合读写', () => {
  it('内存适配器按版本读回同一 role 下的 v1 与 v2', async () => {
    const repository = new InMemoryBufferRepository();
    const savedV1 = await repository.saveBufferSnapshot(ROLE, v1Snapshot());
    const savedV2 = await repository.saveBufferSnapshot(ROLE, v2Snapshot());
    expect([savedV1.seq, savedV2.seq]).toEqual([1, 2]);

    const pending = await repository.getPendingBuffer(ROLE, savedV2.seq);
    expect(pending && isBufferSnapshotV2(pending.snapshot)).toBe(true);
    const legacy = await repository.listPendingBufferSeqs(ROLE);
    expect(legacy).toEqual([1, 2]);
    await repository.markBufferProcessed(ROLE, savedV2.seq);
    const stored = await repository.getStoredBuffer(ROLE, savedV2.seq);
    expect(stored?.location).toBe('processed');
    expect(stored && isBufferSnapshotV2(stored.snapshot)).toBe(true);
  });

  it('文件适配器落盘 v2 后原样读回，不重写成 v1', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-buffer-v2-'));
    temporaryRoots.push(root);
    const repository = new FileBufferRepository({ agentStateRoot: root });
    await repository.ensureAgent(ROLE);
    const savedV1 = await repository.saveBufferSnapshot(ROLE, v1Snapshot());
    const savedV2 = await repository.saveBufferSnapshot(ROLE, v2Snapshot());
    expect(savedV2.seq).toBe(savedV1.seq + 1);

    const pending = await repository.getPendingBuffer(ROLE, savedV2.seq);
    expect(pending && isBufferSnapshotV2(pending.snapshot)).toBe(true);

    const raw = await readFile(
      path.join(root, ROLE, 'buffer', 'pending', `report_${String(savedV2.seq)}.json`),
      'utf8',
    );
    const onDisk = JSON.parse(raw) as Record<string, unknown>;
    expect(onDisk.buffer_version).toBe(2);
    expect(onDisk.role_reflection).toBeDefined();

    await repository.archiveBuffer(ROLE, savedV2.seq);
    const archived = await repository.getStoredBuffer(ROLE, savedV2.seq);
    expect(archived?.location).toBe('processed');
    expect(archived && isBufferSnapshotV2(archived.snapshot)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
//  上下文交付项来源字段
// ─────────────────────────────────────────────────────────────

describe('上下文交付项 v2 来源字段', () => {
  it('v1 交付项保持 source_driver 与 buffer_version=1', () => {
    const source = contextDeliverySourceFields(v1Snapshot());
    const item = buildContextDeliveryItem({
      role_id: ROLE,
      task_id: TASK,
      buffer_seq: 1,
      ...source,
    });
    expect(item).toMatchObject({
      buffer_version: 1,
      source_driver: 'legacy-driver',
    });
    expect(ContextDeliveryItemSchema.parse(item).delivery_id).toBe(item.delivery_id);
  });

  it('v2 零派工交付项不填虚构 driver，来源是空列表', () => {
    const source = contextDeliverySourceFields(v2Snapshot({ source_drivers: [] }));
    const item = buildContextDeliveryItem({
      role_id: ROLE,
      task_id: TASK,
      buffer_seq: 2,
      ...source,
    });
    expect(item.buffer_version).toBe(2);
    expect(item.source_driver).toBeUndefined();
    expect(item.source_drivers).toEqual([]);
    expect(() => ContextDeliveryItemSchema.parse(item)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
//  来源分级
// ─────────────────────────────────────────────────────────────

describe('学习输入来源分级', () => {
  it('宿主观察到通过检查且 claim 被支撑 → host_observed', () => {
    const snapshot = v2Snapshot({
      dispatches: [
        dispatchSummary({
          dispatch_id: 'dsp_ok',
          checks: {
            host_observed_passed: 1,
            host_observed_failed: 0,
            driver_reported: 0,
            missing: 0,
          },
        }),
      ],
      role_reflection: {
        status: 'completed',
        summary: 'done',
        reflection: 'ran the check',
        unresolved: [],
        verification: [
          { requirement: 'tests pass', outcome: 'passed', dispatch_ids: ['dsp_ok'] },
        ],
        memory_used: [],
      },
      source_drivers: ['driver_a'],
    });
    const grade = gradeLearningInput(snapshot, verified(snapshot));
    expect(grade.level).toBe('host_observed');
    expect(grade.confidence_cap).toBeLessThanOrEqual(0.55);
    expect(grade.warnings).toEqual([]);
  });

  it('没有证据核验结果时不把 Buffer 声称的 host_observed 计数当权威', () => {
    const snapshot = v2Snapshot({
      dispatches: [
        dispatchSummary({
          dispatch_id: 'dsp_ok',
          checks: {
            host_observed_passed: 1,
            host_observed_failed: 0,
            driver_reported: 0,
            missing: 0,
          },
        }),
      ],
      role_reflection: {
        status: 'completed',
        summary: 'done',
        reflection: 'ran the check',
        unresolved: [],
        verification: [{ requirement: 'tests pass', outcome: 'passed', dispatch_ids: ['dsp_ok'] }],
        memory_used: [],
      },
      source_drivers: ['driver_a'],
    });
    const grade = gradeLearningInput(snapshot);
    expect(grade.level).toBe('role_declared');
    expect(grade.warnings.join(' ')).toContain('not checked');
  });

  it('证据引用缺失/失配时来源降级并保留诊断', () => {
    const snapshot = v2Snapshot({
      dispatches: [dispatchSummary({ dispatch_id: 'dsp_ok' })],
      role_reflection: {
        status: 'completed',
        summary: 'done',
        reflection: 'ran the check',
        unresolved: [],
        verification: [],
        memory_used: [],
      },
    });
    const grade = gradeLearningInput(snapshot, {
      status: 'mismatch',
      warnings: ['Buffer v2 journal prefix sha256 does not match the Journal content.'],
    });
    expect(grade.level).toBe('role_declared');
    expect(grade.confidence_cap).toBe(0.35);
    expect(grade.warnings.join(' ')).toContain('mismatch');
    expect(grade.warnings.join(' ')).toContain('does not match');
  });

  it('Role 自述 passed 但无宿主证据 → role_declared + 明确警告', () => {
    const snapshot = v2Snapshot({
      dispatches: [dispatchSummary({ checks: { host_observed_passed: 0, host_observed_failed: 1, driver_reported: 1, missing: 0 } })],
      role_reflection: {
        status: 'completed',
        summary: 'done',
        reflection: 'looks fine',
        unresolved: [],
        verification: [
          { requirement: 'tests pass', outcome: 'passed', dispatch_ids: ['dsp_1'] },
        ],
        memory_used: [],
      },
      source_drivers: ['driver_a'],
    });
    const grade = gradeLearningInput(snapshot);
    expect(grade.level).toBe('role_declared');
    expect(grade.warnings.join(' ')).toContain('without host-observed passing evidence');
  });

  it('零派工任务按 role_declared（不是 missing，也不伪造执行事实）', () => {
    const grade = gradeLearningInput(v2Snapshot());
    expect(grade.level).toBe('role_declared');
    expect(grade.confidence_cap).toBeLessThanOrEqual(0.35);
  });

  it('多来源 driver 以去重集合命名，零派工为空串', () => {
    expect(sourceDriversLabel(v2Snapshot({ source_drivers: ['a', 'b'] }))).toBe('a,b');
    expect(sourceDriversLabel(v2Snapshot({ source_drivers: [] }))).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────
//  提取器
// ─────────────────────────────────────────────────────────────

describe('规则版提取器对 v2 的提取', () => {
  it('零派工也产出真实（低置信度）经验，不要求六字段报告', async () => {
    const extractor = new RuleBasedExperienceExtractor();
    const output = await extractor.extract(v2Snapshot());
    expect(output.experiences.length).toBeGreaterThan(0);
    const positive = output.experiences.find((experience) => experience.type === 'positive');
    expect(positive?.confidence).toBeLessThanOrEqual(0.35);
    expect(positive?.source_driver).toBe('');
    expect(positive?.content).toContain('no dispatch');
  });

  it('Role 自述通过缺证据时置信度不超过 role_declared 上限并带警告', async () => {
    const extractor = new RuleBasedExperienceExtractor();
    const snapshot = v2Snapshot({
      dispatches: [dispatchSummary({ checks: { host_observed_passed: 0, host_observed_failed: 0, driver_reported: 1, missing: 0 } })],
      role_reflection: {
        status: 'completed',
        summary: 'all tests pass',
        reflection: 'driver said tests pass',
        unresolved: [],
        verification: [{ requirement: 'tests pass', outcome: 'passed', dispatch_ids: ['dsp_1'] }],
        memory_used: [],
      },
      source_drivers: ['driver_a'],
    });
    const output = await extractor.extract(snapshot);
    const positive = output.experiences.find((experience) => experience.type === 'positive');
    expect(positive?.confidence).toBeLessThanOrEqual(0.35);
    expect((output.warnings ?? []).join(' ')).toContain('dependent');
  });

  it('失败/未确定派工产出负经验（保留 unknown 事实）', async () => {
    const extractor = new RuleBasedExperienceExtractor();
    const output = await extractor.extract(
      v2Snapshot({
        dispatches: [
          dispatchSummary({ dispatch_id: 'dsp_unknown', status: 'unknown' }),
          dispatchSummary({ dispatch_id: 'dsp_failed', status: 'failed' }),
        ],
        role_reflection: {
          status: 'failed',
          summary: 'could not finish',
          reflection: 'driver failed',
          unresolved: ['tests not run'],
          verification: [],
          memory_used: [],
        },
        source_drivers: ['driver_a'],
      }),
    );
    const negatives = output.experiences.filter((experience) => experience.type === 'negative');
    expect(negatives.length).toBeGreaterThan(0);
    expect(negatives.some((experience) => experience.content.includes('unknown'))).toBe(true);
    expect(negatives.every((experience) => experience.confidence <= 0.5)).toBe(true);
  });

  it('宿主观察到通过后，正经验置信度可到 host_observed 上限但不更高', async () => {
    const snapshot = v2Snapshot({
      dispatches: [
        dispatchSummary({
          checks: {
            host_observed_passed: 1,
            host_observed_failed: 0,
            driver_reported: 0,
            missing: 0,
          },
        }),
      ],
      role_reflection: {
        status: 'completed',
        summary: 'done',
        reflection: 'verified',
        unresolved: [],
        verification: [{ requirement: 'tests pass', outcome: 'passed', dispatch_ids: ['dsp_1'] }],
        memory_used: [],
      },
      source_drivers: ['driver_a'],
    });
    const extractor = new RuleBasedExperienceExtractor({
      evidence: { verify: async () => verified(snapshot) },
    });
    const output = await extractor.extract(snapshot);
    const positive = output.experiences.find((experience) => experience.type === 'positive');
    expect(positive?.confidence).toBe(0.55);
    expect(positive?.source_driver).toBe('driver_a');
    expect((output.warnings ?? []).join(' ')).not.toContain('not checked');
  });

  it('v1 快照的提取行为不变（不因 v2 迁移而回归）', async () => {
    const extractor = new RuleBasedExperienceExtractor();
    const output = await extractor.extract(
      v1Snapshot({
        driver_return: emptyDriverReturn({
          summary: 'legacy done',
          decisions: [
            { point: 'approach', options: ['a', 'b'], chosen: 'a', reason: 'simplest' },
          ],
        }),
      }),
    );
    const positive = output.experiences.find((experience) => experience.type === 'positive');
    expect(positive?.confidence).toBe(0.5);
    expect(positive?.source_driver).toBe('legacy-driver');
  });
});

// ─────────────────────────────────────────────────────────────
//  Role 结束状态（问题 1）：非成功结局不能只生成正经验
// ─────────────────────────────────────────────────────────────

describe('规则版提取器保留 Role 结束状态', () => {
  function zeroDispatch(status: 'completed' | 'blocked' | 'failed'): BufferSnapshotV2 {
    return v2Snapshot({
      role_reflection: {
        status,
        summary: status === 'completed' ? 'finished the task' : 'credentials unavailable',
        reflection: '',
        unresolved: [],
        verification: [],
        memory_used: [],
      },
    });
  }

  it('零派工 blocked：结构化状态进入负经验，摘要不再变成正经验', async () => {
    const extractor = new RuleBasedExperienceExtractor();
    const output = await extractor.extract(zeroDispatch('blocked'));
    expect(output.experiences.filter((experience) => experience.type === 'positive')).toHaveLength(
      0,
    );
    const negative = output.experiences.find((experience) => experience.type === 'negative');
    expect(negative?.content).toContain('Role end status: blocked');
    expect(negative?.content).toContain('credentials unavailable');
    expect(negative?.confidence).toBeLessThanOrEqual(0.5);
    expect(negative?.tags).toContain('role_end_blocked');
  });

  it('零派工 failed：同样落成明确负经验（不是缺省正经验）', async () => {
    const extractor = new RuleBasedExperienceExtractor();
    const output = await extractor.extract(zeroDispatch('failed'));
    expect(output.experiences.filter((experience) => experience.type === 'positive')).toHaveLength(
      0,
    );
    expect(
      output.experiences.find((experience) => experience.type === 'negative')?.content,
    ).toContain('Role end status: failed');
  });

  it('零派工 completed：正常产出低置信度正经验', async () => {
    const extractor = new RuleBasedExperienceExtractor();
    const output = await extractor.extract(zeroDispatch('completed'));
    const positive = output.experiences.find((experience) => experience.type === 'positive');
    expect(positive?.content).toContain('Role end status: completed');
    expect(positive?.confidence).toBeLessThanOrEqual(0.35);
  });

  it('非成功结局但有经核验的宿主通过子结果：只把执行事实作为正经验', async () => {
    const snapshot = v2Snapshot({
      dispatches: [
        dispatchSummary({
          dispatch_id: 'dsp_ok',
          checks: {
            host_observed_passed: 1,
            host_observed_failed: 0,
            driver_reported: 0,
            missing: 0,
          },
        }),
      ],
      role_reflection: {
        status: 'blocked',
        summary: 'blocked on credentials',
        reflection: 'verified sub-part only',
        unresolved: [],
        verification: [],
        memory_used: [],
      },
      source_drivers: ['driver_a'],
    });
    const extractor = new RuleBasedExperienceExtractor({
      evidence: { verify: async () => verified(snapshot, 'blocked') },
    });
    const output = await extractor.extract(snapshot);
    const positives = output.experiences.filter((experience) => experience.type === 'positive');
    expect(positives).toHaveLength(1);
    expect(positives[0]?.tags).toContain('verified_execution_facts');
    // 不能把失败陈述包装成正经验内容。
    expect(positives[0]?.content).not.toContain('blocked on credentials');
    expect(positives[0]?.content).toContain('Role end status: blocked');
    const negative = output.experiences.find((experience) => experience.type === 'negative');
    expect(negative?.content).toContain('blocked on credentials');
  });

  it('旧 v2 缺状态：不默认 completed，不因为摘要非空就产出正经验', async () => {
    const extractor = new RuleBasedExperienceExtractor();
    const output = await extractor.extract(legacyV2Snapshot());
    expect(output.experiences).toHaveLength(0);
    expect((output.warnings ?? []).join(' ')).toContain('no role end status');
  });

  it('旧 v2 缺状态但证据核验补回 Journal finish 状态时，按补回状态处理并留诊断', async () => {
    const snapshot = legacyV2Snapshot();
    const extractor = new RuleBasedExperienceExtractor({
      evidence: { verify: async () => verified(snapshot, 'completed') },
    });
    const output = await extractor.extract(snapshot);
    expect(output.experiences.filter((experience) => experience.type === 'positive')).toHaveLength(
      1,
    );
    expect((output.warnings ?? []).join(' ')).toContain('recovered from the verified Journal finish');
  });
});

describe('LLM 提取器对 v2 的提取', () => {
  it('提示词带来源分级，LLM 高置信度被上限截断', async () => {
    const requests: LlmMessage[][] = [];
    const llm: LlmClient = {
      complete: async (input) => {
        requests.push(input.messages);
        return JSON.stringify({
          experiences: [
            {
              description: 'claim',
              content: 'something',
              type: 'positive',
              confidence: 0.99,
              tags: [],
            },
          ],
        });
      },
    };
    const extractor = new LlmExperienceExtractor(llm);
    const output = await extractor.extract(v2Snapshot());
    expect(output.experiences).toHaveLength(1);
    expect(output.experiences[0]?.confidence).toBeLessThanOrEqual(0.35);
    expect(JSON.stringify(requests)).toContain('Source grading');
    expect(JSON.stringify(requests)).toContain('host_observed_passed');
    expect(JSON.stringify(requests)).toContain('Role end status');
    expect(JSON.stringify(requests)).toContain('status=completed');
  });

  it('blocked 结束状态进入提示词，并禁止把失败陈述包装成成功', async () => {
    const requests: LlmMessage[][] = [];
    const llm: LlmClient = {
      complete: async (input) => {
        requests.push(input.messages);
        return JSON.stringify({ experiences: [] });
      },
    };
    const snapshot = v2Snapshot({
      role_reflection: {
        status: 'blocked',
        summary: 'credentials unavailable',
        reflection: '',
        unresolved: [],
        verification: [],
        memory_used: [],
      },
    });
    const extractor = new LlmExperienceExtractor(llm);
    await extractor.extract(snapshot);
    const prompt = JSON.stringify(requests);
    expect(prompt).toContain('status=blocked');
    expect(prompt).toContain('The task did not complete (blocked)');
    expect(prompt).toContain('Do not present the failure statement as a successful outcome');
  });

  it('v2 LLM 失败时降级到规则版 v2（仍可用、带警告）', async () => {
    const extractor = new LlmExperienceExtractor({
      complete: async () => {
        throw new Error('llm down');
      },
    } as never);
    const output = await extractor.extract(v2Snapshot());
    expect(output.experiences.length).toBeGreaterThan(0);
    expect((output.warnings ?? []).join(' ')).toContain('fell back to rule-based');
  });
});

// ─────────────────────────────────────────────────────────────
//  离线消费者：真实 v2 输入 → 经验落库 → 归档
// ─────────────────────────────────────────────────────────────

describe('离线消费者对 v2 学习输入的真实提取', () => {
  it('claim → 提取 → 落库 → 归档 → ack；归属仍是 role', async () => {
    const repository = new InMemoryRepository();
    await repository.initializeAgent({ role_id: ROLE, name: ROLE });
    const bufferRepository = new InMemoryBufferRepository();
    const deliveryRepository = new InMemoryMemoryDeliveryRepository();
    const saved = await bufferRepository.saveBufferSnapshot(
      ROLE,
      v2Snapshot({ source_drivers: ['driver_a'] }),
    );

    const source = contextDeliverySourceFields(v2Snapshot({ source_drivers: ['driver_a'] }));
    const item = buildContextDeliveryItem({
      role_id: ROLE,
      task_id: TASK,
      buffer_seq: saved.seq,
      ...source,
    });
    await deliveryRepository.submitContextDelivery(item);
    const claimed = await deliveryRepository.claimNextDelivery({
      channel: 'context',
      role_id: ROLE,
      owner: 'worker_1',
      lease_ms: 60_000,
    });
    if (claimed?.channel !== 'context') throw new Error('context delivery was not claimable');

    const processor = new DefaultContextDeliveryProcessor({
      deliveryRepository,
      bufferRepository,
      extractor: new RuleBasedExperienceExtractor(),
      scopeFactory: (role_id) =>
        createAgentMemoryScope(repository, bufferRepository, role_id),
    });
    const outcome = await processor.process(claimed.item, { worker_id: 'worker_1' });

    expect(outcome.status).toBe('completed');
    expect(outcome.experiences_created).toBeGreaterThan(0);
    const experiences = await repository.listExperiences(ROLE);
    expect(experiences.length).toBeGreaterThan(0);
    expect(experiences.every((experience) => experience.agent_id === ROLE)).toBe(true);
    expect(experiences.every((experience) => experience.confidence <= 0.55)).toBe(true);
    expect((await bufferRepository.getStoredBuffer(ROLE, saved.seq))?.location).toBe(
      'processed',
    );
  });

  it('提取落库的稳定身份与来源标签在 v2 上成立', async () => {
    const repository = new InMemoryRepository();
    await repository.initializeAgent({ role_id: ROLE, name: ROLE });
    const bufferRepository = new InMemoryBufferRepository();
    const scope = createAgentMemoryScope(repository, bufferRepository, ROLE);
    const extractor = new RuleBasedExperienceExtractor();
    const delivery = await bufferRepository.saveBufferSnapshot(ROLE, v2Snapshot());
    const pending = await bufferRepository.getPendingBuffer(ROLE, delivery.seq);
    if (!pending || !isBufferSnapshotV2(pending.snapshot)) throw new Error('v2 pending missing');
    const extraction = await extractor.extract(pending.snapshot);
    const persisted = await persistExtractedExperiences(scope, delivery.seq, extraction.experiences);
    expect(persisted.created).toBe(extraction.experiences.length);
    expect(persisted.experiences.map((experience) => experience.agent_id)).toEqual(
      extraction.experiences.map(() => ROLE),
    );
  });
});
