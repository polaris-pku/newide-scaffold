import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, createId, nowTimestamp } from '../core';
import type { GateResult } from '../gate';
import {
  BestEffortGateExecutor,
  type GateExecutionInput,
  type GateExecutionResult,
  type IntegrationV0GateExecutor,
} from '../coordinator/gate-executor';
import { completionCriterionId } from '../coordinator/completion-criteria-evaluator';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 1_000_000;
const SECRET_KEY_PATTERN = /(key|token|secret|password|credential|auth)/i;

export interface ProductionGateCommand {
  executable: string;
  args: string[];
  timeout_ms: number;
  attest_completion_criteria: boolean;
}

export interface ProductionGateExecutorOptions {
  runsRoot: string;
  env?: NodeJS.ProcessEnv;
  command?: ProductionGateCommand;
}

export class ProductionGateExecutor implements IntegrationV0GateExecutor {
  private readonly env: NodeJS.ProcessEnv;
  private readonly command: ProductionGateCommand | undefined;
  private readonly fallback = new BestEffortGateExecutor();

  constructor(private readonly options: ProductionGateExecutorOptions) {
    this.env = options.env ?? process.env;
    this.command = options.command ?? readProductionGateCommand(this.env);
  }

  async execute(input: GateExecutionInput): Promise<GateExecutionResult> {
    if (!this.command) return this.fallback.execute(input);

    const startedAt = Date.now();
    const execution = await executeCommand({
      command: this.command,
      cwd: input.workspace_path,
      env: this.env,
    });
    const gateDir = path.join(this.options.runsRoot, input.run_id, 'gates');
    await fs.mkdir(gateDir, { recursive: true });
    const baseName = `${input.phase}-${createId('gate_attempt')}`;
    const stdoutPath = path.join(gateDir, `${baseName}.stdout.log`);
    const stderrPath = path.join(gateDir, `${baseName}.stderr.log`);
    const auditPath = path.join(gateDir, `${baseName}.json`);
    const redact = createRedactor(this.env);
    const safeStdout = redact(execution.stdout);
    const safeStderr = redact(execution.stderr);
    await fs.writeFile(stdoutPath, safeStdout, 'utf-8');
    await fs.writeFile(stderrPath, safeStderr, 'utf-8');
    await fs.writeFile(
      auditPath,
      JSON.stringify(
        {
          schema_version: SCHEMA_VERSION,
          run_id: input.run_id,
          task_id: input.task_id,
          phase: input.phase,
          command: {
            executable: redact(this.command.executable),
            args: this.command.args.map(redact),
          },
          cwd: input.workspace_path,
          exit_code: execution.exit_code,
          signal: execution.signal,
          timed_out: execution.timed_out,
          duration_ms: Date.now() - startedAt,
          stdout_ref: stdoutPath,
          stderr_ref: stderrPath,
          artifact_refs: [...input.artifact_refs],
          attested_completion_criteria: this.command.attest_completion_criteria
            ? [...input.completion_criteria]
            : [],
          created_at: nowTimestamp(),
        },
        null,
        2,
      ),
      'utf-8',
    );

    const decision = execution.exit_code === 0 && !execution.timed_out ? 'allow' : 'deny';
    const hookPoint =
      input.phase === 'post_council' ? 'council.completed' : 'task.completed';
    const subjects =
      this.command.attest_completion_criteria && input.completion_criteria.length > 0
        ? input.completion_criteria.map((criterion, index) => ({
            subject_id: completionCriterionId(criterion, index),
            subject_type: 'completion_criterion' as const,
          }))
        : [{ subject_id: input.task_id, subject_type: 'task' as const }];
    const gateResults: GateResult[] = subjects.map((subject) => ({
      gate_result_id: createId('gate_result'),
      gate_id: 'production-command',
      gate_point: hookPoint,
      request_id: createId('gate_request'),
      ...subject,
      decision,
      reason:
        decision === 'allow'
          ? 'Production Gate command completed successfully.'
          : execution.timed_out
            ? `Production Gate command timed out after ${String(this.command!.timeout_ms)}ms.`
            : `Production Gate command failed with exit code ${String(execution.exit_code)}.`,
      required_actions: decision === 'allow' ? [] : ['inspect-gate-audit'],
      audit_ref: auditPath,
      target_state: decision === 'allow' ? 'reviewing' : 'blocked',
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    }));
    return { hook_point: hookPoint, matched: true, gate_results: gateResults };
  }
}

export function readProductionGateCommand(
  env: NodeJS.ProcessEnv,
): ProductionGateCommand | undefined {
  const executable = env.NEWIDE_GATE_COMMAND?.trim();
  if (!executable) return undefined;
  const rawArgs = env.NEWIDE_GATE_ARGS_JSON?.trim();
  let args: string[] = [];
  if (rawArgs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs);
    } catch (error) {
      throw new Error('NEWIDE_GATE_ARGS_JSON must be a JSON string array', { cause: error });
    }
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
      throw new Error('NEWIDE_GATE_ARGS_JSON must be a JSON string array');
    }
    args = parsed;
  }
  const timeoutMs = readPositiveInteger(env.NEWIDE_GATE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  return {
    executable,
    args,
    timeout_ms: timeoutMs,
    attest_completion_criteria: env.NEWIDE_GATE_ATTESTS_COMPLETION_CRITERIA === '1',
  };
}

interface CommandExecution {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
}

async function executeCommand(input: {
  command: ProductionGateCommand;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<CommandExecution> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command.executable, input.command.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, input.command.timeout_ms);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ exit_code: code, signal, timed_out: timedOut, stdout, stderr });
    });
  });
}

function appendBounded(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) >= MAX_CAPTURE_BYTES) return current;
  const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current);
  return current + chunk.subarray(0, remaining).toString('utf-8');
}

function createRedactor(env: NodeJS.ProcessEnv): (value: string) => string {
  const secrets = Object.entries(env)
    .filter(
      ([key, value]) =>
        SECRET_KEY_PATTERN.test(key) && typeof value === 'string' && value.length >= 6,
    )
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
  return (value) =>
    secrets.reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), value);
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('NEWIDE_GATE_TIMEOUT_MS must be a positive integer');
  }
  return parsed;
}
