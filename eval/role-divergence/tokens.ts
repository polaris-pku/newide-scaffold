/**
 * tokens — 技能正文的体量估算（无副作用，可单测）
 *
 * 口径与语料收敛那轮一致：散文字符/4 + 代码字符/3。代码 tokenize 更差，所以围栏内
 * 的字符按 3 计。这里的数字只用于证据与探针比较，不参与任何决策。
 */

/** 按围栏切分散文与代码，返回估算 token 数（四舍五入） */
export function estimateTokens(text: string): number {
  let prose = 0;
  let code = 0;
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      code += line.length + 1;
    } else {
      prose += line.length + 1;
    }
  }
  return Math.round(prose / 4 + code / 3);
}
