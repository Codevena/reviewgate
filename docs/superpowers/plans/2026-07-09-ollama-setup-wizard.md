# Ollama in the Setup Wizard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ollama` selectable in the `reviewgate setup` Custom walk (reviewer / critic / curator) with a user-chosen model and a Cloud/Local endpoint, matching the existing wizard UX.

**Architecture:** ollama flows through the existing per-provider wizard path (persona → `promptModelWithProbe` → failover). New: a memoized Cloud/Local endpoint prompt, `"apikey"` auth, an availability hint that reads "no API key" (not "CLI not found"), and `baseUrl` threading into the model probe + generated config. Wizard changes are made testable by extracting pure helpers.

**Tech Stack:** Bun, TypeScript, `@clack/prompts` (interactive TUI), `bun test`. No schema/adapter changes (those shipped in the prior feature).

## Global Constraints

- Runtime is **Bun**: `bun test`, `bunx tsc --noEmit`, `bun run lint` (biome) — all clean before "done"; never npm/node/jest.
- The wizard **stores no secrets** — reference `OLLAMA_API_KEY` (env), never prompt to paste a key into config.
- **Minimal generated config:** write `providers.ollama.baseUrl` ONLY for Local; Cloud omits it (defaults supply `https://ollama.com/v1`).
- Default model tag `glm-5.2:cloud` (already `MODEL_DEFAULT.ollama`); default env `OLLAMA_API_KEY`; Local baseUrl `http://localhost:11434/v1`.
- **Quick mode + `RECOMMENDED_DEFAULTS` are UNTOUCHED** (ollama is a Custom-mode selectable option, not the fresh default).
- Never `git add -A` (repo tracks `.reviewgate/`/`.superpowers/` scratch); stage exact paths.

---

### Task 1: Data layer — probe `baseUrl` + `build-config` ollama plumbing (TDD)

**Files:**
- Modify: `src/cli/setup/probe.ts` (`ProbeInput.baseUrl` + forward to `complete()`)
- Modify: `src/cli/setup/build-config.ts` (`CustomAnswers.ollamaBaseUrl`; `providersFor` sets `apiKeyEnv`/`baseUrl` for ollama)
- Test: `tests/unit/setup-probe.test.ts` (extend), `tests/unit/setup-build-config.test.ts` (extend)

