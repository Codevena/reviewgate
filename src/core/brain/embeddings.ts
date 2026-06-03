// src/core/brain/embeddings.ts
import type { OpenRouterProviderRouting } from "../../providers/adapter-base.ts";

/**
 * Cosine similarity between two numeric vectors.
 * Throws if vectors have different lengths, are empty, or have zero magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) {
    throw new Error("cosineSimilarity: vectors must be non-empty");
  }
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: vector length mismatch (${a.length} vs ${b.length})`);
  }

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    magA += (a[i] as number) ** 2;
    magB += (b[i] as number) ** 2;
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) {
    throw new Error("cosineSimilarity: zero-magnitude vector");
  }
  return dot / denom;
}

/** Options for the Embedder.embed() call. */
export interface EmbedOptions {
  /** Environment variable name holding the API key. */
  apiKeyEnv: string;
  /** Embedding model identifier (e.g. "text-embedding-3-small"). */
  model: string;
  /** Request timeout in ms (defaults applied by the adapter). */
  timeoutMs?: number;
  /** OpenRouter-only: upstream-provider routing (see OpenRouterProviderRouting). */
  openrouterProvider?: OpenRouterProviderRouting;
}

/**
 * Interface for anything that can produce embedding vectors for a batch of texts.
 * Implementations must fail-closed: throw rather than returning empty/invalid
 * vectors so callers can treat any error as "dedup check unavailable".
 */
export interface Embedder {
  embed(
    texts: string[],
    cfg?: { model?: string; apiKeyEnv?: string; timeoutMs?: number },
  ): Promise<number[][]>;
}
