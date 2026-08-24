import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';
import { createMemory, forgetMemory, getMemory, listMemories, makeMemoryId, updateMemory } from '../../src/db/queries.js';

describe('memory store queries', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  describe('makeMemoryId', () => {
    it('is deterministic and slug-safe', () => {
      const first = makeMemoryId('Deploy runbook (v2)!');
      const second = makeMemoryId('Deploy runbook (v2)!');
      expect(first).toBe(second);
      expect(first).toMatch(/^[a-z0-9-]+$/);
    });

    it('derives distinct ids for distinct titles', () => {
      expect(makeMemoryId('alpha')).not.toBe(makeMemoryId('beta'));
    });
  });

  describe('createMemory', () => {
    it('persists every field with generated id and ISO timestamps', () => {
      const database = migrate();
      const { id } = createMemory(database, {
        title: 'Prefer local-first tooling',
        content: 'Self-hosted tools beat SaaS for personal infra.',
        type: 'preference',
        tier: 'long',
        source: 'user-stated',
        scope: 'dev',
        tags: ['tooling', 'preferences'],
        importance: 4,
        expires_at: '2026-09-01T00:00:00.000Z',
      });
      expect(id).toBe(makeMemoryId('Prefer local-first tooling'));

      const row = getMemory(database, id);
      expect(row).toMatchObject({
        id,
        title: 'Prefer local-first tooling',
        content: 'Self-hosted tools beat SaaS for personal infra.',
        type: 'preference',
        tier: 'long',
        scope: 'dev',
        tags: ['tooling', 'preferences'],
        status: 'active',
        superseded_by: null,
        source: 'user-stated',
        importance: 4,
        confidence: 1,
        observed_count: 0,
        contradiction_count: 0,
        last_accessed_at: null,
        last_confirmed_at: null,
        expires_at: '2026-09-01T00:00:00.000Z',
      });
      expect(row?.created_at).toBe(row?.updated_at);
      expect(new Date(row!.created_at!).toISOString()).toBe(row!.created_at);
    });

    it('defaults scope, tags, importance and status', () => {
      const database = migrate();
      const { id } = createMemory(database, {
        title: 'Keep the kitchen tidy',
        content: 'Wipe the counter after every session.',
        type: 'decision',
        tier: 'short',
        source: 'agent-inferred',
      });
      expect(getMemory(database, id)).toMatchObject({
        scope: 'global',
        tags: [],
        importance: 3,
        status: 'active',
      });
    });

    it.each([
      ['user-stated', 1],
      ['agent-inferred', 0.7],
      ['agent-guessed', 0.4],
    ] as const)('derives write-time confidence %s from the source base', (source, expected) => {
      const database = migrate();
      const { id } = createMemory(database, {
        title: `seed-${source}`,
        content: 'body',
        type: 'fact',
        tier: 'long',
        source,
      });
      expect(getMemory(database, id)?.confidence).toBe(expected);
    });

    it('honors an explicit id', () => {
      const database = migrate();
      const { id } = createMemory(database, {
        id: 'custom-key',
        title: 'Explicit key',
        content: 'body',
        type: 'fact',
        tier: 'long',
        source: 'user-stated',
      });
      expect(id).toBe('custom-key');
      expect(getMemory(database, 'custom-key')?.title).toBe('Explicit key');
    });
  });

  describe('getMemory', () => {
    it('returns undefined for an unknown id', () => {
      const database = migrate();
      expect(getMemory(database, 'missing')).toBeUndefined();
    });
  });
});

describe('updateMemory', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  const seed = (database: Database.Database): string => {
    const { id } = createMemory(database, {
      title: 'Cache invalidation rules',
      content: 'Invalidate on write, not on read.',
      type: 'fact',
      tier: 'long',
      source: 'user-stated',
    });
    return id;
  };

  const historyRows = (database: Database.Database, id: string): unknown[] =>
    database
      .prepare('SELECT memory_id, content_before, content_after, reason, changed_at FROM history WHERE memory_id = ?')
      .all(id);

  it('appends exactly one history row carrying before/after content and the reason', () => {
    const database = migrate();
    const id = seed(database);
    const before = getMemory(database, id)!;
    const { updated_at } = updateMemory(database, id, {
      content: 'Invalidate on write, and on dependency change.',
      reason: 'reader found stale cache after dependency bump',
    });
    const rows = historyRows(database, id) as {
      content_before: string | null;
      content_after: string | null;
      reason: string | null;
      changed_at: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      memory_id: id,
      content_before: before.content,
      content_after: 'Invalidate on write, and on dependency change.',
      reason: 'reader found stale cache after dependency bump',
      changed_at: updated_at,
    });
  });

  it('appends exactly one history row per update call', () => {
    const database = migrate();
    const id = seed(database);
    updateMemory(database, id, { content: 'first edit', reason: 'r1' });
    updateMemory(database, id, { content: 'second edit', reason: 'r2' });
    expect(historyRows(database, id)).toHaveLength(2);
  });

  it('rejects a content update without a reason', () => {
    const database = migrate();
    const id = seed(database);
    expect(() => updateMemory(database, id, { content: 'unsupported edit' })).toThrow(/reason/);
  });

  it('records a null content_before for non-content updates', () => {
    const database = migrate();
    const id = seed(database);
    updateMemory(database, id, { importance: 2, reason: 'downgraded priority' });
    const rows = historyRows(database, id) as {
      content_before: string | null;
      content_after: string | null;
      reason: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      memory_id: id,
      content_before: null,
      content_after: null,
      reason: 'downgraded priority',
    });
    expect(getMemory(database, id)?.importance).toBe(2);
  });

  it('allows a reason-less non-content update', () => {
    const database = migrate();
    const id = seed(database);
    updateMemory(database, id, { scope: 'ops' });
    const rows = historyRows(database, id) as { content_before: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].content_before).toBeNull();
    expect(getMemory(database, id)?.scope).toBe('ops');
  });

  it('throws for an unknown id', () => {
    const database = migrate();
    expect(() => updateMemory(database, 'missing', { content: 'x', reason: 'r' })).toThrow(/missing/);
  });
});

