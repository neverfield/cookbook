import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import {
  DEFAULT_LOOPBACK_HOST,
  RPC_TOKEN_HEADER,
  RPC_TOKEN_QUERY_PARAM,
  RPC_WS_PROTOCOL,
  RPC_WS_TOKEN_PROTOCOL_PREFIX,
  type AuthRejectionReason,
} from '@codecanvas/protocol';

const LOCALHOST_SUBDOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.localhost$/;

const IPV4_LOOPBACK_RE = /^127\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

const MIN_TOKEN_LENGTH = 32;

export class SecurityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityConfigError';
  }
}

export interface BindHostOptions {
  host?: string;
  allowRemoteHost?: boolean;
}

export interface ResolvedBindHost {
  host: string;
  isLoopback: boolean;
  warning?: string;
}

export interface ParsedHostHeader {
  hostname: string;
  port: number | null;
}

export interface HostValidationPolicy {
  boundHost: string;
  allowRemoteHost: boolean;
  allowedHosts?: readonly string[];
}

export interface OriginValidationPolicy {
  exactOrigins: ReadonlySet<string>;
  loopbackSubdomainPorts: ReadonlySet<number>;
  isWebSocket?: boolean;
  requireOrigin?: boolean;
}

export type SecurityCheckResult =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 403;
      reason: AuthRejectionReason;
      message: string;
    };

export interface ExtractedWsToken {
  token: string | null;
  selectedProtocol?: string;
}

export function generateRpcToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function assertValidToken(token: string): void {
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) {
    throw new SecurityConfigError(
      `RPC token must be at least ${MIN_TOKEN_LENGTH} characters long.`,
    );
  }
}

export function verifyToken(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

export function normalizeHostname(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function isSubdomainLocalhost(hostname: string): boolean {
  return LOCALHOST_SUBDOMAIN_RE.test(normalizeHostname(hostname));
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1'
  ) {
    return true;
  }
  const ipv4Match = IPV4_LOOPBACK_RE.exec(normalized);
  if (ipv4Match) {
    const b = Number(ipv4Match[1]);
    const c = Number(ipv4Match[2]);
    const d = Number(ipv4Match[3]);
    return b <= 255 && c <= 255 && d <= 255;
  }
  return isSubdomainLocalhost(normalized);
}

export function isWildcardBindAddress(host: string): boolean {
  const normalized = normalizeHostname(host);
  return normalized === '0.0.0.0' || normalized === '::';
}

export function resolveBindHost(options: BindHostOptions = {}): ResolvedBindHost {
  const rawHost = options.host?.trim();
  if (!rawHost) {
    return {
      host: DEFAULT_LOOPBACK_HOST,
      isLoopback: true,
    };
  }

  const normalized = normalizeHostname(rawHost);
  if (isLoopbackHost(normalized)) {
    return {
      host: normalized,
      isLoopback: true,
    };
  }

  if (!options.allowRemoteHost) {
    throw new SecurityConfigError(
      `Refusing to bind non-loopback host "${rawHost}" without explicit opt-in (--host / allowRemoteHost: true).`,
    );
  }

  return {
    host: normalized,
    isLoopback: false,
    warning:
      `WARNING: Binding codecanvas daemon to non-loopback host "${normalized}". ` +
      'Remote network interfaces may reach these listeners; per-launch RPC token, Host, and Origin checks remain enforced.',
  };
}

export function parseHostHeader(
  rawHost: string | undefined,
): ParsedHostHeader | null {
  if (!rawHost || rawHost.length === 0) {
    return null;
  }
  if (/[\s/\\@,]/.test(rawHost)) {
    return null;
  }
  // Reject ASCII control characters.
  for (let i = 0; i < rawHost.length; i += 1) {
    const code = rawHost.charCodeAt(i);
    if (code < 0x21 || code === 0x7f) {
      return null;
    }
  }

  let hostname: string;
  let portStr: string | null = null;

  if (rawHost.startsWith('[')) {
    const closeIdx = rawHost.indexOf(']');
    if (closeIdx <= 1) {
      return null;
    }
    hostname = rawHost.slice(1, closeIdx).toLowerCase();
    const remainder = rawHost.slice(closeIdx + 1);
    if (remainder.length > 0) {
      if (!remainder.startsWith(':')) {
        return null;
      }
      portStr = remainder.slice(1);
    }
  } else {
    const firstColon = rawHost.indexOf(':');
    const lastColon = rawHost.lastIndexOf(':');
    if (firstColon !== lastColon) {
      return null;
    }
    if (firstColon !== -1) {
      hostname = rawHost.slice(0, firstColon).toLowerCase();
      portStr = rawHost.slice(firstColon + 1);
    } else {
      hostname = rawHost.toLowerCase();
    }
  }

  if (hostname.length === 0) {
    return null;
  }

  let port: number | null = null;
  if (portStr !== null) {
    if (!/^[1-9]\d*$/.test(portStr)) {
      return null;
    }
    const parsed = Number(portStr);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return null;
    }
    port = parsed;
  }

  return { hostname, port };
}

