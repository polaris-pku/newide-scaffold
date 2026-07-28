/**
 * JSON-RPC 2.0 单行协议原语。
 *
 * 这个文件只负责 envelope 校验与响应构造，不读取 stdin、不写 stdout，也不分发业务方法。
 */
import { z } from 'zod';

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  RUN_NOT_FOUND: -32004,
  RUN_REQUEST_NOT_FOUND: -32005,
  TASK_NOT_FOUND: -32006,
  TASK_ALREADY_RUNNING: -32007,
  TASK_NOT_RUNNING: -32008,
  TASK_EVENT_CURSOR_NOT_FOUND: -32009,
  TASK_NOT_BLOCKED: -32010,
  MAILBOX_DELIVERY_NOT_FOUND: -32011,
  MAILBOX_RECIPIENT_MISMATCH: -32012,
  MAILBOX_DELIVERY_STATE: -32013,
} as const;

const requestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

export type JsonRpcLineParseResult =
  | { ok: true; message: JsonRpcRequest }
  | { ok: false; response: JsonRpcErrorResponse };

export function parseJsonRpcLine(line: string): JsonRpcLineParseResult {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return {
      ok: false,
      response: createErrorResponse(null, JSON_RPC_ERROR_CODES.PARSE_ERROR, 'Parse error'),
    };
  }

  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      response: createErrorResponse(null, JSON_RPC_ERROR_CODES.INVALID_REQUEST, 'Invalid Request'),
    };
  }
  return {
    ok: true,
    message: {
      jsonrpc: '2.0',
      method: parsed.data.method,
      ...(parsed.data.id === undefined ? {} : { id: parsed.data.id }),
      ...(parsed.data.params === undefined ? {} : { params: parsed.data.params }),
    },
  };
}

export function createSuccessResponse(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: '2.0', id, result };
}

export function createErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}
