import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { MIGRATIONS, runMigrations } from '../../src/db/schema.js';
import { initEmbeddingProvider } from '../../src/embeddings/types.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';
import { createLocalEmbeddingProvider } from '../../src/embeddings/local.js';
import type { ModelLoader } from '../../src/embeddings/local.js';

const MODEL_CACHE_DIR = fileURLToPath(new URL('../../.cache/models', import.meta.url));

const l2Norm = (vector: Float32Array): number =>
  Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));

const recordingLoader = (): { loader: ModelLoader; loads: () => number; seenTexts: () => string[][] } => {
  let loads = 0;
  const seenTexts: string[][] = [];
  const loader: ModelLoader = async () => {
    loads += 1;
    const model = async (texts: string[]) => {
      seenTexts.push(texts);
      const data = new Float32Array(texts.length * 384);
      for (let i = 0; i < data.length; i++) data[i] = ((i % 7) + 1) / 10;
      return { dims: [texts.length, 384], data };
    };
    return model;
  };
  return { loader, loads: () => loads, seenTexts: () => seenTexts };
};

describe('local MiniLM embedding provider', () => {
  it(
    'yields 384-dim unit-norm deterministic float32 vectors offline (real model)',
    { timeout: 120_000 },
    async () => {
      const provider = createLocalEmbeddingProvider({ cacheDir: MODEL_CACHE_DIR, offline: true });
      const [first] = await provider.embed(['hello world']);
      const [again] = await provider.embed(['hello world']);
      const [second] = await provider.embed(['a different sentence entirely']);

      expect(provider.name).toBe('local-minilm');
      expect(provider.dim).toBe(384);
      expect(first).toBeInstanceOf(Float32Array);
      expect(first.length).toBe(384);
      expect(Math.abs(l2Norm(first) - 1)).toBeLessThan(1e-5);
      expect(second.length).toBe(384);
      expect(Array.from(again)).toEqual(Array.from(first));
      expect(Array.from(second)).not.toEqual(Array.from(first));
    },
  );

  it('registers through the item-5 dim guard with name local-minilm and dim 384', async () => {
    const provider: EmbeddingProvider = createLocalEmbeddingProvider({
      cacheDir: MODEL_CACHE_DIR,
      offline: true,
    });
    let db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS);
    initEmbeddingProvider(db, provider);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'embedding_dim'").get() as {
      value: string;
    };
    expect(row.value).toBe('384');
    db.close();
  });

  it('truncates inputs longer than the documented char bound before the model sees them', async () => {
    const rec = recordingLoader();
    const provider = createLocalEmbeddingProvider({
      loadModel: rec.loader,
      maxChars: 64,
    });
    await provider.embed(['x'.repeat(200)]);
    const seen = rec.seenTexts()[0][0];
    expect(seen.length).toBe(64);
    expect(seen).toBe('x'.repeat(64));
  });

  it('resolves concurrent first calls with exactly one model load', async () => {
    const rec = recordingLoader();
    const provider = createLocalEmbeddingProvider({ loadModel: rec.loader });
    const calls = Array.from({ length: 8 }, (_, i) => provider.embed([`text ${i}`]));
    const batches = await Promise.all(calls);
    expect(rec.loads()).toBe(1);
    expect(batches).toHaveLength(8);
    for (const batch of batches) {
      expect(batch[0].length).toBe(384);
    }
  });

  it('loads once across sequential and concurrent phases combined', async () => {
    const rec = recordingLoader();
    const provider = createLocalEmbeddingProvider({ loadModel: rec.loader });
    await provider.embed(['warmup']);
    await Promise.all([provider.embed(['a']), provider.embed(['b'])]);
    await provider.embed(['c']);
    expect(rec.loads()).toBe(1);
  });
});

describe('model-load retry after transient failure', () => {
  it('can retry after a failed model load is reset', async () => {
    let loads = 0;
    const loader: ModelLoader = async () => {
      loads += 1;
      if (loads === 1) throw new Error('transient load failure');
      return async (texts: string[]) => {
        const data = new Float32Array(texts.length * 384);
        for (let i = 0; i < data.length; i += 1) data[i] = 0.1;
        return { dims: [texts.length, 384], data };
      };
    };
    const provider = createLocalEmbeddingProvider({ loadModel: loader });
    await expect(provider.embed(['x'])).rejects.toThrow(/transient load failure/);
    expect(typeof provider.reset).toBe('function');
    provider.reset!();
    const [vector] = await provider.embed(['x']);
    expect(vector.length).toBe(384);
  });
});
