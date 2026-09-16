/**
 * role-divergence — harness 的离线守卫
 *
 * 全部不触网、不调 API。守住三件最要紧的事：阶段规模与交叉矩阵的形状、「提示词
 * 模板逐字一致」这条控制、以及检索策略与生产默认值不漂移。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CORPUS_ROLES,
  DEFAULT_MEMORY_RELEVANCE_POLICY,
  ROLE_AGENT_IDS,
  type CorpusRole,
} from '../../src/memory';
import type { SweEvoInstance } from '../../eval/types';
import {
  cellPath,
  clearCell,
  collectCells,
  DRIVER_WORKSPACE_DENY_RULES,
  DRIVER_WORKSPACE_DENY_RULES_WITH_REPO,
  driverWorkspaceSettings,
  readCell,
  writeCell,
  writeDriverWorkspaceSettings,
} from '../../eval/role-divergence/cache';
import { resolveExperimentConfig } from '../../eval/role-divergence/config';
import { buildBatches } from '../../eval/role-divergence/plan';
import {
  PLAN_FILE,
  REVIEW_FILE,
  parseVerdict,
  planPrompt,
  reviewPrompt,
} from '../../eval/role-divergence/prompts';
import { extractProblemStatement, PROBLEM_STATEMENT_MARKER } from '../../eval/role-divergence/recover';
import { extractInjection, findContextPackForRun, summarizeAgentToolCalls } from '../../eval/role-divergence/evidence';
import { evaluateInjectionGate } from '../../eval/role-divergence/injection-gate';
import { buildReviewCells, seededShuffle } from '../../eval/role-divergence/shuffle';
import { estimateTokens } from '../../eval/role-divergence/tokens';
import { cellId, type CellEvidence } from '../../eval/role-divergence/types';

const ROLES: readonly CorpusRole[] = CORPUS_ROLES;

function instance(id: string): SweEvoInstance {
  return {
    repo: 'dask/dask',
    instance_id: id,
    base_commit: 'deadbeef',
    patch: '',
    problem_statement: `GroupBy.value_counts returns wrong results on all-NA partitions (${id}).`,
  };
}

const ONE = [instance('dask__dask_2023.3.2_2023.4.0')];
const THREE = [
  instance('dask__dask_2023.3.2_2023.4.0'),
  instance('dask__dask_2023.6.0_2023.6.1'),
  instance('dask__dask_2024.3.1_2024.4.0'),
];

describe('stage planning', () => {
  it('minimal = 5 个 plan_role 单元，一角色一批', () => {
    const batches = buildBatches('minimal', ONE, [...ROLES]);
    expect(batches).toHaveLength(ROLES.length);
    const keys = batches.flatMap((batch) => batch.keys);
    expect(keys).toHaveLength(5);
    expect(keys.every((key) => key.experiment === 'plan_role')).toBe(true);
    expect(new Set(keys.map((key) => key.role_key)).size).toBe(5);
  });

  it('full = 108 个单元，拆分为 白板 3 / 生成 15 / 评审白板 15 / 交叉 75', () => {
    const keys = buildBatches('full', THREE, [...ROLES]).flatMap((batch) => batch.keys);
    expect(keys).toHaveLength(108);
    const byExperiment = new Map<string, number>();
    for (const key of keys) {
      byExperiment.set(key.experiment, (byExperiment.get(key.experiment) ?? 0) + 1);
    }
    expect(byExperiment.get('plan_neutral')).toBe(3);
    expect(byExperiment.get('plan_role')).toBe(15);
    expect(byExperiment.get('review_neutral')).toBe(15);
    expect(byExperiment.get('review_role')).toBe(75);
  });

  it('全部 plan 批次排在 review 批次之前（评审要读上游产出）', () => {
    const batches = buildBatches('full', THREE, [...ROLES]);
    const lastPlan = batches.reduce(
      (last, batch, index) =>
        batch.keys.every((key) => key.experiment.startsWith('plan_')) ? index : last,
      -1,
    );
    const firstReview = batches.findIndex((batch) =>
      batch.keys.every((key) => key.experiment.startsWith('review_')),
    );
    expect(lastPlan).toBeGreaterThanOrEqual(0);
    expect(firstReview).toBeGreaterThan(lastPlan);
  });

  it('单元 id 全局唯一', () => {
    const keys = buildBatches('full', THREE, [...ROLES]).flatMap((batch) => batch.keys);
    const ids = keys.map(cellId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('cross review matrix', () => {
  it('覆盖 5×5 且每对只出现一次', () => {
    const pairs = buildReviewCells('dask__dask_2023.3.2_2023.4.0', ROLES);
    expect(pairs).toHaveLength(25);
    expect(new Set(pairs.map((pair) => `${pair.reviewer}->${pair.author}`)).size).toBe(25);
  });

  it('顺序由实例 id 决定，可复现', () => {
    expect(buildReviewCells('inst-a', ROLES)).toEqual(buildReviewCells('inst-a', ROLES));
  });

  it('不同实例给出不同顺序（避免固定位置效应）', () => {
    const a = buildReviewCells('inst-a', ROLES).map((pair) => `${pair.reviewer}->${pair.author}`);
    const b = buildReviewCells('inst-b', ROLES).map((pair) => `${pair.reviewer}->${pair.author}`);
    expect(a).not.toEqual(b);
  });

  it('seededShuffle 是排列且确定', () => {
    const source = Array.from({ length: 25 }, (_, index) => index);
    const shuffled = seededShuffle(source, 'seed');
    expect([...shuffled].sort((left, right) => left - right)).toEqual(source);
    expect(seededShuffle(source, 'seed')).toEqual(shuffled);
    expect(seededShuffle(source, 'other')).not.toEqual(shuffled);
  });
});

describe('prompt templates', () => {
  const target = ONE[0]!;

  it('生成模板不提及任何角色，且同一实例字节恒定', () => {
    const prompt = planPrompt(target);
    for (const role of ROLES) {
      expect(prompt).not.toContain(role);
      expect(prompt).not.toContain(ROLE_AGENT_IDS[role]);
    }
    expect(planPrompt(target)).toBe(prompt);
    expect(prompt).toContain(PLAN_FILE);
    expect(prompt).toContain(target.problem_statement);
  });

  it('评审模板只随被审 plan 变化，头部逐字相同', () => {
    const a = reviewPrompt(target, 'PLAN_ALPHA');
    const b = reviewPrompt(target, 'PLAN_BETA');
    expect(a.split('PLAN_ALPHA')[0]).toBe(b.split('PLAN_BETA')[0]);
    expect(a).not.toContain('PLAN_BETA');
    for (const role of ROLES) {
      expect(a).not.toContain(role);
      expect(a).not.toContain(ROLE_AGENT_IDS[role]);
    }
    expect(a).toContain(REVIEW_FILE);
  });

  it('评审模板要求三选一的裁决首行', () => {
    const prompt = reviewPrompt(target, 'PLAN');
    for (const verdict of ['approve', 'needs_revision', 'reject']) {
      expect(prompt).toContain(`VERDICT: ${verdict}`);
    }
  });

  // `--repo-checkout` 是**逐字固定的第二种形态**：控制不变量的要求是「同一形态下跨角色
  // 字节相同」，而不是「全实验只有一份模板」。这段守住这条更强的性质。
  it('有仓库形态：跨角色字节恒定，且不泄漏任何角色名', () => {
    const prompt = planPrompt(target, true);
    expect(planPrompt(target, true)).toBe(prompt);
    for (const role of ROLES) {
      expect(prompt).not.toContain(role);
      expect(prompt).not.toContain(ROLE_AGENT_IDS[role]);
    }
    expect(prompt).toContain('`repo/`');
  });

  it('有仓库形态要求先读代码取证，无仓库形态必须不出现这句话', () => {
    const withRepo = planPrompt(target, true);
    const withoutRepo = planPrompt(target, false);
    expect(withRepo).toContain('Read the relevant source under');
    expect(withoutRepo).not.toContain('Read the relevant source under');
    // 默认形态仍须明说工作区是空的（否则 agent 会反复去找不存在的仓库，实测烧穿预算）
    expect(withoutRepo).toContain('The repository is not checked out');
    expect(withRepo).not.toContain('The repository is not checked out');
    // 两种形态必须真的不同，否则 flag 等于没接上
    expect(withRepo).not.toBe(withoutRepo);
  });

  it('有仓库形态禁止改仓库，并禁止 shell（读工具留给 plan 取证）', () => {
    const prompt = planPrompt(target, true);
    expect(prompt).toContain('Do not modify anything under `repo/`');
    expect(prompt).toContain('Do not use shell commands');
    // 问题陈述与产出文件名在两种形态下都不变
    expect(prompt).toContain(target.problem_statement);
    expect(prompt).toContain(PLAN_FILE);
  });

  it('评审模板同样支持两种形态，且头部仍只随形态与被审 plan 变化', () => {
    const a = reviewPrompt(target, 'PLAN_ALPHA', true);
    const b = reviewPrompt(target, 'PLAN_BETA', true);
    expect(a.split('PLAN_ALPHA')[0]).toBe(b.split('PLAN_BETA')[0]);
    expect(reviewPrompt(target, 'PLAN', true)).not.toBe(reviewPrompt(target, 'PLAN', false));
    for (const role of ROLES) {
      expect(a).not.toContain(role);
    }
    expect(a).toContain(REVIEW_FILE);
  });
});

describe('verdict parsing', () => {
  it('接受规范与宽松写法', () => {
    expect(parseVerdict('VERDICT: approve\n理由')).toBe('approve');
    expect(parseVerdict('\n  **VERDICT: Needs_Revision**\n')).toBe('needs_revision');
    expect(parseVerdict('verdict：REJECT')).toBe('reject');
    expect(parseVerdict('VERDICT: reject.')).toBe('reject');
  });

  it('提不到就是 undefined，不猜', () => {
    expect(parseVerdict('')).toBeUndefined();
    expect(parseVerdict('这个计划总体不错')).toBeUndefined();
    expect(parseVerdict('VERDICT: maybe')).toBeUndefined();
  });
});

describe('token estimation', () => {
  it('围栏内按代码计价（3 字符/token），围栏外按散文（4 字符/token）', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    const fenced = ['```', 'x'.repeat(300), '```'].join('\n');
    expect(estimateTokens(fenced)).toBeGreaterThan(estimateTokens('x'.repeat(300)));
  });

  it('空文本为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('cell ids', () => {
  it('生成类与评审类两种形状', () => {
    expect(cellId({ experiment: 'plan_role', instance_id: 'i', role_key: 'correctness' })).toBe(
      'plan_role__i__correctness',
    );
    expect(
      cellId({
        experiment: 'review_role',
        instance_id: 'i',
        role_key: 'security',
        author_key: 'performance',
      }),
    ).toBe('review_role__i__security__by_performance');
  });
});

describe('cell cache', () => {
  it('写入可读、可收集、可清除', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'role-divergence-'));
    try {
      const id = 'plan_role__i__correctness';
      const evidence = { status: 'completed', cell_id: id } as unknown as CellEvidence;
      const file = cellPath(root, id);
      await writeCell(file, evidence);
      expect((await readCell(file))?.cell_id).toBe(id);
      expect(await collectCells(root)).toHaveLength(1);
      await clearCell(root, id);
      expect(await readCell(file)).toBeUndefined();
      expect(await collectCells(root)).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('control invariants', () => {
  it('检索策略与生产默认值一致（漂移即实验控制失效）', () => {
    const actual = {
      recall_top_k: DEFAULT_MEMORY_RELEVANCE_POLICY.recall_top_k,
      min_embedding_similarity: DEFAULT_MEMORY_RELEVANCE_POLICY.min_embedding_similarity,
      min_confidence: DEFAULT_MEMORY_RELEVANCE_POLICY.min_confidence,
      max_memory_items: DEFAULT_MEMORY_RELEVANCE_POLICY.max_memory_items,
      min_tag_overlap: DEFAULT_MEMORY_RELEVANCE_POLICY.min_tag_overlap,
    };
    const expected = resolveExperimentConfig({}).expected_retrieval_policy;
    expect(actual).toEqual(expected);
  });
});

describe('config guards', () => {
  it('拒绝把记忆关掉的消融档（B0/B1 会让实验静默失效）', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'role-divergence-'));
    try {
      const file = path.join(root, 'experiment.json');
      await fs.writeFile(file, JSON.stringify({ memory_ablation: 'B0' }), 'utf8');
      expect(() => resolveExperimentConfig({ ROLE_DIVERGENCE_CONFIG: file })).toThrow(/B2/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('缺省配置指向 dask-3 子集且消融档为 B2', () => {
    const config = resolveExperimentConfig({});
    expect(config.dataset_subset).toBe('v0-dask-3-prctx');
    expect(config.memory_ablation).toBe('B2');
  });
});

describe('离线回收 problem_statement', () => {
  const HEADER = 'You are fixing a real GitHub issue.\nRepository: dask/dask\n';
  const STATEMENT = '2023.4.0\n--------\n\nReleased on April 14, 2023\n\n### PR 10159: x\nbody';

  it('从提示里切出标记之后的全部内容（含尾部空白不动，字节保真）', () => {
    const prompt = `${HEADER}\n${PROBLEM_STATEMENT_MARKER}\n${STATEMENT}`;
    expect(extractProblemStatement(prompt)).toBe(STATEMENT);
  });

  it('兼容 CRLF 换行', () => {
    const prompt = `${HEADER}\r\n${PROBLEM_STATEMENT_MARKER}\r\n${STATEMENT}`;
    expect(extractProblemStatement(prompt)).toBe(STATEMENT);
  });

  it('标记出现多次时取首个——头部标记一定最靠前', () => {
    const prompt = `${HEADER}\n${PROBLEM_STATEMENT_MARKER}\n${STATEMENT}\n\nSee the problem statement: above.`;
    const extracted = extractProblemStatement(prompt);
    expect(extracted).toContain('2023.4.0');
    expect(extracted).toContain('See the problem statement: above.');
  });

  it('无标记返回 undefined（提示不是本管线产出的）', () => {
    expect(extractProblemStatement('just a plain prompt')).toBeUndefined();
  });

  it('切出的内容为空也算有效切片（不把空串当成失败）', () => {
    expect(extractProblemStatement(`${HEADER}\n${PROBLEM_STATEMENT_MARKER}`)).toBe('');
  });
});

describe('driver 工作区隔离（deny 列表）', () => {
  // 逃逸实录：driver 有完整 Bash，`ls ../..` 走到结果根（experiment-config.json /
  // cells.jsonl / 别格产出）再走到 spec/，`newide-scaffold` 作为兄弟目录可见。
  it('关掉实测出来的越界通道：Bash + 三类读工具 + 网络工具', () => {
    for (const tool of ['Bash', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']) {
      expect(DRIVER_WORKSPACE_DENY_RULES).toContain(tool);
    }
  });

  it('网络工具必须关：抓得到上游 issue / 修复，等于把金标喂进 plan', () => {
    expect(DRIVER_WORKSPACE_DENY_RULES).toContain('WebFetch');
    expect(DRIVER_WORKSPACE_DENY_RULES).toContain('WebSearch');
  });

  it('只关 Bash 不够——Read 仍可 ../ 越界，故读工具必须一起关', () => {
    expect(DRIVER_WORKSPACE_DENY_RULES).toContain('Read');
    expect(DRIVER_WORKSPACE_DENY_RULES).not.toEqual(['Bash']);
  });

  it('写保护 .claude/**，否则 agent 能反手改掉这份 deny 列表', () => {
    expect(DRIVER_WORKSPACE_DENY_RULES.some((rule) => rule.startsWith('Write(./.claude/'))).toBe(
      true,
    );
  });

  it('规则无重复（重复项会被 Claude Code 记为配置错误）', () => {
    expect(new Set(DRIVER_WORKSPACE_DENY_RULES).size).toBe(DRIVER_WORKSPACE_DENY_RULES.length);
  });

  it('settings 形状符合 Claude Code 的 permissions.deny 契约', () => {
    expect(driverWorkspaceSettings()).toEqual({
      permissions: { deny: expect.arrayContaining(['Bash']) },
    });
  });

  it('落盘到 <workspace>/.claude/settings.json，且是合法 JSON', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-ws-'));
    await writeDriverWorkspaceSettings(workspace);
    const raw = await fs.readFile(path.join(workspace, '.claude', 'settings.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual(driverWorkspaceSettings());
    await fs.rm(workspace, { recursive: true, force: true });
  });

  // 有仓库形态：读工具**必须**放开（这是本轮实验的目的），但 Bash 与网络继续封。
  it('有仓库形态放开 Read/Glob/Grep —— 否则 driver 仍读不到代码', () => {
    for (const tool of ['Read', 'Glob', 'Grep']) {
      expect(DRIVER_WORKSPACE_DENY_RULES_WITH_REPO).not.toContain(tool);
    }
  });

  it('有仓库形态仍封 Bash（当年烧穿预算的元凶）与网络（会抓来金标）', () => {
    for (const tool of ['Bash', 'WebFetch', 'WebSearch']) {
      expect(DRIVER_WORKSPACE_DENY_RULES_WITH_REPO).toContain(tool);
    }
  });

  it('有仓库形态写保护 .claude/** 与 repo/**', () => {
    for (const rule of ['Write(./.claude/**)', 'Edit(./.claude/**)', 'Write(./repo/**)', 'Edit(./repo/**)']) {
      expect(DRIVER_WORKSPACE_DENY_RULES_WITH_REPO).toContain(rule);
    }
  });

  it('有仓库形态规则无重复', () => {
    expect(new Set(DRIVER_WORKSPACE_DENY_RULES_WITH_REPO).size).toBe(
      DRIVER_WORKSPACE_DENY_RULES_WITH_REPO.length,
    );
  });

  it('driverWorkspaceSettings 按形态选择 deny 列表', async () => {
    expect(driverWorkspaceSettings({ repoCheckout: false }).permissions.deny).toEqual([
      ...DRIVER_WORKSPACE_DENY_RULES,
    ]);
    expect(driverWorkspaceSettings({ repoCheckout: true }).permissions.deny).toEqual([
      ...DRIVER_WORKSPACE_DENY_RULES_WITH_REPO,
    ]);
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-ws-repo-'));
    await writeDriverWorkspaceSettings(workspace, { repoCheckout: true });
    const raw = await fs.readFile(path.join(workspace, '.claude', 'settings.json'), 'utf8');
    expect(JSON.parse(raw).permissions.deny).not.toContain('Read');
    await fs.rm(workspace, { recursive: true, force: true });
  });
});

describe('注入证据：跑后从 context pack 读回', () => {
  const pack = (skills: unknown[], runId = 'run_x') => ({
    run_id: runId,
    role_id: 'role_correctness',
    driver_invocation_context: { skills, experiences: [] },
  });

  it('非对象 / 缺注入上下文 → undefined，表示「取不到证据」', () => {
    expect(extractInjection(undefined)).toBeUndefined();
    expect(extractInjection('nope')).toBeUndefined();
    expect(extractInjection({ run_id: 'r' })).toBeUndefined();
  });

  it('有注入上下文但零技能 → 0 条。这与 undefined 含义不同，不能混为一谈', () => {
    const result = extractInjection(pack([]));
    expect(result).toBeDefined();
    expect(result?.skills).toEqual([]);
  });

  it('读出 run_id / role_id 与技能正文', () => {
    const result = extractInjection(
      pack([{ id: 'skill_a', description: 'd', content: 'body' }], 'run_42'),
    );
    expect(result?.run_id).toBe('run_42');
    expect(result?.role_id).toBe('role_correctness');
    expect(result?.skills).toEqual([{ id: 'skill_a', description: 'd', content: 'body' }]);
  });

  it('容忍畸形条目：非对象与全空条目被跳过，不因一条坏数据丢掉整格证据', () => {
    const result = extractInjection(pack([null, 'junk', {}, { id: 'ok', content: 'x' }]));
    expect(result?.skills.map((skill) => skill.id)).toEqual(['ok']);
  });

  it('缺 content 记为空串（不抛，也不算有效正文）', () => {
    const result = extractInjection(pack([{ id: 'a', description: 'd' }]));
    expect(result?.skills[0]?.content).toBe('');
  });

  it('findContextPackForRun 返回原始 pack；无匹配或目录不存在时 undefined', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-packs-'));
    await fs.writeFile(
      path.join(dir, 'context_pack_aaa.json'),
      JSON.stringify(pack([{ id: 'wanted', content: 'c' }], 'run_wanted')),
    );
    await fs.writeFile(
      path.join(dir, 'context_pack_bbb.json'),
      JSON.stringify(pack([{ id: 'other', content: 'c' }], 'run_other')),
    );
    const found = await findContextPackForRun(dir, 'run_wanted');
    expect(extractInjection(found)?.skills[0]?.id).toBe('wanted');
    expect(await findContextPackForRun(dir, 'run_missing')).toBeUndefined();
    expect(await findContextPackForRun(path.join(dir, 'nope'), 'run_wanted')).toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('pack 在但缺 driver_invocation_context → undefined（「agent 没调 driver」，非「没注入」）', () => {
    expect(extractInjection({ run_id: 'r', driver_context: { skills: [] } })).toBeUndefined();
  });
});

describe('Agent 工具轨迹：区分「没去查」与「查了没命中」', () => {
  const line = (event: unknown) => JSON.stringify(event);

  it('空输入 / 全是畸形行 → undefined，不编造一份空摘要', () => {
    expect(summarizeAgentToolCalls('')).toBeUndefined();
    expect(summarizeAgentToolCalls('not json\n{broken\n')).toBeUndefined();
  });

  it('query_memory 为 0 = Agent 压根没查（注入为空的第一种成因）', () => {
    const raw = [line({ name: 'invoke_driver', summary: 'ok' })].join('\n');
    const summary = summarizeAgentToolCalls(raw);
    expect(summary?.query_memory).toBe(0);
    expect(summary?.invoke_driver).toBe(1);
    expect(summary?.total).toBe(1);
  });

  it('查了但全返回 0 条 = 第二种成因，与前者区分开', () => {
    const raw = [
      line({ name: 'query_memory', result_counts: { skills: 0, experiences: 0, content_chars: 0 } }),
      line({ name: 'query_memory', result_counts: { skills: 0, experiences: 0, content_chars: 0 } }),
    ].join('\n');
    const summary = summarizeAgentToolCalls(raw);
    expect(summary?.query_memory).toBe(2);
    expect(summary?.query_memory_skill_counts).toEqual([0, 0]);
  });

  it('按发生顺序收集每次检索命中的条数', () => {
    const raw = [
      line({ name: 'query_memory', result_counts: { skills: 3, experiences: 0, content_chars: 10 } }),
      line({ name: 'query_memory', result_counts: { skills: 1, experiences: 2, content_chars: 4 } }),
    ].join('\n');
    expect(summarizeAgentToolCalls(raw)?.query_memory_skill_counts).toEqual([3, 1]);
  });

  it('缺 result_counts 记 -1（未知），不冒充 0', () => {
    const raw = line({ name: 'query_memory', summary: 'skills=? ' });
    expect(summarizeAgentToolCalls(raw)?.query_memory_skill_counts).toEqual([-1]);
  });

  it('跳过畸形行但保留其余，不因一行坏数据丢掉整份证据', () => {
    const raw = [
      line({ name: 'query_memory', result_counts: { skills: 2, experiences: 0, content_chars: 9 } }),
      '{oops',
      JSON.stringify({ no_name: true }),
      line({ name: 'invoke_driver' }),
    ].join('\n');
    const summary = summarizeAgentToolCalls(raw);
    expect(summary?.query_memory).toBe(1);
    expect(summary?.invoke_driver).toBe(1);
    expect(summary?.total).toBe(2);
  });
});

/**
 * 回归守卫：`role_neutral` 的零注入是控制条件，不是操纵变量缺席。
 *
 * 曾经的不分角色门禁把这一格判失败，于是 `reviewedPlanText()` 在第一个 plan 格
 * 就抛 `Upstream plan cell not completed`，`review_neutral` / `review_role` 全被连坐，
 * 整轮 exit 1 —— 而那份白板 plan.md 其实已经写出来了。
 */
