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
import { promises as fs, readFileSync } from 'node:fs';
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
 *
 * `run` 是单个 run 的用量。它与 `task` 的区别不是粒度而是**取数路径**：`run` 由
 * `readRun`（同步）服务，用于把已收尾 run 的快照 `usage` 块从内存搬到持久层，见那里的注释。
 */
export type RunUsageHistoryScope = 'task' | 'system' | 'role' | 'run';

export interface RunUsageHistoryQuery {
  scope: RunUsageHistoryScope;
  /** `task` / `role` / `run` 必填；`system` 忽略。 */
  scope_id?: string;
}

/** 一个 run 的持久计费用量。两条腿分开，永不合并。 */
export interface DurableRunUsage {
  totals: RunUsageTokens;
  by_source: Record<string, RunUsageTokens>;
}

export interface RunUsageHistoryReader {
  read(query: RunUsageHistoryQuery): Promise<RunUsageHistory>;
  /**
   * 单个 run 的持久计费用量；该 run 在持久层里没有用量时返回 `undefined`。
   *
   * **为什么是同步的**：它要服务的调用方是 `getRunSnapshot`，而快照投影是同步的
   * （SQLite 是同步驱动）。为了这一条把整个快照投影改成 Promise 是拿契约去迁就实现。
   *
   * **不依赖任何别的读先跑过**：回填是异步的，同步方法等不了，所以实现不能靠「别人回填过
   * 我就读得到」。答案必须由这一条读**自己**给出——账本在前，run 目录自己的 `summary.json`
   * 兜底（同步），见 `LedgerRunUsageHistoryReader.readRun`。
   *
   * 返回 `undefined` 而不是全 0 的合计：**缺 ≠ 0**。账本里这个 run 没有行，与「这个 run
   * 花了 0 token」是两件事，调用方必须能区分。
   */
  readRun(runId: string): DurableRunUsage | undefined;
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