describe('listMemories', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  const seed = (database: Database.Database): string[] => {
    const ids: string[] = [];
    const fixtures = [
      { title: 'nginx config', content: 'c', type: 'procedure', tier: 'long', scope: 'dev', status: 'active', source: 'user-stated' },
      { title: 'team norms', content: 'c', type: 'lesson', tier: 'short', scope: 'dev', status: 'active', source: 'agent-inferred' },
      { title: 'meeting cadence', content: 'c', type: 'decision', tier: 'long', scope: 'global', status: 'archived', source: 'agent-guessed' },
    ] as const;
    for (const f of fixtures) {
      ids.push(createMemory(database, f).id);
    }
    return ids;
  };

  it('returns every memory when no filters are given', () => {
    const database = migrate();
    const ids = seed(database);
    const result = listMemories(database);
    expect(result.map((row) => row.id).sort()).toEqual([...ids].sort());
    expect(listMemories(database)).toEqual(result);
  });

  it('filters by scope', () => {
    const database = migrate();
    seed(database);
    const rows = listMemories(database, { scope: 'dev' });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.scope === 'dev')).toBe(true);
  });

  it('filters by tier', () => {
    const database = migrate();
    seed(database);
    const rows = listMemories(database, { tier: 'long' });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.tier === 'long')).toBe(true);
  });

  it('filters by type', () => {
    const database = migrate();
    seed(database);
    const rows = listMemories(database, { type: 'lesson' });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('team norms');
  });

  it('filters by status', () => {
    const database = migrate();
    seed(database);
    const rows = listMemories(database, { status: 'archived' });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('meeting cadence');
  });

  it('combines filters with AND semantics', () => {
    const database = migrate();
    seed(database);
    expect(listMemories(database, { scope: 'dev', tier: 'long' })).toHaveLength(1);
    expect(listMemories(database, { scope: 'dev', tier: 'short' })).toHaveLength(1);
  });

  it('returns an empty list when nothing matches', () => {
    const database = migrate();
    seed(database);
    expect(listMemories(database, { status: 'expired' })).toEqual([]);
  });

  it('orders by created_at descending', () => {
    const database = migrate();
    database
      .prepare(
        `INSERT INTO memories (id, title, content, type, tier, source, created_at, updated_at)
         VALUES ('older', 'older', 'body', 'fact', 'long', 'user-stated', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
                ('middle', 'middle', 'body', 'fact', 'long', 'user-stated', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
                ('newer', 'newer', 'body', 'fact', 'long', 'user-stated', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`,
      )
      .run();
    expect(listMemories(database).map((row) => row.id)).toEqual(['newer', 'middle', 'older']);
  });
});

describe('forgetMemory', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  it('archives by default: row retained with status archived', () => {
    const database = migrate();
    const { id } = createMemory(database, {
      title: 'old note',
      content: 'keep the row',
      type: 'fact',
      tier: 'long',
      source: 'user-stated',
    });
    forgetMemory(database, id);
    const row = getMemory(database, id);
    expect(row).toBeDefined();
    expect(row?.status).toBe('archived');
    expect(row?.content).toBe('keep the row');
  });

  it('leaves unrelated memories untouched', () => {
    const database = migrate();
    const { id: victim } = createMemory(database, {
      title: 'victim', content: 'c', type: 'fact', tier: 'long', source: 'user-stated',
    });
    const { id: survivor } = createMemory(database, {
      title: 'survivor', content: 'c', type: 'fact', tier: 'long', source: 'user-stated',
    });
    forgetMemory(database, victim);
    expect(getMemory(database, survivor)?.status).toBe('active');
  });

  it('throws for an unknown id', () => {
    const database = migrate();
    expect(() => forgetMemory(database, 'missing')).toThrow(/missing/);
  });

  it('purge deletes the row and its links via FK cascade', () => {
    const database = migrate();
    const { id: a } = createMemory(database, {
      title: 'alpha', content: 'c', type: 'fact', tier: 'long', source: 'user-stated',
    });
    const { id: b } = createMemory(database, {
      title: 'beta', content: 'c', type: 'fact', tier: 'long', source: 'user-stated',
    });
    const link = database.prepare(
      'INSERT INTO links (from_id, to_id, kind) VALUES (?, ?, ?)',
    );
    link.run(a, b, 'related');
    link.run(b, a, 'contradicts');
    database
      .prepare('INSERT INTO history (memory_id, content_before, content_after, reason, changed_at) VALUES (?, NULL, NULL, ?, ?)')
      .run(a, 'purge fixture', '2026-01-01T00:00:00.000Z');

    forgetMemory(database, a, { purge: true });

    expect(getMemory(database, a)).toBeUndefined();
    expect(getMemory(database, b)).toBeDefined();
    const remaining = database
      .prepare('SELECT from_id, to_id, kind FROM links')
      .all() as { from_id: string }[];
    expect(remaining).toEqual([]);
    const history = database
      .prepare('SELECT memory_id FROM history WHERE memory_id = ?')
      .all(a);
    expect(history).toEqual([]);
  });
});
