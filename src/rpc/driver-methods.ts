/**
 * `driver.*` JSON-RPC 方法（Role → Driver 配置接口）。
 *
 * 职责与核心逻辑：
 * - 只做三件事：Zod 参数校验（strict，多余字段一律拒绝）、调用领域服务、把
 *   {@link DriverRoutingError} 映射成稳定 JSON-RPC 业务错误码。**不直接读写文件**；
 * - `driver.getConfig` 只接受空对象 `{}`：查询不该带任何参数，带上就是调用方理解错了；
 * - `driver.updateRouting` / `driver.resetRouting` 的错误 data 原样来自领域服务，其中只有
 *   结构化字段（revision、field、driver_id、reason_code、limitations、路径类别），没有
 *   secret、没有绝对路径细节。
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
  constructor(private readonly service: DriverMethodsService) {}

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
}

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new JsonRpcMethodError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params');
  }
  return parsed.data;
}
