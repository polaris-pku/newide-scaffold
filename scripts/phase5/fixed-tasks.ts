/**
 * 阶段 5「固定真实任务集 + 新旧路径 A/B 对照」harness。
 *
 * 职责与核心逻辑：
 * - 对每个固定任务、每条路径（new / legacy），从固定 fixture 复制出**独立** workspace，
 *   用独立 `NEWIDE_STATE_ROOT` / B 存储目录 / CLAUDE 配置目录启动一个真实生产后端
 *   （`node --import tsx src/app/backend-rpc-entry.ts`，JSON-RPC over stdio），用 `run.create`
 *   跑一次 solo Run，等终态后收集证据并做**确定性**完成标准校验。
 * - 真实 Role LLM 来自仓库 `.env.local`（不修改），真实外部 Driver 来自
 *   `ACP_DRIVER_RUNNER_DIR`。本 harness 只通过进程环境注入开关与隔离目录，不改仓库配置。
 * - 两条路径除三个功能开关外配置完全一致；prompt 对两条路径相同（A/B 公平性）。
 * - 每条 run 的结果 JSON 落 `<out>/results/<task>/<path>.json`，原始证据留在
 *   `<out>/runs/<task>/<path>/`（workspace、state root、后端 stderr、以及 state root 里的
 *   run 目录）。失败照实登记，不把 mock/确定性结果计入真实任务数。
 *
 * 复用既有模式：后端 stdio 客户端与 run 等待方式对齐 `scripts/rpc-smoke.ts` /
 * `scripts/real-acceptance.ts`，不新建评测框架。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { snapshotWorkspaceContent } from '../../src/coordinator/workspace-change-detector';
import {
  FIXED_TASKS,
  HOST_CHECK_FILES,
  type CompletionCheck,
  type FixedTask,
  type FixtureFile,
} from './fixed-task-definitions';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type PathName = 'new' | 'legacy';

interface HarnessOptions {
  taskIds: string[];
  paths: PathName[];
  concurrency: number;
  outRoot: string;
  repoRoot: string;
  runnerDir: string;
  runTimeoutMs: number;
  /** 只准备 fixture、不跑（调试用）。 */
  prepareOnly: boolean;
}

interface CheckResult {
  kind: CompletionCheck['kind'];
  label: string;
  passed: boolean;
  detail?: string;
}

interface JournalFacts {
  present: boolean;
  entries: number;
  init?: Record<string, unknown>;
  role_rounds: number;
  role_round_input_tokens?: number;
  role_round_output_tokens?: number;
  role_round_usage_missing: number;
  accepted: number;
  dispatched: number;
  settled: number;
  reconciled: number;
  finish?: Record<string, unknown>;
  dispatch_ids: string[];
  dispatch_kinds: Record<string, number>;
  dispatch_status: Record<string, number>;
  unknown_dispatch_ids: string[];
  violations: string[];
  session_ids: string[];
  evidence_usage: { input_tokens: number; output_tokens: number; observations: number };
  errors: string[];
}

interface RunResultRecord {
  schema_version: 'newide.phase5.fixed_task_result.v1';
  task_id: string;
  task_kind: FixedTask['kind'];
  goal: string;
  path: PathName;
  generated_at: string;
  config: {
    switches: Record<string, string>;
    state_root: string;
    b_pglite_data_dir: string;
    b_app_state_root: string;
    claude_config_dir: string;
    workspace: string;
    runner_dir: string;
    acp_inactivity_timeout_ms: string;
    driver_timeout_ms: string;
    gate_command: string;
    node_version: string;
    repo_pinned_node: string;
  };
  run: {
    run_id?: string;
    task_id?: string;
    status?: string;
    outcome?: string;
    started_at?: string;
    ended_at?: string;
    duration_ms?: number;
    termination?: { code?: string; actor?: string; message?: string; source?: string };
    errors: unknown[];
    response_excerpt?: string;
    files_written?: string[];
    changed_files?: string[];
  };
  role: {
    engine: 'role_autonomy' | 'legacy';
    rounds?: number;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    journal_round_total_tokens?: number;
    llm_calls?: number;
    source: string;
    missing: string[];
  };
  driver: {
    billed?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      cache_read_input_tokens?: number;
      call_count?: number;
      source: string;
    };
    merge_status?: string;
    dispatches_observed?: number;
    sessions?: string[];
    context_usage?: { sessions: number; max_context_tokens_used: number };
    journal_evidence_usage_sum?: {
      input_tokens: number;
      output_tokens: number;
      observations: number;
    };
    missing: string[];
  };
  dispatch: {
    total?: number;
    by_status?: Record<string, number>;
    unknown_dispatch_ids?: string[];
    violation_kinds?: string[];
    journal_entries?: number;
    role_rounds?: number;
    missing: string[];
  };
  evidence: {
    run_dir?: string;
    summary?: string;
    result?: string;
    journal?: string;
    timeline?: string;
    driver_stream?: string;
    driver_usage?: string;
    audit?: string;
    missing: string[];
  };
  completion: {
    all_passed: boolean;
    checks: CheckResult[];
  };
  expected_evidence_gap?: { paths: string[]; reason: string };
  failure_reason?: string;
  notes: string[];
}

