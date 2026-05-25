# Reputation Slice C (Quarantine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in reviewer **quarantine** — below a hard floor (`quarantineFloor` 0.15, default OFF), skip a `provider:persona` reviewer slot entirely for the cycle instead of merely demoting it.

**Architecture:** A store query `quarantinedReviewers` (sharing a `reviewersBelow` helper with `unreliableReviewers`) returns sub-floor reviewer keys. A pure `selectActiveReviewers` filters the panel before the orchestrator's run loop; if filtering would empty the panel it runs the full panel anyway. The shrink is surfaced via a new `pending.json` `panel_note` + `console.warn` + a doctor `⛔` marker. Demote (Slice 1) is untouched.

**Tech Stack:** Bun, TypeScript, zod.

Spec: `docs/superpowers/specs/2026-05-25-reputation-slice-c-design.md`. **Honest safety note:** quarantine removes ALL of a skipped reviewer's findings (incl. security) — it CAN move a verdict toward PASS by omission. Accepted, bounded, default-OFF (spec §4).

---

## File Structure

- `src/config/define-config.ts` + `src/config/defaults.ts` — `phases.reputation.quarantine = { enabled:false, floor:0.15 }`.
- `src/core/reputation/store.ts` — `reviewersBelow` refactor, `quarantinedReviewers`, `forDoctor` `quarantined` flag, `ReputationConfig.quarantine?`.
- `src/core/reputation/quarantine.ts` (new) — pure `selectActiveReviewers`.
- `src/core/orchestrator.ts` — hoist `repCfg`, derive `panelReviewers` + `panelNote`, pass `panelNote` to both `writeReport` sites.
- `src/schemas/pending-report.ts` — `panel_note?`.
- `src/core/report-writer.ts` — render `panel_note`.
- `src/cli/commands/doctor.ts` — `⛔ quarantined` marker.

---

## Task 1: Config schema for `quarantine`

**Files:**
- Modify: `src/config/define-config.ts`, `src/config/defaults.ts`
- Test: `tests/unit/reputation-config.test.ts`, `tests/unit/config-diff-serialize.test.ts`, `tests/unit/orchestrator.test.ts`

> **Why orchestrator.test.ts here:** once `quarantine` is added to the schema, the parsed
> `reputation` TYPE requires it. The two EXISTING orchestrator configs (~lines 192 and 232) build a
> `reputation: { enabled, minSamples, trustFloor, halfLifeDays }` literal WITHOUT `quarantine`, so
> the project-wide `bunx tsc --noEmit` in Step 6 fails unless they are updated in this task.

- [ ] **Step 1: Update the failing config tests**

In `tests/unit/reputation-config.test.ts`, update the default-shape assertion and add a quarantine override case:

```ts
  it("is enabled by default with the spec's defaults", () => {
    expect(defaultConfig.phases.reputation).toEqual({
      enabled: true,
      minSamples: 8,
      trustFloor: 0.35,
      halfLifeDays: 45,
      quarantine: { enabled: false, floor: 0.15 },
    });
  });
  it("validates and is overridable", () => {
    const parsed = ConfigSchema.parse({
      ...defaultConfig,
      phases: { ...defaultConfig.phases, reputation: { enabled: false } },
    });
    expect(parsed.phases.reputation.enabled).toBe(false);
    expect(parsed.phases.reputation.minSamples).toBe(8);
    expect(parsed.phases.reputation.quarantine).toEqual({ enabled: false, floor: 0.15 });
  });
  it("accepts a quarantine override", () => {
    const parsed = ConfigSchema.parse({
      ...defaultConfig,
      phases: {
        ...defaultConfig.phases,
        reputation: { enabled: true, quarantine: { enabled: true, floor: 0.2 } },
      },
    });
    expect(parsed.phases.reputation.quarantine).toEqual({ enabled: true, floor: 0.2 });
  });
```

