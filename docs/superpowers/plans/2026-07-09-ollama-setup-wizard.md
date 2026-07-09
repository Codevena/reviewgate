# Ollama in the Setup Wizard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ollama` selectable in the `reviewgate setup` Custom walk (reviewer / critic / curator) with a user-chosen model and a Cloud/Local endpoint (reviewer role only), matching the existing wizard UX.

**Architecture:** ollama flows through the existing per-provider wizard path. New: a reviewer-only, memoized Cloud/Local endpoint prompt; `"apikey"` auth; an availability hint that reads "no API key"; `baseUrl` threaded into the reviewer model probe + generated config; endpoint-aware advisory notes; re-run endpoint seeding. Subtle logic is extracted into exported pure helpers so it's unit-tested; the thin `@clack` walk glue is not (the wizard has no interactive test today).

**Tech Stack:** Bun, TypeScript, `@clack/prompts`, `bun test`. No schema/adapter changes.

## Global Constraints

- Runtime is **Bun**: `bun test`, `bunx tsc --noEmit`, `bun run lint` (biome) — all clean; never npm/node/jest.
- The wizard **stores no secrets** — reference `OLLAMA_API_KEY` (env), never prompt to paste a key.
- **Minimal generated config:** write `providers.ollama.baseUrl` ONLY for Local; Cloud omits it.
- **Runtime-honest:** only the **reviewer** role honors `providers.ollama.baseUrl` at gate time; critic/curator/grounding run against Cloud (`complete()` does not thread baseUrl — prior-feature limitation). So the endpoint prompt is **reviewer-only**, critic/curator ollama probes hit Cloud, and a Local-reviewer + ollama-judge combo gets a warning note.
- Default model `glm-5.2:cloud` (`MODEL_DEFAULT.ollama`); env `OLLAMA_API_KEY`; Local baseUrl `http://localhost:11434/v1`.
- **Quick mode + `RECOMMENDED_DEFAULTS` untouched** (except adding the new `ollamaEndpoint` field with value `"cloud"`, which does not change behavior).
- Never `git add -A`; stage exact paths.

---

### Task 1: Data layer — probe `baseUrl` + `build-config` ollama plumbing (TDD)

**Files:**
- Modify: `src/cli/setup/probe.ts` (`ProbeInput.baseUrl` + forward)
- Modify: `src/cli/setup/build-config.ts` (`CustomAnswers.ollamaBaseUrl`; `providersFor` ollama `apiKeyEnv`/`baseUrl`)
- Test: `tests/unit/setup-probe.test.ts` (extend), `tests/unit/setup-build-config.test.ts` (extend)

