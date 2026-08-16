/**
 * 三重门控退休检测（week3 RFC §8.2 的实现）
 *
 * 这是 AgentRetire 的「触发机制」：只负责判断「该不该退休」，产出
 * recommended_action 与逐层证据，由调用方决定是否真正调用 retireAgent。
 * 与 services/retirement.ts（执行退休资产处置）职责分离。
 *
 * ## 三重门控（由廉到贵）
 *
 * | 层 | 评估器                    | 成本    | 触发条件                          | 冷却  |
 * |----|---------------------------|---------|-----------------------------------|-------|
 * | 1  | StatisticalRetirementEvaluator | O(1) | 每次扫描都跑                    | -     |
 * | 2  | PersonaDriftEvaluator     | O(1)    | 第一层结果非 keep                 | 7 天  |
 * | 3  | LlmRetirementEvaluator    | LLM 调用 | 第二层确认 retire（含 LLM 时）    | 30 天 |
 *
 * ## 组合语义
 *
 * - 第二层只允许「升级」严重度（keep→warn→retire），不允许降级——统计层信号
 *   （长期未中标 / 低成功率）本身已足够值得关注，漂移层只是加码确认。
 * - 第三层是「全面评估」，其 recommended_action 为最终结论（可降级），因为它是
 *   信息最全、成本最高的一层；LLM 不可用或解析失败时回退到统计层结论，不阻断扫描。
 * - 冷却期状态持久化到 AgentMetrics（last_persona_drift_eval_at / last_llm_eval_at /
 *   last_retirement_scan_at / persona_drift），跨进程生效，防止频繁触发昂贵层。
 */
import { createId } from '../../core';
import { RETIREMENT_EVALUATOR_SYSTEM_PROMPT } from '../prompts/retirement-evaluation';
import type { LlmClient } from '../ports/llm-client';
import type { MemoryRepository } from '../ports/memory-repository';
import type {
  AgentMetrics,
  ExperienceRecord,
  PersonaDef,
  RetiredReason,
  SkillRecord,
} from '../schemas';
import { MARKET_POOL_ROLE_ID } from '../schemas';
import {
  evaluateRetirementSignals,
  type RetirementSignals,
} from './metrics';

export type RetirementAction = 'retire' | 'warn' | 'keep';
export type RetirementLayer = 'statistical' | 'persona_drift' | 'llm';

/** 一次退休评估的完整输入（三层共享） */
export interface RetirementEvaluationInput {
  role_id: string;
  metrics: AgentMetrics;
  persona: PersonaDef;
  /** 第一层统计信号（第三层提示词与降级路径也依赖它） */
  signals: RetirementSignals;
  skills: SkillRecord[];
  experiences: ExperienceRecord[];
  /** 市场池技能（用于第三层可替代性评估） */
  market_skills: SkillRecord[];
}

/** 单层评估结果 */
export interface RetirementEvaluation {
  action: RetirementAction;
  /** 该层对其 action 的置信度（0~1） */
  confidence: number;
  reasons: string[];
  /** 第二层写回指标的 Persona 漂移分（0~1） */
  persona_drift?: number;
  /** 第三层评估的技能市场可替代率（0~1） */
  market_replaceability?: number;
  /** 第三层评估的经验可恢复率（0~1） */
  experience_recoverability?: number;
}

/** 退休评估器端口（三层各自实现） */
export interface RetirementEvaluator {
  readonly layer: RetirementLayer;
  evaluate(input: RetirementEvaluationInput): Promise<RetirementEvaluation>;
}

/** 已执行层的记录（含冷却期跳过标记） */
export interface RetirementLayerOutcome extends RetirementEvaluation {
  layer: RetirementLayer;
  /** 该层因冷却期被跳过（未实际评估，沿用上一层结论） */
  skipped?: boolean;
}

/** 一次完整三重门控扫描的结果 */
export interface RetirementScanResult {
  scan_id: string;
  role_id: string;
  scanned_at: string;
  action: RetirementAction;
  confidence: number;
  reasons: string[];
  /** 逐层执行记录（含跳过的层） */
  layers: RetirementLayerOutcome[];
  /** action=retire 时建议的退休原因（供 retireAgent 复用） */
  suggested_reason?: RetiredReason;
  /** 扫描失败时的错误信息（scanAll 容错路径使用） */
  error?: string;
}