**Interfaces:**
- Consumes: `probeModel`, `buildCustomConfig`, `defineConfig`, `OllamaAdapter.complete` (already reads `opts.baseUrl`).
- Produces: `ProbeInput` gains `baseUrl?: string`; `CustomAnswers` gains `ollamaBaseUrl?: string`; `buildCustomConfig` writes `providers.ollama = { enabled, auth:"apikey", apiKeyEnv:"OLLAMA_API_KEY", model?, baseUrl? }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/setup-probe.test.ts` (inside the `describe("probeModel", …)` block):
```ts
  it("forwards baseUrl + apiKeyEnv to complete() (ollama local probe)", async () => {
    let captured: Record<string, unknown> | undefined;
    const r = await probeModel(
      { provider: "ollama", model: "glm-5.2:cloud", auth: "apikey", apiKeyEnv: "OLLAMA_API_KEY", baseUrl: "http://localhost:11434/v1", timeoutMs: 1000 },
      { adapter: fakeAdapter(async (_prompt, opts) => { captured = opts as Record<string, unknown>; return "OK"; }) },
    );
    expect(r.ok).toBe(true);
    expect(captured?.baseUrl).toBe("http://localhost:11434/v1");
    expect(captured?.apiKeyEnv).toBe("OLLAMA_API_KEY");
  });
```
(`fakeAdapter`'s `complete` impl is typed `ProviderAdapter["complete"]` = `(prompt, opts) => Promise<string>`, so the two-arg capture is valid.)

Append to `tests/unit/setup-build-config.test.ts` (inside `describe("buildCustomConfig", …)`):
```ts
  it("wires an ollama reviewer: apikey auth + OLLAMA_API_KEY; Cloud omits baseUrl (defaults supply it)", () => {
    const partial = buildCustomConfig({
      reviewers: [{ provider: "ollama", persona: "security", model: "glm-5.2:cloud" }],
      critic: null, brain: null, fpLedger: false, contextDocs: false, reputation: false,
    }) as { providers?: { ollama?: Record<string, unknown> } };
    expect(partial.providers?.ollama).toBeDefined();
    expect(Object.hasOwn(partial.providers?.ollama ?? {}, "baseUrl")).toBe(false); // Cloud → omitted
    const cfg = defineConfig(partial as Parameters<typeof defineConfig>[0]);
    expect(cfg.providers.ollama?.enabled).toBe(true);
    expect(cfg.providers.ollama?.auth).toBe("apikey");
    expect(cfg.providers.ollama?.apiKeyEnv).toBe("OLLAMA_API_KEY");
    expect(cfg.providers.ollama?.model).toBe("glm-5.2:cloud");
    expect(cfg.providers.ollama?.baseUrl).toBe("https://ollama.com/v1"); // from defaults
  });

  it("writes providers.ollama.baseUrl to localhost when Local endpoint chosen", () => {
    const partial = buildCustomConfig({
      reviewers: [{ provider: "ollama", persona: "security", model: "glm-5.2:cloud" }],
      critic: null, brain: null, fpLedger: false, contextDocs: false, reputation: false,
      ollamaBaseUrl: "http://localhost:11434/v1",
    }) as { providers?: { ollama?: { baseUrl?: string } } };
    expect(partial.providers?.ollama?.baseUrl).toBe("http://localhost:11434/v1");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/unit/setup-probe.test.ts tests/unit/setup-build-config.test.ts`
Expected: FAIL — `captured.baseUrl` undefined; `providers.ollama` undefined / no `apiKeyEnv`.

- [ ] **Step 3: Edit `src/cli/setup/probe.ts`**

Add `baseUrl` to `ProbeInput`:
```ts
export interface ProbeInput {
  provider: ProviderId;
  model: string;
  auth: "oauth" | "apikey" | "openrouter";
  apiKeyEnv?: string;
  /** Ollama-only endpoint override, forwarded to complete() (Local daemon probes). */
  baseUrl?: string;
  timeoutMs?: number;
}
```
Forward it in `probeModel`'s `complete` call (add one spread line):
```ts
    const text = await adapter.complete(PROBE_PROMPT, {
      model: input.model,
      auth: input.auth,
      ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      timeoutMs: input.timeoutMs ?? 15_000,
    });
```

- [ ] **Step 4: Edit `src/cli/setup/build-config.ts`**

Add `ollamaBaseUrl` to `CustomAnswers` (after `openrouterProvider`):
```ts
  /** Ollama endpoint override (Local daemon). Absent/empty → Cloud (baseUrl omitted; defaults supply
   *  https://ollama.com/v1). Written as providers.ollama.baseUrl. */
  ollamaBaseUrl?: string;
```
Extend `providersFor` signature + body:
```ts
function providersFor(
  ids: { provider: ProviderId; model?: string }[],
  openrouterProvider?: string,
  ollamaBaseUrl?: string,
): DeepPartial<ReviewgateConfig>["providers"] {
  const out: Record<string, unknown> = {};
  for (const { provider, model } of ids) {
    const entry: Record<string, unknown> = { enabled: true, auth: DEFAULT_AUTH[provider] };
    if (model) entry.model = model;
    if (provider === "openrouter") {
      entry.apiKeyEnv = "OPENROUTER_API_KEY";
      const slug = openrouterProvider?.trim();
      if (slug) entry.openrouterProvider = { only: [slug] };
    }
    if (provider === "ollama") {
      entry.apiKeyEnv = "OLLAMA_API_KEY";
      if (ollamaBaseUrl) entry.baseUrl = ollamaBaseUrl;
    }
    out[provider] = { ...(out[provider] as object), ...entry };
  }
  return out as DeepPartial<ReviewgateConfig>["providers"];
}
```
Pass `a.ollamaBaseUrl` in `buildCustomConfig`'s return:
```ts
  return {
    providers: providersFor(providerIds, a.openrouterProvider, a.ollamaBaseUrl),
    phases: phases as DeepPartial<ReviewgateConfig>["phases"],
  } as DeepPartial<ReviewgateConfig>;
```

- [ ] **Step 5: Run tests + gates**

Run: `bun test tests/unit/setup-probe.test.ts tests/unit/setup-build-config.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli/setup/probe.ts src/cli/setup/build-config.ts tests/unit/setup-probe.test.ts tests/unit/setup-build-config.test.ts
git commit -m "feat(ollama-wizard): probe baseUrl + build-config ollama plumbing (apikey/baseUrl)"
```

---

### Task 2: Wizard wiring — `setup.ts` (pure helpers + interactive walk)

**Files:**
- Modify: `src/cli/commands/setup.ts`
- Test: `tests/unit/setup-wizard-ollama.test.ts` (new — for the exported pure helpers)

**Interfaces:**
- Consumes: `SUBPROCESSLESS_PROVIDERS` (from `registry.ts`), `isProviderAvailable`, `probeModel`, `buildCustomConfig` (Task 1's `ollamaBaseUrl`), `MODEL_DEFAULT`.
- Produces (exported for tests): `REVIEWER_PROVIDERS` (now includes `"ollama"`), `authFor(p): "oauth"|"openrouter"|"apikey"`, `apiKeyEnvFor(p): string|undefined`, `availabilityHint(p, available): string|undefined`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/setup-wizard-ollama.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { REVIEWER_PROVIDERS, authFor, apiKeyEnvFor, availabilityHint } from "../../src/cli/commands/setup.ts";

describe("setup wizard — ollama plumbing", () => {
  it("REVIEWER_PROVIDERS includes ollama", () => {
    expect(REVIEWER_PROVIDERS).toContain("ollama");
  });
  it("authFor maps ollama to apikey, openrouter to openrouter, CLIs to oauth", () => {
    expect(authFor("ollama")).toBe("apikey");
    expect(authFor("openrouter")).toBe("openrouter");
    expect(authFor("codex")).toBe("oauth");
  });
  it("apiKeyEnvFor maps the API-key providers to their env var, CLIs to undefined", () => {
    expect(apiKeyEnvFor("ollama")).toBe("OLLAMA_API_KEY");
    expect(apiKeyEnvFor("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(apiKeyEnvFor("codex")).toBeUndefined();
  });
  it("availabilityHint: keyless API providers read 'no API key', CLIs 'CLI not found', available → undefined", () => {
    expect(availabilityHint("ollama", false)).toBe("no API key");
    expect(availabilityHint("openrouter", false)).toBe("no API key");
    expect(availabilityHint("codex", false)).toBe("CLI not found");
    expect(availabilityHint("ollama", true)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/unit/setup-wizard-ollama.test.ts`
Expected: FAIL — exports not found / `REVIEWER_PROVIDERS` lacks ollama / `authFor` can't return "apikey".

- [ ] **Step 3: Add the exported pure helpers + widen the list in `setup.ts`**

Import `SUBPROCESSLESS_PROVIDERS`:
```ts
import { type ProviderId, SUBPROCESSLESS_PROVIDERS } from "../../providers/registry.ts";
```
Export `REVIEWER_PROVIDERS` with ollama, and replace `authFor` + add the two new helpers:
```ts
export const REVIEWER_PROVIDERS: ProviderId[] = [
  "codex",
  "gemini",
  "claude-code",
  "openrouter",
  "opencode",
  "ollama",
];

export function authFor(p: ProviderId): "oauth" | "openrouter" | "apikey" {
  if (p === "openrouter") return "openrouter";
  if (p === "ollama") return "apikey";
  return "oauth";
}

// The env var carrying each API-key provider's credential (CLIs use their own auth → undefined).
export function apiKeyEnvFor(p: ProviderId): string | undefined {
  if (p === "openrouter") return "OPENROUTER_API_KEY";
  if (p === "ollama") return "OLLAMA_API_KEY";
  return undefined;
}

// Hint shown next to an UNAVAILABLE provider in the reviewer multiselect: API-key providers
// (openrouter, ollama = SUBPROCESSLESS_PROVIDERS) need a key; CLI providers need their binary.
export function availabilityHint(p: ProviderId, available: boolean): string | undefined {
  if (available) return undefined;
  return SUBPROCESSLESS_PROVIDERS.has(p) ? "no API key" : "CLI not found";
}
```

- [ ] **Step 4: Run helper tests + gates**

Run: `bun test tests/unit/setup-wizard-ollama.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS; clean. (tsc will now flag the interactive call sites in `runCustom`/`promptModelWithProbe` that must change in Step 5 — that's expected; fix them there.)

- [ ] **Step 5: Wire the interactive `runCustom` walk**

In `runCustom`, replace the `avail` helper + reviewer-hint mapping to use the new helpers:
```ts
  const avail = (p: ProviderId) => isProviderAvailable(p, apiKeyEnvFor(p), { env });
```
```ts
  const picked = await multiselect({
    message: "Reviewers (space to toggle)",
    options: REVIEWER_PROVIDERS.map((p) => {
      const hint = availabilityHint(p, avail(p));
      return hint !== undefined ? { value: p, label: p, hint } : { value: p, label: p };
    }),
    initialValues: defaults.reviewerProviders,
    required: true,
  });
  if (isCancel(picked)) return null;
```
Add the memoized endpoint state + helper at the top of `runCustom` (after `avail`):
```ts
  // Ollama endpoint (Cloud vs Local) — asked ONCE, the first time ollama is configured in any role;
  // baseUrl is a single providers.ollama property shared across reviewer/critic/curator. undefined = Cloud.
  let ollamaBaseUrl: string | undefined;
  let ollamaEndpointAsked = false;
  const ensureOllamaEndpoint = async (): Promise<boolean> => {
    if (ollamaEndpointAsked) return true;
    const ep = await select({
      message: "Ollama endpoint",
      options: [
        { value: "cloud", label: "Cloud (ollama.com)" },
        { value: "local", label: "Local daemon (localhost:11434)" },
      ],
      initialValue: "cloud",
    });
    if (isCancel(ep)) return false;
    ollamaBaseUrl = ep === "local" ? "http://localhost:11434/v1" : undefined;
    ollamaEndpointAsked = true;
    return true;
  };
```
In the reviewer loop, BEFORE `promptModelWithProbe`, ensure the endpoint for ollama and pass the baseUrl:
```ts
    if (p === "ollama" && !(await ensureOllamaEndpoint())) return null;
    const model = await promptModelWithProbe(
      p,
      authFor(p),
      seed?.model ?? MODEL_DEFAULT[p],
      p === "ollama" ? ollamaBaseUrl : undefined,
    );
    if (model === null) return null;
```
Do the same for the critic model prompt (~L258) and curator model prompt (~L286): before each `promptModelWithProbe(provider, authFor(provider), …)`, add
`if (provider === "ollama" && !(await ensureOllamaEndpoint())) return null;`
and add the 4th arg `provider === "ollama" ? ollamaBaseUrl : undefined`.

After the critic/curator/toggle prompts, before the `openrouterProvider` block, add the missing-key note:
```ts
  const usesOllama = [
    ...reviewers.map((r) => r.provider),
    critic?.provider,
    brain?.curator.provider,
  ].includes("ollama");
  if (usesOllama && !env.OLLAMA_API_KEY) {
    note(
      "ollama needs OLLAMA_API_KEY — config is written but ollama stays inert until you set it (from ollama.com → API Keys).",
    );
  }
```
Pass `ollamaBaseUrl` into the final `buildCustomConfig`:
```ts
  return buildCustomConfig({
    reviewers,
    critic,
    brain,
    fpLedger: Boolean(fp),
    contextDocs: Boolean(ctx),
    reputation: Boolean(rep),
    ...(openrouterProvider ? { openrouterProvider } : {}),
    ...(ollamaBaseUrl ? { ollamaBaseUrl } : {}),
  });
```
Finally, widen `promptModelWithProbe`'s signature to accept the auth union + optional baseUrl, and use `apiKeyEnvFor` for its probe:
```ts
async function promptModelWithProbe(
  provider: ProviderId,
  auth: "oauth" | "openrouter" | "apikey",
  initialModel: string = MODEL_DEFAULT[provider],
  baseUrl?: string,
): Promise<string | null> {
  // …unchanged loop until the probe call…
    const r = await probeModel({
      provider,
      model: chosen,
      auth,
      ...(apiKeyEnvFor(provider) ? { apiKeyEnv: apiKeyEnvFor(provider) } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });
  // …unchanged remainder…
}
```
(Replace the old `...(provider === "openrouter" ? { apiKeyEnv: "OPENROUTER_API_KEY" } : {})` line with the `apiKeyEnvFor` spread above.)

- [ ] **Step 6: Full gates + suite**

Run: `bunx tsc --noEmit && bun run lint && bun test`
Expected: clean; suite green (one pre-existing `doctor.test.ts` subprocess-timeout flake is not a regression).

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/setup.ts tests/unit/setup-wizard-ollama.test.ts
git commit -m "feat(ollama-wizard): ollama selectable in setup (apikey auth, endpoint select, model choice, key note)"
```

---

### Task 3: Functional verification (generated config actually works)

**Files:** none committed (scratchpad).

- [ ] **Step 1: Prove the wizard's OUTPUT is a valid, working ollama config**

A scratchpad script that simulates "user picked an ollama reviewer, Cloud, model `glm-5.2:cloud`" by calling `buildCustomConfig({...ollama reviewer...})` → `finalizeSetup({ print:true })`, asserts the serialized config contains `providers` with an enabled `apikey` ollama block (no `baseUrl` for Cloud), then `defineConfig`s it and runs the real `OllamaAdapter` (built from that config's provider entry) against the live daemon with a planted-bug diff — confirming `status:"ok"` + a mapped finding. (Mirrors the prior feature's acceptance; the daemon path needs no key.)

Run: `bun run <scratchpad>/wizard-accept.ts`
Expected: serialized config has the ollama block; live review returns `ok` + ≥1 finding.

- [ ] **Step 2: (optional, manual) real TTY run**

If a TTY is available, run `bun run dev setup` in a scratch repo, choose Custom → toggle ollama → Cloud → keep `glm-5.2:cloud` → confirm the write + doctor. Not automated (interactive).

---

## Self-Review

**1. Spec coverage** (`docs/superpowers/specs/2026-07-09-ollama-setup-wizard-design.md`):
- Feature 1 endpoint select (memoized, asked-once, before probe) → Task 2 Step 5 (`ensureOllamaEndpoint`). Feature 2 model choice + probe baseUrl → Task 1 (probe.ts) + Task 2 (`promptModelWithProbe` 4th arg). Feature 3: `REVIEWER_PROVIDERS`/`authFor`/hint/`avail`/key-note → Task 2; `providersFor` apiKeyEnv+baseUrl → Task 1. "No secrets" (note only) → Task 2 Step 5 note. "Minimal config" (Cloud omits baseUrl) → Task 1 (`if (ollamaBaseUrl)`). Quick/RECOMMENDED_DEFAULTS untouched → not modified in any task.

**2. Placeholder scan:** No TBD/TODO. Interactive-only code (the clack walk) is honestly marked as verified via the data-layer tests (Task 1) + exported-helper tests (Task 2) + the functional check (Task 3), not claimed as unit-tested.

**3. Type consistency:** `authFor` return type `"oauth"|"openrouter"|"apikey"` matches `promptModelWithProbe`'s widened `auth` param and `ProbeInput.auth`. `apiKeyEnvFor`/`availabilityHint`/`REVIEWER_PROVIDERS` are named identically at definition (Task 2 Step 3) and use (Task 2 Step 5 + tests). `CustomAnswers.ollamaBaseUrl` (Task 1) is the same name threaded from `runCustom` (Task 2 Step 5). `SUBPROCESSLESS_PROVIDERS` reused from the prior feature's `registry.ts`.
