import type { MemoryRow } from '../db/queries.js';

const DAY_MS = 86_400_000;

const BASE_BY_SOURCE = {
  'user-stated': 1.0,
  'agent-inferred': 0.7,
  'agent-guessed': 0.4,
} as const;

export const LAMBDA_BY_TYPE = {
  preference: 0.002,
  person: 0.003,
  'project-state': 0.003,
  decision: 0.005,
  lesson: 0.005,
  procedure: 0.005,
  fact: 0.01,
  session: 0.1,
} as const;

export type ReliabilitySource = keyof typeof BASE_BY_SOURCE;
export type ReliabilityMemoryType = keyof typeof LAMBDA_BY_TYPE;

export interface ReliabilityInput {
  source: ReliabilitySource;
  type: ReliabilityMemoryType;
  observedCount: number;
  contradictionCount: number;
  createdAt: number;
  lastConfirmedAt?: number;
  now: number;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export function computeReliability(input: ReliabilityInput): number {
  const anchor = input.lastConfirmedAt ?? input.createdAt;
  const days = (input.now - anchor) / DAY_MS;
  const recency = Math.exp(-LAMBDA_BY_TYPE[input.type] * days);
  const corroboration = 1 + Math.min(0.5, input.observedCount * 0.05);
  const penalty = Math.pow(0.7, input.contradictionCount);
  return clamp01(BASE_BY_SOURCE[input.source] * recency * corroboration * penalty);
}

// Single formula shared by the read-time path and the standalone function above.
export const memoryReliability = (row: MemoryRow, now: number): number =>
  computeReliability({
    source: row.source,
    type: row.type,
    observedCount: row.observed_count,
    contradictionCount: row.contradiction_count,
    createdAt: new Date(row.created_at).getTime(),
    lastConfirmedAt: row.last_confirmed_at ? new Date(row.last_confirmed_at).getTime() : undefined,
    now,
  });
