import type {
  ConsolidateReport,
  DetailPayload,
  GraphPayload,
  StatsPayload,
} from './types.js';

const request = async <T>(path: string): Promise<T> => {
  const res = await fetch(path);
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep statusText
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
};

export const fetchGraph = (): Promise<GraphPayload> => request<GraphPayload>('/api/graph');

export const fetchStats = (): Promise<StatsPayload> => request<StatsPayload>('/api/stats');

export const fetchDetail = (id: string): Promise<DetailPayload> =>
  request<DetailPayload>(`/api/memory/${encodeURIComponent(id)}`);

export const fetchConsolidate = (): Promise<ConsolidateReport> =>
  request<ConsolidateReport>('/api/consolidate');
