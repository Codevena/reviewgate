# CLI-Adapter `complete()` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the optional `ProviderAdapter.complete()` method on the four CLI-backed adapters (claude, gemini, codex, opencode) so the brain Curator and FP↔Brain Contradiction judges work for CLI providers, not only OpenRouter.

**Architecture:** Each CLI adapter gets a self-contained `complete()` that spawns its CLI **without** any review output-schema and returns the raw model text; the existing `review()` path is untouched. A new dedicated `CompleteOptions` type carries `model` + optional `apiKeyEnv`/`timeoutMs`/`auth` (so the embed-only `EmbedOptions` is not weakened). The two judge call-sites pass `auth: pcfg.auth` and the provider's real (possibly absent) `apiKeyEnv`; the `?? "OPENROUTER_API_KEY"` fallback moves into `OpenRouterAdapter.complete()`.

**Tech Stack:** Bun + TypeScript (strict, `exactOptionalPropertyTypes: true`), Zod, `bun test`, Biome. CLI spawns via `src/utils/spawn.ts` `spawnSafely`. Tests use fake `.sh` fixtures + the `binPath` constructor option.

**Spec:** `docs/superpowers/specs/2026-05-22-reviewgate-cli-complete-design.md` (Codex-reviewed, 5 rounds → PASS).

**Commands:** `bun test` · `bun test tests/unit/<file>` · `tsc --noEmit` (typecheck) · `biome check src tests` (lint) · `bun run build` (compiled binary).

---

## File Structure

- `src/providers/adapter-base.ts` (modify) — add `CompleteOptions` interface; change `complete?()` to use it.
- `src/providers/openrouter.ts` (modify) — `complete()` switches param type to `CompleteOptions`, defaults missing `apiKeyEnv` to `"OPENROUTER_API_KEY"` internally.
- `src/cassette/recording-adapter.ts` (modify) — widen the local `CompleteFn` type to `CompleteOptions` (type-only).
- `src/providers/claude.ts` (modify) — add `complete()` + a `COMPLETE_TIMEOUT_MS` const.
- `src/providers/gemini.ts` (modify) — add `complete()` + a `COMPLETE_TIMEOUT_MS` const.
- `src/providers/codex.ts` (modify) — add `complete()` (NO `--output-schema`) + a `COMPLETE_TIMEOUT_MS` const.
- `src/providers/opencode.ts` (modify) — add `complete()` + a `COMPLETE_TIMEOUT_MS` const.
- `src/core/orchestrator.ts` (modify) — two judge call-sites (~789 contradiction, ~915 curator) pass `auth` + raw `apiKeyEnv` via conditional spread.
- `tests/fixtures/fake-claude-complete.sh`, `fake-gemini-complete.sh`, `fake-codex-complete.sh`, `fake-opencode-complete.sh` (create) — judge-output fakes with env toggles.
- `tests/unit/{claude,gemini,codex,opencode}-adapter.test.ts` (modify) — per-adapter `complete()` tests.
- `tests/unit/openrouter-adapter.test.ts` (modify) — fallback-relocation regression test.
- `tests/integration/cli-judge-complete.test.ts` (create) — judge fires through an in-memory adapter with `complete()`.

---

## Task 1: `CompleteOptions` type + OpenRouter fallback relocation + cassette type widen

**Files:**
- Modify: `src/providers/adapter-base.ts:57-72`
- Modify: `src/providers/openrouter.ts:208-237` (and the `EmbedOptions` import usage)
- Modify: `src/cassette/recording-adapter.ts:16-20`
- Test: `tests/unit/openrouter-adapter.test.ts`

- [ ] **Step 1: Write the failing regression test**

Add to `tests/unit/openrouter-adapter.test.ts` inside the existing `describe("OpenRouterAdapter.complete (raw judge completion)", ...)` block (after the existing two `it(...)` cases, before the closing `});` of that describe):

```typescript
  it("defaults a missing apiKeyEnv to OPENROUTER_API_KEY (fallback relocated from call-site)", async () => {
    process.env.OPENROUTER_API_KEY = "default-key";
    let authHeader = "";
    const fetchImpl = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      authHeader = init.headers.Authorization;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"accept":true}' } }], usage: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const adapter = new OpenRouterAdapter({ fetchImpl });
    // apiKeyEnv intentionally OMITTED — must fall back to OPENROUTER_API_KEY.
    const text = await adapter.complete("judge this", { model: "m" });
    expect(text).toBe('{"accept":true}');
    expect(authHeader).toBe("Bearer default-key");
    delete process.env.OPENROUTER_API_KEY;
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/openrouter-adapter.test.ts`
Expected: FAIL — the call `adapter.complete("judge this", { model: "m" })` is a type error (current `complete` requires `apiKeyEnv: string`) and/or throws "API key env 'undefined' is not set".

- [ ] **Step 3: Add the `CompleteOptions` interface to `adapter-base.ts`**

In `src/providers/adapter-base.ts`, add this interface immediately before the `ProviderAdapter` interface (around line 56):

