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