In `tests/unit/config-diff-serialize.test.ts`, add inside `describe("diffFromDefaults", ...)`:

```ts
  it("strips quarantine defaults and emits an enabled override", () => {
    // default quarantine {enabled:false,floor:0.15} is default-equivalent → stripped.
    const def = defineConfig({ phases: { reputation: { enabled: true } } });
    expect("reputation" in (diffFromDefaults(def).phases ?? {})).toBe(false);
    // enabling quarantine differs from default → emitted (floor at default is stripped).
    const on = defineConfig({
      phases: { reputation: { enabled: true, quarantine: { enabled: true } } },
    });
    expect(diffFromDefaults(on)).toEqual({
      phases: { reputation: { quarantine: { enabled: true } } },
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/reputation-config.test.ts tests/unit/config-diff-serialize.test.ts`
Expected: FAIL — `quarantine` isn't in the schema yet, so the default-shape `toEqual` and the override parse fail.

- [ ] **Step 3: Add the `quarantine` sub-schema in `define-config.ts`**

In `src/config/define-config.ts`, change the `reputation` schema (lines ~95-102) to:

```ts
    reputation: z
      .object({
        enabled: z.boolean(),
        minSamples: z.number().int().nonnegative().default(8),
        trustFloor: z.number().min(0).max(1).default(0.35),
        halfLifeDays: z.number().positive().default(45),
        // Slice C: opt-in quarantine — below `floor` (hard, < trustFloor) skip the
        // reviewer entirely for the cycle. Default OFF (can suppress findings; see spec §4).
        quarantine: z
          .object({
            enabled: z.boolean().default(false),
            floor: z.number().min(0).max(1).default(0.15),
          })
          .default({ enabled: false, floor: 0.15 }),
      })
      .default({
        enabled: true,
        minSamples: 8,
        trustFloor: 0.35,
        halfLifeDays: 45,
        quarantine: { enabled: false, floor: 0.15 },
      }),
```

- [ ] **Step 3b: Keep existing orchestrator configs type-valid**

In `tests/unit/orchestrator.test.ts`, the two EXISTING reputation-integration configs (~lines 192 and 232) each have a `reputation: { enabled: …, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45 }` literal. Add `quarantine: { enabled: false, floor: 0.15 },` to BOTH so they satisfy the now-required type. For example, line ~192 becomes:

```ts
          reputation: {
            enabled: true,
            minSamples: 8,
            trustFloor: 0.35,
            halfLifeDays: 45,
            quarantine: { enabled: false, floor: 0.15 },
          },
```

and line ~232 likewise (with `enabled: false`). (These tests keep their existing behavior — quarantine stays off.)

- [ ] **Step 4: Update `defaults.ts`**

In `src/config/defaults.ts`, change the reputation line (~98) to include quarantine:

