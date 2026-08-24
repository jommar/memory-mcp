import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';
import { initEmbeddingProvider } from '../../src/embeddings/types.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';

const fakeProvider = (name: string, dim: number): EmbeddingProvider => ({
  name,
  dim,
  embed: async (texts) => texts.map((t) => new Float32Array(dim).fill(t.length)),
});

describe('embedding provider dim guard', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  it('records provider name and dim in meta on first init', () => {
    const database = migrate();
    initEmbeddingProvider(database, fakeProvider('local-minilm', 384));
    const rows = database.prepare('SELECT key, value FROM meta ORDER BY key').all() as {
      key: string;
      value: string;
    }[];
    expect(rows).toContainEqual({ key: 'embedding_dim', value: '384' });
    expect(rows).toContainEqual({ key: 'embedding_provider', value: 'local-minilm' });
  });

  it('re-init succeeds when provider and dim match the recorded pair', () => {
    const database = migrate();
    initEmbeddingProvider(database, fakeProvider('local-minilm', 384));
    const provider = initEmbeddingProvider(database, fakeProvider('local-minilm', 384));
    expect(provider.name).toBe('local-minilm');
    expect(provider.dim).toBe(384);
  });

  it('fails loudly when dim differs from the meta-recorded dim', () => {
    const database = migrate();
    initEmbeddingProvider(database, fakeProvider('local-minilm', 384));
    expect(() => initEmbeddingProvider(database, fakeProvider('other-model', 768))).toThrow(
      /768.*384|384.*768/,
    );
  });

  it('fails loudly when provider name differs from the recorded pair', () => {
    const database = migrate();
    initEmbeddingProvider(database, fakeProvider('local-minilm', 384));
    expect(() => initEmbeddingProvider(database, fakeProvider('openai-1536', 384))).toThrow(
      /local-minilm.*openai-1536/,
    );
  });
});
