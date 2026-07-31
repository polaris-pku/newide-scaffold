import { z } from 'zod';
import type {
  SystemCapabilitiesV1,
  SystemLivenessV1,
  SystemReadinessV1,
  SystemSchemaManifestV1,
  SystemVersionV1,
} from '../protocol/system-status';
import { JSON_RPC_ERROR_CODES } from './json-rpc-line-protocol';
import { JsonRpcMethodError, type JsonRpcDispatcher } from './json-rpc-dispatcher';

export interface SystemMethodsService {
  getSystemLiveness(): SystemLivenessV1;
  getSystemReadiness(): SystemReadinessV1;
  getSystemCapabilities(required?: readonly string[]): SystemCapabilitiesV1;
  getSystemVersion(): SystemVersionV1;
  getSystemSchema(): SystemSchemaManifestV1;
}

const emptyParamsSchema = z.object({}).strict();
const capabilitiesParamsSchema = z
  .object({
    require: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

export class SystemRpcMethods {
  constructor(private readonly service: SystemMethodsService) {}

  register(dispatcher: JsonRpcDispatcher): void {
    dispatcher.register('system.ping', (params) => {
      parseParams(emptyParamsSchema, params ?? {});
      return {
        status: 'ok',
        protocol_version: this.service.getSystemVersion().protocol_version,
      };
    });
    dispatcher.register('system.liveness', (params) => {
      parseParams(emptyParamsSchema, params ?? {});
      return this.service.getSystemLiveness();
    });
    dispatcher.register('system.readiness', (params) => {
      parseParams(emptyParamsSchema, params ?? {});
      return this.service.getSystemReadiness();
    });
    dispatcher.register('system.capabilities', (params) => {
      const parsed = parseParams(capabilitiesParamsSchema, params ?? {});
      return this.service.getSystemCapabilities(parsed.require);
    });
    dispatcher.register('system.version', (params) => {
      parseParams(emptyParamsSchema, params ?? {});
      return this.service.getSystemVersion();
    });
    dispatcher.register('system.schema', (params) => {
      parseParams(emptyParamsSchema, params ?? {});
      return this.service.getSystemSchema();
    });
  }
}

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new JsonRpcMethodError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params');
  }
  return parsed.data;
}
