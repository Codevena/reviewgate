# Reviewgate `setup` Wizard — Polish Batch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three polish follow-ups for the shipped `reviewgate setup` wizard: re-run pre-fill from the current effective config, critic/curator model prompt+probe, and a `doctor` contextDocs line.

**Architecture:** A new pure `src/cli/setup/prefill.ts` (`answersFromConfig` config→prompt-defaults + `MODEL_DEFAULT` + `RECOMMENDED_DEFAULTS`) feeds `runCustom`'s prompt seeds. The critic/curator reuse the existing `promptModelWithProbe` (gaining an `initialModel` param) and store their model in `phases.{critic,brain.curator}.model` (orchestrator already honors per-role model — verified `orchestrator.ts:620,790,917`). A new pure `contextDocsCheck` is wired into `runDoctor`.

**Tech Stack:** Bun, TypeScript, zod, @clack/prompts, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-05-23-reviewgate-setup-wizard-polish-design.md`

**Conventions (MUST follow):**
- Bun only: `export PATH="$HOME/.bun/bin:$PATH"` then `bun test`, `bunx tsc --noEmit`, `bun run lint` (biome). No `any`, no `delete`.
- Commits: NO Claude/Co-Authored-By/Generated-with attribution. Never push.
- `git add <explicit files>` only (never `-A`); never add the untracked `.claude/` dir or the pre-existing modified `CLAUDE.md`. No HEAD-moving git in subagents.
- Run `bunx tsc --noEmit` AND `bun run lint` clean before every commit; full `bun test` after the wiring task.

---

## File Structure

**Create:**
- `src/cli/setup/prefill.ts` — `MODEL_DEFAULT`, `WizardDefaults`, `RECOMMENDED_DEFAULTS`, `answersFromConfig(cfg)` (pure: config → prompt defaults).
- `tests/unit/setup-prefill.test.ts`.

**Modify:**
- `src/cli/setup/build-config.ts` — `CustomAnswers.critic`/`.brain.curator` gain `model`; `buildCustomConfig` emits per-role model.
- `tests/unit/setup-build-config.test.ts` — update the critic assertion (now includes `model`) + add curator-model coverage.
- `src/cli/commands/doctor.ts` — `contextDocsCheck` + wiring.
- `tests/unit/doctor-reviewers.test.ts` (or a new `tests/unit/doctor-contextdocs.test.ts`) — `contextDocsCheck` tests.
- `src/cli/commands/setup.ts` — import `MODEL_DEFAULT` from prefill (remove local copy); re-add `loadEffectiveConfig` import; `promptModelWithProbe` gains `initialModel`; `runCustom` takes `WizardDefaults` and seeds every prompt; critic/curator get `promptModelWithProbe`; `runSetup` loads the effective config + existing-detection + passes defaults.

---

## Task 1: `prefill.ts` — config → prompt defaults (pure)

**Files:**
- Create: `src/cli/setup/prefill.ts`
- Test: `tests/unit/setup-prefill.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/setup-prefill.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";
import { MODEL_DEFAULT, RECOMMENDED_DEFAULTS, answersFromConfig } from "../../src/cli/setup/prefill.ts";

describe("RECOMMENDED_DEFAULTS", () => {
  it("matches today's fresh-setup recommendation (codex/security, fpLedger ON)", () => {
    expect(RECOMMENDED_DEFAULTS.reviewerProviders).toEqual(["codex"]);
    expect(RECOMMENDED_DEFAULTS.perReviewer.codex).toEqual({ persona: "security", model: MODEL_DEFAULT.codex });
    expect(RECOMMENDED_DEFAULTS.critic).toBeNull();
    expect(RECOMMENDED_DEFAULTS.brainCurator).toBeNull();
    expect(RECOMMENDED_DEFAULTS.fpLedger).toBe(true);
    expect(RECOMMENDED_DEFAULTS.contextDocs).toBe(false);
  });
});

