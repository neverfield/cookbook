# codecanvas: architecture (as built)

This document records what is currently built and verified under `skills/codecanvas/`. Unimplemented v2 work packages are tracked in the v2 implementation plan and are intentionally omitted from "as built" claims until their acceptance tests pass.

## Workspace Structure

```text
skills/codecanvas/
├── SKILL.md                  # Cursor skill entry point (v2 product contract)
├── package.json              # Root pnpm workspace scripts (build, typecheck, test)
├── pnpm-workspace.yaml       # Workspace packages: packages/*
├── tsconfig.base.json        # Strict ESM/NodeNext TypeScript compiler defaults
├── docs/
│   └── ARCHITECTURE.md       # This document
└── packages/
    ├── protocol/             # @codecanvas/protocol
    └── daemon/               # @codecanvas/daemon
```

## Implemented Work Packages

### WP0.1 — Local Loopback Daemon & Authentication (Invariant I8)

Implemented in `@codecanvas/protocol` (`packages/protocol/`) and `@codecanvas/daemon` (`packages/daemon/`).

#### Packages

- **`@codecanvas/protocol`** (`packages/protocol/src/`):
  - `rpc.ts`: JSON-RPC 2.0 envelope types (`JsonRpcRequest`, `JsonRpcNotification`, `JsonRpcResponse`), standard + codecanvas error codes (`RPC_ERROR_CODES`), request type guard (`isJsonRpcRequest`), and response helpers (`makeRpcSuccess`, `makeRpcError`).
  - `security.ts`: Loopback/auth constants (`DEFAULT_LOOPBACK_HOST`, `RPC_TOKEN_HEADER`, `RPC_TOKEN_QUERY_PARAM`, `RPC_WS_PROTOCOL`, `RPC_WS_TOKEN_PROTOCOL_PREFIX`, `RPC_HTML_TOKEN_META`, `RPC_HTML_URL_META`) and config/endpoint types (`DaemonSecurityConfig`, `EditorBootstrapConfig`, `DaemonEndpoints`, `ListenerAddress`, `AuthRejectionReason`, `PreloadHandshake`).
  - `adapters.ts`: Adapter seam placeholder interfaces matching v2 §5 (`FrameworkAdapter`, `LanguageAdapter`, `StyleAdapter`, `FlowSource`, `StateInjector`, `DataSource`, `AgentRunner`) and `SourceRef` shape (§4.2) to keep core packages adapter-agnostic (Invariant I9).

- **`@codecanvas/daemon`** (`packages/daemon/src/`):
  - `security.ts`: Host/loopback resolution (`isLoopbackHost`, `resolveBindHost`, `SecurityConfigError`), constant-time token comparison (`generateRpcToken`, `verifyToken`, `authenticateRpcToken`), strict `Host` header parser/validator (`parseHostHeader`, `validateHostHeader`), exact `Origin` validator (`validateOriginHeader`), and HTTP/WS token extractors (`extractHttpRpcToken`, `extractWsRpcToken`).
  - `rpc-server.ts`: HTTP (`POST /rpc`, `OPTIONS /rpc`, `GET /health`) and WebSocket (`/rpc`, `/ws`) JSON-RPC 2.0 server with 1 MB body/payload cap and fail-closed upgrade rejection before completing the WebSocket handshake.
  - `editor.ts`: Editor HTTP listener serving HTML at `/` and `/index.html` with injected `<meta name="codecanvas-rpc-token">`, `<meta name="codecanvas-rpc-url">`, and frozen `window.__CODECANVAS_CONFIG__`, plus `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`.
  - `gateway.ts`: App/screen HTTP gateway enforcing strict `Host` and `Origin` allowlists (`127.0.0.1`, `localhost`, `[::1]`, `*.localhost`) and stripping `x-codecanvas-token` so daemon credentials never cross the gateway boundary.
  - `server.ts`: `DaemonServer` orchestrating all three listeners (`rpc`, `editor`, `gateway`) on dynamic ephemeral ports by default, registering baseline RPC methods (`daemon/ping`, `daemon/info`), and tearing down active WebSocket connections and HTTP servers cleanly on `stop()`.
  - `cli.ts`: CLI flag parser (`parseDaemonCliArgs`) and launcher (`startDaemonFromCli`) supporting `--host`, `--rpc-port`, `--editor-port`, `--gateway-port`, `--allowed-origin`, and `--allowed-host`.

#### Security Guarantees Enforced

1. **Loopback by default:** All listeners (`rpc`, `editor`, `gateway`) bind `127.0.0.1` by default. Passing a non-loopback address programmatically without `allowRemoteHost: true` throws `SecurityConfigError`. Passing `--host <non-loopback>` on the CLI explicitly opts in and emits a warning while keeping token, `Host`, and `Origin` checks enforced.
2. **Per-launch RPC token:** Each `DaemonServer` generates a fresh 256-bit hex token (`crypto.randomBytes(32).toString('hex')`), verified in constant time via `crypto.timingSafeEqual`.
   - Injected into editor HTML served from the editor listener (which itself enforces `Host` and `Origin` checks and `Cache-Control: no-store`).
   - Required on HTTP RPC via `Authorization: Bearer <token>` or `X-Codecanvas-Token: <token>` (missing/invalid returns `401 Unauthorized` with `WWW-Authenticate: Bearer realm="codecanvas"`).
   - Required on WebSocket upgrade via `Authorization`, `X-Codecanvas-Token`, `Sec-WebSocket-Protocol` (`codecanvas-token.<token>`, negotiating `codecanvas-rpc` when offered), or `?token=<token>` (missing/invalid rejects the HTTP upgrade with `401 Unauthorized`).
   - Never returned in `daemon/info`, CLI startup JSON logs, or gateway upstream requests.
3. **Strict `Host` and `Origin` validation:**
   - Check order on RPC/WS: `Host` (403) → `Origin` (403) → Token (401).
   - `Host` must match an allowed loopback hostname (`127.0.0.1`, `localhost`, `[::1]`, or strict RFC 1035 `*.localhost`) — or the explicitly opted-in host — and the listener's exact port. Missing, malformed, wrong-port, or DNS-rebinding `Host` headers return `403 Forbidden`.
   - When `Origin` is present on RPC/WS, only exact editor/RPC origins (and `http://*.localhost:<editorPort|rpcPort>`) are allowed; cross-origin requests, `Origin: null`, unrelated localhost ports, and gateway screen origins (`http://s-<id>.cc.localhost:<gatewayPort>`) are rejected with `403 Forbidden`.
   - On the gateway listener, `Host` and `Origin` accept loopback and `*.localhost` screen/editor origins on matching ports and reject all other hosts/origins with `403 Forbidden`.

#### Verification

Verified via `packages/daemon/test/security.test.ts` (12 tests, ephemeral port `0` only, no ports in `4400-4410` or `4600`):
- `pnpm -r --if-present typecheck`: pass (both before and after `pnpm build`).
- `pnpm test`: 12/12 passing in `packages/daemon/test/security.test.ts`.
- `pnpm build`: clean ESM + `.d.ts` emit for `@codecanvas/protocol` and `@codecanvas/daemon`.
- Compiled CLI smoke test (`node packages/daemon/dist/cli.js`): binds `127.0.0.1`, logs endpoints without leaking token, shuts down cleanly on `SIGTERM`.
