# Codex Reviewer Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the codex reviewer from intermittently flickering ok↔error (which fuels panel divergence) by disabling its agentic shell exploration and adding a single-retry safety net for runs that produce no parseable review JSON.

**Architecture:** Both changes are local to `src/providers/codex.ts` `review()`. (B) Add `--disable shell_tool` so codex answers in one shot from the orchestrator-curated prompt instead of wandering the repo. (A) Refactor the spawn-and-parse body into an inner `runOnce(attempt, promptText)` using per-attempt filenames, then retry exactly once on a generic `error`/unparseable outcome — but never on quota / timeout / abort. A defensive exit-0-quota-banner reclassification prevents wasting quota on a retry.

**Tech Stack:** Bun, TypeScript, `bun test`. Tests follow the existing pattern in `tests/unit/codex-adapter.test.ts` — real `review()` driven against fake-codex shell scripts as `binPath` (no spawn mocking).

**Spec:** `docs/superpowers/specs/2026-05-27-codex-reviewer-stability-design.md` (codex-reviewed, VERDICT: PASS).

---

## File Structure

- **Modify:** `src/providers/codex.ts` — `review()` only. Add `RETRY_DIRECTIVE` const; insert `--disable shell_tool`; extract `runOnce`; add retry + predicate + exit-0-quota reclassification + statusDetail suffix. `complete()`, `preflight()`, `extractUsage()`, `extractFindings()` are **unchanged**.
- **Create:** `tests/fixtures/fake-codex-attempt.sh` — a fake codex whose behavior branches on the `--output-last-message` filename (`last.1.md` vs `last.2.md`) and on env vars, and appends one line per invocation to `$RG_FAKE_COUNTER`. Used by all retry tests.
- **Modify:** `tests/unit/codex-adapter.test.ts` — add B arg-structure test + the retry/quota suite (cases 3, 3b–3f, abort).
- **Create:** `tests/integration/codex-shell-tool.test.ts` — guarded real-codex smoke test (skips when codex/auth absent).

Reference (current code, do not assume — open the file): `review()` spans roughly `src/providers/codex.ts:67-188`; the args array is built at `:76-97` with the prompt pushed last at `:97`; the `status !== "ok"` early return is at `:129-142`; the `findings === null` unparseable branch is at `:145-167`; the success return at `:169-186`.

---

## Task 1: B — disable codex shell exploration

**Files:**
- Modify: `src/providers/codex.ts` (args array in `review()`)
- Test: `tests/unit/codex-adapter.test.ts`

- [ ] **Step 1: Write the failing test** — assert the spawn receives `--disable shell_tool` as two adjacent args before the prompt positional, and that `--output-schema`/`--output-last-message` remain.

Add to `tests/unit/codex-adapter.test.ts`. This fake records argv to a file via `$RG_FAKE_ARGV`:

