import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const MEMORY_PATH = ':memory:';
const OWNER_ONLY = 0o600;

const isMemoryDb = (path: string): boolean => path === MEMORY_PATH;

// WAL sidecar files are created lazily on the first write transaction, so an
// empty write transaction is forced here to make them chmod-able at open time.
const restrictToOwner = (db: Database.Database, path: string): void => {
  db.exec('BEGIN IMMEDIATE');
  db.exec('COMMIT');
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) chmodSync(file, OWNER_ONLY);
  }
};

export const openDatabase = (path: string): Database.Database => {
  if (!isMemoryDb(path)) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  if (!isMemoryDb(path)) {
    // WAL does not apply to in-memory databases; their journal mode stays 'memory'.
    db.pragma('journal_mode = WAL');
    restrictToOwner(db, path);
  }
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  return db;
};