function getLocalInterfaceAddresses(): Set<string> {
  const result = new Set<string>();
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      result.add(normalizeHostname(entry.address));
    }
  }
  return result;
}

export function isAllowedHostname(
  hostname: string,
  policy: HostValidationPolicy,
): boolean {
  const normalized = normalizeHostname(hostname);
  if (isLoopbackHost(normalized)) {
    return true;
  }
  if (policy.allowedHosts) {
    for (const extra of policy.allowedHosts) {
      if (normalizeHostname(extra) === normalized) {
        return true;
      }
    }
  }
  if (policy.allowRemoteHost) {
    const bound = normalizeHostname(policy.boundHost);
    if (isWildcardBindAddress(bound)) {
      if (getLocalInterfaceAddresses().has(normalized)) {
        return true;
      }
    } else if (bound === normalized) {
      return true;
    }
  }
  return false;
}

export function validateHostHeader(
  rawHost: string | undefined,
  expectedPort: number,
  policy: HostValidationPolicy,
): SecurityCheckResult {
  if (rawHost === undefined || rawHost.length === 0) {
    return {
      ok: false,
      status: 403,
      reason: 'missing-host',
      message: 'Missing Host header.',
    };
  }

  const parsed = parseHostHeader(rawHost);
  if (!parsed) {
    return {
      ok: false,
      status: 403,
      reason: 'invalid-host',
      message: 'Malformed Host header.',
    };
  }

  if (!isAllowedHostname(parsed.hostname, policy)) {
    return {
      ok: false,
      status: 403,
      reason: 'invalid-host',
      message: `Disallowed Host header "${parsed.hostname}".`,
    };
  }

  const effectivePort = parsed.port ?? 80;
  if (effectivePort !== expectedPort) {
    return {
      ok: false,
      status: 403,
      reason: 'invalid-host',
      message: `Host header port ${effectivePort} does not match listener port ${expectedPort}.`,
    };
  }

  return { ok: true };
}

export function buildLoopbackOriginsForPort(
  port: number,
  boundHost: string,
  allowRemoteHost: boolean,
  allowedHosts?: readonly string[],
): string[] {
  const hosts = new Set<string>(['127.0.0.1', 'localhost', '[::1]']);
  const normalizedBound = normalizeHostname(boundHost);
  if (isLoopbackHost(normalizedBound)) {
    hosts.add(normalizedBound.includes(':') ? `[${normalizedBound}]` : normalizedBound);
  } else if (allowRemoteHost) {
    if (isWildcardBindAddress(normalizedBound)) {
      for (const ip of getLocalInterfaceAddresses()) {
        hosts.add(ip.includes(':') ? `[${ip}]` : ip);
      }
    } else {
      hosts.add(normalizedBound.includes(':') ? `[${normalizedBound}]` : normalizedBound);
    }
  }
  if (allowedHosts) {
    for (const h of allowedHosts) {
      const n = normalizeHostname(h);
      hosts.add(n.includes(':') ? `[${n}]` : n);
    }
  }

  const origins: string[] = [];
  for (const h of hosts) {
    origins.push(port === 80 ? `http://${h}` : `http://${h}:${port}`);
  }
  return origins;
}

