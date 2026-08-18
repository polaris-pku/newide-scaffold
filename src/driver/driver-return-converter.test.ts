import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../core';
import { MockLlmClient } from '../memory/adapters/mock-llm-client';
import type { DriverRunResult } from './contract';
import {
  createDefaultDriverReturnConverter,
  createLlmDriverReturnConverter,
  normalizeDriverReturn,
  parseDriverReturnFromTranscript,
} from './driver-return-converter';

const SAMPLE_DRIVER_RETURN = {
  artifacts: [
    {
      type: 'file',
      path: 'artifact://driver_result/task_llm/result.json',
      summary: 'Generated result artifact',
    },
  ],
  summary: 'Task completed successfully via LLM generation.',
  decisions: [
    {
      point: 'Execution approach',
      options: ['delegate', 'direct'],
      chosen: 'delegate',
      reason: 'Driver was best suited for the task.',
    },
  ],
  blockers: [],
  referenced_experiences: [],
  assumptions: [
    {
      assumption: 'The generated artifact is valid.',
      risk_if_wrong: 'Downstream consumers may fail.',
    },
  ],
};

const INSTRUCTION = 'Generate a structured six-field report from the driver result.';

describe('parseDriverReturnFromTranscript', () => {
  it('parses tagged DriverReturn blocks', () => {
    const text = `Some transcript text\n<<<DRIVER_RETURN>>>\n${JSON.stringify(SAMPLE_DRIVER_RETURN)}\n<<<END_DRIVER_RETURN>>>\nMore text`;
    const result = parseDriverReturnFromTranscript(text);
    expect(result).toEqual(SAMPLE_DRIVER_RETURN);
  });

  it('parses JSON code blocks', () => {
    const text = `\`\`\`json\n${JSON.stringify(SAMPLE_DRIVER_RETURN)}\n\`\`\``;
    const result = parseDriverReturnFromTranscript(text);
    expect(result).toEqual(SAMPLE_DRIVER_RETURN);
  });

  it('returns null when no structured block is present', () => {
    const result = parseDriverReturnFromTranscript('plain transcript without json');
    expect(result).toBeNull();
  });
});

describe('createDefaultDriverReturnConverter', () => {
  it('returns parsed DriverReturn when transcript contains structured block', async () => {
    const converter = createDefaultDriverReturnConverter();
    const transcriptText = `<<<DRIVER_RETURN>>>\n${JSON.stringify(SAMPLE_DRIVER_RETURN)}\n<<<END_DRIVER_RETURN>>>`;
    const result = await converter(driverRunResult(), { transcriptText, instruction: INSTRUCTION });
    expect(result).toEqual(SAMPLE_DRIVER_RETURN);
  });

  it('falls back to construction when transcript lacks structured block', async () => {
    const converter = createDefaultDriverReturnConverter();
    const result = await converter(driverRunResult(), {
      transcriptText: 'plain text',
      instruction: INSTRUCTION,
    });
    expect(result.summary).toContain('llm-test-driver');
    expect(result.artifacts).toHaveLength(1);
  });
});

describe('createLlmDriverReturnConverter', () => {
  it('parses transcript block without calling LLM when available', async () => {
    const llm = new MockLlmClient([]);
    const converter = createLlmDriverReturnConverter(llm);
    const transcriptText = `<<<DRIVER_RETURN>>>\n${JSON.stringify(SAMPLE_DRIVER_RETURN)}\n<<<END_DRIVER_RETURN>>>`;

    const result = await converter(driverRunResult(), { transcriptText, instruction: INSTRUCTION });

    expect(result).toEqual(SAMPLE_DRIVER_RETURN);
  });

  it('calls LLM and returns parsed DriverReturn', async () => {
    const llm = new MockLlmClient([{ response: JSON.stringify(SAMPLE_DRIVER_RETURN) }]);
    const converter = createLlmDriverReturnConverter(llm);

    const result = await converter(driverRunResult(), { instruction: INSTRUCTION });

    expect(result).toEqual(SAMPLE_DRIVER_RETURN);
  });

  it('falls back to construction when LLM returns invalid JSON', async () => {
    const llm = new MockLlmClient([{ response: 'not-json' }]);
    const converter = createLlmDriverReturnConverter(llm);

    const result = await converter(driverRunResult(), { instruction: INSTRUCTION });

    expect(result.summary).toContain('llm-test-driver');
    expect(result.artifacts).toHaveLength(1);
  });

  it('normalizes incomplete LLM output instead of falling back', async () => {
    const incomplete = JSON.stringify({ summary: 'real LLM summary' });
    const llm = new MockLlmClient([{ response: incomplete }]);
    const converter = createLlmDriverReturnConverter(llm);

    const result = await converter(driverRunResult(), { instruction: INSTRUCTION });

    // normalize 补全了缺失的数组字段，保留了 LLM 的真实 summary
    expect(result.summary).toBe('real LLM summary');
    expect(result.artifacts).toEqual([]);
    expect(result.decisions).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(result.referenced_experiences).toEqual([]);
    expect(result.assumptions).toEqual([]);
  });

  it('falls back to construction when LLM output cannot be normalized', async () => {
    const nonObject = JSON.stringify(['not', 'an', 'object']);
    const llm = new MockLlmClient([{ response: nonObject }]);
    const converter = createLlmDriverReturnConverter(llm);

    const result = await converter(driverRunResult(), { instruction: INSTRUCTION });

    expect(result.summary).toContain('llm-test-driver');
  });

  it('falls back to construction when LLM throws', async () => {
    const llm = new MockLlmClient([{ response: 'ERROR:mock llm failure' }]);
    const converter = createLlmDriverReturnConverter(llm);

    const result = await converter(driverRunResult(), { instruction: INSTRUCTION });

    expect(result.summary).toContain('llm-test-driver');
  });
});

