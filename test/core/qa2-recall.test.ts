import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';
import { createMemory, getMemory } from '../../src/db/queries.js';
import { recall } from '../../src/core/recall.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';

const vector = (components: number[]): Float32Array => {
  const v = new Float32Array(384);
  for (let i = 0; i < components.length; i += 1) v[i] = components[i];
  return v;
};

const fixedEmbedder = (value: Float32Array): EmbeddingProvider => ({
  name: 'fake',
  dim: 384,
  embed: async () => [value],
});

const seedVector = (db: Database.Database, id: string, v: Float32Array): void => {
  const { rowid } = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
  db.prepare('INSERT INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)').run(
    BigInt(rowid),
    Buffer.from(v.buffer),
  );
};

describe('recall edge behavior (round-02 qa)', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  it('does not throw on unmatched quotes, parens, colons or NEAR syntax in the query', async () => {
    const database = migrate();
    const a = createMemory(database, {
      title: 'alpha', content: 'alpha zebra', type: 'fact', tier: 'long', scope: 'test', source: 'user-stated',
    });
    seedVector(database, a.id, vector([1, 0]));
    for (const query of [
      'say "unterminated',
      '(parens) OR :colon',
      'NEAR(alpha zebra) AND "x',
      '"',
      '- AND OR NOT',
    ]) {
      const result = await recall(database, query, {
        scope: 'test', tier: 'long', status: 'active', embedder: fixedEmbedder(vector([1, 0])),
      });
      expect(Array.isArray(result.hits)).toBe(true);
    }
    const literal = await recall(database, '"unterminated', {
      scope: 'test', tier: 'long', status: 'active', embedder: fixedEmbedder(vector([1, 0])),
    });
    expect(literal.hits.map((h) => h.id)).toContain(a.id);
  });

  it('honors the limit option', async () => {
    const database = migrate();
    for (const title of ['one', 'two', 'three']) {
      const m = createMemory(database, {
        title, content: 'shared term body', type: 'fact', tier: 'long', scope: 'test', source: 'user-stated',
      });
      seedVector(database, m.id, vector([1, 0]));
    }
    const result = await recall(database, 'shared term', {
      scope: 'test', tier: 'long', status: 'active', limit: 1, embedder: fixedEmbedder(vector([1, 0])),
    });
    expect(result.hits).toHaveLength(1);
  });

  it('runs the bm25 leg when no embedder is provided', async () => {
    const database = migrate();
    const a = createMemory(database, {
      title: 'alpha', content: 'alpha zebra', type: 'fact', tier: 'long', scope: 'test', source: 'user-stated',
    });
    seedVector(database, a.id, vector([1, 0]));
    const result = await recall(database, 'alpha', { scope: 'test', tier: 'long', status: 'active' });
    expect(result.hits.map((h) => h.id)).toEqual([a.id]);
  });

  it('does not advance last_accessed_at when nothing matches', async () => {
    const database = migrate();
    const a = createMemory(database, {
      title: 'alpha', content: 'alpha zebra', type: 'fact', tier: 'long', scope: 'test', source: 'user-stated',
    });
    seedVector(database, a.id, vector([1, 0]));
    const result = await recall(database, 'zzz nothing matches', {
      scope: 'test', tier: 'long', status: 'active',
    });
    expect(result.hits).toEqual([]);
    expect(getMemory(database, a.id)!.last_accessed_at).toBeNull();
  });
});
