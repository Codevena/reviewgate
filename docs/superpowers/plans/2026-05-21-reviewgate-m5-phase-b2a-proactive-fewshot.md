# M5 Phase B2a — Proactive Negative Few-Shot + Combined Behavior-Hash — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject active/sticky FP-ledger entries that match the changed files into the reviewer preamble ("Known false positives — do NOT re-report"), and route the brain + FP cache contributions through one structured behavior-hash (replacing B1's ad-hoc string append).

**Architecture:** B1 already computes `fpActiveSnapshot` (post learn/decay, before the cache read) and folds an ad-hoc `|fp:<sig:id:stage>` segment into the cache key. B2a (1) adds a pure `buildFpFewShot()` that turns the changed-file-matching subset of that snapshot into a trusted preamble block, injected alongside `## Brain context`; and (2) extracts a tested `computeBehaviorHash({brain, fp})` helper that both the brain and FP contributions flow through — FP keyed on `{signature, stage}` (the behavior-affecting fields; `id`/`pattern_id` is cosmetic), and **empty FP reproduces the exact pre-B1 brain-only hash so existing cache keys are preserved** when fpLedger is off.

**Tech Stack:** Bun + TS, zod, `bun test`, biome. `export PATH="$HOME/.bun/bin:$PATH"`. Runs in a git worktree branched from local `master` HEAD (via superpowers:using-git-worktrees, manual fallback at a sibling path — origin is intentionally stale, so do NOT let the worktree branch from origin). Prerequisite: Phase B1 merged (`fpActiveSnapshot`, `FpLedgerEntry`, the aggregator fp-demote stage all exist).

---

## File structure
- **Create** `src/cache/behavior-hash.ts` — `computeBehaviorHash({ brain, fp })` (pure, deterministic).
- **Create** `src/core/fp-ledger/few-shot.ts` — `buildFpFewShot({ active, changedFiles, budgetBytes? })` (pure).
- **Create** `tests/unit/behavior-hash.test.ts`, `tests/unit/fp-few-shot.test.ts`.
- **Modify** `src/core/orchestrator.ts` — replace the ad-hoc cache append with `computeBehaviorHash`; build + inject the FP few-shot section into `promptParts`.
- **Modify** `tests/integration/fp-ledger-pipeline.test.ts` — assert the few-shot text reaches the reviewer prompt; assert the cache still invalidates with the refactored hash.

---

## Task 1: Combined behavior-hash helper

**Files:** Create `src/cache/behavior-hash.ts`; Test `tests/unit/behavior-hash.test.ts`

The cache key currently does `providerVersions: fpActiveHash ? \`${brainActiveHash}|fp:${fpActiveHash}\` : brainActiveHash` inline in the orchestrator, where `brainActiveHash` = brain entries' `id:status` sorted+joined and `fpActiveHash` = `signature:id:stage` sorted+joined. Extract this into one structured, tested helper. **Invariant to preserve:** when `fp` is empty the result MUST equal the pre-B1 brain-only string (so caches for brain-only / fpLedger-off repos are byte-identical). The FP segment is keyed on `{signature, stage}` only — `id` is cosmetic (`fp_ledger_match.pattern_id`) and must not perturb the cache.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/behavior-hash.test.ts
import { describe, expect, it } from "bun:test";
import { computeBehaviorHash } from "../../src/cache/behavior-hash.ts";