```typescript
/**
 * Options for the free-form judge completion. Distinct from EmbedOptions:
 * `apiKeyEnv` is OPTIONAL (CLI providers in oauth mode have none) and `auth`
 * selects per-provider auth handling. OpenRouter ignores `auth` and defaults a
 * missing `apiKeyEnv` to "OPENROUTER_API_KEY"; CLI adapters use `auth` to decide
 * key remapping and treat a missing `apiKeyEnv` as "use the CLI's own credentials".
 */
export interface CompleteOptions {
  model: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  auth?: "oauth" | "apikey" | "openrouter";
}
```

Then change the `complete?()` signature in the `ProviderAdapter` interface (currently lines 68-71) to:

```typescript
  complete?(prompt: string, opts: CompleteOptions): Promise<string>;
```

(Keep the existing doc-comment above it.)

- [ ] **Step 4: Relocate the fallback into `OpenRouterAdapter.complete()`**

In `src/providers/openrouter.ts`:

First, add `CompleteOptions` to the type import from adapter-base. Find the existing `import type { ... } from "./adapter-base.ts";` and add `CompleteOptions` to it (if openrouter imports adapter-base types; if not, add a new line):

```typescript
import type { CompleteOptions } from "./adapter-base.ts";
```

Then change the `complete` method signature + key resolution (lines 208-212) from:

```typescript
  async complete(prompt: string, opts: EmbedOptions): Promise<string> {
    const key = opts.apiKeyEnv ? process.env[opts.apiKeyEnv] : undefined;
    if (!key) {
      throw new Error(`OpenRouter complete: API key env '${opts.apiKeyEnv}' is not set`);
    }
```

to:

```typescript
  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const apiKeyEnv = opts.apiKeyEnv ?? "OPENROUTER_API_KEY";
    const key = process.env[apiKeyEnv];
    if (!key) {
      throw new Error(`OpenRouter complete: API key env '${apiKeyEnv}' is not set`);
    }
```

Leave the rest of the method body unchanged. (`embed()` keeps using `EmbedOptions`.)

- [ ] **Step 5: Widen the cassette `CompleteFn` type**

In `src/cassette/recording-adapter.ts`, add `CompleteOptions` to the adapter-base type import, then change the local `CompleteFn` (lines 17-20) from:

```typescript
type CompleteFn = (
  prompt: string,
  opts: { model: string; apiKeyEnv: string; timeoutMs?: number },
) => Promise<string>;
```

to:

```typescript
type CompleteFn = (prompt: string, opts: CompleteOptions) => Promise<string>;
```

- [ ] **Step 6: Run the regression test + typecheck**

Run: `bun test tests/unit/openrouter-adapter.test.ts`
Expected: PASS (all cases, including the new fallback test).

Run: `tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/providers/adapter-base.ts src/providers/openrouter.ts src/cassette/recording-adapter.ts tests/unit/openrouter-adapter.test.ts
git commit -m "feat(providers): add CompleteOptions type; relocate OpenRouter apiKeyEnv fallback"
```

---

## Task 2: `claude.complete()`

**Files:**
- Create: `tests/fixtures/fake-claude-complete.sh`
- Modify: `src/providers/claude.ts`
- Test: `tests/unit/claude-adapter.test.ts`

- [ ] **Step 1: Create the fake CLI fixture**

Create `tests/fixtures/fake-claude-complete.sh`:

```bash
#!/usr/bin/env bash
# Fake `claude -p --output-format json` for complete(): emits the result
# envelope with a JUDGE-shaped JSON inside `result`, echoing the (possibly
# remapped) ANTHROPIC_API_KEY so the auth test can read what arrived.
# Toggles: RG_FAKE_FAIL=1 -> non-zero exit; RG_FAKE_EMPTY=1 -> envelope w/o result.
set -u
[ "${RG_FAKE_FAIL:-}" = "1" ] && { echo "boom" >&2; exit 7; }
if [ "${RG_FAKE_EMPTY:-}" = "1" ]; then
  printf '%s\n' '{"type":"result","subtype":"success","total_cost_usd":0}'
  exit 0
fi
printf '{"type":"result","subtype":"success","result":"{\\"contradicts\\":false,\\"reason\\":\\"k=%s\\"}","total_cost_usd":0}\n' "${ANTHROPIC_API_KEY:-NONE}"
exit 0
```

Make it executable:

```bash
chmod +x tests/fixtures/fake-claude-complete.sh
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/unit/claude-adapter.test.ts` a new describe block (after the existing one):

