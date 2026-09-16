/**
 * run — 角色分歧实验入口
 *
 * 三阶段（规模对应文档 §6）：
 *   probe    1   —— 离线就绪检查：种子 + 每角色语料计数 + 检索策略断言，不触网。
 *                  真实注入由顶层 agent 自行决定，逐格跑完才记录（见 evidence.ts）。
 *   minimal  5   —— 实验一 × 单实例 × 5 角色，用于人眼看差异是否真实存在。
 *   full     108 —— 白板 plan 3 + 角色 plan 15 + 评审白板 15 + 交叉评审 75。
 *
 * 后端进程按角色启停（`NEWIDE_PRIMARY_AGENT_ID` 是进程级 env），顺序串行——PGlite
 * 是单进程文件锁。先生成全部 plan 再评审，否则评审阶段读不到被审对象。
 * 单元证据落盘后即跳过，除非 --force（防 API 漂移）。
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CORPUS_ROLES,
  DEFAULT_MEMORY_RELEVANCE_POLICY,
  ROLE_AGENT_IDS,
  type CorpusRole,
} from '../../src/memory';
import { getInstanceOrThrow, indexDatasetById, loadDataset } from '../load-dataset';
import { loadDatasetSubset, loadManifest, resolveDatasetJsonl } from '../paths';
import { mirrorPathForRepo } from '../ensure-repo-mirror';
import type { SweEvoInstance } from '../types';
import { copyRunEvidence, startBackend } from './backend';
import {
  cellPath,
  clearCell,
  collectCells,
  injectionPath,
  readCell,
  readJson,
  sanitize,
  workspacePath,
  writeCell,
  writeDriverWorkspaceSettings,
  writeJson,
  writeText,
} from './cache';
import {
  assertRetrievalPolicy,
  requireDriverRunner,
  resolveExperimentConfig,
  resolveModelLabel,
  type ExperimentConfig,
} from './config';
import {
  collectCellInjection,
  summarizeAgentToolCalls,
  summarizeDriverToolCalls,
  toExpectedPolicy,
} from './evidence';
import { collectDriverTokenUsage } from './driver-usage';
import {
  cacheGuard,
  cellCostUsd,
  consecutiveFailureGuard,
  resolveRunCostCap,
  runCostGuard,
} from './guards';
import { evaluateInjectionGate } from './injection-gate';
import { buildBatches, type Batch, type Stage } from './plan';
import { PLAN_FILE, REVIEW_FILE, parseVerdict, planPrompt, reviewPrompt } from './prompts';
import { driverRepoRoot, mountDriverRepo, REPO_MOUNT_NAME } from './repo-checkout';
import { seedRoleCorpus } from './seed';
import {
  cellId,
  NEUTRAL_AGENT_ID,
  type CellEvidence,
  type CellKey,
  type PartyKey,
} from './types';

/**
 * 计费时间窗的宽松余量。
 *
 * driver 的会话记录由另一个进程写，其时钟与 harness 不一定完全一致；再加上一条记录
 * 可能在本格标记开始前后落盘。留 60s 余量宁可多算边界记录，也不要漏掉首次调用——
 * 首次调用的输入量就是起始上下文，是成本曲线里最该看见的点。
 */
const CLOCK_SKEW_MARGIN_MS = 60_000;

/**
 * 整轮花费上限的默认口径：每待跑格 $3，下限 $20。
 *
 * 依据是实测的 13 个格子：driver 自报中位 $1.45、最高 $3.39。基数是**待跑**格数而非
 * 总格数——已完成单元会被跳过、不再花钱，用总格数会让续跑一开局就被判超限。
 * 下限要盖得住小规模（`minimal` 5 格最坏也才 ~$17），否则正常跑一趟就被自己拦住。
 */
const DEFAULT_RUN_COST_PER_CELL_USD = 3;
const DEFAULT_RUN_COST_MIN_USD = 20;

