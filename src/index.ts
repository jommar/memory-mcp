#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, type McpHttpHandler, type McpServerFactory } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { MIGRATIONS, runMigrations } from './db/schema.js';
import { initEmbeddingProvider } from './embeddings/types.js';
import { createLocalEmbeddingProvider } from './embeddings/local.js';
import { createServerFactory, type ServerDependencies } from './server.js';

export const appName = '@jommar/memory-mcp';

export type TransportKind = 'stdio' | 'http';

export const resolveTransport = (env: NodeJS.ProcessEnv = process.env): TransportKind =>
  env.MEMORY_TRANSPORT?.trim().toLowerCase() === 'http' ? 'http' : 'stdio';

const buildDependencies = (env: NodeJS.ProcessEnv): ServerDependencies => {
  const config = loadConfig(env);
  const db = openDatabase(config.dbPath);
  runMigrations(db, MIGRATIONS);
  const embedder = createLocalEmbeddingProvider({
    offline: config.embeddingOffline,
    downloadTimeoutMs: config.embeddingDownloadTimeoutMs,
    cacheDir: config.embeddingCacheDir,
  });
  initEmbeddingProvider(db, embedder);
  return { db, embedder };
};

export const createServerFactoryFromEnv = (env: NodeJS.ProcessEnv = process.env): McpServerFactory =>
  createServerFactory(buildDependencies(env));

export const serveStdioServer = (factory: McpServerFactory): StdioServerHandle =>
  serveStdio(factory);

export const createHttpHandler = (factory: McpServerFactory): McpHttpHandler =>
  createMcpHandler(factory);

const toWebRequest = (req: http.IncomingMessage, body: Buffer): Request => {
  const host = (req.headers.host as string | undefined) ?? '127.0.0.1';
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[key] = value;
  }
  return new Request(new URL(req.url ?? '/', `http://${host}`), {
    method: req.method,
    headers,
    body: body.length > 0 ? body : undefined,
  });
};

const serveRequest = (
  handler: McpHttpHandler,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('error', (error) => res.destroy(error));
  req.on('end', () => {
    void (async () => {
      try {
        const webResponse = await handler.fetch(toWebRequest(req, Buffer.concat(chunks)));
        res.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
        res.end(Buffer.from(await webResponse.arrayBuffer()));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    })();
  });
};

export const startHttpServer = (env: NodeJS.ProcessEnv = process.env): http.Server => {
  const config = loadConfig(env);
  const handler = createHttpHandler(createServerFactoryFromEnv(env));
  const server = http.createServer((req, res) => serveRequest(handler, req, res));
  server.listen(config.httpPort, config.httpHost);
  return server;
};

export const main = (env: NodeJS.ProcessEnv = process.env): StdioServerHandle | http.Server =>
  resolveTransport(env) === 'http'
    ? startHttpServer(env)
    : serveStdioServer(createServerFactoryFromEnv(env));

const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.env);
}
