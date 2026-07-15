import { devNull, tmpdir } from "node:os";
import type { OpenRouterProviderRouting } from "../../providers/adapter-base.ts";
import type { ProviderAdapter } from "../../providers/adapter-base.ts";
import { type ProviderId, createAdapter } from "../../providers/registry.ts";

export interface ProbeInput {
  provider: ProviderId;
  model: string;
  auth: "oauth" | "apikey" | "openrouter";
  apiKeyEnv?: string;
  /** Ollama-only endpoint override, forwarded to complete() (Local daemon probes). */
  baseUrl?: string;
  timeoutMs?: number;
  /** The production request shape this model will serve. */
  purpose?: "reviewer" | "fallback" | "critic" | "curator";
  /** OpenRouter upstream route that will be persisted. */
  openrouterProvider?: OpenRouterProviderRouting;
  /** Hard provider-side output ceiling for the paid capability probe. */
  maxTokens?: number;
}

export interface ProbeResult {
  ok: boolean;
  /** true = could not verify (no completion API); treat as "unknown", not failure. Always implies ok=false. */
  skipped: boolean;
  detail: string;
}

export interface ProbeDeps {
  adapter?: ProviderAdapter;
  /** Wizard-lifetime cache: only successful identical paid tuples are reused. */
  cache?: Map<string, ProbeResult>;
}

const PROBE_PROMPT = "Reply with the single word OK.";
const OPENROUTER_REVIEW_PROBE_PROMPT =
  "This is a harmless setup capability probe. Review an empty, safe change and return PASS with no findings using the required review schema.";
// A 64-token ceiling is too small for reasoning models: the documented Alpha.12
// route can spend all 64 tokens on hidden reasoning and return no JSON at all.
// 256 remains a small paid probe while leaving room for the strict PASS payload.
export const OPENROUTER_PROBE_MAX_TOKENS = 256;

export function probeModelCacheKey(input: ProbeInput): string {
  return JSON.stringify({
    provider: input.provider,
    purpose: input.purpose ?? "reviewer",
    model: input.model,
    auth: input.auth,
    apiKeyEnv: input.apiKeyEnv ?? "",
    baseUrl: input.baseUrl ?? "",
    timeoutMs: input.timeoutMs ?? 15_000,
    maxTokens: input.maxTokens ?? OPENROUTER_PROBE_MAX_TOKENS,
    openrouterProvider: input.openrouterProvider ?? null,
  });
}

export async function probeModel(input: ProbeInput, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const adapter = deps.adapter ?? createAdapter(input.provider);
  const cacheKey = probeModelCacheKey(input);
  const cached = input.provider === "openrouter" ? deps.cache?.get(cacheKey) : undefined;
  if (cached) return cached;

  if (input.provider === "openrouter") {
    const purpose = input.purpose ?? "reviewer";
    const timeoutMs = input.timeoutMs ?? 15_000;
    const maxTokens = input.maxTokens ?? OPENROUTER_PROBE_MAX_TOKENS;
    try {
      let result: ProbeResult;
      if (purpose === "reviewer" || purpose === "fallback") {
        const review = await adapter.review({
          promptFile: devNull,
          promptText: OPENROUTER_REVIEW_PROBE_PROMPT,
          workingDir: tmpdir(),
          findingsPath: devNull,
          persona: "security",
          diffPath: devNull,
          reviewerId: "setup-probe",
          cfg: {
            enabled: true,
            auth: input.auth,
            model: input.model,
            timeoutMs,
            maxTokens,
            ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
            ...(input.openrouterProvider ? { openrouterProvider: input.openrouterProvider } : {}),
          },
        });
        result =
          review.status === "ok"
            ? { ok: true, skipped: false, detail: "strict review request responds" }
            : {
                ok: false,
                skipped: false,
                detail: (review.statusDetail ?? `review status ${review.status}`).slice(0, 200),
              };
      } else {
        if (typeof adapter.complete !== "function") {
          return {
            ok: false,
            skipped: true,
            detail: "cannot verify (provider has no completion API)",
          };
        }
        const text = await adapter.complete(PROBE_PROMPT, {
          model: input.model,
          auth: input.auth,
          ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
          timeoutMs,
          maxTokens,
          ...(input.openrouterProvider ? { openrouterProvider: input.openrouterProvider } : {}),
        });
        result = text.trim()
          ? { ok: true, skipped: false, detail: `${purpose} completion responds` }
          : { ok: false, skipped: false, detail: "empty response" };
      }
      if (result.ok) deps.cache?.set(cacheKey, result);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, skipped: false, detail: msg.slice(0, 200) };
    }
  }

  if (typeof adapter.complete !== "function") {
    return { ok: false, skipped: true, detail: "cannot verify (provider has no completion API)" };
  }
  try {
    const text = await adapter.complete(PROBE_PROMPT, {
      model: input.model,
      auth: input.auth,
      ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      timeoutMs: input.timeoutMs ?? 15_000,
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    });
    if (text && text.trim().length > 0)
      return { ok: true, skipped: false, detail: "model responds" };
    return { ok: false, skipped: false, detail: "empty response" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, skipped: false, detail: msg.slice(0, 200) };
  }
}