```typescript
const FAKE_COMPLETE = join(process.cwd(), "tests/fixtures/fake-claude-complete.sh");

describe("ClaudeAdapter.complete (judge completion)", () => {
  it("returns the raw model text containing the judge JSON", async () => {
    const adapter = new ClaudeAdapter({ binPath: FAKE_COMPLETE });
    const text = await adapter.complete("judge this", { model: "claude-sonnet-4-6", auth: "oauth" });
    expect(text).toContain('"contradicts":false');
  });

  it("remaps apiKeyEnv -> ANTHROPIC_API_KEY only under auth=apikey", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.RG_TEST_CL_KEY = "sentinel-cl";
    const adapter = new ClaudeAdapter({ binPath: FAKE_COMPLETE });
    const apikey = await adapter.complete("p", { model: "m", apiKeyEnv: "RG_TEST_CL_KEY", auth: "apikey" });
    expect(apikey).toContain("k=sentinel-cl");
    const oauth = await adapter.complete("p", { model: "m", apiKeyEnv: "RG_TEST_CL_KEY", auth: "oauth" });
    expect(oauth).toContain("k=NONE");
    delete process.env.RG_TEST_CL_KEY;
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  });

  it("throws on non-zero exit (caller falls back to default)", async () => {
    process.env.RG_FAKE_FAIL = "1";
    const adapter = new ClaudeAdapter({ binPath: FAKE_COMPLETE });
    await expect(adapter.complete("p", { model: "m", auth: "oauth" })).rejects.toThrow();
    delete process.env.RG_FAKE_FAIL;
  });

  it("returns '' on a result-less envelope (no throw)", async () => {
    process.env.RG_FAKE_EMPTY = "1";
    const adapter = new ClaudeAdapter({ binPath: FAKE_COMPLETE });
    const text = await adapter.complete("p", { model: "m", auth: "oauth" });
    expect(text).toBe("");
    delete process.env.RG_FAKE_EMPTY;
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/unit/claude-adapter.test.ts`
Expected: FAIL — `adapter.complete is not a function`.

- [ ] **Step 4: Implement `complete()` in `claude.ts`**

Add the `CompleteOptions` type to the adapter-base import in `src/providers/claude.ts`. Add a module-level constant near the top (after `const DISALLOWED = ...`):

```typescript
const COMPLETE_TIMEOUT_MS = 20_000;
```

Then add this method to the `ClaudeAdapter` class (after `review()`, before the closing brace):

```typescript
  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const run = mkdtempSync(join(tmpdir(), "rg-cl-cmpl-"));
    const outFile = join(run, "out.json");
    const errFile = join(run, "err.log");
    const args = [
      "-p",
      prompt,
      "--model",
      opts.model,
      "--output-format",
      "json",
      "--disallowedTools",
      DISALLOWED,
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
    ];
    const env = { ...process.env } as Record<string, string>;
    if (opts.auth === "apikey" && opts.apiKeyEnv) {
      const key = process.env[opts.apiKeyEnv];
      if (key) env.ANTHROPIC_API_KEY = key;
    }
    const res = await spawnSafely({
      command: this.binPath,
      args,
      env,
      cwd: run,
      stdoutFile: outFile,
      stderrFile: errFile,
      timeoutMs: opts.timeoutMs ?? COMPLETE_TIMEOUT_MS,
    });
    if (res.killedByTimeout || res.killedByWatchdog || res.exitCode !== 0) {
      let detail = "";
      try {
        detail = readFileSync(errFile, "utf8").slice(0, 500);
      } catch {
        detail = "";
      }
      throw new Error(`claude complete exit=${res.exitCode}: ${detail}`);
    }
    let fileText = "";
    try {
      fileText = readFileSync(outFile, "utf8");
    } catch {
      return "";
    }
    try {
      const envelope = JSON.parse(fileText) as ClaudeEnvelope;
      return envelope.result ?? "";
    } catch {
      return fileText;
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/claude-adapter.test.ts`
Expected: PASS (all complete cases + the existing review case).

Run: `tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/providers/claude.ts tests/unit/claude-adapter.test.ts tests/fixtures/fake-claude-complete.sh
git commit -m "feat(providers): implement complete() on ClaudeAdapter"
```

---

## Task 3: `gemini.complete()`

**Files:**
- Create: `tests/fixtures/fake-gemini-complete.sh`
- Modify: `src/providers/gemini.ts`
- Test: `tests/unit/gemini-adapter.test.ts`

- [ ] **Step 1: Create the fake CLI fixture**

Create `tests/fixtures/fake-gemini-complete.sh`:

```bash
#!/usr/bin/env bash
# Fake `gemini -p -o json` for complete(): emits the outer envelope with a
# JUDGE-shaped JSON inside `response`, echoing the (possibly remapped)
# GEMINI_API_KEY. Toggles: RG_FAKE_FAIL=1 -> non-zero exit; RG_FAKE_EMPTY=1 ->
# envelope w/o response.
set -u
[ "${RG_FAKE_FAIL:-}" = "1" ] && { echo "boom" >&2; exit 7; }
if [ "${RG_FAKE_EMPTY:-}" = "1" ]; then
  printf '%s\n' '{"session_id":"fake"}'
  exit 0
fi
printf '{"session_id":"fake","response":"{\\"contradicts\\":false,\\"reason\\":\\"k=%s\\"}"}\n' "${GEMINI_API_KEY:-NONE}"
exit 0
```

```bash
chmod +x tests/fixtures/fake-gemini-complete.sh
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/unit/gemini-adapter.test.ts` a new describe block:

