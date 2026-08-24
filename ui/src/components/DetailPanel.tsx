import { useEffect, useState } from 'react';
import { fetchDetail } from '../api.js';
import type { DetailPayload } from '../types.js';
import { KIND_STYLES, TYPE_COLORS } from '../theme.js';

interface DetailPanelProps {
  id: string | null;
  refreshKey: number;
  onSelect: (id: string) => void;
}

const formatDate = (value: string | null): string =>
  value === null
    ? '—'
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value));

const factorChip = (label: string, value: number): React.ReactNode => (
  <span className="factor" key={label} title={label}>
    {label} {value.toFixed(2)}
  </span>
);

export function DetailPanel({ id, refreshKey, onSelect }: DetailPanelProps) {
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (id === null) {
      setDetail(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchDetail(id)
      .then((payload) => {
        if (!cancelled) {
          setDetail(payload);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, refreshKey]);

  if (id === null) {
    return (
      <div className="detail empty">
        <p>Select a memory in the graph to inspect it.</p>
      </div>
    );
  }
  if (loading && detail === null) return <div className="detail">loading…</div>;
  if (error !== null) {
    return (
      <div className="detail">
        <p className="error">{error}</p>
      </div>
    );
  }
  if (detail === null) return null;

  const { memory } = detail;
  return (
    <div className="detail">
      <h2>{memory.title}</h2>
      <div className="badges">
        <span className="badge" style={{ backgroundColor: TYPE_COLORS[memory.type] }}>
          {memory.type}
        </span>
        <span className="badge neutral">{memory.tier}</span>
        <span className="badge neutral">{memory.status}</span>
        <span className="badge neutral">{memory.source}</span>
        <span className="badge neutral">importance {memory.importance}</span>
        <span className="badge neutral">scope:{memory.scope}</span>
      </div>

      <section className="reliability">
        <div className="reliability-header">
          <strong>reliability</strong>
          <span className="score">{Math.round(detail.reliability * 100)}%</span>
        </div>
        <progress max={1} value={detail.reliability} />
        <div className="factors">
          {factorChip('base', detail.breakdown.base)}
          {factorChip('recency', detail.breakdown.recency)}
          {factorChip('corrob', detail.breakdown.corroboration)}
          {factorChip('penalty', detail.breakdown.penalty)}
        </div>
      </section>

      <section>
        <h3>content</h3>
        <pre className="content">{memory.content}</pre>
      </section>

      {memory.tags.length > 0 ? (
        <section>
          <h3>tags</h3>
          <div className="tags">
            {memory.tags.map((tag) => (
              <span className="tag" key={tag}>
                {tag}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h3>dates</h3>
        <dl className="dates">
          <dt>created</dt>
          <dd>{formatDate(memory.created_at)}</dd>
          <dt>updated</dt>
          <dd>{formatDate(memory.updated_at)}</dd>
          <dt>last accessed</dt>
          <dd>{formatDate(memory.last_accessed_at)}</dd>
          <dt>last confirmed</dt>
          <dd>{formatDate(memory.last_confirmed_at)}</dd>
          {memory.expires_at !== null ? (
            <>
              <dt>expires</dt>
              <dd>{formatDate(memory.expires_at)}</dd>
            </>
          ) : null}
        </dl>
      </section>

      {detail.outgoing.length > 0 || detail.incoming.length > 0 ? (
        <section>
          <h3>links</h3>
          {(['outgoing', 'incoming'] as const).map((direction) =>
            detail[direction].length > 0 ? (
              <div key={direction} className="link-group">
                <span className="link-direction">{direction}</span>
                {detail[direction].map((neighbor) => (
                  <button
                    type="button"
                    key={`${direction}-${neighbor.id}-${neighbor.kind}`}
                    className="link-item"
                    onClick={() => onSelect(neighbor.id)}
                    style={{ color: KIND_STYLES[neighbor.kind].color }}
                  >
                    {neighbor.title} <em>({neighbor.kind})</em>
                  </button>
                ))}
              </div>
            ) : null,
          )}
        </section>
      ) : null}

      {detail.chain.length > 1 ? (
        <section>
          <h3>supersession chain</h3>
          <div className="chain">
            {detail.chain.map((chainId, index) => (
              <span key={chainId} className="chain-member">
                {index > 0 ? <span className="arrow">→ </span> : null}
                <button type="button" className="link-item" onClick={() => onSelect(chainId)}>
                  {chainId}
                </button>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {detail.history.length > 0 ? (
        <section>
          <h3>history</h3>
          <ul className="history">
            {[...detail.history].reverse().map((entry, index) => (
              <li key={`${entry.changedAt}-${index}`}>
                <span className="when">{formatDate(entry.changedAt)}</span>
                {entry.reason !== null ? <span className="reason">{entry.reason}</span> : null}
                <span className="diff">
                  {entry.contentBefore === null
                    ? 'created'
                    : `${entry.contentBefore.length} → ${entry.contentAfter?.length ?? 0} chars`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
