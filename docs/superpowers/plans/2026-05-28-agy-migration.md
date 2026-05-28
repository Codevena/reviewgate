# agy Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the `gemini` reviewer adapter in-place to drive the Antigravity CLI (`agy`) instead of the discontinued Gemini CLI, keeping the provider id `gemini`.

**Architecture:** `agy -p` prints the model response to stdout (no `-m`, no `-o json` envelope, no API-key auth). The adapter spawns `agy` as an independent subprocess, captures stdout, and parses review JSON directly via the existing `parseReviewOutput`. Token usage is reported as zero (agy exposes none). The provider id stays `gemini`, so the provider-id union, zod schemas, registry, configs, and ~40 fixtures are untouched.

**Tech Stack:** Bun, TypeScript, `agy` v1.0.3 CLI, `bun test`, biome.

**Spec:** `docs/superpowers/specs/2026-05-28-agy-migration-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/providers/gemini.ts` | The adapter — spawns `agy`, parses stdout | Rewrite `review()`, `complete()`, `parse()`, constructor default; drop `GeminiEnvelope` + apikey branch |
| `src/providers/availability.ts` | Maps provider id → binary to probe | `gemini: "gemini"` → `"agy"` |
| `src/cli/commands/doctor.ts` | Health checks | Probe `agy`; add sunset note + apikey-degradation warning |
| `src/config/defaults.ts` | Default config | Scrub stale gemini-CLI comments; model becomes informational |
| `src/cli/commands/init.ts` | Config scaffold | Note agy ignores `model` in the scaffold comment |
| `src/sandbox/profile-builder.ts` | Sandbox credential/network allowlists | Update `CREDENTIAL_PATHS.gemini` + `NETWORK_ALLOW.gemini` for agy |
| `tests/fixtures/fake-gemini.sh` | Fake reviewer for unit tests | Emit review JSON on stdout + optional argv dump |
| `tests/fixtures/fake-gemini-complete.sh` | Fake `complete()` | Emit completion text on stdout |
| `tests/unit/gemini-adapter.test.ts` | Adapter unit tests | Rewrite for stdout parsing + argv; drop apikey case |
| `tests/unit/availability.test.ts` | Binary-probe test | Expect `agy` |
| `tests/e2e/gemini-real.test.ts` | Real reviewer smoke test | Real `agy` call |

`src/cli/setup/prefill.ts`, `src/cli/setup/build-config.ts`, `src/cli/commands/setup.ts` reference `"gemini"` only as a **provider-id string** (fallback chains, auth map, model prefill) — these stay valid and need no change. `src/providers/registry.ts` constructs `new GeminiAdapter()` with no args, so the constructor-default change to `"agy"` covers it automatically.

---

## Task 1: Rewrite the fake reviewer fixtures

**Files:**
- Modify: `tests/fixtures/fake-gemini.sh`
- Modify: `tests/fixtures/fake-gemini-complete.sh`

- [ ] **Step 1: Rewrite `fake-gemini.sh`** to print review JSON directly on stdout (no envelope), and dump argv to `$RG_ARGS_OUT` when set:

```bash
#!/usr/bin/env bash
# Fake `agy -p` for the gemini-id reviewer adapter. agy prints the model
# response verbatim on stdout (no {response,stats} envelope, no token stats).
# When RG_ARGS_OUT is set, dump the received argv (one per line) for assertions.
set -u
[ -n "${RG_ARGS_OUT:-}" ] && printf '%s\n' "$@" > "$RG_ARGS_OUT"
cat <<'JSON'
{"verdict":"FAIL","findings":[{"severity":"WARN","category":"security","rule_id":"gem-rule","file":"x.ts","line":1,"message":"gemini finding","details":"d","confidence":0.8}]}
JSON
exit 0
```

- [ ] **Step 2: Rewrite `fake-gemini-complete.sh`** to print completion text directly on stdout:

