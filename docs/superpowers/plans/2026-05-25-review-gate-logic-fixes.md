# Review-Gate Logic Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix seven verified correctness/resilience/concurrency bugs in Reviewgate where configured behaviour is silently ignored, unparseable reviewer output passes the gate, or shared-state writes are unsafe.

**Architecture:** Each fix is local to one or two files. Verdict/decision logic lives in `src/core/loop-driver.ts`; reviewer output classification in `src/providers/{codex,opencode}.ts`; persisted-state safety in `src/core/{state-store,quota-cooldown}.ts` and `src/hooks/handlers.ts`; cache TTL in `src/cache/cache.ts`; the stop-hook critical section in `src/cli/commands/gate.ts`. All tasks are TDD: failing test first, minimal fix, green, commit.

**Tech Stack:** Bun (runtime + test runner), TypeScript, zod schemas, Biome (lint/format). Use `bun test`, `bunx tsc --noEmit`, `bun run lint` — never npm/jest/vitest.

---

## Issue → Task Map

| Issue | Severity | Task |
|-------|----------|------|
| E — Cache TTL hardcoded, `cache.reviewTtlDays` ignored | low–mid | Task 1 |
| B — Unparseable reviewer output (exit 0) → silent PASS | **mid** | Task 2 |
| A — `softPassPolicy` defined but ignored (`block`/`ask-once` dead) | **mid** | Task 3 |
| G — `StateStore.loadOrRecover` treats transient I/O as corruption | mid | Task 4 |
| F — `QuotaCooldownStore.write` non-atomic, unlocked | low | Task 5 |
| D — `dirty.flag.tmp` fixed tempname (parallel triggers clobber) | low | Task 6 |
| C — No global lock around the whole stop-hook run | low–mid | Task 7 |

Order rationale: correctness fixes first (E, B, A), then resilience (G), then concurrency hygiene (F, D, C). Tasks are independent — each commits on its own.

---

## File Structure

- `src/cache/cache.ts` — `getCachedReview` gains a `ttlMs` parameter (Task 1).
- `src/core/orchestrator.ts:407` — passes `cfg.cache.reviewTtlDays * 86_400_000` to `getCachedReview` (Task 1).
- `src/providers/codex.ts` — `extractFindings` returns `Finding[] | null`; `null` → `ERROR` (Task 2).
- `src/providers/opencode.ts` — `parseReviewOutput` `null` → `ERROR` (Task 2).
- `src/core/loop-driver.ts` — honour `config.loop.softPassPolicy` at the SOFT-PASS decision points (Task 3).
- `src/core/state-store.ts` — `loadOrRecover` recovers only on parse/schema errors; rethrows genuine I/O errors (Task 4).
- `src/core/quota-cooldown.ts` — `write` uses atomic tmp+rename (Task 5).
- `src/hooks/handlers.ts:36` — unique tempname for the dirty-flag write (Task 6).
- `src/cli/commands/gate.ts` — `flock` around the `hook === "stop"` critical section (Task 7).

---

### Task 1: Cache TTL honours `cache.reviewTtlDays` (Issue E)

`getCachedReview` hardcodes a 7-day TTL and takes no TTL argument, so `cache.reviewTtlDays` (validated in config, default 7) is silently ignored for any non-default value.

**Files:**
- Modify: `src/cache/cache.ts:37-49`
- Modify: `src/core/orchestrator.ts:407`
- Test: `tests/unit/cache.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/cache.test.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("getCachedReview honours a caller-supplied TTL (expires before the 7-day default)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-cache-ttl-"));
  const key = "k-ttl";
  mkdirSync(join(repo, ".reviewgate", "cache", "reviews"), { recursive: true });
  // Written 3 days ago.
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
  writeFileSync(
    join(repo, ".reviewgate", "cache", "reviews", `${key}.json`),
    JSON.stringify({
      ts: threeDaysAgo,
      review: { verdict: "PASS", counts: { critical: 0, warn: 0, info: 0 } },
    }),
  );
  // 1-day TTL → expired.
  expect(await getCachedReview(repo, key, 1 * 24 * 60 * 60 * 1000)).toBeNull();
  // 7-day TTL → still valid.
  expect(await getCachedReview(repo, key, 7 * 24 * 60 * 60 * 1000)).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/cache.test.ts -t "honours a caller-supplied TTL"`
Expected: FAIL — `getCachedReview` currently takes 2 args; the 1-day call still returns the cached review (hardcoded 7-day TTL).

- [ ] **Step 3: Write minimal implementation**

In `src/cache/cache.ts`, change the signature and drop the constant. Replace lines 37-49:

