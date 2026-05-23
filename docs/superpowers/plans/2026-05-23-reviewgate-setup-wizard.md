# Reviewgate `setup` Wizard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive `reviewgate setup` wizard that probes which providers actually work, walks the user through reviewer/critic/brain/fpLedger/contextDocs choices (Quick preset or Custom), live-verifies models, and writes a minimal plain-object `reviewgate.config.ts` (project or global) — backed by a new `global → project → defaults` config-precedence layer.

**Architecture:** A thin `@clack/prompts` TTY layer (`setup.ts`) over pure, unit-tested modules: availability probing (extracted from `doctor.ts`), config diffing/serialization, a layered loader, answer→config building, and a live model probe. The compiled-binary bundling of `@clack/prompts` is de-risked in Task 1 before anything is built on it.

**Tech Stack:** Bun (runtime + `bun build --compile`), TypeScript, zod (config schema), citty (CLI), `@clack/prompts` (new), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-05-23-reviewgate-setup-wizard-design.md`

**Conventions (MUST follow):**
- Bun only: `bun add`, `bun test`, `bunx tsc --noEmit`, `bun run lint` (biome). Set `PATH="$HOME/.bun/bin:$PATH"`.
- `reviewgate.config.ts` output is a **plain `export default {}`** — never a `defineConfig` import.
- Use `console.warn`/`console.error` (not a custom logger) in any JS-context output paths.
- Commits: **no Claude attribution**, present-tense conventional-commit messages. **Never push.**
- `git add <explicit files>` (never `-A`); never run HEAD-moving git in a subagent.
- Run `bunx tsc --noEmit` AND `bun run lint` clean before every commit; `bun test` after schema/loader changes.

---

## File Structure

**Create:**
- `src/providers/availability.ts` — `PROVIDER_BIN` + `isProviderAvailable(id, apiKeyEnv, deps)` (extracted from doctor; injectable `env`/`probeBin`).
- `src/config/diff-defaults.ts` — `diffFromDefaults(cfg)` pure structural diff vs `defaultConfig`.
- `src/config/serialize.ts` — `serializeConfig(partial)` → plain `export default {}` TS string.
- `src/config/global.ts` — `resolveGlobalConfigPath(env, home)` + `loadEffectiveConfig({cwd, env, home})`.
- `src/cli/setup/build-config.ts` — `Answers` type, `buildQuickPreset()`, `buildCustomConfig()`.
- `src/cli/setup/probe.ts` — `probeModel(input, deps?)` live model check.
- `src/cli/commands/setup.ts` — `runSetup` (clack flow) + pure `finalizeSetup()` + `setupTip()`.
- Tests under `tests/unit/` per task.

**Modify:**
- `src/config/define-config.ts` — export `deepMerge` and `DeepPartial`.
- `src/cli/commands/doctor.ts` — re-point provider-availability to `availability.ts`.
- `src/cli/commands/gate.ts` — replace inline `loadEffectiveConfig` with the shared one.
- `src/cli/index.ts` — register the `setup` command + print the TTY-only setup tip after `init`.
- `package.json` — add `@clack/prompts`.

---

## Task 1: Bundling spike — `@clack/prompts` survives `bun --compile`

**Goal:** Prove the prompt library bundles into the compiled binary BEFORE building on it (cf. the M3 wasm regression — `bun test` would not catch a bundle drop). This task is a spike, not TDD.

**Files:**
- Modify: `package.json` (dependency)
- Create (temporary): `src/cli/commands/setup.ts` (minimal stub, expanded in Task 7)
- Modify: `src/cli/index.ts` (register stub)

- [ ] **Step 1: Add the dependency**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun add @clack/prompts`
Expected: `@clack/prompts` appears under `dependencies` in `package.json`; `bun.lock` updated.

- [ ] **Step 2: Write a minimal clack stub command**

Create `src/cli/commands/setup.ts`:

```ts
import { intro, isCancel, outro, select } from "@clack/prompts";

export interface SetupInput {
  repoRoot: string;
}

export async function runSetup(_input: SetupInput): Promise<number> {
  intro("reviewgate setup");
  const mode = await select({
    message: "Setup mode",
    options: [
      { value: "quick", label: "Quick (recommended preset)" },
      { value: "custom", label: "Custom (configure everything)" },
    ],
  });
  if (isCancel(mode)) {
    outro("setup cancelled, no changes written");
    return 1;
  }
  outro(`(spike) selected: ${String(mode)}`);
  return 0;
}
```

- [ ] **Step 3: Register the command**

In `src/cli/index.ts`, add the import and the command, and add it to `subCommands`:

```ts
import { runSetup } from "./commands/setup.ts";

const setup = defineCommand({
  meta: { name: "setup", description: "Interactive configuration wizard" },
  async run() {
    process.exit(await runSetup({ repoRoot: process.cwd() }));
  },
});
```
Add `setup` to the `subCommands` object of `main` (alongside `init`, `gate`, …).

- [ ] **Step 4: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean (no errors).

- [ ] **Step 5: Build the compiled binary**

Run: `bun run build`
Expected: `dist/reviewgate` rebuilt with no "module not found" / unresolved-import error for `@clack/prompts`.

- [ ] **Step 6: Run setup FROM THE COMPILED BINARY**

Run: `dist/reviewgate setup < /dev/null`
Expected: it prints the `reviewgate setup` intro and then exits gracefully (clack receives EOF → cancel → "setup cancelled" or the spike outro). It must **NOT** crash with `Cannot find module "@clack/prompts"` or a runtime import error. This proves the library is bundled into the standalone binary.

> **GATE:** If the binary crashes on the clack import, STOP and switch the dependency to `@inquirer/prompts` (adjust the stub to its API) before continuing. Re-run Steps 4–6. Do not proceed until the compiled binary renders the prompt.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/cli/commands/setup.ts src/cli/index.ts
git commit -m "feat(setup): add @clack/prompts + setup command stub (compiled-binary bundling spike)"
```

---

## Task 2: Extract provider-availability into a shared, injectable module

**Goal:** Move doctor's `PROVIDER_BIN` + availability resolver into `src/providers/availability.ts` with injected `env`/`probeBin` (so it is pure-testable), covering all five provider ids; re-point `doctor.ts` at it without changing doctor behavior.

**Files:**
- Create: `src/providers/availability.ts`
- Test: `tests/unit/availability.test.ts`
- Modify: `src/cli/commands/doctor.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/availability.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { isProviderAvailable } from "../../src/providers/availability.ts";

