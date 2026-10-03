/**
 * 跨 run 的用量历史：对「按作用域累计了多少 token」这件事给出一个**可解释**的答案。
 *
 * 为什么只能重放：用量**有** run 级持久化（每个 run 目录的 `summary.json`），但没有
 * **跨 run 的累计点**——权威的 Task/Run 状态库 `coordination.sqlite` 里连用量列都没有
 * （`src/persistence` 全文搜不到 token/usage）。所以跨 run 的历史只能扫目录重放，与
 * `scripts/consumption-report.ts --all` 同源，只是取数面更窄（只要计费那一条）。
 *
 * 口径：取 `summary.token_usage`，它已经是「proxy 腿 + Claude session 刮取的 driver 计费腿」
 * 合并后的全量计费。**注意 `summary.driver_billed_usage` 是它的 `claude_session_jsonl`
 * 子集**（`buildDriverBilledUsage` 就是从 `by_source.claude_session_jsonl` 生成的视图），
 * 所以两者绝不能相加——本模块只用前者，后者留给按角色的细分。
 *
 * 「缺 ≠ 0」在这里是硬约束。缺口有两种，都必须让结果显得偏低，而不是刚好：
 *
 * 1. run 写了 `summary.json`，但里面没有可读的 `token_usage`；
 * 2. run **执行过**，却从没写出 `summary.json`（进程被杀、中断后没恢复、写盘失败）。
 *
 * 两种都只把 `runs_without_usage` 加一、把 `complete` 置 false，**绝不贡献 0**。一个假装
 * 完整的总量比一个明说「可能偏低」的总量危险得多。
 *
 * 第 2 种最容易漏：只看 `summary.json` 会让这类 run 被当成「从未推进」而从分母里整个
 * 消失，于是 `complete` 在真实花销完全没进账的情况下照样报 true——这正是本模块要防的
 * 失效模式，只不过发生在比口径更高的一层。判据是 `audit.jsonl` 的存在：它在
 * `startStage` 里写出，早于任何 executor，所以「有它」等价于「确实开跑过」。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RunUsageHistory, RunUsageTokens } from '../protocol/run-snapshot';
import {
  type TokenUsageLedgerEntry,
  type TokenUsageLedgerQuery,
  type TokenUsageLedgerStore,
} from '../persistence';
import {
  buildTokenUsageLedgerEntries,
  readClaudeSessionLeg,
  readProxyLeg,
} from './run-usage-ledger-entries';

/**
 * 可支撑的作用域。
 *
 * `role` 现在支持了，但**不是**因为 `summary` 有了角色归属——它仍然没有。原因是账本在
 * **写入时**就把 `role_id` 记在每一行上（proxy 腿来自事件的归属域，driver 腿来自
 * `session_id → role_id` 的 join）。这正是「落库」比「重算」多出来的东西：重算被
 * `summary` 的形状限制住，落库只被「写入那一刻知道什么」限制住。
 */
export type RunUsageHistoryScope = 'task' | 'system' | 'role';

export interface RunUsageHistoryQuery {
  scope: RunUsageHistoryScope;
  /** `task` 作用域必填；`system` 忽略。 */
  scope_id?: string;
}

export interface RunUsageHistoryReader {
  read(query: RunUsageHistoryQuery): Promise<RunUsageHistory>;
}

/** 一条 run summary 里与用量有关的抽取结果；读不出用量时 `tokens` 为 undefined。 */
export interface RunUsageSummaryFacts {
  run_id: string;
  task_id?: string;
  tokens?: RunUsageTokens;
  by_source?: Record<string, RunUsageTokens>;
}