```ts
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function getCachedReview(
  repoRoot: string,
  key: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<CachedReview | null> {
  const p = reviewCachePath(repoRoot, key);
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, "utf8")) as { ts: number; review: CachedReview };
    if (Date.now() - o.ts > ttlMs) return null;
    return o.review;
  } catch {
    return null;
  }
}
```

In `src/core/orchestrator.ts:407`, pass the configured TTL. The verified accessor at this call site is `this.input.config` (see `orchestrator.ts:394` `this.input.config.cache.enabled`). Change:

```ts
const cached = await getCachedReview(repo, cacheKey);
```

to:

```ts
const cached = await getCachedReview(
  repo,
  cacheKey,
  this.input.config.cache.reviewTtlDays * 24 * 60 * 60 * 1000,
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/cache.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS, clean typecheck, clean lint.

- [ ] **Step 5: Commit**

```bash
git add src/cache/cache.ts src/core/orchestrator.ts tests/unit/cache.test.ts
git commit -m "fix(cache): honour cache.reviewTtlDays instead of hardcoded 7-day TTL"
```

---

### Task 2: Unparseable reviewer output → ERROR, not PASS (Issue B)

When codex/opencode exit 0 but emit output that `parseReviewOutput` can't parse (truncated, malformed, no `findings` array), the adapter currently yields `findings:[]` → verdict `PASS` with `status:"ok"`. That is a silent gate pass on a review that never actually happened, and it counts as a successful run so the `okRuns===0` fail-closed guard (`orchestrator.ts:793`) never fires. A successful-exit-but-unparseable run must be `ERROR` (`status:"error"` → excluded from `okRuns`, `orchestrator.ts:744`).

**Files:**
- Modify: `src/providers/codex.ts:145-169, 274-289`
- Modify: `src/providers/opencode.ts:125-149`
- Test: `tests/unit/codex-adapter.test.ts`, `tests/unit/opencode-adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

The adapters parse a file written by the fake CLI. Check each test file's existing fixture pattern (how it points the adapter at a fake binary and what file it reads) and mirror it. Add a test where the fake CLI exits 0 but writes garbage to the output file.

For `tests/unit/codex-adapter.test.ts` (the fake writes to `--output-last-message`):

```ts
it("exit 0 with unparseable last-message → verdict ERROR (not empty PASS)", async () => {
  // Fake codex that exits 0 but writes non-JSON to the last-message file.
  // Reuse the test's existing fake-binary harness; the only change vs. the
  // happy-path fixture is the last-message body = "this is not json".
  const res = await runCodexWithLastMessage("this is not json{{{");
  expect(res.verdict).toBe("ERROR");
  expect(res.status).toBe("error");
  expect(res.findings).toEqual([]);
});
```

If the file has no reusable `runCodexWithLastMessage` helper, write a fixture shell script under `tests/fixtures/` modelled on `tests/fixtures/fake-codex.sh` but with `cat > "$LAST_MSG" <<'JSON'\nnot json\nJSON` and point a `CodexAdapter({ binPath })` at it, as `loop-driver.test.ts:25` does with `FAKE_CODEX`.

For `tests/unit/opencode-adapter.test.ts` (the adapter reads `stdout`):

```ts
it("exit 0 with unparseable stdout → verdict ERROR (not empty PASS)", async () => {
  // Fake opencode that prints non-JSON to stdout and exits 0.
  const res = await runOpencodeWithStdout("garbage, not a review");
  expect(res.verdict).toBe("ERROR");
  expect(res.status).toBe("error");
  expect(res.findings).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/codex-adapter.test.ts tests/unit/opencode-adapter.test.ts -t "unparseable"`
Expected: FAIL — current behaviour returns `verdict:"PASS"`, `status:"ok"`.

- [ ] **Step 3: Write minimal implementation**

In `src/providers/codex.ts`, change `extractFindings` (lines 274-289) to return `Finding[] | null` (`null` = could not read or parse):

```ts
private extractFindings(
  lastMsgFile: string,
  model: string,
  persona: string,
  workingDir: string,
): Finding[] | null {
  let raw: string;
  try {
    raw = readFileSync(lastMsgFile, "utf8");
  } catch {
    return null; // exit 0 but no readable output → not a real review
  }
  const out = parseReviewOutput(raw);
  if (!out) return null; // unparseable → not a real review (was: [] → silent PASS)
  return mapReviewOutputToFindings(out, { provider: "codex", model, persona, workingDir });
}
```

Then in `review()` (after line 145), handle `null` before building the PASS/FAIL return:

