/**
 * 阶段 5 固定任务集 A/B 汇总报告生成器。
 *
 * 职责与核心逻辑：
 * - 只读 `.newide/phase5/fixed-tasks/results/**` 下 harness 产出的逐 run 结果 JSON，
 *   生成新旧路径对比表（summary.md）与机器可读汇总（summary.json）。
 * - 失败/退化/成本异常逐项列出；missing 信号不填 0（沿用仓库报告约定）。
 * - Driver 能力矩阵只根据**实际观察到的证据**下结论：命令级 `driver.command_observed`、
 *   Session 复用（同 session_id 跨派工）、超时/取消终止码。没有证据就写「未验证」，
 *   不从源码或他人结论推断。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface CheckResult {
  kind: string;
  label: string;
  passed: boolean;
  detail?: string;
}

interface ResultRecord {
  task_id: string;
  task_kind: string;
  goal: string;
  path: 'new' | 'legacy';
  run: {
    run_id?: string;
    status?: string;
    duration_ms?: number;
    termination?: { code?: string; message?: string; source?: string };
    errors?: unknown[];
    response_excerpt?: string;
  };
  role: {
    engine: string;
    rounds?: number;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    journal_round_total_tokens?: number;
    llm_calls?: number;
    missing: string[];
  };
  driver: {
    billed?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; call_count?: number };
    merge_status?: string;
    sessions?: string[];
    dispatches_observed?: number;
    journal_evidence_usage_sum?: { input_tokens: number; output_tokens: number; observations: number };
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
    journal?: string;
    driver_stream?: string;
    driver_usage?: string;
    missing: string[];
  };
  completion: { all_passed: boolean; checks: CheckResult[] };
  expected_evidence_gap?: { paths: string[]; reason: string };
  failure_reason?: string;
  notes: string[];
  config: Record<string, unknown>;
}

interface CapabilityFacts {
  runs_with_driver_stream: number;
  command_observed_events: number;
  runs_with_command_observed: number;
  session_reuse_runs: string[];
  timeout_terminations: string[];
  cancel_terminations: string[];
  session_counts: Array<{ task: string; path: string; dispatches: number; sessions: number }>;
  /** 独立能力探针（driver-capability-probe.ts）的实测结论；缺探针 = 未验证。 */
  probes: {
    cancel?: Record<string, unknown>;
    timeout?: Record<string, unknown>;
    session_reuse?: Record<string, unknown>;
  };
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const outRoot = path.resolve(
    readFlag(process.argv.slice(2), '--out') ?? path.join(repoRoot, '.newide', 'phase5', 'fixed-tasks'),
  );
  const resultsDir = path.join(outRoot, 'results');
  const records = await readAllResults(resultsDir);
  if (records.length === 0) throw new Error(`no result JSON under ${resultsDir}`);
  const tasks = [...new Set(records.map((record) => record.task_id))].sort();
  const byKey = new Map<string, ResultRecord>();
  for (const record of records) byKey.set(`${record.task_id}/${record.path}`, record);
  const capability = await collectCapabilityFacts(outRoot, records);
  const summary = buildSummary(tasks, byKey, capability, outRoot);
  await fs.writeFile(path.join(outRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outRoot, 'summary.md'), renderMarkdown(summary), 'utf8');
  process.stdout.write(`[fixed-tasks-report] wrote ${path.join(outRoot, 'summary.json')}\n`);
  process.stdout.write(`[fixed-tasks-report] wrote ${path.join(outRoot, 'summary.md')}\n`);
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function readAllResults(resultsDir: string): Promise<ResultRecord[]> {
  const records: ResultRecord[] = [];
  let taskDirs: string[];
  try {
    taskDirs = await fs.readdir(resultsDir);
  } catch {
    return records;
  }
  for (const taskDir of taskDirs) {
    const full = path.join(resultsDir, taskDir);
    let files: string[];
    try {
      files = (await fs.readdir(full)).filter((file) => file.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(full, file), 'utf8')) as ResultRecord;
        records.push(raw);
      } catch {
        // 坏结果文件跳过，报告里由「缺失」体现。
      }
    }
  }
  return records.sort((left, right) =>
    `${left.task_id}/${left.path}`.localeCompare(`${right.task_id}/${right.path}`),
  );
}

