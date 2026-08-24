import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';
import { createMemory, getMemory, listMemories, updateMemory } from '../../src/db/queries.js';
import { applyConsolidate, consolidateReport } from '../../src/core/lifecycle.js';

const vector = (components: number[]): Float32Array => {
  const v = new Float32Array(384);
  for (let i = 0; i < components.length; i += 1) v[i] = components[i];
  return v;
};

const DAY_MS = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const seedVector = (db: Database.Database, id: string, v: Float32Array): void => {
  const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
  db.prepare('INSERT INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)').run(
    BigInt(row.rowid),
    Buffer.from(v.buffer),
  );
};

const backdate = (
  db: Database.Database,
  id: string,
  fields: { createdAtMs: number; lastAccessMs?: number },
): void => {
  const updates: string[] = ["created_at = ?", "updated_at = ?"];
  const params: (string | number)[] = [iso(fields.createdAtMs), iso(fields.createdAtMs)];
  if (fields.lastAccessMs !== undefined) {
    updates.push('last_accessed_at = ?');
    params.push(iso(fields.lastAccessMs));
  }
  params.push(id);
  db.prepare(`UPDATE memories SET ${updates.join(', ')} WHERE id = ?`).run(...params);
};

interface Fixtures {
  expiredId: string;
  archiveId: string;
  reconfirmId: string;
  expandId: string;
  dupIds: [string, string];
  orphanId: string;
}

const seedAll = (db: Database.Database): Fixtures => {
  const now = Date.now();

  const expired = createMemory(db, {
    title: 'expired session', content: 'old session scratch', type: 'session', tier: 'short',
    scope: 'sig', source: 'user-stated', importance: 2, expires_at: '2020-01-01T00:00:00.000Z',
  });
  backdate(db, expired.id, { createdAtMs: now - 30 * DAY_MS, lastAccessMs: now - DAY_MS });

  const archive = createMemory(db, {
    title: 'archive me', content: 'obsolete preference', type: 'fact', tier: 'long',
    scope: 'sig', source: 'user-stated', importance: 2,
  });
  backdate(db, archive.id, { createdAtMs: now - 200 * DAY_MS, lastAccessMs: now - 100 * DAY_MS });

  const reconfirm = createMemory(db, {
    title: 'reconfirm me', content: 'stale important fact', type: 'fact', tier: 'long',
    scope: 'sig', source: 'user-stated', importance: 4,
  });
  backdate(db, reconfirm.id, { createdAtMs: now - 100 * DAY_MS, lastAccessMs: now - DAY_MS });

  const expand = createMemory(db, {
    title: 'expand me', content: 'tiny', type: 'fact', tier: 'long',
    scope: 'sig', source: 'user-stated',
  });
  updateMemory(db, expand.id, { observed_count: 10, reason: 'fixture' });
  backdate(db, expand.id, { createdAtMs: now - DAY_MS, lastAccessMs: now - 3_600_000 });

  const dupA = createMemory(db, {
    title: 'dup alpha', content: 'same fact a', type: 'fact', tier: 'long',
    scope: 'dup', source: 'user-stated',
  });
  const dupB = createMemory(db, {
    title: 'dup beta', content: 'same fact b', type: 'fact', tier: 'long',
    scope: 'dup', source: 'user-stated',
  });
  seedVector(db, dupA.id, vector([1, 0]));
  seedVector(db, dupB.id, vector([1, 0]));
  backdate(db, dupA.id, { createdAtMs: now - DAY_MS, lastAccessMs: now - 3_600_000 });
  backdate(db, dupB.id, { createdAtMs: now - DAY_MS, lastAccessMs: now - 3_600_000 });

  const orphan = createMemory(db, {
    title: 'orphan', content: 'isolated and never touched', type: 'fact', tier: 'long',
    scope: 'sig', source: 'user-stated',
  });
  backdate(db, orphan.id, { createdAtMs: now - DAY_MS });

  return {
    expiredId: expired.id,
    archiveId: archive.id,
    reconfirmId: reconfirm.id,
    expandId: expand.id,
    dupIds: [dupA.id, dupB.id],
    orphanId: orphan.id,
  };
};

