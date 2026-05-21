# M5 Phase B2b — FP-Ledger Operability (CLI + reject-rate-high trigger) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the FP-ledger inspectable/operable from the CLI (`reviewgate fp list/show/pin/unpin/audit`) and wire the long-defined-but-dead `reject-rate-high` escalation reasonCode so the gate escalates to a human when reviewers are producing a high rate of confirmed false positives.

**Architecture:** A new `src/cli/commands/fp.ts` (mirrors `brain.ts`: pure `run*` functions taking `{repoRoot, write?}`, returning an exit code) backed by the existing `FpLedgerStore` (`snapshot`/`pin`/`unpin`). Pin accepts `--id` OR `--signature` (resolved to an id via the snapshot). `fp audit` lists active/sticky entries grouped by first-seen provider for periodic human review. Separately, a pure `computeRejectRate(repoRoot, throughIter)` helper scans the cycle's `decisions/<iter>.jsonl` files and the LoopDriver adds a `reject-rate-high` escalation precondition (guarded by a minimum sample size so a single rejection never escalates).

**Tech Stack:** Bun + TS, citty (`defineCommand`), zod, `bun test`, biome. `export PATH="$HOME/.bun/bin:$PATH"`. Runs in a git worktree branched from local `master` HEAD (manual `git worktree add … HEAD`; do NOT branch from the stale origin). Prerequisite: B1 (store, schema, decisions format) + B2a merged.

---

## File structure
- **Create** `src/cli/commands/fp.ts` — `runFpList` / `runFpShow` / `runFpPin` / `runFpUnpin` / `runFpAudit`.
- **Create** `src/core/fp-ledger/reject-rate.ts` — `computeRejectRate(...)` (pure, reads decisions files).
- **Create** `tests/unit/fp-cli.test.ts`, `tests/unit/fp-reject-rate.test.ts`, `tests/unit/loop-driver-reject-rate.test.ts`.
- **Modify** `src/cli/index.ts` — register the `fp` command + subcommands.
- **Modify** `src/core/loop-driver.ts` — add the `reject-rate-high` escalation precondition.

---

## Task 1: `fp list` + `fp show`

**Files:** Create `src/cli/commands/fp.ts`; Test `tests/unit/fp-cli.test.ts`

Read-only commands over `FpLedgerStore.snapshot()`. `list` prints one line per entry (`id [stage] category file rule_id  (Nrej, Mprov)`); an optional `--filter` substring matches id/file/rule_id/category/stage. `show --id` prints the full entry incl. its rejects.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/fp-cli.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFpAudit, runFpList, runFpPin, runFpShow, runFpUnpin } from "../../src/cli/commands/fp.ts";
import { FpLedgerStore } from "../../src/core/fp-ledger/store.ts";

const meta = { rule_id: "magic-number", category: "quality" as const, file: "src/a.ts", symbol: "" };

async function seed(repo: string, stage: "candidate" | "active") {
  const s = new FpLedgerStore(repo);
  const t = "2026-05-21T00:00:00Z";
  await s.recordReject("sigA", meta, { run_id: "r1", provider: "codex", reason: "x" }, t);
  if (stage === "active") {
    await s.recordReject("sigA", meta, { run_id: "r2", provider: "gemini", reason: "x" }, t);
    await s.recordReject("sigA", meta, { run_id: "r3", provider: "codex", reason: "x" }, t);
  }
  return s;
}

