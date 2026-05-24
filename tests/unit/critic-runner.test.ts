// tests/unit/critic-runner.test.ts
//
// The critic must run via adapter.complete() — NOT review(). review() forces
// REVIEW_OUTPUT_SCHEMA on schema-enforcing providers (codex/openrouter), so the
// model can only emit {verdict,findings} and never the critic's {verdicts:[...]}
// shape → parseCriticOutput sees nothing → a silent no-op (zero demotions).
import { describe, expect, it } from "bun:test";
import { runCritic } from "../../src/core/critic.ts";
import type { CompleteOptions, ProviderAdapter } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig-1",
    severity: "CRITICAL",
    category: "quality",
    rule_id: "r1",
    file: "src/a.ts",
    line_start: 1,
    line_end: 1,
    message: "msg",
    details: "details",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.8,
    consensus: "singleton",
    ...over,
  };
}

const OPTS: CompleteOptions = { model: "m" };

describe("runCritic", () => {
  it("uses complete() and returns the critic verdict map", async () => {
    const adapter: Pick<ProviderAdapter, "complete"> = {
      complete: async () =>
        JSON.stringify({
          verdicts: [{ signature: "sig-fp", verdict: "likely_fp", reason: "stylistic" }],
        }),
    };
    const { map, info } = await runCritic(adapter, "codex", OPTS, [
      mkFinding({ signature: "sig-fp" }),
    ]);
    expect(info.status).toBe("ran");
    expect(info.verdicts).toBe(1);
    expect(map.get("sig-fp")?.verdict).toBe("likely_fp");
  });

  it("is a VISIBLE no-op (misconfigured) when the adapter has no complete()", async () => {
    const adapter: Pick<ProviderAdapter, "complete"> = {};
    const { map, info } = await runCritic(adapter, "codex", OPTS, [mkFinding()]);
    expect(info.status).toBe("misconfigured");
    expect(map.size).toBe(0);
  });

  it("fails open (empty) on malformed complete() output", async () => {
    const adapter: Pick<ProviderAdapter, "complete"> = {
      complete: async () => "not json at all",
    };
    const { map, info } = await runCritic(adapter, "gemini", OPTS, [mkFinding()]);
    expect(map.size).toBe(0);
    expect(info.status).toBe("empty");
  });

  it("records an error (no throw) when complete() rejects", async () => {
    const adapter: Pick<ProviderAdapter, "complete"> = {
      complete: async () => {
        throw new Error("boom");
      },
    };
    const { map, info } = await runCritic(adapter, "codex", OPTS, [mkFinding()]);
    expect(info.status).toBe("error");
    expect(map.size).toBe(0);
  });

  it("forwards the abort signal through CompleteOptions to complete()", async () => {
    let received: AbortSignal | undefined;
    const adapter: Pick<ProviderAdapter, "complete"> = {
      complete: async (_p, o) => {
        received = o.signal;
        return JSON.stringify({ verdicts: [] });
      },
    };
    const ac = new AbortController();
    await runCritic(adapter, "codex", { model: "m", signal: ac.signal }, [mkFinding()]);
    expect(received).toBe(ac.signal);
  });
});
