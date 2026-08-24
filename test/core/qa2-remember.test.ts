import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';
import { createMemory, getMemory, listMemories, searchMemoriesByText } from '../../src/db/queries.js';
import { remember } from '../../src/core/remember.js';
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

describe('remember branches (round-02 qa)', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  it('stores the memory when no embedder is configured at all (no-embedder degrade-open write)', async () => {
    const database = migrate();
    const result = await remember(database, {
      title: 'no embedder note', content: 'zzq unique token', type: 'fact',
    });
    expect(result.outcome).toBe('created');
    const row = getMemory(database, result.id!)!;
    expect(row.content).toBe('zzq unique token');
    expect((database.prepare('SELECT count(*) AS n FROM memories_vec').get() as { n: number }).n).toBe(0);
    expect(searchMemoriesByText(database, 'zzq unique')).toContainEqual(
      expect.objectContaining({ id: result.id }),
    );
  });

  it('does not dedupe against memories in a different scope', async () => {
    const database = migrate();
    const other = createMemory(database, {
      title: 'dev note', content: 'same idea', type: 'fact', tier: 'long', scope: 'dev', source: 'user-stated',
    });
    seedVector(database, other.id, vector([1, 0]));
    const result = await remember(
      database,
      { title: 'global note', content: 'same idea restated', type: 'fact', scope: 'global' },
      { embedder: fixedEmbedder(vector([1, 0])) },
    );
    expect(result.outcome).toBe('created');
    expect(result.id).not.toBe(other.id);
    expect(getMemory(database, result.id!)!.scope).toBe('global');
    expect(listMemories(database)).toHaveLength(2);
  });

  it('does not dedupe against archived memories', async () => {
    const database = migrate();
    const archived = createMemory(database, {
      title: 'archived twin', content: 'same idea', type: 'fact', tier: 'long', source: 'user-stated',
    });
    seedVector(database, archived.id, vector([1, 0]));
    database.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(archived.id);
    const result = await remember(
      database,
      { title: 'fresh twin', content: 'same idea restated', type: 'fact' },
      { embedder: fixedEmbedder(vector([1, 0])) },
    );
    expect(result.outcome).toBe('created');
    expect(listMemories(database)).toHaveLength(2);
  });

  it('an embedding failure with an existing near-duplicate still writes (merge requires a vector)', async () => {
    const database = migrate();
    const existing = createMemory(database, {
      title: 'existing', content: 'same idea', type: 'fact', tier: 'long', source: 'user-stated',
    });
    seedVector(database, existing.id, vector([1, 0]));
    const failing: EmbeddingProvider = {
      name: 'fake', dim: 384,
      embed: async () => { throw new Error('down'); },
    };
    const result = await remember(
      database,
      { title: 'twin', content: 'same idea restated', type: 'fact' },
      { embedder: failing },
    );
    expect(result.outcome).toBe('created');
    expect(listMemories(database)).toHaveLength(2);
  });
});
