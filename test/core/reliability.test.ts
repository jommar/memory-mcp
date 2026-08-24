import { describe, expect, it } from 'vitest';
import {
  computeReliability,
  type ReliabilityMemoryType,
  type ReliabilitySource,
} from '../../src/core/reliability.js';

type Source = ReliabilitySource;
type MemoryType = ReliabilityMemoryType;

interface ReliabilityInput {
  source: Source;
  type: MemoryType;
  observedCount: number;
  contradictionCount: number;
  createdAt: number;
  lastConfirmedAt?: number;
  now: number;
}

const DAY_MS = 86_400_000;
const NOW = new Date('2026-01-01T00:00:00Z').getTime();
const daysAgo = (days: number): number => NOW - days * DAY_MS;

const fixed = (n: number): number => Number(n.toFixed(4));

interface Case {
  name: string;
  input: ReliabilityInput;
  expected: number;
}

const cases: Case[] = [
  {
    name: 'user-stated base alone, zero days elapsed -> 1.0',
    input: {
      source: 'user-stated',
      type: 'fact',
      observedCount: 0,
      contradictionCount: 0,
      createdAt: NOW,
      now: NOW,
    },
    expected: 1,
  },
  {
    name: 'agent-inferred base alone, zero days elapsed -> 0.7',
    input: {
      source: 'agent-inferred',
      type: 'fact',
      observedCount: 0,
      contradictionCount: 0,
      createdAt: NOW,
      now: NOW,
    },
    expected: 0.7,
  },
  {
    name: 'agent-guessed base alone, zero days elapsed -> 0.4',
    input: {
      source: 'agent-guessed',
      type: 'fact',
      observedCount: 0,
      contradictionCount: 0,
      createdAt: NOW,
      now: NOW,
    },
    expected: 0.4,
  },
  {
    name: 'recency: fact lambda .01 over 30 days -> exp(-0.3) ~ 0.7408',
    input: {
      source: 'user-stated',
      type: 'fact',
      observedCount: 0,
      contradictionCount: 0,
      createdAt: daysAgo(30),
      now: NOW,
    },
    expected: 0.7408,
  },
  {
    name: 'recency: preference lambda .002 over 30 days -> exp(-0.06) ~ 0.9418',
    input: {
      source: 'user-stated',
      type: 'preference',
      observedCount: 0,
      contradictionCount: 0,
      createdAt: daysAgo(30),
      now: NOW,
    },
    expected: 0.9418,
  },
  {
    name: 'recency: session lambda .1 over 1 day -> exp(-0.1) ~ 0.9048',
    input: {
      source: 'user-stated',
      type: 'session',
      observedCount: 0,
      contradictionCount: 0,
      createdAt: daysAgo(1),
      now: NOW,
    },
    expected: 0.9048,
  },
  {
    name: 'recency: session lambda .1 over 10 days -> exp(-1) ~ 0.3679',
    input: {
      source: 'user-stated',
      type: 'session',
      observedCount: 0,
      contradictionCount: 0,
      createdAt: daysAgo(10),
      now: NOW,
    },
    expected: 0.3679,
  },
  {
    name: 'recency: procedure lambda .005 over 100 days -> exp(-0.5) ~ 0.6065',
    input: {
      source: 'user-stated',
      type: 'procedure',
      observedCount: 0,
      contradictionCount: 0,
      createdAt: daysAgo(100),
      now: NOW,
    },
    expected: 0.6065,
  },
  {
    name: 'anchoring prefers lastConfirmedAt (100d created, 5d confirmed) -> exp(-0.05) ~ 0.9512',
    input: {
      source: 'user-stated',
      type: 'fact',
      observedCount: 0,
      contradictionCount: 0,
      createdAt: daysAgo(100),
      lastConfirmedAt: daysAgo(5),
      now: NOW,
    },
    expected: 0.9512,
  },
  {
    name: 'anchoring falls back to createdAt when lastConfirmedAt absent -> exp(-0.05) ~ 0.9512',
    input: {
      source: 'user-stated',
      type: 'fact',
      observedCount: 0,
      contradictionCount: 0,
      createdAt: daysAgo(5),
      now: NOW,
    },
    expected: 0.9512,
  },
  {
    name: 'corroboration grows: 5 observations -> 0.7 * 1.25 = 0.875',
    input: {
      source: 'agent-inferred',
      type: 'fact',
      observedCount: 5,
      contradictionCount: 0,
      createdAt: NOW,
      now: NOW,
    },
    expected: 0.875,
  },
  {
    name: 'corroboration cap at 10 observations (10 * 0.05 = 0.5) -> 0.4 * 1.5 = 0.6',
    input: {
      source: 'agent-guessed',
      type: 'fact',
      observedCount: 10,
      contradictionCount: 0,
      createdAt: NOW,
      now: NOW,
    },
    expected: 0.6,
  },
  {
    name: 'corroboration does not grow past 10 (20 obs same as 10) -> 0.6',
    input: {
      source: 'agent-guessed',
      type: 'fact',
      observedCount: 20,
      contradictionCount: 0,
      createdAt: NOW,
      now: NOW,
    },
    expected: 0.6,
  },
  {
    name: 'penalty: 1 contradiction -> 0.7^1 = 0.7',
    input: {
      source: 'user-stated',
      type: 'fact',
      observedCount: 0,
      contradictionCount: 1,
      createdAt: NOW,
      now: NOW,
    },
    expected: 0.7,
  },
  {
    name: 'penalty: 2 contradictions -> 0.7^2 = 0.49',
    input: {
      source: 'user-stated',
      type: 'fact',
      observedCount: 0,
      contradictionCount: 2,
      createdAt: NOW,
      now: NOW,
    },
    expected: 0.49,
  },
  {
    name: 'clamp upper bound: user-stated with 10 obs (raw 1.5) -> 1',
    input: {
      source: 'user-stated',
      type: 'fact',
      observedCount: 10,
      contradictionCount: 0,
      createdAt: NOW,
      now: NOW,
    },
    expected: 1,
  },
  {
    name: 'many contradictions drive toward 0 but never below: 0.7^50 -> 0.0000 (rounded), still >= 0',
    input: {
      source: 'user-stated',
      type: 'fact',
      observedCount: 0,
      contradictionCount: 50,
      createdAt: NOW,
      now: NOW,
    },
    expected: 0,
  },
  {
    name: 'combined: inferred * fact decay 30d * 2 obs * 1 contradiction -> 0.3993',
    input: {
      source: 'agent-inferred',
      type: 'fact',
      observedCount: 2,
      contradictionCount: 1,
      createdAt: daysAgo(30),
      now: NOW,
    },
    expected: 0.3993,
  },
];

describe('computeReliability', () => {
  it.each(cases)('$name', ({ input, expected }) => {
    const actual = computeReliability(input);
    expect(fixed(actual)).toBe(expected);
    expect(actual).toBeGreaterThanOrEqual(0);
  });
});
