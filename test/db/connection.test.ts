import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/connection.js';

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memory-mcp-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const permissionBits = (path: string): number => statSync(path).mode & 0o777;

describe('openDatabase', () => {
  it('returns a working better-sqlite3 handle for :memory:', () => {
    const db = openDatabase(':memory:');
    expect(db.open).toBe(true);
    expect(db.prepare('SELECT 7 AS x').get()).toEqual({ x: 7 });
    db.close();
    expect(db.open).toBe(false);
  });

  it('returns a working handle for a file path', () => {
    const dbPath = join(tempDir(), 'mem.db');
    const db = openDatabase(dbPath);
    db.prepare('CREATE TABLE t(a)').run();
    db.close();
    const reopened = openDatabase(dbPath);
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t'").get())
      .toBeDefined();
    reopened.close();
  });

  it('puts a file DB in WAL journal mode', () => {
    const db = openDatabase(join(tempDir(), 'wal.db'));
    expect((db.pragma('journal_mode', { simple: true }) as string).toLowerCase()).toBe('wal');
    db.close();
  });

  it('enforces foreign_keys=ON on both handle kinds', () => {
    for (const path of [':memory:', join(tempDir(), 'fk.db')]) {
      const db = openDatabase(path);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      db.close();
    }
  });

  it('loads the sqlite-vec extension so vec_version() answers', () => {
    const db = openDatabase(':memory:');
    expect(db.prepare('SELECT vec_version() AS v').get()).toEqual({ v: 'v0.1.9' });
    db.close();
  });

  it('restricts the database, wal and shm files to owner-only access', () => {
    const dbPath = join(tempDir(), 'private.db');
    const db = openDatabase(dbPath);
    for (const suffix of ['', '-wal', '-shm']) {
      expect(permissionBits(`${dbPath}${suffix}`), `${dbPath}${suffix}`).toBe(0o600);
    }
    db.close();
  });
});
