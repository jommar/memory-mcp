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

export type ModelLoader = (config: { cacheDir: string; offline: boolean }) => Promise<LoadedModel>;

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

export interface LocalEmbeddingOptions {
  cacheDir?: string;
  offline?: boolean;
  loadModel?: ModelLoader;
  maxChars?: number;
}

export const createLocalEmbeddingProvider = (
  options: LocalEmbeddingOptions = {},
): EmbeddingProvider => {
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const offline = options.offline ?? false;
  const maxChars = options.maxChars ?? DEFAULT_MAX_EMBED_CHARS;
  const loadModel = options.loadModel ?? loadTransformersModel;

  let modelPromise: Promise<LoadedModel> | undefined;

  const getModel = (): Promise<LoadedModel> => {
    modelPromise ??= loadModel({ cacheDir, offline });
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
  };
};
