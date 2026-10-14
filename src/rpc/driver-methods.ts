/**
 * `driver.*` JSON-RPC 方法（Role → Driver 配置接口）。
 *
 * 职责与核心逻辑：
 * - 只做三件事：Zod 参数校验（strict，多余字段一律拒绝）、调用领域服务、把
 *   {@link DriverRoutingError} 映射成稳定 JSON-RPC 业务错误码。**不直接读写文件**；
 * - `driver.getConfig` 只接受空对象 `{}`：查询不该带任何参数，带上就是调用方理解错了；
 * - `driver.updateRouting` / `driver.resetRouting` 的错误 data 原样来自领域服务，其中只有
 *   结构化字段（revision、field、driver_id、reason_code、limitations、路径类别），没有
 *   secret、没有绝对路径细节；
 * - `driver.list` / `driver.probe` 是**原始探测**（返回 `DriverProbeResult`），
 *   `driver.refresh` 才是「重新发现并把结果同步到有效列表」（返回 `DriverRoutingSnapshot`）。
 *   三者分开是刻意的：探测成功不等于这个 driver 已经可以路由执行。
 */
import { z } from 'zod';

import {
  resetDriverRoutingInputSchema,
  updateDriverRoutingInputSchema,
  type DriverRoutingSnapshot,
  type UpdateDriverRoutingInput,
} from '../protocol/driver-routing';
import {
  DriverRoutingError,
  type DriverRoutingErrorCode,
} from '../driver/driver-routing-service';
import { DriverDiscoveryFileError } from '../driver/driver-discovery-file-store';
import {
  DriverProbeFailedError,
  DriverProbeUnavailableError,
  type DriverProbeOptions,
  type DriverProbeResult,
} from '../driver/driver-probe-service';
import { JSON_RPC_ERROR_CODES } from './json-rpc-line-protocol';
import { JsonRpcMethodError, type JsonRpcDispatcher } from './json-rpc-dispatcher';

/**
 * RPC 层需要的 driver routing 服务面。
 *
 * 由组装点把 `DriverRoutingService` 适配成它（见 `backend-rpc-stdio.ts`）：领域服务用
 * 自己的词表（snapshot/routing），对外 RPC 用 `driver.` 前缀的词表，两层不互相迁就。
 */
export interface DriverMethodsService {
  getDriverConfig(): Promise<DriverRoutingSnapshot>;
  updateDriverRouting(input: UpdateDriverRoutingInput): Promise<DriverRoutingSnapshot>;
  resetDriverRouting(expectedRevision: string): Promise<DriverRoutingSnapshot>;
}

export interface DriverProbeMethodsService {
  probe(options?: DriverProbeOptions): Promise<DriverProbeResult>;
}

/**
 * `driver.refresh` 需要的面。
 *
 * 返回 *routing 快照*而不是探测结果：这个方法的语义是「让有效 driver 列表反映现在的本机
 * 情况」，调用方关心的正是那份列表。刷新只动 catalog / 自动 profile / runtime，**不改 UI
 * routing mapping**，因此 `revision` 不变。
 */
export interface DriverDiscoveryMethodsService {
  refresh(options?: DriverProbeOptions): Promise<DriverRoutingSnapshot>;
}

/**
 * 把领域服务（snapshot/routing 词表）适配成 RPC 服务面（`driver.` 词表）。
 *
 * 结构类型而非类依赖：组装点、脚本与测试都能把任意同形对象接上来。
 */
export function createDriverMethodsService(routing: {
  getSnapshot(): Promise<DriverRoutingSnapshot>;
  updateRouting(input: UpdateDriverRoutingInput): Promise<DriverRoutingSnapshot>;
  resetRouting(expectedRevision: string): Promise<DriverRoutingSnapshot>;
}): DriverMethodsService {
  return {
    getDriverConfig: () => routing.getSnapshot(),
    updateDriverRouting: (input) => routing.updateRouting(input),
    resetDriverRouting: (expectedRevision) => routing.resetRouting(expectedRevision),
  };
}

const emptyParamsSchema = z.object({}).strict();
const probeParamsSchema = z
  .object({
    agent_ids: z.array(z.string().trim().min(1)).min(1).optional(),
    timeout_ms: z.number().int().positive().max(120_000).optional(),
    concurrency: z.number().int().positive().max(32).optional(),
    force: z.boolean().optional(),
  })
  .strict();

/** 领域错误码 → JSON-RPC 业务错误码；一一对应，没有兜底的「其他」。 */
const DRIVER_ROUTING_RPC_CODES: Readonly<Record<DriverRoutingErrorCode, number>> = {
  revision_mismatch: JSON_RPC_ERROR_CODES.DRIVER_CONFIG_CONFLICT,
  driver_not_found: JSON_RPC_ERROR_CODES.DRIVER_NOT_FOUND,
  driver_not_selectable: JSON_RPC_ERROR_CODES.DRIVER_NOT_SELECTABLE,
  default_driver_locked: JSON_RPC_ERROR_CODES.DRIVER_DEFAULT_LOCKED,
  config_busy: JSON_RPC_ERROR_CODES.DRIVER_CONFIG_BUSY,
  write_failed: JSON_RPC_ERROR_CODES.DRIVER_CONFIG_WRITE_FAILED,
};