const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir(path.join(options.outRoot, 'results'), { recursive: true });
  const tasks = FIXED_TASKS.filter((task) => options.taskIds.includes(task.id));
  if (tasks.length !== options.taskIds.length) {
    const known = new Set(FIXED_TASKS.map((task) => task.id));
    const unknown = options.taskIds.filter((id) => !known.has(id));
    throw new Error(`Unknown task id(s): ${unknown.join(', ')}`);
  }
  const specs: Array<{ task: FixedTask; pathName: PathName }> = [];
  for (const task of tasks) {
    for (const pathName of options.paths) specs.push({ task, pathName });
  }
  process.stdout.write(
    `[fixed-tasks] ${specs.length} run(s): ${tasks.length} task(s) x ${options.paths.join('+')}, ` +
      `concurrency=${options.concurrency}, out=${options.outRoot}\n`,
  );
  if (options.prepareOnly) {
    for (const spec of specs) await prepareRunDirs(options, spec.task, spec.pathName);
    return;
  }
  const failures: string[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, options.concurrency) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const spec = specs[index];
      if (!spec) return;
      try {
        // 单个 run 的硬上限：超过「run 超时 + 5 分钟」仍未返回，就记录失败并继续下一个，
        // 不让一个卡死的真实 driver/后端拖住整个固定任务集。
        await withTimeout(
          runOne(options, spec.task, spec.pathName),
          options.runTimeoutMs + 300_000,
          `run ${spec.task.id}/${spec.pathName}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${spec.task.id}/${spec.pathName}: ${message}`);
        process.stderr.write(`[fixed-tasks] FAILED ${spec.task.id}/${spec.pathName}: ${message}\n`);
      }
    }
  });
  await Promise.all(workers);
  if (failures.length > 0) {
    process.stderr.write(`[fixed-tasks] ${failures.length} harness failure(s):\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('[fixed-tasks] all runs finished\n');
  }
}

function parseArgs(args: string[]): HarnessOptions {
  const repoRoot = process.cwd();
  const options: HarnessOptions = {
    taskIds: FIXED_TASKS.map((task) => task.id),
    paths: ['new', 'legacy'],
    concurrency: 2,
    outRoot: path.join(repoRoot, '.newide', 'phase5', 'fixed-tasks'),
    repoRoot,
    runnerDir:
      process.env.ACP_DRIVER_RUNNER_DIR?.trim() ||
      path.join(repoRoot, '.newide', 'phase5', 'driver-runner'),
    runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
    prepareOnly: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    switch (arg) {
      case '--tasks':
        options.taskIds = requireValue(arg, next)
          .split(',')
          .map((id) => id.trim());
        index += 1;
        break;
      case '--paths':
        options.paths = requireValue(arg, next)
          .split(',')
          .map((value) => value.trim())
          .map((value) => {
            if (value !== 'new' && value !== 'legacy') {
              throw new Error(`Invalid --paths value: ${value}`);
            }
            return value;
          });
        index += 1;
        break;
      case '--concurrency':
        options.concurrency = Number(requireValue(arg, next));
        index += 1;
        break;
      case '--out':
        options.outRoot = path.resolve(requireValue(arg, next));
        index += 1;
        break;
      case '--runner-dir':
        options.runnerDir = path.resolve(requireValue(arg, next));
        index += 1;
        break;
      case '--timeout-ms':
        options.runTimeoutMs = Number(requireValue(arg, next));
        index += 1;
        break;
      case '--prepare-only':
        options.prepareOnly = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(options.concurrency) || options.concurrency < 1) {
    throw new Error('--concurrency must be a positive number');
  }
  if (!Number.isFinite(options.runTimeoutMs) || options.runTimeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }
  return options;
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

interface RunPaths {
  runRoot: string;
  workspace: string;
  stateRoot: string;
  bAppStateRoot: string;
  bPgliteDir: string;
  claudeConfigDir: string;
  backendStderr: string;
  resultFile: string;
}

function resolveRunPaths(options: HarnessOptions, task: FixedTask, pathName: PathName): RunPaths {
  const runRoot = path.join(options.outRoot, 'runs', task.id, pathName);
  return {
    runRoot,
    workspace: path.join(runRoot, 'workspace'),
    stateRoot: path.join(runRoot, 'state'),
    bAppStateRoot: path.join(runRoot, 'b'),
    bPgliteDir: path.join(runRoot, 'b', 'pglite'),
    claudeConfigDir: path.join(runRoot, 'claude-config'),
    backendStderr: path.join(runRoot, 'backend.stderr.log'),
    resultFile: path.join(options.outRoot, 'results', task.id, `${pathName}.json`),
  };
}

async function prepareRunDirs(
  options: HarnessOptions,
  task: FixedTask,
  pathName: PathName,
): Promise<RunPaths> {
  const paths = resolveRunPaths(options, task, pathName);
  // Windows 上后端/驱动残留句柄会让删除暂时 EBUSY；重试几次而不是直接失败。
  await fs.rm(paths.runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await fs.mkdir(paths.workspace, { recursive: true });
  await fs.mkdir(paths.stateRoot, { recursive: true });
  await fs.mkdir(paths.bPgliteDir, { recursive: true });
  await fs.mkdir(paths.claudeConfigDir, { recursive: true });
  await writeFixtureFiles(paths.workspace, task.fixture);
  return paths;
}

async function writeFixtureFiles(workspace: string, files: FixtureFile[]): Promise<void> {
  for (const file of files) {
    const target = path.join(workspace, ...file.path.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, 'utf8');
  }
}

function pathEnv(options: HarnessOptions, pathName: PathName, paths: RunPaths): NodeJS.ProcessEnv {
  const switches =
    pathName === 'new'
      ? {
          NEWIDE_ROLE_AUTONOMY: '1',
          NEWIDE_DRIVER_EVIDENCE_ONLY: '1',
          NEWIDE_BUFFER_V2: '1',
        }
      : {
          NEWIDE_ROLE_AUTONOMY: '0',
          NEWIDE_DRIVER_EVIDENCE_ONLY: '0',
          NEWIDE_BUFFER_V2: '0',
        };
  return {
    ...process.env,
    ...switches,
    NEWIDE_STATE_ROOT: paths.stateRoot,
    NEWIDE_B_APP_STATE_ROOT: paths.bAppStateRoot,
    NEWIDE_B_PGLITE_DATA_DIR: paths.bPgliteDir,
    CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
    ACP_DRIVER_RUNNER_DIR: options.runnerDir,
    ACP_DRIVER_ENV_FILE: path.join(options.runnerDir, '.env'),
    ACP_DRIVER_INACTIVITY_TIMEOUT_MS: process.env.ACP_DRIVER_INACTIVITY_TIMEOUT_MS ?? '600000',
    ACP_DRIVER_TIMEOUT_MS: process.env.ACP_DRIVER_TIMEOUT_MS ?? '600000',
    NEWIDE_GATE_COMMAND: '',
    NEWIDE_DEFAULT_RUN_MODE: 'single_agent',
    NEWIDE_TELEMETRY_JSONL: '1',
    NEWIDE_DRIVER_USAGE_JSONL: '1',
  };
}

async function runOne(options: HarnessOptions, task: FixedTask, pathName: PathName): Promise<void> {
  const paths = await prepareRunDirs(options, task, pathName);
  const startedAt = new Date();
  process.stdout.write(`[fixed-tasks] start ${task.id}/${pathName}\n`);
  const before = await snapshotWorkspace(paths.workspace);
  const backend = await startBackend(options, pathName, paths);
  const notes: string[] = [];
  const evidenceMissing: string[] = [];
  const record: RunResultRecord = {
    schema_version: 'newide.phase5.fixed_task_result.v1',
    task_id: task.id,
    task_kind: task.kind,
    goal: task.goal,
    path: pathName,
    generated_at: startedAt.toISOString(),
    config: {
      switches:
        pathName === 'new'
          ? {
              NEWIDE_ROLE_AUTONOMY: '1',
              NEWIDE_DRIVER_EVIDENCE_ONLY: '1',
              NEWIDE_BUFFER_V2: '1',
            }
          : {
              NEWIDE_ROLE_AUTONOMY: '0',
              NEWIDE_DRIVER_EVIDENCE_ONLY: '0',
              NEWIDE_BUFFER_V2: '0',
            },
      state_root: paths.stateRoot,
      b_pglite_data_dir: paths.bPgliteDir,
      b_app_state_root: paths.bAppStateRoot,
      claude_config_dir: paths.claudeConfigDir,
      workspace: paths.workspace,
      runner_dir: options.runnerDir,
      acp_inactivity_timeout_ms: '600000',
      driver_timeout_ms: '600000',
      gate_command: '(empty -> BestEffortGateExecutor)',
      node_version: process.version,
      repo_pinned_node: '22.22.1 (.nvmrc; 本机 PATH 为 Node 24，记录为环境差异)',
    },
    run: { errors: [] },
    role: {
      engine: pathName === 'new' ? 'role_autonomy' : 'legacy',
      source: 'summary.consumption.by_stage.execute_agent',
      missing: [],
    },
    driver: { missing: [] },
    dispatch: { missing: [] },
    evidence: { missing: [] },
    completion: { all_passed: false, checks: [] },
    notes,
  };
  if (task.expected_evidence_gap) {
    record.expected_evidence_gap = {
      paths: [...task.expected_evidence_gap.paths],
      reason: task.expected_evidence_gap.reason,
    };
  }
  try {
    const created = await backend.request<{ run_id: string; task_id: string }>('run.create', {
      prompt: task.prompt,
      mode: 'single_agent',
      workspace_path: paths.workspace,
    });
    record.run.run_id = created.run_id;
    record.run.task_id = created.task_id;
    record.evidence.run_dir = path.join(paths.stateRoot, 'runs', created.run_id);
    process.stdout.write(`[fixed-tasks] ${task.id}/${pathName} run_id=${created.run_id}\n`);
    const terminal = await backend.waitForTerminal(created.run_id, options.runTimeoutMs);
    process.stderr.write(
      `[fixed-tasks] ${task.id}/${pathName} terminal=${String(terminal.status ?? 'unknown')}\n`,
    );
    const endedAt = new Date();
    record.run.status = String(terminal.status ?? 'unknown');
    record.run.outcome = optionalString(terminal.outcome);
    record.run.duration_ms = endedAt.getTime() - startedAt.getTime();
    record.run.started_at = startedAt.toISOString();
    record.run.ended_at = endedAt.toISOString();
    record.run.errors = Array.isArray(terminal.errors) ? terminal.errors : [];
    const finalOutput = asRecord(terminal.final_output);
    if (finalOutput) {
      record.run.files_written = stringArray(finalOutput.files_written);
      record.run.changed_files = stringArray(finalOutput.changed_files);
      record.run.response_excerpt = excerpt(optionalString(finalOutput.response));
    }
  } catch (error) {
    record.run.status = 'harness_error';
    record.failure_reason = error instanceof Error ? error.message : String(error);
    record.run.errors = [{ code: 'harness_error', message: record.failure_reason }];
    process.stderr.write(`[fixed-tasks] ${task.id}/${pathName} error: ${record.failure_reason}\n`);
  } finally {
    // close 必须有上限：真实 driver 子进程可能不退出，后端 close 会等它；不能让 harness 挂住。
    try {
      await withTimeout(backend.close(), 30_000, `${task.id}/${pathName} backend.close`);
    } catch (error) {
      notes.push(`backend_close_timeout=${error instanceof Error ? error.message : String(error)}`);
      process.stderr.write(
        `[fixed-tasks] ${task.id}/${pathName} backend.close did not finish in 30s; continuing\n`,
      );
    }
  }
  process.stderr.write(`[fixed-tasks] ${task.id}/${pathName} phase=evidence\n`);
  const endedAt = new Date();
  if (record.run.ended_at === undefined) record.run.ended_at = endedAt.toISOString();
  if (record.run.duration_ms === undefined) {
    record.run.duration_ms = endedAt.getTime() - startedAt.getTime();
  }

  // ── 收集证据（只读；不因缺文件而失败，缺什么记什么） ───────────────
  if (record.run.run_id !== undefined) {
    const runDir = path.join(paths.stateRoot, 'runs', record.run.run_id);
    const summaryPath = path.join(runDir, 'summary.json');
    const resultPath = path.join(runDir, 'result.json');
    const journalPath = path.join(runDir, 'journal', 'dispatches.jsonl');
    const timelinePath = path.join(runDir, 'timeline.json');
    const driverStreamPath = path.join(runDir, 'driver-stream.jsonl');
    const driverUsagePath = path.join(runDir, 'driver-usage.jsonl');
    const auditPath = path.join(runDir, 'audit.jsonl');
    const summary = await readJsonIfExists(summaryPath);
    const result = await readJsonIfExists(resultPath);
    const timeline = await readJsonArrayIfExists(timelinePath);
    record.evidence.summary = (await exists(summaryPath)) ? summaryPath : undefined;
    record.evidence.result = (await exists(resultPath)) ? resultPath : undefined;
    record.evidence.journal = (await exists(journalPath)) ? journalPath : undefined;
    record.evidence.timeline = (await exists(timelinePath)) ? timelinePath : undefined;
    record.evidence.driver_stream = (await exists(driverStreamPath)) ? driverStreamPath : undefined;
    record.evidence.driver_usage = (await exists(driverUsagePath)) ? driverUsagePath : undefined;
    record.evidence.audit = (await exists(auditPath)) ? auditPath : undefined;
    for (const [key, value] of Object.entries({
      summary: record.evidence.summary,
      result: record.evidence.result,
      journal: record.evidence.journal,
      timeline: record.evidence.timeline,
      driver_stream: record.evidence.driver_stream,
      driver_usage: record.evidence.driver_usage,
      audit: record.evidence.audit,
    })) {
      if (value === undefined) evidenceMissing.push(key);
    }
    record.evidence.missing = evidenceMissing;

    const journal = await readJournal(journalPath);
    record.dispatch.journal_entries = journal.present ? journal.entries : undefined;
    if (!journal.present) {
      // legacy 路径没有派工 Journal（RD-JRN-07：不伪造记录）。派工/轮次改从 latency span
      // 计数（agent.tool.invoke_driver / agent.llm_round），来源如实标注。
      record.dispatch.missing.push('journal (legacy path: counts derived from latency spans)');
      const spanCounts = await readLatencySpanCounts(path.join(runDir, 'latency.jsonl'));
      record.dispatch.total = spanCounts['agent.tool.invoke_driver'] ?? 0;
      record.role.rounds = spanCounts['agent.llm_round'] ?? 0;
      record.dispatch.role_rounds = record.role.rounds;
      notes.push('legacy_dispatch_and_rounds_from_latency_spans');
    } else {
      record.dispatch.total = journal.accepted;
      record.dispatch.by_status = journal.dispatch_status;
      record.dispatch.unknown_dispatch_ids = journal.unknown_dispatch_ids;
      record.dispatch.violation_kinds = journal.violations;
      record.dispatch.role_rounds = journal.role_rounds;
      if (journal.errors.length > 0) notes.push(`journal_parse_errors=${journal.errors.length}`);
    }
    if (pathName === 'new' && journal.present) {
      record.role.rounds = journal.role_rounds;
      if (journal.role_round_input_tokens !== undefined) {
        record.role.input_tokens = journal.role_round_input_tokens;
      }
      if (journal.role_round_output_tokens !== undefined) {
        record.role.output_tokens = journal.role_round_output_tokens;
      }
      if (
        journal.role_round_input_tokens !== undefined &&
        journal.role_round_output_tokens !== undefined
      ) {
        record.role.journal_round_total_tokens =
          journal.role_round_input_tokens + journal.role_round_output_tokens;
      }
      if (journal.role_round_usage_missing > 0) {
        record.role.missing.push('journal_role_round_usage');
      }
      record.driver.journal_evidence_usage_sum = journal.evidence_usage;
    }

    // role LLM 口径：两条路径都取 execute_agent 的 scaffold LLM 用量（role/agent 循环）。
    const consumption = asRecord(asRecord(summary)?.consumption);
    const byStage = asRecord(consumption?.by_stage);
    const executeAgent = asRecord(byStage?.execute_agent);
    if (executeAgent) {
      record.role.input_tokens =
        numberOrUndefined(executeAgent.input_tokens) ?? record.role.input_tokens;
      record.role.output_tokens =
        numberOrUndefined(executeAgent.output_tokens) ?? record.role.output_tokens;
      const total = numberOrUndefined(executeAgent.total_tokens);
      if (total !== undefined) record.role.total_tokens = total;
      record.role.llm_calls = numberOrUndefined(executeAgent.llm_calls);
    } else {
      record.role.missing.push('consumption.by_stage.execute_agent');
    }

    // driver 计费口径：优先 summary.driver_billed_usage（Claude session JSONL 刮取）。
    // 本 harness 给每个 run 独立的 CLAUDE_CONFIG_DIR，summary 的刮取器只看 ~/.claude，
    // 因此正常会 `skipped_no_session_usage`；此时由 harness 从**本 run 隔离目录**按同一
    // 口径（message.id 去重 + usage 字段求和）自行刮取，并如实标注来源。
    const summaryRecord = asRecord(summary);
    const billedMerge = asRecord(summaryRecord?.driver_billed_merge);
    record.driver.merge_status = optionalString(billedMerge?.status);
    const billed = asRecord(summaryRecord?.driver_billed_usage);
    if (billed && record.driver.merge_status === 'merged') {
      record.driver.billed = {
        input_tokens: numberOrUndefined(billed.input_tokens),
        output_tokens: numberOrUndefined(billed.output_tokens),
        total_tokens: numberOrUndefined(billed.total_tokens),
        cache_read_input_tokens: numberOrUndefined(billed.cache_read_input_tokens),
        call_count: numberOrUndefined(billed.call_count),
        source: 'summary.driver_billed_usage (claude_session_jsonl)',
      };
    } else {
      const scraped = await scrapeClaudeSessionUsage(paths.claudeConfigDir);
      if (scraped.call_count > 0) {
        record.driver.billed = {
          ...scraped,
          source: 'isolated CLAUDE_CONFIG_DIR session JSONL (harness scrape)',
        };
        notes.push(
          `driver_billed_merge=${record.driver.merge_status ?? 'absent'} -> harness scrape`,
        );
      } else {
        record.driver.missing.push(
          `driver_billed_usage (merge_status=${record.driver.merge_status ?? 'absent'}, isolated scrape empty)`,
        );
      }
    }
    const contextUsage = asRecord(summaryRecord?.driver_context_usage);
    if (contextUsage) {
      const sessions = Array.isArray(contextUsage.sessions) ? contextUsage.sessions : [];
      record.driver.sessions = sessions
        .map((session) => optionalString(asRecord(session)?.session_id))
        .filter((value): value is string => value !== undefined);
      record.driver.context_usage = {
        sessions: sessions.length,
        max_context_tokens_used: sessions.reduce(
          (max, session) =>
            Math.max(max, numberOrUndefined(asRecord(session)?.context_tokens_used) ?? 0),
          0,
        ),
      };
    }
    record.driver.dispatches_observed = journal.present ? journal.dispatched : undefined;

    // 终止原因：run.failed / run.cancelled 事件的 payload.code（timeline 是持久投影）。
    const termination = findTermination(timeline, record.run.status);
    if (termination) record.run.termination = termination;
    if (record.run.status === 'failed' && termination?.code === undefined) {
      const resultError = asRecord(asRecord(result)?.error);
      const message = optionalString(resultError?.message) ?? optionalString(resultError?.code);
      if (message) record.run.termination = { code: 'unknown', message };
    }
    if (record.run.response_excerpt === undefined) {
      const response =
        optionalString(asRecord(result)?.response) ??
        optionalString(asRecord(asRecord(summary)?.final_output)?.response);
      if (response) record.run.response_excerpt = excerpt(response);
    }
  }

  // ── 确定性完成标准 ────────────────────────────────────────────────
  process.stderr.write(`[fixed-tasks] ${task.id}/${pathName} phase=checks\n`);
  const hostChecks = HOST_CHECK_FILES[task.id] ?? [];
  if (hostChecks.length > 0) {
    await writeFixtureFiles(paths.workspace, hostChecks);
    notes.push(`host_check_files_written=${hostChecks.map((file) => file.path).join(',')}`);
  }
  const answerText = await collectAnswerTextFromEvidence(paths, record);
  const checkResults = await withTimeout(
    evaluateChecks(task.checks, paths.workspace, before, answerText),
    180_000,
    `${task.id}/${pathName} evaluateChecks`,
  );
  record.completion = {
    all_passed: checkResults.every((check) => check.passed),
    checks: checkResults,
  };
  if (record.run.status !== 'completed') {
    record.failure_reason =
      record.failure_reason ??
      `${record.run.status ?? 'unknown'}: ${record.run.termination?.code ?? 'no_code'} ${
        record.run.termination?.message ?? ''
      }`.trim();
  }
  if (record.run.status === 'completed' && !record.completion.all_passed) {
    record.failure_reason = 'run completed but deterministic completion checks failed';
  }
  // 只读分析任务额外确认 workspace 未变（已在 checks 里，重复记录便于报告直接读）。
  if (task.kind === 'analysis') {
    notes.push('analysis_task=workspace_must_be_unchanged');
  }
  await fs.mkdir(path.dirname(paths.resultFile), { recursive: true });
  process.stderr.write(`[fixed-tasks] ${task.id}/${pathName} phase=write-result\n`);
  await fs.writeFile(paths.resultFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  const checkSummary = checkResults.map(
    (check) => `${check.passed ? 'PASS' : 'FAIL'}:${check.kind}`,
  );
  process.stdout.write(
    `[fixed-tasks] done ${task.id}/${pathName} status=${record.run.status ?? '?'} ` +
      `dispatch=${record.dispatch.total ?? '?'} checks=[${checkSummary.join(', ')}]\n`,
  );
}

// ── 后端 stdio 客户端（复用 rpc-smoke/real-acceptance 的模式） ─────────

interface BackendClient {
  request<T>(method: string, params: unknown): Promise<T>;
  waitForTerminal(runId: string, timeoutMs: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

async function startBackend(
  options: HarnessOptions,
  pathName: PathName,
  paths: RunPaths,
): Promise<BackendClient> {
  const env = pathEnv(options, pathName, paths);
  const stderrChunks: string[] = [];
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['--import', 'tsx', path.join('src', 'app', 'backend-rpc-entry.ts')],
    { cwd: options.repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const stderrHandle = await fs.open(paths.backendStderr, 'w');
  child.stderr.on('data', (chunk: Buffer) => {
    const text = String(chunk);
    stderrChunks.push(text);
    void stderrHandle.write(text).catch(() => undefined);
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code));
  });
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  const messages: JsonRpcMessage[] = [];
  const waiters = new Set<{
    predicate: (message: JsonRpcMessage) => boolean;
    resolve: (message: JsonRpcMessage) => void;
  }>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    messages.push(message);
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  });
  let nextId = 1;
  const request = async <T>(method: string, params: unknown): Promise<T> => {
    if (spawnError) throw spawnError;
    const id = nextId++;
    const waiting = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!waiters.delete(waiter)) return;
        reject(
          new Error(`${method} timed out (120s). stderr=${stderrChunks.join('').slice(-2_000)}`),
        );
      }, 120_000);
      const waiter = {
        predicate: (message: JsonRpcMessage) => message.id === id,
        resolve: (message: JsonRpcMessage) => {
          clearTimeout(timer);
          resolve(message);
        },
      };
      waiters.add(waiter);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const response = await waiting;
    if (response.error) {
      throw new Error(`${method}: ${String(response.error.code)} ${response.error.message}`);
    }
    return response.result as T;
  };
  // 启动探活：system.ping 在服务装配完成后才可用；驱动发现探测可能耗时数秒。
  const pingDeadline = Date.now() + 180_000;
  for (;;) {
    try {
      await request('system.ping', {});
      break;
    } catch (error) {
      if (Date.now() > pingDeadline) {
        throw new Error(
          `backend did not answer system.ping: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (spawnError) throw spawnError;
      await sleep(1_000);
    }
  }
  return {
    request,
    waitForTerminal: async (runId: string, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await request<Record<string, unknown>>('run.getSnapshot', {
          run_id: runId,
        });
        const status = optionalString(snapshot.status);
        if (status !== undefined && status !== 'running') return snapshot;
        const exited = await Promise.race([
          closed.then((code) => ({ exited: true as const, code })),
          sleep(250).then(() => ({ exited: false as const, code: null })),
        ]);
        if (exited.exited) {
          throw new Error(
            `backend exited with code ${String(exited.code)} while run ${runId} was running. ` +
              `stderr=${stderrChunks.join('').slice(-4_000)}`,
          );
        }
      }
      throw new Error(`run ${runId} did not reach a terminal state in ${timeoutMs}ms`);
    },
    close: async () => {
      child.stdin.end();
      let result: number | null | 'timeout' = await Promise.race([
        closed,
        sleep(15_000).then(() => 'timeout' as const),
      ]);
      if (result === 'timeout') {
        child.kill('SIGTERM');
        result = await Promise.race([closed, sleep(3_000).then(() => 'timeout' as const)]);
      }
      if (result === 'timeout') {
        child.kill('SIGKILL');
        await Promise.race([closed, sleep(3_000)]);
      }
      // 释放管道：即使后端进程仍残留，也不让 harness 卡在未消费的 stdout/stderr 上。
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      await stderrHandle.close().catch(() => undefined);
    },
  };
}

