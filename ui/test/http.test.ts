import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUiServer, listenWithRetry, safeJoin } from '../server/http.js';
import { cleanupAll, makeDb, seedGraph, tempDir } from './fixtures.js';

afterEach(cleanupAll);

// Structural server shape shared by net.Server (occupiers) and http.Server (ui).
interface TestServer {
  address(): { port: number } | string | null;
  close(callback?: () => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  listen(port: number, host: string, callback?: () => void): unknown;
}

const listen = async (server: TestServer, port = 0): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('no address'));
    });
  });

const close = (server: { close(callback?: () => void): unknown }): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

const get = async (port: number, path: string): Promise<{ status: number; body: string }> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.text() };
};

describe('createUiServer endpoints', () => {
  it('serves graph payloads and api errors as JSON', async () => {
    const db = makeDb();
    const ids = seedGraph(db);
    const server = createUiServer({ db });
    const port = await listen(server);
    try {
      const graph = await get(port, '/api/graph');
      expect(graph.status).toBe(200);
      const parsed = JSON.parse(graph.body) as { nodes: unknown[]; edges: unknown[] };
      expect(parsed.nodes).toHaveLength(3);
      expect(parsed.edges).toHaveLength(2);

      const missing = await get(port, `/api/memory/${encodeURIComponent('nope')}`);
      expect(missing.status).toBe(404);
      expect(JSON.parse(missing.body)).toHaveProperty('error');

      const detail = await get(port, `/api/memory/${encodeURIComponent(ids.procedureId)}`);
      expect(detail.status).toBe(200);
      expect(JSON.parse(detail.body)).toHaveProperty('breakdown');

      const unknown = await get(port, '/api/nope');
      expect(unknown.status).toBe(404);
      expect(JSON.parse(unknown.body)).toHaveProperty('error');
    } finally {
      await close(server);
      db.close();
    }
  });

  it('rejects non-GET methods', async () => {
    const db = makeDb();
    const server = createUiServer({ db });
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/graph`, { method: 'POST' });
      expect(res.status).toBe(405);
    } finally {
      await close(server);
      db.close();
    }
  });

  it('returns 404 for static paths when no staticDir is configured', async () => {
    const db = makeDb();
    const server = createUiServer({ db });
    const port = await listen(server);
    try {
      const res = await get(port, '/');
      expect(res.status).toBe(404);
    } finally {
      await close(server);
      db.close();
    }
  });
});

describe('static serving', () => {
  it('serves index.html at / and falls back to it for SPA routes; blocks traversal', async () => {
    const dir = tempDir();
    const appDir = join(dir, 'app');
    mkdirSync(appDir);
    writeFileSync(join(appDir, 'index.html'), '<html>ok</html>');
    writeFileSync(join(dir, 'secret.txt'), 'nope');

    const db = makeDb();
    const server = createUiServer({ db, staticDir: appDir });
    const port = await listen(server);
    try {
      const root = await get(port, '/');
      expect(root.status).toBe(200);
      expect(root.body).toContain('ok');

      const spa = await get(port, '/some/client/route');
      expect(spa.status).toBe(200);
      expect(spa.body).toContain('ok');

      // WHATWG URL normalization collapses %2e%2e before our handler runs, so
      // this lands on the SPA fallback rather than the sibling secret.
      const traversal = await get(port, '/%2e%2e/secret.txt');
      expect(traversal.body).not.toContain('nope');
    } finally {
      await close(server);
      db.close();
    }
  });

  it('safeJoin rejects paths escaping staticDir', () => {
    const dir = tempDir();
    expect(safeJoin(dir, '/index.html')).toBe(join(dir, 'index.html'));
    expect(safeJoin(dir, '/../secret.txt')).toBeUndefined();
    expect(safeJoin(dir, '/%2e%2e/secret.txt')).toBeUndefined();
    expect(safeJoin(dir, '/a/../../secret.txt')).toBeUndefined();
  });
});

describe('listenWithRetry', () => {
  it('increments the port on EADDRINUSE', async () => {
    const occupier = net.createServer();
    const occupiedPort = await listen(occupier);
    const db = makeDb();
    const ui = createUiServer({ db });
    try {
      const bound = await listenWithRetry(ui, occupiedPort, '127.0.0.1', 5);
      expect(bound).toBeGreaterThan(occupiedPort);
      expect(ui.listening).toBe(true);
      await close(ui);
    } finally {
      await close(occupier);
      db.close();
    }
  });

  it('rejects once the attempt budget is exhausted', async () => {
    const first = net.createServer();
    const basePort = await listen(first);
    const second = net.createServer();
    let nextPort = -1;
    for (let candidate = basePort + 1; candidate < basePort + 50; candidate += 1) {
      try {
        nextPort = await listen(second, candidate);
        break;
      } catch {
        continue;
      }
    }
    expect(nextPort).toBe(basePort + 1); // both consecutive ports must be held
    const db = makeDb();
    const ui = createUiServer({ db });
    try {
      await expect(listenWithRetry(ui, basePort, '127.0.0.1', 2)).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
    } finally {
      await close(first);
      await close(second);
      db.close();
    }
  });
});