interface Options {
  stage: Stage;
  instances?: string[];
  roles: CorpusRole[];
  dryRun: boolean;
  force: boolean;
  allowEmptyInjection: boolean;
  runTimeoutMs: number;
  /** 覆盖子集声明的 source_jsonl（规范 jsonl 缺席时指向本地回收文件） */
  jsonl?: string;
  /**
   * 给 driver 一份只读仓库副本（挂在 `<workspace>/repo`）。
   *
   * 关（默认）= 历史形态：工作区空，plan 只能凭题目文本推测文件路径。
   * 开 = plan 基于真实代码。**两种形态的 prompt 字节不同**，所以同一实验不要混跑。
   */
  repoCheckout: boolean;
  /** 本地仓库 clone 路径（省去联网建 mirror）；要求含 instance 的 base_commit */
  repoSource?: string;
  /** git mirror 根覆盖；默认 `.newide/eval-mirrors` */
  mirrorsRoot?: string;
  /**
   * 单格的**硬上下文上限**（token）。超过就取消该格并判失败。
   *
   * 为什么要有：driver 每轮重发整个上下文，一格的输入量 ≈ `N·C₀ + r·N²/2`，
   * 所以峰值上下文就是花费的主因。实测 prompt 里的预算条款**管不住** agent
   * （121 次调用、0 产出、峰值 151,706/200,000 仍在涨），所以由 harness 兜底。
   */
  maxContextTokens: number;
  /**
   * 单格的**硬花费上限**（USD，driver 自报）。超过就取消该格。
   *
   * 与 `maxContextTokens` 是两把不同的闸：那个管峰值上下文，拦「轮数多」；这个管账单，
   * 拦「缓存没命中」——实测缓存失效时，同样的上下文序列要多付约十倍，而上下文涨得并不快。
   */
  maxCellCostUsd: number;
  /** 整轮**累计花费上限**（USD）。缺省按待跑格数推算，见 `resolveRunCostCap`。 */
  maxRunCostUsd?: number;
  /**
   * 放行「有 ≥2 次推理、但缓存读为 0」的格子。
   *
   * 默认关闭是因为这正是那次事故的形态：产出照常有、终态照常 completed、证据照常落盘，
   * 只有账单是十倍。要跑一个明知不缓存的场景时才显式打开。
   */
  allowZeroCache: boolean;
}

/** 一次运行的共享上下文：配置、CLI 选项、实例索引 */
interface RunContext {
  config: ExperimentConfig;
  options: Options;
  instanceIndex: Map<string, SweEvoInstance>;
  /**
   * 整轮的实时花费台账。只累加**本轮真跑**的格子——已完成被跳过的不花钱，不参与。
   * 与 `runCostCapUsd` 一起构成整轮闸门。
   */
  spend: { usd: number; cells: number };
  /** 整轮花费上限（USD）。main 里按待跑格数算好（见 `resolveRunCostCap`）后写入。 */
  runCostCapUsd: number;
  /**
   * 连续失败了几格（成功即归零）。
   *
   * 放在 context 而不是 runBatch 局部：批次是按角色切的，额度耗尽那类事故会横跨批次，
   * 用局部计数的话每个批次都要重新数满 3 格才熔断，等于每批白烧两格。
   */
  consecutiveFailures: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = resolveExperimentConfig();

  // 探针是离线就绪检查：不读数据集、不碰 driver，所以在两者之前短路掉。
  if (options.stage === 'probe') {
    log(`result root : ${config.result_root}`);
    log('stage       : probe (offline)');
    await runProbe(config);
    return;
  }

  const all = await loadSubsetInstances(config, options.dryRun, options.jsonl);
  const instances =
    options.instances === undefined
      ? all
      : options.instances.map((id) => getInstanceOrThrow(indexDatasetById(all), id));
  const context: RunContext = {
    config,
    options,
    instanceIndex: indexDatasetById(instances),
    // 整轮花费台账与上限在 batches 建好后填（上限要按待跑格数推算）。
    spend: { usd: 0, cells: 0 },
    runCostCapUsd: 0,
    consecutiveFailures: 0,
  };

  log(`result root : ${config.result_root}`);
  log(`dataset     : ${config.dataset_subset} (${instances.length} instance(s))`);
  log(`stage       : ${options.stage}${options.dryRun ? ' (dry-run)' : ''}`);
  log(`model       : ${resolveModelLabel()}`);
  log(`repo access : ${options.repoCheckout ? 'READ-ONLY CHECKOUT (mounted at repo/)' : 'none (empty workspace)'}`);
  const firstInstance = instances[0];
  if (options.repoCheckout) {
    // 只报告将要用的来源，不在这里 clone：probe 是离线检查，联网取仓库留给真正开跑时。
    for (const instance of instances) {
      const canonical = driverRepoRoot(config.result_root, instance.repo, instance.base_commit);
      log(
        `  ${instance.instance_id} @ ${instance.base_commit.slice(0, 12)}` +
          `${existsSync(canonical) ? ' (checkout present)' : ' (will be prepared on first cell)'}`,
      );
      log(`    → ${canonical}`);
    }
    if (!options.repoSource && firstInstance) {
      log(
        `  mirror root : ${mirrorPathForRepo(firstInstance.repo, options.mirrorsRoot)} ` +
          '(pass --repo-source=<local clone> to avoid a network clone)',
      );
    }
  }

