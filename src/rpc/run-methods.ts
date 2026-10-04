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
  RunPayloadResult,
  RunRestartResult,
} from '../app/newide-backend-service';
import { RunNotFoundError, type AppRunEvent } from '../app/run-registry';
import { RunRequestNotFoundError } from '../app/run-request-store';
import type { RunSnapshot, RunUsage, RunUsageHistory } from '../protocol/run-snapshot';
import { JSON_RPC_ERROR_CODES } from './json-rpc-line-protocol';
import { JsonRpcMethodError } from './json-rpc-dispatcher';
import type { JsonRpcDispatcher } from './json-rpc-dispatcher';

export interface RunMethodsService {
  createRun(params: RunCreateParams): Promise<RunCreateResult>;
  getRunSnapshot(runId: string): RunSnapshot;
  subscribe(
    runId: string,
    listener: (event: AppRunEvent) => void,
    afterSequence?: number,
  ): () => void;
  cancelRun(runId: string): Promise<{ cancelled: true }>;
  listRuns(): Promise<RunListResult>;
  restartRun(runId: string): Promise<RunRestartResult>;
  /**
   * 按 `payload_ref` 取回被外置的原始内容。
   *
   * 超过内联上限的字段（工具 `raw_input` / `raw_output` / content、长 stderr、大 chunk）
   * 只留引用不内联；在那之前这个取回口一直缺失，前端能看见引用却永远拿不到内容。
   */
  getRunPayload(runId: string, payloadRef: string): Promise<RunPayloadResult | undefined>;
  /**
   * 面板用的用量查询：可选的当前 run 用量 + 按作用域的历史累计。
   *
   * `task` / `role` / `run` 作用域必须给 `scope_id`——否则「这个任务/角色/run 的累计」
   * 无从谈起。
   */
  getRunUsage(input: {
    scope: 'task' | 'system' | 'role' | 'run';
    scope_id?: string;
    run_id?: string;
  }): Promise<{ usage?: RunUsage; history: RunUsageHistory }>;
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
    memory_ablation: z.enum(['B0', 'B1', 'B2', 'B3', 'B4']).optional(),
  })
  .strict();
const runIdParamsSchema = z.object({ run_id: z.string().min(1) }).strict();
/**
 * 订阅参数。
 *
 * `after_sequence` 是断线重连的水位：只补该序号之后的事件。不给则全量重放
 * （既有行为）。序号是本后端推流通道自己的单调序号，`run.getSnapshot` 返回的
 * `event.sequence` 与它同源。
 */
const subscribeParamsSchema = z
  .object({
    run_id: z.string().min(1),
    after_sequence: z.number().int().nonnegative().optional(),
  })
  .strict();

/** 外置载荷的引用形状：`<文件名>#<键>=<序号>`，由 driver 流投影生成。 */
const payloadParamsSchema = z
  .object({
    run_id: z.string().min(1),
    payload_ref: z
      .string()
      .min(1)
      .regex(/^driver-stream\.jsonl#(stream_sequence|sequence)=\d+$/),
  })
  .strict();

/**
 * 用量查询参数。
 *
 * 作用域列得出 `task` / `system` / `role` / `run`：`role` 由账本在写入时记下的 `role_id`
 * 支撑（`summary` 里只有 driver 腿带角色）；`run` 是单个 run 的持久用量，进程重启后仍然
 * 读得到。`agent` 仍然不支持，它依赖从未被赋值的 `agent_id`。
 */
const usageParamsSchema = z
  .object({
    scope: z.enum(['task', 'system', 'role', 'run']),
    scope_id: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
  })
  .strict();
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
      const { run_id, after_sequence } = parseParams(subscribeParamsSchema, params);
      const unsubscribe = this.callWithRunError(() =>
        this.service.subscribe(
          run_id,
          (event) => this.notify('run.event', { run_id: event.run_id, event }),
          after_sequence,
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
    dispatcher.register('run.getPayload', async (params) => {
      const { run_id, payload_ref } = parseParams(payloadParamsSchema, params);
      const result = await this.service.getRunPayload(run_id, payload_ref);
      if (!result) {
        // 「引用解析得了但那一行取不到」（文件被保留策略截断 / run 目录不存在）。
        // 报错而不是返回空，前端才能区分它和「本来就没有引用」。
        throw new JsonRpcMethodError(
          JSON_RPC_ERROR_CODES.PAYLOAD_REF_UNAVAILABLE,
          'Payload ref could not be resolved',
          { run_id, payload_ref },
        );
      }
      return result;
    });
    dispatcher.register('run.getUsage', async (params) => {
      const parsed = parseParams(usageParamsSchema, params);
      if (parsed.scope !== 'system' && parsed.scope_id === undefined) {
        // 「这个任务/角色的累计」没有它就没有主语——参数校验就拦下，不去查库。
        throw new JsonRpcMethodError(
          JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          `scope_id is required for ${parsed.scope} scope`,
          { scope: parsed.scope },
        );
      }
      return this.service.getRunUsage({
        scope: parsed.scope,
        ...(parsed.scope_id ? { scope_id: parsed.scope_id } : {}),
        ...(parsed.run_id ? { run_id: parsed.run_id } : {}),
      });
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
    ...(input.memory_ablation ? { memory_ablation: input.memory_ablation } : {}),
  };
}
