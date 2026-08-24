/**
 * Agent 维护定时器
 *
 * 每个 tick 依次执行两个阶段：
 * 1. 退休检查：跑三重门控退休检测，对 recommended_action='retire' 的 Agent
 *    决定是否自动退休（默认不自动，只出报告）。
 * 2. 市场自学习：让存活 Agent 扫描市场池，按 tag + persona 相似度引入技能。
 *
 * 提供 start()/stop()/runOnce()。runOnce 供测试与手动触发；start 使用注入的
 * schedule/cancel（默认 setInterval/clearInterval），便于测试注入假定时器。
 */
import type { EmbeddingProvider, MemoryRepository } from '../memory';
import {
  learnSkillsForAgent,
  type SkillLearningOptions,
  type SkillLearningOutcome,
} from '../memory/services/skill-learning';
import type {
  RetireOptions,
  RetireResult,
  RetirementScanResult,
} from '../memory';

/** 退休执行端口（生产由 DriverRuntimeAgentExecutionFacade 提供） */
export interface AgentRetirementPort {
  runRetirementScan(roleId?: string): Promise<RetirementScanResult[]>;
  retireAgent(roleId: string, options: RetireOptions): Promise<RetireResult>;
}

export interface AgentMaintenanceHandlers {
  repository: MemoryRepository;
  /** 缺省 embedding 时市场自学习阶段跳过（只出空报告）。 */
  embedding?: EmbeddingProvider;
  retirement: AgentRetirementPort;
}

export interface AgentMaintenanceOptions {
  /** 是否自动退休（默认 false：只扫描出报告，不退休） */
  autoRetire?: boolean;
  /** 自动退休的置信度下限（默认 0.5） */
  retireConfidenceFloor?: number;
  /** 自动退休时是否创建替代 Agent（默认 'none'） */
  replacement?: 'clean_slate' | 'seeded_slate' | 'none';
  /** 是否执行市场自学习（默认 true） */
  autoLearn?: boolean;
  /** 学习策略 */
  learning?: SkillLearningOptions;
}

export interface AgentMaintenanceSchedulerOptions extends AgentMaintenanceOptions {
  /** 定时器调度函数（默认 setInterval） */
  schedule?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  /** 定时器取消函数（默认 clearInterval） */
  cancel?: (timer: ReturnType<typeof setInterval>) => void;
  now?: () => number;
  logger?: (message: string) => void;
}

export interface RetirementCheckReportItem {
  role_id: string;
  action: 'retire' | 'warn' | 'keep';
  confidence: number;
  /** 本次是否实际退休（或进入预退休） */
  retired: boolean;
  status?: 'retired' | 'pre_retired';
}

export interface RetirementCheckReport {
  scanned: number;
  recommended_retire: number;
  retired: number;
  items: RetirementCheckReportItem[];
}

export interface SkillLearningReport {
  scanned_agents: number;
  imported_skills_total: number;
  per_agent: SkillLearningOutcome[];
}

export interface AgentMaintenanceRunReport {
  ran_at: string;
  retirement: RetirementCheckReport;
  learning: SkillLearningReport;
}

const DEFAULT_OPTIONS: Required<
  Pick<
    AgentMaintenanceOptions,
    'autoRetire' | 'retireConfidenceFloor' | 'replacement' | 'autoLearn'
  >
> = {
  autoRetire: false,
  retireConfidenceFloor: 0.5,
  replacement: 'none',
  autoLearn: true,
};

