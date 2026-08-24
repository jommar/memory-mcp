import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { openDatabase } from '../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../src/db/schema.js';
import { createServerFactory } from '../src/server.js';
import {
  createHttpHandler,
  main,
  resolveTransport,
  serveStdioServer,
  startHttpServer,
} from '../src/index.js';

vi.mock('@modelcontextprotocol/server/stdio', () => ({
  serveStdio: vi.fn(() => ({ close: vi.fn() })),
}));

const PROTOCOL_VERSION = '2026-07-28';
const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
};

const modernToolsList = (id = 1): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/list',
    params: { _meta: envelope },
  });

const listeningAddress = (server: http.Server): Promise<{ port: number; host: string }> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error(`unexpected address: ${String(address)}`));
        return;
      }
      resolve({ port: address.port, host: address.address });
    });
  });

describe('index entrypoints and transport selection (item 14)', () => {
  const tmpDirs: string[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers.length = 0;
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
    vi.clearAllMocks();
  });

  const tmpDbEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-mcp-test-'));
    tmpDirs.push(dir);
    return { MEMORY_DB_PATH: path.join(dir, 'memory.db'), ...extra };
  };

  describe('transport selection', () => {
    it('defaults to stdio when MEMORY_TRANSPORT is unset', () => {
      expect(resolveTransport({})).toBe('stdio');
      expect(resolveTransport({ MEMORY_TRANSPORT: '' })).toBe('stdio');
      expect(resolveTransport({ MEMORY_TRANSPORT: 'bogus' })).toBe('stdio');
    });

    it('selects http when MEMORY_TRANSPORT=http', () => {
      expect(resolveTransport({ MEMORY_TRANSPORT: 'http' })).toBe('http');
      expect(resolveTransport({ MEMORY_TRANSPORT: 'HTTP' })).toBe('http');
    });
  });

  describe('stdio entry', () => {
    it('serves via the SDK factory-based serveStdio entrypoint with the same factory', () => {
      const factory = createServerFactory({ db: undefined as never });
      const handle = serveStdioServer(factory);
      expect(serveStdio).toHaveBeenCalledTimes(1);
      expect(serveStdio).toHaveBeenCalledWith(factory);
      expect(handle).toBeDefined();
    });
  });

  describe('http entry', () => {
    it('creates a handler that serves a stateless 2026-07-28 tools/list with no session id', async () => {
      const db = openDatabase(':memory:');
      runMigrations(db, MIGRATIONS);
      const handler = createHttpHandler(createServerFactory({ db }));
      const response = await handler.fetch(
        new Request('http://127.0.0.1/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Mcp-Method': 'tools/list' },
          body: modernToolsList(),
        }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBeNull();
      const body = (await response.json()) as { result: { tools: { name: string }[] } };
      expect(body.result.tools.map((tool) => tool.name)).toContain('remember');
      await handler.close();
      db.close();
    });

    it('binds localhost only and serves a real modern request over the wire', async () => {
      const env = tmpDbEnv({ MEMORY_TRANSPORT: 'http', MEMORY_HTTP_PORT: '0' });
      const server = startHttpServer(env);
      servers.push(server);
      const { port, host } = await listeningAddress(server);
      expect(host).toBe('127.0.0.1');
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Mcp-Method': 'tools/list' },
        body: modernToolsList(),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: { tools: { name: string }[] } };
      expect(body.result.tools.map((tool) => tool.name)).toHaveLength(10);
    });
  });

  describe('main entrypoint', () => {
    it('routes to the http server when MEMORY_TRANSPORT=http', async () => {
      const env = tmpDbEnv({ MEMORY_TRANSPORT: 'http', MEMORY_HTTP_PORT: '0' });
      const result = main(env) as http.Server;
      servers.push(result);
      const { host } = await listeningAddress(result);
      expect(host).toBe('127.0.0.1');
    });

    it('routes to the stdio entry (SDK serveStdio) by default', () => {
      const env = tmpDbEnv();
      const result = main(env) as { close(): void };
      expect(serveStdio).toHaveBeenCalledTimes(1);
      expect(typeof result.close).toBe('function');
    });
  });
});
