import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  RPC_HTML_TOKEN_META,
  RPC_HTML_URL_META,
  type EditorBootstrapConfig,
} from '@codecanvas/protocol';
import {
  validateHostHeader,
  validateOriginHeader,
  type HostValidationPolicy,
  type OriginValidationPolicy,
} from './security.js';

export interface EditorServerDeps {
  getPort: () => number;
  getHostPolicy: () => HostValidationPolicy;
  getOriginPolicy: () => OriginValidationPolicy;
  getBootstrapConfig: () => EditorBootstrapConfig;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function serializeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export function renderEditorHtml(config: EditorBootstrapConfig): string {
  const tokenAttr = escapeHtmlAttr(config.token);
  const rpcUrlAttr = escapeHtmlAttr(config.rpcUrl);
  const bootstrapJson = serializeScriptJson(config);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="${RPC_HTML_TOKEN_META}" content="${tokenAttr}" />
    <meta name="${RPC_HTML_URL_META}" content="${rpcUrlAttr}" />
    <title>codecanvas</title>
    <script>window.__CODECANVAS_CONFIG__ = Object.freeze(${bootstrapJson});</script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;
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

export function createEditorServer(deps: EditorServerDeps): Server {
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

    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/health') {
      sendJson(res, 200, { ok: true, role: 'editor' });
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      const html = renderEditorHtml(deps.getBootstrapConfig());
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
      });
      res.end(method === 'HEAD' ? undefined : html);
      return;
    }

    sendJson(res, 404, { error: 'not-found' });
  });
}
