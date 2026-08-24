import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import {
  consolidatePayload,
  detailPayload,
  graphPayload,
  statsPayload,
} from './api.js';

export const HOST = '127.0.0.1';
export const MAX_PORT_ATTEMPTS = 10;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

export interface UiServerOptions {
  db: Database.Database;
  staticDir?: string;
}

const sendJson = (res: http.ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const sendText = (res: http.ServerResponse, status: number, message: string): void => {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(message);
};

// Resolves urlPath inside staticDir or undefined when it escapes it.
export const safeJoin = (staticDir: string, urlPath: string): string | undefined => {
  const root = resolve(staticDir);
  const target = resolve(root, `.${decodeURIComponent(urlPath)}`);
  return target === root || target.startsWith(root + sep) ? target : undefined;
};

const serveStatic = async (
  res: http.ServerResponse,
  staticDir: string,
  pathname: string,
): Promise<void> => {
  const target = safeJoin(staticDir, pathname);
  if (!target) {
    sendText(res, 403, 'forbidden');
    return;
  }
  const candidates = pathname === '/' ? [join(staticDir, 'index.html')] : [target, join(staticDir, 'index.html')];
  for (const candidate of candidates) {
    try {
      const body = await readFile(candidate);
      res.writeHead(200, { 'content-type': MIME_TYPES[extname(candidate)] ?? 'application/octet-stream' });
      res.end(body);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  sendText(res, 404, 'not found');
};

export const createUiServer = ({ db, staticDir }: UiServerOptions): http.Server =>
  http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        const { pathname } = new URL(req.url ?? '/', `http://${HOST}`);
        if (pathname === '/api/graph') {
          sendJson(res, 200, graphPayload(db));
          return;
        }
        if (pathname === '/api/stats') {
          sendJson(res, 200, statsPayload(db));
          return;
        }
        if (pathname === '/api/consolidate') {
          sendJson(res, 200, consolidatePayload(db));
          return;
        }
        const detail = /^\/api\/memory\/([^/]+)$/.exec(pathname);
        if (detail) {
          const payload = detailPayload(db, decodeURIComponent(detail[1]));
          if (!payload) {
            sendJson(res, 404, { error: `memory not found: ${decodeURIComponent(detail[1])}` });
            return;
          }
          sendJson(res, 200, payload);
          return;
        }
        if (pathname.startsWith('/api/')) {
          sendJson(res, 404, { error: 'unknown endpoint' });
          return;
        }
        if (!staticDir) {
          sendText(res, 404, 'ui assets not built (run: npm run ui:build)');
          return;
        }
        await serveStatic(res, staticDir, pathname);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

// Binds startPort and retries port+1 on EADDRINUSE until attempts run out.
export const listenWithRetry = (
  server: http.Server,
  startPort: number,
  host: string,
  attempts = MAX_PORT_ATTEMPTS,
): Promise<number> =>
  new Promise((resolve, reject) => {
    let port = startPort;
    let remaining = attempts;
    const listenOnce = (): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        cleanup();
        if (err.code === 'EADDRINUSE' && remaining > 1) {
          remaining -= 1;
          port += 1;
          listenOnce();
          return;
        }
        reject(err);
      };
      const onListening = (): void => {
        cleanup();
        resolve(port);
      };
      const cleanup = (): void => {
        server.off('error', onError);
        server.off('listening', onListening);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };
    listenOnce();
  });