export class AgentMaintenanceScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastReport: AgentMaintenanceRunReport | undefined;
  private readonly options: Required<
    Pick<AgentMaintenanceOptions, 'autoRetire' | 'retireConfidenceFloor' | 'replacement' | 'autoLearn'>
  > & { learning: SkillLearningOptions };
  private readonly schedule: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly cancel: (timer: ReturnType<typeof setInterval>) => void;
  private readonly now: () => number;
  private readonly logger: (message: string) => void;

  constructor(
    private readonly handlers: AgentMaintenanceHandlers,
    options: AgentMaintenanceSchedulerOptions = {},
  ) {
    this.options = {
      autoRetire: options.autoRetire ?? DEFAULT_OPTIONS.autoRetire,
      retireConfidenceFloor: options.retireConfidenceFloor ?? DEFAULT_OPTIONS.retireConfidenceFloor,
      replacement: options.replacement ?? DEFAULT_OPTIONS.replacement,
      autoLearn: options.autoLearn ?? DEFAULT_OPTIONS.autoLearn,
      learning: { ...(options.learning ?? {}) },
    };
    this.schedule = options.schedule ?? setInterval;
    this.cancel = options.cancel ?? clearInterval;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? (() => {});
  }

  /** 启动周期循环；intervalMs <= 0 时不启动。 */
  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = this.schedule(() => {
      void this.runOnce();
    }, intervalMs);
    this.logger(`Agent maintenance scheduler started (interval=${intervalMs}ms)`);
  }

  stop(): void {
    if (!this.timer) return;
    this.cancel(this.timer);
    this.timer = null;
    this.logger('Agent maintenance scheduler stopped');
  }

  /** 最近一轮维护报告（供观测 / 测试断言）。 */
  lastRunReport(): AgentMaintenanceRunReport | undefined {
    return this.lastReport;
  }

  /** 手动跑一轮（防重入；重入时返回上一轮报告）。 */
  async runOnce(): Promise<AgentMaintenanceRunReport> {
    if (this.running) {
      return this.lastReport ?? emptyReport(new Date(this.now()).toISOString());
    }
    this.running = true;
    try {
      const ranAt = new Date(this.now()).toISOString();
      const retirement = await this.safe(
        () => this.runRetirementPhase(),
        emptyRetirementReport(),
      );
      const learning = await this.safe(
        () => this.runLearningPhase(),
        emptyLearningReport(),
      );
      const report: AgentMaintenanceRunReport = { ran_at: ranAt, retirement, learning };
      this.lastReport = report;
      return report;
    } finally {
      this.running = false;
    }
  }

  private async runRetirementPhase(): Promise<RetirementCheckReport> {
    const scans = await this.handlers.retirement.runRetirementScan();
    const items: RetirementCheckReportItem[] = [];
    let recommended = 0;
    let retired = 0;

    for (const scan of scans) {
      const item: RetirementCheckReportItem = {
        role_id: scan.role_id,
        action: scan.action,
        confidence: scan.confidence,
        retired: false,
      };
      items.push(item);
      if (scan.action !== 'retire') continue;
      recommended += 1;
      if (!this.options.autoRetire) continue;
      if (scan.confidence < this.options.retireConfidenceFloor) continue;

      const result = await this.handlers.retirement.retireAgent(scan.role_id, {
        reason: scan.suggested_reason ?? 'performance_degradation',
        replacement: this.options.replacement,
      });
      item.retired = true;
      item.status = result.status;
      retired += 1;
    }

    return { scanned: scans.length, recommended_retire: recommended, retired, items };
  }

  private async runLearningPhase(): Promise<SkillLearningReport> {
    if (!this.options.autoLearn) {
      return emptyLearningReport();
    }
    const embedding = this.handlers.embedding;
    if (!embedding) {
      return emptyLearningReport();
    }
    const roleIds = (await this.handlers.repository.listAgentIds()).sort();
    const perAgent: SkillLearningOutcome[] = [];
    let importedTotal = 0;

    for (const roleId of roleIds) {
      const handle = await this.handlers.repository.getAgent(roleId).catch(() => null);
      if (!handle || handle.status === 'draining' || handle.status === 'retired') continue;
      const outcome = await learnSkillsForAgent(
        this.handlers.repository,
        embedding,
        roleId,
        this.options.learning,
      );
      importedTotal += outcome.imported_skill_ids.length;
      perAgent.push(outcome);
    }

    return { scanned_agents: perAgent.length, imported_skills_total: importedTotal, per_agent: perAgent };
  }

  /** 单阶段容错：失败时记录日志并返回 fallback，不中断整个循环。 */
  private async safe<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.logger(
        `Agent maintenance phase failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return fallback;
    }
  }
}

function emptyRetirementReport(): RetirementCheckReport {
  return { scanned: 0, recommended_retire: 0, retired: 0, items: [] };
}

function emptyLearningReport(): SkillLearningReport {
  return { scanned_agents: 0, imported_skills_total: 0, per_agent: [] };
}

function emptyReport(ranAt: string): AgentMaintenanceRunReport {
  return { ran_at: ranAt, retirement: emptyRetirementReport(), learning: emptyLearningReport() };
}
