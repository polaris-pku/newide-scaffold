/**
 * Run 请求持久化与历史扫描。
 *
 * 这个文件负责 `.newide/runs/<run_id>/request.json` 的写入、读取，
 * 以及从 `.newide/runs/*` 恢复历史 run 列表。
 * 它不启动 Coordinator，不修改既有终态产物，也不伪造 run 状态。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  SCHEMA_VERSION,
  type SchemaVersion,
  type TaskCreateRequest,
  type Timestamp,
} from '../core';
import type { AppRunMode } from './run-registry';
import { runSnapshotSchema, type RunSnapshot } from '../protocol/run-snapshot';

export interface PersistedRunRequest {
  schema_version: SchemaVersion;
  run_id: string;
  task_id: string;
  prompt: string;
  workspace_path: string;
  session_id?: string;
  task_request?: TaskCreateRequest;
  mode: AppRunMode;
  project_id?: string;
  client_task_id?: string;
  title?: string;
  restarted_from_run_id?: string;
  created_at: Timestamp;
}

export type HistoricalRunStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface RunHistoryEntry {
  run_id: string;
  status: HistoricalRunStatus;
  restartable: boolean;
  task_id?: string;
  mode?: AppRunMode;
  prompt?: string;
  workspace_path?: string;
  session_id?: string;
  task_request?: TaskCreateRequest;
  restarted_from_run_id?: string;
  created_at?: Timestamp;
  error?: { code: string; message: string };
}

export class RunRequestNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} has no persisted request.json`);
    this.name = 'RunRequestNotFoundError';
  }
}

export interface RunRequestStore {
  save(request: Omit<PersistedRunRequest, 'schema_version' | 'created_at'>): Promise<void>;
  load(runId: string): Promise<PersistedRunRequest>;
  listHistory(): Promise<RunHistoryEntry[]>;
  readTerminalSessionId(runId: string): Promise<string | undefined>;
  loadRunSnapshot(runId: string): Promise<RunSnapshot | undefined>;
}

export class FileRunRequestStore implements RunRequestStore {
  constructor(
    private readonly runsRoot = '.newide/runs',
    private readonly now: () => Timestamp = () => new Date().toISOString(),
  ) {}

  async save(request: Omit<PersistedRunRequest, 'schema_version' | 'created_at'>): Promise<void> {
    const runDir = path.join(this.runsRoot, request.run_id);
    await fs.mkdir(runDir, { recursive: true });
    const persisted: PersistedRunRequest = {
      schema_version: SCHEMA_VERSION,
      ...request,
      created_at: this.now(),
    };
    await fs.writeFile(
      path.join(runDir, 'request.json'),
      JSON.stringify(persisted, null, 2),
      'utf-8',
    );
  }

  async load(runId: string): Promise<PersistedRunRequest> {
    const filePath = path.join(this.runsRoot, runId, 'request.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    } catch {
      throw new RunRequestNotFoundError(runId);
    }
    if (!isPersistedRunRequest(parsed)) {
      throw new RunRequestNotFoundError(runId);
    }
    return parsed;
  }

  async listHistory(): Promise<RunHistoryEntry[]> {
    let dirents;
    try {
      dirents = await fs.readdir(this.runsRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const entries = await Promise.all(
      dirents
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => this.readHistoryEntry(dirent.name)),
    );
    return entries
      .filter((entry): entry is RunHistoryEntry => entry !== undefined)
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  }

  async readTerminalSessionId(runId: string): Promise<string | undefined> {
    const terminal = await this.readTerminalState(runId);
    return terminal?.session_id;
  }

  async loadRunSnapshot(runId: string): Promise<RunSnapshot | undefined> {
    const value = await readJsonFile(path.join(this.runsRoot, runId, 'frontend-snapshot.json'));
    if (!value) return undefined;
    const parsed = runSnapshotSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }

  private async readHistoryEntry(runId: string): Promise<RunHistoryEntry | undefined> {
    const request = await this.load(runId).catch(() => undefined);
    const terminal = await this.readTerminalState(runId);
    // 目录里既没有可恢复的请求也没有终态证据（例如只有 audit.jsonl 的残留目录）时，
    // 无法诚实描述它，跳过而不是编造状态。
    if (!request && !terminal) return undefined;

    return {
      run_id: runId,
      // 没有终态快照的 run 一律 interrupted：上一个进程没有留下终态证据，
      // 绝不把它伪装成 running。
      status: terminal?.status ?? 'interrupted',
      restartable: request !== undefined,
      ...(request
        ? {
            task_id: request.task_id,
            mode: request.mode,
            prompt: request.prompt,
            workspace_path: request.workspace_path,
            created_at: request.created_at,
            ...(request.session_id ? { session_id: request.session_id } : {}),
            ...(request.task_request ? { task_request: request.task_request } : {}),
            ...(request.restarted_from_run_id
              ? { restarted_from_run_id: request.restarted_from_run_id }
              : {}),
          }
        : {}),
      ...(terminal?.task_id ? { task_id: terminal.task_id } : {}),
      ...(terminal?.mode ? { mode: terminal.mode } : {}),
      ...(terminal?.session_id ? { session_id: terminal.session_id } : {}),
      ...(terminal?.error ? { error: terminal.error } : {}),
    };
  }

  private async readTerminalState(runId: string): Promise<
    | {
        status: 'completed' | 'failed' | 'cancelled';
        task_id?: string;
        mode?: AppRunMode;
        session_id?: string;
        error?: { code: string; message: string };
      }
    | undefined
  > {
    const runDir = path.join(this.runsRoot, runId);
    const snapshot = await readJsonFile(path.join(runDir, 'frontend-snapshot.json'));
    const fromSnapshot = snapshot ? extractTerminalState(snapshot) : undefined;
    if (fromSnapshot) return fromSnapshot;
    const result = await readJsonFile(path.join(runDir, 'result.json'));
    return result ? extractTerminalState(result) : undefined;
  }
}

function extractTerminalState(value: Record<string, unknown>):
  | {
      status: 'completed' | 'failed' | 'cancelled';
      task_id?: string;
      mode?: AppRunMode;
      session_id?: string;
      error?: { code: string; message: string };
    }
  | undefined {
  const run = asRecord(value.run);
  const status = asTerminalStatus(value.status) ?? asTerminalStatus(run?.status);
  if (!status) return undefined;
  const finalOutput = asRecord(value.final_output);
  const delivery = asRecord(value.delivery_report);
  const sessionId =
    asString(finalOutput?.session_id) ??
    asString(delivery?.session_id) ??
    asString(run?.session_id);
  const errors = Array.isArray(value.errors) ? value.errors.map(asRecord) : [];
  const firstError = errors.find((error) => error && typeof error.code === 'string');
  const taskId = asString(value.task_id);
  const mode = asRunMode(value.mode);
  return {
    status,
    ...(taskId ? { task_id: taskId } : {}),
    ...(mode ? { mode } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(firstError
      ? {
          error: {
            code: String(firstError.code),
            message: typeof firstError.message === 'string' ? firstError.message : '',
          },
        }
      : {}),
  };
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function isPersistedRunRequest(value: unknown): value is PersistedRunRequest {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.run_id === 'string' &&
    typeof record.prompt === 'string' &&
    typeof record.workspace_path === 'string' &&
    (record.task_request === undefined || isTaskCreateRequest(record.task_request)) &&
    asRunMode(record.mode) !== undefined
  );
}

function isTaskCreateRequest(value: unknown): value is TaskCreateRequest {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.spec === 'string' &&
    Array.isArray(record.completion_criteria) &&
    record.completion_criteria.every((criterion) => typeof criterion === 'string') &&
    (record.role_id === undefined || typeof record.role_id === 'string') &&
    (record.parent_task_id === undefined || typeof record.parent_task_id === 'string') &&
    (record.deps === undefined || isStringArray(record.deps)) &&
    (record.risk_level === undefined ||
      ['low', 'medium', 'high', 'critical'].includes(String(record.risk_level))) &&
    (record.affected_paths === undefined || isStringArray(record.affected_paths)) &&
    (record.budget === undefined || asRecord(record.budget) !== undefined)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function asTerminalStatus(value: unknown): 'completed' | 'failed' | 'cancelled' | undefined {
  return value === 'completed' || value === 'failed' || value === 'cancelled' ? value : undefined;
}

function asRunMode(value: unknown): AppRunMode | undefined {
  return value === 'single_agent' || value === 'council' ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
