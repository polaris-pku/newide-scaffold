/**
 * evidence — 注入证据：把「这一格实际被注入了哪些技能」落成机器凭据
 *
 * 实验的操纵变量是「该角色 `role_id` 作用域的记忆有没有进到这一格」，所以证据必须
 * 反映**真实注入**。而真实注入由**顶层 agent 自己决定**——它按需调 `query_memory`，
 * 结果经 facade 合并后才交给 driver。因此不存在「跑前按任务原文预计算注入」这回事：
 * 那条路既已被 `NEWIDE_B_DISABLE_PRE_RETRIEVAL` 关掉，问题陈述又必撞嵌入的 8192
 * token 窗口。
 *
 * 本模块因此**跑后**取数：cell → `run_id` → 该角色后端的 context pack →
 * `driver_invocation_context.skills`。空注入意味着这一格没有操纵变量，应判无效。
 *
 * 教训来源：曾有一版模板措辞让顶层 agent 认定"不必用别的东西"，于是它根本没调
 * `query_memory`——那一格注入为 0 却照常产出 plan。跑前的预计算探针看不见这种事，
 * 跑后读取才看得见。
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_MEMORY_RELEVANCE_POLICY, scanCorpus, slugToSkillId } from '../../src/memory';
import type { MemoryRelevancePolicy } from '../../src/memory';
import { contextPacksDir, readJson } from './cache';
import { assertRetrievalPolicy, type ExperimentConfig } from './config';
import { estimateTokens } from './tokens';
import type {
  AgentToolSummary,
  DriverToolSummary,
  ExpectedRetrievalPolicy,
  InjectedSkillEntry,
  InjectionEvidence,
  PartyKey,
} from './types';

/** facade 交给 driver 的技能条目（`toDriverMemoryItems` 口径） */
export interface InjectedSkill {
  id: string;
  description: string;
  content: string;
}

export interface ExtractedInjection {
  run_id: string | undefined;
  role_id: string | undefined;
  skills: InjectedSkill[];
  experience_count: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSkill(value: unknown): InjectedSkill | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === 'string' ? value.id : '';
  const content = typeof value.content === 'string' ? value.content : '';
  if (id === '' && content === '') return undefined;
  return {
    id,
    description: typeof value.description === 'string' ? value.description : '',
    content,
  };
}

/**
 * 从 context pack 里取出真实注入的技能。
 *
 * 返回 `undefined` 表示这**不是**一份 context pack（或没有注入上下文），调用方不能
 * 把它当成"注入了 0 条"——两者含义不同：前者是取不到证据，后者是证据显示没注入。
 */
export function extractInjection(pack: unknown): ExtractedInjection | undefined {
  if (!isRecord(pack)) return undefined;
  if (!isRecord(pack.driver_invocation_context)) return undefined;
  const context = pack.driver_invocation_context;
  const rawSkills = Array.isArray(context.skills) ? context.skills : [];
  const skills = rawSkills.map(toSkill).filter((skill): skill is InjectedSkill => Boolean(skill));
  return {
    run_id: typeof pack.run_id === 'string' ? pack.run_id : undefined,
    role_id: typeof pack.role_id === 'string' ? pack.role_id : undefined,
    skills,
    experience_count: Array.isArray(context.experiences) ? context.experiences.length : 0,
  };
}

/**
 * 在某个角色的 context pack 目录里按 `run_id` 找那一份，返回**原始 pack**。
 *
 * 刻意不在这里做提取：`undefined`（没有这一格的 pack）与"pack 存在但没有
 * `driver_invocation_context`"是两种不同的诊断，调用方需要分开报。
 */
export async function findContextPackForRun(
  directory: string,
  runId: string,
): Promise<unknown | undefined> {
  if (!existsSync(directory)) return undefined;
  for (const name of (await fs.readdir(directory)).sort()) {
    if (!name.endsWith('.json')) continue;
    const pack = await readJson<unknown>(path.join(directory, name));
    if (isRecord(pack) && pack.run_id === runId) return pack;
  }
  return undefined;
}

/** 从生产默认策略取出实验关心的五个字段并断言未漂移 */
export function toExpectedPolicy(policy: MemoryRelevancePolicy): ExpectedRetrievalPolicy {
  return {
    recall_top_k: policy.recall_top_k,
    min_embedding_similarity: policy.min_embedding_similarity,
    min_confidence: policy.min_confidence,
    max_memory_items: policy.max_memory_items,
    min_tag_overlap: policy.min_tag_overlap,
  };
}

/** id → slug 反查表（SkillRecord.id = uuid v5(slug)） */
export async function buildSlugIndex(config: ExperimentConfig): Promise<Map<string, string>> {
  const files = await scanCorpus(config.skills_dir);
  return new Map(files.map((file) => [slugToSkillId(file.slug), file.slug]));
}

export function toEntry(skill: InjectedSkill, slugById: Map<string, string>): InjectedSkillEntry {
  return {
    id: skill.id,
    slug: slugById.get(skill.id) ?? null,
    description: skill.description,
    content_chars: skill.content.length,
    est_tokens: estimateTokens(skill.content),
  };
}

/**
 * 汇总顶层 Agent 的工具调用轨迹（`agent-tools.jsonl`，每行一个 JSON 事件）。
 *
 * 用途只有一个：**注入为空时区分成因**。`query_memory === 0` 是「Agent 压根没查」；
 * 有 N 次调用而 `query_memory_skill_counts` 全 0 则是「查了但没命中」。没有这条摘要，
 * 两种成因在证据里长得一模一样，只能靠猜。
 *
 * 畸形行跳过——不因一行坏数据丢掉整份证据。整份都没有有效行时返回 undefined。
 */