// ── 证据读取 ──────────────────────────────────────────────────────

async function readJournal(journalPath: string): Promise<JournalFacts> {
  const facts: JournalFacts = {
    present: false,
    entries: 0,
    role_rounds: 0,
    role_round_usage_missing: 0,
    accepted: 0,
    dispatched: 0,
    settled: 0,
    reconciled: 0,
    dispatch_ids: [],
    dispatch_kinds: {},
    dispatch_status: {},
    unknown_dispatch_ids: [],
    violations: [],
    session_ids: [],
    evidence_usage: { input_tokens: 0, output_tokens: 0, observations: 0 },
    errors: [],
  };
  let content: string;
  try {
    content = await fs.readFile(journalPath, 'utf8');
  } catch {
    return facts;
  }
  facts.present = true;
  const seen = new Set<string>();
  const violationKinds = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let usageMissing = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      facts.errors.push('bad_json_line');
      continue;
    }
    facts.entries += 1;
    const event = optionalString(entry.event) ?? '';
    if (event === 'init') facts.init = entry;
    if (event === 'role_round') {
      facts.role_rounds += 1;
      const input = numberOrUndefined(entry.input_tokens);
      const output = numberOrUndefined(entry.output_tokens);
      if (entry.usage_missing === true || input === undefined || output === undefined) {
        usageMissing += 1;
      } else {
        inputTokens += input;
        outputTokens += output;
      }
    }
    if (event === 'accepted') {
      const dispatchId = optionalString(entry.dispatch_id);
      if (dispatchId !== undefined && !seen.has(dispatchId)) {
        seen.add(dispatchId);
        facts.accepted += 1;
        facts.dispatch_ids.push(dispatchId);
        const kind = optionalString(asRecord(entry.brief)?.kind) ?? 'unknown';
        facts.dispatch_kinds[kind] = (facts.dispatch_kinds[kind] ?? 0) + 1;
      }
    }
    if (event === 'dispatched') {
      facts.dispatched += 1;
      const sessionId = optionalString(entry.session_id);
      if (sessionId !== undefined) facts.session_ids.push(sessionId);
    }
    if (event === 'settled') {
      facts.settled += 1;
      const status = optionalString(entry.status) ?? 'unknown';
      facts.dispatch_status[status] = (facts.dispatch_status[status] ?? 0) + 1;
      for (const violation of stringArray(entry.violations)) violationKinds.add(violation);
      const usage = asRecord(asRecord(entry.evidence)?.usage);
      const usageInput = numberOrUndefined(usage?.input_tokens);
      const usageOutput = numberOrUndefined(usage?.output_tokens);
      if (usageInput !== undefined || usageOutput !== undefined) {
        facts.evidence_usage.input_tokens += usageInput ?? 0;
        facts.evidence_usage.output_tokens += usageOutput ?? 0;
        facts.evidence_usage.observations += 1;
      }
    }
    if (event === 'reconciled') facts.reconciled += 1;
    if (event === 'finish') facts.finish = entry;
  }
  facts.role_round_input_tokens = facts.role_rounds > 0 ? inputTokens : undefined;
  facts.role_round_output_tokens = facts.role_rounds > 0 ? outputTokens : undefined;
  facts.role_round_usage_missing = usageMissing;
  facts.violations = [...violationKinds].sort();
  // unknown 以 settled 行状态为准（同一 dispatch 只记一次状态；last-wins 与折叠口径一致）。
  const settledStatus = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.event === 'settled') {
        const dispatchId = optionalString(entry.dispatch_id);
        const status = optionalString(entry.status);
        if (dispatchId !== undefined && status !== undefined) settledStatus.set(dispatchId, status);
      }
    } catch {
      // already counted above
    }
  }
  facts.unknown_dispatch_ids = [...settledStatus.entries()]
    .filter(([, status]) => status === 'unknown')
    .map(([dispatchId]) => dispatchId);
  return facts;
}