export class FileRunUsageHistoryReader implements RunUsageHistoryReader {
  constructor(
    private readonly runsRoot = '.newide/runs',
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async read(query: RunUsageHistoryQuery): Promise<RunUsageHistory> {
    const facts = await this.readAllSummaries();
    return aggregateUsageHistory(facts, query, this.now());
  }

  private async readAllSummaries(): Promise<RunUsageSummaryFacts[]> {
    const entries = await fs
      .readdir(this.runsRoot, { withFileTypes: true })
      .catch(() => []);
    const facts: RunUsageSummaryFacts[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDir = path.join(this.runsRoot, entry.name);
      const summary = await readJsonObject(path.join(runDir, 'summary.json'));
      if (summary) {
        facts.push(runUsageSummaryFacts(entry.name, summary));
        continue;
      }
      // 没写 summary 的目录绝大多数只有一个 request.json（从未推进游标），那些不是 run，
      // 不该进分母——实测 582 个目录里有 413 个如此。只有留下 audit.jsonl 的才算执行过，
      // 作为**已知缺口**进分母，让 complete 掉下来。
      if (!(await hasExecutionEvidence(runDir))) continue;
      facts.push(
        runUsageGapFacts(entry.name, await readJsonObject(path.join(runDir, 'request.json'))),
      );
    }
    return facts;
  }
}

/**
 * 把一批 run 事实按作用域折成一份历史。
 *
 * 纯函数，便于逐条单测缺口语义（缺 summary、缺 token_usage、空目录）。
 */
export function aggregateUsageHistory(
  facts: readonly RunUsageSummaryFacts[],
  query: RunUsageHistoryQuery,
  asOf: string,
): RunUsageHistory {
  const matched =
    query.scope === 'task'
      ? facts.filter((fact) => fact.task_id !== undefined && fact.task_id === query.scope_id)
      : facts;

  const bySource: Record<string, RunUsageTokens> = {};
  const totals = emptyTokens();
  let runsWithUsage = 0;

  for (const fact of matched) {
    if (!fact.tokens) continue;
    runsWithUsage += 1;
    addTokens(totals, fact.tokens);
    for (const [source, tokens] of Object.entries(fact.by_source ?? {})) {
      bySource[source] = addTokens(bySource[source] ?? emptyTokens(), tokens);
    }
  }

  const runsWithoutUsage = matched.length - runsWithUsage;
  return {
    scope: query.scope,
    ...(query.scope === 'task' && query.scope_id ? { scope_id: query.scope_id } : {}),
    as_of: asOf,
    runs_counted: matched.length,
    runs_without_usage: runsWithoutUsage,
    // 一个 run 都没有，或有人没有用量，都不能声称完整。
    complete: matched.length > 0 && runsWithoutUsage === 0,
    billed: { totals, by_source: bySource },
  };
}

/** 从一份 `summary.json` 抽出用量事实。读不出的字段一律缺席，不补 0。 */
export function runUsageSummaryFacts(
  fallbackRunId: string,
  summary: Record<string, unknown>,
): RunUsageSummaryFacts {
  const tokenUsage = asRecord(summary.token_usage);
  return {
    run_id: nonEmptyString(summary.run_id) ?? fallbackRunId,
    ...(nonEmptyString(summary.task_id) ? { task_id: nonEmptyString(summary.task_id)! } : {}),
    ...(tokenUsage ? spreadTokens(tokenUsage) : {}),
  };
}

/**
 * 造一条**已知缺口**事实：run 执行过，但没有任何可读的用量。
 *
 * 刻意不填 `tokens`——这正是重点，缺口不折算成 0。`task_id` 只能取自 `request.json`，
 * 因为没有 summary 就没有第二个来源；取不到时这条事实无法归属任何 task，`task` 作用域的
 * 查询也就看不到它。这是**残留缺口**（实测 12 条缺口里只有 1 条如此），不是 0，但仍未被
 * 任何作用域计入——需要精确到 task 级时得另找归属来源，不能假装它不存在。
 */
export function runUsageGapFacts(
  runId: string,
  request: Record<string, unknown> | undefined,
): RunUsageSummaryFacts {
  const taskId = nonEmptyString(request?.task_id);
  return { run_id: runId, ...(taskId ? { task_id: taskId } : {}) };
}

function spreadTokens(source: Record<string, unknown>): {
  tokens: RunUsageTokens;
  by_source: Record<string, RunUsageTokens>;
} {
  const bySource: Record<string, RunUsageTokens> = {};
  for (const [key, value] of Object.entries(asRecord(source.by_source) ?? {})) {
    const bucket = asRecord(value);
    if (bucket) bySource[key] = readTokens(bucket);
  }
  return { tokens: readTokens(source), by_source: bySource };
}

function readTokens(source: Record<string, unknown>): RunUsageTokens {
  return {
    input_tokens: readNumber(source.input_tokens),
    output_tokens: readNumber(source.output_tokens),
    cache_creation_input_tokens: readNumber(source.cache_creation_input_tokens),
    cache_read_input_tokens: readNumber(source.cache_read_input_tokens),
    total_input_tokens: readNumber(source.total_input_tokens),
    total_tokens: readNumber(source.total_tokens),
    call_count: readNumber(source.call_count),
  };
}

function emptyTokens(): RunUsageTokens {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_input_tokens: 0,
    total_tokens: 0,
    call_count: 0,
  };
}

function addTokens(target: RunUsageTokens, add: RunUsageTokens): RunUsageTokens {
  target.input_tokens += add.input_tokens;
  target.output_tokens += add.output_tokens;
  target.cache_creation_input_tokens += add.cache_creation_input_tokens;
  target.cache_read_input_tokens += add.cache_read_input_tokens;
  target.total_input_tokens += add.total_input_tokens;
  target.total_tokens += add.total_tokens;
  target.call_count += add.call_count;
  return target;
}

/**
 * 这个 run 目录是否留下「确实开跑过」的痕迹。
 *
 * 判据只用 `audit.jsonl`，不查 `latency.jsonl` / `stages/`：实测 582 个目录里「有 audit 却
 * 无 summary」的 12 个，把后两者的命中（6 / 9）全覆盖了，audit 是超集。多查那两个只是多付
 * syscall，而这里的每一次 stat 都乘在 425 个无 summary 目录上。
 */