  if (firstInstance) {
    const promptSha = sha256(planPrompt(firstInstance, options.repoCheckout));
    log(
      `plan prompt : sha256 ${promptSha.slice(0, 16)} (repoCheckout=${String(options.repoCheckout)})`,
    );
  }

  requireDriverRunner(config);
  const batches = buildBatches(options.stage, instances, options.roles);
  log(`cells       : ${batches.reduce((sum, batch) => sum + batch.keys.length, 0)}`);

  // 闸门在 dry-run 之前算好：这样 --dry-run 能连「这次会允许多少钱」一起预览，
  // 而不必先开跑才知道。countPendingCells 只读磁盘，不触网。
  const pendingCells = await countPendingCells(config, batches, options.force);
  context.runCostCapUsd = resolveRunCostCap({
    ...(options.maxRunCostUsd !== undefined ? { explicitUsd: options.maxRunCostUsd } : {}),
    pendingCells,
    perCellUsd: DEFAULT_RUN_COST_PER_CELL_USD,
    minimumUsd: DEFAULT_RUN_COST_MIN_USD,
  });
  log(`pending     : ${String(pendingCells)} cell(s) will run`);
  log(
    `cost caps   : $${options.maxCellCostUsd.toFixed(2)}/cell, ` +
      `$${context.runCostCapUsd.toFixed(2)}/run` +
      (options.allowZeroCache ? ' (zero-cache cells allowed)' : ''),
  );

  if (options.dryRun) {
    for (const batch of batches) {
      log(`  [${batch.roleKey}]`);
      for (const key of batch.keys) log(`    ${cellId(key)}`);
    }
    return;
  }

  await fs.mkdir(config.result_root, { recursive: true });
  await writeJson(path.join(config.result_root, 'experiment-config.json'), {
    ...config,
    stage: options.stage,
    model_label: resolveModelLabel(),
    instance_ids: instances.map((instance) => instance.instance_id),
    role_keys: options.roles,
    started_at: new Date().toISOString(),
  });

  const seed = await seedRoleCorpus(config);
  log(
    `seeded      : ${seed.per_role.map((e) => `${e.role}=${e.skill_count}`).join(' ')} (+${seed.neutral_role_id})`,
  );
  // 注入证据不在这里预计算——注入由顶层 agent 自行决定，只有跑完才存在。
  // 每一格跑完从它的 context pack 读回来，见 runCell → captureCellInjection。

  for (const batch of batches) {
    await runBatch(context, batch);
  }

  await writeSummary(config, options.stage);
}

// ──────────────────────────────────────────────
// 批次执行：一个批次 = 一个后端进程 + 它名下的若干单元
// ──────────────────────────────────────────────

/**
 * 本轮真正会跑的格子数（已完成且非 `--force` 的跳过）。
 *
 * 与 `runBatch` 的筛选同一口径，抽出来是因为整轮花费上限要以它为基数，而那个数
 * 必须在开跑前就知道——否则「续跑一开局就被判超限」和「上限高得拦不住」都会发生。
 */
async function countPendingCells(
  config: ExperimentConfig,
  batches: Batch[],
  force: boolean,
): Promise<number> {
  if (force) return batches.reduce((sum, batch) => sum + batch.keys.length, 0);
  let pending = 0;
  for (const batch of batches) {
    for (const key of batch.keys) {
      const existing = await readCell(cellPath(config.result_root, cellId(key)));
      if (existing?.status !== 'completed') pending += 1;
    }
  }
  return pending;
}

