/**
 * JSON-RPC 方法分发与单连接 session。
 *
 * 这个文件负责协议方法调用和 JSON 行输出，不读取进程流，也不包含 run 业务逻辑。
 */
import {
  JSON_RPC_ERROR_CODES,
  createErrorResponse,
  createSuccessResponse,
  parseJsonRpcLine,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './json-rpc-line-protocol';
import { ApplicationError } from '../protocol/application-error';

export type JsonRpcMethodHandler = (params: unknown) => unknown | Promise<unknown>;

export class JsonRpcMethodError extends Error {
  readonly data?: unknown;

  constructor(
    readonly code: number,
    message: string,
    data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcMethodError';
    if (data !== undefined) this.data = data;
  }
}

export class JsonRpcDispatcher {
  private readonly handlers = new Map<string, JsonRpcMethodHandler>();

  register(method: string, handler: JsonRpcMethodHandler): void {
    if (this.handlers.has(method)) {
      throw new Error(`JSON-RPC method ${method} is already registered`);
    }
    this.handlers.set(method, handler);
  }

  async dispatch(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    const hasResponse = request.id !== undefined;
    const handler = this.handlers.get(request.method);
    if (!handler) {
      return hasResponse
        ? createErrorResponse(
            request.id ?? null,
            JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
            'Method not found',
          )
        : undefined;
    }

    try {
      const result = await handler(request.params);
      return hasResponse ? createSuccessResponse(request.id ?? null, result) : undefined;
    } catch (error) {
      if (error instanceof ApplicationError) {
        return hasResponse
          ? createErrorResponse(
              request.id ?? null,
              JSON_RPC_ERROR_CODES.APPLICATION_ERROR,
              error.message,
              error.data,
            )
          : undefined;
      }
      if (error instanceof JsonRpcMethodError) {
        return hasResponse
          ? createErrorResponse(request.id ?? null, error.code, error.message, error.data)
          : undefined;
      }
      return hasResponse
        ? createErrorResponse(
            request.id ?? null,
            JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
            'Internal error',
          )
        : undefined;
    }
  }
}

export class JsonRpcLineSession {
  constructor(
    private readonly dispatcher: JsonRpcDispatcher,
    private readonly writeLine: (line: string) => void,
  ) {}

  async handleLine(line: string): Promise<void> {
    const parsed = parseJsonRpcLine(line);
    const response = parsed.ok ? await this.dispatcher.dispatch(parsed.message) : parsed.response;
    if (response) this.writeJson(response);
  }

  sendNotification(method: string, params: unknown): void {
    this.writeJson({ jsonrpc: '2.0', method, params });
  }

  private writeJson(value: unknown): void {
    this.writeLine(JSON.stringify(value));
  }
}