```ts
    reputation: {
      enabled: true,
      minSamples: 8,
      trustFloor: 0.35,
      halfLifeDays: 45,
      quarantine: { enabled: false, floor: 0.15 },
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/unit/reputation-config.test.ts tests/unit/config-diff-serialize.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint + commit**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean (run `bun run format` then re-check if biome flags formatting).

```bash
git add src/config/define-config.ts src/config/defaults.ts tests/unit/reputation-config.test.ts tests/unit/config-diff-serialize.test.ts tests/unit/orchestrator.test.ts
git commit -m "feat(reputation): add phases.reputation.quarantine config (default off)"
```

---

## Task 2: Store queries + doctor marker

**Files:**
- Modify: `src/core/reputation/store.ts`, `src/cli/commands/doctor.ts`
- Test: `tests/unit/reputation-store.test.ts`, `tests/unit/doctor-reputation.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/unit/reputation-store.test.ts`, add inside `describe("ReputationStore", ...)`:

```ts
  it("quarantinedReviewers returns only reviewers below the quarantine floor", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    // gemini:security → 10 wrong → trust ≈ 1/12 ≈ 0.083 < 0.15 (quarantined)
    await s.record(
      Array.from({ length: 10 }, (_, i) => ({
        reviewerKey: "gemini:security" as const,
        outcome: "wrong" as const,
        eid: `g${i}`,
        ts: now.toISOString(),
      })),
      { now, halfLifeDays: 45 },
    );
    // codex:security → 6 wrong + 4 correct → trust ≈ 5/12 ≈ 0.417 (neither demoted nor quarantined);
    // make it clearly between the floors: 7 wrong + 3 correct → trust ≈ 4/12 ≈ 0.333 (<0.35 demote, >0.15 not quarantined)
    await s.record(
      [
        ...Array.from({ length: 7 }, (_, i) => ({ reviewerKey: "codex:security" as const, outcome: "wrong" as const, eid: `cw${i}`, ts: now.toISOString() })),
        ...Array.from({ length: 3 }, (_, i) => ({ reviewerKey: "codex:security" as const, outcome: "correct" as const, eid: `cc${i}`, ts: now.toISOString() })),
      ],
      { now, halfLifeDays: 45 },
    );
    const cfg = { enabled: true, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45 };
    const q = await s.quarantinedReviewers(cfg, now, 0.15);
    expect(q).toContain("gemini:security");
    expect(q).not.toContain("codex:security"); // demote-range, not quarantine
    // unreliableReviewers (trustFloor 0.35) still flags BOTH (behavior preserved)
    const u = await s.unreliableReviewers(cfg, now);
    expect(u).toContain("gemini:security");
    expect(u).toContain("codex:security");
  });

  it("quarantinedReviewers ignores legacy bare keys and respects minSamples", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    await s.record([{ reviewerKey: "codex" as const, outcome: "wrong", eid: "x", ts: now.toISOString() }], { now, halfLifeDays: 45 });
    await s.record(
      Array.from({ length: 3 }, (_, i) => ({ reviewerKey: "gemini:security" as const, outcome: "wrong" as const, eid: `s${i}`, ts: now.toISOString() })),
      { now, halfLifeDays: 45 },
    );
    const q = await s.quarantinedReviewers({ enabled: true, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45 }, now, 0.15);
    expect(q.has("codex")).toBe(false); // legacy bare key
    expect(q.has("gemini:security")).toBe(false); // only 3 samples < minSamples 8
  });

  it("forDoctor marks quarantined reviewers when quarantine is enabled", async () => {
    const r = repo();
    const s = new ReputationStore(r);
    const now = new Date("2026-05-25T00:00:00Z");
    await s.record(
      Array.from({ length: 10 }, (_, i) => ({ reviewerKey: "gemini:security" as const, outcome: "wrong" as const, eid: `g${i}`, ts: now.toISOString() })),
      { now, halfLifeDays: 45 },
    );
    const base = { enabled: true, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45 };
    const rowOn = (await s.forDoctor({ ...base, quarantine: { enabled: true, floor: 0.15 } }, now)).find((x) => x.reviewer === "gemini:security");
    expect(rowOn?.quarantined).toBe(true);
    expect(rowOn?.demoting).toBe(true);
    const rowOff = (await s.forDoctor(base, now)).find((x) => x.reviewer === "gemini:security");
    expect(rowOff?.quarantined).toBe(false); // quarantine not enabled → never flagged
  });
