import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';

const asVector = (components: number[]): Buffer => Buffer.from(new Float32Array(components).buffer);

const unitBasis = (index: number): number[] => {
  const vector = new Array<number>(384).fill(0);
  vector[index] = 1;
  return vector;
};

describe('vector schema migrations', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  it('creates the vec0 virtual table with a 384-dim embedding column', () => {
    const ddl = (migrate().prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_vec'").get() as { sql: string }).sql;
    expect(ddl).toContain('vec0');
    expect(ddl).toContain('float[384]');
    expect(ddl).toContain('distance_metric=cosine');
  });

  it('accepts BigInt-bound ids on the declared integer primary key', () => {
    const database = migrate();
    database
      .prepare('INSERT INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)')
      .run(101n, asVector(unitBasis(0)));
    const row = database
      .prepare('SELECT memory_rowid FROM memories_vec WHERE memory_rowid = 101')
      .get() as { memory_rowid: number | bigint };
    expect(Number(row.memory_rowid)).toBe(101);
  });

  it('orders KNN neighbors by ascending cosine distance via MATCH + k = ?', () => {
    const database = migrate();
    const insert = database.prepare('INSERT INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)');
    insert.run(1n, asVector(unitBasis(0)));   // identical to query -> distance 0
    insert.run(2n, asVector(unitBasis(1)));   // orthogonal -> distance 1
    insert.run(3n, asVector([-1, ...new Array<number>(383).fill(0)])); // opposite -> distance 2
    const neighbors = database
      .prepare(
        'SELECT memory_rowid AS id, distance FROM memories_vec WHERE embedding MATCH ? AND k = ?',
      )
      .all(asVector([1, ...new Array<number>(383).fill(0)]), 3) as { id: number; distance: number }[];
    expect(neighbors.map((n) => n.id)).toEqual([1, 2, 3]);
    expect(neighbors.map((n) => Number(n.distance.toFixed(6)))).toEqual([0, 1, 2]);
  });

  it('rejects inserting a vector with the wrong dimensionality', () => {
    const database = migrate();
    expect(() =>
      database
        .prepare('INSERT INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)')
        .run(9n, asVector([0.1, 0.2, 0.3])),
    ).toThrow();
  });
});