async function runBatch(context: RunContext, batch: Batch): Promise<void> {
  const { config, options } = context;
  const pending: CellKey[] = [];
  // 两种形态的 prompt 字节不同：同一结果根里混形态，跨格比较就没有意义。
  // 这里在批次开始时对齐检查，而不是等分析时才发现。
  const wantedForm: CellEvidence['run_form'] = options.repoCheckout ? 'with-repo' : 'no-repo';
  let mixedFormSeen = false;
  for (const key of batch.keys) {
    if (options.force) {
      await clearCell(config.result_root, cellId(key));
      pending.push(key);
      continue;
    }
    const existing = await readCell(cellPath(config.result_root, cellId(key)));
    if (existing?.status === 'completed') {
      if (existing.run_form !== undefined && existing.run_form !== wantedForm) {
        mixedFormSeen = true;
      }
      continue;
    }
    pending.push(key);
  }
  if (mixedFormSeen) {
    throw new Error(
      `Result root already holds "${wantedForm === 'with-repo' ? 'no-repo' : 'with-repo'}" cells, ` +
        `but this run is "${wantedForm}". The two forms produce different prompt bytes, so mixing ` +
        'them in one result root makes cross-cell comparison invalid. Point ROLE_DIVERGENCE_ROOT ' +
        'at a fresh directory (or run --force to replace every cell here).',
    );
  }
  if (pending.length === 0) {
    log(`[${batch.roleKey}] all ${String(batch.keys.length)} cell(s) cached`);
    return;
  }

  const roleId = roleIdFor(batch.roleKey);
  const stateRoot = path.join(config.result_root, 'backend', sanitize(batch.roleKey));
  const backend = await startBackend({ config, roleId, stateRoot });
  try {
    for (const key of pending) {
      const cell = await runCell(context, key, backend);
      const cost = cellCostUsd(cell.driver_usage);
      if (cost !== undefined) context.spend.usd += cost;
      context.spend.cells += 1;
      log(
        `  ${cell.status} ${cell.cell_id}${cell.error ? ` — ${cell.error}` : ''}` +
          describeSpend(cell, cost, context),
      );

      // 缓存闸门。这一类失效是静默的：产出照常有、终态照常 completed、证据照常落盘，
      // 只有账单是十倍。判据落在「有 ≥2 次推理却零缓存读」上，跑完一格就见效。
      const cache = cacheGuard(cell.driver_tokens, {
        allowZeroCache: options.allowZeroCache,
        ...(cost !== undefined ? { spentUsd: cost } : {}),
      });
      if (!cache.ok) throw new Error(cache.reason);

      // 整轮闸门。已完成单元都在盘上，所以在这里停下是**无损**的——调高上限重跑即续。
      const runGuard = runCostGuard(context.spend.usd, context.runCostCapUsd, context.spend.cells);
      if (!runGuard.ok) throw new Error(runGuard.reason);

      // 连败闸门放在最后：上面三道具都是**具体**诊断（缓存/单格花费/整轮花费），
      // 能报出具体原因时优先报那个；这一道只兜住「说不出原因的整片失败」。
      context.consecutiveFailures = cell.status === 'failed' ? context.consecutiveFailures + 1 : 0;
      const streakGuard = consecutiveFailureGuard(context.consecutiveFailures, cell.cell_id);
      if (!streakGuard.ok) throw new Error(streakGuard.reason);
    }
  } finally {
    await backend.close();
  }
}

/**
 * 日志尾部附上本格 driver 自报花费与整轮累计。
 *
 * 放在这里是因为「花了多少」必须当场可见：缓存那类故障事后从 cells.jsonl 里读不出来，
 * 而轮询时的上下文曲线又完全正常（used 涨得并不快）。
 */
function describeSpend(
  cell: CellEvidence,
  cost: number | undefined,
  context: RunContext,
): string {
  const parts: string[] = [];
  if (cost !== undefined) parts.push(`$${cost.toFixed(2)}`);
  const ratio = cell.driver_tokens?.cache_read_ratio;
  if (ratio !== undefined) parts.push(`cache ${(ratio * 100).toFixed(0)}%`);
  if (parts.length === 0) return '';
  return (
    ` (${parts.join(', ')}, run $${context.spend.usd.toFixed(2)}` +
    ` of $${context.runCostCapUsd.toFixed(2)})`
  );
}

function roleIdFor(roleKey: PartyKey): string {
  return roleKey === 'neutral' ? NEUTRAL_AGENT_ID : ROLE_AGENT_IDS[roleKey];
}

/**
 * 仓库在工作区里是链接还是复制。
 *
 * 区别很要紧：链接时 `snapshotWorkspaceFiles` 不跟随（无扫描成本、不会有交付物污染），
 * 复制时会有——证据里记下来，事后才能判断某一轮的耗时/产物是否被这个差异影响。
 */
function mountKindFor(mountPath: string): 'link' | 'copy' {
  try {
    return lstatSync(mountPath).isSymbolicLink() ? 'link' : 'copy';
  } catch {
    return 'copy';
  }
}

// ──────────────────────────────────────────────
// 单元执行
// ──────────────────────────────────────────────

