import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchConsolidate, fetchGraph, fetchStats } from './api.js';
import type { ConsolidateReport, GraphPayload, StatsPayload } from './types.js';
import { EMPTY_FILTERS, Filters, type FilterState } from './components/Filters.js';
import { GraphView } from './components/GraphView.js';
import { DetailPanel } from './components/DetailPanel.js';
import { StatsBar } from './components/StatsBar.js';
import { ConsolidateDrawer } from './components/ConsolidateDrawer.js';
import { computePositions } from './layout.js';

const matchesFilters = (
  node: GraphPayload['nodes'][number],
  filters: FilterState,
): boolean => {
  if (filters.scope !== '' && node.scope !== filters.scope) return false;
  if (filters.tier !== '' && node.tier !== filters.tier) return false;
  if (filters.type !== '' && node.type !== filters.type) return false;
  if (filters.status !== '' && node.status !== filters.status) return false;
  if (filters.text !== '') {
    const needle = filters.text.toLowerCase();
    const haystack = [node.title, node.scope, ...node.tags].join(' ').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
};

export function App() {
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [report, setReport] = useState<ConsolidateReport | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextGraph, nextStats] = await Promise.all([fetchGraph(), fetchStats()]);
      setGraph(nextGraph);
      setStats(nextStats);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    fetchConsolidate()
      .then(setReport)
      .catch(() => setReport(null));
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  const refresh = useCallback(() => {
    void load();
    fetchConsolidate()
      .then(setReport)
      .catch(() => setReport(null));
    setRefreshKey((key) => key + 1);
  }, []);

  const visibleNodes = useMemo(
    () => graph?.nodes.filter((node) => matchesFilters(node, filters)) ?? [],
    [graph, filters],
  );
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () =>
      graph?.edges.filter((edge) => visibleIds.has(edge.fromId) && visibleIds.has(edge.toId)) ??
      [],
    [graph, visibleIds],
  );
  const scopes = useMemo(
    () => [...new Set(graph?.nodes.map((node) => node.scope) ?? [])],
    [graph],
  );
  const positions = useMemo(
    () => (graph ? computePositions(graph.nodes, graph.edges) : new Map()),
    [graph],
  );

  return (
    <div className="app">
      <header>
        <h1>
          memory<span>-mcp</span> explorer
        </h1>
        <div className="controls">
          <button type="button" className="maintenance" onClick={() => setDrawerOpen(true)}>
            maintenance
            {report !== null && report.actions.length > 0 ? (
              <span className="maintenance-count">{report.actions.length}</span>
            ) : null}
          </button>
          <label className="toggle">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            auto 10s
          </label>
          <button type="button" onClick={refresh}>
            refresh
          </button>
        </div>
      </header>
      <StatsBar stats={stats} />
      {error !== null ? <div className="banner error">{error}</div> : null}
      <Filters
        filters={filters}
        scopes={scopes}
        onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
      />
      <main>
        <GraphView
          nodes={visibleNodes}
          edges={visibleEdges}
          positions={positions}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
        />
        <aside>
          <DetailPanel
            id={selectedId}
            refreshKey={refreshKey}
            onSelect={(id) => setSelectedId(id)}
          />
        </aside>
      </main>
      <ConsolidateDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSelect={(id) => setSelectedId(id)}
      />
    </div>
  );
}
