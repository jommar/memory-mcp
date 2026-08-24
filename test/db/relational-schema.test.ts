import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';

describe('relational schema migrations', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  const columnsOf = (database: Database.Database, table: string): string[] =>
    (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

  it('creates the memories table with exactly the DESIGN §4 columns', () => {
    expect(columnsOf(migrate(), 'memories')).toEqual([
      'id', 'title', 'content', 'type', 'tier', 'scope', 'tags', 'status',
      'superseded_by', 'source', 'importance', 'confidence', 'observed_count',
      'contradiction_count', 'created_at', 'updated_at', 'last_accessed_at',
      'last_confirmed_at', 'expires_at',
    ]);
  });

  it('creates links, history and meta with their specified columns', () => {
    const database = migrate();
    expect(columnsOf(database, 'links')).toEqual(['from_id', 'to_id', 'kind']);
    expect(columnsOf(database, 'history')).toEqual([
      'memory_id', 'content_before', 'content_after', 'reason', 'changed_at',
    ]);
    expect(columnsOf(database, 'meta')).toEqual(['key', 'value']);
  });

  it('creates the memories_fts virtual table over the memories content', () => {
    const database = migrate();
    const fts = database
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'")
      .get() as { sql: string };
    expect(fts.sql).toContain("content='memories'");
    for (const col of ['title', 'content', 'tags']) {
      expect(columnsOf(database, 'memories_fts')).toContain(col);
    }
  });

  it('records the schema version in meta', () => {
    const row = migrate().prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe('2');
  });

  it('keeps the FTS index in sync on INSERT of a memory row', () => {
    const database = migrate();
    database
      .prepare(
        `INSERT INTO memories (id, title, content, tags, type, tier, source)
         VALUES ('m1', 'Deploy runbook', 'Roll out canary then promote', '["ops"]', 'procedure', 'long', 'user-stated')`,
      )
      .run();
    const hits = database
      .prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'canary'")
      .all();
    expect(hits).toHaveLength(1);
  });

  it('keeps the FTS index in sync on UPDATE of a memory row', () => {
    const database = migrate();
    database
      .prepare(
        `INSERT INTO memories (id, title, content, type, tier, source)
         VALUES ('m1', 'Runbook', 'old content body', 'fact', 'long', 'user-stated')`,
      )
      .run();
    database.prepare("UPDATE memories SET content = 'fresh content body' WHERE id = 'm1'").run();
    expect(
      database.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'old'").all(),
    ).toHaveLength(0);
    expect(
      database.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'fresh'").all(),
    ).toHaveLength(1);
  });

  it('keeps the FTS index in sync on DELETE of a memory row', () => {
    const database = migrate();
    database
      .prepare(
        `INSERT INTO memories (id, title, content, type, tier, source)
         VALUES ('m1', 'Runbook', 'unique zebra content', 'fact', 'long', 'user-stated')`,
      )
      .run();
    expect(
      database.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'zebra'").all(),
    ).toHaveLength(1);
    database.prepare("DELETE FROM memories WHERE id = 'm1'").run();
    expect(
      database.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'zebra'").all(),
    ).toHaveLength(0);
  });
});
