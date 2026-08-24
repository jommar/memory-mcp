import type Database from 'better-sqlite3';
import { consolidateReport } from '../../src/core/lifecycle.js';
import { supersessionChain } from '../../src/core/links.js';
import {
  memoryReliability,
  memoryReliabilityFactors,
  type ReliabilityFactors,
} from '../../src/core/reliability.js';
import {
  getMemory,
  listHistory,
  listLinks,
  listMemories,
  type HistoryRow,
  type LinkKind,
  type MemoryRow,
} from '../../src/db/queries.js';

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export interface GraphNode {
  id: string;
  title: string;
  type: MemoryRow['type'];
  tier: MemoryRow['tier'];
  scope: string;
  status: MemoryRow['status'];
  tags: string[];
  importance: number;
  source: MemoryRow['source'];
  reliability: number;
}

export interface GraphEdge {
  fromId: string;
  toId: string;
  kind: LinkKind;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const graphPayload = (db: Database.Database): GraphPayload => {
  const now = Date.now();
  return {
    nodes: listMemories(db).map((row) => ({
      id: row.id,
      title: row.title,
      type: row.type,
      tier: row.tier,
      scope: row.scope,
      status: row.status,
      tags: row.tags,
      importance: row.importance,
      source: row.source,
      reliability: round3(memoryReliability(row, now)),
    })),
    edges: listLinks(db).map((link) => ({
      fromId: link.fromId,
      toId: link.toId,
      kind: link.kind,
    })),
  };
};

const tally = (values: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
};

export interface StatsPayload {
  total: number;
  byTier: Record<string, number>;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  byScope: Record<string, number>;
  avgReliability: number;
}

export const statsPayload = (db: Database.Database): StatsPayload => {
  const now = Date.now();
  const memories = listMemories(db);
  const reliabilities = memories.map((row) => memoryReliability(row, now));
  return {
    total: memories.length,
    byTier: tally(memories.map((row) => row.tier)),
    byStatus: tally(memories.map((row) => row.status)),
    byType: tally(memories.map((row) => row.type)),
    byScope: tally(memories.map((row) => row.scope)),
    avgReliability:
      reliabilities.length === 0
        ? 0
        : round3(reliabilities.reduce((sum, value) => sum + value, 0) / reliabilities.length),
  };
};

export interface NeighborSummary {
  id: string;
  title: string;
  kind: LinkKind;
}

export interface DetailPayload {
  memory: MemoryRow;
  reliability: number;
  breakdown: ReliabilityFactors;
  history: HistoryRow[];
  chain: string[];
  outgoing: NeighborSummary[];
  incoming: NeighborSummary[];
}

export const detailPayload = (db: Database.Database, id: string): DetailPayload | undefined => {
  const memory = getMemory(db, id);
  if (!memory) return undefined;
  const now = Date.now();
  const titleOf = (memoryId: string): string => getMemory(db, memoryId)?.title ?? memoryId;
  return {
    memory,
    reliability: round3(memoryReliability(memory, now)),
    breakdown: memoryReliabilityFactors(memory, now),
    history: listHistory(db, id),
    chain: supersessionChain(db, id),
    outgoing: listLinks(db)
      .filter((link) => link.fromId === id)
      .map((link) => ({ id: link.toId, title: titleOf(link.toId), kind: link.kind })),
    incoming: listLinks(db)
      .filter((link) => link.toId === id)
      .map((link) => ({ id: link.fromId, title: titleOf(link.fromId), kind: link.kind })),
  };
};

export const consolidatePayload = (db: Database.Database) => consolidateReport(db);