```typescript
const FAKE_COMPLETE = join(process.cwd(), "tests/fixtures/fake-gemini-complete.sh");

describe("GeminiAdapter.complete (judge completion)", () => {
  it("returns the raw model text containing the judge JSON", async () => {
    const adapter = new GeminiAdapter({ binPath: FAKE_COMPLETE });
    const text = await adapter.complete("judge this", { model: "gemini-3-pro", auth: "oauth" });
    expect(text).toContain('"contradicts":false');
  });

  it("remaps apiKeyEnv -> GEMINI_API_KEY only under auth=apikey", async () => {
    const prev = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.RG_TEST_GEM_KEY = "sentinel-gem";
    const adapter = new GeminiAdapter({ binPath: FAKE_COMPLETE });
    const apikey = await adapter.complete("p", { model: "m", apiKeyEnv: "RG_TEST_GEM_KEY", auth: "apikey" });
    expect(apikey).toContain("k=sentinel-gem");
    const oauth = await adapter.complete("p", { model: "m", apiKeyEnv: "RG_TEST_GEM_KEY", auth: "oauth" });
    expect(oauth).toContain("k=NONE");
    delete process.env.RG_TEST_GEM_KEY;
    if (prev !== undefined) process.env.GEMINI_API_KEY = prev;
  });

  it("throws on non-zero exit", async () => {
    process.env.RG_FAKE_FAIL = "1";
    const adapter = new GeminiAdapter({ binPath: FAKE_COMPLETE });
    await expect(adapter.complete("p", { model: "m", auth: "oauth" })).rejects.toThrow();
    delete process.env.RG_FAKE_FAIL;
  });

  it("returns '' on a response-less envelope (no throw)", async () => {
    process.env.RG_FAKE_EMPTY = "1";
    const adapter = new GeminiAdapter({ binPath: FAKE_COMPLETE });
    const text = await adapter.complete("p", { model: "m", auth: "oauth" });
    expect(text).toBe("");
    delete process.env.RG_FAKE_EMPTY;
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/unit/gemini-adapter.test.ts`
Expected: FAIL — `adapter.complete is not a function`.

- [ ] **Step 4: Implement `complete()` in `gemini.ts`**

Add `CompleteOptions` to the adapter-base import in `src/providers/gemini.ts`. Add the constant near the top:

```typescript
const COMPLETE_TIMEOUT_MS = 20_000;
```

Add this method to `GeminiAdapter` (after `review()`):

```typescript
  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const run = mkdtempSync(join(tmpdir(), "rg-gem-cmpl-"));
    const outFile = join(run, "out.json");
    const errFile = join(run, "err.log");
    const args = ["-p", prompt, "-m", opts.model, "-o", "json", "--approval-mode", "plan"];
    const env = { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" } as Record<string, string>;
    if (opts.auth === "apikey" && opts.apiKeyEnv) {
      const key = process.env[opts.apiKeyEnv];
      if (key) env.GEMINI_API_KEY = key;
    }
    const res = await spawnSafely({
      command: this.binPath,
      args,
      env,
      cwd: run,
      stdoutFile: outFile,
      stderrFile: errFile,
      timeoutMs: opts.timeoutMs ?? COMPLETE_TIMEOUT_MS,
    });
    if (res.killedByTimeout || res.killedByWatchdog || res.exitCode !== 0) {
      let detail = "";
      try {
        detail = readFileSync(errFile, "utf8").slice(0, 500);
      } catch {
        detail = "";
      }
      throw new Error(`gemini complete exit=${res.exitCode}: ${detail}`);
    }
    try {
      const envelope = JSON.parse(readFileSync(outFile, "utf8")) as GeminiEnvelope;
      return envelope.response ?? "";
    } catch {
      return "";
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/gemini-adapter.test.ts`
Expected: PASS.

Run: `tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/providers/gemini.ts tests/unit/gemini-adapter.test.ts tests/fixtures/fake-gemini-complete.sh
git commit -m "feat(providers): implement complete() on GeminiAdapter"
```

---

## Task 4: `codex.complete()` (NO `--output-schema`)

**Files:**
- Create: `tests/fixtures/fake-codex-complete.sh`
- Modify: `src/providers/codex.ts`
- Test: `tests/unit/codex-adapter.test.ts`

- [ ] **Step 1: Create the fake CLI fixture**

Create `tests/fixtures/fake-codex-complete.sh`. It **fails if `--output-schema` is present** (proving complete() drops it) and writes the judge JSON (echoing `OPENAI_API_KEY`) to the `--output-last-message` file:

```bash
#!/usr/bin/env bash
# Fake `codex exec` for complete(): MUST NOT receive --output-schema (a judge
# needs free-form). Writes a JUDGE-shaped JSON (echoing OPENAI_API_KEY) to the
# --output-last-message file. Toggles: RG_FAKE_FAIL=1 -> exit 7;
# RG_FAKE_EMPTY=1 -> empty last-message file.
set -u
LAST_MSG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output-schema) echo "schema flag must not reach complete()" >&2; exit 3 ;;
    --output-last-message) LAST_MSG="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ "${RG_FAKE_FAIL:-}" = "1" ] && { echo "boom" >&2; exit 7; }
if [ -n "$LAST_MSG" ]; then
  if [ "${RG_FAKE_EMPTY:-}" = "1" ]; then
    : > "$LAST_MSG"
  else
    printf '{"contradicts":false,"reason":"k=%s"}\n' "${OPENAI_API_KEY:-NONE}" > "$LAST_MSG"
  fi
fi
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
exit 0
```

