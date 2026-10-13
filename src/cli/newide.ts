#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createProductionBackendService,
  drainMemoryDeliveriesOnce,
  loadRuntimeEnvDefaults,
  materializeRuntimeEnv,
  runBackendRpcMain,
} from '../app/backend-rpc-stdio';
import {
  DRY_RUNNABLE_CHANNELS,
  type MemoryDeliveryChannel,
} from '../app/b-memory-delivery-consumers';
import type { NewideBackendService } from '../app/newide-backend-service';
import type { RunSnapshot } from '../protocol/run-snapshot';
import type { TaskSnapshot } from '../protocol/task-snapshot';
import type { CapabilityStatusV1 } from '../protocol/system-status';

const COUNCIL_CLI_CONTRACT = 'newide.eval.council.v1';
const MEMORY_DRAIN_CLI_CONTRACT = 'newide.memory.drain.v1';

interface CouncilRunRequest {
  prompt: string;
  workspace_path: string;
  state_root?: string;
  timeout_ms?: number;
  allow_degraded?: boolean;
}

interface CouncilRunOptions extends CouncilRunRequest {
  state_root: string;
  timeout_ms: number;
  allow_degraded: boolean;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args[0] === 'serve' && args[1] === '--stdio') {
    const stateRoot = readOptionalFlag(args.slice(2), '--state-root');
    await runBackendRpcMain(withStateRoot(loadRuntimeEnvDefaults(process.env), stateRoot));
    return 0;
  }

  if (args[0] === 'council' && args[1] === 'run') {
    return runCouncilCli(args.slice(2));
  }

  if (args[0] === 'memory' && args[1] === 'drain') {
    return runMemoryDrainCli(args.slice(2));
  }

  writeUsage();
  return args.includes('--help') || args.includes('-h') ? 0 : 2;
}

/**
 * `newide memory drain` —— 内存维护消费端的手动补跑口。
 *
 * 在本进程内直接调三条消费通道各一轮（与 boot 走的是同一套 worker），把在线登记、还没被
 * 定时器抽干的交付项与反馈消费掉。定时消费的周期缺省是一小时，而「刚跑完一个任务、想立刻
 * 看到经验入库」不该只能等——这就是这个子命令存在的唯一理由。
 *
 * 它**不新增任何 RPC 方法**：手动补跑是本机运维动作，不该成为协议面的一部分（计划 §14
 * 也只要一个「内部 service 方法或 CLI/测试入口」）。与正在运行的后端互斥——经验那条腿是
 * PGlite 单写者，后端开着时这里打不开库。
 */
