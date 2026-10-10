/**
 * Plan 核对指令 —— 只有两段文案，没有任何解析或判定逻辑，这是刻意的。
 *
 * 上一版要求执行者把 `plan_todo_<24 位十六进制>` 这种不透明 id 原样回抄，并输出精确的
 * `<!-- newide:plan-execution -->` + 围栏 JSON；机器再拿这份自报和工作区 diff 交叉核对，
 * 有缺口就降级 outcome 并打回一次。实测（plan_first run，6 条清单）证明这条路走不通：
 *
 *   执行者把三个文件全建好、测试全绿、冒烟输出逐字命中计划要求，只是清单块没有精确匹配
 *   格式。系统据此判它 0/6，打回并让它"去把没做的做完"；它于是重写了一遍已经正确的文件。
 *
 * 也就是说：格式的脆弱性直接变成了假阴性和无谓返工。要求模型严谨遵循一个精确格式，
 * 本质上是把流程的正确性押在一次不透明字符串的精确复制上。
 *
 * 现在核对是**执行者自己的显式动作**，产物是**给人读的**：
 *   - 机器不解析自报、不判定遵循度、不降级 outcome、不因缺口重试；
 *   - 核对段落随执行者的回复原样落进 run 产物，由人（或下游角色）阅读；
 *   - 检查是否真的发生，靠指令说得够明白，而不是靠机器卡格式。
 *
 * 因此「计划遵循情况」在当前设计里是一个**可读的人工证据**，不是一个自动指标。
 */

/**
 * Plan 正文里的步骤清单要求。步骤能被逐条走，是核对能成立的前提：
 * 条目含糊或一条塞进多个交付物，执行者事后就没法逐项说清做了没。
 */
export const PLAN_STEP_LIST_REQUIREMENT: readonly string[] = [
  'Write the ordered steps as a numbered list, one step per line.',
  'Phrase each step so it can be judged on its own: name the file it touches and what must be true once it is done.',
  'Steps that change no file (a baseline check, running the tests) must still say what they inspect and what result they expect.',
  'The implementation phase walks this list one entry at a time, so never let one step cover several deliverables.',
];

/**
 * 实现阶段结束前的显式核对要求。要点是顺序（先取证再判断）和诚实（缺口明说），
 * 而不是格式。
 */
export const PLAN_SELF_CHECK_REQUIREMENT: readonly string[] = [
  'Do not end the turn with only a summary. When the implementation is done, run one explicit check pass against the Plan.',
  'First re-open the Plan file and every product file you changed. Judge nothing from memory or from what you meant to write.',
  'Then write a "Plan check" section (heading "## Plan check", or the same heading in the Task language) that walks the Plan\'s ordered steps one at a time, in order.',
  'For each step give: what the step asks for, whether it is done, and the concrete evidence - which file, and where in it.',
  'Steps that change no file are checked the same way: say what you inspected and what it showed.',
  'If a step is not done, only partly done, or you cannot point at concrete evidence, write that plainly. Do not round up, and do not reword a step to make it look satisfied.',
  'A reviewer reads this section to decide whether the Plan was followed. An honest gap is useful to them; a false "done" is not.',
];
