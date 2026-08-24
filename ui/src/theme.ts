import type { MemoryStatus, MemoryType } from '../../src/db/queries.js';

export const TYPE_COLORS: Record<MemoryType, string> = {
  preference: '#60a5fa',
  decision: '#fbbf24',
  fact: '#34d399',
  procedure: '#a78bfa',
  person: '#f472b6',
  'project-state': '#38bdf8',
  lesson: '#fb923c',
  session: '#94a3b8',
};

export interface StatusStyle {
  color: string;
  borderStyle: 'solid' | 'dashed' | 'dotted';
}

export const STATUS_STYLES: Record<MemoryStatus, StatusStyle> = {
  active: { color: '#4ade80', borderStyle: 'solid' },
  superseded: { color: '#64748b', borderStyle: 'dashed' },
  archived: { color: '#57534e', borderStyle: 'dotted' },
  expired: { color: '#f87171', borderStyle: 'dashed' },
};

export interface KindStyle {
  color: string;
  lineStyle: 'solid' | 'dashed';
  arrow: boolean;
}

export const KIND_STYLES: Record<'related' | 'supersedes' | 'contradicts', KindStyle> = {
  related: { color: '#475569', lineStyle: 'solid', arrow: false },
  supersedes: { color: '#38bdf8', lineStyle: 'dashed', arrow: true },
  contradicts: { color: '#f43f5e', lineStyle: 'solid', arrow: true },
};
