import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { RPC_TOKEN_HEADER } from '@codecanvas/protocol';
import {
  parseHostHeader,
  validateHostHeader,
  validateOriginHeader,
  type HostValidationPolicy,
  type OriginValidationPolicy,
} from './security.js';

export interface GatewayServerDeps {
  getPort: () => number;
  getHostPolicy: () => HostValidationPolicy;
  getOriginPolicy: () => OriginValidationPolicy;
  onAppRequest?: (
    req: IncomingMessage,
    res: ServerResponse,
  ) => void | Promise<void>;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

export function createGatewayServer(deps: GatewayServerDeps): Server {
  return http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const hostCheck = validateHostHeader(
      req.headers.host,
      deps.getPort(),
      deps.getHostPolicy(),
    );
    if (!hostCheck.ok) {
      sendJson(res, hostCheck.status, {
        error: hostCheck.reason,
        message: hostCheck.message,
      });
      return;
    }

    const originCheck = validateOriginHeader(
      req.headers.origin,
      deps.getOriginPolicy(),
    );
    if (!originCheck.ok) {
      sendJson(res, originCheck.status, {
        error: originCheck.reason,
        message: originCheck.message,
      });
      return;
    }

    // Secrets never leave the daemon across the gateway boundary.
    delete req.headers[RPC_TOKEN_HEADER];

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/__cc/health') {
      const parsedHost = parseHostHeader(req.headers.host);
      sendJson(res, 200, {
        ok: true,
        role: 'gateway',
        host: parsedHost?.hostname ?? null,
      });
      return;
    }

    if (deps.onAppRequest) {
      Promise.resolve(deps.onAppRequest(req, res)).catch((err: unknown) => {
        if (!res.headersSent) {
          sendJson(res, 502, {
            error: 'gateway-error',
            message: err instanceof Error ? err.message : 'Upstream error',
          });
        }
      });
      return;
    }

    sendJson(res, 503, {
      error: 'no-upstream',
      message: 'No upstream app host is attached to the gateway.',
    });
  });
}
