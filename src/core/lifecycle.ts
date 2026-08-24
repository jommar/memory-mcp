import type Database from 'better-sqlite3';
import {
  BASE_BY_SOURCE,
  createMemory,
  getMemory,
  listMemories,
  searchMemoriesByText,
  updateMemory,
  type MemoryRow,
  type MemorySource,
  type MemoryTier,
  type MemoryType,
} from '../db/queries.js';
import { createLink } from './links.js';
import { LAMBDA_BY_TYPE, memoryReliability } from './reliability.js';

const resolveMemoryId = (db: Database.Database, ref: string): string => {
  if (getMemory(db, ref)) return ref;
  const matches = searchMemoriesByText(db, ref);
  if (matches.length === 0) throw new Error(`no memory matched: ${ref}`);
  if (matches.length > 1) {
    throw new Error(`ambiguous ref, ${matches.length} memories matched: ${ref}`);
  }
  return matches[0].id;
};

export const confirmMemory = (db: Database.Database, ref: string): MemoryRow => {
  const id = resolveMemoryId(db, ref);
  const existing = getMemory(db, id)!;
  const observedCount = existing.observed_count + 1;
  const corroboration = 1 + Math.min(0.5, observedCount * 0.05);
  const penalty = Math.pow(0.7, existing.contradiction_count);
  const confidence = Math.min(1, BASE_BY_SOURCE[existing.source] * corroboration * penalty);
  return updateMemory(db, id, {
    last_confirmed_at: new Date().toISOString(),
    observed_count: observedCount,
    confidence,
    reason: 'confirmed',
  });
};

export interface ContradictInput {
  content: string;
  title?: string;
  type?: MemoryType;
  tier?: MemoryTier;
  scope?: string;
  source?: MemorySource;
  tags?: string[];
  importance?: number;
}

export const contradictMemory = (db: Database.Database, oldId: string, input: ContradictInput): MemoryRow => {
  const old = getMemory(db, oldId);
  if (!old) throw new Error(`memory not found: ${oldId}`);
  const correction = createMemory(db, {
    title: input.title ?? `correction of ${old.title}`,
    content: input.content,
    type: input.type ?? old.type,
    tier: input.tier ?? old.tier,
    scope: input.scope ?? old.scope,
    source: input.source ?? 'user-stated',
    tags: input.tags ?? [],
    importance: input.importance ?? old.importance,
  });
  updateMemory(db, oldId, {
    status: 'superseded',
    superseded_by: correction.id,
    reason: `superseded by correction ${correction.id}`,
  });
  createLink(db, { fromId: oldId, toId: correction.id, kind: 'contradicts' });
  return correction;
};

export const promoteMemory = (db: Database.Database, id: string): MemoryRow => {
  if (!getMemory(db, id)) throw new Error(`memory not found: ${id}`);
  return updateMemory(db, id, { tier: 'long', expires_at: null, reason: 'promoted to long tier' });
};

const DAY_MS = 86_400_000;
const META_APPLIED_KEY = 'consolidate_applied_actions';
const ARCHIVE_RELIABILITY = 0.35;
const ARCHIVE_UNUSED_DAYS = 90;
const EXPANSION_ACCESSES = 10;
const EXPANSION_MIN_CHARS = 400;
const DUPLICATE_COSINE = 0.92;

export type ConsolidateSignal =
  | 'expired-stm'
  | 'archive-candidate'
  | 're-confirm'
  | 'needs-expansion'
  | 'duplicate-cluster'
  | 'orphan';

export interface ConsolidateAction {
  id: string;
  memoryId: string;
  title: string;
  signal: ConsolidateSignal;
  detail: string;
}

export interface ConsolidateReport {
  actions: ConsolidateAction[];
}

export interface ApplyResult {
  actionId: string;
  ok: boolean;
  outcome: string;
}

const readAppliedIds = (db: Database.Database): Set<string> => {
  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(META_APPLIED_KEY) as { value: string } | undefined;
  if (!row?.value) return new Set();
  try {
    return new Set(JSON.parse(row.value) as string[]);
  } catch {
    return new Set();
  }
};

const persistAppliedIds = (db: Database.Database, ids: Set<string>): void => {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(META_APPLIED_KEY, JSON.stringify([...ids].sort()));
};

const actionFor = (row: MemoryRow, signal: ConsolidateSignal, detail: string): ConsolidateAction => ({
  id: `${row.id}:${signal}`,
  memoryId: row.id,
  title: row.title,
  signal,
  detail,
});

const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
};

const embeddingOf = (db: Database.Database, rowid: number): Float32Array | undefined => {
  const row = db
    .prepare('SELECT embedding FROM memories_vec WHERE memory_rowid = ?')
    .get(BigInt(rowid)) as { embedding: Buffer | Uint8Array } | undefined;
  if (!row) return undefined;
  const view = row.embedding as Uint8Array;
  return new Float32Array(view.buffer, view.byteOffset, view.byteLength / 4);
};

class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    const root = this.parent.get(x)!;
    if (root !== x) this.parent.set(x, this.find(root));
    return this.parent.get(x)!;
  }

  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b));
  }
}

