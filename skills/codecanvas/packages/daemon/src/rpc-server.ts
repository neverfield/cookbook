import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import {
  RPC_ERROR_CODES,
  RPC_TOKEN_HEADER,
  isJsonRpcRequest,
  makeRpcError,
  makeRpcSuccess,
  type JsonRpcResponse,
} from '@codecanvas/protocol';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  authenticateRpcToken,
  extractHttpRpcToken,
  extractWsRpcToken,
  validateHostHeader,
  validateOriginHeader,
  type HostValidationPolicy,
  type OriginValidationPolicy,
} from './security.js';

const MAX_RPC_BODY_BYTES = 1024 * 1024;
const WS_UPGRADE_PATHS = new Set(['/rpc', '/ws']);

export interface RpcRequestContext {
  transport: 'http' | 'ws';
  remoteAddress?: string;
}

export type RpcMethodHandler = (
  params: unknown,
  context: RpcRequestContext,
) => unknown | Promise<unknown>;

export interface RpcServerDeps {
  getPort: () => number;
  getToken: () => string;
  getHostPolicy: () => HostValidationPolicy;
  getHttpOriginPolicy: () => OriginValidationPolicy;
  getWsOriginPolicy: () => OriginValidationPolicy;
  methods: ReadonlyMap<string, RpcMethodHandler>;
}

export interface RpcServerHandle {
  httpServer: Server;
  wsServer: WebSocketServer;
  closeConnections: () => void;
}

function writeJsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

function rejectUpgrade(
  socket: Duplex,
  status: 401 | 403 | 404,
  reason: string,
  message: string,
): void {
  const statusText =
    status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not Found';
  const body = JSON.stringify({ error: reason, message });
  const headers = [
    `HTTP/1.1 ${status} ${statusText}`,
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    'Cache-Control: no-store',
  ];
  if (status === 401) {
    headers.push('WWW-Authenticate: Bearer realm="codecanvas"');
  }
  socket.write(`${headers.join('\r\n')}\r\n\r\n${body}`);
  socket.destroy();
}

async function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new PayloadTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('RPC payload exceeds size limit.');
    this.name = 'PayloadTooLargeError';
  }
}

async function dispatchRpcMessage(
  rawText: string,
  methods: ReadonlyMap<string, RpcMethodHandler>,
  context: RpcRequestContext,
): Promise<JsonRpcResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return makeRpcError(null, RPC_ERROR_CODES.PARSE_ERROR, 'Invalid JSON.');
  }

  if (!isJsonRpcRequest(parsed)) {
    return makeRpcError(
      null,
      RPC_ERROR_CODES.INVALID_REQUEST,
      'Invalid JSON-RPC 2.0 request.',
    );
  }

  const handler = methods.get(parsed.method);
  if (!handler) {
    return makeRpcError(
      parsed.id,
      RPC_ERROR_CODES.METHOD_NOT_FOUND,
      `Method not found: ${parsed.method}`,
    );
  }

  try {
    const result = await handler(parsed.params, context);
    return makeRpcSuccess(parsed.id, result);
  } catch (err: unknown) {
    return makeRpcError(
      parsed.id,
      RPC_ERROR_CODES.INTERNAL_ERROR,
      err instanceof Error ? err.message : 'Internal RPC error',
    );
  }
}