export interface RetirementDetectorOptions {
  /** 第一层评估器（默认 StatisticalRetirementEvaluator） */
  statistical?: RetirementEvaluator;
  /** 第二层评估器（默认 PersonaDriftEvaluator） */
  personaDrift?: RetirementEvaluator;
  /** 第三层评估器；不注入则最多跑两层 */
  llm?: RetirementEvaluator;
  /** 当前时间（ms），测试注入固定时间 */
  now?: () => number;
  /** 第二层冷却（默认 7 天） */
  layer2CooldownMs?: number;
  /** 第三层冷却（默认 30 天） */
  layer3CooldownMs?: number;
  /** 是否将扫描状态（时间戳 / 漂移分）持久化回 metrics（默认 true） */
  persistState?: boolean;
}

/** RFC §8.2 的层间冷却时间 */
export const RETIREMENT_COOLDOWNS = {
  /** 第一层触发后，Persona 漂移分析的冷却期 */
  layer2_ms: 7 * 24 * 60 * 60 * 1000,
  /** 第二层触发后，LLM 评估的冷却期 */
  layer3_ms: 30 * 24 * 60 * 60 * 1000,
} as const;

const RETIREMENT_SEVERITY: Record<RetirementAction, number> = {
  keep: 0,
  warn: 1,
  retire: 2,
};

// ═══════════════════════════════════════════
//  第一层：轻量统计评估
// ═══════════════════════════════════════════

export class StatisticalRetirementEvaluator implements RetirementEvaluator {
  readonly layer = 'statistical' as const;

  constructor(private readonly now: () => number = Date.now) {}

  async evaluate(input: RetirementEvaluationInput): Promise<RetirementEvaluation> {
    const signals = evaluateRetirementSignals(input.metrics, this.now());
    return {
      action: signals.recommended_action,
      confidence: statisticalConfidence(signals),
      reasons: statisticalReasons(signals),
    };
  }
}

function statisticalConfidence(signals: RetirementSignals): number {
  if (signals.recommended_action === 'retire') return 0.7;
  if (signals.recommended_action === 'warn') return 0.5;
  return 0.9;
}

function statisticalReasons(signals: RetirementSignals): string[] {
  const reasons: string[] = [];
  if (signals.critical_staleness) {
    reasons.push(`No task won for ${Math.round(signals.days_since_last_won)} days (critical staleness).`);
  } else if (signals.stale_bids) {
    reasons.push(`No task won for ${Math.round(signals.days_since_last_won)} days.`);
  }
  if (signals.low_success_rate) {
    reasons.push('Recent success rate is below threshold.');
  }
  if (signals.inactive) {
    reasons.push('Agent is inactive (no recent task participation).');
  }
  if (reasons.length === 0) {
    reasons.push('Statistical signals are healthy.');
  }
  return reasons;
}

// ═══════════════════════════════════════════
//  第二层：Persona 漂移评估
// ═══════════════════════════════════════════

export const PERSONA_DRIFT_THRESHOLDS = {
  /** total_tasks 低于该值视为探索期，不做漂移判定（RFC：<20 不触发） */
  exploration_task_floor: 20,
  /** 漂移分 ≥ 该值 → 判定为严重漂移（进入第三层） */
  drift_retire_threshold: 0.6,
  /** 漂移分 ≥ 该值 → 判定为轻度漂移 */
  drift_warn_threshold: 0.35,
  /** 成功率低于该值视为「交付不足」 */
  delivery_success_floor: 0.3,
  /** Persona 距今超过该天数视为陈旧（漂移信号的前提） */
  persona_stale_days: 30,
} as const;

/**
 * 计算 Persona 漂移分（0~1）。
 *
 * 优先使用已持久化的 metrics.persona_drift（Persona 演化填充的来源）；
 * 缺失时用启发式：探索期不判漂移；当 Persona 陈旧且近期交付不足时，
 * 漂移分随交付缺口扩大而上升。
 */
