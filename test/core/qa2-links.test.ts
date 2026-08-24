import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';
import { createMemory, updateMemory } from '../../src/db/queries.js';
import { createLink, listBacklinks, supersessionChain } from '../../src/core/links.js';

describe('links edge behavior (round-02 qa)', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  const seed = (database: Database.Database, title: string): string =>
    createMemory(database, {
      title, content: `content of ${title}`, type: 'fact', tier: 'long', source: 'user-stated',
    }).id;

  it('walks the supersession chain from a mid-chain entry to the terminal entry', () => {
    const database = migrate();
    const a = seed(database, 'chain a');
    const b = seed(database, 'chain b');
    const c = seed(database, 'chain c');
    updateMemory(database, a, { status: 'superseded', superseded_by: b, reason: 'arrange' });
    updateMemory(database, b, { status: 'superseded', superseded_by: c, reason: 'arrange' });
    expect(supersessionChain(database, b)).toEqual([b, c]);
  });

  it('terminates on a superseded_by cycle instead of looping forever', () => {
    const database = migrate();
    const a = seed(database, 'loop a');
    const b = seed(database, 'loop b');
    updateMemory(database, a, { status: 'superseded', superseded_by: b, reason: 'arrange' });
    updateMemory(database, b, { status: 'superseded', superseded_by: a, reason: 'arrange' });
    expect(supersessionChain(database, a)).toEqual([a, b]);
  });

  it('returns an empty page for an offset beyond the last backlink', () => {
    const database = migrate();
    const target = seed(database, 'hub');
    const a = seed(database, 'alpha');
    createLink(database, { fromId: a, toId: target, kind: 'related' });
    expect(listBacklinks(database, target, { limit: 2, offset: 5 })).toEqual({
      links: [],
      hasMore: false,
    });
  });
});
