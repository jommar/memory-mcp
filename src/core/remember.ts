import type Database from 'better-sqlite3';
import {
  createMemory,
  getMemory,
  type MemoryRow,
  type MemorySource,
  type MemoryTier,
  type MemoryType,
} from '../db/queries.js';
import type { EmbeddingProvider } from '../embeddings/types.js';

// Starting cosine thresholds; tunable after v1.
export const DEDUPE_COSINE_THRESHOLD = 0.88;
export const CONFLICT_COSINE_THRESHOLD = 0.6;
const KNN_K = 50;

const STM_TTL_HOURS: Record<MemoryType, number | null> = {
  session: 24,
  'project-state': 14 * 24,
  preference: null,
  decision: null,
  fact: null,
  procedure: null,
  person: null,
  lesson: null,
};

export const tierAndTtl = (type: MemoryType): { tier: MemoryTier; ttlMs: number | null } => {
  const hours = STM_TTL_HOURS[type];
  if (hours === null) return { tier: 'long', ttlMs: null };
  return { tier: 'short', ttlMs: hours * 3_600_000 };
};

export interface RememberInput {
  title: string;
  content: string;
  type: MemoryType;
  scope?: string;
  tags?: string[];
  source?: MemorySource;
  importance?: number;
}

export interface RememberOptions {
  embedder?: EmbeddingProvider | null;
  force?: boolean;
}

export interface RememberResult {
  result: string;
  outcome: 'created' | 'merged' | 'conflict';
  id?: string;
  candidates?: string[];
}

const memoryByRowid = (db: Database.Database, rowid: number): MemoryRow | undefined => {
  const row = db.prepare('SELECT id FROM memories WHERE rowid = ?').get(rowid) as
    | { id: string }
    | undefined;
  return row ? getMemory(db, row.id) : undefined;
};

const insertVector = (db: Database.Database, id: string, value: Float32Array): void => {
  const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
  db.prepare('INSERT INTO memories_vec(memory_rowid, embedding) VALUES (?, ?)').run(
    BigInt(row.rowid),
    Buffer.from(value.buffer),
  );
};

export const remember = async (
  db: Database.Database,
  input: RememberInput,
  options: RememberOptions = {},
): Promise<RememberResult> => {
  const scope = input.scope ?? 'global';
  let vector: Float32Array | undefined;
  if (options.embedder) {
    try {
      const [embedded] = await options.embedder.embed([input.content]);
      vector = embedded;
    } catch {
      // Degrade open: still store the memory without a vector so the keyword
      // leg can find it. Dedupe is impossible without an embedding.
      vector = undefined;
    }
  }

  if (vector && !options.force) {
    const neighbors = db
      .prepare(
        'SELECT memory_rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ?',
      )
      .all(Buffer.from(vector.buffer), KNN_K) as { memory_rowid: number; distance: number }[];
    const candidates = neighbors
      .map(({ memory_rowid, distance }) => ({ memory: memoryByRowid(db, memory_rowid), cosine: 1 - distance }))
      .filter(({ memory, cosine }) => memory && cosine > CONFLICT_COSINE_THRESHOLD)
      .filter(({ memory }) => memory!.scope === scope && memory!.status === 'active') as {
      memory: MemoryRow;
      cosine: number;
    }[];
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.cosine - a.cosine);
      const best = candidates[0];
      if (best.cosine > DEDUPE_COSINE_THRESHOLD) {
        return { result: `merged:${best.memory.id}`, outcome: 'merged', id: best.memory.id };
      }
      const conflictIds = candidates
        .filter(({ cosine }) => cosine <= DEDUPE_COSINE_THRESHOLD)
        .map(({ memory }) => memory.id)
        .sort();
      return {
        result: `conflict:[${conflictIds.join(',')}]`,
        outcome: 'conflict',
        candidates: conflictIds,
      };
    }
  }

  const { tier, ttlMs } = tierAndTtl(input.type);
  const now = new Date();
  const created = createMemory(db, {
    title: input.title,
    content: input.content,
    type: input.type,
    tier,
    scope,
    tags: input.tags ?? [],
    source: input.source ?? 'agent-inferred',
    importance: input.importance,
    expires_at: ttlMs === null ? null : new Date(now.getTime() + ttlMs).toISOString(),
  });
  if (vector) insertVector(db, created.id, vector);
  return { result: 'created', outcome: 'created', id: created.id };
};
