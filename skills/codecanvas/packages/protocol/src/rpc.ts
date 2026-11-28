export const JSON_RPC_VERSION = '2.0' as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  method: string;
  params?: TParams;
}

export interface JsonRpcErrorObject<TData = unknown> {
  code: number;
  message: string;
  data?: TData;
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcErrorResponse<TData = unknown> {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: JsonRpcId;
  error: JsonRpcErrorObject<TData>;
}

export type JsonRpcResponse<TResult = unknown, TData = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse<TData>;

export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32001,
  FORBIDDEN: -32003,
  REF_STALE: -32010,
} as const;

export type RpcErrorCode =
  (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.jsonrpc !== JSON_RPC_VERSION) {
    return false;
  }
  if (typeof candidate.method !== 'string' || candidate.method.length === 0) {
    return false;
  }
  const id = candidate.id;
  if (
    id !== undefined &&
    id !== null &&
    typeof id !== 'string' &&
    typeof id !== 'number'
  ) {
    return false;
  }
  return 'id' in candidate;
}

export function makeRpcSuccess<TResult>(
  id: JsonRpcId,
  result: TResult,
): JsonRpcSuccessResponse<TResult> {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  };
}

export function makeRpcError<TData = unknown>(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: TData,
): JsonRpcErrorResponse<TData> {
  const error: JsonRpcErrorObject<TData> =
    data === undefined ? { code, message } : { code, message, data };
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error,
  };
}
