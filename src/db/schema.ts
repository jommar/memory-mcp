import type Database from 'better-sqlite3';

export interface Migration {
  filename: string;
  sql: string;
}

const TRACKING_TABLE = 'schema_migrations';

const RELATIONAL_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN
    ('preference','decision','fact','procedure','person','project-state','lesson','session')),
  tier TEXT NOT NULL CHECK (tier IN ('short','long')),
  scope TEXT DEFAULT 'global',
  tags TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','superseded','archived','expired')),
  superseded_by TEXT,
  source TEXT NOT NULL CHECK (source IN ('user-stated','agent-inferred','agent-guessed')),
  importance INTEGER DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  confidence REAL,
  observed_count INTEGER DEFAULT 0,
  contradiction_count INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  last_accessed_at TEXT,
  last_confirmed_at TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS links (
  from_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('related','supersedes','contradicts')),
  PRIMARY KEY (from_id, to_id, kind)
);

CREATE TABLE IF NOT EXISTS history (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  content_before TEXT,
  content_after TEXT,
  reason TEXT,
  changed_at TEXT
);

-- External-content FTS5: the triggers below are the ONLY writers to memories_fts.
-- memories.id is TEXT, so the implicit rowid is the sync key (content_rowid='rowid');
-- FTS queries must select rowid, not a named id column.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title,
  content,
  tags,
  content='memories',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags);
  INSERT INTO memories_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;
`;

const VECTOR_SQL = `
-- memory_rowid is memories.rowid (integer); JS callers must bind it as BigInt.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
  memory_rowid integer primary key,
  embedding float[384] distance_metric=cosine
);
`;

export const MIGRATIONS: readonly Migration[] = [
  { filename: '0001_relational.sql', sql: RELATIONAL_SQL },
  { filename: '0002_vectors.sql', sql: VECTOR_SQL },
];

const createBootstrapTables = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
};

const appliedFilenames = (db: Database.Database): Set<string> => {
  const rows = db.prepare(`SELECT filename FROM ${TRACKING_TABLE}`).all() as { filename: string }[];
  return new Set(rows.map((row) => row.filename));
};

const recordSchemaVersion = (db: Database.Database, version: string): void => {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(version);
};

const applyMigration = (db: Database.Database, migration: Migration): void => {
  const recordApplied = db.prepare(
    `INSERT INTO ${TRACKING_TABLE} (filename, applied_at) VALUES (?, ?)`,
  );
  // Migration body and its tracking row commit atomically: a failure rolls back both.
  db.transaction(() => {
    db.exec(migration.sql);
    recordApplied.run(migration.filename, new Date().toISOString());
  })();
};

export const runMigrations = (db: Database.Database, migrations: readonly Migration[]): void => {
  createBootstrapTables(db);
  const applied = appliedFilenames(db);
  let version = applied.size;
  for (const migration of migrations) {
    if (applied.has(migration.filename)) continue;
    applyMigration(db, migration);
    version += 1;
  }
  if (version > 0) recordSchemaVersion(db, String(version));
};