export function createRpcServer(deps: RpcServerDeps): RpcServerHandle {
  const selectedProtocols = new WeakMap<IncomingMessage, string>();

  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_RPC_BODY_BYTES,
    handleProtocols: (_protocols, req) => {
      return selectedProtocols.get(req) ?? false;
    },
  });

  wsServer.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const remoteAddress = req.socket.remoteAddress;
    ws.on('message', (data: RawData) => {
      const rawText =
        typeof data === 'string'
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.isBuffer(data)
              ? data.toString('utf8')
              : Buffer.from(data).toString('utf8');

      void dispatchRpcMessage(rawText, deps.methods, {
        transport: 'ws',
        remoteAddress,
      }).then((response) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(response));
        }
      });
    });
  });

  const httpServer = http.createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const hostCheck = validateHostHeader(
        req.headers.host,
        deps.getPort(),
        deps.getHostPolicy(),
      );
      if (!hostCheck.ok) {
        writeJsonResponse(res, hostCheck.status, {
          error: hostCheck.reason,
          message: hostCheck.message,
        });
        return;
      }

      const origin = req.headers.origin;
      const originCheck = validateOriginHeader(
        origin,
        deps.getHttpOriginPolicy(),
      );
      if (!originCheck.ok) {
        writeJsonResponse(res, originCheck.status, {
          error: originCheck.reason,
          message: originCheck.message,
        });
        return;
      }

      const corsHeaders: Record<string, string> = origin
        ? {
            'Access-Control-Allow-Origin': origin,
            Vary: 'Origin',
          }
        : {};

      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

      if (req.method === 'OPTIONS' && pathname === '/rpc') {
        res.writeHead(204, {
          ...corsHeaders,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': `Content-Type, Authorization, ${RPC_TOKEN_HEADER}`,
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }

      const tokenCheck = authenticateRpcToken(
        extractHttpRpcToken(req),
        deps.getToken(),
      );
      if (!tokenCheck.ok) {
        writeJsonResponse(
          res,
          tokenCheck.status,
          {
            error: tokenCheck.reason,
            message: tokenCheck.message,
          },
          {
            ...corsHeaders,
            'WWW-Authenticate': 'Bearer realm="codecanvas"',
          },
        );
        return;
      }

      if (req.method === 'GET' && pathname === '/health') {
        writeJsonResponse(
          res,
          200,
          { ok: true, role: 'rpc' },
          corsHeaders,
        );
        return;
      }

      if (req.method === 'POST' && pathname === '/rpc') {
        void readBody(req, MAX_RPC_BODY_BYTES)
          .then((body) =>
            dispatchRpcMessage(body, deps.methods, {
              transport: 'http',
              remoteAddress: req.socket.remoteAddress,
            }),
          )
          .then((rpcResponse) => {
            writeJsonResponse(res, 200, rpcResponse, corsHeaders);
          })
          .catch((err: unknown) => {
            if (err instanceof PayloadTooLargeError) {
              writeJsonResponse(
                res,
                413,
                { error: 'payload-too-large', message: err.message },
                corsHeaders,
              );
              return;
            }
            writeJsonResponse(
              res,
              400,
              makeRpcError(
                null,
                RPC_ERROR_CODES.PARSE_ERROR,
                'Failed to read request body.',
              ),
              corsHeaders,
            );
          });
        return;
      }

      writeJsonResponse(res, 404, { error: 'not-found' }, corsHeaders);
    },
  );

  httpServer.on(
    'upgrade',
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!WS_UPGRADE_PATHS.has(pathname)) {
        rejectUpgrade(socket, 404, 'not-found', `Unknown WS path "${pathname}".`);
        return;
      }

      const hostCheck = validateHostHeader(
        req.headers.host,
        deps.getPort(),
        deps.getHostPolicy(),
      );
      if (!hostCheck.ok) {
        rejectUpgrade(
          socket,
          hostCheck.status,
          hostCheck.reason,
          hostCheck.message,
        );
        return;
      }

      const originCheck = validateOriginHeader(
        req.headers.origin,
        deps.getWsOriginPolicy(),
      );
      if (!originCheck.ok) {
        rejectUpgrade(
          socket,
          originCheck.status,
          originCheck.reason,
          originCheck.message,
        );
        return;
      }

      const extracted = extractWsRpcToken(req);
      const tokenCheck = authenticateRpcToken(extracted.token, deps.getToken());
      if (!tokenCheck.ok) {
        rejectUpgrade(
          socket,
          tokenCheck.status,
          tokenCheck.reason,
          tokenCheck.message,
        );
        return;
      }

      if (extracted.selectedProtocol) {
        selectedProtocols.set(req, extracted.selectedProtocol);
      }

      wsServer.handleUpgrade(req, socket, head, (ws) => {
        wsServer.emit('connection', ws, req);
      });
    },
  );

  return {
    httpServer,
    wsServer,
    closeConnections: () => {
      for (const client of wsServer.clients) {
        client.terminate();
      }
      wsServer.close();
    },
  };
}