```

In `tests/unit/doctor-reputation.test.ts`, add a test that the `⛔` marker renders when quarantine is enabled:

```ts
  it("flags a quarantined reviewer with ⛔ when quarantine is enabled", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-docrep-quar-"));
    const now = new Date();
    await new ReputationStore(repo).record(
      Array.from({ length: 10 }, (_, i) => ({
        reviewerKey: "gemini:security" as const,
        outcome: "wrong" as const,
        eid: `w${i}`,
        ts: now.toISOString(),
      })),
    );
    const cfg = {
      phases: { reputation: { ...repCfg, quarantine: { enabled: true, floor: 0.15 } } },
    } as unknown as ReviewgateConfig;
    const c = await reputationCheck(repo, cfg);
    expect(c?.detail).toContain("⛔ quarantined");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/reputation-store.test.ts tests/unit/doctor-reputation.test.ts`
Expected: FAIL — `quarantinedReviewers` doesn't exist, `forDoctor` rows have no `quarantined`, no `⛔` text.

- [ ] **Step 3: Refactor `store.ts` — `reviewersBelow` + `quarantinedReviewers` + `ReputationConfig.quarantine`**

In `src/core/reputation/store.ts`, extend the `ReputationConfig` interface:

```ts
export interface ReputationConfig {
  enabled: boolean;
  minSamples: number;
  trustFloor: number;
  halfLifeDays: number;
  quarantine?: { enabled: boolean; floor: number };
}
```

Replace `unreliableReviewers` (lines ~104-119) with a shared helper + two callers:

```ts
  private async reviewersBelow(floor: number, cfg: ReputationConfig, now: Date): Promise<Set<string>> {
    const rep = await this.snapshot();
    const out = new Set<string>();
    for (const reviewerKey of Object.keys(rep.reviewers)) {
      if (!reviewerKey.includes(":")) continue; // legacy bare-provider key (pre-Slice-B) → inert
      if (isUnreliable(this.derive(reviewerKey, rep, now, cfg.halfLifeDays), cfg.minSamples, floor))
        out.add(reviewerKey);
    }
    return out;
  }

  async unreliableReviewers(cfg: ReputationConfig, now: Date): Promise<Set<string>> {
    return this.reviewersBelow(cfg.trustFloor, cfg, now);
  }

  async quarantinedReviewers(cfg: ReputationConfig, now: Date, floor: number): Promise<Set<string>> {
    return this.reviewersBelow(floor, cfg, now);
  }
```

Update `forDoctor` (lines ~121-135) to add the `quarantined` flag:

```ts
  async forDoctor(cfg: ReputationConfig, now: Date) {
    const rep = await this.snapshot();
    const qFloor = cfg.quarantine?.enabled ? cfg.quarantine.floor : null;
    return Object.entries(rep.reviewers)
      .filter(([reviewerKey]) => reviewerKey.includes(":")) // hide legacy bare-provider keys
      .map(([reviewerKey, e]) => {
        const d = this.derive(reviewerKey, rep, now, cfg.halfLifeDays);
        return {
          reviewer: reviewerKey,
          correct: e.correct.length,
          wrong: e.wrong.length,
          trust: d.trust,
          demoting: isUnreliable(d, cfg.minSamples, cfg.trustFloor),
          quarantined: qFloor !== null && isUnreliable(d, cfg.minSamples, qFloor),
        };
      });
  }
```

- [ ] **Step 4: Render the `⛔` marker in `doctor.ts`**

In `src/cli/commands/doctor.ts`, in `reputationCheck` (the `.map(...)` that builds each row line, ~line 182), append the quarantined marker:

```ts
        `${r.reviewer} ${r.correct}✓/${r.wrong}✗ (trust ${r.trust.toFixed(2)})${r.demoting ? " ⚠ demoting" : ""}${r.quarantined ? " ⛔ quarantined" : ""}`,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/unit/reputation-store.test.ts tests/unit/doctor-reputation.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + lint + commit**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

```bash
git add src/core/reputation/store.ts src/cli/commands/doctor.ts tests/unit/reputation-store.test.ts tests/unit/doctor-reputation.test.ts
git commit -m "feat(reputation): quarantinedReviewers query + doctor ⛔ marker"
```

---

## Task 3: Pure `selectActiveReviewers`

**Files:**
- Create: `src/core/reputation/quarantine.ts`
- Test: `tests/unit/reputation-quarantine.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/reputation-quarantine.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { selectActiveReviewers } from "../../src/core/reputation/quarantine.ts";

const keyOf = (r: { provider: string; persona: string }) => `${r.provider}:${r.persona}`;
const codex = { provider: "codex", persona: "security" };
const gemini = { provider: "gemini", persona: "architecture" };

describe("selectActiveReviewers", () => {
  it("returns all reviewers unchanged when nothing is quarantined", () => {
    const res = selectActiveReviewers([codex, gemini], new Set<string>(), keyOf);
    expect(res.active).toEqual([codex, gemini]);
    expect(res.dropped).toEqual([]);
    expect(res.usedFullFallback).toBe(false);
  });

  it("drops a quarantined reviewer slot", () => {
    const res = selectActiveReviewers([codex, gemini], new Set(["codex:security"]), keyOf);
    expect(res.active).toEqual([gemini]);
    expect(res.dropped).toEqual(["codex:security"]);
    expect(res.usedFullFallback).toBe(false);
  });

  it("runs the FULL panel when filtering would empty it", () => {
    const res = selectActiveReviewers(
      [codex, gemini],
      new Set(["codex:security", "gemini:architecture"]),
      keyOf,
    );
    expect(res.active).toEqual([codex, gemini]); // full panel, unchanged
    expect(res.dropped).toEqual([]);
    expect(res.usedFullFallback).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/reputation-quarantine.test.ts`
Expected: FAIL — module/function does not exist.

- [ ] **Step 3: Create `src/core/reputation/quarantine.ts`**

```ts
// src/core/reputation/quarantine.ts
export interface QuarantineResult<R> {
  /** Reviewers to actually run this cycle. */
  active: R[];
  /** Reviewer keys (provider:persona) skipped because they are quarantined. */
  dropped: string[];
  /** True when filtering would empty the panel → the FULL panel ran anyway (quarantine yields). */
  usedFullFallback: boolean;
}

// Filter quarantined reviewer slots out of the panel. If that would leave zero
// reviewers, return the full list with usedFullFallback=true — quarantine must
// never produce an empty (un-reviewed) panel. Pure: no I/O, fully unit-testable.
export function selectActiveReviewers<R>(
  activeReviewers: R[],
  quarantined: Set<string>,
  keyOf: (r: R) => string,
): QuarantineResult<R> {
  if (quarantined.size === 0)
    return { active: activeReviewers, dropped: [], usedFullFallback: false };
  const active = activeReviewers.filter((r) => !quarantined.has(keyOf(r)));
  if (active.length === 0)
    return { active: activeReviewers, dropped: [], usedFullFallback: true };
  const dropped = activeReviewers.filter((r) => quarantined.has(keyOf(r))).map(keyOf);
  return { active, dropped, usedFullFallback: false };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/reputation-quarantine.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint + commit**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

```bash
git add src/core/reputation/quarantine.ts tests/unit/reputation-quarantine.test.ts
git commit -m "feat(reputation): pure selectActiveReviewers panel filter"
```

---

## Task 4: Orchestrator wiring + report surfacing

**Files:**
- Modify: `src/schemas/pending-report.ts`, `src/core/report-writer.ts`, `src/core/orchestrator.ts`
- Test: `tests/unit/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/unit/orchestrator.test.ts`, inside `describe("Orchestrator reputation demote integration", ...)` (it already imports `Orchestrator`, `ReputationStore`, `defaultConfig`, `CodexAdapter`, fixtures, and has `criticalQualityBin`), add:

```ts
  it("quarantines a sub-floor reviewer: skips its run and notes it (panel_note)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-quar-"));
    writeFileSync(join(repo, "foo.ts"), "const a = 2;\n");
    // Seed codex:security WAY below the quarantine floor (10 wrong → trust ≈ 0.083 < 0.15).
    await new ReputationStore(repo).record(
      Array.from({ length: 10 }, (_, i) => ({
        reviewerKey: "codex:security" as const,
        outcome: "wrong" as const,
        eid: `w${i}`,
        ts: new Date().toISOString(),
      })),
    );
    const orch = new Orchestrator({
      repoRoot: repo,
      config: {
        ...defaultConfig,
        cache: { ...defaultConfig.cache, enabled: false },
        phases: {
          ...defaultConfig.phases,
          reputation: {
            enabled: true,
            minSamples: 8,
            trustFloor: 0.35,
            halfLifeDays: 45,
            quarantine: { enabled: true, floor: 0.15 },
          },
        },
      },
      adapters: { codex: new CodexAdapter({ binPath: criticalQualityBin(repo) }) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: SOFT_DIFF,
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "01HXQUAR1", iter: 1 });
    // Only configured reviewer (codex:security) is quarantined → filtering would empty the
    // panel → FULL panel runs anyway (usedFullFallback) → codex DOES run → its lone CRITICAL
    // quality finding is still demoted by Slice 1 (codex unreliable) → SOFT-PASS, with a panel_note.
    expect(result.verdict).toBe("SOFT-PASS");
    const pending = JSON.parse(readFileSync(join(repo, ".reviewgate/pending.json"), "utf8"));
    expect(pending.panel_note).toContain("quarantined");
  });