```bash
chmod +x tests/fixtures/fake-codex-complete.sh
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/unit/codex-adapter.test.ts` a new describe block. Note codex tests already reference a fake bin constant (`PRETEND_CODEX_BIN`); define a fresh one for the complete fixture:

```typescript
const FAKE_CODEX_COMPLETE = join(process.cwd(), "tests/fixtures/fake-codex-complete.sh");

describe("CodexAdapter.complete (judge completion)", () => {
  it("returns the last-message text and passes NO --output-schema", async () => {
    // If complete() wrongly passed --output-schema, the fake exits 3 -> throw.
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX_COMPLETE });
    const text = await adapter.complete("judge this", { model: "gpt-x", auth: "oauth" });
    expect(text).toContain('"contradicts":false');
  });

  it("remaps apiKeyEnv -> OPENAI_API_KEY only under auth=apikey", async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.RG_TEST_CDX_KEY = "sentinel-cdx";
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX_COMPLETE });
    const apikey = await adapter.complete("p", { model: "m", apiKeyEnv: "RG_TEST_CDX_KEY", auth: "apikey" });
    expect(apikey).toContain("k=sentinel-cdx");
    const oauth = await adapter.complete("p", { model: "m", apiKeyEnv: "RG_TEST_CDX_KEY", auth: "oauth" });
    expect(oauth).toContain("k=NONE");
    delete process.env.RG_TEST_CDX_KEY;
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  });

  it("throws on non-zero exit", async () => {
    process.env.RG_FAKE_FAIL = "1";
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX_COMPLETE });
    await expect(adapter.complete("p", { model: "m", auth: "oauth" })).rejects.toThrow();
    delete process.env.RG_FAKE_FAIL;
  });

  it("returns '' on an empty last-message file (no throw)", async () => {
    process.env.RG_FAKE_EMPTY = "1";
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX_COMPLETE });
    const text = await adapter.complete("p", { model: "m", auth: "oauth" });
    expect(text).toBe("");
    delete process.env.RG_FAKE_EMPTY;
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/unit/codex-adapter.test.ts`
Expected: FAIL — `adapter.complete is not a function`.

- [ ] **Step 4: Implement `complete()` in `codex.ts`**

Add `CompleteOptions` to the adapter-base import in `src/providers/codex.ts`. Add the constant near the top:

```typescript
const COMPLETE_TIMEOUT_MS = 20_000;
```

Add this method to `CodexAdapter` (after `review()`). It deliberately omits `--output-schema` and uses the temp dir as `--cd`:

```typescript
  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const run = mkdtempSync(join(tmpdir(), "rg-codex-cmpl-"));
    const lastMsgFile = join(run, "last.md");
    const eventsFile = join(run, "events.jsonl");
    const stderrFile = join(run, "stderr.log");
    // NOTE: NO --output-schema — a judge needs a free-form completion.
    const args = [
      "exec",
      "--sandbox",
      "read-only",
      "--json",
      "--output-last-message",
      lastMsgFile,
      "--cd",
      run,
      "--model",
      opts.model,
      prompt,
    ];
    const env = { ...process.env } as Record<string, string>;
    if (opts.auth === "apikey" && opts.apiKeyEnv) {
      const key = process.env[opts.apiKeyEnv];
      if (key) env.OPENAI_API_KEY = key;
    }
    const res = await spawnSafely({
      command: this.binPath,
      args,
      env,
      cwd: run,
      stdoutFile: eventsFile,
      stderrFile,
      timeoutMs: opts.timeoutMs ?? COMPLETE_TIMEOUT_MS,
    });
    if (res.killedByTimeout || res.killedByWatchdog || res.exitCode !== 0) {
      let detail = "";
      try {
        detail = readFileSync(stderrFile, "utf8").slice(0, 500);
      } catch {
        detail = "";
      }
      throw new Error(`codex complete exit=${res.exitCode}: ${detail}`);
    }
    try {
      return readFileSync(lastMsgFile, "utf8");
    } catch {
      return "";
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/codex-adapter.test.ts`
Expected: PASS.

Run: `tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/providers/codex.ts tests/unit/codex-adapter.test.ts tests/fixtures/fake-codex-complete.sh
git commit -m "feat(providers): implement complete() on CodexAdapter (no output-schema)"
```

---

## Task 5: `opencode.complete()`

**Files:**
- Create: `tests/fixtures/fake-opencode-complete.sh`
- Modify: `src/providers/opencode.ts`
- Test: `tests/unit/opencode-adapter.test.ts`

- [ ] **Step 1: Create the fake CLI fixture**

Create `tests/fixtures/fake-opencode-complete.sh` (opencode does no key remapping, so no auth echo):

```bash
#!/usr/bin/env bash
# Fake `opencode run --format default` for complete(): prints a JUDGE-shaped
# JSON to stdout. Toggles: RG_FAKE_FAIL=1 -> exit 7; RG_FAKE_EMPTY=1 -> no stdout.
set -u
[ "${RG_FAKE_FAIL:-}" = "1" ] && { echo "boom" >&2; exit 7; }
[ "${RG_FAKE_EMPTY:-}" = "1" ] && exit 0
printf '%s\n' '{"contradicts":false,"reason":"opencode-judge"}'
exit 0
```

