#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createProductionBackendService,
  loadRuntimeEnvDefaults,
  materializeRuntimeEnv,
  runBackendRpcMain,
} from '../app/backend-rpc-stdio';
import type { NewideBackendService } from '../app/newide-backend-service';
import type { RunSnapshot } from '../protocol/run-snapshot';
import type { CapabilityStatusV1 } from '../protocol/system-status';

const COUNCIL_CLI_CONTRACT = 'newide.eval.council.v1';

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

  writeUsage();
  return args.includes('--help') || args.includes('-h') ? 0 : 2;
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

    const env = materializeRuntimeEnv(
      withStateRoot(loadRuntimeEnvDefaults(process.env), options.state_root),
    );
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

    await waitForTerminal(service, created.run_id, options.timeout_ms);
    const snapshot = service.getRunSnapshot(created.run_id);
    process.stdout.write(
      `${JSON.stringify(
        buildCouncilCliResult(snapshot, options, councilCapability, readiness.service.status),
      )}\n`,
    );
    return snapshot.status === 'completed' ? 0 : 1;
  } catch (error) {
    const message = toMessage(error);
    if (service && runId) {
      const cancelError = await service.cancelRun(runId).catch((cancelFailure) => cancelFailure);
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
                code: isTimeoutError(message) ? 'COUNCIL_CLI_TIMEOUT' : 'COUNCIL_CLI_FAILED',
                message: cancellationMessage
                  ? `${message}; cancellation failed: ${cancellationMessage}`
                  : message,
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
    : (request?.timeout_ms ?? 900_000);
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
): Record<string, unknown> {
  const links = snapshot.links ?? {};
  const councilResult = snapshot.council?.result ?? {};
  return {
    contract_version: COUNCIL_CLI_CONTRACT,
    status: snapshot.status,
    quality: snapshot.council?.result?.quality ?? snapshot.quality?.status ?? null,
    run_id: snapshot.run_id,
    task_id: snapshot.task_id,
    workspace_path: options.workspace_path,
    state_root: options.state_root,
    service_status: serviceStatus,
    council_capability: capability,
    result_path: stringField(links, 'result_path'),
    frontend_snapshot_path: stringField(links, 'frontend_snapshot_path'),
    audit_path: stringField(links, 'audit_path'),
    council: {
      decision_id: snapshot.council?.decision_id ?? null,
      verdict: snapshot.council?.verdict ?? null,
      proposal_count: snapshot.council?.proposals?.length ?? 0,
      review_count: snapshot.council?.reviews?.length ?? 0,
      selected_artifact_refs: snapshot.council?.selected_artifact_refs ?? [],
      final_artifact_sha256: stringField(councilResult, 'final_artifact_sha256'),
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
  return message.startsWith('Council run timed out after ');
}

function writeUsage(): void {
  process.stderr.write(
    [
      'Usage:',
      '  newide serve --stdio [--state-root PATH]',
      '  newide council run --request FILE',
      '  newide council run --workspace ABS --prompt TEXT [--state-root PATH] [--allow-degraded]',
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