```

(Note: with a single configured reviewer, this exercises the empty-panel fallback path AND the `panel_note`. A multi-reviewer drop test would need a second fake adapter; the pure `selectActiveReviewers` test in Task 3 already covers the drop-one case.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/orchestrator.test.ts -t "quarantines a sub-floor reviewer"`
Expected: FAIL — `pending.panel_note` is undefined (no quarantine wiring yet).

- [ ] **Step 3: Add `panel_note` to the pending-report schema**

In `src/schemas/pending-report.ts`, add to `PendingReportSchema` (after the `findings` field, before `critic`):

```ts
  // Slice C: a human/agent-visible note when the reviewer panel was degraded this
  // cycle (reviewers quarantined, or all-quarantined → full panel ran anyway).
  panel_note: z.string().optional(),
```

- [ ] **Step 4: Render `panel_note` in `report-writer.ts`**

In `src/core/report-writer.ts`, in the `head` array (~lines 82-93), insert a banner right after `...coverageBanner,`:

```ts
    ...coverageBanner,
    ...(r.panel_note ? [`> ⛔ **Panel:** ${r.panel_note}`, ""] : []),
```

- [ ] **Step 5: Thread `panelNote` through `writeReport`**

In `src/core/orchestrator.ts`, add a trailing optional param to `writeReport` (signature ~line 1204, after the `critic?` param):

