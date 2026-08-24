import os from 'node:os';
import path from 'node:path';
import { pipeline } from '@huggingface/transformers';
import type { EmbeddingProvider } from './types.js';

export const LOCAL_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIM = 384;
// Inputs longer than this are cut before tokenization; MiniLM's context window
// is ~256 word pieces, so text past a few thousand characters adds cost, not signal.
export const DEFAULT_MAX_EMBED_CHARS = 8_000;

const defaultCacheDir = (): string => path.join(os.homedir(), '.memory-mcp', 'cache');

export interface EmbeddingTensor {
  readonly dims: readonly number[];
  readonly data: Float32Array;
}

export type LoadedModel = (texts: string[]) => Promise<EmbeddingTensor>;

export interface ModelLoadConfig {
  cacheDir: string;
  offline: boolean;
  downloadTimeoutMs: number;
}

export type ModelLoader = (config: ModelLoadConfig) => Promise<LoadedModel>;

const loadTransformersModel: ModelLoader = async ({ cacheDir, offline }) => {
  const extractor = await pipeline('feature-extraction', LOCAL_MODEL_ID, {
    dtype: 'q8',
    cache_dir: cacheDir,
    local_files_only: offline,
  });
  return async (texts) => {
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    return { dims: output.dims, data: output.data as Float32Array };
  };
};

// Races a model load against a stall guard. On timeout the memoized load
// promise is cleared so the next embed retries (a stalled first-run download
// is transient); any other load failure keeps the memoized rejection until
// reset() — retrying a genuinely broken load on every call would only churn.
const withDownloadTimeout = <T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`model load exceeded ${ms}ms timeout`));
    }, ms);
    timer.unref?.();
  });
  const raced = Promise.race([promise, timeout]);
  raced.then(
    () => {
      if (timer !== undefined) clearTimeout(timer);
    },
    () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  );
  return raced;
};

export interface LocalEmbeddingOptions {
  cacheDir?: string;
  // Offline-first: never reach out to the HF CDN on a cache miss. Set false to
  // opt in to a first-run model download.
  offline?: boolean;
  // Stall guard for an opted-in first-run download; 0 disables it.
  downloadTimeoutMs?: number;
  loadModel?: ModelLoader;
  maxChars?: number;
}

export const createLocalEmbeddingProvider = (
  options: LocalEmbeddingOptions = {},
): EmbeddingProvider => {
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const offline = options.offline ?? true;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? 0;
  const maxChars = options.maxChars ?? DEFAULT_MAX_EMBED_CHARS;
  const loadModel = options.loadModel ?? loadTransformersModel;

  let modelPromise: Promise<LoadedModel> | undefined;

  const getModel = (): Promise<LoadedModel> => {
    if (modelPromise === undefined) {
      const load = loadModel({ cacheDir, offline, downloadTimeoutMs });
      modelPromise =
        !offline && downloadTimeoutMs > 0
          ? withDownloadTimeout(load, downloadTimeoutMs, () => {
              modelPromise = undefined;
            })
          : load;
    }
    return modelPromise;
  };

  return {
    name: 'local-minilm',
    dim: EMBEDDING_DIM,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const model = await getModel();
      const truncated = texts.map((text) =>
        text.length > maxChars ? text.slice(0, maxChars) : text,
      );
      const output = await model(truncated);
      const vectors: Float32Array[] = [];
      for (let i = 0; i < texts.length; i++) {
        vectors.push(output.data.slice(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM));
      }
      return vectors;
    },
    // A rejected load is not retried by the memoized promise; reset() clears it
    // so a transient failure (network, model cache) can be retried on the next call.
    reset(): void {
      modelPromise = undefined;
    },
  };
};