describe("isProviderAvailable", () => {
  it("openrouter: true only when the configured key env var is set", () => {
    expect(isProviderAvailable("openrouter", "OPENROUTER_API_KEY", { env: { OPENROUTER_API_KEY: "sk-x" } })).toBe(true);
    expect(isProviderAvailable("openrouter", "OPENROUTER_API_KEY", { env: {} })).toBe(false);
  });

  it("openrouter: honors a non-default apiKeyEnv name", () => {
    expect(isProviderAvailable("openrouter", "MY_KEY", { env: { MY_KEY: "x" } })).toBe(true);
    expect(isProviderAvailable("openrouter", "MY_KEY", { env: { OPENROUTER_API_KEY: "x" } })).toBe(false);
  });

  it("openrouter: defaults a missing apiKeyEnv to OPENROUTER_API_KEY", () => {
    expect(isProviderAvailable("openrouter", undefined, { env: { OPENROUTER_API_KEY: "x" } })).toBe(true);
  });

  it("CLI providers probe their binary (codex/gemini/claude-code/opencode)", () => {
    const present = (bin: string) => ["codex", "gemini", "claude", "opencode"].includes(bin);
    for (const id of ["codex", "gemini", "claude-code", "opencode"] as const) {
      expect(isProviderAvailable(id, undefined, { env: {}, probeBin: present })).toBe(true);
    }
    expect(isProviderAvailable("codex", undefined, { env: {}, probeBin: () => false })).toBe(false);
  });

  it("claude-code probes the `claude` binary, not `claude-code`", () => {
    const probed: string[] = [];
    isProviderAvailable("claude-code", undefined, { env: {}, probeBin: (b) => { probed.push(b); return true; } });
    expect(probed).toEqual(["claude"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/availability.test.ts`
Expected: FAIL — `Cannot find module ".../availability.ts"`.

- [ ] **Step 3: Implement `availability.ts`**

Create `src/providers/availability.ts`:

```ts
import { spawnSync } from "node:child_process";
import type { ProviderId } from "./registry.ts";

// CLI providers resolve via a `--version` binary probe; openrouter has NO binary
// (it is an API-key check). claude-code runs the `claude` CLI.
export const PROVIDER_BIN: Record<ProviderId, string | null> = {
  codex: "codex",
  gemini: "gemini",
  "claude-code": "claude",
  opencode: "opencode",
  openrouter: null,
};

export interface AvailabilityDeps {
  env?: Record<string, string | undefined>;
  probeBin?: (bin: string) => boolean;
}

function defaultProbeBin(bin: string): boolean {
  try {
    return spawnSync(bin, ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

// Whether a provider can actually run. For openrouter: the configured key env var
// (apiKeyEnv, default OPENROUTER_API_KEY) must be set. For CLI providers: the
// binary must respond to `--version`. Dependencies are injected for testability.
export function isProviderAvailable(
  id: ProviderId,
  apiKeyEnv: string | undefined,
  deps: AvailabilityDeps = {},
): boolean {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const probe = deps.probeBin ?? defaultProbeBin;
  if (id === "openrouter") return Boolean(env[apiKeyEnv ?? "OPENROUTER_API_KEY"]);
  const bin = PROVIDER_BIN[id];
  return bin ? probe(bin) : false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/availability.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Re-point `doctor.ts` at the shared resolver**

In `src/cli/commands/doctor.ts`:
- Add import: `import { isProviderAvailable } from "../../providers/availability.ts";`
- Remove the local `PROVIDER_BIN` constant (lines ~193-199) and the `curatorAvailable` closure (lines ~200-204).
- Replace the closure usage with:

```ts
    const curatorAvailable: ProviderAvailable = (id, apiKeyEnv) =>
      isProviderAvailable(id, apiKeyEnv);
```
(Keep the `ProviderAvailable` type and the `checkBinary` helper as-is — `checkBinary` is still used for the standalone CLI status lines.)

- [ ] **Step 6: Verify doctor tests + checks still pass**

Run: `bun test tests/unit/doctor-reviewers.test.ts tests/unit/availability.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS + clean. (If other doctor tests exist, run `bun test -t doctor`.)

- [ ] **Step 7: Commit**

```bash
git add src/providers/availability.ts tests/unit/availability.test.ts src/cli/commands/doctor.ts
git commit -m "refactor(doctor): extract injectable provider-availability resolver"
```

---

## Task 3: Config diff + serializer (minimal plain-object output)

**Goal:** `diffFromDefaults` reduces a full config to the minimal partial that differs from `defaultConfig`; `serializeConfig` renders that partial as a plain `export default {}`. The round-trip `defineConfig(diffFromDefaults(cfg)) deepEquals cfg` is the invariant.

**Files:**
- Modify: `src/config/define-config.ts` (export `deepMerge`, `DeepPartial`)
- Create: `src/config/diff-defaults.ts`
- Create: `src/config/serialize.ts`
- Test: `tests/unit/config-diff-serialize.test.ts`

- [ ] **Step 1: Export `deepMerge` and `DeepPartial` from `define-config.ts`**

In `src/config/define-config.ts` change the declarations to named exports (no behavior change):

```ts
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  // ...unchanged body...
}
```

Run: `bunx tsc --noEmit` → Expected: clean.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/config-diff-serialize.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { defineConfig } from "../../src/config/define-config.ts";
import { loadConfig } from "../../src/config/loader.ts";
import { diffFromDefaults } from "../../src/config/diff-defaults.ts";
import { serializeConfig } from "../../src/config/serialize.ts";

describe("diffFromDefaults", () => {
  it("returns an empty object when the config equals the defaults", () => {
    expect(diffFromDefaults(defineConfig({}))).toEqual({});
  });

  it("emits a default-on feature being disabled (fpLedger -> {enabled:false})", () => {
    const cfg = defineConfig({ phases: { fpLedger: { enabled: true } } });
    // start from enabled, then turn off:
    const off = defineConfig({ phases: { fpLedger: { enabled: false } } });
    expect(diffFromDefaults(off)).toEqual({ phases: { fpLedger: { enabled: false } } });
    expect(diffFromDefaults(cfg)).toEqual({ phases: { fpLedger: { enabled: true } } });
  });

  it("omits nullable features left at their default null (critic/brain)", () => {
    const d = diffFromDefaults(defineConfig({}));
    expect("critic" in (d.phases ?? {})).toBe(false);
    expect("brain" in (d.phases ?? {})).toBe(false);
  });

  it("re-emits the WHOLE reviewers array when any element differs", () => {
    const cfg = defineConfig({
      phases: { review: { reviewers: [
        { provider: "codex", persona: "security" },
        { provider: "gemini", persona: "architecture" },
      ] } },
    } as Parameters<typeof defineConfig>[0]);
    const d = diffFromDefaults(cfg);
    expect(d.phases?.review?.reviewers).toHaveLength(2);
  });
});

describe("serializeConfig + round-trip", () => {
  function roundTrip(cfg: ReturnType<typeof defineConfig>) {
    const partial = diffFromDefaults(cfg);
    const text = serializeConfig(partial as Record<string, unknown>);
    expect(text.startsWith("//")).toBe(true);
    expect(text).toContain("export default {");
    expect(text).not.toContain("defineConfig");
    const dir = mkdtempSync(join(tmpdir(), "rg-cfg-"));
    const file = join(dir, "reviewgate.config.ts");
    writeFileSync(file, text);
    return loadConfig(file);
  }

  it("round-trips a brain+reviewers config back to the same effective config", async () => {
    const cfg = defineConfig({
      phases: {
        review: { reviewers: [
          { provider: "codex", persona: "security" },
          { provider: "openrouter", persona: "adversarial" },
        ] },
        fpLedger: { enabled: true },
        brain: {
          enabled: true,
          embeddings: { provider: "openrouter", model: "baai/bge-base-en-v1.5", apiKeyEnv: "OPENROUTER_API_KEY" },
          curator: { provider: "codex", persona: "fp-filter" },
        },
      },
      providers: { openrouter: { enabled: true } },
    } as Parameters<typeof defineConfig>[0]);
    const reloaded = await roundTrip(cfg);
    expect(reloaded).toEqual(cfg);
  });

  it("round-trips the bare defaults to an empty `export default {}`", async () => {
    const reloaded = await roundTrip(defineConfig({}));
    expect(reloaded).toEqual(defineConfig({}));
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test tests/unit/config-diff-serialize.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `diff-defaults.ts`**

Create `src/config/diff-defaults.ts`:

```ts
import { defaultConfig } from "./defaults.ts";
import type { DeepPartial, ReviewgateConfig } from "./define-config.ts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// Recursively keep only what differs from `base`. Objects recurse (an empty diff
// is dropped); arrays + scalars + null compare whole and are emitted intact when
// they differ. Operates on two fully-resolved configs (no explicit-vs-omitted
// ambiguity). The result, fed back through defineConfig, reproduces the input.
function diff(value: unknown, base: unknown): { changed: boolean; value: unknown } {
  if (isPlainObject(value) && isPlainObject(base)) {
    const out: Record<string, unknown> = {};
    let changed = false;
    for (const k of Object.keys(value)) {
      const r = diff(value[k], base[k]);
      if (r.changed) {
        out[k] = r.value;
        changed = true;
      }
    }
    return { changed, value: out };
  }
  return { changed: !deepEqual(value, base), value };
}

export function diffFromDefaults(cfg: ReviewgateConfig): DeepPartial<ReviewgateConfig> {
  return diff(cfg, defaultConfig).value as DeepPartial<ReviewgateConfig>;
}
```

- [ ] **Step 5: Implement `serialize.ts`**

Create `src/config/serialize.ts`:

```ts
const BLOCK_COMMENTS: Record<string, string> = {
  providers: "Providers (reviewers + judges). Models & OAuth-vs-OpenRouter are your choice.",
  phases: "Review pipeline: reviewers, critic, brain (repo memory), fpLedger, contextDocs.",
  docReview: "Optional plan/spec review.",
  weeklyReport: "Weekly report auto-snapshot on rollover.",
};

function renderKey(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
}

// Renders a JS object/array/scalar literal. `indent` is the depth of the line that
// holds the opening brace/bracket; contents sit one level deeper.
function renderValue(v: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  const padIn = "  ".repeat(indent + 1);
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const items = v.map((x) => padIn + renderValue(x, indent + 1));
    return `[\n${items.join(",\n")}\n${pad}]`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>);
    if (keys.length === 0) return "{}";
    const items = keys.map(
      (k) => `${padIn}${renderKey(k)}: ${renderValue((v as Record<string, unknown>)[k], indent + 1)}`,
    );
    return `{\n${items.join(",\n")}\n${pad}}`;
  }
  if (typeof v === "string") return JSON.stringify(v);
  return String(v); // number | boolean
}

// Renders a config partial as a plain `export default {}` TS module (no defineConfig
// import — ever). A one-line comment precedes each known top-level block. Comments
// are decorative; they are stripped on import (round-trip-safe).
export function serializeConfig(partial: Record<string, unknown>): string {
  const keys = Object.keys(partial);
  const body = keys
    .map((k) => {
      const c = BLOCK_COMMENTS[k] ? `  // ${BLOCK_COMMENTS[k]}\n` : "";
      return `${c}  ${renderKey(k)}: ${renderValue(partial[k], 1)},`;
    })
    .join("\n");
  return [
    "// Reviewgate config — generated by `reviewgate setup`.",
    "// A plain object, deep-merged over defaults + validated. Edit freely.",
    "export default {",
    body,
    "};",
    "",
  ].join("\n");
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/unit/config-diff-serialize.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS + clean.

- [ ] **Step 7: Commit**

```bash
git add src/config/define-config.ts src/config/diff-defaults.ts src/config/serialize.ts tests/unit/config-diff-serialize.test.ts
git commit -m "feat(config): minimal-diff + plain-object serializer with loadConfig round-trip"
```

---

## Task 4: Global config-precedence layer

**Goal:** `resolveGlobalConfigPath(env, home)` (returns `null` when unresolvable) + `loadEffectiveConfig({cwd, env, home})` merging `defaults ← global ← project`, preserving the gate's graceful try/catch fallback. Re-point the gate + doctor at it.

**Files:**
- Create: `src/config/global.ts`
- Test: `tests/unit/global-config.test.ts`
- Modify: `src/cli/commands/gate.ts`, `src/cli/commands/doctor.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/global-config.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";
import { loadEffectiveConfig, resolveGlobalConfigPath } from "../../src/config/global.ts";

function tmp() {
  return mkdtempSync(join(tmpdir(), "rg-glob-"));
}

describe("resolveGlobalConfigPath", () => {
  it("prefers XDG_CONFIG_HOME", () => {
    expect(resolveGlobalConfigPath({ XDG_CONFIG_HOME: "/x" }, "/home/u")).toBe(
      "/x/reviewgate/reviewgate.config.ts",
    );
  });
  it("falls back to <home>/.config", () => {
    expect(resolveGlobalConfigPath({}, "/home/u")).toBe(
      "/home/u/.config/reviewgate/reviewgate.config.ts",
    );
  });
  it("returns null when neither XDG_CONFIG_HOME nor a usable home is available", () => {
    expect(resolveGlobalConfigPath({}, "")).toBeNull();
    expect(resolveGlobalConfigPath({}, "relative/path")).toBeNull();
  });
});

describe("loadEffectiveConfig", () => {
  it("no global, no project => byte-identical to defaults", async () => {
    const cwd = tmp();
    const cfg = await loadEffectiveConfig({ cwd, env: {}, home: tmp() });
    expect(cfg).toEqual(defineConfig({}));
  });

  it("project overrides defaults", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "reviewgate.config.ts"), 'export default { phases: { fpLedger: { enabled: true } } };');
    const cfg = await loadEffectiveConfig({ cwd, env: {}, home: tmp() });
    expect(cfg.phases.fpLedger).toEqual({ enabled: true });
  });

  it("project beats global; global beats defaults; reviewers array REPLACES", async () => {
    const home = tmp();
    const gdir = join(home, ".config", "reviewgate");
    require("node:fs").mkdirSync(gdir, { recursive: true });
    writeFileSync(join(gdir, "reviewgate.config.ts"),
      'export default { notify: { desktop: true }, phases: { review: { reviewers: [{ provider: "gemini", persona: "security" }] } } };');
    const cwd = tmp();
    writeFileSync(join(cwd, "reviewgate.config.ts"),
      'export default { phases: { review: { reviewers: [{ provider: "codex", persona: "adversarial" }] } } };');
    const cfg = await loadEffectiveConfig({ cwd, env: {}, home });
    expect(cfg.notify.desktop).toBe(true); // from global (defaults=false)
    expect(cfg.phases.review.reviewers).toEqual([{ provider: "codex", persona: "adversarial" }]); // project replaces
  });

  it("a malformed project config degrades to the lower layers (no throw)", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "reviewgate.config.ts"), "this is not valid typescript $$$");
    const cfg = await loadEffectiveConfig({ cwd, env: {}, home: tmp() });
    expect(cfg).toEqual(defineConfig({}));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/unit/global-config.test.ts`
Expected: FAIL — `src/config/global.ts` not found.

- [ ] **Step 3: Implement `global.ts`**

Create `src/config/global.ts`:

```ts
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { defaultConfig } from "./defaults.ts";
import { type DeepPartial, type ReviewgateConfig, defineConfig, deepMerge } from "./define-config.ts";

export function resolveGlobalConfigPath(
  env: Record<string, string | undefined>,
  home: string,
): string | null {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : home && isAbsolute(home) ? join(home, ".config") : null;
  if (!base) return null;
  return join(base, "reviewgate", "reviewgate.config.ts");
}

// Reads a config file's RAW default-export partial (NOT through defineConfig). A file
// that is missing, fails to import, or doesn't export an object yields null so the
// layer is simply dropped — mirrors the gate's historical graceful fallback.
async function readRawPartial(path: string | null): Promise<DeepPartial<ReviewgateConfig> | null> {
  if (!path || !existsSync(path)) return null;
  try {
    const mod = (await import(resolve(path))) as { default?: unknown };
    if (mod.default && typeof mod.default === "object") {
      return mod.default as DeepPartial<ReviewgateConfig>;
    }
  } catch {
    // fall through — broken layer is dropped
  }
  return null;
}

export interface EffectiveConfigInput {
  cwd: string;
  env?: Record<string, string | undefined>;
  home?: string;
}

// Effective config = defaults <- global <- project. Validated once at the end.
export async function loadEffectiveConfig(input: EffectiveConfigInput): Promise<ReviewgateConfig> {
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const home = input.home ?? "";
  const globalPath = resolveGlobalConfigPath(env, home);
  const globalPartial = await readRawPartial(globalPath);
  const projectPartial = await readRawPartial(join(input.cwd, "reviewgate.config.ts"));
  // Merge the two partials (project wins). Base is cast to the full type so the
  // generic resolves to <ReviewgateConfig>; the result is re-validated by defineConfig
  // (which also re-merges over defaults), so the cast is structural only.
  const merged = deepMerge(
    (globalPartial ?? {}) as ReviewgateConfig,
    (projectPartial ?? {}) as DeepPartial<ReviewgateConfig>,
  );
  try {
    return defineConfig(merged as Parameters<typeof defineConfig>[0]);
  } catch {
    // A merged config that fails validation degrades to defaults (gate stays functional).
    return defineConfig({});
  }
}
```

> Note: `import()` caches modules by resolved path; the per-test temp dirs use unique
> paths so cache collisions don't occur. (`defaultConfig` import is type-only context for
> the test's `defineConfig({})` comparison.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/global-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-point the gate at the shared loader**

In `src/cli/commands/gate.ts`, replace the inline `loadEffectiveConfig` (lines ~33-44) with an import + call:

```ts
import { loadEffectiveConfig } from "../../config/global.ts";
import { homedir } from "node:os";
```
Delete the local `async function loadEffectiveConfig(repoRoot: string)` and change its single call site (`const cfg = await loadEffectiveConfig(input.repoRoot);`) to:

```ts
  const cfg = await loadEffectiveConfig({
    cwd: input.repoRoot,
    env: process.env as Record<string, string | undefined>,
    home: homedir(),
  });
```
Remove now-unused imports if `loadConfig`/`defaultConfigPath` are no longer referenced elsewhere in the file (check with `bunx tsc --noEmit`).

- [ ] **Step 6: Re-point doctor at the shared loader**

In `src/cli/commands/doctor.ts`, replace the config load (line ~187 `const cfg = await loadConfig(cfgExists ? cfgPath : null);`) with:

```ts
import { loadEffectiveConfig } from "../../config/global.ts";
import { homedir } from "node:os";
// ...
    const cfg = await loadEffectiveConfig({
      cwd: input.repoRoot,
      env: process.env as Record<string, string | undefined>,
      home: homedir(),
    });
```
(Keep the surrounding try/catch and the `cfgExists` "reviewgate.config.ts present" check, which is independent.)

- [ ] **Step 7: Full verification**

Run: `bun test && bunx tsc --noEmit && bun run lint`
Expected: full suite PASS + clean. (Confirms gate/doctor still behave with no global file present.)

- [ ] **Step 8: Commit**

```bash
git add src/config/global.ts tests/unit/global-config.test.ts src/cli/commands/gate.ts src/cli/commands/doctor.ts
git commit -m "feat(config): global->project->defaults precedence layer (gate+doctor use it)"
```

---

## Task 5: Build config from answers (Quick preset + Custom)

**Goal:** Pure functions mapping wizard answers to a config partial: `buildQuickPreset` (availability-gated) and `buildCustomConfig`. No TTY.

**Files:**
- Create: `src/cli/setup/build-config.ts`
- Test: `tests/unit/setup-build-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/setup-build-config.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";
import { buildCustomConfig, buildQuickPreset } from "../../src/cli/setup/build-config.ts";

describe("buildQuickPreset", () => {
  it("no OPENROUTER key => fpLedger on, brain OFF", () => {
    const cfg = defineConfig(buildQuickPreset({ openrouterKeyPresent: false }) as Parameters<typeof defineConfig>[0]);
    expect(cfg.phases.fpLedger).toEqual({ enabled: true });
    expect(cfg.phases.brain).toBeNull();
    expect(cfg.phases.review.reviewers).toEqual([{ provider: "codex", persona: "security" }]);
  });

  it("OPENROUTER key present => brain ON with codex fp-filter curator", () => {
    const cfg = defineConfig(buildQuickPreset({ openrouterKeyPresent: true }) as Parameters<typeof defineConfig>[0]);
    expect(cfg.phases.brain?.enabled).toBe(true);
    expect(cfg.phases.brain?.curator).toEqual({ provider: "codex", persona: "fp-filter" });
  });
});

describe("buildCustomConfig", () => {
  it("maps reviewers + critic + fpLedger toggles", () => {
    const partial = buildCustomConfig({
      reviewers: [
        { provider: "codex", persona: "security", model: "gpt-5.4" },
        { provider: "gemini", persona: "architecture", model: "gemini-3-flash-preview" },
      ],
      critic: { provider: "opencode", persona: "fp-filter" },
      brain: null,
      fpLedger: true,
      contextDocs: false,
    });
    const cfg = defineConfig(partial as Parameters<typeof defineConfig>[0]);
    expect(cfg.providers.gemini?.enabled).toBe(true);
    expect(cfg.phases.review.reviewers).toHaveLength(2);
    expect(cfg.phases.critic).toEqual({ provider: "opencode", persona: "fp-filter" });
    expect(cfg.phases.fpLedger).toEqual({ enabled: true });
    expect(cfg.phases.brain).toBeNull();
    expect(cfg.phases.contextDocs).toBeNull();
  });

  it("a per-reviewer model override lands in providers.<id>.model", () => {
    const partial = buildCustomConfig({
      reviewers: [{ provider: "codex", persona: "security", model: "gpt-5.4-codex" }],
      critic: null, brain: null, fpLedger: false, contextDocs: false,
    });
    const cfg = defineConfig(partial as Parameters<typeof defineConfig>[0]);
    expect(cfg.providers.codex.model).toBe("gpt-5.4-codex");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/unit/setup-build-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `build-config.ts`**

Create `src/cli/setup/build-config.ts`:

```ts
import type { DeepPartial, ReviewgateConfig } from "../../config/define-config.ts";
import type { ProviderId } from "../../providers/registry.ts";

export interface ReviewerAnswer {
  provider: ProviderId;
  persona: string;
  model: string;
}

export interface CustomAnswers {
  reviewers: ReviewerAnswer[];
  critic: { provider: ProviderId; persona: string } | null;
  brain: { curator: { provider: ProviderId; persona: string } } | null;
  fpLedger: boolean;
  contextDocs: boolean;
}

const DEFAULT_AUTH: Record<ProviderId, "oauth" | "openrouter"> = {
  codex: "oauth",
  gemini: "oauth",
  "claude-code": "oauth",
  opencode: "oauth",
  openrouter: "openrouter",
};

// Enables each used provider with its chosen model. apiKeyEnv is set for openrouter.
function providersFor(
  ids: { provider: ProviderId; model?: string }[],
): DeepPartial<ReviewgateConfig>["providers"] {
  const out: Record<string, unknown> = {};
  for (const { provider, model } of ids) {
    const entry: Record<string, unknown> = { enabled: true, auth: DEFAULT_AUTH[provider] };
    if (model) entry.model = model;
    if (provider === "openrouter") entry.apiKeyEnv = "OPENROUTER_API_KEY";
    out[provider] = { ...(out[provider] as object), ...entry };
  }
  return out as DeepPartial<ReviewgateConfig>["providers"];
}

export interface QuickInput {
  openrouterKeyPresent: boolean;
}

export function buildQuickPreset(input: QuickInput): DeepPartial<ReviewgateConfig> {
  const brain = input.openrouterKeyPresent
    ? {
        brain: {
          enabled: true,
          embeddings: {
            provider: "openrouter" as const,
            model: "baai/bge-base-en-v1.5",
            apiKeyEnv: "OPENROUTER_API_KEY",
          },
          curator: { provider: "codex" as const, persona: "fp-filter" },
        },
      }
    : {};
  return {
    providers: { codex: { enabled: true, auth: "oauth" } },
    phases: {
      review: { reviewers: [{ provider: "codex", persona: "security" }] },
      fpLedger: { enabled: true },
      ...brain,
    },
  } as DeepPartial<ReviewgateConfig>;
}

export function buildCustomConfig(a: CustomAnswers): DeepPartial<ReviewgateConfig> {
  const providerIds: { provider: ProviderId; model?: string }[] = a.reviewers.map((r) => ({
    provider: r.provider,
    model: r.model,
  }));
  if (a.critic) providerIds.push({ provider: a.critic.provider });
  if (a.brain) providerIds.push({ provider: a.brain.curator.provider });

  const phases: Record<string, unknown> = {
    review: { reviewers: a.reviewers.map((r) => ({ provider: r.provider, persona: r.persona })) },
    fpLedger: { enabled: a.fpLedger },
  };
  if (a.critic) phases.critic = { provider: a.critic.provider, persona: a.critic.persona };
  if (a.brain) {
    phases.brain = {
      enabled: true,
      embeddings: {
        provider: "openrouter",
        model: "baai/bge-base-en-v1.5",
        apiKeyEnv: "OPENROUTER_API_KEY",
      },
      curator: a.brain.curator,
    };
  }
  if (a.contextDocs) phases.contextDocs = { enabled: true };

  return {
    providers: providersFor(providerIds),
    phases: phases as DeepPartial<ReviewgateConfig>["phases"],
  } as DeepPartial<ReviewgateConfig>;
}
```

> Note: `fpLedger:{enabled:false}` in Custom maps to the schema's nullable field as
> `{enabled:false}` (kept by `diffFromDefaults` only if it differs from the default; the
> default is `null`, so `{enabled:false}` IS emitted — acceptable and explicit). If you
> prefer to OMIT a disabled fpLedger entirely, set it to `null` instead; the test above
> asserts `{enabled:false}` is acceptable via `defineConfig`, not the diff. Keep
> `{enabled: a.fpLedger}` for explicitness.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/setup-build-config.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/setup/build-config.ts tests/unit/setup-build-config.test.ts
git commit -m "feat(setup): pure answer->config builders (Quick preset + Custom)"
```

---

## Task 6: Live model probe

**Goal:** `probeModel(input, deps?)` fires a tiny `adapter.complete()` to verify a model works under the chosen auth; guards the optional `complete?`; never throws out.

**Files:**
- Create: `src/cli/setup/probe.ts`
- Test: `tests/unit/setup-probe.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/setup-probe.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { ProviderAdapter } from "../../src/providers/adapter-base.ts";
import { probeModel } from "../../src/cli/setup/probe.ts";

function fakeAdapter(impl?: ProviderAdapter["complete"]): ProviderAdapter {
  return {
    id: "codex",
    preflight: async () => ({ available: true, version: "x", authMode: "oauth", error: null }),
    review: async () => { throw new Error("unused"); },
    ...(impl ? { complete: impl } : {}),
  };
}

const base = { provider: "codex" as const, model: "gpt-5.4", auth: "oauth" as const, timeoutMs: 1000 };

describe("probeModel", () => {
  it("ok when complete returns non-empty text", async () => {
    const r = await probeModel(base, { adapter: fakeAdapter(async () => "OK") });
    expect(r.ok).toBe(true);
  });

  it("not ok (empty) when complete returns empty string", async () => {
    const r = await probeModel(base, { adapter: fakeAdapter(async () => "") });
    expect(r.ok).toBe(false);
  });

  it("not ok when complete throws (e.g. ModelNotFoundError)", async () => {
    const r = await probeModel(base, { adapter: fakeAdapter(async () => { throw new Error("ModelNotFoundError"); }) });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("ModelNotFoundError");
  });

  it("skipped when the adapter has no complete() method", async () => {
    const r = await probeModel(base, { adapter: fakeAdapter() });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.detail).toContain("no completion API");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/unit/setup-probe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `probe.ts`**

Create `src/cli/setup/probe.ts`:

```ts
import type { ProviderAdapter } from "../../providers/adapter-base.ts";
import { createAdapter } from "../../providers/registry.ts";
import type { ProviderId } from "../../providers/registry.ts";

export interface ProbeInput {
  provider: ProviderId;
  model: string;
  auth: "oauth" | "apikey" | "openrouter";
  apiKeyEnv?: string;
  timeoutMs?: number;
}

export interface ProbeResult {
  ok: boolean;
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
    if (text && text.trim().length > 0) return { ok: true, skipped: false, detail: "model responds" };
    return { ok: false, skipped: false, detail: "empty response" };
  } catch (e) {
    return { ok: false, skipped: false, detail: (e as Error).message.slice(0, 200) };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/setup-probe.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/setup/probe.ts tests/unit/setup-probe.test.ts
git commit -m "feat(setup): live model probe via adapter.complete (guards optional complete)"
```

---

## Task 7: The wizard flow, finalize, init tip, registration

**Goal:** Replace the Task-1 stub with the full clack flow; add a pure `finalizeSetup()` (validate → diff → serialize → backup → write OR print) and a pure `setupTip()`; wire the init tip. The clack interaction is the only non-unit-tested part.

**Files:**
- Modify: `src/cli/commands/setup.ts` (full implementation)
- Modify: `src/cli/commands/init.ts` (TTY tip)
- Modify: `src/cli/index.ts` (`--global`/`--print` flags)
- Test: `tests/unit/setup-finalize.test.ts`

- [ ] **Step 1: Write the failing test (finalize + tip — the pure parts)**

Create `tests/unit/setup-finalize.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";
import { buildQuickPreset } from "../../src/cli/setup/build-config.ts";
import { finalizeSetup, setupTip } from "../../src/cli/commands/setup.ts";

describe("setupTip", () => {
  it("returns the tip only in a TTY", () => {
    expect(setupTip(true)).toContain("reviewgate setup");
    expect(setupTip(false)).toBeNull();
  });
});

describe("finalizeSetup", () => {
  it("--print returns text and writes NOTHING", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-fin-"));
    const target = join(dir, "reviewgate.config.ts");
    const partial = buildQuickPreset({ openrouterKeyPresent: false });
    const r = finalizeSetup({ partial, targetPath: target, print: true });
    expect(r.text).toContain("export default {");
    expect(existsSync(target)).toBe(false);
    expect(r.wrotePath).toBeNull();
  });

  it("writes the file and backs up an existing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-fin-"));
    const target = join(dir, "reviewgate.config.ts");
    writeFileSync(target, "export default { /* old */ };");
    const partial = buildQuickPreset({ openrouterKeyPresent: false });
    const r = finalizeSetup({ partial, targetPath: target, print: false });
    expect(r.wrotePath).toBe(target);
    expect(existsSync(`${target}.bak`)).toBe(true);
    expect(readFileSync(`${target}.bak`, "utf8")).toContain("old");
    expect(readFileSync(target, "utf8")).toContain("export default {");
  });

  it("rejects an invalid partial (validation guard) without writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-fin-"));
    const target = join(dir, "reviewgate.config.ts");
    // reviewers must be a non-empty array; an empty one fails ConfigSchema.
    const bad = { phases: { review: { reviewers: [] } } } as Parameters<typeof defineConfig>[0];
    expect(() => finalizeSetup({ partial: bad, targetPath: target, print: false })).toThrow();
    expect(existsSync(target)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/unit/setup-finalize.test.ts`
Expected: FAIL — `finalizeSetup`/`setupTip` not exported.

- [ ] **Step 3: Implement `finalizeSetup` + `setupTip` + the full flow in `setup.ts`**

Replace `src/cli/commands/setup.ts` with:

```ts
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import type { DeepPartial, ReviewgateConfig } from "../../config/define-config.ts";
import { defineConfig } from "../../config/define-config.ts";
import { defaultConfig } from "../../config/defaults.ts";
import { diffFromDefaults } from "../../config/diff-defaults.ts";
import { loadEffectiveConfig, resolveGlobalConfigPath } from "../../config/global.ts";
import { serializeConfig } from "../../config/serialize.ts";
import { isProviderAvailable } from "../../providers/availability.ts";
import type { ProviderId } from "../../providers/registry.ts";
import { type CustomAnswers, buildCustomConfig, buildQuickPreset } from "../setup/build-config.ts";
import { probeModel } from "../setup/probe.ts";
import { runDoctor } from "./doctor.ts";

export function setupTip(isTty: boolean): string | null {
  return isTty
    ? "Tip: run `reviewgate setup` to configure reviewers, brain & critic interactively."
    : null;
}

export interface FinalizeInput {
  partial: DeepPartial<ReviewgateConfig>;
  targetPath: string;
  print: boolean;
}
export interface FinalizeResult {
  text: string;
  wrotePath: string | null;
}

// Validate (defineConfig) -> minimal diff -> serialize -> (print | backup+write).
// Throws on validation failure BEFORE any write (never leaves a broken file).
export function finalizeSetup(input: FinalizeInput): FinalizeResult {
  const validated = defineConfig(input.partial as Parameters<typeof defineConfig>[0]);
  const minimal = diffFromDefaults(validated);
  const text = serializeConfig(minimal as Record<string, unknown>);
  if (input.print) return { text, wrotePath: null };
  if (existsSync(input.targetPath)) {
    copyFileSync(input.targetPath, `${input.targetPath}.bak`);
  } else {
    mkdirSync(dirname(input.targetPath), { recursive: true });
  }
  writeFileSync(input.targetPath, text);
  return { text, wrotePath: input.targetPath };
}

export interface SetupInput {
  repoRoot: string;
  global?: boolean;
  print?: boolean;
  env?: Record<string, string | undefined>;
  home?: string;
}

const PERSONAS = ["security", "architecture", "adversarial"] as const;
const REVIEWER_PROVIDERS: ProviderId[] = ["codex", "gemini", "claude-code", "openrouter", "opencode"];
const MODEL_DEFAULT: Record<ProviderId, string> = {
  codex: defaultConfig.providers.codex.model,
  gemini: defaultConfig.providers.gemini.model,
  "claude-code": defaultConfig.providers["claude-code"].model,
  openrouter: defaultConfig.providers.openrouter.model,
  opencode: defaultConfig.providers.opencode.model,
};

function authFor(p: ProviderId): "oauth" | "openrouter" {
  return p === "openrouter" ? "openrouter" : "oauth";
}

export async function runSetup(input: SetupInput): Promise<number> {
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const home = input.home ?? homedir();
  const orKey = Boolean(env.OPENROUTER_API_KEY);
  intro("reviewgate setup");

  // 1. Target
  const globalPath = resolveGlobalConfigPath(env, home);
  let targetPath = join(input.repoRoot, "reviewgate.config.ts");
  if (input.global) {
    if (!globalPath) {
      cancel("no resolvable global config dir — set XDG_CONFIG_HOME or HOME");
      return 1;
    }
    targetPath = globalPath;
  } else {
    const target = await select({
      message: "Where should this config be saved?",
      options: [
        { value: "project", label: `This project (${targetPath})` },
        ...(globalPath ? [{ value: "global", label: `My global default (${globalPath})` }] : []),
      ],
    });
    if (isCancel(target)) return cancelOut();
    if (target === "global" && globalPath) targetPath = globalPath;
  }

  // 2. Mode
  const mode = await select({
    message: "Setup mode",
    options: [
      { value: "quick", label: "Quick (recommended preset)" },
      { value: "custom", label: "Custom (configure everything)" },
    ],
  });
  if (isCancel(mode)) return cancelOut();

  let partial: DeepPartial<ReviewgateConfig>;
  if (mode === "quick") {
    if (!orKey) {
      note("brain needs OPENROUTER_API_KEY — leaving it off (set the key and re-run setup).");
    }
    partial = buildQuickPreset({ openrouterKeyPresent: orKey });
  } else {
    const custom = await runCustom(env, orKey);
    if (!custom) return cancelOut();
    partial = custom;
  }

  // 3. Finalize
  const result = finalizeSetup({ partial, targetPath, print: Boolean(input.print) });
  if (input.print) {
    process.stdout.write(`${result.text}\n`);
    outro("(--print) nothing written");
    return 0;
  }

  // 4. Doctor — let it print its own lines directly (no spinner wrap, to avoid
  // interleaving with doctor's stdout); then summarize.
  note(`wrote ${result.wrotePath}`);
  const code = await runDoctor({ repoRoot: input.repoRoot });
  outro(
    code === 0
      ? "setup complete — doctor: all green"
      : code === 1
        ? "setup complete — doctor reported warnings (see above)"
        : "setup complete — doctor reported failures (see above)",
  );
  return 0;
}

function cancelOut(): number {
  cancel("setup cancelled, no changes written");
  return 1;
}

// The Custom walk. Returns null on cancel.
async function runCustom(
  env: Record<string, string | undefined>,
  orKey: boolean,
): Promise<DeepPartial<ReviewgateConfig> | null> {
  const avail = (p: ProviderId) =>
    isProviderAvailable(p, p === "openrouter" ? "OPENROUTER_API_KEY" : undefined, { env });

  const picked = await multiselect({
    message: "Reviewers (space to toggle)",
    options: REVIEWER_PROVIDERS.map((p) => ({
      value: p,
      label: p,
      hint: avail(p) ? undefined : p === "openrouter" ? "no API key" : "CLI not found",
    })),
    initialValues: ["codex"] as ProviderId[],
    required: true,
  });
  if (isCancel(picked)) return null;

  const reviewers: CustomAnswers["reviewers"] = [];
  for (const p of picked as ProviderId[]) {
    const persona = await select({
      message: `${p}: persona`,
      options: PERSONAS.map((x) => ({ value: x, label: x })),
    });
    if (isCancel(persona)) return null;
    const model = await text({ message: `${p}: model`, initialValue: MODEL_DEFAULT[p] });
    if (isCancel(model)) return null;
    // best-effort probe
    const verified = await maybeProbe(p, String(model), authFor(p));
    if (verified === "cancel") return null;
    reviewers.push({ provider: p, persona: String(persona), model: String(model) });
  }

  const wantCritic = await confirm({ message: "Enable the critic (demote-only FP pass)?", initialValue: false });
  if (isCancel(wantCritic)) return null;
  let critic: CustomAnswers["critic"] = null;
  if (wantCritic) {
    const cp = await select({
      message: "Critic provider",
      options: REVIEWER_PROVIDERS.map((p) => ({ value: p, label: p })),
    });
    if (isCancel(cp)) return null;
    critic = { provider: cp as ProviderId, persona: "fp-filter" };
  }

  const wantBrain = await confirm({ message: "Enable the brain (repo memory + curator)?", initialValue: orKey });
  if (isCancel(wantBrain)) return null;
  let brain: CustomAnswers["brain"] = null;
  if (wantBrain) {
    if (!orKey) note("brain needs OPENROUTER_API_KEY — config will be written but memory stays inert until you set it.");
    const cur = await select({
      message: "Curator (LLM judge — a non-reviewer like opencode is more independent)",
      options: REVIEWER_PROVIDERS.map((p) => ({ value: p, label: p })),
      initialValue: "codex" as ProviderId,
    });
    if (isCancel(cur)) return null;
    brain = { curator: { provider: cur as ProviderId, persona: "fp-filter" } };
  }

  const fp = await confirm({ message: "Enable the FP-ledger (learn rejected false positives)?", initialValue: true });
  if (isCancel(fp)) return null;

  const ctx = await confirm({ message: "Enable contextDocs (inject current library docs)?", initialValue: false });
  if (isCancel(ctx)) return null;
  if (ctx) note("contextDocs works keyless; set CONTEXT7_API_KEY for higher rate limits.");

  return buildCustomConfig({ reviewers, critic, brain, fpLedger: Boolean(fp), contextDocs: Boolean(ctx) });
}

// Returns "ok" | "kept" | "cancel". Loops on a failed probe (re-enter/keep/skip).
async function maybeProbe(
  provider: ProviderId,
  model: string,
  auth: "oauth" | "openrouter",
): Promise<"ok" | "kept" | "cancel"> {
  const verify = await confirm({ message: `Verify ${provider}/${model} with a test call?`, initialValue: true });
  if (isCancel(verify)) return "cancel";
  if (!verify) return "kept";
  const s = spinner();
  s.start(`probing ${provider}/${model} (${auth})…`);
  const r = await probeModel({ provider, model, auth, ...(provider === "openrouter" ? { apiKeyEnv: "OPENROUTER_API_KEY" } : {}) });
  s.stop(r.ok ? "✓ model responds" : r.skipped ? `⚠ ${r.detail}` : `✗ ${r.detail}`);
  return "ok";
}
```

> Note on `maybeProbe`: the spec calls for re-enter/keep on failure. This implementation
> reports the probe result inline and continues (keep) — a deliberate simplification to
> avoid a model-re-entry sub-loop in the first cut; the user sees the ✗ and can edit the
> written file or re-run. If a re-entry loop is desired, wrap the model `text()` + probe
> in a `while` and break on ok/keep. (Flagged for the plan review.)

- [ ] **Step 4: Add the TTY tip (in `index.ts`, keeping `runInit` script-safe)**

The tip is printed by the CLI wrapper, NOT inside `runInit` (so `runInit` stays
side-effect-clean for scripting). In `src/cli/index.ts`'s `init` command `run`, after
`process.stdout.write("Reviewgate installed.\n")` add:

```ts
import { setupTip } from "./commands/setup.ts";
// ...
    const tip = setupTip(Boolean(process.stdout.isTTY));
    if (tip) process.stdout.write(`${tip}\n`);
```

- [ ] **Step 5: Wire `--global` / `--print` flags in `index.ts`**

Replace the `setup` command in `src/cli/index.ts` with:

```ts
const setup = defineCommand({
  meta: { name: "setup", description: "Interactive configuration wizard" },
  args: { global: { type: "boolean" }, print: { type: "boolean" } },
  async run({ args }) {
    process.exit(
      await runSetup({
        repoRoot: process.cwd(),
        global: args.global === true,
        print: args.print === true,
      }),
    );
  },
});
```

- [ ] **Step 6: Run the unit tests + static checks**

Run: `bun test tests/unit/setup-finalize.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS + clean.

- [ ] **Step 7: Full suite**

Run: `bun test`
Expected: full suite PASS (no regressions in init/doctor/gate).

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/setup.ts src/cli/index.ts tests/unit/setup-finalize.test.ts
git commit -m "feat(setup): full clack wizard flow, finalize+backup, init TTY tip, --global/--print"
```

---

## Task 8: Compiled-binary end-to-end verification

**Goal:** Confirm the whole feature works in the standalone binary (the only place the clack TTY layer + bundling are exercised together) — per the M3 wasm lesson, `bun test` is not enough.

**Files:** none (verification only).

- [ ] **Step 1: Build**

Run: `bun run build`
Expected: `dist/reviewgate` rebuilt, no errors.

- [ ] **Step 2: `--print` from the binary (non-interactive smoke)**

Run: `dist/reviewgate setup --print < /dev/null`
Expected: either the cancelled message (clack EOF on the target/mode prompt) OR, if you pipe answers, a printed `export default {}`. The key assertion: **no module/runtime crash**. (Interactive prompts need a TTY; do the real interactive runs below in your terminal.)

- [ ] **Step 3: Interactive Quick path in a scratch repo (manual, in a real terminal)**

```bash
tmp=$(mktemp -d); cd "$tmp"; git init -q
/full/path/to/dist/reviewgate setup
# choose: This project -> Quick
```
Expected: writes `reviewgate.config.ts` (a plain `export default {}`); the closing doctor summary prints; if `OPENROUTER_API_KEY` is set, brain is enabled, else the "brain needs OPENROUTER_API_KEY" note appears. Verify: `cat reviewgate.config.ts` is a plain object (no `defineConfig` import) and `dist/reviewgate doctor` is green/warn (not fail).

- [ ] **Step 4: Interactive Custom path with a bad model (manual)**

Re-run `setup` → Custom → add a reviewer → enter a deliberately bad model (e.g. `does-not-exist`) → keep "Verify? yes".
Expected: the spinner shows `✗ <reason>` (e.g. ModelNotFoundError) — proving the live probe works against a real CLI.

- [ ] **Step 5: `--global` path (manual)**

Run: `dist/reviewgate setup --global` (choose Quick).
Expected: writes to `${XDG_CONFIG_HOME:-$HOME/.config}/reviewgate/reviewgate.config.ts`. Then in an UNRELATED repo with no local config, run a gate cycle (or `dist/reviewgate doctor`) and confirm the global config is picked up (e.g. `reviewgate.config.ts present` is "missing (defaults will apply)" yet the brain/fpLedger settings from global are in effect — confirm via behavior or a temporary debug print).

- [ ] **Step 6: Update the handoff doc**

Update `NEXT_SESSION.md`: mark the setup wizard shipped, note any deviations (e.g. the `maybeProbe` keep-only behavior), and record the compiled-binary verification results.

- [ ] **Step 7: Final static checks + commit**

```bash
bunx tsc --noEmit && bun run lint && bun test
git add NEXT_SESSION.md
git commit -m "docs(setup): handoff — setup wizard shipped + compiled-binary e2e verified"
```

> **Definition of Done (per CLAUDE.md):** after Task 8, run the full review pipeline —
> static checks (Step 7) → Codex review ×2 (or the OpenCode fallback while codex is
> ratelimited) → Claude review ×2 — fix every finding, re-run all reviewers until clean,
> `rm -rf .review/`, then **ask before pushing**.

---

## Self-Review (filled by plan author)

**Spec coverage:** Command surface (Task 1/7), two-track flow (Task 7), Quick preset gating (Task 5), live probe (Task 6), minimal-diff+backup output (Task 3/7), global precedence + gate/doctor error-fallback (Task 4), availability extraction (Task 2), env/secrets handling (Task 7 notes), doctor-at-end (Task 7), compiled-binary verification (Task 1 + Task 8). All §-sections map to a task.

**Known deviations to confirm in plan review:**
1. `maybeProbe` reports the probe result and continues (no re-enter sub-loop) — spec §6 allows re-enter/keep/skip; this ships keep-only first. Acceptable?
2. Custom `fpLedger:false` emits `{enabled:false}` rather than omitting — explicit and round-trips; acceptable per Task 5 note.
3. The interactive flow (Task 7 Steps 3-5 of Task 8) is verified manually in a real terminal — clack needs a TTY and cannot be asserted in `bun test`.