```bash
chmod +x tests/fixtures/fake-opencode-complete.sh
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/unit/opencode-adapter.test.ts` a new describe block:

```typescript
const FAKE_COMPLETE = join(process.cwd(), "tests/fixtures/fake-opencode-complete.sh");

describe("OpenCodeAdapter.complete (judge completion)", () => {
  it("returns the stdout text containing the judge JSON", async () => {
    const adapter = new OpenCodeAdapter({ binPath: FAKE_COMPLETE });
    const text = await adapter.complete("judge this", { model: "default", auth: "oauth" });
    expect(text).toContain('"contradicts":false');
  });

  it("throws on non-zero exit", async () => {
    process.env.RG_FAKE_FAIL = "1";
    const adapter = new OpenCodeAdapter({ binPath: FAKE_COMPLETE });
    await expect(adapter.complete("p", { model: "default", auth: "oauth" })).rejects.toThrow();
    delete process.env.RG_FAKE_FAIL;
  });

  it("returns '' on empty stdout (no throw)", async () => {
    process.env.RG_FAKE_EMPTY = "1";
    const adapter = new OpenCodeAdapter({ binPath: FAKE_COMPLETE });
    const text = await adapter.complete("p", { model: "default", auth: "oauth" });
    expect(text).toBe("");
    delete process.env.RG_FAKE_EMPTY;
  });
});
```

(Confirm the class name — `OpenCodeAdapter` — and import match the existing `opencode-adapter.test.ts`; use whatever that file already imports.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/unit/opencode-adapter.test.ts`
Expected: FAIL — `adapter.complete is not a function`.

- [ ] **Step 4: Implement `complete()` in `opencode.ts`**

Add `CompleteOptions` to the adapter-base import in `src/providers/opencode.ts` (it already imports `mkdtempSync`, `readFileSync`, `tmpdir`, `join`, `spawnSafely`). Add the constant near the top:

```typescript
const COMPLETE_TIMEOUT_MS = 20_000;
```

Add this method to the class (after `review()`):

```typescript
  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const run = mkdtempSync(join(tmpdir(), "rg-oc-cmpl-"));
    const stdoutFile = join(run, "out.txt");
    const stderrFile = join(run, "err.log");
    const args = ["run", "--dangerously-skip-permissions", "--format", "default"];
    if (opts.model && opts.model !== "default") args.push("-m", opts.model);
    args.push(prompt);
    const res = await spawnSafely({
      command: this.binPath,
      args,
      env: { ...process.env } as Record<string, string>,
      cwd: run,
      stdoutFile,
      stderrFile,
      timeoutMs: opts.timeoutMs ?? COMPLETE_TIMEOUT_MS,
    });
    if (res.killedByTimeout || res.killedByWatchdog || res.exitCode !== 0) {
      let detail = "";
      try {
        detail = readFileSync(stderrFile, "utf8").slice(0, 500);
      } catch {
        detail = "";
      }
      throw new Error(`opencode complete exit=${res.exitCode}: ${detail}`);
    }
    try {
      return readFileSync(stdoutFile, "utf8");
    } catch {
      return "";
    }
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/opencode-adapter.test.ts`
Expected: PASS.

Run: `tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/providers/opencode.ts tests/unit/opencode-adapter.test.ts tests/fixtures/fake-opencode-complete.sh
git commit -m "feat(providers): implement complete() on OpenCodeAdapter"
```

---

## Task 6: Judge call-sites pass `auth` + raw `apiKeyEnv`; integration test (judge fires)

**Files:**
- Modify: `src/core/orchestrator.ts` (contradiction judge ~789; curator judge ~915)
- Create: `tests/integration/cli-judge-complete.test.ts`

- [ ] **Step 1: Write the failing integration test**

The existing `tests/integration/brain-curator.test.ts` already has a "B3b" case that drives the contradiction judge via `complete()` — but with the **openrouter** provider as curator. This new test proves the same path works when the curator is a **CLI provider** (`codex`) configured with `auth:"apikey"`, AND asserts the call-site forwards `auth`. It is self-contained (it re-declares the small helpers rather than importing them). Create `tests/integration/cli-judge-complete.test.ts`:

```typescript
// tests/integration/cli-judge-complete.test.ts
// Proves the orchestrator wires the contradiction judge to a CLI-provider
// curator's complete() correctly: the call-site FORWARDS the provider's auth,
// and a contradiction verdict flags the active FP entry (contradicts_brain_id)
// instead of pairing it. (That the REAL CLI adapters actually expose a working
// complete() — the "no longer a no-op" half — is proven by the per-adapter unit
// tests in Tasks 2–5. Here we use an in-memory codex adapter with complete() to
// isolate the call-site/auth wiring, which is the part that fails pre-change.)
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { BrainStore } from "../../src/core/brain/store.ts";
import { FpLedgerStore } from "../../src/core/fp-ledger/store.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type {
  CompleteOptions,
  Preflight,
  ProviderAdapter,
  ReviewResult,
} from "../../src/providers/adapter-base.ts";

