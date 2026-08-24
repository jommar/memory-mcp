import { useEffect, useState } from 'react';
import { fetchConsolidate } from '../api.js';
import type { ConsolidateReport } from '../types.js';

export type ConsolidateSignal =
  | 'expired-stm'
  | 'archive-candidate'
  | 're-confirm'
  | 'needs-expansion'
  | 'duplicate-cluster'
  | 'orphan';

const SIGNAL_META: Record<ConsolidateSignal, { label: string; color: string }> = {
  'expired-stm': { label: 'expired STM', color: '#f87171' },
  'archive-candidate': { label: 'archive candidate', color: '#fb923c' },
  're-confirm': { label: 're-confirm', color: '#fbbf24' },
  'needs-expansion': { label: 'needs expansion', color: '#60a5fa' },
  'duplicate-cluster': { label: 'duplicate cluster', color: '#c084fc' },
  orphan: { label: 'orphan', color: '#94a3b8' },
};

interface ConsolidateDrawerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
}

// duplicate-cluster details look like "merge proposal: id-a, id-b, …".
const clusterMembers = (detail: string): string[] =>
  detail.startsWith('merge proposal:')
    ? detail
        .slice('merge proposal:'.length)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : [];

export function ConsolidateDrawer({ open, onClose, onSelect }: ConsolidateDrawerProps) {
  const [report, setReport] = useState<ConsolidateReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchConsolidate()
      .then((payload) => {
        if (!cancelled) {
          setReport(payload);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const actions = report?.actions ?? [];
  const grouped = new Map<ConsolidateSignal, typeof actions>();
  for (const action of actions) {
    const bucket = grouped.get(action.signal as ConsolidateSignal) ?? [];
    bucket.push(action);
    grouped.set(action.signal as ConsolidateSignal, bucket);
  }

  return (
    <div className="drawer" role="dialog" aria-label="maintenance proposals">
      <div className="drawer-header">
        <h2>maintenance</h2>
        <button type="button" onClick={onClose} aria-label="close">
          ✕
        </button>
      </div>
      {error !== null ? <p className="error">{error}</p> : null}
      {report === null && error === null ? <p className="drawer-loading">loading…</p> : null}
      {report !== null && actions.length === 0 ? (
        <p className="drawer-empty">No proposals — the store looks healthy.</p>
      ) : null}
      {[...grouped.entries()].map(([signal, signalActions]) => (
        <section key={signal}>
          <h3>
            <span className="signal-dot" style={{ backgroundColor: SIGNAL_META[signal].color }} />
            {SIGNAL_META[signal].label}
            <span className="signal-count">{signalActions.length}</span>
          </h3>
          {signalActions.map((action) => (
            <div className="proposal" key={action.id}>
              <button
                type="button"
                className="proposal-title"
                onClick={() => onSelect(action.memoryId)}
              >
                {action.title}
              </button>
              <p className="proposal-detail">{action.detail}</p>
              {clusterMembers(action.detail).length > 1 ? (
                <div className="cluster-chips">
                  {clusterMembers(action.detail).map((memberId) => (
                    <button
                      type="button"
                      key={memberId}
                      className="cluster-chip"
                      onClick={() => onSelect(memberId)}
                    >
                      {memberId}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </section>
      ))}
      <p className="drawer-note">
        Report-only — apply actions from an MCP client via <code>consolidate</code> with{' '}
        <code>apply</code>.
      </p>
    </div>
  );
}