/** latency.jsonl 的 span 名计数（legacy 路径没有 Journal 时用于派生派工/轮次）。 */
async function readLatencySpanCounts(latencyPath: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  let content: string;
  try {
    content = await fs.readFile(latencyPath, 'utf8');
  } catch {
    return counts;
  }
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const span = JSON.parse(line) as Record<string, unknown>;
      const name = optionalString(span.name);
      if (name !== undefined) counts[name] = (counts[name] ?? 0) + 1;
    } catch {
      // 坏行忽略：计数是派生信号，不因个别坏行失败。
    }
  }
  return counts;
}

interface ScrapedSessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_tokens: number;
  call_count: number;
}

/**
 * 从**本 run 隔离的** CLAUDE_CONFIG_DIR 下刮取真实计费 token。
 *
 * 口径与 `src/telemetry/collect-claude-session-usage.ts` 一致：逐行解析 session JSONL，
 * 按 `message.id` 去重（同一条消息可能在 JSONL 中出现多行），usage 字段求和。
 * 只在 summary 的 `driver_billed_merge` 没并进来时使用（隔离 CLAUDE_CONFIG_DIR 导致
 * 仓库内置刮取器看不到本 run 的 session 文件），来源如实标注。
 */
async function scrapeClaudeSessionUsage(claudeConfigDir: string): Promise<ScrapedSessionUsage> {
  const usage: ScrapedSessionUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_tokens: 0,
    call_count: 0,
  };
  const files = await listJsonlFiles(path.join(claudeConfigDir, 'projects'));
  if (files.length === 0) return usage;
  const byMessageId = new Map<
    string,
    { input: number; output: number; cacheCreate: number; cacheRead: number }
  >();
  for (const file of files) {
    let content: string;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const message = asRecord(entry.message);
      const messageUsage = asRecord(message?.usage);
      if (!messageUsage) continue;
      const input = numberOrUndefined(messageUsage.input_tokens) ?? 0;
      const output = numberOrUndefined(messageUsage.output_tokens) ?? 0;
      const cacheCreate = numberOrUndefined(messageUsage.cache_creation_input_tokens) ?? 0;
      const cacheRead = numberOrUndefined(messageUsage.cache_read_input_tokens) ?? 0;
      const messageId =
        optionalString(message?.id) ?? optionalString(entry.uuid) ?? `${file}:${line.length}`;
      byMessageId.set(messageId, { input, output, cacheCreate, cacheRead });
    }
  }
  for (const entry of byMessageId.values()) {
    usage.input_tokens += entry.input;
    usage.output_tokens += entry.output;
    usage.cache_creation_input_tokens += entry.cacheCreate;
    usage.cache_read_input_tokens += entry.cacheRead;
    usage.total_tokens += entry.input + entry.output + entry.cacheCreate + entry.cacheRead;
  }
  usage.call_count = byMessageId.size;
  return usage;
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(absolute);
    }
  };
  await walk(root);
  return files;
}