```bash
#!/usr/bin/env bash
# Fake `agy -p` for complete(): prints the judge JSON text directly on stdout.
# Toggles: RG_FAKE_FAIL=1 -> non-zero exit; RG_FAKE_EMPTY=1 -> no stdout.
set -u
[ "${RG_FAKE_FAIL:-}" = "1" ] && { echo "boom" >&2; exit 7; }
[ "${RG_FAKE_EMPTY:-}" = "1" ] && exit 0
printf '%s\n' '{"contradicts":false,"reason":"ok"}'
exit 0
```

- [ ] **Step 3: Keep them executable**

Run: `chmod +x tests/fixtures/fake-gemini.sh tests/fixtures/fake-gemini-complete.sh`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/fake-gemini.sh tests/fixtures/fake-gemini-complete.sh
git commit -m "test(fixtures): fake gemini reviewer prints agy-style plain stdout"
```

---

## Task 2: Rewrite the adapter unit tests (failing first)

**Files:**
- Modify (rewrite): `tests/unit/gemini-adapter.test.ts`

- [ ] **Step 1: Replace the whole file** with tests for the new stdout/argv behavior (no envelope, no apikey):

```ts
// tests/unit/gemini-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiAdapter } from "../../src/providers/gemini.ts";

const FAKE = join(process.cwd(), "tests/fixtures/fake-gemini.sh");
const FAKE_COMPLETE = join(process.cwd(), "tests/fixtures/fake-gemini-complete.sh");

describe("GeminiAdapter (agy, mocked)", () => {
  it("parses findings from plain stdout; usage is zero (agy has no token stats)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-gem-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const adapter = new GeminiAdapter({ binPath: FAKE });
    const res = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "ignored", timeoutMs: 60_000 },
      reviewerId: "gemini-architecture",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "architecture",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.status).toBe("ok");
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]?.reviewer.provider).toBe("gemini");
    expect(res.usage.inputTokens).toBe(0);
    expect(res.usage.outputTokens).toBe(0);
  });

  it("spawns agy with the right argv: -p + skip-permissions, NO -m/-o/--add-dir/--approval-mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-gem-args-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const argsFile = join(dir, "argv.txt");
    process.env.RG_ARGS_OUT = argsFile;
    try {
      const adapter = new GeminiAdapter({ binPath: FAKE });
      await adapter.review({
        cfg: { enabled: true, auth: "oauth", model: "ignored", timeoutMs: 60_000 },
        reviewerId: "gemini-security",
        promptFile,
        workingDir: dir,
        findingsPath: join(dir, "f.md"),
        persona: "security",
        diffPath: join(dir, "d.patch"),
      });
      const argv = readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
      expect(argv).toContain("-p");
      expect(argv).toContain("--dangerously-skip-permissions");
      expect(argv).toContain("--print-timeout");
      expect(argv).toContain("60000ms");
      expect(argv).not.toContain("-m");
      expect(argv).not.toContain("-o");
      expect(argv).not.toContain("--add-dir");
      expect(argv).not.toContain("--approval-mode");
    } finally {
      Reflect.deleteProperty(process.env, "RG_ARGS_OUT");
    }
  });
});