async function runCell(
  context: RunContext,
  key: CellKey,
  backend: Awaited<ReturnType<typeof startBackend>>,
): Promise<CellEvidence> {
  const { config, options, instanceIndex } = context;
  const id = cellId(key);
  const filePath = cellPath(config.result_root, id);
  const instance = getInstanceOrThrow(instanceIndex, key.instance_id);
  const isReview = key.experiment.startsWith('review_');
  const prompt = isReview
    ? reviewPrompt(instance, await reviewedPlanText(config, key), options.repoCheckout)
    : planPrompt(instance, options.repoCheckout);

  const workspace = workspacePath(config.result_root, id);
  // `maxRetries` 是 Windows 专治：目录刚被别的句柄放开（上一个 driver 进程正在退出、
  // 杀毒/索引器扫过）时 `rmdir` 会抛 EBUSY/EPERM。实测踩过一次——一次人为中断留下的
  // 孤儿进程仍以该目录为工作目录，导致 `rm` 抛 EBUSY 把整轮打崩（exit 1），
  // 而它本来只是"这一格没跑成"。默认 0 次重试，这里给到 ~2 秒。
  await fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await fs.mkdir(workspace, { recursive: true });
  await writeDriverWorkspaceSettings(workspace, { repoCheckout: options.repoCheckout });

  // 只读仓库挂在工作区之外、再用 junction 挂进来。快照器不跟随链接
  // （workspace-change-detector.ts），所以既无全仓扫描成本，也不会把仓库当交付物。
  let repoProvenance: CellEvidence['repo_provenance'];
  if (options.repoCheckout) {
    const mounted = await mountDriverRepo(instance, workspace, config.result_root, {
      ...(options.repoSource ? { sourceRepo: options.repoSource } : {}),
      ...(options.mirrorsRoot ? { mirrorsRoot: options.mirrorsRoot } : {}),
      log: (message) => log(`  [${key.role_key}] ${message}`),
    });
    repoProvenance = {
      mount: REPO_MOUNT_NAME,
      canonical_path: mounted.canonicalPath,
      base_commit: mounted.base_commit,
      head_commit: mounted.head_commit,
      mount_kind: mountKindFor(mounted.mountPath),
    };
  }

  const cellRoot = path.join(config.result_root, 'cells', sanitize(id));
  await writeText(path.join(cellRoot, 'prompt.txt'), prompt);
  const outputFile = isReview ? REVIEW_FILE : PLAN_FILE;

  const started = Date.now();
  const evidence: CellEvidence = {
    status: 'failed',
    cell_id: id,
    experiment: key.experiment,
    instance_id: key.instance_id,
    role_key: key.role_key,
    role_id: roleIdFor(key.role_key),
    ...(key.author_key ? { author_key: key.author_key } : {}),
    memory_ablation: config.memory_ablation,
    model_label: resolveModelLabel(),
    prompt_path: path.join(cellRoot, 'prompt.txt'),
    prompt_sha256: sha256(prompt),
    workspace_path: workspace,
    output_path: path.join(workspace, outputFile),
    wall_ms: 0,
    run_form: options.repoCheckout ? 'with-repo' : 'no-repo',
    ...(repoProvenance ? { repo_provenance: repoProvenance } : {}),
  };

  let runId: string | undefined;
  try {
    const created = await backend.request<{ run_id: string; task_id: string }>('run.create', {
      prompt,
      mode: 'single_agent',
      workspace_path: workspace,
      memory_ablation: config.memory_ablation,
      title: id,
    });
    runId = created.run_id;
    evidence.run_id = created.run_id;
    evidence.task_id = created.task_id;
    // 本格的预算：上下文上限 + 花费上限。两个都传给 waitForTerminal，由它轮询兜底。
    const budget = {
      stateRoot: path.join(config.result_root, 'backend', sanitize(key.role_key)),
      roleKey: key.role_key,
      max_context_tokens: options.maxContextTokens,
      max_cost_usd: options.maxCellCostUsd,
    };
    const snapshot = await backend.waitForTerminal(created.run_id, options.runTimeoutMs, budget);
    evidence.terminal_status = String(snapshot.status ?? 'unknown');
    await copyRunEvidence(config, sanitize(key.role_key), created.run_id, cellRoot).catch(
      () => undefined,
    );

    // 真实计费台账。必须在 copyRunEvidence 之后（轨迹已落盘）、且用 run 时间窗过滤：
    // workspace 是复用的，Claude 会话文件会持续追加，不过滤会把上一轮算进来。
    try {
      evidence.driver_tokens = await collectDriverTokenUsage({
        workspacePath: workspace,
        sessionIds: backend.driverSessionIds(budget, created.run_id),
        since: new Date(started - CLOCK_SKEW_MARGIN_MS).toISOString(),
        until: new Date(Date.now() + CLOCK_SKEW_MARGIN_MS).toISOString(),
      });
    } catch (error) {
      // 取不到计费不该把已经跑完的一格判死，但必须留痕：缺省与「零花费」不是一回事。
      evidence.driver_tokens_error = message(error);
    }

    const summary = await readJson<Record<string, unknown>>(path.join(cellRoot, 'run-summary.json'));
    if (summary?.token_usage !== undefined) evidence.token_usage = summary.token_usage;
    if (summary?.driver_usage !== undefined) evidence.driver_usage = summary.driver_usage;

    const output = await readOutput(evidence.output_path);
    if (output === undefined) {
      evidence.error = `driver produced no ${outputFile}`;
    } else {
      evidence.output_sha256 = sha256(output);
      if (isReview) {
        const verdict = parseVerdict(output);
        if (verdict) evidence.review_verdict = verdict;
        else evidence.review_parse_failed = true;
      }
      if (evidence.terminal_status === 'completed') evidence.status = 'completed';
    }

    await captureCellInjection(config, options, {
      cellId: id,
      key,
      runId: created.run_id,
      evidence,
    });
  } catch (error) {
    evidence.error = message(error);
    if (runId) {
      await copyRunEvidence(config, sanitize(key.role_key), runId, cellRoot).catch(() => undefined);
    }
  } finally {
    evidence.wall_ms = Date.now() - started;
    await writeCell(filePath, evidence);
  }
  return evidence;
}

