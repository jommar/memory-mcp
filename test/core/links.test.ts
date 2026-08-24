import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';
import { createMemory, getMemory, updateMemory } from '../../src/db/queries.js';
import {
  createLink,
  listBacklinks,
  listOutgoingLinks,
  supersessionChain,
  type LinkKind,
} from '../../src/core/links.js';

describe('links module', () => {
  let db: Database.Database;
  afterEach(() => {
    vi.restoreAllMocks();
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  const seed = (database: Database.Database, title: string): string =>
    createMemory(database, {
      title,
      content: `content of ${title}`,
      type: 'fact',
      tier: 'long',
      source: 'user-stated',
    }).id;

  describe('createLink', () => {
    it('persists a related link and reports created', () => {
      const database = migrate();
      const a = seed(database, 'alpha');
      const b = seed(database, 'beta');
      expect(createLink(database, { fromId: a, toId: b, kind: 'related' })).toEqual({ created: true });
      expect(listOutgoingLinks(database, a)).toEqual([{ fromId: a, toId: b, kind: 'related' }]);
    });

    it('accepts each allowed kind: related, supersedes, contradicts', () => {
      const database = migrate();
      const a = seed(database, 'alpha');
      const b = seed(database, 'beta');
      for (const kind of ['related', 'supersedes', 'contradicts'] as const) {
        expect(createLink(database, { fromId: a, toId: b, kind }).created).toBe(true);
      }
      expect(listOutgoingLinks(database, a)).toHaveLength(3);
    });

    it('rejects a kind outside the allowed set', () => {
      const database = migrate();
      const a = seed(database, 'alpha');
      const b = seed(database, 'beta');
      expect(() =>
        createLink(database, { fromId: a, toId: b, kind: 'adjacent' as LinkKind }),
      ).toThrow(/kind/);
      expect(listOutgoingLinks(database, a)).toEqual([]);
    });

    it('warns and skips when the target memory does not exist', () => {
      const database = migrate();
      const a = seed(database, 'alpha');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(createLink(database, { fromId: a, toId: 'ghost', kind: 'related' })).toEqual({
        created: false,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(listOutgoingLinks(database, a)).toEqual([]);
    });

    it('warns and skips when the source memory does not exist', () => {
      const database = migrate();
      const b = seed(database, 'beta');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(createLink(database, { fromId: 'ghost', toId: b, kind: 'related' })).toEqual({
        created: false,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(listOutgoingLinks(database, 'ghost')).toEqual([]);
    });

    it('is idempotent for repeated identical links', () => {
      const database = migrate();
      const a = seed(database, 'alpha');
      const b = seed(database, 'beta');
      expect(createLink(database, { fromId: a, toId: b, kind: 'related' })).toEqual({ created: true });
      expect(createLink(database, { fromId: a, toId: b, kind: 'related' })).toEqual({ created: false });
      expect(listOutgoingLinks(database, a)).toEqual([{ fromId: a, toId: b, kind: 'related' }]);
    });
  });

  describe('listBacklinks', () => {
    it('paginates with a hasMore signal using the limit+1 pattern', () => {
      const database = migrate();
      const target = seed(database, 'hub');
      const a = seed(database, 'alpha');
      const b = seed(database, 'beta');
      const c = seed(database, 'gamma');
      for (const source of [a, b, c]) {
        createLink(database, { fromId: source, toId: target, kind: 'related' });
      }
      const pageOne = listBacklinks(database, target, { limit: 2 });
      expect(pageOne.links).toHaveLength(2);
      expect(pageOne.hasMore).toBe(true);
      const pageTwo = listBacklinks(database, target, { limit: 2, offset: 2 });
      expect(pageTwo.links).toHaveLength(1);
      expect(pageTwo.hasMore).toBe(false);
      const seen = [...pageOne.links, ...pageTwo.links].map((link) => link.fromId).sort();
      expect(seen).toEqual([a, b, c].sort());
    });

    it('returns an empty page for a memory with no backlinks', () => {
      const database = migrate();
      const lonely = seed(database, 'lonely');
      expect(listBacklinks(database, lonely, { limit: 5 })).toEqual({ links: [], hasMore: false });
    });

    it('does not count outgoing links as backlinks', () => {
      const database = migrate();
      const a = seed(database, 'alpha');
      const b = seed(database, 'beta');
      createLink(database, { fromId: a, toId: b, kind: 'related' });
      expect(listBacklinks(database, a, { limit: 5 }).links).toEqual([]);
      expect(listBacklinks(database, b, { limit: 5 }).links).toEqual([
        { fromId: a, toId: b, kind: 'related' },
      ]);
    });
  });

  describe('supersessionChain', () => {
    it('walks superseded_by pointers to the terminal non-superseded entry', () => {
      const database = migrate();
      const a = seed(database, 'chain a');
      const b = seed(database, 'chain b');
      const c = seed(database, 'chain c');
      updateMemory(database, a, { status: 'superseded', superseded_by: b, reason: 'arrange' });
      updateMemory(database, b, { status: 'superseded', superseded_by: c, reason: 'arrange' });
      expect(supersessionChain(database, a)).toEqual([a, b, c]);
      expect(getMemory(database, c)?.status).toBe('active');
    });

    it('returns just the entry itself when it is not superseded', () => {
      const database = migrate();
      const a = seed(database, 'active entry');
      expect(supersessionChain(database, a)).toEqual([a]);
    });

    it('returns an empty chain for an unknown id', () => {
      const database = migrate();
      expect(supersessionChain(database, 'missing')).toEqual([]);
    });
  });
});