async function runMemoryDrainCli(args: string[]): Promise<number> {
  // `--help` 必须在这里被拦住：不拦的话它会落到下面「按缺省跑一轮」上——一个问用法的人
  // 顺手把队列真消费掉了。这与 `--dry-run` 那条「不许静默跑真格」是同一条理由。
  if (args.includes('--help') || args.includes('-h')) {
    writeUsage();
    return 0;
  }
  try {
    const stateRoot = readOptionalFlag(args, '--state-root') ?? path.join(process.cwd(), '.newide');
    const roleId = readOptionalFlag(args, '--role');
    const dryRun = args.includes('--dry-run');
    const requested = parseChannelSelection(readRepeatedFlag(args, '--channel'));
    const channels = dryRun ? resolveDryRunChannels(requested) : requested;
    const batchSizeRaw = readOptionalFlag(args, '--batch-size');
    const batchSize = batchSizeRaw ? parsePositiveInteger(batchSizeRaw, '--batch-size') : undefined;

    const env = materializeRuntimeEnv({
      ...withStateRoot(loadRuntimeEnvDefaults(process.env), stateRoot),
    });
    const report = await drainMemoryDeliveriesOnce(env, {
      ...(roleId !== undefined ? { role_id: roleId } : {}),
      ...(channels !== undefined ? { channels } : {}),
      ...(batchSize !== undefined ? { batch_size: batchSize } : {}),
      ...(dryRun ? { dry_run: true } : {}),
    });
    process.stdout.write(
      `${JSON.stringify({ contract_version: MEMORY_DRAIN_CLI_CONTRACT, ...report }, null, 2)}\n`,
    );
    return Object.values(report.channels).some((channel) => channel.status === 'failed') ? 1 : 0;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        contract_version: MEMORY_DRAIN_CLI_CONTRACT,
        status: 'failed',
        error: { code: 'MEMORY_DRAIN_CLI_FAILED', message: toMessage(error) },
      })}\n`,
    );
    return 1;
  }
}

/**
 * 解析 `--channel` 的选择：接受通道全名、日常简写，以及 `all`。
 *
 * 简写存在的理由：`context` / `feedback` / `pending` / `promotion` / `evolution` 是运维嘴里说的
 * 名字，而 `context_delivery` / `driver_feedback` / `feedback_reconcile` / `skill_promotion` /
 * `persona_evolution` 是 run 记录里的 `job_type`。两个都收，避免「记得住名字才用得了」。
 * 非法值当场报错而不是静默忽略——打错一个通道名却以为跑过了，比跑不起来更贵。
 */
function parseChannelSelection(values: readonly string[]): MemoryDeliveryChannel[] | undefined {
  if (values.length === 0) return undefined;
  const aliases: Record<string, MemoryDeliveryChannel | undefined> = {
    context: 'context_delivery',
    context_delivery: 'context_delivery',
    feedback: 'driver_feedback',
    driver_feedback: 'driver_feedback',
    pending: 'feedback_reconcile',
    pending_feedback: 'feedback_reconcile',
    feedback_reconcile: 'feedback_reconcile',
    promotion: 'skill_promotion',
    skill: 'skill_promotion',
    skill_promotion: 'skill_promotion',
    evolution: 'persona_evolution',
    persona: 'persona_evolution',
    persona_evolution: 'persona_evolution',
  };
  const selected = new Set<MemoryDeliveryChannel>();
  for (const raw of values.flatMap((value) => value.split(','))) {
    const token = raw.trim();
    if (!token) continue;
    if (token === 'all') return undefined;
    const channel = aliases[token];
    if (!channel) {
      throw new Error(
        `Unknown --channel "${token}"; expected one of context, feedback, pending, promotion, evolution, all`,
      );
    }
    selected.add(channel);
  }
  return selected.size > 0 ? [...selected] : undefined;
}

/**
 * `--dry-run` 只对两条 job 通道成立（它们有「照常判定但不落地」这个模式）。
 *
 * 没指定 `--channel` 时默认跑那两条，并在 stderr 上说清这一次跑的是哪几条——**不能**默认成
 * 「五条一起演练」：另外三条没有演练模式，跑真格就等于把队列消费掉，而那正是想演练的人要避开的
 * 事。显式点名了不可演练的通道时交给库去拒绝（判据只有那一个地方），CLI 不替它过滤——静默丢掉
 * 一条通道的选择，比报错贵得多。
 */
function resolveDryRunChannels(
  requested: MemoryDeliveryChannel[] | undefined,
): MemoryDeliveryChannel[] | undefined {
  if (requested !== undefined) return requested;
  const channels: MemoryDeliveryChannel[] = [...DRY_RUNNABLE_CHANNELS];
  process.stderr.write(
    `[newide] --dry-run applies to ${channels.join(', ')}; running only those. Pass --channel to widen, but the outbox channels have no dry-run mode.\n`,
  );
  return channels;
}

/** 收集一个可重复出现的旗标的全部取值（`--channel a --channel b`）；缺省为空数组。 */
function readRepeatedFlag(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}

async function runCouncilCli(args: string[]): Promise<number> {
  let service: NewideBackendService | undefined;
  let runId: string | undefined;
  let options: CouncilRunOptions | undefined;
  let readiness: ReturnType<NewideBackendService['getSystemReadiness']> | undefined;
  let councilCapability: CapabilityStatusV1 | undefined;
  try {
    options = await parseCouncilRunOptions(args);
    await assertDirectory(options.workspace_path, 'workspace');
    await fs.mkdir(options.state_root, { recursive: true });

    const env = materializeRuntimeEnv({
      ...withStateRoot(loadRuntimeEnvDefaults(process.env), options.state_root),
    });
    service = await createProductionBackendService(env);
    readiness = service.getSystemReadiness();
    councilCapability = readiness.capabilities.find(
      (capability) => capability.capability_id === 'council.execute',
    );
    if (!councilCapability || councilCapability.status === 'unavailable') {
      throw new Error('council.execute is unavailable');
    }
    if (councilCapability.status === 'degraded' && !options.allow_degraded) {
      throw new Error(
        'council.execute is degraded; pass --allow-degraded to run and preserve this status in the result',
      );
    }

    const created = await service.createRun({
      prompt: options.prompt,
      workspace_path: options.workspace_path,
      mode: 'council',
    });
    runId = created.run_id;
    process.stderr.write(`[newide] Council run created: ${created.run_id}\n`);

    const task = await waitForTaskTerminal(service, created.task_id, options.timeout_ms);
    const terminalRunId = latestTerminalRunId(task);
    runId = terminalRunId;
    await waitForTerminal(service, terminalRunId, options.timeout_ms);
    const snapshot = service.getRunSnapshot(terminalRunId);
    process.stdout.write(
      `${JSON.stringify(
        buildCouncilCliResult(
          snapshot,
          options,
          councilCapability,
          readiness.service.status,
          undefined,
          task.task.status,
        ),
      )}\n`,
    );
    return task.task.status === 'completed' && snapshot.status === 'completed' ? 0 : 1;
  } catch (error) {
    const message = toMessage(error);
    if (service && runId) {
      const cancellationReason = {
        code: isTimeoutError(message) ? 'COUNCIL_CLI_TIMEOUT' : 'COUNCIL_CLI_FAILED',
        message,
      };
      const cancelError = await service
        .cancelRun(runId, cancellationReason)
        .catch((cancelFailure) => cancelFailure);
      const terminal = service.getRunSnapshot(runId);
      if (options && readiness && councilCapability && terminal) {
        const cancellationMessage =
          cancelError instanceof Error ? cancelError.message : undefined;
        process.stdout.write(
          `${JSON.stringify(
            buildCouncilCliResult(
              terminal,
              options,
              councilCapability,
              readiness.service.status,
              {
                code: cancellationReason.code,
                message: cancellationMessage
                  ? `${cancellationReason.message}; cancellation failed: ${cancellationMessage}`
                  : cancellationReason.message,
              },
            ),
          )}\n`,
        );
        return 1;
      }
    }
    process.stdout.write(
      `${JSON.stringify({
        contract_version: COUNCIL_CLI_CONTRACT,
        status: 'failed',
        error: {
          code: isTimeoutError(message) ? 'COUNCIL_CLI_TIMEOUT' : 'COUNCIL_CLI_FAILED',
          message,
        },
      })}\n`,
    );
    return 1;
  } finally {
    await service?.close().catch(() => undefined);
  }
}

async function parseCouncilRunOptions(args: string[]): Promise<CouncilRunOptions> {
  const requestPath = readOptionalFlag(args, '--request');
  const request = requestPath
    ? parseCouncilRequest(JSON.parse(await fs.readFile(path.resolve(requestPath), 'utf-8')))
    : undefined;
  const promptFile = readOptionalFlag(args, '--prompt-file');
  const prompt =
    readOptionalFlag(args, '--prompt') ??
    (promptFile ? await fs.readFile(path.resolve(promptFile), 'utf-8') : undefined) ??
    request?.prompt;
  const workspacePath =
    readOptionalFlag(args, '--workspace') ?? request?.workspace_path;
  const stateRoot =
    readOptionalFlag(args, '--state-root') ??
    request?.state_root ??
    path.join(process.cwd(), '.newide');
  const timeoutRaw = readOptionalFlag(args, '--timeout-ms');
  const timeoutMs = timeoutRaw
    ? parsePositiveInteger(timeoutRaw, '--timeout-ms')
    : (request?.timeout_ms ?? 1_800_000);
  const allowDegraded = args.includes('--allow-degraded') || request?.allow_degraded === true;

  if (!prompt?.trim()) throw new Error('Council prompt is required');
  if (!workspacePath || !path.isAbsolute(workspacePath)) {
    throw new Error('--workspace must be an absolute path');
  }
  return {
    prompt: prompt.trim(),
    workspace_path: path.resolve(workspacePath),
    state_root: path.resolve(stateRoot),
    timeout_ms: timeoutMs,
    allow_degraded: allowDegraded,
  };
}

function parseCouncilRequest(value: unknown): CouncilRunRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Council request must be a JSON object');
  }
  const request = value as Record<string, unknown>;
  const allowed = new Set([
    'prompt',
    'workspace_path',
    'state_root',
    'timeout_ms',
    'allow_degraded',
  ]);
  const unknown = Object.keys(request).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown Council request fields: ${unknown.join(', ')}`);
  if (typeof request.prompt !== 'string' || !request.prompt.trim()) {
    throw new Error('Council request prompt is required');
  }
  if (typeof request.workspace_path !== 'string' || !path.isAbsolute(request.workspace_path)) {
    throw new Error('Council request workspace_path must be absolute');
  }
  if (request.state_root !== undefined && typeof request.state_root !== 'string') {
    throw new Error('Council request state_root must be a string');
  }
  if (
    request.timeout_ms !== undefined &&
    (!Number.isInteger(request.timeout_ms) || Number(request.timeout_ms) <= 0)
  ) {
    throw new Error('Council request timeout_ms must be a positive integer');
  }
  if (request.allow_degraded !== undefined && typeof request.allow_degraded !== 'boolean') {
    throw new Error('Council request allow_degraded must be a boolean');
  }
  return {
    prompt: request.prompt.trim(),
    workspace_path: request.workspace_path,
    ...(typeof request.state_root === 'string' ? { state_root: request.state_root } : {}),
    ...(typeof request.timeout_ms === 'number' ? { timeout_ms: request.timeout_ms } : {}),
    ...(typeof request.allow_degraded === 'boolean'
      ? { allow_degraded: request.allow_degraded }
      : {}),
  };
}