export function validateOriginHeader(
  rawOrigin: string | undefined,
  policy: OriginValidationPolicy,
): SecurityCheckResult {
  const rejectReason: AuthRejectionReason = policy.isWebSocket
    ? 'cross-origin-ws'
    : 'invalid-origin';

  if (rawOrigin === undefined) {
    if (policy.requireOrigin) {
      return {
        ok: false,
        status: 403,
        reason: rejectReason,
        message: 'Missing Origin header.',
      };
    }
    return { ok: true };
  }

  if (rawOrigin.length === 0 || rawOrigin === 'null') {
    return {
      ok: false,
      status: 403,
      reason: rejectReason,
      message: 'Disallowed null or empty Origin header.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    return {
      ok: false,
      status: 403,
      reason: rejectReason,
      message: 'Malformed Origin header.',
    };
  }

  if (parsed.origin !== rawOrigin) {
    return {
      ok: false,
      status: 403,
      reason: rejectReason,
      message: 'Origin header must be a canonical scheme://host[:port].',
    };
  }

  if (policy.exactOrigins.has(rawOrigin)) {
    return { ok: true };
  }

  if (parsed.protocol === 'http:' && isSubdomainLocalhost(parsed.hostname)) {
    const port = parsed.port ? Number(parsed.port) : 80;
    if (policy.loopbackSubdomainPorts.has(port)) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    status: 403,
    reason: rejectReason,
    message: `Disallowed Origin "${rawOrigin}".`,
  };
}

function parseBearerToken(authHeader: string | string[] | undefined): string | null {
  if (typeof authHeader !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  return match?.[1] ?? null;
}

function parseCustomTokenHeader(
  header: string | string[] | undefined,
): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const trimmed = header.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractHttpRpcToken(req: IncomingMessage): string | null {
  const fromAuth = parseBearerToken(req.headers.authorization);
  if (fromAuth) {
    return fromAuth;
  }
  return parseCustomTokenHeader(req.headers[RPC_TOKEN_HEADER]);
}

export function extractWsRpcToken(req: IncomingMessage): ExtractedWsToken {
  const headerToken = extractHttpRpcToken(req);

  const rawProtoHeader = req.headers['sec-websocket-protocol'];
  let protocolToken: string | null = null;
  let selectedProtocol: string | undefined;

  if (typeof rawProtoHeader === 'string' && rawProtoHeader.trim().length > 0) {
    const protocols = rawProtoHeader
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    const hasMainProtocol = protocols.includes(RPC_WS_PROTOCOL);
    let matchedTokenProto: string | undefined;
    for (const proto of protocols) {
      if (proto.startsWith(RPC_WS_TOKEN_PROTOCOL_PREFIX)) {
        const candidate = proto.slice(RPC_WS_TOKEN_PROTOCOL_PREFIX.length);
        if (candidate.length > 0) {
          protocolToken = candidate;
          matchedTokenProto = proto;
          break;
        }
      }
    }

    if (hasMainProtocol) {
      selectedProtocol = RPC_WS_PROTOCOL;
    } else if (matchedTokenProto) {
      selectedProtocol = matchedTokenProto;
    }
  }

  let queryToken: string | null = null;
  if (req.url) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const param = parsed.searchParams.get(RPC_TOKEN_QUERY_PARAM);
      if (param && param.length > 0) {
        queryToken = param;
      }
    } catch {
      queryToken = null;
    }
  }

  return {
    token: headerToken ?? protocolToken ?? queryToken,
    selectedProtocol,
  };
}

export function authenticateRpcToken(
  provided: string | null,
  expected: string,
): SecurityCheckResult {
  if (provided === null || provided.length === 0) {
    return {
      ok: false,
      status: 401,
      reason: 'missing-token',
      message: 'Missing RPC authentication token.',
    };
  }
  if (!verifyToken(provided, expected)) {
    return {
      ok: false,
      status: 401,
      reason: 'invalid-token',
      message: 'Invalid RPC authentication token.',
    };
  }
  return { ok: true };
}

export function formatHostForUrl(host: string): string {
  const normalized = normalizeHostname(host);
  return normalized.includes(':') ? `[${normalized}]` : normalized;
}