const duplicateClusterActions = (
  db: Database.Database,
  active: MemoryRow[],
): ConsolidateAction[] => {
  const byScope = new Map<string, MemoryRow[]>();
  for (const row of active) {
    const group = byScope.get(row.scope) ?? [];
    group.push(row);
    byScope.set(row.scope, group);
  }
  const actions: ConsolidateAction[] = [];
  for (const group of byScope.values()) {
    if (group.length < 2) continue;
    const uf = new UnionFind();
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        const va = embeddingOf(db, rowidOf(db, a.id));
        const vb = embeddingOf(db, rowidOf(db, b.id));
        if (va && vb && cosine(va, vb) > DUPLICATE_COSINE) uf.union(a.id, b.id);
      }
    }
    const clusters = new Map<string, MemoryRow[]>();
    for (const row of group) {
      const root = uf.find(row.id);
      const members = clusters.get(root) ?? [];
      members.push(row);
      clusters.set(root, members);
    }
    for (const members of clusters.values()) {
      if (members.length < 2) continue;
      const canonical = [...members].sort((a, b) => a.id.localeCompare(b.id))[0];
      actions.push(
        actionFor(
          canonical,
          'duplicate-cluster',
          `merge proposal: ${members.map((m) => m.id).sort().join(', ')}`,
        ),
      );
    }
  }
  return actions;
};

const rowidOf = (db: Database.Database, id: string): number =>
  (db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number }).rowid;

export const consolidateReport = (db: Database.Database): ConsolidateReport => {
  const now = Date.now();
  const applied = readAppliedIds(db);
  const active = listMemories(db).filter((row) => row.status === 'active');
  const actions: ConsolidateAction[] = [];

  for (const row of active) {
    if (row.tier === 'short' && row.expires_at !== null && new Date(row.expires_at).getTime() < now) {
      actions.push(actionFor(row, 'expired-stm', `expired STM at ${row.expires_at}`));
    }
    const reliability = memoryReliability(row, now);
    if (
      row.importance <= 2 &&
      row.last_accessed_at !== null &&
      now - new Date(row.last_accessed_at).getTime() > ARCHIVE_UNUSED_DAYS * DAY_MS &&
      reliability < ARCHIVE_RELIABILITY
    ) {
      actions.push(
        actionFor(row, 'archive-candidate', `reliability ${reliability.toFixed(3)}, unused ${ARCHIVE_UNUSED_DAYS}+ days`),
      );
    }
    const staleDays = Math.log(2) / LAMBDA_BY_TYPE[row.type];
    const anchor = row.last_confirmed_at ?? row.created_at;
    if (row.importance >= 3 && now - new Date(anchor).getTime() > staleDays * DAY_MS) {
      actions.push(actionFor(row, 're-confirm', `unconfirmed past type TTL (~${Math.round(staleDays)}d)`));
    }
    if (row.observed_count >= EXPANSION_ACCESSES && row.content.length < EXPANSION_MIN_CHARS) {
      actions.push(
        actionFor(row, 'needs-expansion', `${row.observed_count} accesses but only ${row.content.length} chars`),
      );
    }
  }

  for (const row of active) {
    if (row.last_accessed_at !== null) continue;
    const outgoing = db.prepare('SELECT 1 FROM links WHERE from_id = ? LIMIT 1').get(row.id);
    const incoming = db.prepare('SELECT 1 FROM links WHERE to_id = ? LIMIT 1').get(row.id);
    if (!outgoing && !incoming) {
      actions.push(actionFor(row, 'orphan', 'no links and never accessed'));
    }
  }

  actions.push(...duplicateClusterActions(db, active));

  const unique = new Map<string, ConsolidateAction>();
  for (const action of actions) unique.set(action.id, action);
  const visible = [...unique.values()]
    .filter((action) => !applied.has(action.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { actions: visible };
};

export const applyConsolidate = (db: Database.Database, actionIds: string[]): ApplyResult[] => {
  const applied = readAppliedIds(db);
  const current = new Map(consolidateReport(db).actions.map((action) => [action.id, action]));
  const results: ApplyResult[] = [];
  const executed = new Set(applied);
  for (const actionId of actionIds) {
    if (applied.has(actionId)) {
      results.push({ actionId, ok: false, outcome: 'already-executed' });
      continue;
    }
    const action = current.get(actionId);
    if (!action) {
      results.push({ actionId, ok: false, outcome: 'unknown' });
      continue;
    }
    const row = getMemory(db, action.memoryId)!;
    let outcome: string;
    switch (action.signal) {
      case 'expired-stm':
        updateMemory(db, row.id, { status: 'expired', reason: 'expired by consolidate' });
        outcome = 'expired';
        break;
      case 'archive-candidate':
        updateMemory(db, row.id, { status: 'archived', reason: 'archived by consolidate' });
        outcome = 'archived';
        break;
      case 're-confirm':
        outcome = 're-confirm-queued';
        break;
      case 'needs-expansion':
        outcome = 'needs-expansion-flagged';
        break;
      case 'duplicate-cluster':
        outcome = 'merge-proposed';
        break;
      case 'orphan':
        outcome = 'orphan-flagged';
        break;
    }
    executed.add(actionId);
    results.push({ actionId, ok: true, outcome });
  }
  if (results.some((result) => result.ok)) persistAppliedIds(db, executed);
  return results;
};