interface Summary {
  generated_at: string;
  out_root: string;
  environment: Record<string, unknown>;
  counts: Record<string, number>;
  tasks: Array<{
    task_id: string;
    kind: string;
    goal: string;
    expected_evidence_gap: boolean;
    new?: TaskSide;
    legacy?: TaskSide;
    checks_pass: { new?: boolean; legacy?: boolean };
    completion_status: { new?: string; legacy?: string };
  }>;
  failures: Array<{ task_id: string; path: string; status?: string; reason?: string }>;
  cost: {
    role_tokens: { new?: number; legacy?: number; ratio?: number; runs_missing: string[] };
    driver_billed_tokens: { new?: number; legacy?: number; ratio?: number; runs_missing: string[] };
    duration_ms: { new?: number; legacy?: number; ratio?: number };
    per_task_ratio: Array<{ task_id: string; role_token_ratio?: number }>;
  };
  missing_signals: Array<{ task_id: string; path: string; signals: string[] }>;
  capability: CapabilityFacts;
}

interface TaskSide {
  status?: string;
  termination_code?: string;
  duration_ms?: number;
  dispatch_total?: number;
  dispatch_by_status?: Record<string, number>;
  role_rounds?: number;
  role_total_tokens?: number;
  role_input_tokens?: number;
  role_output_tokens?: number;
  driver_billed_total_tokens?: number;
  driver_merge_status?: string;
  checks_passed: number;
  checks_total: number;
  all_checks_passed: boolean;
  evidence_run_dir?: string;
  evidence_journal?: string;
  missing: string[];
  failure_reason?: string;
}