function findTermination(
  timeline: unknown[] | undefined,
  status: string | undefined,
): RunResultRecord['run']['termination'] | undefined {
  if (!timeline) return undefined;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const event = asRecord(timeline[index]);
    const type = optionalString(event?.type);
    if (type === undefined) continue;
    if (type !== 'run.failed' && type !== 'run.cancelled' && type !== 'run.interrupted') continue;
    const payload = asRecord(event?.payload);
    return {
      code: optionalString(payload?.code),
      actor: optionalString(payload?.actor),
      message: optionalString(payload?.message),
      source: type,
    };
  }
  if (status === 'completed') return undefined;
  return undefined;
}

async function collectAnswerText(
  summary: unknown,
  result: unknown,
  timeline: unknown[] | undefined,
): Promise<string> {
  const parts: string[] = [];
  const push = (value: unknown): void => {
    const text = optionalString(value);
    if (text) parts.push(text);
  };
  push(asRecord(summary)?.response);
  push(asRecord(asRecord(summary)?.final_output)?.response);
  push(asRecord(result)?.response);
  push(asRecord(asRecord(result)?.final_output)?.response);
  if (timeline) {
    for (const event of timeline) {
      const record = asRecord(event);
      if (record?.type !== 'agent.execution_completed') continue;
      push(asRecord(record.payload)?.response);
    }
  }
  return parts.join('\n');
}