```ts
const usage = this.extractUsage(eventsFile);
const findings = this.extractFindings(
  lastMsgFile,
  input.cfg.model,
  input.persona,
  input.workingDir,
);
if (findings === null) {
  return {
    reviewerId: input.reviewerId,
    verdict: "ERROR",
    findings: [],
    usage,
    durationMs: res.durationMs,
    exitCode: res.exitCode,
    rawEventsPath: eventsFile,
    status: "error",
    statusDetail: "reviewer exited 0 but produced no valid review JSON (unparseable output)",
  };
}
```

Leave the existing `verdict: findings.some(...) ? "FAIL" : "PASS"` return below unchanged — it now only runs on a genuinely parsed review (`findings` is a real array, possibly empty).

In `src/providers/opencode.ts`, replace lines 125-134:

```ts
const stdout = readFileSync(stdoutFile, "utf8");
const out = parseReviewOutput(stdout);
if (!out) {
  return {
    reviewerId: input.reviewerId,
    verdict: "ERROR",
    findings: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
    durationMs: res.durationMs,
    exitCode: res.exitCode,
    rawEventsPath: stdoutFile,
    status: "error",
    statusDetail: "reviewer exited 0 but produced no valid review JSON (unparseable output)",
  };
}
const findings = mapReviewOutputToFindings(out, {
  provider: "opencode",
  model: input.cfg.model,
  persona: input.persona,
  workingDir: input.workingDir,
});
```

Leave the subsequent `return { ... verdict: findings.some(...) ... status: "ok" }` block unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/codex-adapter.test.ts tests/unit/opencode-adapter.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS. A legit zero-findings review (valid JSON `{"verdict":"PASS","findings":[]}`) still parses → `PASS`; only unparseable output becomes `ERROR`. The `loop-driver.test.ts` tests using `fake-codex.sh` (which writes valid JSON) are unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/providers/codex.ts src/providers/opencode.ts tests/unit/codex-adapter.test.ts tests/unit/opencode-adapter.test.ts
git commit -m "fix(providers): exit-0 but unparseable reviewer output → ERROR not silent PASS"
```

---

### Task 3: Wire `softPassPolicy` (allow | block | ask-once) (Issue A)

`config.loop.softPassPolicy` is validated and defaulted (`define-config.ts:121`, `defaults.ts:110`) but never read. `loop-driver.ts:457` and `:476` bucket `SOFT-PASS` with `PASS` unconditionally. SOFT-PASS = WARN findings present, none reaching the hard-FAIL bar (`aggregator.ts:367`). Wire the three policies:

- `"allow"` (default): behave exactly as today — re-arm, delete dirty flag, open the gate.
- `"block"`: treat SOFT-PASS like FAIL — block with the panel summary, require a decision per WARN finding (the decisions-gate already reads `pending.json`, which `writeReport` populates with the WARN findings), advance `iteration`. Do NOT re-arm.
- `"ask-once"`: re-arm + delete dirty flag (like PASS), but force a single informational block surfacing the warnings; because the dirty flag is deleted, the agent's re-stop hits the "no changes" branch and allows the stop — one block, no loop. (Same mechanic as `acknowledgePass`; no new state field needed.)

**Files:**
- Modify: `src/core/loop-driver.ts:457, 475-504`
- Modify: `src/core/orchestrator.ts:406-408` (cache-hit guard — see Step 3b)
- Test: `tests/unit/loop-driver.test.ts`

> **Why a cache change is needed here:** a cached SOFT-PASS stores only verdict+counts, not findings (`cache.ts:28-30`), and the cache-hit path writes `pending.json` with EMPTY findings (`orchestrator.ts:409` → `writeReport(opts, start, [], [], cached.verdict, cached.counts)`). Under `softPassPolicy="block"` the decisions-gate reads `pending.json` findings (`loop-driver.ts:78-96` `previousFindingIds`) and would find none — so it could never require decisions on the WARNs, blocking with WARN counts the agent cannot satisfy (looping until the iter-cap escalation). Fix: don't serve a cached SOFT-PASS when the policy is `block`; fall through to a real panel run that repopulates `pending.json` with the WARN findings.

- [ ] **Step 1: Write the failing tests**

`LoopInput.orchestrator` is typed as `IterationRunner` (`orchestrator.ts:95`), so inject a stub returning a SOFT-PASS result. Mirror the `PASS_RESULT`/`PASS_SUMMARY` fixtures in `tests/unit/gate-deadline.test.ts:18-35`. Add to `tests/unit/loop-driver.test.ts`:

```ts
import type { IterationResult } from "../../src/core/orchestrator.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";

