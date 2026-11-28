import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type DaemonEndpoints,
  type EditorBootstrapConfig,
  type ListenerAddress,
  type ListenerRole,
} from '@codecanvas/protocol';
import { createEditorServer } from './editor.js';
import { createGatewayServer } from './gateway.js';
import {
  createRpcServer,
  type RpcMethodHandler,
  type RpcServerHandle,
} from './rpc-server.js';
import {
  assertValidToken,
  buildLoopbackOriginsForPort,
  formatHostForUrl,
  generateRpcToken,
  resolveBindHost,
  type HostValidationPolicy,
  type OriginValidationPolicy,
} from './security.js';

export const DAEMON_VERSION = '0.1.0';

export interface DaemonServerOptions {
  /** Bind address for all listeners. Defaults to 127.0.0.1. */
  host?: string;
  /** Explicit opt-in required when binding a non-loopback host. */
  allowRemoteHost?: boolean;
  /** Ephemeral port 0 by default. */
  rpcPort?: number;
  /** Ephemeral port 0 by default. */
  editorPort?: number;
  /** Ephemeral port 0 by default. */
  gatewayPort?: number;
  /** Override per-launch random token (primarily for deterministic tests). */
  token?: string;
  /** Additional exact allowed Origin values. */
  allowedOrigins?: readonly string[];
  /** Additional allowed Host header hostnames. */
  allowedHosts?: readonly string[];
  /** Optional handler for proxied app requests on the gateway listener. */
  onGatewayAppRequest?: (
    req: IncomingMessage,
    res: ServerResponse,
  ) => void | Promise<void>;
  /** Optional warning sink (defaults to console.warn when non-loopback). */
  onWarning?: (message: string) => void;
}