describe('consolidate report', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  it('lists one stable action per signal with deterministic ids', () => {
    const database = migrate();
    const f = seedAll(database);
    const report = consolidateReport(database);
    const ids = report.actions.map((a) => a.id).sort();
    expect(ids).toEqual(
      [
        `${f.expiredId}:expired-stm`,
        `${f.archiveId}:archive-candidate`,
        `${f.reconfirmId}:re-confirm`,
        `${f.expandId}:needs-expansion`,
        `${[f.dupIds[0], f.dupIds[1]].sort()[0]}:duplicate-cluster`,
        `${f.orphanId}:orphan`,
      ].sort(),
    );
  });

  it('generating a report mutates nothing', () => {
    const database = migrate();
    seedAll(database);
    const before = listMemories(database).map((r) => JSON.stringify(r)).sort();
    const vecBefore = (database.prepare('SELECT count(*) AS n FROM memories_vec').get() as { n: number }).n;
    const linksBefore = (database.prepare('SELECT count(*) AS n FROM links').get() as { n: number }).n;
    consolidateReport(database);
    const after = listMemories(database).map((r) => JSON.stringify(r)).sort();
    const vecAfter = (database.prepare('SELECT count(*) AS n FROM memories_vec').get() as { n: number }).n;
    const linksAfter = (database.prepare('SELECT count(*) AS n FROM links').get() as { n: number }).n;
    expect(after).toEqual(before);
    expect(vecAfter).toBe(vecBefore);
    expect(linksAfter).toBe(linksBefore);
  });
});

describe('consolidate apply', () => {
  let db: Database.Database;
  afterEach(() => {
    db?.close();
  });

  const migrate = (): Database.Database => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    return db;
  };

  it('executes only the named selections and returns per-id outcomes', () => {
    const database = migrate();
    const f = seedAll(database);
    const report = consolidateReport(database);
    const expiredAction = report.actions.find((a) => a.signal === 'expired-stm')!;
    const archiveAction = report.actions.find((a) => a.signal === 'archive-candidate')!;

    const results = applyConsolidate(database, [expiredAction.id]);
    expect(results).toEqual([{ actionId: expiredAction.id, ok: true, outcome: 'expired' }]);
    expect(getMemory(database, f.expiredId)!.status).toBe('expired');
    expect(getMemory(database, f.archiveId)!.status).toBe('active');

    const next = consolidateReport(database);
    expect(next.actions.map((a) => a.id)).not.toContain(expiredAction.id);
    expect(next.actions.map((a) => a.id)).toContain(archiveAction.id);
  });

  it('rejects unknown action ids', () => {
    const database = migrate();
    seedAll(database);
    const results = applyConsolidate(database, ['no-such-id:expired-stm']);
    expect(results).toEqual([{ actionId: 'no-such-id:expired-stm', ok: false, outcome: 'unknown' }]);
  });

  it('rejects already-executed action ids', () => {
    const database = migrate();
    const f = seedAll(database);
    const report = consolidateReport(database);
    const expiredAction = report.actions.find((a) => a.signal === 'expired-stm')!;
    applyConsolidate(database, [expiredAction.id]);
    const again = applyConsolidate(database, [expiredAction.id]);
    expect(again).toEqual([{ actionId: expiredAction.id, ok: false, outcome: 'already-executed' }]);
    expect(getMemory(database, f.expiredId)!.status).toBe('expired');
  });

  it('records advisory actions without mutating the underlying memory', () => {
    const database = migrate();
    const f = seedAll(database);
    const report = consolidateReport(database);
    const reconfirm = report.actions.find((a) => a.signal === 're-confirm')!;
    const results = applyConsolidate(database, [reconfirm.id]);
    expect(results).toEqual([{ actionId: reconfirm.id, ok: true, outcome: 're-confirm-queued' }]);
    expect(getMemory(database, f.reconfirmId)!.status).toBe('active');
    const next = consolidateReport(database);
    expect(next.actions.map((a) => a.id)).not.toContain(reconfirm.id);
  });

  it('archives on explicit apply for an archive candidate', () => {
    const database = migrate();
    const f = seedAll(database);
    const report = consolidateReport(database);
    const archive = report.actions.find((a) => a.signal === 'archive-candidate')!;
    const results = applyConsolidate(database, [archive.id]);
    expect(results).toEqual([{ actionId: archive.id, ok: true, outcome: 'archived' }]);
    expect(getMemory(database, f.archiveId)!.status).toBe('archived');
  });
});
