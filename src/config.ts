import os from 'node:os';
import path from 'node:path';

export const DEFAULT_DB_PATH = path.join(os.homedir(), '.memory-mcp', 'memory.db');
export const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.memory-mcp', 'cache');
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000;
export const DEFAULT_HTTP_PORT = 3000;
export const DEFAULT_HTTP_HOST = '127.0.0.1';

export interface MemoryConfig {
  dbPath: string;
  httpHost: string;
  httpPort: number;
  embeddingOffline: boolean;
  embeddingDownloadTimeoutMs: number;
  embeddingCacheDir: string;
}

const truthy = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined || raw.trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
};

const nonNegativeInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const nonEmpty = (raw: string | undefined, fallback: string): string =>
  raw !== undefined && raw.trim() !== '' ? raw.trim() : fallback;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): MemoryConfig => ({
  dbPath: nonEmpty(env.MEMORY_DB_PATH, DEFAULT_DB_PATH),
  httpHost: nonEmpty(env.MEMORY_HTTP_HOST, DEFAULT_HTTP_HOST),
  httpPort: nonNegativeInt(env.MEMORY_HTTP_PORT, DEFAULT_HTTP_PORT),
  embeddingOffline: truthy(env.MEMORY_EMBEDDING_OFFLINE, true),
  embeddingDownloadTimeoutMs: nonNegativeInt(
    env.MEMORY_EMBEDDING_DOWNLOAD_TIMEOUT_MS,
    DEFAULT_DOWNLOAD_TIMEOUT_MS,
  ),
  embeddingCacheDir: nonEmpty(env.MEMORY_EMBEDDING_CACHE_DIR, DEFAULT_CACHE_DIR),
});