describe('注入门禁：白板对照的零注入必须放行', () => {
  it('role_neutral 零注入 → control，不判失败', () => {
    const gate = evaluateInjectionGate({ roleKey: 'neutral', skillCount: 0, allowEmpty: false });
    expect(gate.kind).toBe('control');
  });

  it('role_neutral 不需要 --allow-empty-injection 也放行', () => {
    expect(evaluateInjectionGate({ roleKey: 'neutral', skillCount: 0, allowEmpty: false }).kind).toBe(
      'control',
    );
    expect(evaluateInjectionGate({ roleKey: 'neutral', skillCount: 0, allowEmpty: true }).kind).toBe(
      'control',
    );
  });

  it.each(ROLES)('%s 角色格零注入 → 仍然判失败', (role) => {
    const gate = evaluateInjectionGate({
      roleKey: role,
      skillCount: 0,
      allowEmpty: false,
      queryHits: [0, 0],
      roleId: `role_${role}`,
    });
    expect(gate.kind).toBe('zero_forbidden');
    // 诊断信息要能区分「没去查」（[]）与「查了没命中」（[0,0]）
    expect(gate.kind === 'zero_forbidden' ? gate.reason : '').toContain('query_memory hits=[0,0]');
  });

  it('角色格有注入 → ok', () => {
    expect(
      evaluateInjectionGate({ roleKey: 'security', skillCount: 3, allowEmpty: false }).kind,
    ).toBe('ok');
  });

  it('--allow-empty-injection 才放行角色格的零注入', () => {
    expect(
      evaluateInjectionGate({ roleKey: 'security', skillCount: 0, allowEmpty: true }).kind,
    ).toBe('ok');
  });

  it('注入为 0 的对照格不会被误当成「有注入」', () => {
    // 守住反向错误：别把 control 写成 ok，否则后续统计会把对照格算进有注入组
    expect(evaluateInjectionGate({ roleKey: 'neutral', skillCount: 0, allowEmpty: false }).kind).not.toBe(
      'ok',
    );
  });
});