```ts
    critic?: {
      provider: string;
      status: "ran" | "error" | "empty" | "misconfigured";
      verdicts: number;
      demoted: number;
    },
    panelNote?: string,
  ): Promise<void> {
```

And add it to the report object passed to `writer.write` (~line 1258, next to the `critic` spread):

```ts
        ...(critic ? { critic } : {}),
        ...(panelNote ? { panel_note: panelNote } : {}),
```

- [ ] **Step 6: Compute the quarantine filter before the run loop**

In `src/core/orchestrator.ts`, the demote-pass currently declares `const repCfg = this.input.config.phases.reputation;` at ~line 880. **Remove that declaration there** (keep the `let repUnreliable...` block that follows it, now referencing the hoisted `repCfg`). Insert the hoisted declaration + the quarantine filter immediately after `const cooldownStore = new QuotaCooldownStore(repo);` (~line 588) and BEFORE `const tasks = activeReviewers.map(...)` (~line 593):

```ts
    // Reviewer quarantine (Slice C, opt-in): drop reviewer slots whose provider:persona is
    // below the hard quarantine floor BEFORE running them. If that would empty the panel, run
    // the full panel anyway (quarantine yields). repCfg is hoisted here so the demote pass below
    // reuses it. See spec §4: quarantine can suppress a skipped reviewer's findings — opt-in.
    const repCfg = this.input.config.phases.reputation;
    let panelReviewers = activeReviewers;
    let panelNote: string | undefined;
    if (repCfg?.enabled && repCfg.quarantine?.enabled) {
      const quarantined = await new ReputationStore(repo)
        .quarantinedReviewers(repCfg, now, repCfg.quarantine.floor)
        .catch(() => new Set<string>());
      const keyOf = (r: { provider: ProviderId; persona: string }) =>
        `${r.provider}:${docPersona ?? r.persona}`;
      const sel = selectActiveReviewers(activeReviewers, quarantined, keyOf);
      panelReviewers = sel.active;
      if (sel.usedFullFallback) {
        panelNote =
          "⚠ All configured reviewers are quarantined (reputation below floor) — ran the full panel anyway this cycle. Review/replace these reviewers.";
        console.warn(`[reviewgate] ${panelNote}`);
      } else if (sel.dropped.length > 0) {
        panelNote = `Quarantined (skipped) this cycle — reputation below floor: ${sel.dropped.join(", ")}`;
        console.warn(`[reviewgate] ${panelNote}`);
      }
    }
```