const CODE_DIFF =
  "diff --git a/src/cart.ts b/src/cart.ts\n" +
  "--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n";

// A codex adapter that BOTH reviews (PASS, no proposals) AND judges via
// complete() — recording the opts it received so we can assert auth forwarding.
class CodexReviewerJudge implements ProviderAdapter {
  readonly id = "codex" as const;
  lastOpts: CompleteOptions | null = null;
  constructor(private readonly verdictJson: string) {}
  async preflight(): Promise<Preflight> {
    return { available: true, version: "x", authMode: "oauth", error: null };
  }
  async review(inp: { reviewerId: string }): Promise<ReviewResult> {
    return {
      reviewerId: inp.reviewerId,
      verdict: "PASS",
      findings: [],
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
      durationMs: 1,
      exitCode: 0,
      rawEventsPath: "",
      rawText: JSON.stringify({ verdict: "PASS", findings: [] }),
      status: "ok",
    };
  }
  async complete(_prompt: string, opts: CompleteOptions): Promise<string> {
    this.lastOpts = opts;
    return this.verdictJson;
  }
}

// Fake openrouter exposing embed() (orthogonal vectors → no accidental dedup).
function fakeOpenRouter(): ProviderAdapter & {
  embed(t: string, o: { model: string; apiKeyEnv: string }): Promise<number[]>;
} {
  return {
    id: "openrouter",
    async preflight() {
      return { available: true, version: "x", authMode: "openrouter", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: "PASS",
        findings: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: "",
        status: "ok",
      } satisfies ReviewResult;
    },
    async embed(text: string) {
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 9973;
      return [Math.cos(h), Math.sin(h), 1];
    },
  };
}

