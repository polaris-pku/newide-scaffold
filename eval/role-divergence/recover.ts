/**
 * recover — 从历史运行归档里回收 problem_statement
 *
 * SWE-EVO 消融跑把完整任务提示写进每次运行的 `state/runs/<run_id>/request.json`，
 * 提示的构造是「固定头部 + `Problem statement:` + **原样**的问题陈述」，标记在提示里
 * 只出现一次、其后无任何追加。因此从标记之后切到底，就是该字段的原文。
 *
 * 用于规范 jsonl（`eval/data/sweevo-v0-repo-full-prctx.jsonl`）不在手边时，在不触网、
 * 不需要 GITHUB_TOKEN 的前提下复现同一串字节。
 */

export const PROBLEM_STATEMENT_MARKER = 'Problem statement:';

/**
 * 切出问题陈述；无标记返回 undefined（说明该提示不是本管线产出的）。
 *
 * 取**首个**匹配：标记若恰好也出现在某段 PR 正文里，它必然位于头部标记之后，
 * 而头部标记总是提示里最靠前的那个。
 */
export function extractProblemStatement(prompt: string): string | undefined {
  const at = prompt.indexOf(PROBLEM_STATEMENT_MARKER);
  if (at < 0) return undefined;
  const body = prompt.slice(at + PROBLEM_STATEMENT_MARKER.length);
  if (body.startsWith('\r\n')) return body.slice(2);
  if (body.startsWith('\n')) return body.slice(1);
  return body;
}