describe("fp CLI", () => {
  it("list prints entries; empty repo prints a friendly message", async () => {
    const empty = mkdtempSync(join(tmpdir(), "rg-fpcli-e-"));
    let out = "";
    expect(await runFpList({ repoRoot: empty, write: (s) => { out += s; } })).toBe(0);
    expect(out).toContain("No FP-ledger entries");

    const repo = mkdtempSync(join(tmpdir(), "rg-fpcli-l-"));
    await seed(repo, "active");
    out = "";
    expect(await runFpList({ repoRoot: repo, write: (s) => { out += s; } })).toBe(0);
    expect(out).toContain("FP-001");
    expect(out).toContain("active");
    expect(out).toContain("src/a.ts");
  });

  it("show prints the entry + rejects; missing id returns 1", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpcli-s-"));
    await seed(repo, "active");
    let out = "";
    expect(await runFpShow({ repoRoot: repo, id: "FP-001", write: (s) => { out += s; } })).toBe(0);
    expect(out).toContain("sigA");
    expect(out).toContain("codex");
    expect(await runFpShow({ repoRoot: repo, id: "FP-404" })).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/unit/fp-cli.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `runFpList` + `runFpShow`** (create the file with these two; the other three exports are added in Tasks 2–3):

```typescript
// src/cli/commands/fp.ts
import { FpLedgerStore } from "../../core/fp-ledger/store.ts";

export interface FpListInput {
  repoRoot: string;
  filter?: string;
  write?: (s: string) => void;
}
export interface FpShowInput {
  repoRoot: string;
  id: string;
  write?: (s: string) => void;
}

export async function runFpList(input: FpListInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const snap = await new FpLedgerStore(input.repoRoot).snapshot();
  let entries = snap.entries;
  if (input.filter) {
    const f = input.filter.toLowerCase();
    entries = entries.filter((e) =>
      [e.id, e.file, e.rule_id, e.category, e.stage].some((v) => v.toLowerCase().includes(f)),
    );
  }
  if (entries.length === 0) {
    out("No FP-ledger entries found.\n");
    return 0;
  }
  for (const e of entries) {
    out(
      `${e.id}  [${e.stage}]  ${e.category}  ${e.file}  ${e.rule_id}  (${e.rejects.length} rejects, ${e.distinct_providers.length} providers)\n`,
    );
  }
  return 0;
}

export async function runFpShow(input: FpShowInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const snap = await new FpLedgerStore(input.repoRoot).snapshot();
  const e = snap.entries.find((x) => x.id === input.id);
  if (!e) {
    process.stderr.write(`fp show: entry ${input.id} not found\n`);
    return 1;
  }
  out(`ID:         ${e.id}\n`);
  out(`Stage:      ${e.stage}${e.pinned_by ? ` (pinned by ${e.pinned_by})` : ""}\n`);
  out(`Signature:  ${e.signature}\n`);
  out(`Rule:       ${e.rule_id}\n`);
  out(`Category:   ${e.category}\n`);
  out(`File:       ${e.file}\n`);
  out(`Providers:  ${e.distinct_providers.join(", ") || "(none)"}\n`);
  out(`First seen: ${e.first_seen_at}\n`);
  out(`Last seen:  ${e.last_seen_at}\n`);
  out(`Rejects (${e.rejects.length}):\n`);
  for (const r of e.rejects) {
    out(`  - ${r.ts}  ${r.provider}  ${r.reason}\n`);
  }
  return 0;
}
```

- [ ] **Step 4: Run to verify it passes** — `bun test tests/unit/fp-cli.test.ts` → list/show tests PASS (the pin/unpin/audit tests added later still fail until their tasks).
- [ ] **Step 5: typecheck + lint + commit** — `git add -A && git commit -m "feat(cli): fp list + fp show"`

---

## Task 2: `fp pin` (by --id or --signature) + `fp unpin`

**Files:** Modify `src/cli/commands/fp.ts`; Test `tests/unit/fp-cli.test.ts` (add a `pin`/`unpin` block)

`pin` makes an entry sticky (advisory, NOT hidden — document this). Accept `--id` OR `--signature`; signature is resolved to an id via the snapshot. `unpin` reverts to the earned stage.

- [ ] **Step 1: Add the failing tests** (append inside the `describe`):

```typescript
  it("pin by id makes the entry sticky; unpin reverts", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpcli-pin-"));
    await seed(repo, "candidate");
    let out = "";
    expect(await runFpPin({ repoRoot: repo, id: "FP-001", by: "markus", write: (s) => { out += s; } })).toBe(0);
    expect((await new FpLedgerStore(repo).snapshot()).entries[0]?.stage).toBe("sticky");
    expect(await runFpUnpin({ repoRoot: repo, id: "FP-001" })).toBe(0);
    expect((await new FpLedgerStore(repo).snapshot()).entries[0]?.stage).toBe("candidate");
  });

  it("pin by signature resolves to the id; unknown target returns 1", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpcli-pinsig-"));
    await seed(repo, "candidate");
    expect(await runFpPin({ repoRoot: repo, signature: "sigA", by: "markus" })).toBe(0);
    expect((await new FpLedgerStore(repo).snapshot()).entries[0]?.stage).toBe("sticky");
    expect(await runFpPin({ repoRoot: repo, signature: "nope", by: "markus" })).toBe(1);
    expect(await runFpPin({ repoRoot: repo, by: "markus" })).toBe(2); // no target
  });
```

- [ ] **Step 2: Run to verify it fails** — module exports missing.

- [ ] **Step 3: Implement** (append to `fp.ts`):

```typescript
export interface FpPinInput {
  repoRoot: string;
  id?: string;
  signature?: string;
  by?: string;
  write?: (s: string) => void;
}
export interface FpUnpinInput {
  repoRoot: string;
  id: string;
  write?: (s: string) => void;
}

export async function runFpPin(input: FpPinInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const store = new FpLedgerStore(input.repoRoot);
  let id = input.id;
  if (!id && input.signature) {
    const snap = await store.snapshot();
    id = snap.entries.find((e) => e.signature === input.signature)?.id;
    if (!id) {
      process.stderr.write(`fp pin: no entry with signature ${input.signature}\n`);
      return 1;
    }
  }
  if (!id) {
    process.stderr.write("fp pin: --id <id> or --signature <sig> is required\n");
    return 2;
  }
  const ok = await store.pin(id, input.by ?? "cli");
  if (!ok) {
    process.stderr.write(`fp pin: entry ${id} not found\n`);
    return 1;
  }
  out(`Pinned ${id} (sticky — still shown as advisory, not hidden).\n`);
  return 0;
}

export async function runFpUnpin(input: FpUnpinInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const ok = await new FpLedgerStore(input.repoRoot).unpin(input.id);
  if (!ok) {
    process.stderr.write(`fp unpin: entry ${input.id} not found\n`);
    return 1;
  }
  out(`Unpinned ${input.id}.\n`);
  return 0;
}
```

- [ ] **Step 4: Run to verify it passes** — `bun test tests/unit/fp-cli.test.ts` → pin/unpin tests PASS.
- [ ] **Step 5: typecheck + lint + commit** — `git add -A && git commit -m "feat(cli): fp pin (--id|--signature) + fp unpin"`

---

## Task 3: `fp audit`

**Files:** Modify `src/cli/commands/fp.ts`; Test `tests/unit/fp-cli.test.ts` (add an `audit` block)

Lists ACTIVE + STICKY entries grouped by first-seen provider (`rejects[0].provider`) for periodic human review (the spec's anti-poisoning audit surface). Candidates are excluded (they are not yet applied).

- [ ] **Step 1: Add the failing test:**

```typescript
  it("audit groups active/sticky entries by first-seen provider; skips candidates", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpcli-audit-"));
    await seed(repo, "active"); // sigA active, first reject by codex
    const s = new FpLedgerStore(repo);
    await s.recordReject("sigCand", meta, { run_id: "c1", provider: "gemini", reason: "x" }, "2026-05-21T00:00:00Z");
    let out = "";
    expect(await runFpAudit({ repoRoot: repo, write: (s2) => { out += s2; } })).toBe(0);
    expect(out).toContain("codex"); // group header for the active entry
    expect(out).toContain("FP-001");
    expect(out).not.toContain("sigCand"); // candidate excluded
  });
```

- [ ] **Step 2: Run to verify it fails** — export missing.

- [ ] **Step 3: Implement** (append to `fp.ts`):

```typescript
export interface FpAuditInput {
  repoRoot: string;
  write?: (s: string) => void;
}

export async function runFpAudit(input: FpAuditInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const snap = await new FpLedgerStore(input.repoRoot).snapshot();
  const applied = snap.entries.filter((e) => e.stage !== "candidate");
  if (applied.length === 0) {
    out("No active or sticky FP-ledger entries to audit.\n");
    return 0;
  }
  const groups = new Map<string, typeof applied>();
  for (const e of applied) {
    const firstProvider = e.rejects[0]?.provider ?? "(unknown)";
    const list = groups.get(firstProvider) ?? [];
    list.push(e);
    groups.set(firstProvider, list);
  }
  out(`Active/sticky FP-ledger entries by first-seen provider (${applied.length} total):\n`);
  for (const provider of [...groups.keys()].sort()) {
    out(`\n${provider}:\n`);
    for (const e of groups.get(provider) ?? []) {
      out(`  ${e.id}  [${e.stage}]  ${e.file}  ${e.rule_id}  (${e.distinct_providers.length} providers)\n`);
    }
  }
  return 0;
}
```

- [ ] **Step 4: Run to verify it passes** — `bun test tests/unit/fp-cli.test.ts` → all 5 CLI tests PASS.
- [ ] **Step 5: typecheck + lint + commit** — `git add -A && git commit -m "feat(cli): fp audit (active/sticky grouped by first-seen provider)"`

---

## Task 4: Register the `fp` command in the CLI

**Files:** Modify `src/cli/index.ts`

Mirror the `brain` command block. Flag style `--id` / `--signature` / `--filter` / `--by`.

- [ ] **Step 1: Add the import** (after the brain import):

```typescript
import { runFpAudit, runFpList, runFpPin, runFpShow, runFpUnpin } from "./commands/fp.ts";
```

- [ ] **Step 2: Define the command** (after the `brain` command definition, before `main`):

```typescript
const fp = defineCommand({
  meta: { name: "fp", description: "FP-ledger (known false positives) management" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list" },
      args: { filter: { type: "string" } },
      async run({ args }) {
        const filter = typeof args.filter === "string" ? args.filter : undefined;
        process.exit(
          await runFpList({ repoRoot: process.cwd(), ...(filter !== undefined ? { filter } : {}) }),
        );
      },
    }),
    show: defineCommand({
      meta: { name: "show" },
      args: { id: { type: "string" } },
      async run({ args }) {
        if (!args.id) {
          process.stderr.write("fp show: --id <id> is required\n");
          process.exit(2);
        }
        process.exit(await runFpShow({ repoRoot: process.cwd(), id: args.id as string }));
      },
    }),
    pin: defineCommand({
      meta: { name: "pin" },
      args: { id: { type: "string" }, signature: { type: "string" }, by: { type: "string" } },
      async run({ args }) {
        process.exit(
          await runFpPin({
            repoRoot: process.cwd(),
            ...(typeof args.id === "string" ? { id: args.id } : {}),
            ...(typeof args.signature === "string" ? { signature: args.signature } : {}),
            ...(typeof args.by === "string" ? { by: args.by } : {}),
          }),
        );
      },
    }),
    unpin: defineCommand({
      meta: { name: "unpin" },
      args: { id: { type: "string" } },
      async run({ args }) {
        if (!args.id) {
          process.stderr.write("fp unpin: --id <id> is required\n");
          process.exit(2);
        }
        process.exit(await runFpUnpin({ repoRoot: process.cwd(), id: args.id as string }));
      },
    }),
    audit: defineCommand({
      meta: { name: "audit" },
      async run() {
        process.exit(await runFpAudit({ repoRoot: process.cwd() }));
      },
    }),
  },
});
```

- [ ] **Step 3: Add `fp` to `subCommands`** of `main`:

```typescript
  subCommands: { init, gate, "review-plan": reviewPlan, doctor, audit, brain, fp },
```

- [ ] **Step 4: Run to verify** — `bun run typecheck && bun run lint && bun test`. Then a real binary smoke check (per the project's real-verification rule — citty wiring is invisible to unit tests):

```bash
bun run build
./dist/reviewgate fp list          # → "No FP-ledger entries found." in a clean repo
./dist/reviewgate fp --help        # lists list/show/pin/unpin/audit
```

- [ ] **Step 5: commit** — `git add -A && git commit -m "feat(cli): register fp command (list/show/pin/unpin/audit)"`

---

## Task 5: Wire the `reject-rate-high` escalation trigger

**Files:** Create `src/core/fp-ledger/reject-rate.ts`; Modify `src/core/loop-driver.ts`; Test `tests/unit/fp-reject-rate.test.ts` + `tests/unit/loop-driver-reject-rate.test.ts`

`reject-rate-high` is a defined `EscalationReason` (src/schemas/state.ts) with NO trigger. Wire it: across the current cycle's `decisions/<iter>.jsonl` files (iterations 1..throughIter), the reject rate = (decisions with `verdict:"rejected"` AND `reviewer_was_wrong:true`) / (all decisions). Escalate when the denominator ≥ a minimum sample (`MIN_DECISIONS = 4`, so a one-off rejection never escalates) AND the rate ≥ `config.loop.rejectRateEscalation` (default 0.8). This is independent of the FP-ledger opt-in — it is a panel-noise circuit-breaker.

- [ ] **Step 1: Write the failing test for the pure helper:**

```typescript
// tests/unit/fp-reject-rate.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeRejectRate } from "../../src/core/fp-ledger/reject-rate.ts";
import { decisionsPath } from "../../src/utils/paths.ts";

function writeDecisions(repo: string, iter: number, lines: object[]) {
  const p = decisionsPath(repo, iter);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
const rejected = (id: string) => ({ schema: "reviewgate.decision.v1", finding_id: id, verdict: "rejected", reason: "false positive on unchanged code xx", reviewer_was_wrong: true });
const accepted = (id: string) => ({ schema: "reviewgate.decision.v1", finding_id: id, verdict: "accepted", action: "fixed" });

describe("computeRejectRate", () => {
  it("returns rate + total across the cycle's decisions", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rr-"));
    writeDecisions(repo, 1, [rejected("F-001"), rejected("F-002"), accepted("F-003")]);
    writeDecisions(repo, 2, [rejected("F-001")]);
    const r = computeRejectRate(repo, 2);
    expect(r.total).toBe(4);
    expect(r.wrongRejects).toBe(3);
    expect(r.rate).toBeCloseTo(0.75, 5);
  });

  it("ignores rejections without reviewer_was_wrong", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rr2-"));
    writeDecisions(repo, 1, [
      { schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "legitimately wont fix now xx" },
      accepted("F-002"),
    ]);
    const r = computeRejectRate(repo, 1);
    expect(r.total).toBe(2);
    expect(r.wrongRejects).toBe(0);
    expect(r.rate).toBe(0);
  });

  it("is zero for no decisions", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rr3-"));
    const r = computeRejectRate(repo, 3);
    expect(r).toEqual({ total: 0, wrongRejects: 0, rate: 0 });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement the helper:**

```typescript
// src/core/fp-ledger/reject-rate.ts
import { existsSync, readFileSync } from "node:fs";
import { DecisionEntrySchema } from "../../schemas/decision.ts";
import { decisionsPath } from "../../utils/paths.ts";

export interface RejectRate {
  total: number;
  wrongRejects: number;
  rate: number;
}

// Reject rate across the CURRENT cycle's decisions (iterations 1..throughIter):
// (rejected & reviewer_was_wrong) / (all valid decisions). A panel-noise
// circuit-breaker — independent of the FP-ledger opt-in.
export function computeRejectRate(repoRoot: string, throughIter: number): RejectRate {
  let total = 0;
  let wrongRejects = 0;
  for (let iter = 1; iter <= throughIter; iter++) {
    const p = decisionsPath(repoRoot, iter);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const res = DecisionEntrySchema.safeParse(parsed);
      if (!res.success) continue;
      total++;
      if (res.data.verdict === "rejected" && res.data.reviewer_was_wrong === true) wrongRejects++;
    }
  }
  return { total, wrongRejects, rate: total === 0 ? 0 : wrongRejects / total };
}
```

- [ ] **Step 4: Run to verify it passes** — `bun test tests/unit/fp-reject-rate.test.ts` → PASS (3 tests).

- [ ] **Step 5: Wire the precondition into the LoopDriver.** Add the import (with the other `../core` imports at the top of `loop-driver.ts`):

```typescript
import { computeRejectRate } from "./fp-ledger/reject-rate.ts";
```

Add a constant near the top of the file (after the imports):

```typescript
const MIN_DECISIONS_FOR_REJECT_RATE = 4;
```

Insert the precondition **after the stuck-signatures block and before the `if (state.iteration > 0)` decisions-gate block** (so an unaddressed-decisions loop still takes precedence is NOT required — reject-rate is the earlier signal; place it right after stuck-signatures):

```typescript
    // Escalation precondition: reviewers are producing a high rate of confirmed
    // false positives this cycle → stop nagging and surface to the human. Guarded
    // by a minimum sample so a single reviewer_was_wrong rejection never escalates.
    if (state.iteration > 0 && this.i.config.loop.rejectRateEscalation > 0) {
      const rr = computeRejectRate(this.i.repoRoot, state.iteration);
      if (rr.total >= MIN_DECISIONS_FOR_REJECT_RATE && rr.rate >= this.i.config.loop.rejectRateEscalation) {
        return this.escalateAndDecide(
          state,
          "reject-rate-high",
          `${rr.wrongRejects}/${rr.total} decisions this cycle were confirmed reviewer false positives (rate ${(rr.rate * 100).toFixed(0)}% ≥ ${(this.i.config.loop.rejectRateEscalation * 100).toFixed(0)}%).`,
        );
      }
    }
```

- [ ] **Step 6: Write the LoopDriver integration test.** Inspect an existing `tests/unit/loop-driver*.test.ts` for the harness/builder used to construct a `LoopDriver` (state store, config, a stub orchestrator, dirty flag). Mirror it:

```typescript
// tests/unit/loop-driver-reject-rate.test.ts — sketch; adapt to the existing harness
// Arrange: dirty flag set; state.iteration = 2; write decisions/1.jsonl + decisions/2.jsonl
// with ≥4 decisions, ≥80% rejected+reviewer_was_wrong; config.loop.rejectRateEscalation = 0.8.
// Act: await driver.run() (or runIteration gate entry).
// Assert: decision.kind === "escalate" (or block-with-escalation), state.escalation_reason === "reject-rate-high",
//         and ESCALATION.md exists.
```

Match the assertions to how the existing loop-driver tests assert escalation (`escalateAndDecide` sets `state.escalated` + writes `ESCALATION.md`). Keep the sample ≥ `MIN_DECISIONS_FOR_REJECT_RATE`.

- [ ] **Step 7: Run** — `bun test tests/unit/loop-driver-reject-rate.test.ts tests/unit/loop-driver.test.ts` → PASS (no regression in existing loop-driver tests).
- [ ] **Step 8: typecheck + lint + commit** — `git add -A && git commit -m "feat(loop-driver): wire reject-rate-high escalation (panel-noise circuit-breaker)"`

---

## Task 6: Full-suite gate + DoD + merge

- [ ] **Step 1:** `bun test && bun run typecheck && bun run lint` → all pass / clean.
- [ ] **Step 2: Real binary smoke** (per real-verification rule): `bun run build` then `./dist/reviewgate fp list|--help` behave as in Task 4 Step 4.
- [ ] **Step 3: DoD:** Codex Agent A (file-based prompt, foreground, stdin closed; review `git diff master...HEAD`; run typecheck+lint itself) → PASS = 0 CRITICAL/WARN; fix all findings (TDD each), re-run until clean; then Claude Agent A review subagent → PASS. `rm -rf .review/`.
- [ ] **Step 4:** FF-merge to master, rebuild binary (verify boots + `fp` subcommands present), remove worktree, delete branch. Ask before pushing.

---

## Self-review (spec coverage)
- CLI `fp list/show/pin/unpin/audit`, `--id` flag style, pin = advisory-not-hidden (documented in output), audit grouped by first-seen provider (spec §CLI, §Safety) → Tasks 1–4. ✓
- `reject-rate-high` trigger with a concrete numerator/denominator over decisions, min-sample guard, uses `config.loop.rejectRateEscalation` (spec §Safety, §"Decomposition — B2b") → Task 5. ✓
- `decayPass` — already wired per-run in the orchestrator (B1, found by DoD review); no separate B2b work needed beyond the existing coverage. Noted.
- Real binary verification of the CLI (citty wiring is invisible to `bun test`) → Tasks 4 + 6. ✓
- NOT in B2b (later): B3 brain↔ledger coupling.