describe("answersFromConfig", () => {
  it("extracts reviewers (provider/persona/model), critic, curator, toggles", () => {
    const cfg = defineConfig({
      providers: { gemini: { enabled: true }, openrouter: { enabled: true } },
      phases: {
        review: { reviewers: [
          { provider: "codex", persona: "security" },
          { provider: "gemini", persona: "architecture" },
        ] },
        critic: { provider: "opencode", persona: "fp-filter" },
        fpLedger: { enabled: true },
        contextDocs: { enabled: true },
        brain: {
          enabled: true,
          embeddings: { provider: "openrouter", model: "baai/bge-base-en-v1.5", apiKeyEnv: "OPENROUTER_API_KEY" },
          curator: { provider: "codex", persona: "fp-filter" },
        },
      },
    } as Parameters<typeof defineConfig>[0]);
    const d = answersFromConfig(cfg);
    expect(d.reviewerProviders).toEqual(["codex", "gemini"]);
    expect(d.perReviewer.codex.persona).toBe("security");
    expect(d.perReviewer.gemini.persona).toBe("architecture");
    // model falls back to providers.<id>.model (the default, since no per-reviewer override)
    expect(d.perReviewer.gemini.model).toBe(cfg.providers.gemini?.model);
    expect(d.critic).toEqual({ provider: "opencode", model: cfg.providers.opencode?.model ?? MODEL_DEFAULT.opencode });
    expect(d.brainCurator?.provider).toBe("codex");
    expect(d.fpLedger).toBe(true);
    expect(d.contextDocs).toBe(true);
  });

  it("defaults/empty config => codex-only, no critic/brain, fpLedger off (schema default)", () => {
    const d = answersFromConfig(defineConfig({}));
    expect(d.reviewerProviders).toEqual(["codex"]);
    expect(d.critic).toBeNull();
    expect(d.brainCurator).toBeNull();
    expect(d.fpLedger).toBe(false); // schema default is null/off — NOT the recommended-on
  });

  it("honors a per-reviewer model override over providers.<id>.model", () => {
    // hand-built partial: reviewers[].model set explicitly (the third-precedence tier)
    const cfg = defineConfig({
      phases: { review: { reviewers: [{ provider: "codex", persona: "security", model: "gpt-5.4-codex" }] } },
    } as Parameters<typeof defineConfig>[0]);
    expect(answersFromConfig(cfg).perReviewer.codex.model).toBe("gpt-5.4-codex");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/setup-prefill.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `prefill.ts`**

Create `src/cli/setup/prefill.ts`:

```ts
import { defaultConfig } from "../../config/defaults.ts";
import type { ReviewgateConfig } from "../../config/define-config.ts";
import type { ProviderId } from "../../providers/registry.ts";

// Per-provider default model, sourced from the validated defaults. Shared with setup.ts.
export const MODEL_DEFAULT: Record<ProviderId, string> = {
  codex: defaultConfig.providers.codex.model,
  gemini: defaultConfig.providers.gemini.model,
  "claude-code": defaultConfig.providers["claude-code"].model,
  openrouter: defaultConfig.providers.openrouter.model,
  opencode: defaultConfig.providers.opencode.model,
};

export interface WizardDefaults {
  reviewerProviders: ProviderId[];
  perReviewer: Record<string, { persona: string; model: string }>;
  critic: { provider: ProviderId; model: string } | null;
  brainCurator: { provider: ProviderId; model: string } | null;
  fpLedger: boolean;
  contextDocs: boolean;
}

// The fresh-setup recommendation (no existing config). Preserves today's wizard behavior —
// notably fpLedger recommended ON even though the schema default is null/off.
export const RECOMMENDED_DEFAULTS: WizardDefaults = {
  reviewerProviders: ["codex"],
  perReviewer: { codex: { persona: "security", model: MODEL_DEFAULT.codex } },
  critic: null,
  brainCurator: null,
  fpLedger: true,
  contextDocs: false,
};

function modelFor(cfg: ReviewgateConfig, provider: ProviderId, override?: string): string {
  return override ?? cfg.providers[provider]?.model ?? MODEL_DEFAULT[provider];
}

// Derives prompt defaults from an existing (effective, validated) config so a re-run seeds
// every Custom prompt with the user's current setup.
export function answersFromConfig(cfg: ReviewgateConfig): WizardDefaults {
  const reviewerProviders: ProviderId[] = [];
  const perReviewer: Record<string, { persona: string; model: string }> = {};
  for (const r of cfg.phases.review.reviewers) {
    if (!reviewerProviders.includes(r.provider)) reviewerProviders.push(r.provider);
    if (!perReviewer[r.provider]) {
      perReviewer[r.provider] = { persona: r.persona, model: modelFor(cfg, r.provider, r.model) };
    }
  }
  const c = cfg.phases.critic;
  const critic = c ? { provider: c.provider, model: modelFor(cfg, c.provider, c.model) } : null;
  const cur = cfg.phases.brain?.curator;
  const brainCurator = cur
    ? { provider: cur.provider, model: modelFor(cfg, cur.provider, cur.model) }
    : null;
  return {
    reviewerProviders,
    perReviewer,
    critic,
    brainCurator,
    fpLedger: Boolean(cfg.phases.fpLedger?.enabled),
    contextDocs: Boolean(cfg.phases.contextDocs?.enabled),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/setup-prefill.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/setup/prefill.ts tests/unit/setup-prefill.test.ts
git commit -m "feat(setup): prefill — answersFromConfig + WizardDefaults (config -> prompt defaults)"
```

---

## Task 2: Judge models in `build-config.ts`

**Files:**
- Modify: `src/cli/setup/build-config.ts`
- Test: `tests/unit/setup-build-config.test.ts`

- [ ] **Step 1: Update the test (existing critic assertion changes + curator-model coverage)**

In `tests/unit/setup-build-config.test.ts`, the existing "maps reviewers + critic + fpLedger toggles" test passes `critic: { provider: "opencode", persona: "fp-filter" }` and asserts `cfg.phases.critic` equals `{ provider, persona }`. Update that test's input to include a model and assert it lands:

```ts
  it("maps reviewers + critic (with model) + fpLedger toggles", () => {
    const partial = buildCustomConfig({
      reviewers: [
        { provider: "codex", persona: "security", model: "gpt-5.4" },
        { provider: "gemini", persona: "architecture", model: "gemini-3-flash-preview" },
      ],
      critic: { provider: "opencode", persona: "fp-filter", model: "default" },
      brain: null,
      fpLedger: true,
      contextDocs: false,
    });
    const cfg = defineConfig(partial as Parameters<typeof defineConfig>[0]);
    expect(cfg.providers.gemini?.enabled).toBe(true);
    expect(cfg.phases.review.reviewers).toHaveLength(2);
    expect(cfg.phases.critic).toEqual({ provider: "opencode", persona: "fp-filter", model: "default" });
    expect(cfg.phases.fpLedger).toEqual({ enabled: true });
    expect(cfg.phases.brain).toBeNull();
    expect(cfg.phases.contextDocs).toBeNull();
  });

  it("emits the curator model in phases.brain.curator.model", () => {
    const partial = buildCustomConfig({
      reviewers: [{ provider: "codex", persona: "security", model: "gpt-5.4" }],
      critic: null,
      brain: { curator: { provider: "codex", persona: "fp-filter", model: "gpt-5.4-codex" } },
      fpLedger: false,
      contextDocs: false,
    });
    const cfg = defineConfig(partial as Parameters<typeof defineConfig>[0]);
    expect(cfg.phases.brain?.curator).toEqual({ provider: "codex", persona: "fp-filter", model: "gpt-5.4-codex" });
  });
```

(Leave the `buildQuickPreset` curator test untouched — Quick stays `{ provider, persona }` with no model.)

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/setup-build-config.test.ts`
Expected: FAIL — `CustomAnswers` doesn't accept `model` on critic/curator yet (tsc/test error).

- [ ] **Step 3: Add `model` to the types + emit it**

In `src/cli/setup/build-config.ts`:

Change the `CustomAnswers` interface:
```ts
export interface CustomAnswers {
  reviewers: ReviewerAnswer[];
  critic: { provider: ProviderId; persona: string; model: string } | null;
  brain: { curator: { provider: ProviderId; persona: string; model: string } } | null;
  fpLedger: boolean;
  contextDocs: boolean;
}
```

In `buildCustomConfig`, change the critic emission to include the model:
```ts
  if (a.critic) phases.critic = { provider: a.critic.provider, persona: a.critic.persona, model: a.critic.model };
```
The `curator: a.brain.curator` line already forwards the whole curator object, which now carries
`model` — no change needed there. (`providersFor` is UNCHANGED: judge providers are still pushed
without a model, so the per-role `phases.{critic,brain.curator}.model` is the judge's model and a
reviewer-and-judge provider keeps its reviewer `providers.<id>.model`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/setup-build-config.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/setup/build-config.ts tests/unit/setup-build-config.test.ts
git commit -m "feat(setup): carry critic/curator model into phases.{critic,brain.curator}.model"
```

---

## Task 3: `doctor` contextDocs line

**Files:**
- Modify: `src/cli/commands/doctor.ts`
- Test: `tests/unit/doctor-contextdocs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/doctor-contextdocs.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { contextDocsCheck } from "../../src/cli/commands/doctor.ts";
import { defineConfig } from "../../src/config/define-config.ts";

describe("contextDocsCheck", () => {
  it("returns null when contextDocs is disabled", () => {
    expect(contextDocsCheck(defineConfig({}), {})).toBeNull();
  });

  it("ok + 'set' when contextDocs enabled and key present", () => {
    const cfg = defineConfig({ phases: { contextDocs: { enabled: true } } } as Parameters<typeof defineConfig>[0]);
    const c = contextDocsCheck(cfg, { CONTEXT7_API_KEY: "x" });
    expect(c?.status).toBe("ok");
    expect(c?.detail).toContain("set");
  });

  it("ok + keyless hint when enabled and key unset", () => {
    const cfg = defineConfig({ phases: { contextDocs: { enabled: true } } } as Parameters<typeof defineConfig>[0]);
    const c = contextDocsCheck(cfg, {});
    expect(c?.status).toBe("ok");
    expect(c?.detail).toContain("keyless");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/doctor-contextdocs.test.ts`
Expected: FAIL — `contextDocsCheck` not exported.

- [ ] **Step 3: Implement + wire `contextDocsCheck`**

In `src/cli/commands/doctor.ts`, add the exported check (near the other `*Check` functions). The
`Check` and `ReviewgateConfig` types are already imported at the top of the file:

```ts
// contextDocs works keyless (lower rate limit), so this is informational (always ok) — it just
// surfaces whether CONTEXT7_API_KEY is set. cfg is the validated effective config, so when
// contextDocs is enabled cd.apiKeyEnv is always populated (schema default CONTEXT7_API_KEY).
export function contextDocsCheck(
  cfg: ReviewgateConfig,
  env: Record<string, string | undefined>,
): Check | null {
  const cd = cfg.phases.contextDocs;
  if (!cd?.enabled) return null;
  const keyName = cd.apiKeyEnv;
  const set = Boolean(env[keyName]);
  return {
    name: "contextDocs",
    status: "ok",
    detail: set
      ? `enabled (${keyName} set)`
      : `enabled (${keyName} unset — keyless works; set it for higher rate limits)`,
  };
}
```

Then wire it into `runDoctor`, right after the `curatorCheck` push (the block that does
`const cur = curatorCheck(cfg, curatorAvailable); if (cur) checks.push(cur);`):

```ts
    const cd = contextDocsCheck(cfg, process.env as Record<string, string | undefined>);
    if (cd) checks.push(cd);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/doctor-contextdocs.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/doctor.ts tests/unit/doctor-contextdocs.test.ts
git commit -m "feat(doctor): surface contextDocs (enabled + CONTEXT7_API_KEY presence)"
```

---

## Task 4: Wire pre-fill + judge probe into `setup.ts`

**Files:**
- Modify: `src/cli/commands/setup.ts`

This task has no new unit tests (the clack flow is TTY-bound; verified in Task 5). It rewires
`runSetup`/`runCustom`/`promptModelWithProbe` to consume `WizardDefaults` and prompt+probe judges.

- [ ] **Step 1: Swap MODEL_DEFAULT to the shared one + add imports**

In `src/cli/commands/setup.ts`:
- DELETE the local `const MODEL_DEFAULT: Record<ProviderId, string> = { ... };` block.
- Add to imports:
```ts
import { loadEffectiveConfig, resolveGlobalConfigPath } from "../../config/global.ts";
import {
  MODEL_DEFAULT,
  RECOMMENDED_DEFAULTS,
  type WizardDefaults,
  answersFromConfig,
} from "../setup/prefill.ts";
```
(The file currently imports only `resolveGlobalConfigPath` from `global.ts` — extend it to include
`loadEffectiveConfig`. Keep `defaultConfig` imported only if still used elsewhere; if the removed
MODEL_DEFAULT was its only use, drop the `defaultConfig` import — verify with tsc.)

- [ ] **Step 2: `promptModelWithProbe` gains `initialModel`**

Change its signature + the `initial` seed:
```ts
async function promptModelWithProbe(
  provider: ProviderId,
  auth: "oauth" | "openrouter",
  initialModel: string = MODEL_DEFAULT[provider],
): Promise<string | null> {
  let initial = initialModel;
  for (;;) {
    // ...unchanged body...
  }
}
```

- [ ] **Step 3: Load effective config + existing-detection + compute defaults in `runSetup`**

The existing `runSetup` "1. Target" block already declares `const globalPath = resolveGlobalConfigPath(env, home);`
and `let targetPath = join(input.repoRoot, "reviewgate.config.ts");`. Do NOT redeclare `globalPath`
(that would be a duplicate-const tsc error). Instead, IMMEDIATELY AFTER those two existing lines (and
before the `if (input.global) {...}` block), insert the detection + defaults computation, reusing the
existing `globalPath` and `targetPath`:
```ts
  const hasExisting =
    existsSync(targetPath) || (globalPath !== null && existsSync(globalPath));
  const defaults: WizardDefaults = hasExisting
    ? answersFromConfig(await loadEffectiveConfig({ cwd: input.repoRoot, env, home }))
    : RECOMMENDED_DEFAULTS;
```
(`existsSync` and `join` are already imported. `targetPath` is the project path at this point —
before the `--global`/select logic may reassign it — which is exactly the project-config path we want
to existence-check.)

Then pass `defaults` into the custom branch:
```ts
  } else {
    const custom = await runCustom(env, orKey, defaults);
    if (!custom) return cancelOut();
    partial = custom;
  }
```

- [ ] **Step 4: `runCustom` consumes `WizardDefaults` and seeds every prompt + probes judges**

Replace the `runCustom` signature and body seeds:

```ts
async function runCustom(
  env: Record<string, string | undefined>,
  orKey: boolean,
  defaults: WizardDefaults,
): Promise<DeepPartial<ReviewgateConfig> | null> {
  const avail = (p: ProviderId) =>
    isProviderAvailable(p, p === "openrouter" ? "OPENROUTER_API_KEY" : undefined, { env });

  const picked = await multiselect({
    message: "Reviewers (space to toggle)",
    options: REVIEWER_PROVIDERS.map((p) => {
      const hint = avail(p) ? undefined : p === "openrouter" ? "no API key" : "CLI not found";
      return hint !== undefined ? { value: p, label: p, hint } : { value: p, label: p };
    }),
    initialValues: defaults.reviewerProviders,
    required: true,
  });
  if (isCancel(picked)) return null;

  const reviewers: CustomAnswers["reviewers"] = [];
  for (const p of picked as ProviderId[]) {
    const seed = defaults.perReviewer[p];
    const persona = await select({
      message: `${p}: persona`,
      options: PERSONAS.map((x) => ({ value: x, label: x })),
      initialValue: seed?.persona ?? "security",
    });
    if (isCancel(persona)) return null;
    const model = await promptModelWithProbe(p, authFor(p), seed?.model ?? MODEL_DEFAULT[p]);
    if (model === null) return null;
    reviewers.push({ provider: p, persona: String(persona), model });
  }

  const wantCritic = await confirm({
    message: "Enable the critic (demote-only FP pass)?",
    initialValue: Boolean(defaults.critic),
  });
  if (isCancel(wantCritic)) return null;
  let critic: CustomAnswers["critic"] = null;
  if (wantCritic) {
    const cp = await select({
      message: "Critic provider",
      options: REVIEWER_PROVIDERS.map((p) => ({ value: p, label: p })),
      initialValue: defaults.critic?.provider ?? "codex",
    });
    if (isCancel(cp)) return null;
    const provider = cp as ProviderId;
    const cm = await promptModelWithProbe(provider, authFor(provider), defaults.critic?.model);
    if (cm === null) return null;
    critic = { provider, persona: "fp-filter", model: cm };
  }

  const wantBrain = await confirm({
    message: "Enable the brain (repo memory + curator)?",
    initialValue: defaults.brainCurator ? true : orKey,
  });
  if (isCancel(wantBrain)) return null;
  let brain: CustomAnswers["brain"] = null;
  if (wantBrain) {
    if (!orKey) {
      note(
        "brain needs OPENROUTER_API_KEY — config will be written but memory stays inert until you set it.",
      );
    }
    const cur = await select({
      message: "Curator (LLM judge — a non-reviewer like opencode is more independent)",
      options: REVIEWER_PROVIDERS.map((p) => ({ value: p, label: p })),
      initialValue: defaults.brainCurator?.provider ?? "codex",
    });
    if (isCancel(cur)) return null;
    const provider = cur as ProviderId;
    const cm = await promptModelWithProbe(provider, authFor(provider), defaults.brainCurator?.model);
    if (cm === null) return null;
    brain = { curator: { provider, persona: "fp-filter", model: cm } };
  }

  const fp = await confirm({
    message: "Enable the FP-ledger (learn rejected false positives)?",
    initialValue: defaults.fpLedger,
  });
  if (isCancel(fp)) return null;

  const ctx = await confirm({
    message: "Enable contextDocs (inject current library docs)?",
    initialValue: defaults.contextDocs,
  });
  if (isCancel(ctx)) return null;
  if (ctx) note("contextDocs works keyless; set CONTEXT7_API_KEY for higher rate limits.");

  return buildCustomConfig({
    reviewers,
    critic,
    brain,
    fpLedger: Boolean(fp),
    contextDocs: Boolean(ctx),
  });
}
```

NOTE on `promptModelWithProbe(provider, authFor(provider), defaults.critic?.model)`: when
`defaults.critic?.model` is `undefined` the default param kicks in (`MODEL_DEFAULT[provider]`). Good.
`authFor` returns `"oauth" | "openrouter"`, matching the probe signature.

- [ ] **Step 5: Static checks + full suite**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bunx tsc --noEmit && bun run lint && bun test`
Expected: clean + full suite 0 fail. (If tsc flags an unused `defaultConfig` import after the
MODEL_DEFAULT removal, delete that import.)

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/setup.ts
git commit -m "feat(setup): pre-fill Custom prompts from current config + probe critic/curator models"
```

---

## Task 5: Compiled-binary E2E verification

**Files:** none (verification only).

- [ ] **Step 1: Build**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun run build`
Expected: `dist/reviewgate` rebuilt, no errors, @clack still bundled.

- [ ] **Step 2: Pre-fill E2E (manual/PTY)**

In a scratch repo, write a config that enables gemini + brain, then re-run `setup` → Custom and
confirm the reviewer multiselect pre-selects codex+gemini and the brain confirm defaults to Yes:

```bash
tmp=$(mktemp -d); cd "$tmp"; git init -q
cat > reviewgate.config.ts <<'EOF'
export default {
  phases: {
    review: { reviewers: [{ provider: "codex", persona: "security" }, { provider: "gemini", persona: "architecture" }] },
    brain: { enabled: true, embeddings: { provider: "openrouter", model: "baai/bge-base-en-v1.5", apiKeyEnv: "OPENROUTER_API_KEY" }, curator: { provider: "codex", persona: "fp-filter" } },
  },
};
EOF
/full/path/to/dist/reviewgate setup
# Custom → observe: reviewers shows codex✓ + gemini✓ pre-selected; brain? defaults to Yes
```
(A PTY driver as used in prior verification is fine; the key assertion is the pre-selected state.)

- [ ] **Step 3: Judge probe E2E**

Re-run Custom, enable the critic, pick a provider, and confirm a model prompt + probe appears for it
(and the re-enter/keep prompt on a forced bad model).

- [ ] **Step 4: doctor contextDocs**

In a repo whose config has `phases.contextDocs: { enabled: true }`, run `dist/reviewgate doctor` and
confirm a `contextDocs: enabled (…)` line appears.

- [ ] **Step 5: Update handoff + final checks + commit**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bunx tsc --noEmit && bun run lint && bun test
```
Update `NEXT_SESSION.md`: mark the three polish items done; record the binary verification.
```bash
git add NEXT_SESSION.md
git commit -m "docs(setup): handoff — wizard polish batch done + binary-verified"
```

> **Definition of Done:** static checks green → reviews (codex ×2 when off ratelimit, else the
> OpenCode fallback; + an Opus pass) → fix findings → re-review until clean → `rm -rf .review/` →
> finishing-a-development-branch (ask before push/merge).

---

## Self-Review (filled by plan author)

**Spec coverage:** §3 pre-fill → Tasks 1 (answersFromConfig/defaults) + 4 (wiring); §4 judge model+probe → Tasks 2 (build-config) + 4 (prompts); §5 doctor contextDocs → Task 3; testing/verification → each task's tests + Task 5. The §4 orchestrator per-role model resolution is already verified (spec) — no orchestrator task needed.

**Placeholder scan:** none — every code step shows complete code.

**Type consistency:** `WizardDefaults`/`MODEL_DEFAULT`/`answersFromConfig` (Task 1) are imported and used with matching shapes in Task 4; `CustomAnswers.critic/.brain.curator` gain `model` in Task 2 and are constructed with `model` in Task 4; `contextDocsCheck(cfg, env)` signature consistent between Task 3 definition and wiring. `promptModelWithProbe`'s new optional `initialModel` is backward-compatible with its existing reviewer call (which now passes `seed?.model ?? MODEL_DEFAULT[p]`).
