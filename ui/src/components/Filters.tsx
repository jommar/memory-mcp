import type { ReactElement } from 'react';
import type { MemoryStatus, MemoryTier, MemoryType } from '../../../src/db/queries.js';

export interface FilterState {
  scope: string;
  tier: string;
  type: string;
  status: string;
  text: string;
}

export const EMPTY_FILTERS: FilterState = {
  scope: '',
  tier: '',
  type: '',
  status: '',
  text: '',
};

const TYPES: MemoryType[] = [
  'preference',
  'decision',
  'fact',
  'procedure',
  'person',
  'project-state',
  'lesson',
  'session',
];
const TIERS: MemoryTier[] = ['short', 'long'];
const STATUSES: MemoryStatus[] = ['active', 'superseded', 'archived', 'expired'];

interface FiltersProps {
  filters: FilterState;
  scopes: string[];
  onChange: (patch: Partial<FilterState>) => void;
}

const selectRow = (
  label: string,
  value: string,
  options: string[],
  onChange: (value: string) => void,
): ReactElement => (
  <label className="filter-row">
    <span>{label}</span>
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">all</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  </label>
);

export function Filters({ filters, scopes, onChange }: FiltersProps) {
  const dirty = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);
  return (
    <div className="filters">
      <input
        type="search"
        placeholder="search title / tag / scope…"
        value={filters.text}
        onChange={(event) => onChange({ text: event.target.value })}
      />
      {selectRow('scope', filters.scope, [...scopes].sort(), (scope) => onChange({ scope }))}
      {selectRow('type', filters.type, [...TYPES].sort(), (type) => onChange({ type }))}
      {selectRow('tier', filters.tier, TIERS, (tier) => onChange({ tier }))}
      {selectRow('status', filters.status, STATUSES, (status) => onChange({ status }))}
      {dirty ? (
        <button type="button" className="reset" onClick={() => onChange(EMPTY_FILTERS)}>
          reset
        </button>
      ) : null}
    </div>
  );
}
