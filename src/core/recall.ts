import type Database from 'better-sqlite3';
import {
  getMemory,
  type MemoryRow,
  type MemoryStatus,
  type MemoryTier,
} from '../db/queries.js';
import { listOutgoingLinks, type LinkRow } from '../core/links.js';
import { listIncomingLinks } from '../db/queries.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import { memoryReliability } from './reliability.js';

export { memoryReliability } from './reliability.js';

const RRF_K = 60;
const KNN_K = 50;

// FTS5 MATCH treats raw user text as query syntax. Quote every token and double
// embedded quotes so operator characters are matched literally instead of crashing.
const sanitizeFtsQuery = (query: string): string =>
  (query.match(/\S+/g) ?? [])
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' ');

const memoryByRowid = (db: Database.Database, rowid: number): MemoryRow | undefined => {
  const row = db.prepare('SELECT id FROM memories WHERE rowid = ?').get(rowid) as
    | { id: string }
    | undefined;
  return row ? getMemory(db, row.id) : undefined;
};

const rankIndex = (rankedIds: string[], id: string): number => rankedIds.indexOf(id);

export interface RecallOptions {
  scope?: string;
  tier?: MemoryTier;
  status?: MemoryStatus;
  limit?: number;
  embedder?: EmbeddingProvider | null;
}

export interface RecallHit {
  id: string;
  title: string;
  content: string;
  score: number;
  reliability: number;
  importance: number;
  links: LinkRow[];
}

export interface RecallResult {
  query: string;
  hits: RecallHit[];
  markdown: string;
}

const renderMarkdown = (query: string, hits: RecallHit[], titleOf: (id: string) => string): string => {
  const lines: string[] = [`# Recall: ${query}`, ''];
  for (const hit of hits) {
    lines.push(`## ${hit.title} (\`${hit.id}\`)`);
    lines.push(`score: ${hit.score.toFixed(4)} (reliability ${hit.reliability.toFixed(3)} × importance ${hit.importance})`);
    const body = hit.content.length > 240 ? `${hit.content.slice(0, 240)}…` : hit.content;
    lines.push(`> ${body}`);
    if (hit.links.length > 0) {
      lines.push('');
      lines.push('Linked:');
      for (const link of hit.links) {
        const other = link.fromId === hit.id ? link.toId : link.fromId;
        lines.push(`- ${link.kind}: \`${other}\` ${titleOf(other)}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
};

export const recall = async (
  db: Database.Database,
  query: string,
  options: RecallOptions = {},
): Promise<RecallResult> => {
  const limit = options.limit ?? 10;
  const status = options.status ?? 'active';
  const now = Date.now();

  const ftsIds: string[] = [];
  const sanitized = sanitizeFtsQuery(query);
  if (sanitized.length > 0) {
    const rows = db
      .prepare(
        'SELECT rowid, bm25(memories_fts) AS score FROM memories_fts WHERE memories_fts MATCH ? ORDER BY score',
      )
      .all(sanitized) as { rowid: number; score: number }[];
    for (const row of rows) {
      const memory = memoryByRowid(db, row.rowid);
      if (memory) ftsIds.push(memory.id);
    }
  }

  const semanticIds: string[] = [];
  if (options.embedder) {
    try {
      const [queryVector] = await options.embedder.embed([query]);
      const rows = db
        .prepare(
          'SELECT memory_rowid, distance FROM memories_vec WHERE embedding MATCH ? AND k = ?',
        )
        .all(Buffer.from(queryVector.buffer), KNN_K) as {
        memory_rowid: number;
        distance: number;
      }[];
      for (const row of rows) {
        const memory = memoryByRowid(db, row.memory_rowid);
        if (memory) semanticIds.push(memory.id);
      }
    } catch {
      // Degrade open: keep the bm25 leg; a failed embedding must not abort recall.
    }
  }

  const candidateIds = [...new Set([...ftsIds, ...semanticIds])];
  const hits: RecallHit[] = [];
  for (const id of candidateIds) {
    const row = getMemory(db, id);
    if (!row) continue;
    if (options.scope !== undefined && row.scope !== options.scope) continue;
    if (options.tier !== undefined && row.tier !== options.tier) continue;
    if (row.status !== status) continue;
    const ftsRank = rankIndex(ftsIds, id);
    const semanticRank = rankIndex(semanticIds, id);
    const fused =
      (ftsRank >= 0 ? 1 / (RRF_K + ftsRank + 1) : 0) +
      (semanticRank >= 0 ? 1 / (RRF_K + semanticRank + 1) : 0);
    const reliability = memoryReliability(row, now);
    const score = fused * reliability * row.importance;
    const outgoing = listOutgoingLinks(db, id);
    const incoming = listIncomingLinks(db, id, 50);
    hits.push({
      id,
      title: row.title,
      content: row.content,
      score,
      reliability,
      importance: row.importance,
      links: [...incoming, ...outgoing],
    });
  }
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const selected = hits.slice(0, limit);

  if (selected.length > 0) {
    const update = db.prepare('UPDATE memories SET last_accessed_at = ? WHERE id = ?');
    const nowIso = new Date(now).toISOString();
    db.transaction(() => {
      for (const hit of selected) update.run(nowIso, hit.id);
    })();
  }

  const titleOf = (id: string): string => getMemory(db, id)?.title ?? id;
  return { query, hits: selected, markdown: renderMarkdown(query, selected, titleOf) };
};
