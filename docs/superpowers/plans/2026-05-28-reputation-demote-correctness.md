# Reputation-demote correctness → INFO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a chronically-wrong (`repUnreliable`) lone reviewer's uncorroborated **correctness** CRITICAL/WARN findings demote to **INFO (advisory, non-blocking)**, while **security** findings are never softened.

**Architecture:** Refine the existing `repScoped` pass in `src/core/aggregator.ts`. Split the blanket `touchesSecurityOrCorrectness` exemption into `touchesSecurity` (always exempt) + `touchesCorrectness` (demotable to INFO when the new `demoteCorrectness` flag is on). INFO findings are never in the loop-driver's `requiredIds`, so the demote removes the per-run rejection tax without changing the verdict machinery or `softPassPolicy`.

**Tech Stack:** Bun, TypeScript, zod config, `bun test`, biome.

**Spec:** `docs/superpowers/specs/2026-05-28-reputation-demote-correctness-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/config/define-config.ts` | zod config schema | Add `demoteCorrectness: z.boolean().default(true)` to `phases.reputation` (object + its outer `.default({...})`) |
| `src/config/defaults.ts` | effective defaults | Add `demoteCorrectness: true` to the `reputation` block |
| `src/core/aggregator.ts` | severity-weighted verdict + demotes | Add `demoteCorrectness?` to `AggregateInput`; add `touchesSecurity`/`touchesCorrectness`; carve-in in `repScoped` |
| `src/core/orchestrator.ts` | pipeline wiring | Thread `demoteCorrectness: repCfg?.demoteCorrectness ?? true` into the `aggregate({...})` call |
| `tests/unit/aggregator-reputation.test.ts` | aggregator demote tests | Add correctness-demote cases (TDD) |

**Default convention (important):** `AggregateInput.demoteCorrectness` is **OFF when absent** — every existing aggregator test omits it, so their behavior is preserved (correctness CRITICALs still exempt in those tests). Production turns it ON via the orchestrator (`repCfg?.demoteCorrectness ?? true`) and the config default `true`. So: config-layer default ON, pure-function default OFF.

---

## Task 1: Config flag + AggregateInput field (plumbing, no behavior change)

**Files:**
- Modify: `src/config/define-config.ts` (reputation block ~108-129)
- Modify: `src/config/defaults.ts` (reputation block ~103-109)
- Modify: `src/core/aggregator.ts` (`AggregateInput` ~10-44)

- [ ] **Step 1: Add the schema field** in `src/config/define-config.ts`. In the `reputation` `z.object({...})`, add the field after `halfLifeDays`:

```ts
        halfLifeDays: z.number().positive().default(45),
        // Demote a lone unreliable reviewer's uncorroborated CORRECTNESS finding to
        // INFO (advisory). security is never softened. Default ON.
        demoteCorrectness: z.boolean().default(true),
```

And add it to the object's outer `.default({...})` so an absent `reputation` key still carries it explicitly:

```ts
      .default({
        enabled: true,
        minSamples: 8,
        trustFloor: 0.35,
        halfLifeDays: 45,
        demoteCorrectness: true,
        quarantine: { enabled: false, floor: 0.15 },
      }),
```

- [ ] **Step 2: Add the explicit default** in `src/config/defaults.ts` reputation block:

```ts
    reputation: {
      enabled: true,
      minSamples: 8,
      trustFloor: 0.35,
      halfLifeDays: 45,
      demoteCorrectness: true,
      quarantine: { enabled: false, floor: 0.15 },
```

- [ ] **Step 3: Add the field to `AggregateInput`** in `src/core/aggregator.ts`, right after the `repUnreliable?: Set<string>;` field:

```ts
  repUnreliable?: Set<string>;
  // When true, a lone unreliable reviewer's uncorroborated CORRECTNESS finding is
  // demoted to INFO (advisory). security is NEVER demoted. Absent/false → off
  // (preserves the pre-feature behavior; production passes true from config).
  demoteCorrectness?: boolean;
```

- [ ] **Step 4: Typecheck + full test (no behavior change expected)**

Run: `bunx tsc --noEmit && bun test`
Expected: tsc clean; all tests pass unchanged (nothing consumes the flag yet).

- [ ] **Step 5: Commit**

```bash
git add src/config/define-config.ts src/config/defaults.ts src/core/aggregator.ts
git commit -m "feat(reputation): add demoteCorrectness config flag + AggregateInput field (default on)"
```

---

## Task 2: Helper split + `repScoped` carve-in (TDD)

