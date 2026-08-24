import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';
import { createMemory, getMemory, listMemories } from '../../src/db/queries.js';
import { listOutgoingLinks } from '../../src/core/links.js';
import { confirmMemory, contradictMemory, promoteMemory } from '../../src/core/lifecycle.js';

describe('lifecycle operations', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  describe('confirmMemory', () => {
    it('resolves by id, then advances last_confirmed_at, observed_count and confidence', () => {
      const database = migrate();
      const { id } = createMemory(database, {
        title: 'prefer plain text',
        content: 'Markdown over rich formats.',
        type: 'preference',
        tier: 'long',
        source: 'agent-inferred',
      });
      expect(getMemory(database, id)).toMatchObject({ observed_count: 0, confidence: 0.7, last_confirmed_at: null });
      const before = Date.now();
      confirmMemory(database, id);
      const after = getMemory(database, id)!;
      expect(after.observed_count).toBe(1);
      expect(after.last_confirmed_at).not.toBeNull();
      expect(new Date(after.last_confirmed_at!).getTime()).toBeGreaterThanOrEqual(before);
      expect(after.confidence).toBeGreaterThan(0.7);
      expect(after.confidence).toBeCloseTo(0.735, 3);
    });

    it('resolves by a query against title or content', () => {
      const database = migrate();
      createMemory(database, {
        title: 'portland hours',
        content: 'The Portland office closes at 5pm on Fridays.',
        type: 'fact',
        tier: 'long',
        source: 'agent-guessed',
      });
      confirmMemory(database, 'Portland office');
      const matches = listMemories(database).filter((row) => row.observed_count === 1);
      expect(matches).toHaveLength(1);
      expect(matches[0].title).toBe('portland hours');
    });

    it('throws when the query matches no memory', () => {
      const database = migrate();
      expect(() => confirmMemory(database, 'zzz-no-such-token')).toThrow(/no memory matched/);
    });

    it('throws when the query is ambiguous', () => {
      const database = migrate();
      createMemory(database, {
        title: 'first shared note', content: 'shared term appears here', type: 'fact', tier: 'long', source: 'user-stated',
      });
      createMemory(database, {
        title: 'second shared note', content: 'shared term also here', type: 'fact', tier: 'long', source: 'user-stated',
      });
      expect(() => confirmMemory(database, 'shared term')).toThrow(/ambiguous/);
    });

    it('clamps confidence to 1.0 for a heavily confirmed user-stated memory', () => {
      const database = migrate();
      const { id } = createMemory(database, {
        title: 'trusted fact',
        content: 'body',
        type: 'fact',
        tier: 'long',
        source: 'user-stated',
      });
      for (let i = 0; i < 10; i += 1) {
        confirmMemory(database, id);
      }
      const after = getMemory(database, id)!;
      expect(after.observed_count).toBe(10);
      expect(after.confidence).toBe(1);
    });
  });

  describe('contradictMemory', () => {
    it('creates the correction, supersedes the old entry, and records a contradicts link', () => {
      const database = migrate();
      const old = createMemory(database, {
        title: 'Old fact',
        content: 'The earth is flat.',
        type: 'fact',
        tier: 'long',
        scope: 'science',
        source: 'agent-inferred',
      });
      const correction = contradictMemory(database, old.id, { content: 'The earth is round.' });

      const oldAfter = getMemory(database, old.id)!;
      expect(oldAfter.status).toBe('superseded');
      expect(oldAfter.superseded_by).toBe(correction.id);

      const correctionAfter = getMemory(database, correction.id)!;
      expect(correctionAfter.content).toBe('The earth is round.');
      expect(correctionAfter.type).toBe('fact');
      expect(correctionAfter.scope).toBe('science');
      expect(correctionAfter.source).toBe('user-stated');
      expect(correctionAfter.status).toBe('active');

      expect(listOutgoingLinks(database, old.id)).toEqual([
        { fromId: old.id, toId: correction.id, kind: 'contradicts' },
      ]);
    });

    it('throws for an unknown old entry', () => {
      const database = migrate();
      expect(() => contradictMemory(database, 'missing', { content: 'correction' })).toThrow(/not found/);
    });
  });

  describe('promoteMemory', () => {
    it('flips short to long and clears expires_at', () => {
      const database = migrate();
      const { id } = createMemory(database, {
        title: 'session note',
        content: 'scratch',
        type: 'session',
        tier: 'short',
        source: 'user-stated',
        expires_at: '2026-09-01T00:00:00.000Z',
      });
      promoteMemory(database, id);
      const after = getMemory(database, id)!;
      expect(after.tier).toBe('long');
      expect(after.expires_at).toBeNull();
    });

    it('throws for an unknown id', () => {
      const database = migrate();
      expect(() => promoteMemory(database, 'missing')).toThrow(/not found/);
    });
  });
});
