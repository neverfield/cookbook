import { pathToFileURL } from 'node:url';
import { DEFAULT_LOOPBACK_HOST } from '@codecanvas/protocol';
import { SecurityConfigError, isLoopbackHost } from './security.js';
import { DaemonServer, type DaemonServerOptions } from './server.js';

export interface ParsedDaemonCliOptions extends DaemonServerOptions {
  host: string;
  allowRemoteHost: boolean;
  allowedOrigins: string[];
  allowedHosts: string[];
}

function parsePortFlag(flag: string, rawValue: string | undefined): number {
  if (!rawValue || !/^\d+$/.test(rawValue)) {
    throw new SecurityConfigError(`Flag ${flag} requires a numeric port (0-65535).`);
  }
  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new SecurityConfigError(`Flag ${flag} port out of range: ${rawValue}`);
  }
  return port;
}

export function parseDaemonCliArgs(
  argv: readonly string[],
): ParsedDaemonCliOptions {
  let host: string = DEFAULT_LOOPBACK_HOST;
  let allowRemoteHost = false;
  let rpcPort = 0;
  let editorPort = 0;
  let gatewayPort = 0;
  const allowedOrigins: string[] = [];
  const allowedHosts: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--host') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new SecurityConfigError('Flag --host requires a hostname or IP value.');
      }
      host = value;
      allowRemoteHost = !isLoopbackHost(value);
      i += 1;
      continue;
    }

    if (arg.startsWith('--host=')) {
      const value = arg.slice('--host='.length);
      if (!value) {
        throw new SecurityConfigError('Flag --host requires a hostname or IP value.');
      }
      host = value;
      allowRemoteHost = !isLoopbackHost(value);
      continue;
    }

    if (arg === '--rpc-port') {
      rpcPort = parsePortFlag('--rpc-port', argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--rpc-port=')) {
      rpcPort = parsePortFlag('--rpc-port', arg.slice('--rpc-port='.length));
      continue;
    }

    if (arg === '--editor-port') {
      editorPort = parsePortFlag('--editor-port', argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--editor-port=')) {
      editorPort = parsePortFlag(
        '--editor-port',
        arg.slice('--editor-port='.length),
      );
      continue;
    }

    if (arg === '--gateway-port') {
      gatewayPort = parsePortFlag('--gateway-port', argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--gateway-port=')) {
      gatewayPort = parsePortFlag(
        '--gateway-port',
        arg.slice('--gateway-port='.length),
      );
      continue;
    }

    if (arg === '--allowed-origin') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new SecurityConfigError('Flag --allowed-origin requires an origin URL.');
      }
      allowedOrigins.push(value);
      i += 1;
      continue;
    }
    if (arg.startsWith('--allowed-origin=')) {
      const value = arg.slice('--allowed-origin='.length);
      if (!value) {
        throw new SecurityConfigError('Flag --allowed-origin requires an origin URL.');
      }
      allowedOrigins.push(value);
      continue;
    }

    if (arg === '--allowed-host') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new SecurityConfigError('Flag --allowed-host requires a hostname.');
      }
      allowedHosts.push(value);
      i += 1;
      continue;
    }
    if (arg.startsWith('--allowed-host=')) {
      const value = arg.slice('--allowed-host='.length);
      if (!value) {
        throw new SecurityConfigError('Flag --allowed-host requires a hostname.');
      }
      allowedHosts.push(value);
      continue;
    }

    throw new SecurityConfigError(`Unknown CLI flag: ${arg}`);
  }

  return {
    host,
    allowRemoteHost,
    rpcPort,
    editorPort,
    gatewayPort,
    allowedOrigins,
    allowedHosts,
  };
}

export async function startDaemonFromCli(
  argv: readonly string[],
  io: {
    log?: (message: string) => void;
    warn?: (message: string) => void;
  } = {},
): Promise<DaemonServer> {
  const log = io.log ?? ((msg: string) => console.log(msg));
  const warn = io.warn ?? ((msg: string) => console.warn(msg));

  const parsed = parseDaemonCliArgs(argv);
  const daemon = new DaemonServer({
    ...parsed,
    onWarning: warn,
  });

  const endpoints = await daemon.start();
  log(
    JSON.stringify({
      status: 'listening',
      host: endpoints.host,
      editorUrl: endpoints.editor.url,
      rpcUrl: endpoints.rpc.url,
      wsUrl: endpoints.wsUrl,
      gatewayUrl: endpoints.gateway.url,
    }),
  );
  return daemon;
}

const isDirectEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  startDaemonFromCli(process.argv.slice(2))
    .then((daemon) => {
      const shutdown = () => {
        void daemon.stop().finally(() => {
          process.exit(0);
        });
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