**Files:**
- Test: `tests/unit/aggregator-reputation.test.ts`
- Modify: `src/core/aggregator.ts` (`touchesSecurityOrCorrectness` ~118-121; `repScoped` ~367-394)

- [ ] **Step 1: Add the failing tests** to `tests/unit/aggregator-reputation.test.ts` (append inside the existing `describe("aggregator reputation demote", ...)` block — it already defines the `finding(over)` helper). These use the existing helper:

```ts
  it("demotes a lone unreliable CORRECTNESS CRITICAL → INFO (PASS) when demoteCorrectness on", () => {
    const agg = aggregate({
      findings: [finding({ category: "correctness" })],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini:security"]),
      demoteCorrectness: true,
    });
    const f = agg.dedupedFindings[0];
    expect(f?.severity).toBe("INFO");
    expect(f?.reputation_demoted).toBe(true);
    expect(agg.verdict).toBe("PASS");
  });

  it("demotes a lone unreliable CORRECTNESS WARN → INFO too", () => {
    const agg = aggregate({
      findings: [finding({ category: "correctness", severity: "WARN" })],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini:security"]),
      demoteCorrectness: true,
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("INFO");
    expect(agg.verdict).toBe("PASS");
  });

  it("NEVER demotes a SECURITY CRITICAL even with demoteCorrectness on", () => {
    const agg = aggregate({
      findings: [finding({ category: "security" })],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini:security"]),
      demoteCorrectness: true,
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(agg.verdict).toBe("FAIL");
  });

  it("does NOT demote a correctness finding that has a SECURITY member", () => {
    // representative is correctness, but a merged member is security → touchesSecurity → exempt
    const f1 = finding({ signature: "sig-9", category: "correctness", reviewer: { provider: "gemini", model: "x", persona: "security" } });
    const f2 = finding({ signature: "sig-9", category: "security", reviewer: { provider: "gemini", model: "x", persona: "security" } });
    const agg = aggregate({
      findings: [f1, f2],
      reviewersTotal: 1,
      repUnreliable: new Set(["gemini:security"]),
      demoteCorrectness: true,
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });

  it("does NOT demote correctness when demoteCorrectness is off (default)", () => {
    const agg = aggregate({
      findings: [finding({ category: "correctness" })],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini:security"]),
      // demoteCorrectness omitted → off
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(agg.dedupedFindings[0]?.reputation_demoted).toBeUndefined();
  });

  it("does NOT demote a corroborated (majority) correctness CRITICAL", () => {
    const f1 = finding({ signature: "sig-8", category: "correctness", reviewer: { provider: "gemini", model: "x", persona: "security" } });
    const f2 = finding({ signature: "sig-8", category: "correctness", reviewer: { provider: "codex", model: "y", persona: "quality" } });
    const agg = aggregate({
      findings: [f1, f2],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini:security", "codex:quality"]),
      demoteCorrectness: true,
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });
```

- [ ] **Step 2: Run the new tests to verify they FAIL**

Run: `bun test tests/unit/aggregator-reputation.test.ts`
Expected: the correctness-demote cases FAIL (current code exempts all correctness via `touchesSecurityOrCorrectness`, so severity stays CRITICAL/WARN). The security/off/majority cases already pass.

- [ ] **Step 3: Add the two helpers** in `src/core/aggregator.ts` directly below the existing `touchesSecurityOrCorrectness` (keep that one — it still guards the critic block, confidence exemption, and verdict hard-FAIL):

```ts
// True if the finding's representative OR any merged member is `security`.
// security findings are NEVER reputation-demoted (hard veto preserved).
function touchesSecurity(f: Finding): boolean {
  const cats = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
  return cats.some((c) => c === "security");
}
// True if the finding's representative OR any merged member is `correctness`.
function touchesCorrectness(f: Finding): boolean {
  const cats = [f.category, ...(f.members?.map((m) => m.category) ?? [])];
  return cats.some((c) => c === "correctness");
}
```

- [ ] **Step 4: Rewrite the `repScoped` map body** in `src/core/aggregator.ts`. Replace the current map callback (the one starting `if (f.severity === "INFO") return f;` through the final `return {...}`) with:

