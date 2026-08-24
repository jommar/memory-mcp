import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const MEMORY_PATH = ':memory:';

const isMemoryDb = (path: string): boolean => path === MEMORY_PATH;

export const openDatabase = (path: string): Database.Database => {
  const db = new Database(path);
  if (!isMemoryDb(path)) {
    // WAL does not apply to in-memory databases; their journal mode stays 'memory'.
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  return db;
};