describe("CLI provider (codex) as brain curator judge via complete()", () => {
  it("forwards auth to complete() and flags the FP on a contradiction", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cli-judge-"));

    // Seed an ACTIVE FP entry (≥3 rejects across 2 distinct providers).
    const fpStore = new FpLedgerStore(repo);
    const fpMeta = { rule_id: "magic-number", category: "quality" as const, file: "src/cart.ts", symbol: "" };
    const t = "2026-05-22T00:00:00Z";
    await fpStore.recordReject("sigM", fpMeta, { run_id: "r1", provider: "codex", reason: "intentional constant xx" }, t);
    await fpStore.recordReject("sigM", fpMeta, { run_id: "r2", provider: "gemini", reason: "intentional constant xx" }, t);
    await fpStore.recordReject("sigM", fpMeta, { run_id: "r3", provider: "codex", reason: "intentional constant xx" }, t);
    expect((await fpStore.snapshot()).entries[0]?.stage).toBe("active");

    // A CONTRADICTING active brain anti-pattern (magic-number IS real here).
    const bs = new BrainStore(repo);
    await bs.add({
      id: "B-900",
      type: "anti-pattern",
      scope: "this-repo",
      title: "magic-number is always real here",
      body: "never dismiss magic-number",
      tags: ["magic-number"],
      file_globs: ["src/cart.ts"],
      status: "active",
      referenced_count: 3,
      referencing_reviewers: ["codex", "gemini"],
      confidence: 0.95,
      embedding: null,
      evidence: [],
      created_at: t,
      source_run_id: "seed",
    });

    const judge = new CodexReviewerJudge(
      '{"contradicts":true,"brain_entry_id":"B-900","reason":"anti-pattern says it is real"}',
    );
    const config = {
      ...defaultConfig,
      providers: {
        ...defaultConfig.providers,
        // Curator provider is a CLI provider in APIKEY mode → the call-site must forward auth.
        codex: { ...defaultConfig.providers.codex, enabled: true, auth: "apikey" as const, apiKeyEnv: "RG_TEST_CURATOR_KEY" },
        openrouter: { ...defaultConfig.providers.openrouter, enabled: true },
      },
      phases: {
        review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
        critic: null,
        triage: null,
        fpLedger: { enabled: true },
        brain: {
          enabled: true,
          maxPromptTokens: 1500,
          embeddings: { provider: "openrouter" as const, model: "fake-embed", apiKeyEnv: "OPENROUTER_API_KEY" },
          egressAllowlist: [],
          curatorTimeoutMs: 10_000,
          curator: { provider: "codex" as const, model: "x", persona: "fp-filter" },
        },
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo,
      config,
      adapters: { codex: judge, openrouter: fakeOpenRouter() },
      sandboxMode: "off",
      hostTier: "opus",
      diff: CODE_DIFF,
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN1", iter: 1 });

    // The judge ran through the CLI adapter's complete() with the provider's auth.
    expect(judge.lastOpts).not.toBeNull();
    expect(judge.lastOpts?.auth).toBe("apikey");
    // Contradiction flagged the FP instead of pairing it.
    const fp = (await fpStore.snapshot()).entries[0];
    expect(fp?.contradicts_brain_id).toBe("B-900");
    expect(fp?.linked_brain_id).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/integration/cli-judge-complete.test.ts`
Expected: FAIL on `expect(judge.lastOpts?.auth).toBe("apikey")` — before the call-site change `complete()` is invoked without `auth` (so `lastOpts.auth` is `undefined`). (The judge already runs because `CodexReviewerJudge` has `complete`; the wiring under test is the `auth` forwarding.)

- [ ] **Step 3: Edit the contradiction judge call-site**

In `src/core/orchestrator.ts`, find the contradiction judge `adapter.complete(...)` call (~line 789):

```typescript
        const text = await adapter.complete(prompt, {
          model: curatorCfg.model ?? pcfg.model,
          apiKeyEnv: (pcfg as { apiKeyEnv?: string }).apiKeyEnv ?? "OPENROUTER_API_KEY",
          timeoutMs: brainCfg.curatorTimeoutMs,
        });
```

Replace with (conditional `apiKeyEnv` for `exactOptionalPropertyTypes`, plus `auth`):

```typescript
        const text = await adapter.complete(prompt, {
          model: curatorCfg.model ?? pcfg.model,
          ...(pcfg.apiKeyEnv ? { apiKeyEnv: pcfg.apiKeyEnv } : {}),
          auth: pcfg.auth,
          timeoutMs: brainCfg.curatorTimeoutMs,
        });
```

- [ ] **Step 4: Edit the curator accept/reject judge call-site**

In `src/core/orchestrator.ts`, find the curator judge `adapter.complete(...)` call (~line 915):

```typescript
            const text = await adapter.complete(prompt, {
              model: curatorCfg.model ?? pcfg.model,
              apiKeyEnv: (pcfg as { apiKeyEnv?: string }).apiKeyEnv ?? "OPENROUTER_API_KEY",
              timeoutMs: brainCfg.curatorTimeoutMs,
            });
```

Replace with:

```typescript
            const text = await adapter.complete(prompt, {
              model: curatorCfg.model ?? pcfg.model,
              ...(pcfg.apiKeyEnv ? { apiKeyEnv: pcfg.apiKeyEnv } : {}),
              auth: pcfg.auth,
              timeoutMs: brainCfg.curatorTimeoutMs,
            });
```

> Note: `pcfg` is already non-null here (both sites guard with `if (!adapter || !pcfg || typeof adapter.complete !== "function") return ...` just above) and is typed as the adapter-base `ProviderConfig`, which has `apiKeyEnv?: string` and `auth`. The `(pcfg as { apiKeyEnv?: string })` cast is no longer needed — use `pcfg.apiKeyEnv` / `pcfg.auth` directly.

- [ ] **Step 5: Run the integration test + typecheck**

Run: `bun test tests/integration/cli-judge-complete.test.ts`
Expected: PASS — `judge.lastOpts?.auth === "apikey"` and the FP entry is flagged `contradicts_brain_id`.

Run: `tsc --noEmit`
Expected: no errors (both call-sites type-check under `exactOptionalPropertyTypes`).

- [ ] **Step 6: Commit**

```bash
git add src/core/orchestrator.ts tests/integration/cli-judge-complete.test.ts
git commit -m "feat(orchestrator): pass auth + raw apiKeyEnv to judge complete(); CLI judges now fire"
```

---

## Task 7: Full verification (static checks + binary smoke)

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: all pass (previous baseline 581 pass / 9 skip / 0 fail, now plus the new tests; 0 fail).

- [ ] **Step 2: Typecheck**

Run: `tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `biome check src tests`
Expected: no errors. (If Biome flags formatting, run `biome format --write src tests` and re-check.)

- [ ] **Step 4: Build the compiled binary**

Run: `bun run build`
Expected: builds `dist/reviewgate` with no error (confirms the new code compiles into the `--compile` binary — see the M3 wasm lesson: source-mode green is not enough).

- [ ] **Step 5: Commit any formatting fixes**

```bash
git add -A
git commit -m "chore: lint/format after complete() implementation" || echo "nothing to commit"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** Task 1 = interface/`CompleteOptions` + OpenRouter fallback relocation + cassette type. Tasks 2–5 = the four adapters (happy / auth-remap / error→throw / empty→"" ; codex also schema-drop). Task 6 = both judge call-sites + judge-fires integration test. Task 7 = static checks + binary. Cassette behaviour needs no code beyond the Task-1 type widen (per spec: pre-existing cassettes no-op safely; new recordings capture `complete`).
- **Type consistency:** `CompleteOptions` (defined Task 1) is the single param type used by every `complete()` and the cassette `CompleteFn`. `COMPLETE_TIMEOUT_MS = 20_000` is a per-adapter module const (Tasks 2–5). The remap target vars are `ANTHROPIC_API_KEY` (claude), `GEMINI_API_KEY` (gemini), `OPENAI_API_KEY` (codex); opencode never remaps.
- **No behaviour change unless configured:** `complete()` is only called by the two judges, which only run when `phases.brain.curator` is set — so existing setups are unaffected.
- **DoD (per CLAUDE.md):** after Task 7, run the Codex×2 + Claude×2 review gate before committing the final state; this plan's per-task commits are local only — do not push without explicit approval.