```ts
import { readFileSync as rf } from "node:fs";

it("B: review() passes --disable shell_tool before the prompt positional", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-codex-args-"));
  const argvFile = join(dir, "argv.txt");
  const bin = join(dir, "fake-argv.sh");
  // Records every arg on its own line, writes valid review JSON, exits 0.
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
set -u
: > "${argvFile}"
LAST_MSG=""
for a in "$@"; do printf '%s\\n' "$a" >> "${argvFile}"; done
i=1
for a in "$@"; do
  if [ "$a" = "--output-last-message" ]; then eval "LAST_MSG=\\\${$((i+1))}"; fi
  i=$((i+1))
done
[ -n "$LAST_MSG" ] && printf '%s' '{"verdict":"PASS","findings":[]}' > "$LAST_MSG"
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1,"cached_input_tokens":0}}'
exit 0
`,
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "REVIEW_PROMPT_BODY");
  writeFileSync(join(dir, "diff.patch"), "diff");

  const adapter = new CodexAdapter({ binPath: bin });
  const result = await adapter.review({
    cfg: { enabled: true, auth: "oauth", model: "gpt-5.4", timeoutMs: 60_000 },
    reviewerId: "codex-plan",
    promptFile,
    workingDir: dir,
    findingsPath: join(dir, "findings.md"),
    persona: "plan",
    diffPath: join(dir, "diff.patch"),
  });
  expect(result.status).toBe("ok");

  const argv = rf(argvFile, "utf8").split("\n");
  const di = argv.indexOf("--disable");
  expect(di).toBeGreaterThanOrEqual(0);
  expect(argv[di + 1]).toBe("shell_tool");
  // schema/last-message still present, and the prompt is the LAST arg (positional)
  expect(argv).toContain("--output-schema");
  expect(argv).toContain("--output-last-message");
  expect(argv.filter((x) => x.length > 0).pop()).toBe("REVIEW_PROMPT_BODY");
  // --disable must come before the prompt positional
  expect(di).toBeLessThan(argv.lastIndexOf("REVIEW_PROMPT_BODY"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/codex-adapter.test.ts -t "disable shell_tool"`
Expected: FAIL — `argv.indexOf("--disable")` is `-1` (flag not yet added).

- [ ] **Step 3: Add the flag** in `review()`'s `args` array, immediately after `"exec",` and before the prompt push:

```ts
const args = [
  "exec",
  "--disable",
  "shell_tool",
  "--sandbox",
  "read-only",
  "--json",
  "--output-last-message",
  lastMsgFile,
  "--output-schema",
  schemaPath,
  "--cd",
  input.workingDir,
  "--model",
  input.cfg.model,
];
args.push(readFileSync(input.promptFile, "utf8"));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/codex-adapter.test.ts`
Expected: PASS (new test + the two existing codex tests).

- [ ] **Step 5: Commit**

```bash
git add src/providers/codex.ts tests/unit/codex-adapter.test.ts
git commit -m "fix(codex): disable shell_tool so reviewer answers from curated context"
```

---

## Task 2: Refactor review() body into runOnce() (no behavior change)

**Files:**
- Modify: `src/providers/codex.ts` (`review()`)
- Test: `tests/unit/codex-adapter.test.ts` (existing tests are the regression guard)

This is a pure refactor: extract the spawn+classify+parse body into an inner async `runOnce` that uses per-attempt filenames (`last.${attempt}.md`, etc.) and returns the `ReviewResult` plus `killedByAbort`. `review()` calls it exactly once and returns its result — identical behavior, setting up Task 4.

- [ ] **Step 1: Replace the `review()` method body** with the form below. Keep `RETRY_DIRECTIVE` unused for now (it lands in Task 4) — define it in Step 1 of Task 4, not here.

```ts
async review(
  input: ReviewInput & { cfg: ProviderConfig; reviewerId: string },
): Promise<ReviewResult> {
  const run = mkdtempSync(join(tmpdir(), "rg-codex-run-"));

  // Always constrain codex to our review schema so the response shape is
  // predictable. Caller may override with their own schema file.
  let schemaPath = input.schemaPath;
  if (!schemaPath) {
    schemaPath = join(run, "schema.json");
    writeFileSync(schemaPath, JSON.stringify(REVIEW_OUTPUT_SCHEMA));
  }

  const env = { ...process.env } as Record<string, string>;
  if (input.cfg.auth === "apikey" && input.cfg.apiKeyEnv) {
    const key = process.env[input.cfg.apiKeyEnv];
    if (key) env.OPENAI_API_KEY = key;
  }
  // OAuth mode relies on codex's own credential store; no env change.

  // One codex invocation. Per-attempt filenames so a retry can never read a
  // previous attempt's stale last-message (see spec "stale-output guard").
  const runOnce = async (
    attempt: 1 | 2,
    promptText: string,
  ): Promise<{ result: ReviewResult; killedByAbort: boolean }> => {
    const lastMsgFile = join(run, `last.${attempt}.md`);
    const eventsFile = join(run, `events.${attempt}.jsonl`);
    const stderrFile = join(run, `stderr.${attempt}.log`);

    const args = [
      "exec",
      "--disable",
      "shell_tool",
      "--sandbox",
      "read-only",
      "--json",
      "--output-last-message",
      lastMsgFile,
      "--output-schema",
      schemaPath,
      "--cd",
      input.workingDir,
      "--model",
      input.cfg.model,
      promptText,
    ];

    const res = await spawnSafely({
      command: this.binPath,
      args,
      env,
      cwd: input.workingDir,
      stdoutFile: eventsFile,
      stderrFile,
      timeoutMs: input.cfg.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const stderrText = readFileSafe(stderrFile);
    const quotaText = `${stderrText}\n${readFileSafe(eventsFile)}`;
    const baseStatus: ReviewStatus =
      res.killedByTimeout || res.killedByWatchdog
        ? "timeout"
        : res.exitCode === 0
          ? "ok"
          : "error";
    const status: ReviewStatus =
      baseStatus === "error" && isQuotaExhausted(quotaText) ? "quota-exhausted" : baseStatus;

    if (status !== "ok") {
      const detail =
        status === "quota-exhausted" ? (extractQuotaMessage(quotaText) ?? stderrText) : stderrText;
      return {
        result: {
          reviewerId: input.reviewerId,
          verdict: "ERROR",
          findings: [],
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
          durationMs: res.durationMs,
          exitCode: res.exitCode,
          rawEventsPath: eventsFile,
          status,
          statusDetail: detail.slice(0, 1000),
        },
        killedByAbort: res.killedByAbort,
      };
    }

    const usage = this.extractUsage(eventsFile);
    const findings = this.extractFindings(
      lastMsgFile,
      input.cfg.model,
      input.persona,
      input.workingDir,
    );
    if (findings === null) {
      // Exit 0 but no parseable review. If codex actually printed a usage-limit
      // banner (which lands on exit 0 here, not the exit!=0 path above), classify
      // it as quota-exhausted so the cooldown handles it and we don't retry into
      // the cap. Otherwise it's a genuine unparseable run (retry candidate).
      if (isQuotaExhausted(quotaText)) {
        return {
          result: {
            reviewerId: input.reviewerId,
            verdict: "ERROR",
            findings: [],
            usage,
            durationMs: res.durationMs,
            exitCode: res.exitCode,
            rawEventsPath: eventsFile,
            status: "quota-exhausted",
            statusDetail: (extractQuotaMessage(quotaText) ?? "codex usage limit reached").slice(
              0,
              1000,
            ),
          },
          killedByAbort: res.killedByAbort,
        };
      }
      return {
        result: {
          reviewerId: input.reviewerId,
          verdict: "ERROR",
          findings: [],
          usage,
          durationMs: res.durationMs,
          exitCode: res.exitCode,
          rawEventsPath: eventsFile,
          status: "error",
          statusDetail: "reviewer exited 0 but produced no valid review JSON (unparseable output)",
        },
        killedByAbort: res.killedByAbort,
      };
    }

    let rawText = "";
    try {
      rawText = readFileSync(lastMsgFile, "utf8");
    } catch {
      rawText = "";
    }
    return {
      result: {
        reviewerId: input.reviewerId,
        verdict: findings.some((f) => f.severity === "CRITICAL" || f.severity === "WARN")
          ? "FAIL"
          : "PASS",
        findings,
        usage,
        durationMs: res.durationMs,
        exitCode: 0,
        rawEventsPath: eventsFile,
        rawText,
        status: "ok",
      },
      killedByAbort: res.killedByAbort,
    };
  };

  const first = await runOnce(1, readFileSync(input.promptFile, "utf8"));
  return first.result;
}
```

> Note: the exit-0 quota reclassification is included here for code locality, but it is *tested* in Task 3. The retry caller is added in Task 4.

- [ ] **Step 2: Run the full codex suite to verify no behavior change**

Run: `bun test tests/unit/codex-adapter.test.ts`
Expected: PASS — all existing tests plus Task 1's arg test still green.

- [ ] **Step 3: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/providers/codex.ts
git commit -m "refactor(codex): extract runOnce() with per-attempt filenames (no behavior change)"
```

---

## Task 3: Test the exit-0 quota-banner reclassification

**Files:**
- Create: `tests/fixtures/fake-codex-attempt.sh`
- Test: `tests/unit/codex-adapter.test.ts`

The reclassification code already landed in Task 2; this task pins it with a test and introduces the shared attempt-aware fake used by Task 4.

- [ ] **Step 1: Create the shared fake** `tests/fixtures/fake-codex-attempt.sh` (mode 0755). It branches on the `--output-last-message` filename suffix and on env knobs, and records each invocation in `$RG_FAKE_COUNTER`.

```bash
#!/usr/bin/env bash
# Attempt-aware fake codex for retry/quota tests.
# Behavior is driven by env vars set by the test:
#   RG_FAKE_COUNTER     : file to append one line per invocation (spawn count)
#   RG_FAKE_A1          : one of  ok|garbage|exit7|quota   (first attempt: last.1.md)
#   RG_FAKE_A2          : one of  ok|garbage|exit7|quota|none (second attempt: last.2.md)
# A run is "attempt 1" if its --output-last-message ends in last.1.md, else attempt 2.
set -u
LAST_MSG=""
i=1
for a in "$@"; do
  if [ "$a" = "--output-last-message" ]; then eval "LAST_MSG=\${$((i+1))}"; fi
  i=$((i+1))
done
[ -n "${RG_FAKE_COUNTER:-}" ] && printf 'x\n' >> "$RG_FAKE_COUNTER"

mode="$RG_FAKE_A1"
case "$LAST_MSG" in
  *last.2.md) mode="$RG_FAKE_A2" ;;
esac

emit_usage() { printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5,"cached_input_tokens":0}}'; }

case "$mode" in
  ok)
    [ -n "$LAST_MSG" ] && printf '%s' '{"verdict":"PASS","findings":[]}' > "$LAST_MSG"
    emit_usage; exit 0 ;;
  garbage)
    [ -n "$LAST_MSG" ] && printf '%s' 'not json {{{' > "$LAST_MSG"
    emit_usage; exit 0 ;;
  none)
    # exit 0 but write NOTHING to last-message (proves no stale-file parse)
    emit_usage; exit 0 ;;
  quota)
    # exit 0, empty last-message, usage-limit banner on the event stream
    printf '%s\n' '{"type":"item.completed","text":"You'\''ve hit your usage limit. Try again at 2026-05-28 10:00."}'
    emit_usage; exit 0 ;;
  exit7)
    echo "simulated codex failure" >&2
    exit 7 ;;
  *) echo "unknown mode: $mode" >&2; exit 99 ;;
esac
```

> Verify the banner string actually matches `isQuotaExhausted()` — open `src/providers/quota-signals.ts` and adjust the `quota` mode's text to a phrase that function recognizes if "hit your usage limit" is not matched.

- [ ] **Step 2: Write the failing test** (case 3f) in `tests/unit/codex-adapter.test.ts`:

```ts
const ATTEMPT_BIN = join(process.cwd(), "tests/fixtures/fake-codex-attempt.sh");

function makeReviewInput(dir: string, persona = "plan") {
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "REVIEW_PROMPT_BODY");
  writeFileSync(join(dir, "diff.patch"), "diff");
  return {
    cfg: { enabled: true, auth: "oauth" as const, model: "gpt-5.4", timeoutMs: 60_000 },
    reviewerId: "codex-plan",
    promptFile,
    workingDir: dir,
    findingsPath: join(dir, "findings.md"),
    persona,
    diffPath: join(dir, "diff.patch"),
  };
}

it("3f: exit-0 empty last-message with quota banner → quota-exhausted, one spawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-codex-q-"));
  const counter = join(dir, "count.txt");
  writeFileSync(counter, "");
  process.env.RG_FAKE_COUNTER = counter;
  process.env.RG_FAKE_A1 = "quota";
  process.env.RG_FAKE_A2 = "none";
  try {
    const adapter = new CodexAdapter({ binPath: ATTEMPT_BIN });
    const result = await adapter.review(makeReviewInput(dir));
    expect(result.status).toBe("quota-exhausted");
    expect(readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).length).toBe(1);
    expect(result.statusDetail ?? "").not.toContain("(after retry)");
  } finally {
    delete process.env.RG_FAKE_COUNTER;
    delete process.env.RG_FAKE_A1;
    delete process.env.RG_FAKE_A2;
  }
});
```

- [ ] **Step 3: Run it**

Run: `bun test tests/unit/codex-adapter.test.ts -t "3f"`
Expected: PASS (reclassification landed in Task 2). If it FAILS with `status === "error"`, the banner text doesn't match `isQuotaExhausted` — fix the fake's `quota` text per the Step-1 note, not the adapter.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/fake-codex-attempt.sh tests/unit/codex-adapter.test.ts
git commit -m "test(codex): pin exit-0 quota-banner reclassification + add attempt-aware fake"
```

---

## Task 4: A — retry-once mechanism + predicate + statusDetail suffix

**Files:**
- Modify: `src/providers/codex.ts` (`review()` — add the retry caller + `RETRY_DIRECTIVE`)
- Test: `tests/unit/codex-adapter.test.ts`

- [ ] **Step 1: Write the failing retry tests** (cases 3, 3b, 3c, 3d, 3e, abort). Append to `tests/unit/codex-adapter.test.ts`:

```ts
function spawnCount(counter: string): number {
  return readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).length;
}

async function runWithModes(a1: string, a2: string, prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const counter = join(dir, "count.txt");
  writeFileSync(counter, "");
  process.env.RG_FAKE_COUNTER = counter;
  process.env.RG_FAKE_A1 = a1;
  process.env.RG_FAKE_A2 = a2;
  const adapter = new CodexAdapter({ binPath: ATTEMPT_BIN });
  const result = await adapter.review(makeReviewInput(dir));
  const spawns = spawnCount(counter);
  delete process.env.RG_FAKE_COUNTER;
  delete process.env.RG_FAKE_A1;
  delete process.env.RG_FAKE_A2;
  return { result, spawns };
}

it("3: unparseable then valid → retries once, status ok, two spawns", async () => {
  const { result, spawns } = await runWithModes("garbage", "ok", "rg-codex-3-");
  expect(result.status).toBe("ok");
  expect(spawns).toBe(2);
});

it("3b: non-zero exit then valid → retries once, status ok, two spawns", async () => {
  const { result, spawns } = await runWithModes("exit7", "ok", "rg-codex-3b-");
  expect(result.status).toBe("ok");
  expect(spawns).toBe(2);
});

it("3c: unparseable then no-output → error (no stale parse), two spawns", async () => {
  const { result, spawns } = await runWithModes("garbage", "none", "rg-codex-3c-");
  expect(result.status).toBe("error");
  expect(spawns).toBe(2);
  expect(result.statusDetail ?? "").toContain("(after retry)");
});

it("3d: error then quota on retry → quota-exhausted unchanged (no suffix), two spawns", async () => {
  const { result, spawns } = await runWithModes("garbage", "quota", "rg-codex-3d-");
  expect(result.status).toBe("quota-exhausted");
  expect(spawns).toBe(2);
  expect(result.statusDetail ?? "").not.toContain("(after retry)");
});

it("3e: both non-zero error → error with (after retry) suffix, two spawns", async () => {
  const { result, spawns } = await runWithModes("exit7", "exit7", "rg-codex-3e-");
  expect(result.status).toBe("error");
  expect(spawns).toBe(2);
  expect(result.statusDetail ?? "").toContain("(after retry)");
});

it("valid first time → no retry, one spawn", async () => {
  const { result, spawns } = await runWithModes("ok", "none", "rg-codex-ok-");
  expect(result.status).toBe("ok");
  expect(spawns).toBe(1);
});

it("abort: pre-aborted signal → no retry (one spawn)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-codex-abort-"));
  const counter = join(dir, "count.txt");
  writeFileSync(counter, "");
  process.env.RG_FAKE_COUNTER = counter;
  process.env.RG_FAKE_A1 = "exit7"; // looks like a generic error...
  process.env.RG_FAKE_A2 = "ok";
  try {
    const adapter = new CodexAdapter({ binPath: ATTEMPT_BIN });
    const ac = new AbortController();
    ac.abort(); // ...but the signal is already aborted → must NOT retry
    const result = await adapter.review({ ...makeReviewInput(dir), signal: ac.signal });
    expect(spawnCount(counter)).toBe(1);
    expect(result.status).not.toBe("ok");
  } finally {
    delete process.env.RG_FAKE_COUNTER;
    delete process.env.RG_FAKE_A1;
    delete process.env.RG_FAKE_A2;
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test tests/unit/codex-adapter.test.ts -t "retries once"`
Expected: FAIL — currently `review()` calls `runOnce` once and never retries (case 3 sees one spawn / non-ok).

- [ ] **Step 3: Add `RETRY_DIRECTIVE`** as a module-level const near the top of `src/providers/codex.ts` (after the imports, beside `COMPLETE_TIMEOUT_MS`):

```ts
const RETRY_DIRECTIVE =
  "\n\nIMPORTANT: Output ONLY the single JSON object of the required schema now. Do not call any tools or explain.";
```

- [ ] **Step 4: Replace the final two lines of `review()`** (`const first = await runOnce(...)` / `return first.result;`) with the retry caller:

```ts
  const basePrompt = readFileSync(input.promptFile, "utf8");
  const first = await runOnce(1, basePrompt);

  // Retry exactly once ONLY on a generic error / unparseable outcome. Never on
  // quota (cooldown owns it), timeout/watchdog (a rerun won't help), or abort
  // (the loop self-deadline fired — killedByAbort surfaces as status "error",
  // so check it explicitly rather than inferring from status).
  const retriable =
    first.result.status === "error" && !first.killedByAbort && !input.signal?.aborted;
  if (!retriable) return first.result;

  const second = await runOnce(2, basePrompt + RETRY_DIRECTIVE);
  // Only the generic-error outcome gets the "(after retry)" marker; a terminal
  // quota/timeout status on the retry is returned unchanged so its detail stays
  // parseable by the cooldown.
  if (second.result.status === "error") {
    return {
      ...second.result,
      statusDetail: `${second.result.statusDetail ?? ""} (after retry)`.slice(0, 1000),
    };
  }
  return second.result;
```

(Delete the now-duplicate `readFileSync(input.promptFile, "utf8")` that Task 2 used for `first`; `basePrompt` replaces it.)

- [ ] **Step 5: Run the full codex suite**

Run: `bun test tests/unit/codex-adapter.test.ts`
Expected: PASS — all retry/quota/abort cases plus the Task 1–3 tests and the two original tests.

- [ ] **Step 6: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/providers/codex.ts tests/unit/codex-adapter.test.ts
git commit -m "fix(codex): retry once on unparseable/error review output (never on quota/timeout/abort)"
```

---

## Task 5: Real-codex smoke test (guarded)

**Files:**
- Create: `tests/integration/codex-shell-tool.test.ts`

Proves against the **real** codex CLI that `--disable shell_tool` yields a parseable review with zero shell exploration. Skips cleanly when codex is unavailable so CI without codex stays green (mirrors the memory rule: verify real, but don't hard-require the CLI in unit CI).

- [ ] **Step 1: Write the guarded test**

```ts
// tests/integration/codex-shell-tool.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../../src/providers/codex.ts";

// Opt-in: only runs when codex is present AND RG_REAL_CODEX=1 is set, so the
// default `bun test` (and CI without codex/auth) skips it.
const REAL = process.env.RG_REAL_CODEX === "1";
const d = REAL ? describe : describe.skip;

d("CodexAdapter against real codex CLI", () => {
  it("--disable shell_tool produces a parseable review with no shell exploration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-codex-real-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(
      promptFile,
      "You are reviewing an implementation plan. Output ONLY a single JSON object matching the provided schema. Plan: add an EbookCard using the shared Card with variant=glass; wire onArchived.",
    );
    writeFileSync(join(dir, "diff.patch"), "n/a");

    const adapter = new CodexAdapter();
    const result = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "gpt-5.4", timeoutMs: 300_000 },
      reviewerId: "codex-plan",
      promptFile,
      workingDir: process.cwd(),
      findingsPath: join(dir, "findings.md"),
      persona: "plan",
      diffPath: join(dir, "diff.patch"),
    });

    // Either a clean parse (ok) — what we expect now — or a classified non-ok,
    // but NEVER a crash; and the event stream must show no shell tool-calls.
    expect(["ok", "error", "quota-exhausted", "timeout"]).toContain(result.status);
    if (result.status === "ok") {
      const events = await Bun.file(result.rawEventsPath ?? "").text().catch(() => "");
      expect(events).not.toContain("exec_command");
      expect(events).not.toContain('"type":"function_call"');
    }
  }, 320_000);
});
```

- [ ] **Step 2: Run it for real (manual, requires codex + auth)**

Run: `RG_REAL_CODEX=1 bun test tests/integration/codex-shell-tool.test.ts`
Expected: PASS — `result.status === "ok"`, events contain no `exec_command` / `function_call`. (This reproduces the manual verification recorded in the spec.)

- [ ] **Step 3: Confirm it skips without the flag**

Run: `bun test tests/integration/codex-shell-tool.test.ts`
Expected: the describe block is skipped (0 tests run / "skip").

- [ ] **Step 4: Commit**

```bash
git add tests/integration/codex-shell-tool.test.ts
git commit -m "test(codex): guarded real-CLI smoke for --disable shell_tool"
```

---

## Final verification (after all tasks)

- [ ] `bunx tsc --noEmit` — clean
- [ ] `bun run lint` — clean
- [ ] `bun test` — full suite green
- [ ] `RG_REAL_CODEX=1 bun test tests/integration/codex-shell-tool.test.ts` — real codex parses, no shell calls
- [ ] Run the Definition-of-Done review pipeline (Codex ×2 + Claude ×2) per `~/.claude/CLAUDE.md`; fix findings; only then merge `slice1-codex-reviewer-stability`.

---

## Self-review (plan vs spec)

- **Spec coverage:** B → Task 1; runOnce refactor + per-attempt files (stale-output guard) → Task 2; exit-0 quota fallthrough → Task 2 code + Task 3 test; retry predicate + no-retry (quota/timeout/abort via `killedByAbort`/`signal.aborted`) + statusDetail suffix rules → Task 4; per-attempt timeout bounded by abort → covered by the predicate (Task 4) and abort test; arg-structure (two args before positional) → Task 1; retry-prompt mutates the final positional only → Task 4 (the retry calls `runOnce(2, basePrompt + RETRY_DIRECTIVE)`, prompt is the last arg); real-codex smoke → Task 5. Test cases 1–7 / 3b–3f all map to named tests.
- **Placeholder scan:** no TBD/TODO; every code step shows complete code; fake scripts are complete. One conditional fix-up note (quota banner text vs `isQuotaExhausted`) is explicit with the file to check, not a placeholder.
- **Type/name consistency:** `runOnce(attempt, promptText)` returns `{ result: ReviewResult; killedByAbort: boolean }` consistently in Tasks 2 & 4; `RETRY_DIRECTIVE`, `RG_FAKE_COUNTER`, `RG_FAKE_A1/A2`, `ATTEMPT_BIN`, `makeReviewInput`, `runWithModes`, `spawnCount` are defined once and reused; statuses use the `ReviewStatus` union values.