async function collectAnswerTextFromEvidence(
  paths: RunPaths,
  record: RunResultRecord,
): Promise<string> {
  const runDir = record.evidence.run_dir;
  if (!runDir) return record.run.response_excerpt ?? '';
  const summary = await readJsonIfExists(path.join(runDir, 'summary.json'));
  const result = await readJsonIfExists(path.join(runDir, 'result.json'));
  const timeline = await readJsonArrayIfExists(path.join(runDir, 'timeline.json'));
  return collectAnswerText(summary, result, timeline);
}

// ── 确定性完成标准 ────────────────────────────────────────────────

async function evaluateChecks(
  checks: CompletionCheck[],
  workspace: string,
  before: Map<string, string>,
  answerText: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await evaluateCheck(check, workspace, before, answerText));
  }
  return results;
}

async function evaluateCheck(
  check: CompletionCheck,
  workspace: string,
  before: Map<string, string>,
  answerText: string,
): Promise<CheckResult> {
  const label = check.label ?? defaultLabel(check);
  try {
    switch (check.kind) {
      case 'node_script': {
        const result = await runNodeScript(
          path.join(workspace, ...check.path.split('/')),
          workspace,
          check.timeout_ms ?? 30_000,
        );
        return {
          kind: check.kind,
          label,
          passed: result.exitCode === 0,
          detail: `exit=${String(result.exitCode)} stdout=${excerpt(result.stdout)} stderr=${excerpt(result.stderr)}`,
        };
      }
      case 'file_contains': {
        const content = await readWorkspaceFile(workspace, check.path);
        if (content === undefined) {
          return { kind: check.kind, label, passed: false, detail: 'file missing' };
        }
        const missing = check.patterns.filter((pattern) => !content.includes(pattern));
        return {
          kind: check.kind,
          label,
          passed: missing.length === 0,
          detail: missing.length === 0 ? undefined : `missing=${missing.join('|')}`,
        };
      }
      case 'file_not_contains': {
        const content = await readWorkspaceFile(workspace, check.path);
        if (content === undefined) {
          return { kind: check.kind, label, passed: false, detail: 'file missing' };
        }
        const found = check.patterns.filter((pattern) => content.includes(pattern));
        return {
          kind: check.kind,
          label,
          passed: found.length === 0,
          detail: found.length === 0 ? undefined : `found=${found.join('|')}`,
        };
      }
      case 'json_path_equals': {
        const content = await readWorkspaceFile(workspace, check.path);
        if (content === undefined) {
          return { kind: check.kind, label, passed: false, detail: 'file missing' };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch (error) {
          return {
            kind: check.kind,
            label,
            passed: false,
            detail: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        const actual = readJsonPath(parsed, check.json_path);
        const passed = JSON.stringify(actual) === JSON.stringify(check.expected);
        return {
          kind: check.kind,
          label,
          passed,
          detail: passed ? undefined : `actual=${JSON.stringify(actual)}`,
        };
      }
      case 'path_exists': {
        const existsResult = await exists(path.join(workspace, ...check.path.split('/')));
        return { kind: check.kind, label, passed: existsResult };
      }
      case 'answer_contains': {
        const normalized = answerText.toLowerCase();
        const matched = check.patterns.filter((pattern) =>
          normalized.includes(pattern.toLowerCase()),
        );
        const passed =
          check.any === true ? matched.length > 0 : matched.length === check.patterns.length;
        return {
          kind: check.kind,
          label,
          passed,
          detail: passed
            ? undefined
            : `matched=${matched.join('|')} wanted=${check.patterns.join('|')}`,
        };
      }
      case 'workspace_unchanged': {
        const after = await snapshotWorkspace(workspace);
        const changed = diffSnapshots(before, after);
        return {
          kind: check.kind,
          label,
          passed: changed.length === 0,
          detail: changed.length === 0 ? undefined : `changed=${changed.join('|')}`,
        };
      }
    }
  } catch (error) {
    return {
      kind: check.kind,
      label,
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function defaultLabel(check: CompletionCheck): string {
  switch (check.kind) {
    case 'node_script':
      return `node ${check.path}`;
    case 'file_contains':
    case 'file_not_contains':
      return `${check.kind}:${check.path}`;
    case 'json_path_equals':
      return `${check.path}#${check.json_path}`;
    case 'path_exists':
      return `exists:${check.path}`;
    case 'answer_contains':
      return `answer:${check.patterns.join('|')}`;
    case 'workspace_unchanged':
      return 'workspace unchanged';
  }
}

async function runNodeScript(
  scriptPath: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(String(chunk)));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout: stdout.join(''), stderr: stderr.join('') });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: '', stderr: error.message });
    });
  });
}