describe('normalizeDriverReturn', () => {
  it('fills missing list fields with empty arrays while keeping real content', () => {
    const raw = {
      summary: 'Real summary from LLM',
      artifacts: [{ type: 'file', path: '/tmp/a.txt', summary: 'wrote a' }],
      decisions: [],
      // blockers / referenced_experiences / assumptions missing
    };

    const result = normalizeDriverReturn(raw);

    expect(result).not.toBeNull();
    expect(result!.artifacts).toEqual([
      { type: 'file', path: '/tmp/a.txt', summary: 'wrote a' },
    ]);
    expect(result!.summary).toBe('Real summary from LLM');
    expect(result!.blockers).toEqual([]);
    expect(result!.referenced_experiences).toEqual([]);
    expect(result!.assumptions).toEqual([]);
  });

  it('repairs wrong field types (string boolean, object options, scalar attempts)', () => {
    const raw = {
      summary: 'done',
      artifacts: [],
      decisions: [
        {
          point: 'Approach',
          options: 'single-option', // string instead of array
          chosen: 'single-option',
          reason: 'why',
        },
      ],
      blockers: [
        {
          blocker: 'b',
          attempts: 'attempt 1', // string instead of array
          resolution: 'r',
          resolved: 'yes', // string instead of boolean
        },
      ],
      referenced_experiences: [],
      assumptions: [],
    };

    const result = normalizeDriverReturn(raw);

    expect(result).not.toBeNull();
    expect(result!.decisions[0]!.options).toEqual(['single-option']);
    expect(result!.blockers[0]!.attempts).toEqual(['attempt 1']);
    expect(result!.blockers[0]!.resolved).toBe(true);
  });

  it('maps effectiveness aliases to the schema enum', () => {
    const raw = {
      summary: 'done',
      artifacts: [],
      decisions: [],
      blockers: [],
      referenced_experiences: [
        {
          experience_id: 'exp_1',
          applied: true,
          effectiveness: 'somewhat', // alias of partially_effective
          note: 'n',
        },
      ],
      assumptions: [],
    };

    const result = normalizeDriverReturn(raw);

    expect(result).not.toBeNull();
    expect(result!.referenced_experiences[0]!.effectiveness).toBe('partially_effective');
  });

  it('drops unrecognized effectiveness values by falling back to not_applicable', () => {
    const raw = {
      summary: 'done',
      artifacts: [],
      decisions: [],
      blockers: [],
      referenced_experiences: [
        {
          experience_id: 'exp_1',
          applied: false,
          effectiveness: 'completely-bogus',
          note: 'n',
        },
      ],
      assumptions: [],
    };

    const result = normalizeDriverReturn(raw);

    expect(result).not.toBeNull();
    expect(result!.referenced_experiences[0]!.effectiveness).toBe('not_applicable');
  });

  it('drops unknown top-level fields and preserves the optional effectiveness enum', () => {
    const raw = {
      summary: 'done',
      artifacts: [],
      decisions: [],
      blockers: [],
      referenced_experiences: [],
      assumptions: [],
      effectiveness: 'fully_effective',
      output: 'extra field that must be stripped',
    };

    const result = normalizeDriverReturn(raw);

    expect(result).not.toBeNull();
    expect(result!.effectiveness).toBe('fully_effective');
    expect('output' in result!).toBe(false);
  });

  it('returns null for non-object input', () => {
    expect(normalizeDriverReturn(null)).toBeNull();
    expect(normalizeDriverReturn('string')).toBeNull();
    expect(normalizeDriverReturn([1, 2, 3])).toBeNull();
  });

  it('converts string-array fields to schema objects (real LLM output shape)', () => {
    // 真实运行（eval 归档 main-prctx-B0B1B2）中 LLM 把六个字段全部输出为字符串数组：
    // artifacts 是文件路径列表、decisions/blockers/assumptions 是文本列表、
    // referenced_experiences 是 experience id 列表。
    const raw = {
      artifacts: ['conan/api/conan_api.py', 'conan/model/info.py'],
      summary: 'Implemented the plan.',
      decisions: ['Step 25 fallback fix applied', 'Step 8 package-scoped confs'],
      blockers: ['Git metadata is broken in this environment', 'No internet access'],
      referenced_experiences: ['587dc1fd-93ca-4df9-bb25-d633d5bf4b1b'],
      assumptions: ['The working tree is the deliverable'],
    };

    const result = normalizeDriverReturn(raw);

    expect(result).not.toBeNull();
    expect(result!.artifacts).toEqual([
      { type: 'file', path: 'conan/api/conan_api.py', summary: '' },
      { type: 'file', path: 'conan/model/info.py', summary: '' },
    ]);
    expect(result!.decisions).toEqual([
      { point: 'Step 25 fallback fix applied', options: [], chosen: '', reason: '' },
      { point: 'Step 8 package-scoped confs', options: [], chosen: '', reason: '' },
    ]);
    expect(result!.blockers).toEqual([
      {
        blocker: 'Git metadata is broken in this environment',
        attempts: [],
        resolution: '',
        resolved: false,
      },
      { blocker: 'No internet access', attempts: [], resolution: '', resolved: false },
    ]);
    expect(result!.referenced_experiences).toEqual([
      {
        experience_id: '587dc1fd-93ca-4df9-bb25-d633d5bf4b1b',
        applied: true,
        effectiveness: 'not_applicable',
        note: '',
      },
    ]);
    expect(result!.assumptions).toEqual([
      { assumption: 'The working tree is the deliverable', risk_if_wrong: '' },
    ]);
  });

  it('parses a DRIVER_RETURN block without END marker via bare-JSON fallback', () => {
    // 真实运行中 Claude Code 输出的 <<<DRIVER_RETURN>>> 块常缺 <<<END_DRIVER_RETURN>>>，
    // 且六字段为字符串数组；策略 C（裸 JSON）必须兜住。
    const transcript = [
      'Some prior text...',
      '<<<DRIVER_RETURN>>>',
      '{',
      '  "artifacts": ["conan/api/conan_api.py"],',
      '  "summary": "Implemented the approved Council Plan.",',
      '  "decisions": ["Step 25 fallback fix applied"],',
      '  "blockers": ["Git metadata is broken"],',
      '  "referenced_experiences": ["587dc1fd-93ca-4df9-bb25-d633d5bf4b1b"],',
      '  "assumptions": ["The working tree is the deliverable"]',
      '}',
      'more text after without END marker...',
    ].join('\n');

    const result = parseDriverReturnFromTranscript(transcript);

    expect(result).not.toBeNull();
    expect(result!.artifacts).toEqual([
      { type: 'file', path: 'conan/api/conan_api.py', summary: '' },
    ]);
    expect(result!.decisions).toHaveLength(1);
    expect(result!.blockers).toHaveLength(1);
    expect(result!.referenced_experiences).toHaveLength(1);
    expect(result!.assumptions).toHaveLength(1);
    expect(result!.summary).toContain('Implemented the approved Council Plan');
  });
});