export function computePersonaDrift(
  metrics: AgentMetrics,
  persona: PersonaDef,
  now: number = Date.now(),
): number {
  if (metrics.persona_drift !== undefined) return metrics.persona_drift;
  if (metrics.total_tasks < PERSONA_DRIFT_THRESHOLDS.exploration_task_floor) return 0;

  const completed = metrics.tasks_completed;
  const successRate = completed > 0 ? metrics.tasks_succeeded / completed : 0;
  const dayMs = 24 * 60 * 60 * 1000;
  const stableSince = metrics.persona_stable_since ?? persona.generated_at;
  const personaAgeDays = stableSince
    ? (now - Date.parse(stableSince)) / dayMs
    : Number.POSITIVE_INFINITY;
  const stalePersona = personaAgeDays > PERSONA_DRIFT_THRESHOLDS.persona_stale_days;
  const lowDelivery = successRate < PERSONA_DRIFT_THRESHOLDS.delivery_success_floor;
  if (!stalePersona || !lowDelivery) return 0;

  return Math.min(
    1,
    0.5 + (PERSONA_DRIFT_THRESHOLDS.delivery_success_floor - successRate),
  );
}

export class PersonaDriftEvaluator implements RetirementEvaluator {
  readonly layer = 'persona_drift' as const;

  constructor(private readonly now: () => number = Date.now) {}

  async evaluate(input: RetirementEvaluationInput): Promise<RetirementEvaluation> {
    const drift = computePersonaDrift(input.metrics, input.persona, this.now());
    const action: RetirementAction =
      drift >= PERSONA_DRIFT_THRESHOLDS.drift_retire_threshold
        ? 'retire'
        : drift >= PERSONA_DRIFT_THRESHOLDS.drift_warn_threshold
          ? 'warn'
          : 'keep';
    return {
      action,
      confidence: action === 'keep' ? 0.9 : action === 'warn' ? 0.5 : drift,
      reasons: buildDriftReasons(drift, input.metrics),
      persona_drift: drift,
    };
  }
}

function buildDriftReasons(drift: number, metrics: AgentMetrics): string[] {
  if (drift === 0) return ['No persona drift detected.'];
  if (metrics.total_tasks < PERSONA_DRIFT_THRESHOLDS.exploration_task_floor) {
    return ['Persona drift assessment suppressed during exploration period.'];
  }
  return [
    `Persona drift score ${drift.toFixed(2)} (stale persona with declining delivery).`,
  ];
}

// ═══════════════════════════════════════════
//  第三层：LLM 全面评估
// ═══════════════════════════════════════════

export class LlmRetirementEvaluator implements RetirementEvaluator {
  readonly layer = 'llm' as const;

  constructor(private readonly llm: LlmClient) {}

