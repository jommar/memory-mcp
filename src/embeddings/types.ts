import type Database from 'better-sqlite3';

export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

const META_PROVIDER_KEY = 'embedding_provider';
const META_DIM_KEY = 'embedding_dim';

const readMeta = (db: Database.Database, key: string): string | undefined => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? undefined;
};

export const initEmbeddingProvider = (
  db: Database.Database,
  provider: EmbeddingProvider,
): EmbeddingProvider => {
  const recordedProvider = readMeta(db, META_PROVIDER_KEY);
  const recordedDim = readMeta(db, META_DIM_KEY);

  if (recordedDim !== undefined && Number(recordedDim) !== provider.dim) {
    throw new Error(
      `Embedding dimension mismatch: store was initialized with dim ${recordedDim} but provider '${provider.name}' produces dim ${provider.dim}. Reindex or use a matching provider.`,
    );
  }
  if (recordedProvider !== undefined && recordedProvider !== provider.name) {
    throw new Error(
      `Embedding provider mismatch: store was initialized with '${recordedProvider}' (dim ${recordedDim}) but got '${provider.name}' (dim ${provider.dim}).`,
    );
  }

  const upsert = db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  db.transaction(() => {
    upsert.run(META_PROVIDER_KEY, provider.name);
    upsert.run(META_DIM_KEY, String(provider.dim));
  })();

  return provider;
};
