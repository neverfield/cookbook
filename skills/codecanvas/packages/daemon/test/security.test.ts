import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  RPC_HTML_TOKEN_META,
  RPC_HTML_URL_META,
  RPC_TOKEN_HEADER,
  RPC_WS_PROTOCOL,
  RPC_WS_TOKEN_PROTOCOL_PREFIX,
  type JsonRpcResponse,
} from '@codecanvas/protocol';
import {
  DaemonServer,
  SecurityConfigError,
  isLoopbackHost,
  parseDaemonCliArgs,
  startDaemonFromCli,
} from '../src/index.js';

interface RawHttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function sendHttpRequest(options: {
  port: number;
  host?: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<RawHttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: options.host ?? '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

function connectWsExpectRejected(
  url: string,
  options: {
    headers?: Record<string, string>;
    protocols?: string | string[];
  } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const ws =
      options.protocols !== undefined
        ? new WebSocket(url, options.protocols, { headers: options.headers })
        : new WebSocket(url, { headers: options.headers });

    let settled = false;

    ws.once('unexpected-response', (_req, res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        if (!settled) {
          settled = true;
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        }
      });
    });

    ws.once('open', () => {
      ws.terminate();
      if (!settled) {
        settled = true;
        reject(new Error('Expected WebSocket upgrade to be rejected, but it opened.'));
      }
    });

    ws.once('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function openWsAndCallRpc(
  url: string,
  options: {
    headers?: Record<string, string>;
    protocols?: string | string[];
  } = {},
  method = 'daemon/ping',
): Promise<{ response: JsonRpcResponse; protocol: string }> {
  return new Promise((resolve, reject) => {
    const ws =
      options.protocols !== undefined
        ? new WebSocket(url, options.protocols, { headers: options.headers })
        : new WebSocket(url, { headers: options.headers });

    const cleanup = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    };

    ws.once('unexpected-response', (_req, res) => {
      cleanup();
      reject(
        new Error(
          `Expected WebSocket upgrade to succeed, got HTTP ${res.statusCode ?? 0}`,
        ),
      );
    });

    ws.once('error', (err) => {
      cleanup();
      reject(err);
    });

    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
        }),
      );
    });

    ws.once('message', (data) => {
      const parsed = JSON.parse(data.toString('utf8')) as JsonRpcResponse;
      const protocol = ws.protocol;
      ws.close();
      resolve({ response: parsed, protocol });
    });
  });
}

const activeDaemons: DaemonServer[] = [];

async function startTrackedDaemon(
  options?: ConstructorParameters<typeof DaemonServer>[0],
): Promise<DaemonServer> {
  const daemon = new DaemonServer(options);
  activeDaemons.push(daemon);
  await daemon.start();
  return daemon;
}

afterEach(async () => {
  while (activeDaemons.length > 0) {
    const daemon = activeDaemons.pop();
    if (daemon) {
      await daemon.stop();
    }
  }
});