```ts
      ? confScoped.map((f) => {
          if (f.severity === "INFO") return f;
          if (f.consensus === "unanimous" || f.consensus === "majority") return f;
          // security is NEVER softened — hard veto preserved.
          if (touchesSecurity(f)) return f;
          const isCorrectness = touchesCorrectness(f);
          // correctness is exempt UNLESS the demoteCorrectness flag is on.
          if (isCorrectness && input.demoteCorrectness !== true) return f;
          const keys =
            f.confirmed_by && f.confirmed_by.length > 0
              ? f.confirmed_by
              : [`${f.reviewer.provider}:${f.reviewer.persona}`];
          if (!keys.every((k) => repUnreliable.has(k))) return f;
          if (isCorrectness) {
            // Advisory tier: a chronically-wrong lone reviewer's correctness
            // finding goes straight to INFO (non-blocking, no decision required),
            // CRITICAL or WARN alike. Mirrors the FP-ledger advisory demote.
            const note =
              "\n\n↓ low reviewer reputation — correctness finding from an unreliable lone reviewer; advisory only.";
            return {
              ...f,
              severity: "INFO" as const,
              reputation_demoted: true,
              details: `${f.details.slice(0, 2000 - note.length)}${note}`,
            };
          }
          // Pure quality/style: existing one-step demote (CRITICAL→WARN, WARN→INFO).
          const next = DEMOTE[f.severity];
          if (next === "drop") return f;
          const note = "\n\n↓ low reviewer reputation — advisory only.";
          return {
            ...f,
            severity: next,
            reputation_demoted: true,
            details: `${f.details.slice(0, 2000 - note.length)}${note}`,
          };
        })
```

Also update the comment above `const repUnreliable = input.repUnreliable;` to reflect that correctness is now demotable-to-INFO under the flag (replace "any security/correctness finding are NEVER reputation-demoted" with "security is never demoted; correctness demotes to INFO when demoteCorrectness is on").

- [ ] **Step 5: Run the tests to verify they PASS**

Run: `bun test tests/unit/aggregator-reputation.test.ts`
Expected: all pass (the 7 original + 6 new).

- [ ] **Step 6: Typecheck + lint + full suite**

Run: `bunx tsc --noEmit && bun run lint && bun test`
Expected: all clean/green. (Existing tests unaffected: they omit `demoteCorrectness` → off; the one named "NEVER demotes a security/correctness CRITICAL" uses `category:"security"` → still CRITICAL.)

- [ ] **Step 7: Commit**

```bash
git add src/core/aggregator.ts tests/unit/aggregator-reputation.test.ts
git commit -m "feat(aggregator): demote lone unreliable correctness findings to INFO advisory"
```

---

## Task 3: Wire the flag through the orchestrator

**Files:**
- Modify: `src/core/orchestrator.ts` (the `aggregate({...})` call ~1007-1023)

- [ ] **Step 1: Pass the flag** into the `aggregate({...})` call. `repCfg` is already in scope (`const repCfg = this.input.config.phases.reputation;` ~657). Add this line alongside the other options (e.g. after the `confidenceFloor` line):

```ts
      confidenceFloor: this.input.config.phases.review.confidenceFloor ?? 0,
      demoteCorrectness: repCfg?.demoteCorrectness ?? true,
```

(Unconditional — safe even when reputation is disabled, because `repScoped` only runs when `repUnreliable?.size > 0`.)

- [ ] **Step 2: Typecheck + full suite**

Run: `bunx tsc --noEmit && bun test`
Expected: clean/green. If an orchestrator/integration test asserts an exact `aggregate` input shape, update it to include `demoteCorrectness`; otherwise no test change.

- [ ] **Step 3: Commit**

```bash
git add src/core/orchestrator.ts
git commit -m "feat(orchestrator): thread reputation.demoteCorrectness into the aggregator"
```

---

## Task 4: Full verification + DoD

**Files:** none (verification only)

- [ ] **Step 1: Static + full suite**

Run: `bunx tsc --noEmit && bun run lint && bun test`
Expected: tsc clean, lint clean, all tests green.

- [ ] **Step 2: Build the binary** (compiled-binary parity)

Run: `bun run build`
Expected: `dist/reviewgate` produced, 0 errors.

- [ ] **Step 3: Config sanity** — confirm the flag is in the effective config:

Run: `bun run dev doctor >/dev/null 2>&1; echo ok` then a quick check that `defineConfig({})` yields `phases.reputation.demoteCorrectness === true` (e.g. a one-off `bun -e` or an existing config-loader test already covers schema defaults). Expected: default resolves to `true`.

- [ ] **Step 4: DoD review pipeline** (per project `CLAUDE.md`): run the agy reviewer (codex-replacement) + an Opus reviewer over the branch diff, fix all findings, gate. Commit only after both PASS; do NOT push without explicit user permission.