export class DriverRpcMethods {
  constructor(
    private readonly service: DriverMethodsService,
    private readonly probeService?: DriverProbeMethodsService,
    private readonly discoveryService?: DriverDiscoveryMethodsService,
  ) {}

  register(dispatcher: JsonRpcDispatcher): void {
    dispatcher.register('driver.getConfig', async (params) => {
      parseParams(emptyParamsSchema, params ?? {});
      return this.invoke(() => this.service.getDriverConfig());
    });

    dispatcher.register('driver.updateRouting', async (params) => {
      const input = parseParams(updateDriverRoutingInputSchema, params ?? {});
      return this.invoke(() => this.service.updateDriverRouting(input));
    });

    dispatcher.register('driver.resetRouting', async (params) => {
      const input = parseParams(resetDriverRoutingInputSchema, params ?? {});
      return this.invoke(() => this.service.resetDriverRouting(input.expected_revision));
    });

    if (this.probeService) {
      dispatcher.register('driver.list', async (params) => {
        const input = parseParams(probeParamsSchema, params ?? {});
        return this.invokeProbe(() => this.probeService!.probe(toProbeOptions(input)));
      });
      // `driver.probe` is an explicit alias for clients that prefer an action
      // name; both methods share exactly the same validated contract.
      dispatcher.register('driver.probe', async (params) => {
        const input = parseParams(probeParamsSchema, params ?? {});
        return this.invokeProbe(() => this.probeService!.probe(toProbeOptions(input)));
      });
    }

    if (this.discoveryService) {
      // 与 `driver.list` 共用同一套参数 schema（`agent_ids` / `timeout_ms` / `concurrency` /
      // `force`）：前端「刷新」按钮与「探测」按钮说的是同一件事，只是后者只回原始探测结果。
      dispatcher.register('driver.refresh', async (params) => {
        const input = parseParams(probeParamsSchema, params ?? {});
        return this.invokeRefresh(() => this.discoveryService!.refresh(toProbeOptions(input)));
      });
    }
  }

  private async invoke<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DriverRoutingError) {
        throw new JsonRpcMethodError(
          DRIVER_ROUTING_RPC_CODES[error.code],
          error.message,
          error.data,
        );
      }
      throw error;
    }
  }

  private async invokeProbe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw probeJsonRpcError(error) ?? error;
    }
  }

  /**
   * 刷新的错误映射。
   *
   * 探测失败沿用 `DRIVER_PROBE_*`——前端已经按这两个码做过「重新构建 runner / 重试」的分支，
   * 刷新这条路没有理由换一套；落盘与加锁失败给自动发现自己的码（可重试与不可重试分开）。
   * 两类错误的 data 里都只有原因码，没有路径与 secret。
   */
  private async invokeRefresh<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const probeError = probeJsonRpcError(error);
      if (probeError) throw probeError;
      if (error instanceof DriverRoutingError) {
        throw new JsonRpcMethodError(
          DRIVER_ROUTING_RPC_CODES[error.code],
          error.message,
          error.data,
        );
      }
      if (error instanceof DriverDiscoveryFileError) {
        const busy = error.reason === 'lock_busy';
        throw new JsonRpcMethodError(
          busy
            ? JSON_RPC_ERROR_CODES.DRIVER_DISCOVERY_LOCK_BUSY
            : JSON_RPC_ERROR_CODES.DRIVER_DISCOVERY_PERSIST_FAILED,
          busy
            ? 'Driver discovery is being refreshed by another writer'
            : 'Failed to persist driver discovery results',
          { reason: error.reason_code },
        );
      }
      throw error;
    }
  }
}

/** 探测类错误 → JSON-RPC 业务错误；不是探测错误时返回 undefined。 */
function probeJsonRpcError(error: unknown): JsonRpcMethodError | undefined {
  if (error instanceof DriverProbeUnavailableError) {
    return new JsonRpcMethodError(
      JSON_RPC_ERROR_CODES.DRIVER_PROBE_UNAVAILABLE,
      error.message,
      { reason: 'DRIVER_PROBE_UNAVAILABLE' },
    );
  }
  if (error instanceof DriverProbeFailedError) {
    return new JsonRpcMethodError(JSON_RPC_ERROR_CODES.DRIVER_PROBE_FAILED, 'ACP driver probe failed', {
      reason: 'DRIVER_PROBE_FAILED',
    });
  }
  return undefined;
}

function toProbeOptions(input: {
  agent_ids?: string[] | undefined;
  timeout_ms?: number | undefined;
  concurrency?: number | undefined;
  force?: boolean | undefined;
}): DriverProbeOptions {
  return {
    ...(input.agent_ids ? { agentIds: input.agent_ids } : {}),
    ...(input.timeout_ms === undefined ? {} : { timeoutMs: input.timeout_ms }),
    ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
    ...(input.force === undefined ? {} : { force: input.force }),
  };
}

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new JsonRpcMethodError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params');
  }
  return parsed.data;
}