async function readWorkspaceFile(
  workspace: string,
  relativePath: string,
): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(workspace, ...relativePath.split('/')), 'utf8');
  } catch {
    return undefined;
  }
}

function readJsonPath(value: unknown, jsonPath: string): unknown {
  let current: unknown = value;
  for (const segment of jsonPath.split('.')) {
    const record = asRecord(current);
    if (record === undefined) return undefined;
    current = record[segment];
  }
  return current;
}

// ── 工作区快照（直接复用生产口径） ──

async function snapshotWorkspace(workspace: string): Promise<Map<string, string>> {
  return new Map(await snapshotWorkspaceContent(workspace));
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [key, hash] of before) {
    if (after.get(key) !== hash) changed.add(key);
  }
  for (const key of after.keys()) {
    if (!before.has(key)) changed.add(key);
  }
  return [...changed].sort();
}

// ── 小工具 ────────────────────────────────────────────────────────

async function readJsonIfExists(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function readJsonArrayIfExists(filePath: string): Promise<unknown[] | undefined> {
  const value = await readJsonIfExists(filePath);
  return Array.isArray(value) ? value : undefined;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function excerpt(value: string | undefined, limit = 600): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 给不可信阶段（后端关闭 / 证据校验）加硬上限，避免单个 run 挂住整个任务集。 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `[fixed-tasks] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
