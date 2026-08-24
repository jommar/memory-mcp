import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';
import { createMemory, getMemory } from '../../src/db/queries.js';
import { createLink } from '../../src/core/links.js';
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
  const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
  db.prepare('INSERT INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)').run(
    BigInt(row.rowid),
    Buffer.from(v.buffer),
  );
};

describe('recall hybrid search', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  it('fuses bm25 and cosine via RRF so a text match can outrank a closer vector', async () => {
    const database = migrate();
    const a = createMemory(database, {
      title: 'alpha', content: 'alpha zebra', type: 'fact', tier: 'long', scope: 'test', source: 'user-stated',
    });
    const b = createMemory(database, {
      title: 'bravo', content: 'bravo zebra', type: 'fact', tier: 'long', scope: 'test', source: 'user-stated',
    });
    const c = createMemory(database, {
      title: 'charlie', content: 'charlie zebra', type: 'fact', tier: 'long', scope: 'test', source: 'user-stated',
    });
    // query vector = e0; a is the closest vector, c is second-closest, b is furthest.
    seedVector(database, a.id, vector([1, 0]));
    seedVector(database, b.id, vector([0, 1]));
    seedVector(database, c.id, vector([0.8660254, 0.5]));
    const result = await recall(
      database,
      'bravo',
      { scope: 'test', tier: 'long', status: 'active', embedder: fixedEmbedder(vector([1, 0])) },
    );
    // b wins on bm25 rank 1 despite semantic rank 3; a is second; c is third.
    expect(result.hits.map((hit) => hit.id)).toEqual([b.id, a.id, c.id]);
  });

  it('weights the fused score by reliability times importance', async () => {
    const database = migrate();
    const low = createMemory(database, {
      title: 'low entry', content: 'shared term body', type: 'fact', tier: 'long', scope: 'test', source: 'user-stated', importance: 3,
    });
    const high = createMemory(database, {
      title: 'high entry', content: 'shared term body', type: 'fact', tier: 'long', scope: 'test', source: 'user-stated', importance: 5,
    });
    seedVector(database, low.id, vector([1, 0]));
    seedVector(database, high.id, vector([1, 0]));
    const result = await recall(
      database,
      'shared term',
      { scope: 'test', tier: 'long', status: 'active', embedder: fixedEmbedder(vector([1, 0])) },
    );
    expect(result.hits.map((hit) => hit.id)).toEqual([high.id, low.id]);
  });

  it('applies hard filters for scope, tier and status', async () => {
    const database = migrate();
    const keep = createMemory(database, {
      title: 'keep', content: 'shared term body', type: 'fact', tier: 'long', scope: 'test', source: 'user-stated',
    });
    const otherScope = createMemory(database, {
      title: 'other scope', content: 'shared term body', type: 'fact', tier: 'long', scope: 'other', source: 'user-stated',
    });
    const shortTier = createMemory(database, {
      title: 'short tier', content: 'shared term body', type: 'fact', tier: 'short', scope: 'test', source: 'user-stated',
    });
    const archived = createMemory(database, {
      title: 'archived', content: 'shared term body', type: 'fact', tier: 'long', scope: 'test', source: 'user-stated',
    });
    for (const row of [keep, otherScope, shortTier, archived]) {
      seedVector(database, row.id, vector([1, 0]));
    }
    database
      .prepare("UPDATE memories SET status = 'archived' WHERE id = ?")
      .run(archived.id);
    const result = await recall(
      database,
      'shared term',
      { scope: 'test', tier: 'long', status: 'active', embedder: fixedEmbedder(vector([1, 0])) },
    );
    expect(result.hits.map((hit) => hit.id)).toEqual([keep.id]);
  });

  it('returns a markdown bundle with scores and 1-hop linked entries', async () => {
    const database = migrate();
    const a = createMemory(database, {
      title: 'linked note', content: 'alpha zebra', type: 'fact', tier: 'long', scope: 'test', source: 'user-stated',
    });
    const b = createMemory(database, {
      title: 'peer note', content: 'bravo zebra', type: 'fact', tier: 'long', scope: 'test', source: 'user-stated',
    });
    seedVector(database, a.id, vector([1, 0]));
    seedVector(database, b.id, vector([0, 1]));
    createLink(database, { fromId: a.id, toId: b.id, kind: 'related' });
    const result = await recall(
      database,
      'alpha',
      { scope: 'test', tier: 'long', status: 'active', embedder: fixedEmbedder(vector([1, 0])) },
    );
    expect(result.markdown).toContain('linked note');
    expect(result.markdown).toMatch(/score: \d/);
    expect(result.markdown).toContain('peer note');
    expect(result.markdown).toMatch(/related/);
  });

  it('advances last_accessed_at on recalled ids only', async () => {
    const database = migrate();
    const hit = createMemory(database, {
      title: 'hit', content: 'alpha zebra', type: 'fact', tier: 'long', scope: 'test', source: 'user-stated',
    });
    const miss = createMemory(database, {
      title: 'miss', content: 'zzz unrelated', type: 'fact', tier: 'long', scope: 'test', source: 'user-stated',
    });
    seedVector(database, hit.id, vector([1, 0]));
    const before = Date.now();
    const result = await recall(
      database,
      'alpha',
      { scope: 'test', tier: 'long', status: 'active', embedder: fixedEmbedder(vector([1, 0])) },
    );
    expect(result.hits.map((h) => h.id)).toEqual([hit.id]);
    const hitAfter = getMemory(database, hit.id)!;
    expect(hitAfter.last_accessed_at).not.toBeNull();
    expect(new Date(hitAfter.last_accessed_at!).getTime()).toBeGreaterThanOrEqual(before);
    expect(getMemory(database, miss.id)!.last_accessed_at).toBeNull();
  });

  it('does not throw on FTS5 operator characters in the query', async () => {
    const database = migrate();
    const alpha = createMemory(database, {
      title: 'alpha', content: 'alpha zebra', type: 'fact', tier: 'long', scope: 'test', source: 'user-stated',
    });
    seedVector(database, alpha.id, vector([1, 0]));
    const result = await recall(
      database,
      'alpha OR "quoted" -zebra *',
      { scope: 'test', tier: 'long', status: 'active', embedder: fixedEmbedder(vector([1, 0])) },
    );
    expect(result.hits.map((h) => h.id)).toContain(alpha.id);
  });
});
