// tests/e2e/brain-embeddings-real.test.ts
//
// Gated real end-to-end test for OpenRouter embeddings via OpenRouterAdapter.
// Only runs when REVIEWGATE_E2E=1 — skipped otherwise.
import { describe, expect, it } from "bun:test";
import { cosineSimilarity } from "../../src/core/brain/embeddings.ts";
import { OpenRouterAdapter } from "../../src/providers/openrouter.ts";

const E2E = process.env.REVIEWGATE_E2E === "1";
const E2E_TIMEOUT_MS = 60_000;

const MODEL = "baai/bge-base-en-v1.5";
const API_KEY_ENV = "OPENROUTER_API_KEY";

const TEXT_A = "src/cart.ts null-guards are intentional Promise.all pattern";
const TEXT_B = "cart.ts intentionally null-guards its Promise.all"; // near-duplicate of A
const TEXT_C = "Stripe webhook signatures must be verified before processing"; // unrelated

(E2E ? describe : describe.skip)("e2e: brain embeddings via OpenRouter", () => {
  it(
    "near-duplicate texts have cosine similarity ≥ 0.85 and unrelated text < 0.85",
    async () => {
      const adapter = new OpenRouterAdapter();
      const opts = {
        apiKeyEnv: API_KEY_ENV,
        model: MODEL,
        timeoutMs: 30_000,
      };

      const [vecA, vecB, vecC] = await Promise.all([
        adapter.embed(TEXT_A, opts),
        adapter.embed(TEXT_B, opts),
        adapter.embed(TEXT_C, opts),
      ]);

      const simAB = cosineSimilarity(vecA, vecB);
      const simAC = cosineSimilarity(vecA, vecC);

      console.info(
        `[brain-embeddings-real] cosine(A,B) = ${simAB.toFixed(6)} (near-dup, expect ≥ 0.85)`,
      );
      console.info(
        `[brain-embeddings-real] cosine(A,C) = ${simAC.toFixed(6)} (unrelated, expect < 0.85)`,
      );

      expect(simAB).toBeGreaterThanOrEqual(0.85);
      expect(simAC).toBeLessThan(0.85);
    },
    E2E_TIMEOUT_MS,
  );
});
