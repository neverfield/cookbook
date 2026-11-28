export const DEFAULT_LOOPBACK_HOST = '127.0.0.1' as const;
export const RPC_TOKEN_HEADER = 'x-codecanvas-token' as const;
export const RPC_TOKEN_QUERY_PARAM = 'token' as const;
export const RPC_WS_PROTOCOL = 'codecanvas-rpc' as const;
export const RPC_WS_TOKEN_PROTOCOL_PREFIX = 'codecanvas-token.' as const;
export const RPC_HTML_TOKEN_META = 'codecanvas-rpc-token' as const;
export const RPC_HTML_URL_META = 'codecanvas-rpc-url' as const;

export type ListenerRole = 'rpc' | 'editor' | 'gateway';

export interface ListenerAddress {
  role: ListenerRole;
  host: string;
  port: number;
  family: string;
  url: string;
}

export interface DaemonSecurityConfig {
  /** Bind address for all listeners. Defaults to 127.0.0.1. */
  host: string;
  /** Must be explicitly true to bind a non-loopback address (e.g. via --host). */
  allowRemoteHost: boolean;
  /** Per-launch cryptographically random RPC token (64-char hex). */
  token: string;
  /** Additional exact origins permitted to talk to RPC/WS and gateway. */
  allowedOrigins?: readonly string[];
  /** Additional hostnames permitted in Host headers (e.g. reverse-proxy hostnames). */
  allowedHosts?: readonly string[];
}

export interface EditorBootstrapConfig {
  rpcUrl: string;
  rpcHttpUrl: string;
  gatewayUrl: string;
  token: string;
}

export interface DaemonEndpoints {
  host: string;
  rpc: ListenerAddress;
  editor: ListenerAddress;
  gateway: ListenerAddress;
  wsUrl: string;
}

export type AuthRejectionReason =
  | 'missing-host'
  | 'invalid-host'
  | 'invalid-origin'
  | 'cross-origin-ws'
  | 'missing-token'
  | 'invalid-token';

export interface PreloadHandshake {
  pid: number;
  framework: string;
  version: string;
  token: string;
}
