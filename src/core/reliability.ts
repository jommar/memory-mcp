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

export interface ReliabilityFactors {
  base: number;
  recency: number;
  corroboration: number;
  penalty: number;
}

export const reliabilityFactors = (input: ReliabilityInput): ReliabilityFactors => {
  const anchor = input.lastConfirmedAt ?? input.createdAt;
  const days = (input.now - anchor) / DAY_MS;
  return {
    base: BASE_BY_SOURCE[input.source],
    recency: Math.exp(-LAMBDA_BY_TYPE[input.type] * days),
    corroboration: 1 + Math.min(0.5, input.observedCount * 0.05),
    penalty: Math.pow(0.7, input.contradictionCount),
  };
};

export function computeReliability(input: ReliabilityInput): number {
  const factors = reliabilityFactors(input);
  return clamp01(factors.base * factors.recency * factors.corroboration * factors.penalty);
}

// Single formula shared by the read-time path and the standalone function above.
export const memoryReliability = (row: MemoryRow, now: number): number => {
  const factors = memoryReliabilityFactors(row, now);
  return clamp01(factors.base * factors.recency * factors.corroboration * factors.penalty);
};

export const memoryReliabilityFactors = (row: MemoryRow, now: number): ReliabilityFactors =>
  reliabilityFactors({
    source: row.source,
    type: row.type,
    observedCount: row.observed_count,
    contradictionCount: row.contradiction_count,
    createdAt: new Date(row.created_at).getTime(),
    lastConfirmedAt: row.last_confirmed_at ? new Date(row.last_confirmed_at).getTime() : undefined,
    now,
  });
