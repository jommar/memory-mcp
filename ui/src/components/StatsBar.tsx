import type { ReactElement } from 'react';
import type { StatsPayload } from '../types.js';

interface StatsBarProps {
  stats: StatsPayload | null;
}

const chip = (label: string, value: string | number): ReactElement => (
  <span className="chip" key={label}>
    <span className="chip-label">{label}</span>
    <span className="chip-value">{value}</span>
  </span>
);

export function StatsBar({ stats }: StatsBarProps) {
  if (!stats) return <div className="stats-bar">loading…</div>;
  const statuses = ['active', 'superseded', 'archived', 'expired'] as const;
  return (
    <div className="stats-bar">
      {chip('memories', stats.total)}
      {statuses.map((status) =>
        stats.byStatus[status] !== undefined
          ? chip(status, stats.byStatus[status])
          : null,
      )}
      {chip('avg reliability', `${Math.round(stats.avgReliability * 100)}%`)}
      {Object.entries(stats.byScope).map(([scope, count]) => chip(`scope:${scope}`, count))}
    </div>
  );
}
