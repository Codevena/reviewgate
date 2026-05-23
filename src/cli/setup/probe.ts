import type { ProviderAdapter } from "../../providers/adapter-base.ts";
import { type ProviderId, createAdapter } from "../../providers/registry.ts";

export interface ProbeInput {
  provider: ProviderId;
  model: string;
  auth: "oauth" | "apikey" | "openrouter";
  apiKeyEnv?: string;
  timeoutMs?: number;
}

export interface ProbeResult {
  ok: boolean;
  /** true = could not verify (no completion API); treat as "unknown", not failure. Always implies ok=false. */
  skipped: boolean;
  detail: string;
}

export interface ProbeDeps {
  adapter?: ProviderAdapter;
}

const PROBE_PROMPT = "Reply with the single word OK.";

export async function probeModel(input: ProbeInput, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const adapter = deps.adapter ?? createAdapter(input.provider);
  if (typeof adapter.complete !== "function") {
    return { ok: false, skipped: true, detail: "cannot verify (provider has no completion API)" };
  }
  try {
    const text = await adapter.complete(PROBE_PROMPT, {
      model: input.model,
      auth: input.auth,
      ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
      timeoutMs: input.timeoutMs ?? 15_000,
    });
    if (text && text.trim().length > 0)
      return { ok: true, skipped: false, detail: "model responds" };
    return { ok: false, skipped: false, detail: "empty response" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, skipped: false, detail: msg.slice(0, 200) };
  }
}