  async evaluate(input: RetirementEvaluationInput): Promise<RetirementEvaluation> {
    try {
      const raw = await this.llm.complete({
        messages: [
          { role: 'system', content: RETIREMENT_EVALUATOR_SYSTEM_PROMPT },
          { role: 'user', content: buildRetirementEvaluationUserPrompt(input) },
        ],
        responseFormat: { type: 'json_object' },
      });
      return parseRetirementEvaluation(raw);
    } catch (error) {
      // LLM 不可用或解析失败 → 回退到统计层结论，不阻断扫描
      return {
        action: input.signals.recommended_action,
        confidence: 0.4,
        reasons: [
          `LLM retirement evaluation unavailable; fell back to statistical signal. ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      };
    }
  }
}

export function parseRetirementEvaluation(raw: string): RetirementEvaluation {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM retirement response is not a JSON object');
  }
  const action = parsed.recommended_action ?? parsed.action;
  if (action !== 'retire' && action !== 'warn' && action !== 'keep') {
    throw new Error(`LLM retirement response has invalid recommended_action: ${String(action)}`);
  }
  const asNumber = (value: unknown): number | undefined =>
    typeof value === 'number' ? clamp01(value) : undefined;
  const reasons = Array.isArray(parsed.reasoning)
    ? parsed.reasoning.map(String)
    : typeof parsed.reasoning === 'string'
      ? [parsed.reasoning]
      : [];

  return {
    action,
    confidence: asNumber(parsed.confidence) ?? 0.5,
    reasons: reasons.length > 0 ? reasons : ['LLM evaluation completed.'],
    ...(asNumber(parsed.market_replaceability) !== undefined
      ? { market_replaceability: asNumber(parsed.market_replaceability)! }
      : {}),
    ...(asNumber(parsed.experience_recoverability) !== undefined
      ? { experience_recoverability: asNumber(parsed.experience_recoverability)! }
      : {}),
  };
}

export function buildRetirementEvaluationUserPrompt(
  input: RetirementEvaluationInput,
): string {
  const sections: string[] = [];
  sections.push(`## Agent: ${input.role_id}`);
  sections.push(`## Persona summary\n${input.persona.summary}`);
  sections.push(`## Recent performance\n${input.persona.recent_performance}`);
  sections.push(`## Metrics\n${renderMetrics(input.metrics)}`);
  sections.push(`## Statistical signals\n${renderSignals(input.signals)}`);
  sections.push(
    `## Skills (${input.skills.length})\n${
      input.skills.map((skill) => `- ${skill.description}`).join('\n') || '(none)'
    }`,
  );
  sections.push(
    `## Experiences (${input.experiences.length})\n${
      input.experiences
        .map((experience) => `- [${experience.confidence.toFixed(2)}] ${experience.description}`)
        .join('\n') || '(none)'
    }`,
  );
  sections.push(
    `## Market skills (${input.market_skills.length})\n${
      input.market_skills.map((skill) => `- ${skill.description}`).join('\n') || '(none)'
    }`,
  );
  return sections.join('\n\n');
}

function renderMetrics(metrics: AgentMetrics): string {
  return [
    `total_tasks: ${metrics.total_tasks}`,
    `tasks_won: ${metrics.tasks_won}`,
    `tasks_completed: ${metrics.tasks_completed}`,
    `tasks_succeeded: ${metrics.tasks_succeeded}`,
    `tasks_failed: ${metrics.tasks_failed}`,
    `success_rate: ${metrics.tasks_completed > 0 ? (metrics.tasks_succeeded / metrics.tasks_completed).toFixed(2) : 'n/a'}`,
    `skill_count: ${metrics.skill_count}`,
    `experience_count: ${metrics.experience_count}`,
    `persona_version: ${metrics.persona_version}`,
    ...(metrics.persona_drift !== undefined
      ? [`persona_drift: ${metrics.persona_drift.toFixed(2)}`]
      : []),
    ...(metrics.last_won_at ? [`last_won_at: ${metrics.last_won_at}`] : []),
  ].join('\n');
}

function renderSignals(signals: RetirementSignals): string {
  return [
    `days_since_last_won: ${
      signals.days_since_last_won === Number.POSITIVE_INFINITY
        ? 'never'
        : Math.round(signals.days_since_last_won)
    }`,
    `stale_bids: ${signals.stale_bids}`,
    `critical_staleness: ${signals.critical_staleness}`,
    `low_success_rate: ${signals.low_success_rate}`,
    `inactive: ${signals.inactive}`,
    `recommended_action: ${signals.recommended_action}`,
  ].join('\n');
}

// ═══════════════════════════════════════════
//  RetirementDetector：三重门控编排
// ═══════════════════════════════════════════

export class RetirementDetector {
  private readonly statistical: RetirementEvaluator;
  private readonly personaDrift: RetirementEvaluator;
  private readonly llm: RetirementEvaluator | undefined;
  private readonly now: () => number;
  private readonly layer2CooldownMs: number;
  private readonly layer3CooldownMs: number;
  private readonly persistState: boolean;

  constructor(
    private readonly repository: MemoryRepository,
    options: RetirementDetectorOptions = {},
  ) {
    this.statistical = options.statistical ?? new StatisticalRetirementEvaluator(options.now);
    this.personaDrift = options.personaDrift ?? new PersonaDriftEvaluator(options.now);
    this.llm = options.llm;
    this.now = options.now ?? Date.now;
    this.layer2CooldownMs = options.layer2CooldownMs ?? RETIREMENT_COOLDOWNS.layer2_ms;
    this.layer3CooldownMs = options.layer3CooldownMs ?? RETIREMENT_COOLDOWNS.layer3_ms;
    this.persistState = options.persistState ?? true;
  }

  /** 扫描单个 Agent，返回三重门控检测结果（不自动退休）。 */
  async scan(roleId: string): Promise<RetirementScanResult> {
    const handle = await this.repository.getAgent(roleId).catch(() => null);
    if (!handle) {
      throw new Error(`Agent not found: ${roleId}`);
    }
    if (handle.status === 'retired' || handle.status === 'draining') {
      throw new Error(`Agent is not scannable (status=${handle.status}): ${roleId}`);
    }
    if (roleId === MARKET_POOL_ROLE_ID) {
      throw new Error(`Market pool agent is not scannable: ${roleId}`);
    }

    const [metrics, persona, skills, experiences] = await Promise.all([
      this.repository.getMetrics(roleId),
      this.repository.getPersona(roleId),
      this.repository.listSkills(roleId),
      this.repository.listExperiences(roleId),
    ]);
    const marketSkills = await this.listMarketSkills();
    const signals = evaluateRetirementSignals(metrics, this.now());
    const input: RetirementEvaluationInput = {
      role_id: roleId,
      metrics,
      persona,
      signals,
      skills,
      experiences,
      market_skills: marketSkills,
    };

    const outcomes: RetirementLayerOutcome[] = [];
    const layer1 = await this.statistical.evaluate(input);
    outcomes.push({ layer: 'statistical', ...layer1 });
    let verdict: RetirementEvaluation = layer1;
    let layer2Ran = false;
    let layer3Ran = false;

    // 第二层门控：统计层非 keep → Persona 漂移分析（冷却 7 天）
    if (verdict.action !== 'keep') {
      const cooldownElapsed = cooldownElapsedFor(
        metrics.last_persona_drift_eval_at,
        this.layer2CooldownMs,
        this.now,
      );
      if (cooldownElapsed) {
        const layer2 = await this.personaDrift.evaluate(input);
        outcomes.push({ layer: 'persona_drift', ...layer2 });
        verdict = combineEscalate(verdict, layer2);
        layer2Ran = true;
      } else {
        outcomes.push({
          layer: 'persona_drift',
          action: verdict.action,
          confidence: verdict.confidence,
          reasons: ['Layer 2 skipped: persona drift cooldown active.'],
          skipped: true,
        });
      }
    }

    // 第三层门控：第二层确认 retire → LLM 全面评估（冷却 30 天，最终仲裁）
    if (verdict.action === 'retire' && this.llm) {
      const cooldownElapsed = cooldownElapsedFor(
        metrics.last_llm_eval_at,
        this.layer3CooldownMs,
        this.now,
      );
      if (cooldownElapsed) {
        const layer3 = await this.llm.evaluate(input);
        outcomes.push({ layer: 'llm', ...layer3 });
        verdict = combineOverride(verdict, layer3);
        layer3Ran = true;
      } else {
        outcomes.push({
          layer: 'llm',
          action: verdict.action,
          confidence: verdict.confidence,
          reasons: ['Layer 3 skipped: LLM evaluation cooldown active.'],
          skipped: true,
        });
      }
    }

    if (this.persistState) {
      await this.persistScanState(roleId, layer2Ran, layer3Ran, outcomes);
    }

    const suggested_reason =
      verdict.action === 'retire' ? suggestRetireReason(signals, verdict.persona_drift) : undefined;
    return {
      scan_id: createId('scan'),
      role_id: roleId,
      scanned_at: new Date(this.now()).toISOString(),
      action: verdict.action,
      confidence: verdict.confidence,
      reasons: verdict.reasons,
      layers: outcomes,
      ...(suggested_reason ? { suggested_reason } : {}),
    };
  }

  /** 扫描全部活跃 Agent（跳过 retired/draining/市场池）。单个失败不阻断批次。 */
  async scanAll(): Promise<RetirementScanResult[]> {
    const roleIds = (await this.repository.listAgentIds()).sort(compareCodeUnits);
    const results: RetirementScanResult[] = [];
    for (const roleId of roleIds) {
      try {
        const handle = await this.repository.getAgent(roleId).catch(() => null);
        if (!handle || handle.status === 'retired' || handle.status === 'draining') continue;
        results.push(await this.scan(roleId));
      } catch (error) {
        results.push({
          scan_id: createId('scan'),
          role_id: roleId,
          scanned_at: new Date(this.now()).toISOString(),
          action: 'keep',
          confidence: 0,
          reasons: [
            `Retirement scan failed: ${error instanceof Error ? error.message : String(error)}`,
          ],
          layers: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  private async listMarketSkills(): Promise<SkillRecord[]> {
    try {
      return await this.repository.listSkills(MARKET_POOL_ROLE_ID);
    } catch {
      return [];
    }
  }

  private async persistScanState(
    roleId: string,
    layer2Ran: boolean,
    layer3Ran: boolean,
    outcomes: RetirementLayerOutcome[],
  ): Promise<void> {
    const scannedAt = new Date(this.now()).toISOString();
    const updates: Partial<AgentMetrics> = { last_retirement_scan_at: scannedAt };
    if (layer2Ran) {
      updates.last_persona_drift_eval_at = scannedAt;
      const drift = outcomes.find((outcome) => outcome.layer === 'persona_drift')?.persona_drift;
      if (drift !== undefined) updates.persona_drift = drift;
    }
    if (layer3Ran) {
      updates.last_llm_eval_at = scannedAt;
    }
    await this.repository.updateMetrics(roleId, (metrics) => ({ ...metrics, ...updates }));
  }
}

// ═══════════════════════════════════════════
//  组合与建议退休原因
// ═══════════════════════════════════════════

function combineEscalate(
  prev: RetirementEvaluation,
  next: RetirementEvaluation,
): RetirementEvaluation {
  // 第二层只允许升级严重度；确认或降级时沿用 prev 的 action，
  // 但始终保留 next 的证据（drift / reasons）供最终结论与建议退休原因使用。
  const escalated = RETIREMENT_SEVERITY[next.action] > RETIREMENT_SEVERITY[prev.action];
  return {
    action: escalated ? next.action : prev.action,
    confidence: escalated ? Math.max(prev.confidence, next.confidence) : prev.confidence,
    reasons: [...prev.reasons, ...next.reasons],
    ...(next.persona_drift !== undefined ? { persona_drift: next.persona_drift } : {}),
    ...(next.market_replaceability !== undefined
      ? { market_replaceability: next.market_replaceability }
      : {}),
    ...(next.experience_recoverability !== undefined
      ? { experience_recoverability: next.experience_recoverability }
      : {}),
  };
}

function combineOverride(
  prev: RetirementEvaluation,
  next: RetirementEvaluation,
): RetirementEvaluation {
  // LLM 响应通常不含 persona_drift，从 prev（第二层）继续保留，供建议退休原因使用。
  const personaDrift = next.persona_drift ?? prev.persona_drift;
  return {
    action: next.action,
    confidence: next.confidence,
    reasons: [...prev.reasons, ...next.reasons],
    ...(personaDrift !== undefined ? { persona_drift: personaDrift } : {}),
    ...(next.market_replaceability !== undefined
      ? { market_replaceability: next.market_replaceability }
      : {}),
    ...(next.experience_recoverability !== undefined
      ? { experience_recoverability: next.experience_recoverability }
      : {}),
  };
}

function cooldownElapsedFor(
  lastRunAt: string | undefined,
  cooldownMs: number,
  now: () => number,
): boolean {
  if (lastRunAt === undefined) return true;
  return now() - Date.parse(lastRunAt) >= cooldownMs;
}

/** 根据统计信号与漂移分，为「建议退休」选择 RetiredReason。 */
export function suggestRetireReason(
  signals: RetirementSignals,
  personaDrift?: number,
): RetiredReason {
  if (personaDrift !== undefined && personaDrift >= PERSONA_DRIFT_THRESHOLDS.drift_retire_threshold) {
    return 'persona_drift';
  }
  if (signals.low_success_rate || signals.critical_staleness) {
    return 'performance_degradation';
  }
  if (signals.inactive) {
    return 'inactivity';
  }
  return 'manual';
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
