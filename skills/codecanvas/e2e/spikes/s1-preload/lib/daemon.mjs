import crypto from 'node:crypto';
import http from 'node:http';

const FORBIDDEN_PORTS = new Set([
  4400, 4401, 4402, 4403, 4404, 4405, 4406, 4407, 4408, 4409, 4410, 4600
]);

/**
 * Minimal loopback-only handshake daemon for Spike S1 (§3.4, I8).
 * Binds strictly to 127.0.0.1 with a per-launch bearer token.
 */
export async function startHandshakeDaemon() {
  const token = crypto.randomBytes(24).toString('hex');
  const handshakes = [];
  const waiters = [];

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/handshake') {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          payload.receivedAt = Date.now();
          handshakes.push(payload);
          while (waiters.length > 0) {
            const w = waiters.shift();
            w.resolve(payload);
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  // Bind to an ephemeral loopback port guaranteed outside forbidden range
  const port = await new Promise((resolve, reject) => {
    const tryListen = () => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const addr = server.address();
        if (FORBIDDEN_PORTS.has(addr.port)) {
          server.close(tryListen);
          return;
        }
        resolve(addr.port);
      });
    };
    tryListen();
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    handshakes,

    waitForHandshake(timeoutMs = 15000) {
      if (handshakes.length > 0) {
        return Promise.resolve(handshakes[0]);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(
            new Error(
              `Preload handshake timeout after ${timeoutMs}ms (received 0 handshakes; dev script may have stripped NODE_OPTIONS or launched an uninstrumented process)`
            )
          );
        }, timeoutMs);

        const entry = {
          resolve: (payload) => {
            clearTimeout(timer);
            resolve(payload);
          }
        };
        waiters.push(entry);
      });
    },

    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