const SOFT_SUMMARY: RunSummary = {
  verdict: "SOFT-PASS",
  source: "panel",
  counts: { critical: 0, warn: 1, info: 0 },
  cost_usd: 0,
  duration_ms: 1,
  demoted: 0,
  signatures: ["sig-w1"],
  providers: [],
};
const SOFT_RESULT: IterationResult = {
  verdict: "SOFT-PASS",
  costUsd: 0,
  durationMs: 1,
  signaturesThisIter: ["sig-w1"],
  summary: SOFT_SUMMARY,
};
const softOrch = { runIteration: async () => SOFT_RESULT };

function driverWithSoftPolicy(repo: string, state: StateStore, policy: "allow" | "block" | "ask-once") {
  return new LoopDriver({
    repoRoot: repo,
    config: { ...defaultConfig, loop: { ...defaultConfig.loop, softPassPolicy: policy } },
    state,
    audit: new AuditLogger(auditDir(repo)),
    orchestrator: softOrch,
    stopHookActive: false,
  });
}

it("softPassPolicy=allow: SOFT-PASS opens the gate (allow_stop)", async () => {
  const repo = fakeRepo();
  const state = new StateStore(repo);
  await state.initialise("01HXQSOFTA");
  writeDirty(repo);
  const decision = await driverWithSoftPolicy(repo, state, "allow").run();
  expect(decision.kind).toBe("allow_stop");
  expect(existsSync(dirtyFlagPath(repo))).toBe(false); // re-armed
});

it("softPassPolicy=block: SOFT-PASS blocks the turn and keeps the dirty flag", async () => {
  const repo = fakeRepo();
  const state = new StateStore(repo);
  await state.initialise("01HXQSOFTB");
  writeDirty(repo);
  const decision = await driverWithSoftPolicy(repo, state, "block").run();
  expect(decision.kind).toBe("block");
  expect(decision.reason).toContain("GATE CLOSED");
  expect(existsSync(dirtyFlagPath(repo))).toBe(true); // NOT re-armed
  expect((await state.load()).iteration).toBe(1); // advanced like a FAIL
});

