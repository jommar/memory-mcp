import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { openDatabase, openDatabaseReadOnly } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';
import { createMemory } from '../../src/db/queries.js';
import {
  consolidatePayload,
  detailPayload,
  graphPayload,
  statsPayload,
} from '../server/api.js';
import { cleanupAll, makeDb, seedGraph, tempDir } from './fixtures.js';

afterEach(cleanupAll);

describe('graphPayload', () => {
  it('returns nodes with reliability in [0,1] and the seeded edges', () => {
    const db = makeDb();
    const ids = seedGraph(db);
    const payload = graphPayload(db);
    expect(payload.nodes).toHaveLength(3);
    for (const node of payload.nodes) {
      expect(node.reliability).toBeGreaterThanOrEqual(0);
      expect(node.reliability).toBeLessThanOrEqual(1);
      expect(Array.isArray(node.tags)).toBe(true);
    }
    expect(payload.edges).toContainEqual({
      fromId: ids.preferenceId,
      toId: ids.procedureId,
      kind: 'related',
    });
    expect(payload.edges).toContainEqual({
      fromId: ids.archivedId,
      toId: ids.procedureId,
      kind: 'supersedes',
    });
    db.close();
  });

  it('returns empty arrays for an empty store', () => {
    const db = makeDb();
    expect(graphPayload(db)).toEqual({ nodes: [], edges: [] });
    db.close();
  });
});

describe('statsPayload', () => {
  it('tallies tiers, statuses, types and scopes with average reliability', () => {
    const db = makeDb();
    seedGraph(db);
    const stats = statsPayload(db);
    expect(stats.total).toBe(3);
    expect(stats.byStatus.active).toBe(2);
    expect(stats.byStatus.archived).toBe(1);
    expect(stats.byTier.long).toBe(3);
    expect(stats.byScope.global).toBe(2);
    expect(stats.byScope['memory-mcp']).toBe(1);
    expect(stats.avgReliability).toBeGreaterThan(0);
    expect(stats.avgReliability).toBeLessThanOrEqual(1);
    db.close();
  });
});

describe('detailPayload', () => {
  it('returns memory, factor breakdown, history and neighbor summaries', () => {
    const db = makeDb();
    const ids = seedGraph(db);
    const detail = detailPayload(db, ids.procedureId);
    expect(detail).toBeDefined();
    expect(detail!.memory.id).toBe(ids.procedureId);
    expect(detail!.breakdown.base).toBe(0.7); // agent-inferred
    expect(detail!.breakdown.penalty).toBe(1); // no contradictions
    expect(detail!.history).toHaveLength(1);
    expect(detail!.history[0].reason).toBe('runbook revision after incident review');
    expect(detail!.outgoing).toEqual([]);
    expect(detail!.incoming).toContainEqual({
      id: ids.preferenceId,
      title: 'Prefers dark mode',
      kind: 'related',
    });
    expect(detail!.chain).toEqual([ids.procedureId]);
    db.close();
  });

  it('returns undefined for an unknown id', () => {
    const db = makeDb();
    expect(detailPayload(db, 'missing-id')).toBeUndefined();
    db.close();
  });
});

describe('consolidatePayload', () => {
  it('returns a report-shaped action list on a read-only handle', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'seeded.db');
    const writer = openDatabase(dbPath);
    runMigrations(writer, MIGRATIONS);
    createMemory(writer, {
      title: 'Orphan note',
      content: 'never linked, never accessed',
      type: 'fact',
      tier: 'long',
      source: 'agent-guessed',
    });
    writer.close();

    const ro = openDatabaseReadOnly(dbPath);
    const report = consolidatePayload(ro);
    expect(Array.isArray(report.actions)).toBe(true);
    expect(report.actions.some((action) => action.signal === 'orphan')).toBe(true);
    ro.close();
  });
});

describe('openDatabaseReadOnly', () => {
  it('refuses writes at the SQLite layer', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'readonly.db');
    const writer = openDatabase(dbPath);
    runMigrations(writer, MIGRATIONS);
    writer.close();

    const ro = openDatabaseReadOnly(dbPath);
    expect(() =>
      ro.prepare('INSERT INTO memories (id, title, content, type, tier, source) VALUES (?, ?, ?, ?, ?, ?)').run(
        'x',
        'x',
        'x',
        'fact',
        'long',
        'user-stated',
      ),
    ).toThrow(/readonly/i);
    ro.close();
  });

  it('fails when the database file does not exist', () => {
    const dir = tempDir();
    expect(() => openDatabaseReadOnly(join(dir, 'absent.db'))).toThrow();
  });
});