**Interfaces:**
- Produces: `ProbeInput.baseUrl?: string`; `CustomAnswers.ollamaBaseUrl?: string`; `buildCustomConfig` emits `providers.ollama = { enabled, auth:"apikey", apiKeyEnv:"OLLAMA_API_KEY", model?, baseUrl? }` for an ollama reviewer OR critic/curator.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/setup-probe.test.ts` (inside `describe("probeModel", …)`):
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

Append to `tests/unit/setup-build-config.test.ts` (inside `describe("buildCustomConfig", …)`):
```ts
  it("ollama reviewer: apikey + OLLAMA_API_KEY; Cloud omits baseUrl (defaults supply it)", () => {
    const partial = buildCustomConfig({
      reviewers: [{ provider: "ollama", persona: "security", model: "glm-5.2:cloud" }],
      critic: null, brain: null, fpLedger: false, contextDocs: false, reputation: false,
    }) as { providers?: { ollama?: Record<string, unknown> } };
    expect(Object.hasOwn(partial.providers?.ollama ?? {}, "baseUrl")).toBe(false);
    const cfg = defineConfig(partial as Parameters<typeof defineConfig>[0]);
    expect(cfg.providers.ollama?.enabled).toBe(true);
    expect(cfg.providers.ollama?.auth).toBe("apikey");
    expect(cfg.providers.ollama?.apiKeyEnv).toBe("OLLAMA_API_KEY");
    expect(cfg.providers.ollama?.model).toBe("glm-5.2:cloud");
    expect(cfg.providers.ollama?.baseUrl).toBe("https://ollama.com/v1");
  });

  it("Local endpoint writes providers.ollama.baseUrl=localhost", () => {
    const partial = buildCustomConfig({
      reviewers: [{ provider: "ollama", persona: "security", model: "glm-5.2:cloud" }],
      critic: null, brain: null, fpLedger: false, contextDocs: false, reputation: false,
      ollamaBaseUrl: "http://localhost:11434/v1",
    }) as { providers?: { ollama?: { baseUrl?: string } } };
    expect(partial.providers?.ollama?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("enables providers.ollama when ollama is CRITIC-only (no ollama reviewer)", () => {
    const partial = buildCustomConfig({
      reviewers: [{ provider: "codex", persona: "security", model: "" }],
      critic: { provider: "ollama", persona: "fp-filter", model: "glm-5.2:cloud" },
      brain: null, fpLedger: false, contextDocs: false, reputation: false,
    }) as { providers?: { ollama?: Record<string, unknown> } };
    expect(partial.providers?.ollama?.enabled).toBe(true);
    expect(partial.providers?.ollama?.auth).toBe("apikey");
    expect(partial.providers?.ollama?.apiKeyEnv).toBe("OLLAMA_API_KEY");
  });
```

- [ ] **Step 2: Run to verify failure** — `bun test tests/unit/setup-probe.test.ts tests/unit/setup-build-config.test.ts` → FAIL.

- [ ] **Step 3: Edit `src/cli/setup/probe.ts`** — add `baseUrl?: string` to `ProbeInput` and forward it:
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
In `probeModel`'s `complete` call add one spread: `...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),` (alongside the existing `apiKeyEnv` spread).

- [ ] **Step 4: Edit `src/cli/setup/build-config.ts`**

Add to `CustomAnswers` (after `openrouterProvider`):
```ts
  /** Ollama endpoint override (Local). Absent → Cloud (baseUrl omitted). Written as providers.ollama.baseUrl. */
  ollamaBaseUrl?: string;
```
Extend `providersFor` (add the `ollamaBaseUrl` param + the ollama branch):
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
Pass `a.ollamaBaseUrl` in `buildCustomConfig`'s return: `providers: providersFor(providerIds, a.openrouterProvider, a.ollamaBaseUrl),`. (`providerIds` already includes critic + curator providers — L110-111 — so a critic/curator-only ollama is enabled.)

- [ ] **Step 5: Run tests + gates** — `bun test tests/unit/setup-probe.test.ts tests/unit/setup-build-config.test.ts && bunx tsc --noEmit && bun run lint` → PASS/clean.

- [ ] **Step 6: Commit**
```bash
git add src/cli/setup/probe.ts src/cli/setup/build-config.ts tests/unit/setup-probe.test.ts tests/unit/setup-build-config.test.ts
git commit -m "feat(ollama-wizard): probe baseUrl + build-config ollama plumbing (apikey/baseUrl, all roles)"
```

---

### Task 2: prefill seeding + setup.ts pure helpers (TDD)

**Files:**
- Modify: `src/cli/setup/prefill.ts` (`WizardDefaults.ollamaEndpoint` + `answersFromConfig` + `RECOMMENDED_DEFAULTS`)
- Modify: `src/cli/commands/setup.ts` (export `REVIEWER_PROVIDERS` (+ollama), `authFor` (widen), new `apiKeyEnvFor`, `availabilityHint`, `ollamaNotes`)
- Test: `tests/unit/setup-wizard-ollama.test.ts` (new), `tests/unit/setup-prefill.test.ts` (extend)

**Interfaces:**
- Produces (exported): `REVIEWER_PROVIDERS` (incl. `"ollama"`), `authFor(p): "oauth"|"openrouter"|"apikey"`, `apiKeyEnvFor(p): string|undefined`, `availabilityHint(p, available): string|undefined`, `ollamaNotes({usedAsJudge, endpoint, keyPresent}): string[]`; `WizardDefaults.ollamaEndpoint: "cloud"|"local"`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/setup-wizard-ollama.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { REVIEWER_PROVIDERS, authFor, apiKeyEnvFor, availabilityHint, ollamaNotes } from "../../src/cli/commands/setup.ts";

describe("setup wizard — ollama plumbing", () => {
  it("REVIEWER_PROVIDERS includes ollama", () => {
    expect(REVIEWER_PROVIDERS).toContain("ollama");
  });
  it("authFor: ollama→apikey, openrouter→openrouter, CLI→oauth", () => {
    expect(authFor("ollama")).toBe("apikey");
    expect(authFor("openrouter")).toBe("openrouter");
    expect(authFor("codex")).toBe("oauth");
  });
  it("apiKeyEnvFor: API-key providers→env var, CLI→undefined", () => {
    expect(apiKeyEnvFor("ollama")).toBe("OLLAMA_API_KEY");
    expect(apiKeyEnvFor("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(apiKeyEnvFor("codex")).toBeUndefined();
  });
  it("availabilityHint: key provider unavailable→'no API key', CLI→'CLI not found', available→undefined", () => {
    expect(availabilityHint("ollama", false)).toBe("no API key");
    expect(availabilityHint("openrouter", false)).toBe("no API key");
    expect(availabilityHint("codex", false)).toBe("CLI not found");
    expect(availabilityHint("ollama", true)).toBeUndefined();
  });
  it("ollamaNotes: key-missing note only when !keyPresent; local+judge note only for local+judge", () => {
    expect(ollamaNotes({ usedAsJudge: false, endpoint: "cloud", keyPresent: true })).toEqual([]);
    expect(ollamaNotes({ usedAsJudge: false, endpoint: "cloud", keyPresent: false })).toHaveLength(1);
    expect(ollamaNotes({ usedAsJudge: false, endpoint: "cloud", keyPresent: false })[0]).toContain("OLLAMA_API_KEY");
    const localJudge = ollamaNotes({ usedAsJudge: true, endpoint: "local", keyPresent: true });
    expect(localJudge).toHaveLength(1);
    expect(localJudge[0]).toContain("Cloud");
    // local + judge + no key → BOTH notes
    expect(ollamaNotes({ usedAsJudge: true, endpoint: "local", keyPresent: false })).toHaveLength(2);
  });
});
```

Append to `tests/unit/setup-prefill.test.ts`:
```ts
  it("answersFromConfig derives ollamaEndpoint from providers.ollama.baseUrl", () => {
    const local = answersFromConfig(defineConfig({
      providers: { codex: { enabled: true, auth: "oauth", model: "x", timeoutMs: 1000 },
        ollama: { enabled: true, auth: "apikey", apiKeyEnv: "OLLAMA_API_KEY", model: "glm-5.2:cloud", baseUrl: "http://localhost:11434/v1", timeoutMs: 1000 } },
      phases: { review: { reviewers: [{ provider: "ollama", persona: "security" }] } },
    } as Parameters<typeof defineConfig>[0]));
    expect(local.ollamaEndpoint).toBe("local");
    const cloud = answersFromConfig(defineConfig({
      providers: { codex: { enabled: true, auth: "oauth", model: "x", timeoutMs: 1000 } },
      phases: { review: { reviewers: [{ provider: "codex", persona: "security" }] } },
    } as Parameters<typeof defineConfig>[0]));
    expect(cloud.ollamaEndpoint).toBe("cloud");
  });
```
(imports: ensure the test file imports `answersFromConfig` and `defineConfig`.)

- [ ] **Step 2: Run to verify failure** — both new/extended tests FAIL (exports missing; `ollamaEndpoint` undefined).

- [ ] **Step 3: Edit `src/cli/setup/prefill.ts`**

Import the loopback check: `import { isLoopbackUrl } from "../../providers/ollama.ts";`
Add to `WizardDefaults`: `ollamaEndpoint: "cloud" | "local";`
Add to `RECOMMENDED_DEFAULTS`: `ollamaEndpoint: "cloud",`
In `answersFromConfig`, before the `return`, derive it and include it:
```ts
  const ollamaBase = cfg.providers.ollama?.baseUrl;
  const ollamaEndpoint: "cloud" | "local" = ollamaBase && isLoopbackUrl(ollamaBase) ? "local" : "cloud";
```
Add `ollamaEndpoint,` to the returned object.

- [ ] **Step 4: Edit `src/cli/commands/setup.ts` — export the pure helpers**

Import: `import { type ProviderId } from "../../providers/registry.ts";` stays (SUBPROCESSLESS_PROVIDERS NOT needed).
Replace the `REVIEWER_PROVIDERS` const + `authFor` and add the three helpers:
```ts
export const REVIEWER_PROVIDERS: ProviderId[] = [
  "codex", "gemini", "claude-code", "openrouter", "opencode", "ollama",
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

// Hint next to an UNAVAILABLE provider in the reviewer multiselect. A provider needs a key iff it
// HAS a key env (apiKeyEnvFor) — otherwise it's a CLI provider needing its binary.
export function availabilityHint(p: ProviderId, available: boolean): string | undefined {
  if (available) return undefined;
  return apiKeyEnvFor(p) ? "no API key" : "CLI not found";
}

// Endpoint-aware advisory lines for an ollama-using config. Emitted via note(). `endpoint` is the
// reviewer's choice ("cloud" when ollama is judge-only, since the endpoint prompt is reviewer-only).
export function ollamaNotes(input: {
  usedAsJudge: boolean;
  endpoint: "cloud" | "local";
  keyPresent: boolean;
}): string[] {
  const notes: string[] = [];
  if (!input.keyPresent) {
    notes.push(
      "ollama needs OLLAMA_API_KEY (availability is key-based — even a local daemon needs one set; a placeholder works for localhost). Cloud keys: ollama.com → API Keys. Config is written but ollama stays inert until it's set.",
    );
  }
  if (input.endpoint === "local" && input.usedAsJudge) {
    notes.push(
      "The Local endpoint applies to the ollama reviewer; an ollama critic/curator runs against Ollama Cloud regardless (needs OLLAMA_API_KEY).",
    );
  }
  return notes;
}
```
Delete the old private `REVIEWER_PROVIDERS`/`authFor` definitions.

- [ ] **Step 5: Run the new unit tests** — `bun test tests/unit/setup-wizard-ollama.test.ts tests/unit/setup-prefill.test.ts` → PASS. **Do NOT run `bunx tsc --noEmit` yet:** widening `authFor`'s return type intentionally breaks the not-yet-widened `runCustom`/`promptModelWithProbe` call sites, so tsc is EXPECTED to fail between Step 4 and Step 6. `bun test` transpiles without type-checking, so these tests still run. The full `tsc --noEmit` + `lint` gate is Step 7, after Step 6 wires `runCustom`.

- [ ] **Step 6: Wire the interactive `runCustom` walk**

Change `avail`:
```ts
  const avail = (p: ProviderId) => isProviderAvailable(p, apiKeyEnvFor(p), { env });
```
Reviewer multiselect hint mapping:
```ts
    options: REVIEWER_PROVIDERS.map((p) => {
      const hint = availabilityHint(p, avail(p));
      return hint !== undefined ? { value: p, label: p, hint } : { value: p, label: p };
    }),
```
Add the memoized, **reviewer-only** endpoint state + helper (after `avail`), seeded from prefill defaults:
```ts
  let ollamaBaseUrl: string | undefined; // undefined = Cloud
  let ollamaEndpointAsked = false;
  const ensureOllamaEndpoint = async (): Promise<boolean> => {
    if (ollamaEndpointAsked) return true;
    const ep = await select({
      message: "Ollama endpoint (applies to the reviewer role)",
      options: [
        { value: "cloud", label: "Cloud (ollama.com)" },
        { value: "local", label: "Local daemon (localhost:11434)" },
      ],
      initialValue: defaults.ollamaEndpoint,
    });
    if (isCancel(ep)) return false;
    ollamaBaseUrl = ep === "local" ? "http://localhost:11434/v1" : undefined;
    ollamaEndpointAsked = true;
    return true;
  };
```
In the **reviewer** loop, before `promptModelWithProbe`:
```ts
    if (p === "ollama" && !(await ensureOllamaEndpoint())) return null;
    const model = await promptModelWithProbe(
      p, authFor(p), seed?.model ?? MODEL_DEFAULT[p], p === "ollama" ? ollamaBaseUrl : undefined,
    );
    if (model === null) return null;
```
In the **critic** (~L258) and **curator** (~L286) model prompts, pass `undefined` as the 4th arg (ollama judges run Cloud — do NOT call ensureOllamaEndpoint there):
```ts
    const cm = await promptModelWithProbe(provider, authFor(provider), <existing initial>, undefined);
```
Before the `openrouterProvider` block, emit the endpoint-aware notes:
```ts
  const rolesWithOllama = [...reviewers.map((r) => r.provider), critic?.provider, brain?.curator.provider];
  if (rolesWithOllama.includes("ollama")) {
    const usedAsJudge = critic?.provider === "ollama" || brain?.curator.provider === "ollama";
    const endpoint: "cloud" | "local" = ollamaBaseUrl ? "local" : "cloud";
    for (const line of ollamaNotes({ usedAsJudge, endpoint, keyPresent: Boolean(env.OLLAMA_API_KEY) })) {
      note(line);
    }
  }
```
Pass `ollamaBaseUrl` into the final `buildCustomConfig`: add `...(ollamaBaseUrl ? { ollamaBaseUrl } : {}),`.
Widen `promptModelWithProbe`'s signature + probe call:
```ts
async function promptModelWithProbe(
  provider: ProviderId,
  auth: "oauth" | "openrouter" | "apikey",
  initialModel: string = MODEL_DEFAULT[provider],
  baseUrl?: string,
): Promise<string | null> {
  // …loop…
    const keyEnv = apiKeyEnvFor(provider); // hoist: a double call yields `string | undefined`, tripping TS2379 under exactOptionalPropertyTypes
    const r = await probeModel({
      provider, model: chosen, auth,
      ...(keyEnv ? { apiKeyEnv: keyEnv } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });
  // …remainder…
}
```
(Replace the old `provider === "openrouter" ? { apiKeyEnv: "OPENROUTER_API_KEY" }` spread with the `apiKeyEnvFor` one.)

- [ ] **Step 7: Full gates + suite** — `bunx tsc --noEmit && bun run lint && bun test` → clean; suite green (known `doctor.test.ts` flake aside).

- [ ] **Step 8: Commit**
```bash
git add src/cli/setup/prefill.ts src/cli/commands/setup.ts tests/unit/setup-wizard-ollama.test.ts tests/unit/setup-prefill.test.ts
git commit -m "feat(ollama-wizard): ollama selectable in setup (apikey, reviewer-only endpoint, seeded re-run, honest notes)"
```

---

### Task 3: Functional verification (generated reviewer config works)

**Files:** none committed (scratchpad).

- [ ] **Step 1: Prove the wizard OUTPUT is a valid, working ollama REVIEWER config**

Scratchpad script simulating "user picked an ollama **reviewer**, **Local** daemon, model `glm-5.2:cloud`":
`buildCustomConfig({ reviewers:[{provider:"ollama",persona:"security",model:"glm-5.2:cloud"}], …, ollamaBaseUrl:"http://localhost:11434/v1" })` → `finalizeSetup({ print:true })` → assert the serialized text has `providers.ollama` with `auth:"apikey"`, `apiKeyEnv:"OLLAMA_API_KEY"`, `baseUrl:"http://localhost:11434/v1"`. Then `defineConfig` it, construct the real `OllamaAdapter`, and `review()` a planted-bug diff against the **local daemon** (baseUrl=localhost, no key needed) → assert `status:"ok"` + ≥1 finding. This exercises the reviewer path the config actually enables (the daemon honors baseUrl at runtime).

Run: `bun run <scratchpad>/wizard-accept.ts` → serialized ollama block correct; live review `ok` + finding. Delete the script after.

- [ ] **Step 2: (optional, manual) real TTY run** — `bun run dev setup` in a scratch repo → Custom → toggle ollama → Local → keep `glm-5.2:cloud` → confirm write + doctor. Not automated.

---

## Self-Review

**1. Spec coverage:** Feature 1 reviewer-only endpoint + memoization + re-run seeding → Task 2 (Step 3 prefill, Step 6 `ensureOllamaEndpoint` seeded from `defaults.ollamaEndpoint`, reviewer-only). Feature 2 model+probe baseUrl (reviewer honors, judges Cloud) → Task 1 (probe) + Task 2 Step 6 (reviewer passes `ollamaBaseUrl`, critic/curator pass `undefined`). Feature 3 helpers (`authFor`/`apiKeyEnvFor`/`availabilityHint`/`ollamaNotes`), `providersFor`, prefill → Tasks 1+2. Cloud-omits-baseUrl → Task 1 `if (ollamaBaseUrl)`. Critic/curator-only enable → Task 1 (providerIds includes all roles) + its test. No-secrets/Quick-untouched → not modified.

**2. Placeholder scan:** No TBD. The interactive `runCustom` clack glue is honestly marked untested (no wizard-walk test exists today); the subtle logic (`ollamaNotes`, `availabilityHint`, endpoint mapping, prefill seeding) IS extracted into tested pure helpers, and Task 3 gives a functional check of the OUTPUT.

**3. Type consistency:** `authFor` return `"oauth"|"openrouter"|"apikey"` matches `promptModelWithProbe`'s widened `auth` and `ProbeInput.auth`. `apiKeyEnvFor`/`availabilityHint`/`ollamaNotes`/`REVIEWER_PROVIDERS` named identically at definition (Task 2 Step 4) and use (Step 6 + tests). `CustomAnswers.ollamaBaseUrl` (Task 1) is threaded from `runCustom` (Task 2 Step 6). `WizardDefaults.ollamaEndpoint` (Task 2 Step 3) seeds `ensureOllamaEndpoint` (Step 6). `isLoopbackUrl` reused from `ollama.ts`. No `SUBPROCESSLESS_PROVIDERS` dependency (availabilityHint uses `apiKeyEnvFor`).
