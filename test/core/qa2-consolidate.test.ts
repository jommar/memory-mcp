import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';
import { createMemory, updateMemory } from '../../src/db/queries.js';
import { applyConsolidate, consolidateReport } from '../../src/core/lifecycle.js';

const vector = (components: number[]): Float32Array => {
  const v = new Float32Array(384);
  for (let i = 0; i < components.length; i += 1) v[i] = components[i];
  return v;
};

const DAY_MS = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const seedVector = (db: Database.Database, id: string, v: Float32Array): void => {
  const { rowid } = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
  db.prepare('INSERT INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)').run(
    BigInt(rowid),
    Buffer.from(v.buffer),
  );
};

const backdate = (db: Database.Database, id: string, createdAtMs: number, lastAccessMs?: number): void => {
  const updates: string[] = ['created_at = ?', 'updated_at = ?'];
  const params: (string | number)[] = [iso(createdAtMs), iso(createdAtMs)];
  if (lastAccessMs !== undefined) {
    updates.push('last_accessed_at = ?');
    params.push(iso(lastAccessMs));
  }
  params.push(id);
  db.prepare(`UPDATE memories SET ${updates.join(', ')} WHERE id = ?`).run(...params);
};

const seedOneOfEach = (db: Database.Database): string[] => {
  const now = Date.now();
  const ids: string[] = [];
  const expired = createMemory(db, {
    title: 'e', content: 'c', type: 'session', tier: 'short', source: 'user-stated',
    importance: 2, expires_at: '2020-01-01T00:00:00.000Z',
  });
  backdate(db, expired.id, now - 30 * DAY_MS, now - DAY_MS);
  ids.push(expired.id);

  const archive = createMemory(db, {
    title: 'a', content: 'c', type: 'fact', tier: 'long', source: 'user-stated', importance: 2,
  });
  backdate(db, archive.id, now - 200 * DAY_MS, now - 100 * DAY_MS);
  ids.push(archive.id);

  const reconfirm = createMemory(db, {
    title: 'r', content: 'c', type: 'fact', tier: 'long', source: 'user-stated', importance: 4,
  });
  backdate(db, reconfirm.id, now - 100 * DAY_MS, now - DAY_MS);
  ids.push(reconfirm.id);

  const expand = createMemory(db, {
    title: 'x', content: 'tiny', type: 'fact', tier: 'long', source: 'user-stated',
  });
  updateMemory(db, expand.id, { observed_count: 10, reason: 'fixture' });
  backdate(db, expand.id, now - DAY_MS, now - 3_600_000);
  ids.push(expand.id);

  const dupA = createMemory(db, { title: 'da', content: 'c', type: 'fact', tier: 'long', scope: 'dup', source: 'user-stated' });
  const dupB = createMemory(db, { title: 'db', content: 'c', type: 'fact', tier: 'long', scope: 'dup', source: 'user-stated' });
  seedVector(db, dupA.id, vector([1, 0]));
  seedVector(db, dupB.id, vector([1, 0]));
  backdate(db, dupA.id, now - DAY_MS, now - 3_600_000);
  backdate(db, dupB.id, now - DAY_MS, now - 3_600_000);
  ids.push(dupA.id, dupB.id);

  const orphan = createMemory(db, { title: 'o', content: 'c', type: 'fact', tier: 'long', source: 'user-stated' });
  backdate(db, orphan.id, now - DAY_MS);
  ids.push(orphan.id);

  return ids;
};

describe('consolidate apply outcomes (round-02 qa)', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  it('applying every action in one batch returns a per-signal outcome and empties the next report', () => {
    const database = migrate();
    seedOneOfEach(database);
    const report = consolidateReport(database);
    expect(report.actions).toHaveLength(6);
    const results = applyConsolidate(database, report.actions.map((a) => a.id));
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(
      ['archived', 'expired', 'merge-proposed', 'needs-expansion-flagged', 'orphan-flagged', 're-confirm-queued'].sort(),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(consolidateReport(database).actions).toEqual([]);
  });

  it('re-applying already-executed ids reports already-executed for every one (apply idempotency)', () => {
    const database = migrate();
    seedOneOfEach(database);
    const report = consolidateReport(database);
    applyConsolidate(database, report.actions.map((a) => a.id));
    const again = applyConsolidate(database, report.actions.map((a) => a.id));
    expect(again).toHaveLength(6);
    expect(again.every((r) => r.outcome === 'already-executed' && r.ok === false)).toBe(true);
  });

  it('a mixed batch of unknown and valid ids reports per-id results and persists the valid one', () => {
    const database = migrate();
    seedOneOfEach(database);
    const report = consolidateReport(database);
    const orphanAction = report.actions.find((a) => a.signal === 'orphan')!;
    const results = applyConsolidate(database, ['ghost:orphan', orphanAction.id]);
    expect(results).toEqual([
      { actionId: 'ghost:orphan', ok: false, outcome: 'unknown' },
      { actionId: orphanAction.id, ok: true, outcome: 'orphan-flagged' },
    ]);
    const again = applyConsolidate(database, [orphanAction.id]);
    expect(again).toEqual([{ actionId: orphanAction.id, ok: false, outcome: 'already-executed' }]);
  });

  it('generating a report does not write the applied-action ledger', () => {
    const database = migrate();
    seedOneOfEach(database);
    consolidateReport(database);
    const ledger = database
      .prepare("SELECT value FROM meta WHERE key = 'consolidate_applied_actions'")
      .get();
    expect(ledger).toBeUndefined();
  });
});
