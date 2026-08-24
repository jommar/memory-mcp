import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { runMigrations, type Migration } from '../../src/db/schema.js';

const good: Migration = { filename: '001_ok.sql', sql: 'CREATE TABLE t(a);' };
const multiStatement: Migration = {
  filename: '002_partial.sql',
  sql: 'CREATE TABLE p(x); INSERT INTO no_such_table VALUES (1);',
};

function tracked(db: Database.Database): string[] {
  return db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').all()
    .map((r) => (r as { filename: string }).filename);
}

describe('runMigrations', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  it('applies each pending migration exactly once and records applied filenames in order', () => {
    db = openDatabase(':memory:');
    runMigrations(db, [good]);
    runMigrations(db, [{ filename: '002_more.sql', sql: 'CREATE TABLE u(b);' }]);
    expect(tracked(db)).toEqual(['001_ok.sql', '002_more.sql']);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('t','u')").get())
      .toEqual({ n: 2 });
  });

  it('applies nothing on re-run of an already-applied list', () => {
    db = openDatabase(':memory:');
    runMigrations(db, [good]);
    runMigrations(db, [good]);
    expect(tracked(db)).toEqual(['001_ok.sql']);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='t'").get())
      .toEqual({ n: 1 });
  });

  it('rolls back a failing migration completely and throws', () => {
    db = openDatabase(':memory:');
    runMigrations(db, [good]);
    expect(() => runMigrations(db, [multiStatement])).toThrow();
    expect(tracked(db)).toEqual(['001_ok.sql']);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'p'").get())
      .toEqual({ n: 0 });
  });
});