function buildCouncilCliResult(
  snapshot: RunSnapshot,
  options: CouncilRunOptions,
  capability: CapabilityStatusV1,
  serviceStatus: string,
  cliError?: { code: string; message: string },
  taskStatus?: string,
): Record<string, unknown> {
  const links = snapshot.links ?? {};
  const councilResult = snapshot.council?.result ?? {};
  return {
    contract_version: COUNCIL_CLI_CONTRACT,
    status: taskStatus ?? snapshot.status,
    quality: snapshot.council?.result?.quality ?? snapshot.quality?.status ?? null,
    run_id: snapshot.run_id,
    task_id: snapshot.task_id,
    workspace_path: options.workspace_path,
    state_root: options.state_root,
    service_status: serviceStatus,
    council_capability: capability,
    result_path: stringField(links, 'result_path'),
    summary_path: stringField(links, 'summary_path'),
    frontend_snapshot_path: stringField(links, 'frontend_snapshot_path'),
    audit_path: stringField(links, 'audit_path'),
    council: {
      decision_id: snapshot.council?.decision_id ?? null,
      verdict: snapshot.council?.verdict ?? null,
      proposal_count: snapshot.council?.proposals?.length ?? 0,
      review_count: snapshot.council?.reviews?.length ?? 0,
      selected_artifact_refs: snapshot.council?.selected_artifact_refs ?? [],
      final_artifact_sha256: stringField(councilResult, 'final_artifact_sha256'),
      role_failure_count: councilResult.role_failure_count ?? 0,
      fallback_used: councilResult.fallback_used ?? false,
      warnings: councilResult.warnings ?? [],
      unmet_criteria: councilResult.unmet_criteria ?? [],
    },
    errors: snapshot.errors,
    ...(cliError ? { error: cliError } : {}),
  };
}