describe('WP0.1 daemon security (Invariant I8)', () => {
  it('binds all default listeners strictly to 127.0.0.1 on ephemeral ports', async () => {
    const daemon = await startTrackedDaemon();
    const endpoints = daemon.getEndpoints();

    expect(endpoints.host).toBe('127.0.0.1');
    expect(endpoints.rpc.host).toBe('127.0.0.1');
    expect(endpoints.editor.host).toBe('127.0.0.1');
    expect(endpoints.gateway.host).toBe('127.0.0.1');

    for (const port of [
      endpoints.rpc.port,
      endpoints.editor.port,
      endpoints.gateway.port,
    ]) {
      expect(port).toBeGreaterThan(0);
      expect(port < 4400 || port > 4410).toBe(true);
      expect(port).not.toBe(4600);
    }
  });

  it('generates distinct 256-bit cryptographically random tokens per launch', async () => {
    const first = await startTrackedDaemon();
    const second = await startTrackedDaemon();

    expect(first.getToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(second.getToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(first.getToken()).not.toBe(second.getToken());
  });

  it('rejects non-loopback host binds without explicit opt-in', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('s-home.cc.localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.50')).toBe(false);
    expect(isLoopbackHost('localhost.evil.com')).toBe(false);

    expect(() => new DaemonServer({ host: '0.0.0.0' })).toThrow(
      SecurityConfigError,
    );
    expect(() => new DaemonServer({ host: '192.168.1.50' })).toThrow(
      SecurityConfigError,
    );
  });

  it('supports explicit --host opt-in with warning while preserving auth and Host/Origin checks', async () => {
    const defaultArgs = parseDaemonCliArgs([]);
    expect(defaultArgs.host).toBe('127.0.0.1');
    expect(defaultArgs.allowRemoteHost).toBe(false);

    const loopbackArgs = parseDaemonCliArgs(['--host', '127.0.0.1']);
    expect(loopbackArgs.host).toBe('127.0.0.1');
    expect(loopbackArgs.allowRemoteHost).toBe(false);

    const warnings: string[] = [];
    const logs: string[] = [];
    const daemon = await startDaemonFromCli(['--host', '0.0.0.0'], {
      warn: (msg) => warnings.push(msg),
      log: (msg) => logs.push(msg),
    });
    activeDaemons.push(daemon);

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/non-loopback/i);
    expect(logs.length).toBe(1);
    expect(logs[0]).not.toContain(daemon.getToken());

    const endpoints = daemon.getEndpoints();
    expect(endpoints.rpc.host).toBe('0.0.0.0');
    expect(endpoints.editor.host).toBe('0.0.0.0');
    expect(endpoints.gateway.host).toBe('0.0.0.0');

    // Missing token is still rejected (401).
    const unauth = await sendHttpRequest({
      port: endpoints.rpc.port,
      path: '/rpc',
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${endpoints.rpc.port}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'daemon/ping' }),
    });
    expect(unauth.status).toBe(401);

    // DNS rebinding Host is still rejected (403).
    const badHost = await sendHttpRequest({
      port: endpoints.rpc.port,
      path: '/rpc',
      method: 'POST',
      headers: {
        Host: `evil.com:${endpoints.rpc.port}`,
        Authorization: `Bearer ${daemon.getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'daemon/ping' }),
    });
    expect(badHost.status).toBe(403);

    // Authenticated loopback call succeeds.
    const authed = await sendHttpRequest({
      port: endpoints.rpc.port,
      path: '/rpc',
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${endpoints.rpc.port}`,
        Authorization: `Bearer ${daemon.getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'daemon/ping' }),
    });
    expect(authed.status).toBe(200);
  });

  it('injects the per-launch RPC token into served editor HTML and guards editor Host/Origin', async () => {
    const daemon = await startTrackedDaemon();
    const endpoints = daemon.getEndpoints();
    const token = daemon.getToken();

    const htmlRes = await sendHttpRequest({
      port: endpoints.editor.port,
      path: '/',
    });
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers['cache-control']).toBe('no-store');
    expect(htmlRes.headers['referrer-policy']).toBe('no-referrer');
    expect(htmlRes.body).toContain(
      `<meta name="${RPC_HTML_TOKEN_META}" content="${token}" />`,
    );
    expect(htmlRes.body).toContain(
      `<meta name="${RPC_HTML_URL_META}" content="${endpoints.wsUrl}" />`,
    );
    expect(htmlRes.body).toContain('window.__CODECANVAS_CONFIG__');
    expect(htmlRes.body).toContain(token);

    // Editor rejects DNS-rebinding Host headers (403) so token cannot be exfiltrated.
    const badHost = await sendHttpRequest({
      port: endpoints.editor.port,
      path: '/',
      headers: { Host: `attacker.example:${endpoints.editor.port}` },
    });
    expect(badHost.status).toBe(403);
    expect(badHost.body).not.toContain(token);

    // Editor rejects cross-origin requests (403).
    const crossOrigin = await sendHttpRequest({
      port: endpoints.editor.port,
      path: '/',
      headers: {
        Host: `127.0.0.1:${endpoints.editor.port}`,
        Origin: 'https://evil.com',
      },
    });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body).not.toContain(token);
  });

  it('rejects missing or invalid tokens on HTTP RPC with 401 and accepts valid tokens', async () => {
    const daemon = await startTrackedDaemon();
    const endpoints = daemon.getEndpoints();
    const token = daemon.getToken();
    const pingBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: 'daemon/ping',
    });

    const missing = await sendHttpRequest({
      port: endpoints.rpc.port,
      path: '/rpc',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: pingBody,
    });
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toContain('Bearer');

    const invalidBearer = await sendHttpRequest({
      port: endpoints.rpc.port,
      path: '/rpc',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${'0'.repeat(64)}`,
        'Content-Type': 'application/json',
      },
      body: pingBody,
    });
    expect(invalidBearer.status).toBe(401);

    const invalidCustom = await sendHttpRequest({
      port: endpoints.rpc.port,
      path: '/rpc',
      method: 'POST',
      headers: {
        [RPC_TOKEN_HEADER]: 'wrong-token',
        'Content-Type': 'application/json',
      },
      body: pingBody,
    });
    expect(invalidCustom.status).toBe(401);

    // Valid Bearer token accepted.
    const bearerOk = await sendHttpRequest({
      port: endpoints.rpc.port,
      path: '/rpc',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: endpoints.editor.url,
        'Content-Type': 'application/json',
      },
      body: pingBody,
    });
    expect(bearerOk.status).toBe(200);
    expect(bearerOk.headers['access-control-allow-origin']).toBe(
      endpoints.editor.url,
    );
    const bearerJson = JSON.parse(bearerOk.body) as JsonRpcResponse<{
      ok: boolean;
    }>;
    expect('result' in bearerJson && bearerJson.result.ok).toBe(true);

    // Valid X-Codecanvas-Token header accepted and daemon/info never leaks token.
    const headerOk = await sendHttpRequest({
      port: endpoints.rpc.port,
      path: '/rpc',
      method: 'POST',
      headers: {
        [RPC_TOKEN_HEADER]: token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 43,
        method: 'daemon/info',
      }),
    });
    expect(headerOk.status).toBe(200);
    expect(headerOk.body).not.toContain(token);
  });

  it('rejects bad Host and cross-origin Origin headers on HTTP RPC with 403', async () => {
    const daemon = await startTrackedDaemon();
    const endpoints = daemon.getEndpoints();
    const token = daemon.getToken();
    const pingBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'daemon/ping',
    });

    for (const badHost of [
      `evil.com:${endpoints.rpc.port}`,
      `localhost.evil.com:${endpoints.rpc.port}`,
      `127.0.0.1:${endpoints.rpc.port + 1}`,
      '127.0.0.1',
    ]) {
      const res = await sendHttpRequest({
        port: endpoints.rpc.port,
        path: '/rpc',
        method: 'POST',
        headers: {
          Host: badHost,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: pingBody,
      });
      expect(res.status, `Host "${badHost}" should be rejected`).toBe(403);
    }

    for (const badOrigin of [
      'https://evil.com',
      'http://evil.com',
      'null',
      `http://127.0.0.1:${endpoints.rpc.port + 1}`,
      `http://s-home.cc.localhost:${endpoints.gateway.port}`,
    ]) {
      const res = await sendHttpRequest({
        port: endpoints.rpc.port,
        path: '/rpc',
        method: 'POST',
        headers: {
          Host: `127.0.0.1:${endpoints.rpc.port}`,
          Origin: badOrigin,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: pingBody,
      });
      expect(res.status, `Origin "${badOrigin}" should be rejected`).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('rejects cross-origin WebSocket upgrades (403) even when token is valid', async () => {
    const daemon = await startTrackedDaemon();
    const endpoints = daemon.getEndpoints();
    const token = daemon.getToken();

    const crossOriginCases = [
      'https://evil.com',
      'http://attacker.local',
      'null',
      'http://127.0.0.1:9999',
      `http://s-home.cc.localhost:${endpoints.gateway.port}`,
    ];

    for (const badOrigin of crossOriginCases) {
      const rejected = await connectWsExpectRejected(
        `${endpoints.wsUrl}?token=${token}`,
        {
          headers: { Origin: badOrigin },
        },
      );
      expect(rejected.status, `WS Origin "${badOrigin}" should return 403`).toBe(
        403,
      );
    }

    // Also rejected with 403 when token is absent (Origin checked before token).
    const crossOriginNoToken = await connectWsExpectRejected(endpoints.wsUrl, {
      headers: { Origin: 'https://evil.com' },
    });
    expect(crossOriginNoToken.status).toBe(403);
  });

  it('rejects bad Host (403) and missing/invalid token (401) on WebSocket upgrade', async () => {
    const daemon = await startTrackedDaemon();
    const endpoints = daemon.getEndpoints();
    const token = daemon.getToken();

    const badHost = await connectWsExpectRejected(
      `${endpoints.wsUrl}?token=${token}`,
      {
        headers: { Host: `evil.com:${endpoints.rpc.port}` },
      },
    );
    expect(badHost.status).toBe(403);

    const missingToken = await connectWsExpectRejected(endpoints.wsUrl);
    expect(missingToken.status).toBe(401);

    const badQueryToken = await connectWsExpectRejected(
      `${endpoints.wsUrl}?token=${'f'.repeat(64)}`,
    );
    expect(badQueryToken.status).toBe(401);

    const badProtocolToken = await connectWsExpectRejected(endpoints.wsUrl, {
      protocols: [
        RPC_WS_PROTOCOL,
        `${RPC_WS_TOKEN_PROTOCOL_PREFIX}${'a'.repeat(64)}`,
      ],
    });
    expect(badProtocolToken.status).toBe(401);
  });

  it('accepts valid loopback WebSocket upgrades across header, subprotocol, and query auth', async () => {
    const daemon = await startTrackedDaemon();
    const endpoints = daemon.getEndpoints();
    const token = daemon.getToken();

    // 1. Authorization: Bearer header + allowed editor Origin.
    const viaBearer = await openWsAndCallRpc(endpoints.wsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: endpoints.editor.url,
      },
    });
    expect('result' in viaBearer.response).toBe(true);

    // 2. X-Codecanvas-Token header + *.localhost editor Origin.
    const viaCustomHeader = await openWsAndCallRpc(endpoints.wsUrl, {
      headers: {
        [RPC_TOKEN_HEADER]: token,
        Origin: `http://editor.cc.localhost:${endpoints.editor.port}`,
      },
    });
    expect('result' in viaCustomHeader.response).toBe(true);

    // 3. Browser-compatible Sec-WebSocket-Protocol negotiation.
    const viaSubprotocol = await openWsAndCallRpc(endpoints.wsUrl, {
      headers: { Origin: endpoints.editor.url },
      protocols: [
        RPC_WS_PROTOCOL,
        `${RPC_WS_TOKEN_PROTOCOL_PREFIX}${token}`,
      ],
    });
    expect(viaSubprotocol.protocol).toBe(RPC_WS_PROTOCOL);
    expect('result' in viaSubprotocol.response).toBe(true);

    // 4. Query parameter ?token=.
    const viaQuery = await openWsAndCallRpc(
      `${endpoints.wsUrl}?token=${token}`,
      {
        headers: { Origin: endpoints.editor.url },
      },
    );
    expect('result' in viaQuery.response).toBe(true);

    // 5. Single token subprotocol without codecanvas-rpc also negotiates cleanly.
    const singleTokenProto = `${RPC_WS_TOKEN_PROTOCOL_PREFIX}${token}`;
    const viaSingleProto = await openWsAndCallRpc(endpoints.wsUrl, {
      headers: { Origin: endpoints.editor.url },
      protocols: [singleTokenProto],
    });
    expect(viaSingleProto.protocol).toBe(singleTokenProto);
    expect('result' in viaSingleProto.response).toBe(true);
  });

  it('rejects requests with missing Host header (HTTP/1.0) and handles CORS preflight strictly', async () => {
    const daemon = await startTrackedDaemon();
    const endpoints = daemon.getEndpoints();

    // Send raw HTTP/1.0 request without Host header to RPC listener.
    const rawResponse = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(
        { host: '127.0.0.1', port: endpoints.rpc.port },
        () => {
          socket.write('GET /health HTTP/1.0\r\n\r\n');
        },
      );
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.on('error', reject);
    });
    expect(rawResponse).toContain('HTTP/1.1 403');
    expect(rawResponse).toContain('missing-host');

    // Allowed editor origin CORS preflight succeeds (204).
    const allowedPreflight = await sendHttpRequest({
      port: endpoints.rpc.port,
      path: '/rpc',
      method: 'OPTIONS',
      headers: {
        Host: `127.0.0.1:${endpoints.rpc.port}`,
        Origin: endpoints.editor.url,
      },
    });
    expect(allowedPreflight.status).toBe(204);
    expect(allowedPreflight.headers['access-control-allow-origin']).toBe(
      endpoints.editor.url,
    );

    // Cross-origin CORS preflight rejected (403) without CORS headers.
    const blockedPreflight = await sendHttpRequest({
      port: endpoints.rpc.port,
      path: '/rpc',
      method: 'OPTIONS',
      headers: {
        Host: `127.0.0.1:${endpoints.rpc.port}`,
        Origin: 'https://evil.com',
      },
    });
    expect(blockedPreflight.status).toBe(403);
    expect(blockedPreflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('enforces Host and Origin allowlists on gateway and strips daemon token headers', async () => {
    let forwardedTokenHeader: string | string[] | undefined = 'unset';
    const daemon = await startTrackedDaemon({
      onGatewayAppRequest: (req, res) => {
        forwardedTokenHeader = req.headers[RPC_TOKEN_HEADER];
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      },
    });
    const endpoints = daemon.getEndpoints();

    // Valid loopback & per-screen *.localhost Host headers accepted.
    const gwLoopback = await sendHttpRequest({
      port: endpoints.gateway.port,
      path: '/__cc/health',
      headers: {
        Host: `127.0.0.1:${endpoints.gateway.port}`,
        Origin: endpoints.editor.url,
      },
    });
    expect(gwLoopback.status).toBe(200);

    const gwSubdomain = await sendHttpRequest({
      port: endpoints.gateway.port,
      path: '/__cc/health',
      headers: {
        Host: `s-home.cc.localhost:${endpoints.gateway.port}`,
        Origin: `http://s-home.cc.localhost:${endpoints.gateway.port}`,
      },
    });
    expect(gwSubdomain.status).toBe(200);
    expect(JSON.parse(gwSubdomain.body)).toMatchObject({
      ok: true,
      role: 'gateway',
      host: 's-home.cc.localhost',
    });

    // Bad Host headers rejected (403).
    const gwBadHost = await sendHttpRequest({
      port: endpoints.gateway.port,
      path: '/__cc/health',
      headers: { Host: `evil.com:${endpoints.gateway.port}` },
    });
    expect(gwBadHost.status).toBe(403);

    const gwSneakyHost = await sendHttpRequest({
      port: endpoints.gateway.port,
      path: '/__cc/health',
      headers: { Host: `s-home.localhost.evil.com:${endpoints.gateway.port}` },
    });
    expect(gwSneakyHost.status).toBe(403);

    // Cross-origin Origin rejected (403).
    const gwBadOrigin = await sendHttpRequest({
      port: endpoints.gateway.port,
      path: '/__cc/health',
      headers: {
        Host: `127.0.0.1:${endpoints.gateway.port}`,
        Origin: 'https://evil.com',
      },
    });
    expect(gwBadOrigin.status).toBe(403);

    // Daemon RPC token header is stripped before forwarding to upstream app handler.
    const appRes = await sendHttpRequest({
      port: endpoints.gateway.port,
      path: '/app',
      headers: {
        Host: `127.0.0.1:${endpoints.gateway.port}`,
        [RPC_TOKEN_HEADER]: daemon.getToken(),
      },
    });
    expect(appRes.status).toBe(200);
    expect(forwardedTokenHeader).toBeUndefined();
  });
});