/**
 * 跑后取该格的真实注入证据并落盘，同时把关。
 *
 * 空注入（或取不到 context pack）意味着**操纵变量没进这一格**——产出照常有，但它证明
 * 不了任何角色效应。默认判该格失败；`--allow-empty-injection` 是显式放行的开关，
 * 用于明知某角色注入为空仍要看产出。
 *
 * 例外：`role_neutral`（白板对照）的零注入是控制条件本身，见函数末尾的分支。
 */
async function captureCellInjection(
  config: ExperimentConfig,
  options: Options,
  input: { cellId: string; key: CellKey; runId: string; evidence: CellEvidence },
): Promise<void> {
  const { evidence } = input;

  // 先记 Agent 侧轨迹。失败的那一格更需要它——注入为空时，只有这条能区分
  // 「Agent 压根没查」与「查了没命中」。
  const tracePath = path.join(
    config.result_root,
    'cells',
    sanitize(input.cellId),
    'agent-tools.jsonl',
  );
  const trace = await fs.readFile(tracePath, 'utf8').catch(() => undefined);
  if (trace !== undefined) {
    const summary = summarizeAgentToolCalls(trace);
    if (summary) evidence.agent_tools = summary;
  }

  // driver 自己的工具轨迹：缺了它就无法回答「有仓库形态下它到底读没读代码」。
  const trajectoryPath = path.join(path.dirname(tracePath), 'trajectory.jsonl');
  const trajectory = await fs.readFile(trajectoryPath, 'utf8').catch(() => undefined);
  if (trajectory !== undefined) {
    evidence.trajectory_path = trajectoryPath;
    const driverSummary = summarizeDriverToolCalls(trajectory);
    if (driverSummary) evidence.driver_tools = driverSummary;
  }

  const result = await collectCellInjection({
    config,
    cellId: input.cellId,
    roleKey: input.key.role_key,
    roleId: roleIdFor(input.key.role_key),
    instanceId: input.key.instance_id,
    runId: input.runId,
  });

  if (result.kind === 'ok') {
    await writeJson(injectionPath(config.result_root, input.cellId), result.evidence);
  }

  // 这一格已经失败（运行本身出错/超时）：保留它原本的死因。注入问题不该盖掉它——
  // 那不是同一个诊断。
  if (evidence.error !== undefined) return;

  if (result.kind === 'no_pack') {
    evidence.error =
      'no context pack for this run: the backend wrote none, so injection cannot be proven';
    evidence.status = 'failed';
    return;
  }
  if (result.kind === 'no_invocation') {
    evidence.error =
      'run has no driver_invocation_context: the top-level agent never invoked the driver';
    evidence.status = 'failed';
    return;
  }

  // 零注入门禁只管**角色格**。`role_neutral` 是实验二的白板对照，其 agent 名下按定义
  // 不存在任何技能（seed.ts: `skills_overview: 无预置技能`），注入为 0 正是控制条件本身。
  // 判错它会连坐 `review_neutral`/`review_role`（它们都要读这份白板 plan）。
  const gate = evaluateInjectionGate({
    roleKey: input.key.role_key,
    skillCount: result.evidence.skill_count,
    allowEmpty: options.allowEmptyInjection,
    queryHits: evidence.agent_tools?.query_memory_skill_counts,
    roleId: roleIdFor(input.key.role_key),
  });
  if (gate.kind === 'control') {
    evidence.control_zero_injection = true;
  } else if (gate.kind === 'zero_forbidden') {
    evidence.error = gate.reason;
    evidence.status = 'failed';
  }
}