function driverRunResult(): DriverRunResult {
  const created_at = '2026-07-03T00:00:01.000Z';
  const transcript = artifactRef({
    artifact_id: 'artifact_transcript',
    type: 'transcript',
    uri: 'artifact://transcript/task_llm/session_llm',
    created_at,
  });

  return {
    driver_run_result_id: 'driver_result_llm',
    session_id: 'session_llm',
    status: 'succeeded',
    artifacts: [
      artifactRef({
        artifact_id: 'artifact_driver_result',
        type: 'driver_result',
        uri: 'artifact://driver_result/task_llm/driver_result_llm.json',
        created_at,
      }),
    ],
    transcript_ref: transcript,
    tool_events: [
      {
        tool_event_id: 'event_1',
        tool_name: 'write_file',
        status: 'completed',
        summary: 'Wrote result file',
        created_at,
        schema_version: SCHEMA_VERSION,
      },
    ],
    diagnostics: {
      driver_id: 'llm-test-driver',
      duration_ms: 42,
      notes: ['LLM converter test run.'],
    },
    created_at,
    schema_version: SCHEMA_VERSION,
  };
}

function artifactRef(input: {
  artifact_id: string;
  type: ArtifactRef['type'];
  uri: string;
  created_at: string;
}): ArtifactRef {
  return {
    artifact_id: input.artifact_id,
    type: input.type,
    uri: input.uri,
    producer_id: 'llm-test-driver',
    task_id: 'task_llm',
    created_at: input.created_at,
    schema_version: SCHEMA_VERSION,
  };
}