describe("computeBehaviorHash", () => {
  it("is empty when both inputs are empty", () => {
    expect(computeBehaviorHash({ brain: [], fp: [] })).toBe("");
  });

  it("empty fp reproduces the brain-only id:status hash (cache continuity)", () => {
    const brain = [
      { id: "B-2", status: "active" },
      { id: "B-1", status: "candidate" },
    ];
    // exact legacy format: `${id}:${status}` sorted, comma-joined
    expect(computeBehaviorHash({ brain, fp: [] })).toBe("B-1:candidate,B-2:active");
  });

  it("appends an fp segment keyed on signature:stage (sorted), id is ignored", () => {
    const fpA = computeBehaviorHash({
      brain: [],
      fp: [
        { signature: "sigB", stage: "active", id: "FP-002" },
        { signature: "sigA", stage: "sticky", id: "FP-001" },
      ],
    });
    expect(fpA).toBe("|fp:sigA:sticky,sigB:active");
    // changing only the cosmetic id does NOT change the hash
    const fpB = computeBehaviorHash({
      brain: [],
      fp: [
        { signature: "sigB", stage: "active", id: "FP-999" },
        { signature: "sigA", stage: "sticky", id: "FP-998" },
      ],
    });
    expect(fpB).toBe(fpA);
  });

  it("a stage change DOES change the hash", () => {
    const before = computeBehaviorHash({ brain: [], fp: [{ signature: "s", stage: "active", id: "FP-1" }] });
    const after = computeBehaviorHash({ brain: [], fp: [{ signature: "s", stage: "sticky", id: "FP-1" }] });
    expect(after).not.toBe(before);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/unit/behavior-hash.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// src/cache/behavior-hash.ts
//
// Single structured behavior-hash for the review cache key. Both the brain's
// active-entry identity and the FP-ledger's active/sticky identity flow through
// here so a change in either deterministically invalidates a cached PASS/SOFT-PASS
// (a cached pass otherwise short-circuits BEFORE few-shot injection and the
// reactive fp-demote run). Keep the brain-only output byte-identical to the
// pre-B1 `id:status` format so existing cache keys are preserved when the
// FP-ledger is off or empty.

export interface BrainHashEntry {
  id: string;
  status: string;
}
// `id` is intentionally excluded — it only feeds the cosmetic fp_ledger_match
// .pattern_id and must not perturb the cache. Verdict behavior depends solely on
// which signatures are demoted (and at what stage).
export interface FpHashEntry {
  signature: string;
  stage: string;
  id?: string;
}

export function computeBehaviorHash(input: {
  brain: BrainHashEntry[];
  fp: FpHashEntry[];
}): string {
  const brainPart = input.brain
    .map((e) => `${e.id}:${e.status}`)
    .sort()
    .join(",");
  if (input.fp.length === 0) return brainPart;
  const fpPart = input.fp
    .map((e) => `${e.signature}:${e.stage}`)
    .sort()
    .join(",");
  return `${brainPart}|fp:${fpPart}`;
}
```

- [ ] **Step 4: Run to verify it passes** — `bun test tests/unit/behavior-hash.test.ts` → PASS (4 tests).
- [ ] **Step 5: typecheck + lint + commit** — `bun run typecheck && bun run lint` clean; `git add -A && git commit -m "feat(cache): single structured behavior-hash (brain + FP)"`

---

## Task 2: FP negative few-shot builder

**Files:** Create `src/core/fp-ledger/few-shot.ts`; Test `tests/unit/fp-few-shot.test.ts`

Pure function: from the active/sticky snapshot (signature → entry), keep only entries whose `file` is one of the changed files, and render a trusted preamble block. Empty input (or no file match) → `""` (so the orchestrator pushes nothing). Byte-budget-bounded like brain context: accumulate lines until the budget, then stop and append a `(+N more)` tail. The entry has no original message — render the available identity (`file`, `rule_id`, `category`, optional `symbol`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/fp-few-shot.test.ts
import { describe, expect, it } from "bun:test";
import { buildFpFewShot } from "../../src/core/fp-ledger/few-shot.ts";
import type { FpLedgerEntry } from "../../src/schemas/fp-ledger.ts";

function entry(over: Partial<FpLedgerEntry>): FpLedgerEntry {
  return {
    id: "FP-001",
    signature: "sig",
    rule_id: "magic-number",
    category: "quality",
    file: "src/a.ts",
    symbol: "foo",
    stage: "active",
    rejects: [],
    distinct_providers: ["codex", "gemini"],
    first_seen_at: "t",
    last_seen_at: "t",
    created_at: "t",
    ...over,
  };
}

describe("buildFpFewShot", () => {
  it("returns empty string when there are no active entries", () => {
    expect(buildFpFewShot({ active: new Map(), changedFiles: ["src/a.ts"] })).toBe("");
  });

  it("returns empty string when no active entry matches a changed file", () => {
    const active = new Map([["sig", entry({ file: "src/other.ts" })]]);
    expect(buildFpFewShot({ active, changedFiles: ["src/a.ts"] })).toBe("");
  });

  it("renders matching entries with file + rule + category + symbol", () => {
    const active = new Map([["sig", entry({ file: "src/a.ts", rule_id: "magic-number", category: "quality", symbol: "foo" })]]);
    const text = buildFpFewShot({ active, changedFiles: ["src/a.ts"] });
    expect(text).toContain("Known false positives");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("magic-number");
    expect(text).toContain("quality");
    expect(text).toContain("foo");
  });

  it("respects the byte budget and notes the remainder", () => {
    const active = new Map<string, FpLedgerEntry>();
    for (let i = 0; i < 50; i++) {
      active.set(`sig${i}`, entry({ id: `FP-${i}`, signature: `sig${i}`, file: "src/a.ts", rule_id: `rule-${i}` }));
    }
    const text = buildFpFewShot({ active, changedFiles: ["src/a.ts"], budgetBytes: 200 });
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(260); // budget + the (+N more) tail
    expect(text).toContain("more)");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/core/fp-ledger/few-shot.ts
import type { FpLedgerEntry } from "../../schemas/fp-ledger.ts";

const DEFAULT_BUDGET_BYTES = 1500;
const HEADER =
  "Known false positives in this repo — maintainers have confirmed these are NOT real issues. Do NOT re-report them:";

// Render the changed-file-matching subset of the active/sticky FP snapshot as a
// trusted preamble block. Pure: the orchestrator decides placement. Empty when
// nothing matches so the caller can skip the section entirely.
export function buildFpFewShot(input: {
  active: Map<string, FpLedgerEntry>;
  changedFiles: string[];
  budgetBytes?: number;
}): string {
  const budget = input.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  const changed = new Set(input.changedFiles);
  const matches = [...input.active.values()]
    .filter((e) => changed.has(e.file))
    // deterministic order: file then rule then signature
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.rule_id.localeCompare(b.rule_id) ||
        a.signature.localeCompare(b.signature),
    );
  if (matches.length === 0) return "";

  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const e of matches) {
    const line = `- ${e.file}: rule "${e.rule_id}" (${e.category})${e.symbol ? ` in ${e.symbol}` : ""}`;
    const cost = Buffer.byteLength(`${line}\n`, "utf8");
    if (used + cost > budget && lines.length > 0) {
      dropped = matches.length - lines.length;
      break;
    }
    lines.push(line);
    used += cost;
  }
  const tail = dropped > 0 ? `\n(+${dropped} more)` : "";
  return `${HEADER}\n${lines.join("\n")}${tail}`;
}
```

- [ ] **Step 4: Run to verify it passes** — `bun test tests/unit/fp-few-shot.test.ts` → PASS (4 tests).
- [ ] **Step 5: typecheck + lint + commit** — `git add -A && git commit -m "feat(fp-ledger): negative few-shot builder (changed-file-scoped, budget-bounded)"`

---

## Task 3: Wire few-shot injection + behavior-hash into the orchestrator

**Files:** Modify `src/core/orchestrator.ts`; Test `tests/integration/fp-ledger-pipeline.test.ts`

Two edits, both using the already-computed `fpActiveSnapshot` and `brainEngine` — no second ledger/brain read.

- [ ] **Step 1: Replace the ad-hoc cache append with `computeBehaviorHash`.**

Add the import (sorted into the `../cache/` group, after the `cache.ts` import):

```typescript
import { computeBehaviorHash } from "../cache/behavior-hash.ts";
```

Find the `brainActiveHash` + `fpActiveHash` block (added in B1, just before `computeCacheKey`). Replace BOTH local hashes and the `providerVersions` expression so the value flows through the helper. The brain entries come from `brainEngine.snapshotEntries()` (each has `id` + `status`); the fp entries from `fpActiveSnapshot` values (`signature` + `stage`). Concretely, replace:

```typescript
    const brainActiveHash = brainEngine
      ? brainEngine
          .snapshotEntries()
          .map((e) => `${e.id}:${e.status}`)
          .sort()
          .join(",")
      : "";

    // ...the fpActiveSnapshot read stays...
    const fpActiveHash =
      fpActiveSnapshot && fpActiveSnapshot.size > 0
        ? [...fpActiveSnapshot.values()]
            .map((e) => `${e.signature}:${e.id}:${e.stage}`)
            .sort()
            .join(",")
        : "";
```

with (keep the `fpActiveSnapshot` read line that precedes this — it is reused for few-shot + aggregate):

```typescript
    const behaviorHash = computeBehaviorHash({
      brain: brainEngine ? brainEngine.snapshotEntries().map((e) => ({ id: e.id, status: e.status })) : [],
      fp: fpActiveSnapshot
        ? [...fpActiveSnapshot.values()].map((e) => ({ signature: e.signature, stage: e.stage }))
        : [],
    });
```

and change the `computeCacheKey({...})` call's `providerVersions` field to:

```typescript
      providerVersions: behaviorHash,
```

(Leave the surrounding comment but update it to say the brain + FP identities are combined via `computeBehaviorHash`.)

- [ ] **Step 2: Build + inject the FP few-shot block** next to the brain text. Add the import (sorted into the `./fp-ledger/` group, alongside the B1 imports):

```typescript
import { buildFpFewShot } from "./fp-ledger/few-shot.ts";
```

Place this **after `fpActiveSnapshot` is computed** (the B1 read sits just before the behavior-hash / cache key — `fpActiveSnapshot` does NOT exist yet at the `brainText` block, so do not put it there) and before the prompt-assembly section. Reuse `facts.files` for the changed paths:

```typescript
    // M5 Part B2a — proactive negative few-shot: tell the panel which findings
    // this repo's maintainers have already confirmed as false positives for the
    // changed files, so they are not re-reported (complements the reactive
    // aggregator demote). Trusted context, injected before the untrusted diff
    // fence like brain context. Derived from the same active snapshot folded into
    // the behavior-hash, so the cache already accounts for it.
    const fpFewShot = fpActiveSnapshot
      ? buildFpFewShot({
          active: fpActiveSnapshot,
          changedFiles: facts.files.map((file) => file.path),
        })
      : "";
```

Then in the prompt assembly, inject it right after the brain-context push:

```typescript
      if (brainText) promptParts.push("## Brain context", brainText, "");
      if (fpFewShot) promptParts.push("## Known false positives (do not re-report)", fpFewShot, "");
```

- [ ] **Step 3: Run to verify** — `bun run typecheck && bun run lint && bun test` → clean / all pass.

- [ ] **Step 4: Add an integration assertion** that the few-shot reaches the prompt. Extend `tests/integration/fp-ledger-pipeline.test.ts` with a stub adapter that captures its prompt file. Add at the end of the `describe`:

```typescript
  it("injects active FP entries (matching a changed file) into the reviewer prompt", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fppipe-fewshot-"));
    await seedActive(repo); // active entry for sig "sigFP" on file "a.ts" (the changed file)
    let capturedPrompt = "";
    const capturing: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp) {
        capturedPrompt = readFileSync(inp.promptFile, "utf8");
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
        };
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo,
      config: configWithFpLedger(true),
      adapters: { codex: capturing },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF, // touches a.ts
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(capturedPrompt).toContain("Known false positives");
    expect(capturedPrompt).toContain("a.ts");
  });
```

- [ ] **Step 5: Run** — `bun test tests/integration/fp-ledger-pipeline.test.ts` → PASS (4 tests). Then `bun run lint` (format the new test if biome asks).
- [ ] **Step 6: commit** — `git add -A && git commit -m "feat(orchestrator): inject FP few-shot + route cache through computeBehaviorHash"`

---

## Task 4: Full-suite gate + DoD + merge

- [ ] **Step 1:** `bun test && bun run typecheck && bun run lint` → all pass / clean.
- [ ] **Step 2: DoD** (B2a touches the prompt + cache key — substantive): Codex Agent A (file-based prompt, foreground, stdin closed, review the branch diff `git diff master...HEAD`, run typecheck+lint itself) → PASS = 0 CRITICAL/WARN; fix all findings (TDD each) and re-run until clean; then Claude Agent A review subagent → PASS. `rm -rf .review/`.
- [ ] **Step 3:** FF-merge to master, rebuild binary (`bun run build`, verify it boots), remove worktree, delete branch. Ask before pushing.
- [ ] **Step 4: Real e2e** (later, in flashbuddy): with an `active` FP on a changed file, confirm the "Known false positives" block appears in the reviewer prompt and the FP is not re-reported.

---

## Self-review (spec coverage)
- Proactive negative few-shot, changed-file-matching, token/budget-aware, injected like brain context (spec §"Apply path", §"Data flow" #3) → Tasks 2 + 3. ✓
- Combined behavior-hash: brain + FP through ONE structured hash, FP covers `{signature, stage}` (not just `id:status`), computed after learn/decay + brain pin and before the cache read, existing keys preserved when off/empty (spec §"Cache — ordering contract") → Task 1 + Task 3 Step 1. ✓ (The post-learn/pre-cache-read ordering is already established in B1; B2a only changes how the hash is built, not where.)
- Reuses the single `fpActiveSnapshot` for hash + few-shot + aggregate demote (no extra IO) → Task 3. ✓
- NOT in B2a (later): CLI / decayPass-cron / reject-rate trigger (B2b), brain↔ledger coupling (B3). The reactive aggregator demote + per-run decayPass already shipped in B1.
