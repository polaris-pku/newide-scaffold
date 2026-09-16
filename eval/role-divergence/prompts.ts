/**
 * prompts — 逐字固定的任务模板
 *
 * 模板里**不出现角色名**：角色的身份与知识只经由 agent 的 persona 与按 role_id
 * 检索到的技能进入上下文。因此同一模板对五个角色、以及中性对照都是同一份字节，
 * 「提示词逐字一致」这条控制由结构保证而不是靠人工核对。
 *
 * 两个模板都要求产出写到固定文件名、禁止改动其它文件。
 *
 * **两种实验形态各有一组逐字固定的约束**（由 `--repo-checkout` 选择，跨角色不变量）：
 * - 无仓库：工作区是空 scratch 目录，明说去别处找是白费；
 * - 有仓库：只读仓库挂在 `repo/`，要求先读代码再下结论——plan 的「areas of the code」
 *   与「root cause」此后必须落到真实文件上，而不是「expected locations」。
 */
import type { SweEvoInstance } from '../types';
import { REVIEW_VERDICTS, type ReviewVerdict } from './types';
import { REPO_MOUNT_NAME } from './repo-checkout';

export const PLAN_FILE = 'plan.md';
export const REVIEW_FILE = 'review.md';

/** 无仓库形态：明说工作区是空的，避免 agent 反复去找不存在的仓库（会烧穿预算） */
const CONSTRAINTS_NO_REPO = [
  '- Keep every read and write inside the current working directory.',
  '- The repository is not checked out in the working directory: there are no source files',
  '  to read there.',
  '- Use only the problem statement below; internet access is unavailable.',
];

/**
 * 有仓库形态：仓库只读挂在 `repo/`，要求读代码取证。
 *
 * **预算条款是被实测逼出来的。** 第一版只写了 "Search efficiently rather than reading the
 * whole tree" 这类软建议，结果 correctness 一格跑了 **121 次工具调用（Read 72 / Grep 34 /
 * Glob 14）、0 次 Write**，峰值上下文 151,706 / 200,000，23 分钟还没动笔——与早年
 * "security 连续 17 次调用全是探索、一次 Write 都没发出" 是同一个病：**没有停止判据**。
 *
 * 成本结构决定了这有多贵：driver 每轮重发整个上下文，所以一格的输入量 ≈
 * `Σ(起始上下文 + r·n) ≈ N·C₀ + r·N²/2`。起始约 74k、每次调用涨约 654，N=121 时约
 * **1360 万 token**；把 N 压到 25 量级可降一个数量级。所以这里的条款是**硬约束**，
 * 不是风格建议。
 */
const CONSTRAINTS_WITH_REPO = [
  '- Keep every write inside the current working directory.',
  `- A read-only checkout of the repository is mounted at \`${REPO_MOUNT_NAME}/\` relative to the`,
  '  current working directory.',
  '- Read the relevant source under `repo/` before drawing conclusions, and cite the files and',
  '  symbols you rely on. Every file you read stays in your context for the rest of the task, so',
  '  reading is not free.',
  '',
  'Exploration budget for this task — treat these as hard limits:',
  '- Glob/Grep to locate the code first; only then Read. Never read a whole directory, and never',
  '  re-read a file you have already read.',
  '- Read at most 8 files in total, and prefer reading only the relevant line ranges of a large',
  '  file over reading it end to end.',
  '- Run at most 15 search commands (Glob/Grep/Bash) in total.',
  '- You have gathered enough evidence once you can name the files and functions you would',
  '  change. At that point stop searching and start writing the plan. Do not keep reading to',
  '  remove every uncertainty — say what you inferred and what you did not verify instead.',
  `- Do not modify anything under \`${REPO_MOUNT_NAME}/\`; it is read-only reference material.`,
  '- Do not use shell commands; internet access is unavailable.',
];

function constraints(repoCheckout: boolean): string[] {
  return repoCheckout ? CONSTRAINTS_WITH_REPO : CONSTRAINTS_NO_REPO;
}

/** 生成 plan 的任务模板——实验一与白板 plan 共用同一份字节 */
export function planPrompt(instance: SweEvoInstance, repoCheckout = false): string {
  return [
    `Write an implementation plan for the task below to the file \`${PLAN_FILE}\` in the current working directory.`,
    '',
    'Constraints:',
    `- Produce the plan only. Do not implement the change.`,
    '- Do not create, modify, rename, or delete any file other than the plan file.',
    '- Do not add, edit, or generate tests or test-runner configuration.',
    ...constraints(repoCheckout),
    '',
    'The plan must state the likely root cause, the areas of the code it touches, the ordered',
    'edits you would make, the risks you accept, and how the change would be verified.',
    '',
    `Repository: ${instance.repo}`,
    `Instance: ${instance.instance_id}`,
    '',
    'Problem statement:',
    instance.problem_statement,
  ].join('\n');
}

/**
 * 评审模板——实验二（评审白板 plan）与实验三（交叉评审角色 plan）共用。
 * 被审 plan 以正文内联，**不带任何作者身份**；同一实例下各审者的模板字节相同。
 */
export function reviewPrompt(
  instance: SweEvoInstance,
  plan: string,
  repoCheckout = false,
): string {
  return [
    `Review the implementation plan below from your own area of responsibility, and write your`,
    `review to the file \`${REVIEW_FILE}\` in the current working directory.`,
    '',
    `The first line of \`${REVIEW_FILE}\` must be exactly one of:`,
    ...REVIEW_VERDICTS.map((verdict) => `VERDICT: ${verdict}`),
    '',
    'After that line, give your findings and the reasoning behind the verdict.',
    '',
    'Constraints:',
    '- Review only. Do not implement the change or rewrite the plan.',
    '- Do not create, modify, rename, or delete any file other than the review file.',
    '- Do not add, edit, or generate tests or test-runner configuration.',
    ...constraints(repoCheckout),
    ...(repoCheckout ? ['', 'Cite the code you relied on when you can.'] : []),
    '',
    `Repository: ${instance.repo}`,
    `Instance: ${instance.instance_id}`,
    '',
    'Problem statement:',
    instance.problem_statement,
    '',
    'Plan under review:',
    plan,
  ].join('\n');
}

/**
 * 从产出正文宽容提取裁决：只看首行（允许前置空白与 markdown 加粗）。
 * 提不到返回 undefined，调用方记 `review_parse_failed`——不猜测、不默认。
 */
export function parseVerdict(text: string): ReviewVerdict | undefined {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0);
  if (!firstLine) {
    return undefined;
  }
  const normalized = firstLine.trim().replace(/^[*_`\s]+|[*_`\s]+$/g, '');
  const match = /^VERDICT\s*[:：]\s*(.+)$/i.exec(normalized);
  if (!match) {
    return undefined;
  }
  const value = match[1]!.trim().toLowerCase().replace(/[.;,]+$/, '');
  return (REVIEW_VERDICTS as readonly string[]).includes(value)
    ? (value as ReviewVerdict)
    : undefined;
}
