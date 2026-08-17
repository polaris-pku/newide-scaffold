/**
 * DriverReturnInstruction — 构造要求 Driver 输出六字段报告的指令文本
 *
 * 指令无条件要求：
 * - 必须包含全部六个字段（summary/artifacts/decisions/blockers/
 *   referenced_experiences/assumptions），无内容也必须输出 []，绝不省略字段
 * - 只输出 JSON 对象本身，不要 markdown 代码块或额外文字
 * - blockers[].resolved 必须是布尔、referenced_experiences[].effectiveness
 *   必须是枚举值（配合 DriverReturnConverter 的容错 normalize 双保险）
 *
 * ACP_WRITE_REPORT_FILE=1 时追加"写 {taskId}_report.txt 文件"的最终步骤。
 */
const DRIVER_RETURN_EXAMPLE = {
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
};

/** 全空示例：强调"无内容也必须输出 []，绝不省略字段" */
const EMPTY_DRIVER_RETURN_EXAMPLE = {
  artifacts: [],
  summary: 'Summarize what was done in 2-3 sentences.',
  decisions: [],
  blockers: [],
  referenced_experiences: [],
  assumptions: [],
};

export function buildDriverReturnInstruction(input: {
  taskId: string;
  writeReportFile: boolean;
}): string {
  const sections = [
    '---',
    'After completing the task, output a structured report in the following JSON format:',
    '<<<DRIVER_RETURN>>>',
    JSON.stringify(DRIVER_RETURN_EXAMPLE, null, 2),
    '<<<END_DRIVER_RETURN>>>',
    '',
    'REQUIREMENTS (MUST follow):',
    '1. The report MUST contain all six fields: summary, artifacts, decisions, blockers, referenced_experiences, assumptions.',
    '2. If a list field has no items, still output it as an empty array ([]). Never omit a field.',
    '3. Output ONLY the JSON object — no markdown, no code fences, no extra text before or after.',
    '4. "resolved" in blockers MUST be a boolean (true or false), never a string.',
    '5. "effectiveness" in referenced_experiences MUST be one of: "fully_effective", "partially_effective", "ineffective", "not_applicable".',
    '',
    'Example with empty lists (fields still present):',
    '<<<DRIVER_RETURN>>>',
    JSON.stringify(EMPTY_DRIVER_RETURN_EXAMPLE, null, 2),
    '<<<END_DRIVER_RETURN>>>',
  ];

  if (input.writeReportFile) {
    sections.push(
      '---',
      'FINAL STEP — After completing the task, you MUST write a report file:',
      `- File name: exactly \`${input.taskId}_report.txt\` in the workspace root directory.`,
      '- File content: a JSON object containing the six-field report. The JSON MUST be the object inside the <<<DRIVER_RETURN>>> block above — DO NOT include the markers themselves. The file MUST start with `{` and end with `}` and be valid JSON.',
      '- Required fields: summary, artifacts, decisions, blockers, referenced_experiences, assumptions.',
    );
  }

  return sections.join('\n');
}

export function shouldWriteDriverReportFile(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ACP_WRITE_REPORT_FILE === '1' || env.ACP_WRITE_REPORT_FILE === 'true';
}
