/**
 * run.* JSON-RPC 方法适配器。
 *
 * 这个文件只校验 RPC 参数并调用 application service，不运行 Coordinator 或读写进程流。
 */
import { z } from 'zod';
import path from 'node:path';
import type {
  RunCreateParams,
  RunCreateResult,
  RunListResult,
  RunRestartResult,
} from '../app/newide-backend-service';
import { RunNotFoundError, type AppRunEvent } from '../app/run-registry';
import { RunRequestNotFoundError } from '../app/run-request-store';
import type { RunSnapshot } from '../protocol/run-snapshot';
import { JSON_RPC_ERROR_CODES } from './json-rpc-line-protocol';
import { JsonRpcMethodError } from './json-rpc-dispatcher';
import type { JsonRpcDispatcher } from './json-rpc-dispatcher';

export interface RunMethodsService {
  createRun(params: RunCreateParams): Promise<RunCreateResult>;
  getRunSnapshot(runId: string): RunSnapshot;
  subscribe(runId: string, listener: (event: AppRunEvent) => void): () => void;
  cancelRun(runId: string): Promise<{ cancelled: true }>;
  listRuns(): Promise<RunListResult>;
  restartRun(runId: string): Promise<RunRestartResult>;
}

const createParamsSchema = z
  .object({
    prompt: z.string().trim().min(1),
    workspace_path: z.string().trim().min(1).refine(path.isAbsolute),
    session_id: z.string().trim().min(1).optional(),
    mode: z.enum(['single_agent', 'council']).optional(),
    project_id: z.string().min(1).optional(),
    client_task_id: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  })
  .strict();
const runIdParamsSchema = z.object({ run_id: z.string().min(1) }).strict();
const emptyParamsSchema = z.object({}).strict();

export class RunRpcMethods {
  private readonly subscriptions = new Map<string, () => void>();

  constructor(
    private readonly service: RunMethodsService,
    private readonly notify: (method: string, params: unknown) => void,
  ) {}

  register(dispatcher: JsonRpcDispatcher): void {
    dispatcher.register('run.create', async (params) => {
      const parsed = parseParams(createParamsSchema, params);
      return this.service.createRun(compactCreateParams(parsed));
    });
    dispatcher.register('run.getSnapshot', (params) => {
      const { run_id } = parseParams(runIdParamsSchema, params);
      return this.callWithRunError(() => this.service.getRunSnapshot(run_id));
    });
    dispatcher.register('run.subscribe', (params) => {
      const { run_id } = parseParams(runIdParamsSchema, params);
      const unsubscribe = this.callWithRunError(() =>
        this.service.subscribe(run_id, (event) =>
          this.notify('run.event', { run_id: event.run_id, event }),
        ),
      );
      this.subscriptions.get(run_id)?.();
      this.subscriptions.set(run_id, unsubscribe);
      return { subscribed: true };
    });
    dispatcher.register('run.unsubscribe', (params) => {
      const { run_id } = parseParams(runIdParamsSchema, params);
      this.subscriptions.get(run_id)?.();
      this.subscriptions.delete(run_id);
      return { unsubscribed: true };
    });
    dispatcher.register('run.cancel', (params) => {
      const { run_id } = parseParams(runIdParamsSchema, params);
      return this.callWithRunError(() => this.service.cancelRun(run_id));
    });
    dispatcher.register('run.list', (params) => {
      parseParams(emptyParamsSchema, params ?? {});
      return this.service.listRuns();
    });
    dispatcher.register('run.restart', async (params) => {
      const { run_id } = parseParams(runIdParamsSchema, params);
      try {
        return await this.service.restartRun(run_id);
      } catch (error) {
        if (error instanceof RunRequestNotFoundError) {
          throw new JsonRpcMethodError(
            JSON_RPC_ERROR_CODES.RUN_REQUEST_NOT_FOUND,
            'Run request not found',
            { run_id: error.runId },
          );
        }
        throw error;
      }
    });
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
  }

  private callWithRunError<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof RunNotFoundError) {
        throw new JsonRpcMethodError(JSON_RPC_ERROR_CODES.RUN_NOT_FOUND, 'Run not found', {
          run_id: error.runId,
        });
      }
      throw error;
    }
  }
}

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new JsonRpcMethodError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params');
  }
  return parsed.data;
}

function compactCreateParams(input: z.infer<typeof createParamsSchema>): RunCreateParams {
  return {
    prompt: input.prompt,
    workspace_path: input.workspace_path,
    ...(input.session_id ? { session_id: input.session_id } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.project_id ? { project_id: input.project_id } : {}),
    ...(input.client_task_id ? { client_task_id: input.client_task_id } : {}),
    ...(input.title ? { title: input.title } : {}),
  };
}