function buildSummary(
  tasks: string[],
  byKey: Map<string, ResultRecord>,
  capability: CapabilityFacts,
  outRoot: string,
): Summary {
  const roleTokens: Record<'new' | 'legacy', number> = { new: 0, legacy: 0 };
  const driverTokens: Record<'new' | 'legacy', number> = { new: 0, legacy: 0 };
  const durations: Record<'new' | 'legacy', number> = { new: 0, legacy: 0 };
  const roleMissing: string[] = [];
  const driverMissing: string[] = [];
  const failures: Summary['failures'] = [];
  const missingSignals: Summary['missing_signals'] = [];
  const perTaskRatio: Summary['cost']['per_task_ratio'] = [];
  const taskRows: Summary['tasks'] = [];
  const completed = { new: 0, legacy: 0 };
  const checksAllPassed = { new: 0, legacy: 0 };
  const runCounts = { new: 0, legacy: 0 };

  for (const taskId of tasks) {
    const newRecord = byKey.get(`${taskId}/new`);
    const legacyRecord = byKey.get(`${taskId}/legacy`);
    const first = newRecord ?? legacyRecord!;
    const row: Summary['tasks'][number] = {
      task_id: taskId,
      kind: first.task_kind,
      goal: first.goal,
      expected_evidence_gap: first.expected_evidence_gap !== undefined,
      checks_pass: {},
      completion_status: {},
    };
    for (const [pathName, record] of [
      ['new', newRecord],
      ['legacy', legacyRecord],
    ] as const) {
      if (!record) continue;
      const side = toTaskSide(record);
      row[pathName] = side;
      runCounts[pathName] += 1;
      row.checks_pass[pathName] = side.all_checks_passed;
      row.completion_status[pathName] = side.status;
      if (side.status === 'completed') completed[pathName] += 1;
      if (side.all_checks_passed) checksAllPassed[pathName] += 1;
      if (side.role_total_tokens !== undefined) roleTokens[pathName] += side.role_total_tokens;
      else roleMissing.push(`${taskId}/${pathName}`);
      if (side.driver_billed_total_tokens !== undefined) {
        driverTokens[pathName] += side.driver_billed_total_tokens;
      } else {
        driverMissing.push(`${taskId}/${pathName}`);
      }
      if (side.duration_ms !== undefined) durations[pathName] += side.duration_ms;
      const missing = [
        ...new Set([
          ...record.role.missing,
          ...record.driver.missing,
          ...record.dispatch.missing,
          ...record.evidence.missing,
        ]),
      ];
      if (missing.length > 0) missingSignals.push({ task_id: taskId, path: pathName, signals: missing });
      if (record.run.status !== 'completed' || !side.all_checks_passed) {
        failures.push({
          task_id: taskId,
          path: pathName,
          status: record.run.status,
          reason: record.failure_reason ?? record.run.termination?.message,
        });
      }
    }
    if (row.new?.role_total_tokens !== undefined && row.legacy?.role_total_tokens !== undefined) {
      perTaskRatio.push({
        task_id: taskId,
        role_token_ratio:
          row.legacy.role_total_tokens > 0
            ? round2(row.new.role_total_tokens / row.legacy.role_total_tokens)
            : undefined,
      });
    }
    taskRows.push(row);
  }

  const environment: Record<string, unknown> = {
    node_version: process.version,
    repo_pinned_node: '22.22.1 (.nvmrc) — 本机 PATH 为 Node 24，属环境差异',
    real_driver: '外部 ACP runner (.newide/phase5/driver-runner, claude-agent-acp 适配器)',
    real_provider:
      '真实 provider 经本地 CC Switch 代理 (127.0.0.1:15721)，实际映射 deepseek-v4.1-flash；不是 Anthropic 模型',
    role_llm: '.env.local DeepSeek（LLM_PROVIDER=deepseek, DEEPSEEK_MODEL=deepseek-v4-flash）',
    gate_command: '空（BestEffortGateExecutor 放行，manifest/物化照跑）',
    b_storage:
      '每 run 独立 NEWIDE_B_PGLITE_DATA_DIR + NEWIDE_B_APP_STATE_ROOT（PGlite，非 :memory:）',
    claude_config_dir: '每 run 独立 CLAUDE_CONFIG_DIR；workspace 内 .claude 为指向 run 目录的 junction（快照不跟随）',
  };

  return {
    generated_at: new Date().toISOString(),
    out_root: outRoot,
    environment,
    counts: {
      tasks: tasks.length,
      runs_new: runCounts.new,
      runs_legacy: runCounts.legacy,
      runs: runCounts.new + runCounts.legacy,
      completed_new: completed.new,
      completed_legacy: completed.legacy,
      checks_all_passed_new: checksAllPassed.new,
      checks_all_passed_legacy: checksAllPassed.legacy,
      expected_evidence_gap_tasks: taskRows.filter((row) => row.expected_evidence_gap).length,
    },
    tasks: taskRows,
    failures,
    cost: {
      role_tokens: {
        new: roleTokens.new,
        legacy: roleTokens.legacy,
        ratio: roleTokens.legacy > 0 ? round2(roleTokens.new / roleTokens.legacy) : undefined,
        runs_missing: roleMissing,
      },
      driver_billed_tokens: {
        new: driverTokens.new,
        legacy: driverTokens.legacy,
        ratio: driverTokens.legacy > 0 ? round2(driverTokens.new / driverTokens.legacy) : undefined,
        runs_missing: driverMissing,
      },
      duration_ms: {
        new: durations.new,
        legacy: durations.legacy,
        ratio: durations.legacy > 0 ? round2(durations.new / durations.legacy) : undefined,
      },
      per_task_ratio: perTaskRatio,
    },
    missing_signals: missingSignals,
    capability,
  };
}

function toTaskSide(record: ResultRecord): TaskSide {
  const checks = record.completion?.checks ?? [];
  return {
    status: record.run.status,
    termination_code: record.run.termination?.code,
    duration_ms: record.run.duration_ms,
    dispatch_total: record.dispatch.total,
    dispatch_by_status: record.dispatch.by_status,
    role_rounds: record.role.rounds ?? record.dispatch.role_rounds,
    role_total_tokens: record.role.total_tokens,
    role_input_tokens: record.role.input_tokens,
    role_output_tokens: record.role.output_tokens,
    driver_billed_total_tokens: record.driver.billed?.total_tokens,
    driver_merge_status: record.driver.merge_status,
    checks_passed: checks.filter((check) => check.passed).length,
    checks_total: checks.length,
    all_checks_passed: checks.length > 0 && checks.every((check) => check.passed),
    evidence_run_dir: record.evidence.run_dir,
    evidence_journal: record.evidence.journal,
    missing: [...record.role.missing, ...record.driver.missing, ...record.dispatch.missing, ...record.evidence.missing],
    failure_reason: record.failure_reason,
  };
}