async function readOutput(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/** 评审单元的被审对象：取上游 plan 单元的产出文件正文 */
async function reviewedPlanText(config: ExperimentConfig, key: CellKey): Promise<string> {
  const upstream: CellKey | undefined =
    key.experiment === 'review_neutral'
      ? { experiment: 'plan_neutral', instance_id: key.instance_id, role_key: 'neutral' }
      : key.author_key
        ? { experiment: 'plan_role', instance_id: key.instance_id, role_key: key.author_key }
        : undefined;
  if (!upstream) throw new Error(`No reviewed plan defined for ${cellId(key)}`);

  const cell = await readCell(cellPath(config.result_root, cellId(upstream)));
  if (!cell || cell.status !== 'completed') {
    throw new Error(`Upstream plan cell not completed: ${cellId(upstream)}`);
  }
  const text = await readOutput(cell.output_path);
  if (text === undefined) throw new Error(`Upstream plan output missing: ${cell.output_path}`);
  return text;
}

// ──────────────────────────────────────────────
// 探针（离线就绪检查）
// ──────────────────────────────────────────────

/**
 * 探针不再复算注入。注入由**顶层 agent 自行决定**（它按需调 `query_memory`），跑前
 * 无从得知；而按问题陈述预检索那条路既已被 `NEWIDE_B_DISABLE_PRE_RETRIEVAL` 关掉，
 * 又会撞上嵌入的 8192 token 窗口。
 *
 * 它现在只回答「这台机器具备跑实验的条件吗」：种子是否落库、每个角色的语料计数是否
 * 符合预期、检索策略是否仍是生产默认值。全程不触网、不调 API。
 *
 * 真实注入的门禁在跑后：见 `captureCellInjection`。
 */
async function runProbe(config: ExperimentConfig): Promise<void> {
  const seed = await seedRoleCorpus(config);
  const policy = toExpectedPolicy(DEFAULT_MEMORY_RELEVANCE_POLICY);
  assertRetrievalPolicy(policy, config.expected_retrieval_policy);

  process.stdout.write(
    [
      '',
      'readiness probe — 离线就绪检查（不触网）',
      'role              skills',
      '----------------  ------',
      ...seed.per_role.map(
        (entry) => `${entry.role.padEnd(16)}  ${String(entry.skill_count).padStart(6)}`,
      ),
      '',
      `neutral role      : ${seed.neutral_role_id}`,
      `embedding asset   : ${seed.asset_model} @${String(seed.dimensions)}d`,
      `retrieval policy  : top_k=${String(policy.recall_top_k)} sim>=${String(
        policy.min_embedding_similarity,
      )} max_items=${String(policy.max_memory_items)} tag_overlap>=${String(policy.min_tag_overlap)}`,
      '',
      '注入由顶层 agent 自行决定（按需调 query_memory），跑前无法预知，故此处不报注入。',
      '真实注入逐格落在 injection/<cell_id>.json；空注入的格会被判失败——那才是门禁。',
      '',
    ].join('\n'),
  );
}

// ──────────────────────────────────────────────
// 数据与汇总
// ──────────────────────────────────────────────

/**
 * 载入子集实例。`--dry-run` 允许数据集缺失：此时只用子集声明的 instance id 造占位
 * 记录，好让阶段规模与单元 id 在数据到位之前就能核对。
 *
 * `jsonlOverride`（CLI `--jsonl=<path>`）用于规范 jsonl 不在手边时指向本地回收文件，
 * 规范元数据 `source_jsonl` 保持不动。
 */
async function loadSubsetInstances(
  config: ExperimentConfig,
  allowMissingDataset: boolean,
  jsonlOverride?: string,
): Promise<SweEvoInstance[]> {
  const manifest = loadManifest();
  const subset = loadDatasetSubset(manifest, config.dataset_subset);
  const jsonlPath = resolveDatasetJsonl(manifest, jsonlOverride ?? subset.source_jsonl);
  log(`jsonl       : ${jsonlPath}${jsonlOverride ? ' (--jsonl override)' : ''}`);
  if (!existsSync(jsonlPath)) {
    if (allowMissingDataset) {
      log(
        `WARNING     : dataset jsonl missing (${jsonlPath}); dry-run only lists the subset's ` +
          'declared instance ids.',
      );
      return subset.instance_ids.map((instanceId) => ({
        repo: 'unknown',
        instance_id: instanceId,
        base_commit: '',
        patch: '',
        problem_statement: '',
      }));
    }
    throw new Error(
      `Dataset jsonl missing: ${jsonlPath}. Build it (pnpm eval:build-pr-context -- ` +
        '--subset v0-repo-full), point the subset at an existing source_jsonl, or recover the ' +
        'subset offline (pnpm eval:role-divergence:recover) and pass --jsonl=<path>.',
    );
  }
  const byId = indexDatasetById(await loadDataset(jsonlPath));
  return subset.instance_ids.map((id) => getInstanceOrThrow(byId, id));
}

async function writeSummary(config: ExperimentConfig, stage: Stage): Promise<void> {
  const cells = await collectCells(config.result_root);
  const completed = cells.filter((cell) => cell.status === 'completed').length;
  await fs.writeFile(
    path.join(config.result_root, 'cells.jsonl'),
    cells.map((cell) => JSON.stringify(cell)).join('\n') + (cells.length > 0 ? '\n' : ''),
    'utf8',
  );
  await writeJson(path.join(config.result_root, 'summary.json'), {
    experiment_id: config.experiment_id,
    stage,
    model_label: resolveModelLabel(),
    completed_at: new Date().toISOString(),
    total_cells: cells.length,
    completed_cells: completed,
    failed_cells: cells.length - completed,
  });
  log(`summary     : ${String(completed)}/${String(cells.length)} completed`);
  const reviews = cells.filter((cell) => cell.experiment.startsWith('review_'));
  const unparsed = reviews.filter((cell) => cell.review_parse_failed).length;
  if (unparsed > 0) log(`WARNING     : ${String(unparsed)} review(s) without a parseable VERDICT line`);
  if (completed !== cells.length) process.exitCode = 1;
}

// ──────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────

function parseArgs(argv: string[]): Options {
  const stageArg = valueOf(argv, '--stage') ?? 'probe';
  if (stageArg !== 'probe' && stageArg !== 'minimal' && stageArg !== 'full') {
    throw new Error(`Unknown --stage "${stageArg}" (probe|minimal|full)`);
  }
  const rolesArg = valueOf(argv, '--roles');
  const instancesArg = valueOf(argv, '--instances');
  const jsonlArg = valueOf(argv, '--jsonl');
  const repoSourceArg = valueOf(argv, '--repo-source');
  const mirrorsRootArg = valueOf(argv, '--mirrors-root');
  const roles = rolesArg
    ? rolesArg
        .split(',')
        .map((value) => value.trim())
        .filter((value): value is CorpusRole => (CORPUS_ROLES as readonly string[]).includes(value))
    : [...CORPUS_ROLES];
  if (roles.length === 0) throw new Error('--roles filtered out every known role');

  return {
    stage: stageArg,
    ...(instancesArg
      ? { instances: instancesArg.split(',').map((value) => value.trim()) }
      : {}),
    ...(jsonlArg ? { jsonl: jsonlArg } : {}),
    ...(repoSourceArg ? { repoSource: repoSourceArg } : {}),
    ...(mirrorsRootArg ? { mirrorsRoot: mirrorsRootArg } : {}),
    roles,
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
    allowEmptyInjection: argv.includes('--allow-empty-injection'),
    runTimeoutMs: Number(valueOf(argv, '--timeout-ms') ?? 2_700_000),
    repoCheckout: argv.includes('--repo-checkout'),
    // 实测：无仓库形态每格约 1 次调用、峰值上下文远低于此；有仓库形态若不设闸，
    // 实测一格 23 分钟仍在爬（75.9% / 200k）且 0 产出。默认值取 200k 窗口的约 60%，
    // 留出"读够了、把 plan 写出来"的余量。
    maxContextTokens: Number(valueOf(argv, '--max-context-tokens') ?? 120_000),
    // 单格花费默认 $10：实测 13 个格子的 driver 自报花费，中位 $1.45、最高 $3.39，
    // 留约 3 倍余量。缓存一旦失效，同样的序列会到 $15–35，这道闸在第一格就能拦住。
    maxCellCostUsd: Number(valueOf(argv, '--max-cell-cost-usd') ?? 10),
    ...(valueOf(argv, '--max-run-cost-usd') !== undefined
      ? { maxRunCostUsd: Number(valueOf(argv, '--max-run-cost-usd')) }
      : {}),
    allowZeroCache: argv.includes('--allow-zero-cache'),
  };
}

function valueOf(argv: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(value: string): void {
  process.stderr.write(`[role-divergence] ${value}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${message(error)}\n`);
  process.exitCode = 1;
});