  /**
   * 同步读一个 run 的 `summary.json`。参考实现——生产走账本，这条路径依赖 run 目录还在。
   *
   * 用同步 IO 是刻意的：这个方法的契约就是同步（见 `RunUsageHistoryReader.readRun`）。
   */
  readRun(runId: string): DurableRunUsage | undefined {
    const summary = readJsonObjectSync(path.join(this.runsRoot, runId, 'summary.json'));
    if (!summary) return undefined;
    const facts = runUsageSummaryFacts(runId, summary);
    // 与 `readLeg` 同一条守卫：读不出、或读出来是个 0，都算**缺席**而不是「花了 0」。
    if (!facts.tokens || facts.tokens.total_tokens === 0) return undefined;
    return { totals: facts.tokens, by_source: facts.by_source ?? {} };
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

/** `readJsonObject` 的同步孪生：语义完全相同（读不出 → undefined，绝不折算成 0）。 */
function readJsonObjectSync(filePath: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, { encoding: 'utf8' });
  } catch {
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
  /**
   * 账本里没有这个 run 的腿时的**同步兜底**。
   *
   * 它存在是因为 `readRun` 是同步的而回填是异步的：没有它，「这个 run 花了多少」就取决于
   * **有没有人先读过一次历史**——先读 `run.getUsage`（会回填）就有数字，直接读快照就没有。
   * 同一个 run 的用量随**读的顺序**而变是不能接受的，所以那一格必须由这一条读自己填。
   */
  private readonly summaryFallback: FileRunUsageHistoryReader;

  constructor(
    private readonly ledger: TokenUsageLedgerStore,
    private readonly runsRoot = '.newide/runs',
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.summaryFallback = new FileRunUsageHistoryReader(runsRoot, now);
  }

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
   * 单个 run 的持久用量：**账本在前，run 目录自己的 `summary.json` 兜底**。
   *
   * 一条按 `run_id` 的等值聚合：主键 `(run_id, role_id, source, metric)` 的前缀就是它，
   * 所以这是索引命中，可以安全地挂在同步的快照投影路径上。
   *
   * **为什么必须有兜底**：账本的行是 run **收尾时**写的，所以「账本里有行」只对账本上线之后
   * 跑过的 run 成立；账本之前的历史只活在 `runs/<id>/summary.json` 里（实测：本地 41 个状态库、
   * 292 个 run，`token_usage_ledger` 表一个都不存在，而 208 个 run 有 summary）。回填能把它们
   * 搬进账本，但回填是异步的、`readRun` 是同步的——只读账本就等于让「这个 run 花了多少」
   * 取决于**有没有人先读过一次历史**。这不只是不好看：前端的 run 详情先于历史面板打开时，
   * 同一个 run 会先报「没有用量」、再报出一个数。
   *
   * 顺序刻意是账本在前：账本的行在 run 目录被清掉之后仍然在，而且 `appendUsageLedger` 写下的
   * 正是**同一份** summary 的两条腿（外加角色归属）。所以两条路给出同一个数，差别只在「目录
   * 还在不在」——兜底因此只是把账本上线之前的窗口补上，不是第二套口径。
   *
   * 兜底是一次**同步读单个文件**，只在账本里没有这个 run 的腿时才发生；一旦回填过（任何一次
   * `read` 都会把整棵目录树灌进去）就不再走这条路。实测全部 510 个 `summary.json` 里最大的
   * 一个 57 KB、中位数 12 KB，所以挂在同步快照路径上不构成负担。
   *
   * 兜底的边界要说清：它只在 run 目录还在时成立。账本上线**之前**跑完、目录又已经被清掉的
   * run，这里永远给不出数字——数据是真的没了。那种缺口由 `read` 的 `runs_without_usage` /
   * `complete` 报出来（它按事件表里的 `handler.started` 数 run，不看目录），而不是在这里
   * 编一个 0。
   */
  readRun(runId: string): DurableRunUsage | undefined {
    const aggregate = this.ledger.aggregateTokenUsage({ scope: 'run', scope_id: runId }, this.now());
    // `runs_counted` 会把「执行过但账本里没有行」的 run 也算进来，那种情况 `totals` 全是 0。
    // 判据因此不能是 `runs_counted`，得是「到底有没有腿」——**缺 ≠ 0**。
    if (Object.keys(aggregate.by_source).length === 0) {
      return this.summaryFallback.readRun(runId);
    }
    return { totals: aggregate.totals, by_source: aggregate.by_source };
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
  /**
   * 账本里**已经有腿**、因而只补缺失那条腿（或整条都不补）的 run 数。
   *
   * 摆出来而不是悄悄跳过：这个数就是「回填与存活期写入谁先谁后」的观测。它长期为 0 意味着
   * 账本之前的历史还没灌完；它迅速追平 `runs_scanned` 意味着回填已经没什么可做的了。
   */
  runs_already_in_ledger: number;
  rows_written: number;
}

/**
 * 把 run 目录里已有的用量一次性灌进账本。**按腿幂等**，可以反复跑。
 *
 * 只搬 `summary.token_usage` 的两条腿：proxy 腿在 summary 里没有角色细分，所以回填出来的
 * proxy 行一律是未归属哨兵（编造归属比留空更糟）；driver 腿能借
 * `driver_billed_usage.sessions[]` 还原角色。**绝不碰 `driver_context_usage`**——那是上下文
 * 占用，属于另一种口径。
 *
 * **为什么必须逐腿检查「账本里是不是已经有了」**：幂等键是
 * `(run_id, role_id, source, metric)`，而回填的 proxy 行是**未归属**的（`role_id = ''`）、
 * 存活期写入的那一行带真实 `role_id`。两者主键不同，于是「再回填一次」不是覆盖而是**新增
 * 一行**。实测这条路径把同一个 run 的 proxy 腿算成了两倍（110 → 220），而且触发条件正是最
 * 常见的那个：跑完一个 run 之后重启后端，第一次读历史就会回填整个目录树。
 *
 * 因此判据是**腿**而不是 run：账本里已经有 `proxy` 行就不再补 proxy，已经有
 * `claude_session_jsonl` 行就不再补 driver。只补缺的那条腿，两条都在就整条跳过。
 *
 * 已知残留：这个判据看的是「有没有腿」，不是「这条腿完不完整」。若某次写入在
 * `appendTokenUsage` 中途崩掉（它不是事务），回填不会再补齐剩下那部分。两种失效模式里
 * 选这个是刻意的——重复计会把总量**报大**且看不出来，补不全只会**报小**，而报小有
 * `runs_without_usage` 这条已知缺口的通道在盯着。
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
  let alreadyInLedger = 0;

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
    const runId = nonEmptyString(summary.run_id) ?? entry.name;
    const present = presentLedgerSources(ledger, runId, recordedAt);
    if (present.size > 0) alreadyInLedger += 1;
    const tokenUsage = summary.token_usage;
    const proxyLeg = present.has('proxy') ? undefined : readProxyLeg(tokenUsage);
    const driverBilledLeg = present.has('claude_session_jsonl')
      ? undefined
      : readClaudeSessionLeg(tokenUsage);
    batch.push(
      ...buildTokenUsageLedgerEntries({
        run_id: runId,
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
    runs_already_in_ledger: alreadyInLedger,
    rows_written: batch.length,
  };
}

/**
 * 这个 run 在账本里**已经有哪几条腿**。
 *
 * 复用 `run` 作用域的聚合而不是新开一个存储端口：语义正好是「这个 run 的 by_source」，而
 * 端口多一个方法就要多改一批测试替身。查询走主键前缀 `run_id`，是索引命中。
 *
 * 不吞错：查不出来就抛给调用方（`LedgerRunUsageHistoryReader.ensureBackfilled` 会在下次读
 * 时重试）。这里刻意**不**降级成「当成空的」——那正好会退化成我们要修的那个重复计。
 */
function presentLedgerSources(
  ledger: TokenUsageLedgerStore,
  runId: string,
  asOf: string,
): Set<string> {
  const aggregate = ledger.aggregateTokenUsage({ scope: 'run', scope_id: runId }, asOf);
  return new Set(Object.keys(aggregate.by_source));
}