Add the import at the top of `orchestrator.ts` (near the other reputation import):

```ts
import { selectActiveReviewers } from "./reputation/quarantine.ts";
```

Change the run-loop source from `activeReviewers` to `panelReviewers` (the `const tasks = activeReviewers.map(` at ~593):

```ts
    const tasks = panelReviewers.map(
```

At the demote pass (~880, where you removed the `const repCfg`), the block now reads (repCfg already in scope):

```ts
    let repUnreliable: Set<string> | undefined;
    if (repCfg?.enabled) {
      repUnreliable = await new ReputationStore(repo)
        .unreliableReviewers(repCfg, new Date())
        .catch(() => undefined);
    }
```

Pass `panelNote` to BOTH `writeReport` calls:
- Zero-ok ERROR write (~line 809): `await this.writeReport(opts, start, settled, [], "ERROR", undefined, undefined, panelNote);`
- Main panel write (~line 906): append `panelNote` as the final argument of that call (after the `critic` argument).

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test tests/unit/orchestrator.test.ts -t "quarantines a sub-floor reviewer"`
Expected: PASS. Then run the whole orchestrator file: `bun test tests/unit/orchestrator.test.ts` — expect the existing reputation/integration tests still pass (the demote-integration test is unaffected: quarantine defaults off in its config).

- [ ] **Step 8: Typecheck + lint + commit**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean (run `bun run format` then re-check if biome flags formatting).

```bash
git add src/schemas/pending-report.ts src/core/report-writer.ts src/core/orchestrator.ts tests/unit/orchestrator.test.ts
git commit -m "feat(reputation): quarantine skips sub-floor reviewers + panel_note surfacing"
```

---

## Task 5: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full suite + static checks**

Run:
```bash
bunx tsc --noEmit
bun run lint
bun test
```
Expected: all green. The known intermittent `runDoctor` timeout flake is unrelated — if (and only if) it flakes, re-run `bun test` once. Any OTHER failure → STOP and report BLOCKED with details (do not patch unrelated code).

- [ ] **Step 2: Manual doctor sanity (optional)**

In a scratch repo with a seeded sub-floor composite key and `quarantine.enabled`, `bun run dev doctor` should show the reviewer's line with `⛔ quarantined`. Unit tests already cover this; final smoke check only.

- [ ] **Step 3: No commit (verification task).** Report the suite result + the four task commit SHAs for the final review gate.

---

## Final Verification (before the cross-agent review gate)

- [ ] `bunx tsc --noEmit` clean
- [ ] `bun run lint` clean
- [ ] `bun test` green (full suite)

Then run the cross-agent review (Codex + final Claude over the whole branch), fix findings, and stop for push approval.
