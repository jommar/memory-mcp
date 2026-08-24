import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, DEFAULT_DB_PATH, DEFAULT_CACHE_DIR, DEFAULT_DOWNLOAD_TIMEOUT_MS } from '../src/config.js';

describe('MEMORY_* config surface', () => {
  it('falls back to the zero-config default DB path when no vars are set', () => {
    const config = loadConfig({});
    expect(config.dbPath).toBe(path.join(os.homedir(), '.memory-mcp', 'memory.db'));
    expect(config.dbPath).toBe(DEFAULT_DB_PATH);
  });

  it('honors MEMORY_DB_PATH over the default', () => {
    const config = loadConfig({ MEMORY_DB_PATH: '/tmp/custom/memory.db' });
    expect(config.dbPath).toBe('/tmp/custom/memory.db');
  });

  it('defaults embeddings to offline-first with no implicit download', () => {
    const config = loadConfig({});
    expect(config.embeddingOffline).toBe(true);
  });

  it('opt-in to first-run model download by turning MEMORY_EMBEDDING_OFFLINE off', () => {
    expect(loadConfig({ MEMORY_EMBEDDING_OFFLINE: '0' }).embeddingOffline).toBe(false);
    expect(loadConfig({ MEMORY_EMBEDDING_OFFLINE: 'false' }).embeddingOffline).toBe(false);
    expect(loadConfig({ MEMORY_EMBEDDING_OFFLINE: '1' }).embeddingOffline).toBe(true);
  });

  it('surfaces a download timeout default and honors MEMORY_EMBEDDING_DOWNLOAD_TIMEOUT_MS', () => {
    expect(DEFAULT_DOWNLOAD_TIMEOUT_MS).toBeGreaterThan(0);
    expect(loadConfig({}).embeddingDownloadTimeoutMs).toBe(DEFAULT_DOWNLOAD_TIMEOUT_MS);
    expect(loadConfig({ MEMORY_EMBEDDING_DOWNLOAD_TIMEOUT_MS: '45000' }).embeddingDownloadTimeoutMs).toBe(45000);
  });

  it('defaults the cache dir under the app data dir', () => {
    expect(loadConfig({}).embeddingCacheDir).toBe(path.join(os.homedir(), '.memory-mcp', 'cache'));
    expect(loadConfig({}).embeddingCacheDir).toBe(DEFAULT_CACHE_DIR);
  });

  it('defaults HTTP binding to localhost only', () => {
    const config = loadConfig({});
    expect(config.httpHost).toBe('127.0.0.1');
    expect(config.httpPort).toBe(3000);
    expect(loadConfig({ MEMORY_HTTP_HOST: '0.0.0.0', MEMORY_HTTP_PORT: '8080' }).httpHost).toBe('0.0.0.0');
    expect(loadConfig({ MEMORY_HTTP_PORT: '8080' }).httpPort).toBe(8080);
  });
});
