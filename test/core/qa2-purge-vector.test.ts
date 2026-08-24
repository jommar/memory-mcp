import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';
import { createMemory, forgetMemory } from '../../src/db/queries.js';

const vector = (): Buffer => Buffer.from(new Float32Array(384).buffer);

const seedVector = (db: Database.Database, id: string): void => {
  const { rowid } = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
  db.prepare('INSERT INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)').run(BigInt(rowid), vector());
};

describe('purge removes the memory row AND its vector (round-02 qa pin)', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  it('purge deletes the vec0 row belonging to the purged memory', () => {
    const database = migrate();
    const { id } = createMemory(database, {
      title: 'alpha', content: 'c', type: 'fact', tier: 'long', source: 'user-stated',
    });
    seedVector(database, id);
    expect((database.prepare('SELECT count(*) AS n FROM memories_vec').get() as { n: number }).n).toBe(1);
    forgetMemory(database, id, { purge: true });
    expect((database.prepare('SELECT count(*) AS n FROM memories_vec').get() as { n: number }).n).toBe(0);
  });

  it('a memory created after a purge does not inherit the purged memory vector via rowid reuse', () => {
    const database = migrate();
    const a = createMemory(database, {
      title: 'alpha', content: 'c', type: 'fact', tier: 'long', source: 'user-stated',
    });
    seedVector(database, a.id);
    forgetMemory(database, a.id, { purge: true });
    const b = createMemory(database, {
      title: 'beta', content: 'c', type: 'fact', tier: 'long', source: 'user-stated',
    });
    const { rowid } = database.prepare('SELECT rowid FROM memories WHERE id = ?').get(b.id) as { rowid: number };
    expect(database.prepare('SELECT 1 FROM memories_vec WHERE memory_rowid = ?').get(BigInt(rowid))).toBeUndefined();
  });

  it('purge leaves other memories vectors untouched', () => {
    const database = migrate();
    const a = createMemory(database, {
      title: 'alpha', content: 'c', type: 'fact', tier: 'long', source: 'user-stated',
    });
    const b = createMemory(database, {
      title: 'beta', content: 'c', type: 'fact', tier: 'long', source: 'user-stated',
    });
    seedVector(database, a.id);
    seedVector(database, b.id);
    forgetMemory(database, a.id, { purge: true });
    expect((database.prepare('SELECT count(*) AS n FROM memories_vec').get() as { n: number }).n).toBe(1);
  });
});