function listenServer(
  server: Server,
  host: string,
  port: number,
  role: ListenerRole,
): Promise<ListenerAddress> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error(`Unexpected non-TCP address for ${role} listener.`));
        return;
      }
      const info = addr as AddressInfo;
      const urlHost = formatHostForUrl(info.address);
      resolve({
        role,
        host: info.address,
        port: info.port,
        family: info.family,
        url: `http://${urlHost}:${info.port}`,
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export class DaemonServer {
  private readonly host: string;
  private readonly allowRemoteHost: boolean;
  private readonly warning?: string;
  private readonly token: string;
  private readonly rpcPortRequested: number;
  private readonly editorPortRequested: number;
  private readonly gatewayPortRequested: number;
  private readonly allowedOrigins: readonly string[];
  private readonly allowedHosts: readonly string[];
  private readonly onGatewayAppRequest?: (
    req: IncomingMessage,
    res: ServerResponse,
  ) => void | Promise<void>;
  private readonly onWarning?: (message: string) => void;

  private readonly methods = new Map<string, RpcMethodHandler>();

  private rpcHandle: RpcServerHandle | null = null;
  private editorServer: Server | null = null;
  private gatewayServer: Server | null = null;
  private endpoints: DaemonEndpoints | null = null;

  constructor(options: DaemonServerOptions = {}) {
    const resolved = resolveBindHost({
      host: options.host,
      allowRemoteHost: options.allowRemoteHost,
    });
    this.host = resolved.host;
    this.allowRemoteHost = Boolean(options.allowRemoteHost);
    this.warning = resolved.warning;

    if (options.token !== undefined) {
      assertValidToken(options.token);
      this.token = options.token;
    } else {
      this.token = generateRpcToken();
    }

    this.rpcPortRequested = options.rpcPort ?? 0;
    this.editorPortRequested = options.editorPort ?? 0;
    this.gatewayPortRequested = options.gatewayPort ?? 0;
    this.allowedOrigins = options.allowedOrigins ?? [];
    this.allowedHosts = options.allowedHosts ?? [];
    this.onGatewayAppRequest = options.onGatewayAppRequest;
    this.onWarning = options.onWarning;

    this.registerDefaultMethods();
  }

  private registerDefaultMethods(): void {
    this.methods.set('daemon/ping', () => ({
      ok: true,
      timestamp: Date.now(),
    }));
    this.methods.set('daemon/info', () => {
      const endpoints = this.getEndpoints();
      return {
        version: DAEMON_VERSION,
        host: endpoints.host,
        listeners: {
          rpc: endpoints.rpc,
          editor: endpoints.editor,
          gateway: endpoints.gateway,
        },
      };
    });
  }

  registerMethod(name: string, handler: RpcMethodHandler): void {
    this.methods.set(name, handler);
  }

  getToken(): string {
    return this.token;
  }

  getWarning(): string | undefined {
    return this.warning;
  }

  getEndpoints(): DaemonEndpoints {
    if (!this.endpoints) {
      throw new Error('DaemonServer is not started.');
    }
    return this.endpoints;
  }

  private getHostPolicy(): HostValidationPolicy {
    return {
      boundHost: this.host,
      allowRemoteHost: this.allowRemoteHost,
      allowedHosts: this.allowedHosts,
    };
  }

  private getRpcOriginPolicy(isWebSocket: boolean): OriginValidationPolicy {
    const endpoints = this.getEndpoints();
    const exact = new Set<string>(this.allowedOrigins);
    for (const origin of buildLoopbackOriginsForPort(
      endpoints.editor.port,
      this.host,
      this.allowRemoteHost,
      this.allowedHosts,
    )) {
      exact.add(origin);
    }
    for (const origin of buildLoopbackOriginsForPort(
      endpoints.rpc.port,
      this.host,
      this.allowRemoteHost,
      this.allowedHosts,
    )) {
      exact.add(origin);
    }

    return {
      exactOrigins: exact,
      loopbackSubdomainPorts: new Set([
        endpoints.editor.port,
        endpoints.rpc.port,
      ]),
      isWebSocket,
    };
  }

  private getEditorOriginPolicy(): OriginValidationPolicy {
    const endpoints = this.getEndpoints();
    const exact = new Set<string>(this.allowedOrigins);
    for (const origin of buildLoopbackOriginsForPort(
      endpoints.editor.port,
      this.host,
      this.allowRemoteHost,
      this.allowedHosts,
    )) {
      exact.add(origin);
    }
    return {
      exactOrigins: exact,
      loopbackSubdomainPorts: new Set([endpoints.editor.port]),
    };
  }

  private getGatewayOriginPolicy(): OriginValidationPolicy {
    const endpoints = this.getEndpoints();
    const exact = new Set<string>(this.allowedOrigins);
    for (const origin of buildLoopbackOriginsForPort(
      endpoints.gateway.port,
      this.host,
      this.allowRemoteHost,
      this.allowedHosts,
    )) {
      exact.add(origin);
    }
    for (const origin of buildLoopbackOriginsForPort(
      endpoints.editor.port,
      this.host,
      this.allowRemoteHost,
      this.allowedHosts,
    )) {
      exact.add(origin);
    }
    return {
      exactOrigins: exact,
      loopbackSubdomainPorts: new Set([
        endpoints.gateway.port,
        endpoints.editor.port,
      ]),
    };
  }

  private getEditorBootstrapConfig(): EditorBootstrapConfig {
    const endpoints = this.getEndpoints();
    return {
      rpcUrl: endpoints.wsUrl,
      rpcHttpUrl: `${endpoints.rpc.url}/rpc`,
      gatewayUrl: endpoints.gateway.url,
      token: this.token,
    };
  }

  async start(): Promise<DaemonEndpoints> {
    if (this.endpoints) {
      return this.endpoints;
    }

    if (this.warning && this.onWarning) {
      this.onWarning(this.warning);
    }

    let rpcPort = 0;
    let editorPort = 0;
    let gatewayPort = 0;

    const rpcHandle = createRpcServer({
      getPort: () => rpcPort,
      getToken: () => this.token,
      getHostPolicy: () => this.getHostPolicy(),
      getHttpOriginPolicy: () => this.getRpcOriginPolicy(false),
      getWsOriginPolicy: () => this.getRpcOriginPolicy(true),
      methods: this.methods,
    });

    const editorServer = createEditorServer({
      getPort: () => editorPort,
      getHostPolicy: () => this.getHostPolicy(),
      getOriginPolicy: () => this.getEditorOriginPolicy(),
      getBootstrapConfig: () => this.getEditorBootstrapConfig(),
    });

    const gatewayServer = createGatewayServer({
      getPort: () => gatewayPort,
      getHostPolicy: () => this.getHostPolicy(),
      getOriginPolicy: () => this.getGatewayOriginPolicy(),
      onAppRequest: this.onGatewayAppRequest,
    });

    this.rpcHandle = rpcHandle;
    this.editorServer = editorServer;
    this.gatewayServer = gatewayServer;

    try {
      const [rpcAddr, editorAddr, gatewayAddr] = await Promise.all([
        listenServer(
          rpcHandle.httpServer,
          this.host,
          this.rpcPortRequested,
          'rpc',
        ),
        listenServer(
          editorServer,
          this.host,
          this.editorPortRequested,
          'editor',
        ),
        listenServer(
          gatewayServer,
          this.host,
          this.gatewayPortRequested,
          'gateway',
        ),
      ]);

      rpcPort = rpcAddr.port;
      editorPort = editorAddr.port;
      gatewayPort = gatewayAddr.port;

      const wsHost = formatHostForUrl(rpcAddr.host);
      this.endpoints = {
        host: this.host,
        rpc: rpcAddr,
        editor: editorAddr,
        gateway: gatewayAddr,
        wsUrl: `ws://${wsHost}:${rpcAddr.port}/rpc`,
      };

      return this.endpoints;
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    const rpcHandle = this.rpcHandle;
    const editorServer = this.editorServer;
    const gatewayServer = this.gatewayServer;

    this.rpcHandle = null;
    this.editorServer = null;
    this.gatewayServer = null;
    this.endpoints = null;

    if (rpcHandle) {
      rpcHandle.closeConnections();
    }

    await Promise.all([
      rpcHandle ? closeServer(rpcHandle.httpServer) : Promise.resolve(),
      editorServer ? closeServer(editorServer) : Promise.resolve(),
      gatewayServer ? closeServer(gatewayServer) : Promise.resolve(),
    ]);
  }
}