it("softPassPolicy=ask-once: SOFT-PASS blocks ONCE, deletes dirty flag (re-stop allows)", async () => {
  const repo = fakeRepo();
  const state = new StateStore(repo);
  await state.initialise("01HXQSOFTC");
  writeDirty(repo);
  const decision = await driverWithSoftPolicy(repo, state, "ask-once").run();
  expect(decision.kind).toBe("block");
  expect(decision.reason).toContain("SOFT-PASS");
  expect(existsSync(dirtyFlagPath(repo))).toBe(false); // re-armed → re-stop is clean → allows
  expect((await state.load()).iteration).toBe(0); // re-armed, not advanced
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/loop-driver.test.ts -t "softPassPolicy"`
Expected: FAIL — `block` and `ask-once` currently both open the gate (allow_stop, dirty flag deleted, iteration 0).

- [ ] **Step 3: Write minimal implementation**

In `src/core/loop-driver.ts`, just before line 457 compute the policy split:

```ts
const softPolicy = this.i.config.loop.softPassPolicy;
// "block" demotes SOFT-PASS to a FAIL-like blocking outcome (address the WARNs);
// "allow"/"ask-once" keep SOFT-PASS passing (re-arm). PASS always passes.
const softPassBlocks = result.verdict === "SOFT-PASS" && softPolicy === "block";
const passed = (result.verdict === "PASS" || result.verdict === "SOFT-PASS") && !softPassBlocks;
```

Line 457 (`const passed = result.verdict === "PASS" || result.verdict === "SOFT-PASS";`) is replaced by the block above. The state-update block at 458-473 already keys off `passed`, so a `block`-policy SOFT-PASS now advances `iteration`/cost like a FAIL — no change needed there.

Replace the decision branch condition at line 476. Change `if (result.verdict === "PASS" || result.verdict === "SOFT-PASS") {` to `if (passed) {`. Inside that branch, extend the `acknowledgePass` decision (lines 496-504) so `ask-once` forces the one-time block:

```ts
const forceSoftAck = result.verdict === "SOFT-PASS" && softPolicy === "ask-once";
decision =
  this.i.config.loop.acknowledgePass || forceSoftAck
    ? {
        kind: "block",
        reason: forceSoftAck
          ? `🟡 Reviewgate · GATE OPEN — ⚠️ SOFT-PASS (iteration ${nextIter}): ${formatPanelSummary(result.summary)}. These are non-blocking warnings — review them in .reviewgate/pending.md, then end your turn again to accept and pass through.`
          : `🟢 Reviewgate · GATE OPEN — ✅ ${result.verdict} (iteration ${nextIter}). Review is clean, no findings to address. No action needed: simply end your turn again to pass through (you may briefly confirm the pass to the user first).`,
      }
    : {
        kind: "allow_stop",
        reason: `🟢 Reviewgate · GATE OPEN — ${result.verdict} (iteration ${nextIter}). Clear to finish.`,
      };
```

The `else if (result.verdict === "ERROR")` and final `else` (FAIL) branches are unchanged: a `block`-policy SOFT-PASS has `passed===false` and `verdict==="SOFT-PASS"` (not ERROR), so it falls through to the final FAIL branch (lines 515-519), producing the "GATE CLOSED — iteration … record a decision per CRITICAL/WARN finding" block. That is exactly the desired behaviour.

- [ ] **Step 3b: Guard the cache-hit so block-policy SOFT-PASS isn't served empty**

In `src/core/orchestrator.ts`, change the cache-hit condition (line 408). Replace:

```ts
if (cached && (cached.verdict === "PASS" || cached.verdict === "SOFT-PASS")) {
```

with:

```ts
// A cached SOFT-PASS stores only counts, not findings (cache.ts), so serving it
// writes pending.json with no findings. Under softPassPolicy="block" the
// decisions-gate needs the WARN findings to require decisions on — so don't
// serve a cached SOFT-PASS then; fall through to a real panel run that
// repopulates pending.json. PASS (no findings) and allow/ask-once SOFT-PASS
// (no decisions required) are still served from cache.
const softPassBlocksCache = this.input.config.loop.softPassPolicy === "block";
if (
  cached &&
  (cached.verdict === "PASS" || (cached.verdict === "SOFT-PASS" && !softPassBlocksCache))
) {
```

- [ ] **Step 3c: Add the cache-guard regression test**

Add to `tests/unit/loop-driver.test.ts` (or `tests/unit/orchestrator*.test.ts` if you prefer testing the orchestrator directly — pick whichever harness can seed a cache entry; the orchestrator-level test is more direct). The intent: with `softPassPolicy="block"` and a pre-seeded cached SOFT-PASS, the panel must actually run (cache NOT served), so the resulting `pending.json` has the WARN findings. If seeding the cache is awkward in the loop-driver harness, assert at the orchestrator level that `runIteration` with a seeded SOFT-PASS cache entry and `softPassPolicy:"block"` returns a result whose `summary.source === "panel"` (not `"cache"`). Document the chosen assertion in the test name.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/loop-driver.test.ts tests/unit/orchestrator*.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS (including the pre-existing `acknowledgePass` tests, which use PASS not SOFT-PASS and are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/core/loop-driver.ts src/core/orchestrator.ts tests/unit/loop-driver.test.ts
git commit -m "fix(loop): honour loop.softPassPolicy (block/ask-once); don't serve cached SOFT-PASS under block"
```

---

### Task 4: `loadOrRecover` distinguishes I/O errors from corruption (Issue G)

`StateStore.loadOrRecover` (`state-store.ts:32-43`) catches *every* error from `load()` and wipes the gating state (renames the file aside, re-initialises). A transient I/O error (EBUSY, AV lock, network FS) on `readFileSync` is then misclassified as corruption, discarding the iteration counter, cost, and escalation status. Only `JSON.parse`/schema failures are genuine corruption; real I/O errors must propagate (the gate fails loudly rather than silently resetting).

**Files:**
- Modify: `src/core/state-store.ts:1-2, 29-44`
- Test: `tests/unit/state-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/state-store.test.ts`:

```ts
import { ZodError } from "zod";

it("recovers on corrupt JSON (parse error) — backs up and re-initialises", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-state-corrupt-"));
  const store = new StateStore(repo);
  await store.initialise("01HXQSEED");
  writeFileSync(stateJsonPath(repo), "{ not valid json");
  const recovered = await store.loadOrRecover("01HXQNEW");
  expect(recovered.recovered_from).toBe("corruption");
  expect(recovered.iteration).toBe(0);
});

it("rethrows a genuine I/O error instead of wiping state", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-state-io-"));
  const store = new StateStore(repo);
  await store.initialise("01HXQSEED2");
  // Force load() to throw a non-parse, non-schema error. `load` is a public
  // method, so reassigning it is type-compatible — NO @ts-expect-error (an unused
  // one would fail `bunx tsc --noEmit` under the repo's tests/** type-checking).
  const ioErr = Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
  const orig = store.load.bind(store);
  store.load = async () => {
    throw ioErr;
  };
  await expect(store.loadOrRecover("01HXQNEW2")).rejects.toThrow("EBUSY");
  store.load = orig;
});
```

Ensure `stateJsonPath` is imported in the test (check the existing imports at the top of the file; add it from `../../src/utils/paths.ts` if missing).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/state-store.test.ts -t "I/O error"`
Expected: FAIL — current code swallows the EBUSY error and returns a fresh `recovered_from:"corruption"` state instead of rethrowing.

- [ ] **Step 3: Write minimal implementation**

In `src/core/state-store.ts`, import `ZodError` (add to line 1-2 region):

```ts
import { ZodError } from "zod";
```

Replace `loadOrRecover` (lines 29-44):

```ts
async loadOrRecover(sessionId: string): Promise<ReviewgateState> {
  const p = stateJsonPath(this.repoRoot);
  if (!existsSync(p)) return this.initialise(sessionId);
  try {
    return await this.load();
  } catch (err) {
    // Only treat genuine content corruption as recoverable: malformed JSON
    // (SyntaxError) or a schema mismatch (ZodError). A transient I/O error
    // (EBUSY / AV lock / network FS) must NOT be misread as corruption — wiping
    // the gating history on a momentary read failure is far worse than failing
    // loudly, so rethrow and let the gate surface the error.
    const isCorruption = err instanceof SyntaxError || err instanceof ZodError;
    if (!isCorruption) throw err;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${p}.corrupt.${ts}.json`;
    renameSync(p, backup);
    const fresh = initialState(sessionId);
    fresh.recovered_from = "corruption";
    await this.writeAtomic(fresh);
    return fresh;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/state-store.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS — corrupt JSON still recovers; the injected EBUSY rethrows.

- [ ] **Step 5: Commit**

```bash
git add src/core/state-store.ts tests/unit/state-store.test.ts
git commit -m "fix(state): recover only on parse/schema corruption, rethrow transient I/O errors"
```

---

### Task 5: Atomic cooldown writes (Issue F)

`QuotaCooldownStore.write` (`quota-cooldown.ts:80-84`) writes `quota-cooldowns.json` directly with `writeFileSync` — no tmp+rename — unlike `StateStore.writeAtomic`. A process killed mid-write leaves a truncated file. The read path already fails safe (corrupt → `EMPTY`), so impact is low, but the write should be atomic for consistency. (No file lock added here — the design is single-writer-per-run, `quota-cooldown.ts:60-64`; cross-run serialization is covered by Task 7's gate lock.)

**Files:**
- Modify: `src/core/quota-cooldown.ts:7, 80-84`
- Test: `tests/unit/quota-cooldown.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/quota-cooldown.test.ts`:

```ts
import { existsSync, readdirSync } from "node:fs";

it("write leaves no stray .tmp file and produces valid JSON (atomic)", () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-cooldown-atomic-"));
  const store = new QuotaCooldownStore(repo);
  const now = new Date();
  store.record("codex", new Date(now.getTime() + 60_000).toISOString(), now, "parsed");
  const dir = join(repo, ".reviewgate");
  const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
  expect(leftovers).toEqual([]);
  // File is readable + the cooldown is active.
  expect(store.activeUntil("codex", now)).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails (or guards the change)**

Run: `bun test tests/unit/quota-cooldown.test.ts -t "atomic"`
Expected: with the current direct write there is no `.tmp` leftover either, so this test PASSES today — it is a *guard* that the atomic rewrite keeps the temp file from leaking. Confirm it passes before AND after Step 3 (the value is preventing a regression where the tmp isn't cleaned up). If you prefer a strictly-failing test, skip this guard test and rely on the typecheck + full suite; the change is mechanical.

- [ ] **Step 3: Write minimal implementation**

In `src/core/quota-cooldown.ts`, add `renameSync` to the import (line 7):

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
```

Replace `write` (lines 80-84):

```ts
private write(c: QuotaCooldown): void {
  const dir = dirname(this.path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Atomic: write to a unique temp, then rename into place — a process killed
  // mid-write can never leave a truncated quota-cooldowns.json (mirrors
  // StateStore.writeAtomic). Unique suffix so concurrent writers don't share a tmp.
  const tmp = `${this.path}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  renameSync(tmp, this.path);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/quota-cooldown.test.ts tests/unit/orchestrator-cooldown.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/quota-cooldown.ts tests/unit/quota-cooldown.test.ts
git commit -m "fix(cooldown): atomic tmp+rename write for quota-cooldowns.json"
```

---

### Task 6: Unique tempname for the dirty-flag write (Issue D)

`handleTrigger` (`handlers.ts:36`) writes to a fixed `${p}.tmp` before renaming. Two PostToolUse triggers racing on the same checkout share that temp path and can clobber each other (torn write / wrong `base_sha`). The write is already atomic via rename; only the temp name needs to be unique.

**Files:**
- Modify: `src/hooks/handlers.ts:36-40`
- Test: `tests/unit/handlers.test.ts` (create if absent; otherwise add to the existing handlers test)

- [ ] **Step 1: Write the failing test**

Check whether a handlers test exists: `ls tests/unit | grep -i handler`. If none, create `tests/unit/handlers.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTrigger } from "../../src/hooks/handlers.ts";
import { dirtyFlagPath, reviewgateDir } from "../../src/utils/paths.ts";

describe("handleTrigger", () => {
  it("concurrent triggers leave no stray .tmp and a valid dirty.flag", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-trigger-"));
    mkdirSync(reviewgateDir(repo), { recursive: true });
    await Promise.all([
      handleTrigger({ repoRoot: repo, hookStdinRaw: '{"a":1}' }),
      handleTrigger({ repoRoot: repo, hookStdinRaw: '{"b":2}' }),
      handleTrigger({ repoRoot: repo, hookStdinRaw: '{"c":3}' }),
    ]);
    const dir = reviewgateDir(repo);
    const tmps = readdirSync(dir).filter((f) => f.includes("dirty.flag.") && f.endsWith(".tmp"));
    expect(tmps).toEqual([]); // every unique temp cleaned up by its rename
    // The final dirty.flag is valid JSON.
    const body = JSON.parse(readFileSync(dirtyFlagPath(repo), "utf8")) as { diff_hash?: string };
    expect(typeof body.diff_hash).toBe("string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or guards the change)**

Run: `bun test tests/unit/handlers.test.ts -t "concurrent triggers"`
Expected: with a fixed `.tmp` this can intermittently leave a stray temp or a torn flag under contention; the unique-name fix makes it deterministic. (Bun runs these effectively serially via the event loop, so this primarily guards against a regression — acceptable per plan.)

- [ ] **Step 3: Write minimal implementation**

In `src/hooks/handlers.ts`, replace lines 36-40:

```ts
const tmp = `${p}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
writeFileSync(tmp, body, { mode: 0o600 });
const { renameSync } = await import("node:fs");
renameSync(tmp, p);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/handlers.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/handlers.ts tests/unit/handlers.test.ts
git commit -m "fix(hooks): unique tempname for dirty.flag write to avoid parallel-trigger clobber"
```

---

### Task 7: Global lock around the stop-hook run (Issue C)

`StateStore.update` locks only individual state writes. There is no lock around the whole stop pipeline (`runGate` `hook==="stop"` → `LoopDriver.run()` → `Orchestrator.runIteration` → `writeReport`). Two stop-hooks on the same checkout (the discouraged two-sessions-one-checkout case) could run reviews in parallel and interleave writes to `pending.*`, decisions, and the dirty flag. Serialize the stop pipeline with the existing `flock` (dead-pid reclaim, atomic link protocol). On lock-acquire timeout, fail CLOSED (block "another gate run is in progress — re-run") — never allow an unreviewed turn through.

**Files:**
- Modify: `src/cli/commands/gate.ts:5-16 (imports), 54-160 (stop branch)`
- Test: `tests/unit/gate-lock.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/gate-lock.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/cli/commands/gate.ts";
import { flock } from "../../src/utils/flock.ts";
import { dirtyFlagPath } from "../../src/utils/paths.ts";
import { gateLockPath } from "../../src/utils/paths.ts";

describe("gate stop-hook lock", () => {
  it("fails CLOSED (block) when the gate lock is already held", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-gate-lock-"));
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    // Hold the lock so runGate cannot acquire it within its short test timeout.
    const held = await flock(gateLockPath(repo));
    try {
      const out = await runGate({
        repoRoot: repo,
        hook: "stop",
        hookStdinRaw: "{}",
        lockTimeoutMs: 200, // tiny acquire timeout → fails closed fast while the lock is held
      });
      const parsed = JSON.parse(out.stdout || "{}") as { decision?: string; reason?: string };
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("in progress");
    } finally {
      await held.release();
    }
  });
});
```

Note: the test passes `lockTimeoutMs: 200` so it fails closed in ~200ms while the lock is held (the production default is the short `GATE_LOCK_ACQUIRE_TIMEOUT_MS` constant added in Step 3). `gateLockPath` must be exported from `src/utils/paths.ts` (added in Step 3).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/gate-lock.test.ts`
Expected: FAIL to compile/run — `gateLockPath` does not exist yet and `runGate` does not lock.

- [ ] **Step 3: Write minimal implementation**

Add a lock path helper in `src/utils/paths.ts` (next to `lockPath`):

```ts
export function gateLockPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "gate.lock");
}
```

(Confirm the exact local style in `paths.ts` — reuse its `reviewgateDir`/`join` pattern.)

In `src/cli/commands/gate.ts`, import the lock + path:

```ts
import { flock } from "../../utils/flock.ts";
import { auditDir, dirtyFlagPath, gateLockPath } from "../../utils/paths.ts";
```

Add `lockTimeoutMs?: number` to `GateInput`. Define a SHORT default acquire timeout near the top of `gate.ts` (module scope):

```ts
// Lock-ACQUIRE timeout for the stop-hook gate lock. Deliberately short and NOT
// tied to loop.runTimeoutMs (840_000ms default): a contended gate may run a
// full multi-minute review while holding the lock, and waiting that long would
// let the OS Stop-hook timeout KILL this process before it can emit the
// fail-closed block (→ fail OPEN). Instead we give up quickly and fail CLOSED
// with a "re-run" block; the agent's re-stop retries, bounded by the holder's
// own self-deadline. 10s is well under any reasonable Stop-hook timeout.
const GATE_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
```

Wrap the entire `hook === "stop"` body (from `const parsedStdin = ...` through `return ...allow_stop...`) in a lock acquire/finally. Acquire just before the stop work begins:

```ts
// hook === 'stop' — serialize the whole pipeline so two stop-hooks on the same
// checkout can't run reviews in parallel and interleave writes to pending.*,
// decisions, and the dirty flag. Fail CLOSED on contention (never allow an
// unreviewed turn through).
let lock: { release: () => Promise<void> };
try {
  lock = await flock(
    gateLockPath(input.repoRoot),
    input.lockTimeoutMs ?? GATE_LOCK_ACQUIRE_TIMEOUT_MS,
  );
} catch {
  const reason =
    "🔴 Reviewgate · GATE CLOSED — another gate run is in progress (could not acquire gate lock). Re-run to review after it finishes.";
  return { exitCode: 0, stdout: JSON.stringify({ decision: "block", reason }), stderr: reason };
}
try {
  // ... existing stop-hook body (parsedStdin … driver.run() … decision …) ...
  // (move the existing code here unchanged; return its existing GateOutput)
} finally {
  await lock.release();
}
```

Keep the two existing `return` statements (block / allow_stop) inside the `try`. The `finally` releases the lock on every path including throws.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/gate-lock.test.ts tests/unit/gate-deadline.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS. Single-session runs are unaffected (uncontended lock acquires instantly).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/gate.ts src/utils/paths.ts tests/unit/gate-lock.test.ts
git commit -m "fix(gate): serialize the stop-hook run with a gate lock, fail closed on contention"
```

---

## Final Verification (after all tasks)

- [ ] **Full suite + static checks**

Run: `bunx tsc --noEmit && bun run lint && bun test`
Expected: all green. If any provider-touching test regressed because it relied on the old "unparseable → PASS" behaviour, that is the intended change — update the test's expectation to `ERROR`, don't revert the fix.

- [ ] **Reviewgate dogfood gate** — this repo runs its own gate on your turns. Address or reject each finding per `docs/AGENTS.md`; do not bypass.

---

## Self-Review Notes

- **Spec coverage:** All 7 verified issues map to a task (see Issue → Task Map). Both rounds of agent findings are covered: round 1 (#1 softPassPolicy=Task 3, #2 cooldown=Task 5, #3 state-reset=Task 4); round 2 (#2 unparseable=Task 2, #3 softPassPolicy=Task 3, #4 global lock=Task 7, #5 dirty.flag tmp=Task 6, #6 cache TTL=Task 1).
- **Type consistency:** `getCachedReview(repoRoot, key, ttlMs?)` used identically in Task 1 test + impl + orchestrator call site. `extractFindings(): Finding[] | null` returns `null` on both read and parse failure in Task 2. `softPassBlocks`/`passed`/`forceSoftAck` (loop-driver) and `softPassBlocksCache` (orchestrator) are the only new locals in Task 3. `gateLockPath` defined in `paths.ts` and used in both Task 7 test and impl. Verified accessor: `this.input.config` (NOT `this.cfg`).
- **Codex plan-review (gpt-5.5) incorporated:** 2 CRITICAL + 2 WARN, all verified against source and fixed in-plan — cached SOFT-PASS empty-findings gap under `block` (Task 3 Step 3b/3c), lock-timeout default too long → fail-open (Task 7 `GATE_LOCK_ACQUIRE_TIMEOUT_MS=10s`), accessor `this.input.config` (Task 1), unused `@ts-expect-error` (Task 4). Codex confirmed Tasks 2/5/6 and the non-cache parts of Task 3 as correct.
- **Open verification point flagged inline (do not skip):** confirm/realign provider adapter test harnesses (fake-binary fixture pattern) before Task 2.