describe("GeminiAdapter.complete (judge completion)", () => {
  it("returns the raw stdout text containing the judge JSON", async () => {
    const adapter = new GeminiAdapter({ binPath: FAKE_COMPLETE });
    const text = await adapter.complete("judge this", { model: "ignored", auth: "oauth" });
    expect(text).toContain('"contradicts":false');
  });

  it("throws on non-zero exit", async () => {
    process.env.RG_FAKE_FAIL = "1";
    const adapter = new GeminiAdapter({ binPath: FAKE_COMPLETE });
    await expect(adapter.complete("p", { model: "m", auth: "oauth" })).rejects.toThrow();
    Reflect.deleteProperty(process.env, "RG_FAKE_FAIL");
  });

  it("returns '' on empty stdout (no throw)", async () => {
    process.env.RG_FAKE_EMPTY = "1";
    const adapter = new GeminiAdapter({ binPath: FAKE_COMPLETE });
    const text = await adapter.complete("p", { model: "m", auth: "oauth" });
    expect(text).toBe("");
    Reflect.deleteProperty(process.env, "RG_FAKE_EMPTY");
  });
});
```

- [ ] **Step 2: Run the tests to verify they FAIL** (adapter still parses the envelope, still has the apikey branch)

Run: `bun test tests/unit/gemini-adapter.test.ts`
Expected: FAIL — `usage.inputTokens` is `200` not `0`, and the argv test fails because the old args contain `-m`/`-o`.

- [ ] **Step 3: Commit the failing tests**

```bash
git add tests/unit/gemini-adapter.test.ts
git commit -m "test(gemini): pin agy stdout parsing + argv, drop envelope/apikey cases"
```

---

## Task 3: Rebuild the adapter to drive `agy`

**Files:**
- Modify (rewrite): `src/providers/gemini.ts`

- [ ] **Step 1: Replace the whole file** with the agy-driving implementation:

```ts
// src/providers/gemini.ts
// Drives the Antigravity CLI (`agy`), the successor to the discontinued Gemini
// CLI (gemini CLI sunsets 2026-06-18 for OAuth/Pro/Ultra/free tiers). The
// provider id stays "gemini" for config compatibility. agy `-p` prints the model
// response verbatim on stdout — there is no -m, no -o json envelope, and no
// API-key auth (OAuth via the Antigravity session only).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "../schemas/finding.ts";
import { spawnSafely } from "../utils/spawn.ts";
import type {
  CompleteOptions,
  Preflight,
  ProviderAdapter,
  ProviderConfig,
  ReviewInput,
  ReviewResult,
  ReviewStatus,
} from "./adapter-base.ts";
import { failureReason, readFileSafe } from "./complete-helpers.ts";
import { isQuotaExhausted } from "./quota-signals.ts";
import { mapReviewOutputToFindings, parseReviewOutput } from "./review-output.ts";

const COMPLETE_TIMEOUT_MS = 20_000;

export interface GeminiAdapterOptions {
  binPath?: string;
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini" as const;
  private readonly binPath: string;
  constructor(opts: GeminiAdapterOptions = {}) {
    this.binPath = opts.binPath ?? "agy";
  }

