import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { openDatabaseReadOnly } from '../../src/db/connection.js';
import { createUiServer, HOST, listenWithRetry, MAX_PORT_ATTEMPTS } from './http.js';

const DEFAULT_UI_PORT = 3001;

const uiPort = (): number => {
  const raw = process.env.MEMORY_UI_PORT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_UI_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`invalid MEMORY_UI_PORT: ${raw}`);
  }
  return parsed;
};

const main = async (): Promise<void> => {
  // Compiled layout: <ui>/dist-server/ui/server/index.js → app assets at <ui>/dist.
  const here = dirname(fileURLToPath(import.meta.url));
  const staticDir = join(here, '..', '..', '..', 'dist');
  const { dbPath } = loadConfig(process.env);
  const db = openDatabaseReadOnly(dbPath);
  const server = createUiServer({ db, staticDir });
  const port = await listenWithRetry(server, uiPort(), HOST, MAX_PORT_ATTEMPTS);
  console.log(`memory-mcp ui → http://${HOST}:${port} (db: ${dbPath})`);
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