export function summarizeAgentToolCalls(raw: string): AgentToolSummary | undefined {
  const summary: AgentToolSummary = {
    total: 0,
    query_memory: 0,
    invoke_driver: 0,
    query_memory_skill_counts: [],
  };

  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event) || typeof event.name !== 'string') continue;
    summary.total++;
    if (event.name === 'query_memory') {
      summary.query_memory++;
      const counts = isRecord(event.result_counts) ? event.result_counts : undefined;
      summary.query_memory_skill_counts.push(
        counts && typeof counts.skills === 'number' ? counts.skills : -1,
      );
    } else if (event.name === 'invoke_driver') {
      summary.invoke_driver++;
    }
  }

  return summary.total > 0 ? summary : undefined;
}

/** 读代码类工具：有仓库形态下放开的就是这三个 */
const REPO_READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);

/**
 * 汇总 driver 自己的工具调用（`trajectory.jsonl`，`driver-stream-audit.v1` 包一层 `event`）。
 *
 * 为什么必须有这条：`--repo-checkout` 只是**把仓库放到 driver 手边**，它读没读是另一回事。
 * `repo_reads === 0` 就等于「仓库挂着但 plan 仍是凭题目文本写的」——没有这个读数，
 * 两种情形在证据里长得一模一样。
 *
 * 失败次数记的是**真实终态**（`tool_call_update.status === 'failed'`），不是"工具名在黑名单里
 * 就记失败"——deny 列表若哪天没生效，那样会算出一个假的安全读数。
 */
export function summarizeDriverToolCalls(raw: string): DriverToolSummary | undefined {
  const byTool: Record<string, number> = {};
  /** toolCallId → 工具名，用于把 update 的终态归回调用 */
  const callTool = new Map<string, string>();
  const failedIds = new Set<string>();
  const okIds = new Set<string>();
  let total = 0;
  let writes = 0;
  let streamEvents = 0;

  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const event = isRecord(parsed.event) ? parsed.event : undefined;
    if (!event || typeof event.event_type !== 'string') continue;

    const type = event.event_type;
    const payload = isRecord(event.payload) ? event.payload : {};
    const update = isRecord(payload.update) ? payload.update : {};
    const meta = isRecord(update._meta) ? update._meta : {};
    const claude = isRecord(meta.claudeCode) ? meta.claudeCode : {};
    const tool = typeof claude.toolName === 'string' ? claude.toolName : undefined;
    const callId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;

    if (type === 'tool_call') {
      if (!tool) continue;
      total++;
      byTool[tool] = (byTool[tool] ?? 0) + 1;
      if (tool === 'Write') writes++;
      if (callId) callTool.set(callId, tool);
      continue;
    }

    if (type === 'tool_call_update') {
      const status = typeof update.status === 'string' ? update.status : undefined;
      if (!callId || !status) continue;
      if (status === 'failed') failedIds.add(callId);
      else if (status === 'completed') okIds.add(callId);
      continue;
    }

    if (type === 'agent_thought_chunk' || type === 'agent_message_chunk') streamEvents++;
  }

  const repoReadIds = [...callTool.entries()].filter(([, tool]) => REPO_READ_TOOLS.has(tool));
  const summary: DriverToolSummary = {
    total,
    by_tool: byTool,
    repo_reads: repoReadIds.length,
    repo_reads_ok: repoReadIds.filter(([id]) => okIds.has(id)).length,
    failed: failedIds.size,
    writes,
    stream_events: streamEvents,
  };

  return summary.total > 0 || summary.stream_events > 0 ? summary : undefined;
}

export interface CellInjectionRequest {
  config: ExperimentConfig;
  cellId: string;
  roleKey: PartyKey;
  roleId: string;
  instanceId: string;
  runId: string;
}

/**
 * 取某一格注入证据的结果。三种情形分开报，因为诊断意义不同：
 * - `ok`：拿到了注入集合（含 `skill_count === 0` 的"确实没注入"）
 * - `no_invocation`：pack 在，但没有 `driver_invocation_context`——agent 没调 `invoke_driver`
 * - `no_pack`：该 run 没有 pack——后端没写出，或 run 根本没走到建 pack
 */
export type CellInjectionResult =
  | { kind: 'ok'; evidence: InjectionEvidence }
  | { kind: 'no_invocation' }
  | { kind: 'no_pack' };

export async function collectCellInjection(
  request: CellInjectionRequest,
): Promise<CellInjectionResult> {
  const policy = toExpectedPolicy(DEFAULT_MEMORY_RELEVANCE_POLICY);
  assertRetrievalPolicy(policy, request.config.expected_retrieval_policy);

  const pack = await findContextPackForRun(
    contextPacksDir(request.config.result_root, request.roleKey),
    request.runId,
  );
  if (pack === undefined) return { kind: 'no_pack' };

  const injection = extractInjection(pack);
  if (!injection) return { kind: 'no_invocation' };

  const slugById = await buildSlugIndex(request.config);
  const skills = injection.skills.map((skill) => toEntry(skill, slugById));
  return {
    kind: 'ok',
    evidence: {
      cell_id: request.cellId,
      role_key: request.roleKey,
      role_id: request.roleId,
      instance_id: request.instanceId,
      run_id: request.runId,
      policy,
      skill_count: skills.length,
      experience_count: injection.experience_count,
      total_content_chars: skills.reduce((sum, skill) => sum + skill.content_chars, 0),
      total_est_tokens: skills.reduce((sum, skill) => sum + skill.est_tokens, 0),
      skills,
    },
  };
}
