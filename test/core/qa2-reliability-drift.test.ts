import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';
import { createMemory } from '../../src/db/queries.js';
import { computeReliability, type ReliabilitySource } from '../../src/core/reliability.js';
// NOTE: the module's ReliabilitySource type uses the typo'd 'agent-stated' key and
// rejects the DB/DESIGN 'user-stated' source; the cast below pins the intended contract.
import { memoryReliability } from '../../src/core/recall.js';

// Two implementations of the DESIGN §5 formula exist (src/core/reliability.ts and
// the read-time copy in src/core/recall.ts). These tests pin them to each other so
// a drift in either is caught instead of silently changing ranking behavior.
describe('reliability implementations agree (round-02 qa)', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  it.each([
    ['user-stated', 'fact', 0, 0, 0],
    ['agent-inferred', 'preference', 5, 1, 30],
    ['agent-guessed', 'session', 10, 2, 1],
    ['user-stated', 'decision', 3, 0, 100],
    ['agent-inferred', 'project-state', 7, 3, 14],
    ['agent-guessed', 'lesson', 20, 5, 60],
  ] as const)(
    'matches memoryReliability for source=%s type=%s obs=%s contra=%s days=%s',
    (source, type, observedCount, contradictionCount, days) => {
      const database = migrate();
      const now = Date.now();
      const createdAtMs = now - days * 86_400_000;
      const { id } = createMemory(database, {
        title: 'probe', content: 'c', type, tier: 'long', source,
        importance: 3,
      });
      database
        .prepare('UPDATE memories SET observed_count = ?, contradiction_count = ?, created_at = ?, updated_at = ? WHERE id = ?')
        .run(observedCount, contradictionCount, new Date(createdAtMs).toISOString(), new Date(createdAtMs).toISOString(), id);
      const row = database.prepare('SELECT * FROM memories WHERE id = ?').get(id) as never;
      const viaRow = memoryReliability(row, now);
      const viaFn = computeReliability({
        source: source as ReliabilitySource,
        type,
        observedCount,
        contradictionCount,
        createdAt: createdAtMs,
        now,
      });
      expect(Math.abs(viaRow - viaFn)).toBeLessThan(1e-12);
    },
  );

  it('the last_confirmed_at anchor is honored by both implementations', () => {
    const database = migrate();
    const now = Date.now();
    const createdAtMs = now - 100 * 86_400_000;
    const confirmedMs = now - 5 * 86_400_000;
    const { id } = createMemory(database, {
      title: 'probe', content: 'c', type: 'fact', tier: 'long', source: 'agent-inferred',
    });
    database
      .prepare('UPDATE memories SET created_at = ?, updated_at = ?, last_confirmed_at = ? WHERE id = ?')
      .run(new Date(createdAtMs).toISOString(), new Date(createdAtMs).toISOString(), new Date(confirmedMs).toISOString(), id);
    const row = database.prepare('SELECT * FROM memories WHERE id = ?').get(id) as never;
    const viaRow = memoryReliability(row, now);
    const viaFn = computeReliability({
      source: 'agent-inferred',
      type: 'fact',
      observedCount: 0,
      contradictionCount: 0,
      createdAt: createdAtMs,
      lastConfirmedAt: confirmedMs,
      now,
    });
    expect(Math.abs(viaRow - viaFn)).toBeLessThan(1e-12);
  });
});
