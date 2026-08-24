import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';
import { createMemory, getMemory, listMemories, searchMemoriesByText, makeMemoryId } from '../../src/db/queries.js';
import { remember } from '../../src/core/remember.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

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

const failingEmbedder = (message: string): EmbeddingProvider => ({
  name: 'fake',
  dim: 384,
  embed: async () => {
    throw new Error(message);
  },
});

const seedVector = (db: Database.Database, id: string, v: Float32Array): void => {
  const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
  db.prepare('INSERT INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)').run(
    BigInt(row.rowid),
    Buffer.from(v.buffer),
  );
};

describe('remember pipeline', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  describe('novel content', () => {
    it('creates a memory with an auto-generated key and a long-tier default for a fact', async () => {
      const database = migrate();
      const result = await remember(
        database,
        { title: 'Prefer local-first tooling', content: 'Self-hosted beats SaaS.', type: 'fact' },
        { embedder: fixedEmbedder(vector([1, 0])) },
      );
      expect(result.outcome).toBe('created');
      expect(result.id).toBe(makeMemoryId('Prefer local-first tooling'));
      const row = getMemory(database, result.id!)!;
      expect(row.tier).toBe('long');
      expect(row.expires_at).toBeNull();
    });

    it('defaults a session memory to short tier with a 24h STM expiry', async () => {
      const database = migrate();
      const result = await remember(
        database,
        { title: 'session scratch', content: 'in-flight thought', type: 'session' },
        { embedder: fixedEmbedder(vector([1, 0])) },
      );
      const row = getMemory(database, result.id!)!;
      expect(row.tier).toBe('short');
      const expiryMs = new Date(row.expires_at!).getTime();
      const createdMs = new Date(row.created_at).getTime();
      expect(expiryMs - createdMs).toBeGreaterThanOrEqual(24 * HOUR_MS - 1000);
      expect(expiryMs - createdMs).toBeLessThanOrEqual(24 * HOUR_MS + 1000);
    });

    it('defaults a project-state memory to short tier with a 14d STM expiry', async () => {
      const database = migrate();
      const result = await remember(
        database,
        { title: 'project state', content: 'current milestone', type: 'project-state' },
        { embedder: fixedEmbedder(vector([1, 0])) },
      );
      const row = getMemory(database, result.id!)!;
      expect(row.tier).toBe('short');
      const expiryMs = new Date(row.expires_at!).getTime();
      const createdMs = new Date(row.created_at).getTime();
      expect(expiryMs - createdMs).toBeGreaterThanOrEqual(14 * DAY_MS - 1000);
      expect(expiryMs - createdMs).toBeLessThanOrEqual(14 * DAY_MS + 1000);
    });

    it('stores the embedding vector when one is produced', async () => {
      const database = migrate();
      const result = await remember(
        database,
        { title: 'vectored note', content: 'has an embedding', type: 'fact' },
        { embedder: fixedEmbedder(vector([1, 0])) },
      );
      const row = database
        .prepare('SELECT count(*) AS n FROM memories_vec')
        .get() as { n: number };
      expect(row.n).toBe(1);
      const rowid = (
        database.prepare('SELECT rowid FROM memories WHERE id = ?').get(result.id!) as { rowid: number }
      ).rowid;
      const vec = database
        .prepare('SELECT memory_rowid FROM memories_vec WHERE memory_rowid = ?')
        .get(BigInt(rowid));
      expect(vec).toBeDefined();
    });
  });

  describe('duplicate detection', () => {
    it('returns merged:<key> and writes nothing when similarity exceeds the dedupe threshold', async () => {
      const database = migrate();
      const existing = createMemory(database, {
        title: 'existing note', content: 'same idea', type: 'fact', tier: 'long', source: 'user-stated',
      });
      seedVector(database, existing.id, vector([1, 0]));
      const result = await remember(
        database,
        { title: 'existing note v2', content: 'same idea restated', type: 'fact' },
        { embedder: fixedEmbedder(vector([1, 0])) },
      );
      expect(result.outcome).toBe('merged');
      expect(result.id).toBe(existing.id);
      expect(listMemories(database)).toHaveLength(1);
    });

    it('returns conflict:[candidates] without writing for mid-band similarity', async () => {
      const database = migrate();
      const candidate = createMemory(database, {
        title: 'near miss', content: 'related but distinct angle', type: 'fact', tier: 'long', source: 'user-stated',
      });
      seedVector(database, candidate.id, vector([0.7, Math.sqrt(1 - 0.49)]));
      const result = await remember(
        database,
        { title: 'near miss v2', content: 'related but distinct angle restated', type: 'fact' },
        { embedder: fixedEmbedder(vector([1, 0])) },
      );
      expect(result.outcome).toBe('conflict');
      expect(result.candidates).toEqual([candidate.id]);
      expect(listMemories(database)).toHaveLength(1);
      expect(getMemory(database, makeMemoryId('near miss v2'))).toBeUndefined();
    });

    it('lists every candidate in the conflict band in deterministic order', async () => {
      const database = migrate();
      const first = createMemory(database, {
        title: 'aa candidate', content: 'angle one', type: 'fact', tier: 'long', source: 'user-stated',
      });
      const second = createMemory(database, {
        title: 'bb candidate', content: 'angle two', type: 'fact', tier: 'long', source: 'user-stated',
      });
      seedVector(database, first.id, vector([0.65, Math.sqrt(1 - 0.4225)]));
      seedVector(database, second.id, vector([0.7, Math.sqrt(1 - 0.49)]));
      const result = await remember(
        database,
        { title: 'fresh angle', content: 'a third angle', type: 'fact' },
        { embedder: fixedEmbedder(vector([1, 0])) },
      );
      expect(result.outcome).toBe('conflict');
      expect(result.candidates).toEqual([first.id, second.id].sort());
      expect(listMemories(database)).toHaveLength(2);
    });
  });

  describe('embedding failure', () => {
    it('still stores the memory without a vector and the keyword leg finds it', async () => {
      const database = migrate();
      const result = await remember(
        database,
        { title: 'offline note', content: 'uniquely findable phrase zqx', type: 'fact' },
        { embedder: failingEmbedder('model download failed') },
      );
      expect(result.outcome).toBe('created');
      const row = getMemory(database, result.id!)!;
      expect(row.content).toBe('uniquely findable phrase zqx');
      const vec = database
        .prepare('SELECT count(*) AS n FROM memories_vec')
        .get() as { n: number };
      expect(vec.n).toBe(0);
      expect(searchMemoriesByText(database, 'uniquely findable')).toContainEqual(
        expect.objectContaining({ id: result.id }),
      );
    });
  });
});