async function readCapabilityProbes(
  outRoot: string,
): Promise<CapabilityFacts['probes']> {
  const probes: CapabilityFacts['probes'] = {};
  const directory = path.join(outRoot, 'capability');
  const read = async (name: string): Promise<Record<string, unknown> | undefined> => {
    try {
      return JSON.parse(
        await fs.readFile(path.join(directory, name, 'result.json'), 'utf8'),
      ) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };
  const cancel = await read('cancel');
  if (cancel) {
    const capability = asRecord(cancel.capability);
    probes.cancel = {
      ...asRecord(capability?.cancel),
      evidence: path.join(directory, 'cancel', 'result.json'),
    };
  }
  const timeout = await read('timeout');
  if (timeout) {
    const capability = asRecord(timeout.capability);
    probes.timeout = {
      ...asRecord(capability?.timeout),
      evidence: path.join(directory, 'timeout', 'result.json'),
    };
  }
  const sessionReuse = await read('session-reuse');
  if (sessionReuse) {
    const capability = asRecord(sessionReuse.capability);
    probes.session_reuse = {
      ...asRecord(capability?.session_reuse),
      evidence: path.join(directory, 'session-reuse', 'result.json'),
    };
  }
  return probes;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function collectCapabilityFacts(
  outRoot: string,
  records: ResultRecord[],
): Promise<CapabilityFacts> {
  const facts: CapabilityFacts = {
    runs_with_driver_stream: 0,
    command_observed_events: 0,
    runs_with_command_observed: 0,
    session_reuse_runs: [],
    timeout_terminations: [],
    cancel_terminations: [],
    session_counts: [],
    probes: await readCapabilityProbes(outRoot),
  };
  for (const record of records) {
    const runDir = record.evidence.run_dir;
    if (!runDir) continue;
    const streamPath = path.join(runDir, 'driver-stream.jsonl');
    let stream = '';
    try {
      stream = await fs.readFile(streamPath, 'utf8');
    } catch {
      stream = '';
    }
    if (stream.length > 0) {
      facts.runs_with_driver_stream += 1;
      const count = (stream.match(/"event_type":"driver\.command_observed"/g) ?? []).length;
      facts.command_observed_events += count;
      if (count > 0) facts.runs_with_command_observed += 1;
    }
    const journalPath = path.join(runDir, 'journal', 'dispatches.jsonl');
    let journal = '';
    try {
      journal = await fs.readFile(journalPath, 'utf8');
    } catch {
      journal = '';
    }
    if (journal.length > 0) {
      const sessions = new Set<string>();
      let dispatches = 0;
      for (const line of journal.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          // 派工事实：dispatched 行是派工开始，settled 行携带该派工的 driver session id。
          // session 复用判据用「不同 session 数 < 派工数」。
          if (entry.event === 'dispatched') dispatches += 1;
          const evidence = entry.evidence as Record<string, unknown> | undefined;
          const sessionId =
            typeof entry.session_id === 'string' && entry.session_id.length > 0
              ? entry.session_id
              : typeof evidence?.session_id === 'string' && evidence.session_id.length > 0
                ? evidence.session_id
                : undefined;
          if (sessionId !== undefined) sessions.add(sessionId);
        } catch {
          // ignore
        }
      }
      if (dispatches > 1 && sessions.size > 0 && sessions.size < dispatches) {
        facts.session_reuse_runs.push(`${record.task_id}/${record.path}`);
      }
      facts.session_counts.push({
        task: record.task_id,
        path: record.path,
        dispatches,
        sessions: sessions.size,
      });
    }
    const code = record.run.termination?.code;
    if (code === 'inactivity_timeout' || code === 'budget_wall_clock' || code === 'host_timeout') {
      facts.timeout_terminations.push(`${record.task_id}/${record.path}:${code}`);
    }
    if (code === 'host_cancelled' || record.run.status === 'cancelled') {
      facts.cancel_terminations.push(`${record.task_id}/${record.path}:${code ?? 'cancelled'}`);
    }
  }
  return facts;
}

function renderMarkdown(summary: Summary): string {
  const lines: string[] = [];
  lines.push('# 阶段 5：固定任务集新旧路径 A/B 对照汇总');
  lines.push('');
  lines.push(`生成时间：${summary.generated_at}`);
  lines.push(`结果根目录：\`${summary.out_root}\``);
  lines.push('');
  lines.push('## 环境口径');
  lines.push('');
  for (const [key, value] of Object.entries(summary.environment)) {
    lines.push(`- **${key}**：${String(value)}`);
  }
  lines.push('');
  lines.push('## 总览');
  lines.push('');
  lines.push('| 指标 | 旧路径 (legacy) | 新路径 (new) |');
  lines.push('| --- | --- | --- |');
  lines.push(
    `| 任务数 | ${summary.counts.tasks} | ${summary.counts.tasks} |\n` +
      `| run 数 | ${summary.counts.runs_legacy} | ${summary.counts.runs_new} |\n` +
      `| 终态 completed | ${summary.counts.completed_legacy} | ${summary.counts.completed_new} |\n` +
      `| 确定性完成标准全过 | ${summary.counts.checks_all_passed_legacy} | ${summary.counts.checks_all_passed_new} |`,
  );
  lines.push('');
  lines.push('## 逐任务对比');
  lines.push('');
  lines.push(
    '| 任务 | 类别 | 旧路径终态 | 新路径终态 | 旧派工/轮次 | 新派工/轮次 | 旧 role token | 新 role token | 旧 driver billed | 新 driver billed | 旧耗时(s) | 新耗时(s) | 旧校验 | 新校验 |',
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const task of summary.tasks) {
    const legacy = task.legacy;
    const fresh = task.new;
    lines.push(
      `| ${task.task_id}${task.expected_evidence_gap ? ' ⚠️' : ''} | ${task.kind} | ${
        legacy?.status ?? '缺失'
      } | ${fresh?.status ?? '缺失'} | ${fmtPair(legacy?.dispatch_total, legacy?.role_rounds)} | ${fmtPair(
        fresh?.dispatch_total,
        fresh?.role_rounds,
      )} | ${fmtNum(legacy?.role_total_tokens)} | ${fmtNum(fresh?.role_total_tokens)} | ${fmtNum(
        legacy?.driver_billed_total_tokens,
      )} | ${fmtNum(fresh?.driver_billed_total_tokens)} | ${fmtSec(legacy?.duration_ms)} | ${fmtSec(
        fresh?.duration_ms,
      )} | ${fmtChecks(legacy)} | ${fmtChecks(fresh)} |`,
    );
  }
  lines.push('');
  lines.push('## 成本与耗时');
  lines.push('');
  lines.push('| 口径 | 旧路径 | 新路径 | 新/旧 | 缺失 run |');
  lines.push('| --- | --- | --- | --- | --- |');
  lines.push(
    `| role LLM tokens | ${summary.cost.role_tokens.legacy ?? 'missing'} | ${
      summary.cost.role_tokens.new ?? 'missing'
    } | ${summary.cost.role_tokens.ratio ?? 'n/a'} | ${summary.cost.role_tokens.runs_missing.join(', ') || '无'} |`,
  );
  lines.push(
    `| driver billed tokens | ${summary.cost.driver_billed_tokens.legacy ?? 'missing'} | ${
      summary.cost.driver_billed_tokens.new ?? 'missing'
    } | ${summary.cost.driver_billed_tokens.ratio ?? 'n/a'} | ${
      summary.cost.driver_billed_tokens.runs_missing.join(', ') || '无'
    } |`,
  );
  lines.push(
    `| 总耗时 (ms) | ${summary.cost.duration_ms.legacy ?? 'missing'} | ${
      summary.cost.duration_ms.new ?? 'missing'
    } | ${summary.cost.duration_ms.ratio ?? 'n/a'} | - |`,
  );
  lines.push('');
  lines.push('> token 口径：role 取 `summary.consumption.by_stage.execute_agent`（role/agent 循环的 scaffold LLM）；');
  lines.push('> driver 取 `summary.driver_billed_usage`（Claude session JSONL 刮取的真实计费 token）。');
  lines.push('> `missing` 不填 0：merge_status 非 merged 时该 run 的 driver token 记为缺失。');
  lines.push('');
  lines.push('## 失败与退化');
  lines.push('');
  if (summary.failures.length === 0) lines.push('无。');
  for (const failure of summary.failures) {
    lines.push(`- \`${failure.task_id}/${failure.path}\` 终态=${failure.status ?? '?'}：${failure.reason ?? '(无原因)'}`);
  }
  lines.push('');
  lines.push('## 证据缺失信号（不填 0）');
  lines.push('');
  if (summary.missing_signals.length === 0) lines.push('无。');
  for (const item of summary.missing_signals) {
    lines.push(`- \`${item.task_id}/${item.path}\`：${item.signals.join(', ')}`);
  }
  lines.push('');
  lines.push('## Driver 能力矩阵（只写实际验证过的）');
  lines.push('');
  lines.push('| 能力 | 结论 | 证据 |');
  lines.push('| --- | --- | --- |');
  lines.push(
    `| 真实 Driver 执行并返回 DriverRunResult | 已验证 | ${summary.capability.runs_with_driver_stream} 个 run 有 driver-stream 事件 |`,
  );
  lines.push(
    `| 命令级 host_observed 证据（driver.command_observed） | ${
      summary.capability.command_observed_events > 0 ? '已观察到' : '未观察到（当前真实 runner 不产生该事件）'
    } | command_observed 事件数=${summary.capability.command_observed_events}，出现在 ${summary.capability.runs_with_command_observed} 个 run |`,
  );
  const freshPattern = summary.capability.session_counts
    .filter((entry) => entry.path === 'new' && entry.dispatches > 1)
    .map((entry) => `${entry.task}: ${entry.dispatches} 派工/${entry.sessions} session`);
  const probeCancel = summary.capability.probes.cancel;
  const probeTimeout = summary.capability.probes.timeout;
  const probeSession = summary.capability.probes.session_reuse;
  lines.push(
    `| Session 复用（同 session_id 跨 Run） | ${
      probeSession?.verified === true
        ? '已验证（旧路径显式 session_id 原生续做成功）'
        : summary.capability.session_reuse_runs.length > 0
          ? '已观察到'
          : '未观察到（新路径每次派工都是 fresh session）'
    } | ${
      probeSession !== undefined
        ? `探针：requested=${String(probeSession.requested_session_id ?? '?')} observed=${String(
            probeSession.observed_session_id ?? '?',
          )} second_status=${String(probeSession.second_run_status ?? probeSession.second_status ?? '?')}；${String(probeSession.evidence)}`
        : summary.capability.session_reuse_runs.join(', ') || freshPattern.join('; ') || '无复用证据'
    } |`,
  );
  lines.push(
    `| 超时语义 | ${
      probeTimeout?.verified === true
        ? '已验证（宿主派工超时 → settled=unknown，未伪造成功）'
        : summary.capability.timeout_terminations.length > 0
          ? '已观察到'
          : '未在本任务集触发'
    } | ${
      probeTimeout !== undefined
        ? `探针：status=${String(probeTimeout.observed_status ?? '?')} termination=${String(
            probeTimeout.termination_code ?? '?',
          )} dispatch_status=${JSON.stringify(probeTimeout.dispatch_status ?? {})}；${String(
            probeTimeout.evidence,
          )}`
        : summary.capability.timeout_terminations.join(', ') || '无'
    } |`,
  );
  lines.push(
    `| 取消语义 | ${
      probeCancel?.verified === true ? '已验证（run.cancel → cancelled，在飞派工无 settled）' : '未验证'
    } | ${
      probeCancel !== undefined
        ? `探针：status=${String(probeCancel.observed_status ?? '?')}；${String(probeCancel.evidence)}`
        : summary.capability.cancel_terminations.join(', ') || '无'
    } |`,
  );
  lines.push('');
  lines.push('## 逐 run 证据路径');
  lines.push('');
  for (const task of summary.tasks) {
    for (const [pathName, side] of [
      ['legacy', task.legacy],
      ['new', task.new],
    ] as const) {
      if (!side) continue;
      lines.push(
        `- \`${task.task_id}/${pathName}\`：run 目录 \`${side.evidence_run_dir ?? 'missing'}\`；journal \`${
          side.evidence_journal ?? 'missing（legacy 无 Journal 属正常）'
        }\``,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

function fmtNum(value: number | undefined): string {
  return value === undefined ? 'missing' : String(value);
}

function fmtSec(value: number | undefined): string {
  return value === undefined ? 'missing' : (value / 1000).toFixed(1);
}

function fmtPair(first: number | undefined, second: number | undefined): string {
  return `${first ?? 'missing'}/${second ?? 'missing'}`;
}

function fmtChecks(side: TaskSide | undefined): string {
  if (!side) return 'missing';
  return `${side.checks_passed}/${side.checks_total}${side.all_checks_passed ? ' ✅' : ''}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `[fixed-tasks-report] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});