async function waitForTerminal(
  service: NewideBackendService,
  runId: string,
  timeoutMs: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      service.waitForTerminal(runId),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Council run timed out after ${String(timeoutMs)}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForTaskTerminal(
  service: NewideBackendService,
  taskId: string,
  timeoutMs: number,
): Promise<TaskSnapshot> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      service.waitForTaskTerminal(taskId),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Council task timed out after ${String(timeoutMs)}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function latestTerminalRunId(task: TaskSnapshot): string {
  const latest = task.run_history[0];
  if (!latest) throw new Error(`Task ${task.task.task_id} has no terminal Run`);
  return latest.run_id;
}

function withStateRoot(env: NodeJS.ProcessEnv, stateRoot?: string): NodeJS.ProcessEnv {
  return stateRoot ? { ...env, NEWIDE_STATE_ROOT: path.resolve(stateRoot) } : env;
}

async function assertDirectory(directory: string, label: string): Promise<void> {
  const stat = await fs.stat(directory).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`${label} directory not found: ${directory}`);
}

function readOptionalFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  return typeof record[field] === 'string' ? record[field] : null;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTimeoutError(message: string): boolean {
  return (
    message.startsWith('Council run timed out after ') ||
    message.startsWith('Council task timed out after ')
  );
}

function writeUsage(): void {
  process.stderr.write(
    [
      'Usage:',
      '  newide serve --stdio [--state-root PATH]',
      '  newide council run --request FILE',
      '  newide council run --workspace ABS --prompt TEXT [--state-root PATH] [--allow-degraded]',
      '  newide memory drain [--state-root PATH] [--role ROLE] [--channel NAME] [--batch-size N] [--dry-run]',
      '',
      'newide memory drain runs the memory-maintenance offline half once: consuming the two',
      'outboxes (context deliveries, driver feedback, pending feedback) and then the two jobs',
      'that scan derived candidates (skill promotion, persona evolution). --channel accepts',
      'context | feedback | pending | promotion | evolution | all and may be repeated or',
      'comma-separated.',
      '',
      '--dry-run only applies to the two job channels: it screens and judges candidates without',
      'claiming, writing a Skill or bumping a Persona version. With no --channel it runs those',
      'two alone (the outbox channels have no dry-run mode); naming one of them alongside',
      '--dry-run is an error rather than a silent real run.',
      '',
      'It needs the backend to be stopped (the experience store is single-writer).',
      '',
    ].join('\n'),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${toMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
}