async function hasExecutionEvidence(runDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(runDir, 'audit.jsonl'));
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, { encoding: 'utf8' });
  } catch {
    // 读不出（文件不在、或目录被清掉）：返回 undefined，由调用方决定把这次缺席算成
    // **已知缺口**还是整个跳过。两种处理都不会把它当成 0。
    return undefined;
  }
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * 账本支撑的历史读路径。
 *
 * 与 `FileRunUsageHistoryReader` 的分工：那个**扫目录重算**，只在 run 目录还在时才成立，
 * 保留为参考实现与回填来源；这个读账本，才是「往期被清掉也不影响」的那条路。
 *
 * 首次读之前做一次**惰性回填**：账本之前的历史只存在于 run 目录里，不回填就等于「切到
 * 账本」把既有历史一次性变成 0。回填是幂等 upsert（`(run_id, role_id, source, metric)`
 * 是主键），所以进程重启后重跑一遍也只是重写同样的行。
 */
export class LedgerRunUsageHistoryReader implements RunUsageHistoryReader {
  private backfill: Promise<void> | undefined;

  constructor(
    private readonly ledger: TokenUsageLedgerStore,
    private readonly runsRoot = '.newide/runs',
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async read(query: RunUsageHistoryQuery): Promise<RunUsageHistory> {
    await this.ensureBackfilled();
    const ledgerQuery: TokenUsageLedgerQuery =
      query.scope === 'system'
        ? { scope: 'system' }
        : {
            scope: query.scope,
            ...(query.scope_id !== undefined ? { scope_id: query.scope_id } : {}),
          };
    const aggregate = this.ledger.aggregateTokenUsage(ledgerQuery, this.now());
    return {
      scope: aggregate.scope,
      ...(aggregate.scope_id !== undefined ? { scope_id: aggregate.scope_id } : {}),
      as_of: aggregate.as_of,
      runs_counted: aggregate.runs_counted,
      runs_without_usage: aggregate.runs_without_usage,
      complete: aggregate.complete,
      billed: { totals: aggregate.totals, by_source: aggregate.by_source },
    };
  }

  /**
   * 回填失败**不抛给调用方**——否则 `run.getUsage` 会整个不可用，而账本里已有的那部分
   * 本来是能读的。失败也不缓存，下一次读会重试。
   *
   * 代价要说清：回填失败期间，历史只反映账本里已有的 run，而 `complete` 可能仍报 true
   * （它数的是同一个库里的 `handler.started`，不含那些只存在于目录树里的旧 run）。
   */
  private ensureBackfilled(): Promise<void> {
    this.backfill ??= backfillTokenUsageLedger(this.runsRoot, this.ledger, this.now())
      .then(() => undefined)
      .catch(() => {
        this.backfill = undefined;
      });
    return this.backfill;
  }
}

export interface TokenUsageLedgerBackfillResult {
  /** 读到 `summary.json` 的 run 数。 */
  runs_scanned: number;
  /** 没有 `task_id` 因而无法落行的 run 数——账本的 `task_id` 非空，这类只能跳过。 */
  runs_skipped_without_task_id: number;
  rows_written: number;
}

/**
 * 把 run 目录里已有的用量一次性灌进账本。**幂等**，可以反复跑。
 *
 * 只搬 `summary.token_usage` 的两条腿：proxy 腿在 summary 里没有角色细分，所以回填出来的
 * proxy 行一律是未归属哨兵（编造归属比留空更糟）；driver 腿能借
 * `driver_billed_usage.sessions[]` 还原角色。**绝不碰 `driver_context_usage`**——那是上下文
 * 占用，属于另一种口径。
 */
export async function backfillTokenUsageLedger(
  runsRoot: string,
  ledger: TokenUsageLedgerStore,
  recordedAt: string,
): Promise<TokenUsageLedgerBackfillResult> {
  const entries = await fs.readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  const batch: TokenUsageLedgerEntry[] = [];
  let runsScanned = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const summary = await readJsonObject(path.join(runsRoot, entry.name, 'summary.json'));
    if (!summary) continue;
    runsScanned += 1;
    const taskId = nonEmptyString(summary.task_id);
    if (!taskId) {
      skipped += 1;
      continue;
    }
    const tokenUsage = summary.token_usage;
    const proxyLeg = readProxyLeg(tokenUsage);
    const driverBilledLeg = readClaudeSessionLeg(tokenUsage);
    batch.push(
      ...buildTokenUsageLedgerEntries({
        run_id: nonEmptyString(summary.run_id) ?? entry.name,
        task_id: taskId,
        ...(proxyLeg ? { proxyLeg } : {}),
        ...(driverBilledLeg ? { driverBilledLeg } : {}),
        ...(summary.driver_billed_usage !== undefined
          ? { driverBilledUsage: summary.driver_billed_usage }
          : {}),
        recorded_at: recordedAt,
      }),
    );
  }

  if (batch.length > 0) ledger.appendTokenUsage(batch);
  return {
    runs_scanned: runsScanned,
    runs_skipped_without_task_id: skipped,
    rows_written: batch.length,
  };
}