  async preflight(cfg: ProviderConfig): Promise<Preflight> {
    const tmp = mkdtempSync(join(tmpdir(), "rg-agy-pf-"));
    try {
      const res = await spawnSafely({
        command: this.binPath,
        args: ["--version"],
        stdoutFile: join(tmp, "o"),
        stderrFile: join(tmp, "e"),
        timeoutMs: 5_000,
      });
      if (res.exitCode !== 0)
        return {
          available: false,
          version: null,
          authMode: cfg.auth,
          error: `agy --version exit=${res.exitCode}`,
        };
      return {
        available: true,
        version: readFileSafe(join(tmp, "o")).trim(),
        authMode: cfg.auth,
        error: null,
      };
    } catch (err) {
      return { available: false, version: null, authMode: cfg.auth, error: (err as Error).message };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async review(
    input: ReviewInput & { cfg: ProviderConfig; reviewerId: string },
  ): Promise<ReviewResult> {
    const run = mkdtempSync(join(tmpdir(), "rg-agy-run-"));
    const outFile = join(run, "out.txt");
    const errFile = join(run, "err.log");
    // No --add-dir: the diff is supplied inline in the prompt, so the reviewer
    // needs no workspace access (no agentic file exploration, no edit risk).
    // --dangerously-skip-permissions prevents a hang on the permission prompt.
    const args = [
      "-p",
      readFileSync(input.promptFile, "utf8"),
      "--dangerously-skip-permissions",
      "--print-timeout",
      `${input.cfg.timeoutMs}ms`,
    ];
    const res = await spawnSafely({
      command: this.binPath,
      args,
      env: { ...process.env } as Record<string, string>,
      cwd: input.workingDir,
      stdoutFile: outFile,
      stderrFile: errFile,
      timeoutMs: input.cfg.timeoutMs,
      // agy print mode buffers (no streamed stdout), so the default 60s zero-byte
      // idle watchdog would SIGKILL a longer review. Tie it to the wall timeout.
      zeroByteWatchdogMs: input.cfg.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const errText = readFileSafe(errFile);
    const outText = readFileSafe(outFile);
    const baseStatus: ReviewStatus =
      res.killedByTimeout || res.killedByWatchdog ? "timeout" : res.exitCode === 0 ? "ok" : "error";
    const status: ReviewStatus =
      baseStatus === "error" && isQuotaExhausted(errText + outText) ? "quota-exhausted" : baseStatus;
    if (status !== "ok") {
      return {
        reviewerId: input.reviewerId,
        verdict: "ERROR",
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
        durationMs: res.durationMs,
        exitCode: res.exitCode,
        rawEventsPath: outFile,
        status,
        statusDetail: errText.slice(0, 1000),
      };
    }
    const { findings, rawText } = this.parse(outText, input.cfg.model, input.persona, input.workingDir);
    return {
      reviewerId: input.reviewerId,
      verdict: findings.some((f) => f.severity === "CRITICAL" || f.severity === "WARN")
        ? "FAIL"
        : "PASS",
      findings,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
      durationMs: res.durationMs,
      exitCode: 0,
      rawEventsPath: outFile,
      rawText,
      status: "ok",
    };
  }

  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const run = mkdtempSync(join(tmpdir(), "rg-agy-cmpl-"));
    try {
      const outFile = join(run, "out.txt");
      const errFile = join(run, "err.log");
      const timeoutMs = opts.timeoutMs ?? COMPLETE_TIMEOUT_MS;
      const args = [
        "-p",
        prompt,
        "--dangerously-skip-permissions",
        "--print-timeout",
        `${timeoutMs}ms`,
      ];
      const res = await spawnSafely({
        command: this.binPath,
        args,
        env: { ...process.env } as Record<string, string>,
        cwd: run,
        stdoutFile: outFile,
        stderrFile: errFile,
        timeoutMs,
        zeroByteWatchdogMs: timeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (res.killedByTimeout || res.killedByWatchdog || res.exitCode !== 0) {
        throw new Error(`agy complete ${failureReason(res)}: ${readFileSafe(errFile).slice(0, 500)}`);
      }
      // agy `-p` prints the response verbatim — stdout IS the completion.
      return readFileSafe(outFile);
    } finally {
      try {
        rmSync(run, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  }

  private parse(
    rawText: string,
    model: string,
    persona: string,
    workingDir: string,
  ): { findings: Finding[]; rawText: string } {
    const out = rawText ? parseReviewOutput(rawText) : null;
    const findings = out
      ? mapReviewOutputToFindings(out, { provider: "gemini", model, persona, workingDir })
      : [];
    return { findings, rawText };
  }
}
```

- [ ] **Step 2: Run the adapter unit tests to verify they PASS**

Run: `bun test tests/unit/gemini-adapter.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 3: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean. (Fix import ordering if biome complains — move `readFileSync` import up with the other `node:fs` import.)

- [ ] **Step 4: Commit**

```bash
git add src/providers/gemini.ts
git commit -m "feat(gemini): drive the Antigravity CLI (agy) instead of the Gemini CLI"
```

---

## Task 4: Point the binary probe at `agy`

**Files:**
- Modify: `src/providers/availability.ts:8`
- Modify: `tests/unit/availability.test.ts:28-29`

- [ ] **Step 1: Update the test expectation first** (it currently asserts `"gemini"` is probed). In `tests/unit/availability.test.ts`, change the probe test so the present-set and the expected binary are `agy`:

```ts
  it("CLI providers probe their binary (codex/agy/claude-code/opencode)", () => {
    const present = (bin: string) => ["codex", "agy", "claude", "opencode"].includes(bin);
    for (const id of ["codex", "gemini", "claude-code", "opencode"] as const) {
```

(Leave the rest of the test body unchanged — the loop still iterates provider ids, only the binary set changes.)

- [ ] **Step 2: Run it to verify it FAILS**

Run: `bun test tests/unit/availability.test.ts`
Expected: FAIL — `PROVIDER_BIN.gemini` is still `"gemini"`, so the probe for id `gemini` looks up `"gemini"`, not `"agy"`.

- [ ] **Step 3: Update `PROVIDER_BIN`** in `src/providers/availability.ts`:

```ts
export const PROVIDER_BIN: Record<ProviderId, string | null> = {
  codex: "codex",
  gemini: "agy",
  "claude-code": "claude",
  opencode: "opencode",
  openrouter: null,
};
```

- [ ] **Step 4: Run it to verify it PASSES**

Run: `bun test tests/unit/availability.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/availability.ts tests/unit/availability.test.ts
git commit -m "feat(availability): probe agy for the gemini provider id"
```

---

## Task 5: Scrub stale gemini-CLI comments in defaults

**Files:**
- Modify: `src/config/defaults.ts` (the `gemini:` provider block, ~lines 11-20)

- [ ] **Step 1: Replace the comment block + keep the model field** (model is now informational — agy has no `-m`):

```ts
    gemini: {
      enabled: false,
      auth: "oauth" as const,
      // Driven by the Antigravity CLI (`agy`); the provider id stays "gemini".
      // agy has no model-selection flag, so `model` is INFORMATIONAL ONLY
      // (recorded in audit/research, never passed to the CLI). Kept in the
      // schema to avoid a breaking config change.
      model: "gemini-3-flash-preview",
      timeoutMs: 300_000,
    },
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/config/defaults.ts
git commit -m "docs(defaults): gemini block reflects agy (model now informational)"
```

---

## Task 6: Doctor — agy health + sunset note + apikey-degradation warning

**Files:**
- Modify: `src/cli/commands/doctor.ts` (~line 390)

- [ ] **Step 1: Update the optional-CLI check** to probe `agy` with a sunset-aware label:

```ts
  for (const [bin, name] of [
    ["agy", "Antigravity CLI agy (gemini reviewer; gemini CLI sunsets 2026-06-18)"],
    ["claude", "claude CLI (optional)"],
  ] as const) {
    const c = checkBinary(bin, name);
    checks.push({ ...c, status: c.status === "fail" ? "warn" : c.status });
  }
```

- [ ] **Step 2: Add an apikey-degradation warning** inside the existing `try`
block, immediately after `checks.push(reviewersEnabledCheck(cfg));` (~line 339),
where the effective config `cfg` is in scope. The `gemini` provider is OAuth-only
now; warn if a config sets `auth:"apikey"` for it (it has no effect):

```ts
    // gemini → agy is OAuth-only; an apikey auth on the gemini provider is inert.
    const gem = cfg.providers?.gemini;
    if (gem?.enabled && gem.auth === "apikey") {
      checks.push({
        name: "gemini auth",
        status: "warn",
        detail: 'gemini runs the agy CLI (OAuth only); auth:"apikey" has no effect — remove it.',
      });
    }
```

- [ ] **Step 3: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

- [ ] **Step 4: Run the doctor tests**

Run: `bun test tests/unit/doctor-reviewers.test.ts tests/unit/doctor-fallback.test.ts`
Expected: PASS. If a test asserts the old `"gemini CLI (optional)"` label or the `"gemini"` binary, update that expectation to `"agy"`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/doctor.ts tests/unit/doctor-*.test.ts
git commit -m "feat(doctor): check agy, surface gemini-CLI sunset + apikey-is-inert warning"
```

---

## Task 7: Update the config scaffold comment in init

**Files:**
- Modify: `src/cli/commands/init.ts:157`

- [ ] **Step 1: Update the scaffolded gemini comment** so users know agy ignores `model`:

```ts
      '    // gemini: { enabled: true, auth: "oauth", timeoutMs: 300_000 }, // runs the agy CLI (model ignored)',
```

- [ ] **Step 2: Run the init tests**

Run: `bun test tests/unit/setup-build-config.test.ts tests/unit/setup-prefill.test.ts`
Expected: PASS. (These reference `gemini` as a provider id / auth map / model prefill — all still valid; no change expected. If one asserts the exact scaffold comment string, update it to match Step 1.)

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/init.ts
git commit -m "docs(init): scaffold notes gemini runs agy and ignores model"
```

---

## Task 8: Sandbox profile — agy credentials + network

**Files:**
- Modify: `src/sandbox/profile-builder.ts:6,13`

> Non-blocking for the migration (sandbox is `mode:"off"` by default and
> `"strict"`/`"permissive"` fail closed), but the profile must be correct for
> when isolation ships.

- [ ] **Step 1: Update `CREDENTIAL_PATHS.gemini`** to the Antigravity session dirs:

```ts
  gemini: ["~/.antigravity", "~/.gemini/antigravity-cli", "~/.config/gemini", "~/.gemini"],
```

- [ ] **Step 2: Update `NETWORK_ALLOW.gemini`** to the agy endpoints:

```ts
  gemini: [
    "oauth2.googleapis.com",
    "accounts.google.com",
    "cloudcode-pa.googleapis.com",
    "www.googleapis.com",
    "generativelanguage.googleapis.com",
  ],
```

- [ ] **Step 3: Typecheck + run any sandbox tests**

Run: `bunx tsc --noEmit && bun test tests/unit -t "profile" 2>/dev/null; echo done`
Expected: clean typecheck; profile tests (if any) pass.

- [ ] **Step 4: Commit**

```bash
git add src/sandbox/profile-builder.ts
git commit -m "feat(sandbox): gemini profile allows agy credential dirs + endpoints"
```

---

## Task 9: Real-agy e2e smoke test

**Files:**
- Modify: `tests/e2e/gemini-real.test.ts`

- [ ] **Step 1: Update the inline reviewgate.config** in the test so the gemini provider has no model dependency (agy ignores it) — change the `providers.gemini` literal to drop `model`:

```ts
      writeFileSync(
        join(repo, "reviewgate.config.ts"),
        `import { defineConfig } from "${process.cwd()}/src/config/define-config.ts";\nexport default defineConfig({ providers: { gemini: { enabled: true, auth: "oauth", timeoutMs: 300000 } }, phases: { review: { reviewers: [{ provider: "gemini", persona: "security" }] } } });\n`,
      );
```

(If `model` is required by `ProviderConfigSchema`, keep a placeholder `model: "agy-default"` — it is informational. Check `src/config/define-config.ts:14`: `model: z.string()` is **required**, so KEEP `model: "agy-default"` in the literal.)

- [ ] **Step 2: Update the describe label** to reflect agy:

```ts
(E2E ? describe : describe.skip)("e2e with real agy (gemini provider)", () => {
```

- [ ] **Step 3: Run it for real** (requires an authenticated `agy`):

Run: `REVIEWGATE_E2E=1 bun test tests/e2e/gemini-real.test.ts`
Expected: PASS — `pending.md` exists and mentions timing/compare/`==`. If `agy` is not authenticated in this environment, the test is the only one that needs real auth; confirm it is skipped cleanly with `bun test tests/e2e/gemini-real.test.ts` (no `REVIEWGATE_E2E`) → 0 run.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/gemini-real.test.ts
git commit -m "test(e2e): gemini reviewer e2e runs against real agy"
```

---

## Task 10: Full verification + DoD

**Files:** none (verification only)

- [ ] **Step 1: Static checks**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean.

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: all green (the ~40 fixtures using `"gemini"` as a provider-id string are untouched; only the adapter/availability/doctor tests changed).

- [ ] **Step 3: Build the binary** (compiled-binary parity — a `bun --compile` regression is invisible in `bun test`)

Run: `bun run build`
Expected: `dist/reviewgate` produced. Then smoke the doctor: `./dist/reviewgate doctor` should show the `agy` check and the sunset note.

- [ ] **Step 4: Real reviewer smoke via the binary** (optional, requires authed agy)

Run: `REVIEWGATE_E2E=1 bun test tests/e2e/gemini-real.test.ts`
Expected: PASS.

- [ ] **Step 5: DoD review pipeline** (per project `CLAUDE.md`): run the codex/agy reviewers ×2 then claude reviewers ×2 on the uncommitted/branch diff, fix all findings, gate. Then the final commit is already done per task; do NOT push without explicit user permission.
```
