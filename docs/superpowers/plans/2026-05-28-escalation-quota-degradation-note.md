# Honest escalation under quota-degraded panel (Bug 3b) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the gate's precondition escalations fire while a configured reviewer is quota-capped, append a diagnostic "quota-degraded panel" note to ESCALATION.md and the Stop-hook reason — no change to escalation/blocking behavior.

**Architecture:** A new `LoopDriver.quotaDegradationNote(now)` reads the `QuotaCooldownStore` and lists configured-reviewer providers currently capped (`activeUntil`). `escalateAndDecide` appends the note to the `summary` it forwards to `escalate()` (→ ESCALATION.md) and adds a short suffix to the returned reason.

**Tech Stack:** Bun, TypeScript, `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-28-escalation-quota-degradation-note-design.md` (agy-reviewed PASS)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/core/loop-driver.ts` | gate decision + escalation | import `QuotaCooldownStore`; add `quotaDegradationNote`; inject into `escalateAndDecide` |
| `tests/unit/loop-driver.test.ts` | gate tests | seed cooldown store + assert note in ESCALATION.md + reason |

`QuotaCooldownStore` (`src/core/quota-cooldown.ts`) and `ReportWriter.writeEscalation` are reused unchanged (summary already flows into ESCALATION.md).

---

## Task 1: `quotaDegradationNote` helper + escalation injection

**Files:**
- Modify: `src/core/loop-driver.ts` (imports; new method; `escalateAndDecide` ~797-832)
- Test: `tests/unit/loop-driver.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/unit/loop-driver.test.ts`:

```ts
describe("LoopDriver quota-degraded escalation note", () => {
  // Forces a max-iterations escalation (rising real findings) with codex — the
  // default configured reviewer — quota-capped, and asserts the note surfaces.
  async function escalateWith(opts: { capProvider?: string } = {}) {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQDEGR");
    await state.update((cur) => ({ ...cur, iteration: 3, signature_history: [["a"], ["a", "b"]] })); // rising → non-progressing
    if (opts.capProvider) {
      // capped 1h into the future → activeUntil() returns non-null
      const future = new Date(Date.now() + 3_600_000).toISOString();
      new QuotaCooldownStore(repo).record(opts.capProvider, future, new Date());
    }
    writeDirty(repo);
    const cfg = { ...defaultConfig, loop: { ...defaultConfig.loop, maxIterations: 3, stuckThreshold: 99 } };
    const driver = new LoopDriver({
      repoRoot: repo, config: cfg, state, audit: new AuditLogger(auditDir(repo)),
      orchestrator: new Orchestrator({ repoRoot: repo, config: cfg, adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) }, sandboxMode: "off", hostTier: "opus", diff: "", reasonOnFailEnabled: true }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    const escMd = existsSync(join(repo, ".reviewgate", "ESCALATION.md"))
      ? readFileSync(join(repo, ".reviewgate", "ESCALATION.md"), "utf8") : "";
    return { decision, escMd };
  }

  it("appends the quota-degraded note when a configured reviewer (codex) is capped", async () => {
    const { decision, escMd } = await escalateWith({ capProvider: "codex" });
    expect(decision.kind).toBe("block");
    expect(decision.reason).toContain("degraded panel");
    expect(escMd).toContain("Quota-degraded panel");
    expect(escMd).toContain("codex");
  });

  it("no note when no reviewer is capped", async () => {
    const { decision, escMd } = await escalateWith({});
    expect(decision.reason).not.toContain("degraded panel");
    expect(escMd).not.toContain("Quota-degraded panel");
  });

  it("no note when a NON-reviewer provider is capped", async () => {
    // openrouter is not in the default reviewers list (codex is) → not flagged
    const { decision, escMd } = await escalateWith({ capProvider: "openrouter" });
    expect(decision.reason).not.toContain("degraded panel");
    expect(escMd).not.toContain("Quota-degraded panel");
  });
});
```

Add the import to the test file's top if missing: `import { QuotaCooldownStore } from "../../src/core/quota-cooldown.ts";` (and ensure `existsSync`, `readFileSync`, `join` are imported — they already are).

- [ ] **Step 2: Run to verify it FAILS**

Run: `bun test tests/unit/loop-driver.test.ts -t "quota-degraded escalation note"`
Expected: the first test fails (no "degraded panel" / "Quota-degraded panel" yet).

- [ ] **Step 3: Add the import** to `src/core/loop-driver.ts` (top, with the other `./` imports):

```ts
import { QuotaCooldownStore } from "./quota-cooldown.ts";
```

- [ ] **Step 4: Add the helper method** to the `LoopDriver` class (near `escalateAndDecide`):

```ts
  // Diagnostic: if a CONFIGURED reviewer is currently quota-capped, the panel that
  // produced this escalation was degraded. Returns a note for ESCALATION.md +
  // the Stop reason, or null when no reviewer slot is capped. (Quota only — error/
  // timeout degradation is surfaced on the ERROR path via formatCoverageNote.)
  private quotaDegradationNote(now: Date): string | null {
    const reviewers = this.i.config.phases.review.reviewers ?? [];
    const providers = [...new Set(reviewers.map((r) => r.provider))];
    const store = new QuotaCooldownStore(this.i.repoRoot);
    const capped = providers
      .map((p) => ({ p, until: store.activeUntil(p, now) }))
      .filter((x): x is { p: string; until: string } => x.until !== null);
    if (capped.length === 0) return null;
    const list = capped.map((x) => `${x.p} (capped until ${x.until})`).join(", ");
    return (
      `\n\n⚠ Quota-degraded panel: ${list} could not review this cycle. A capped ` +
      `reviewer cannot corroborate or refute the others' findings — if its failover ` +
      `did not cover the slot, this escalation rests on a degraded panel. Consider ` +
      `waiting for the quota reset, then re-run \`reviewgate gate --hook reset\` ` +
      `before treating these findings as final.`
    );
  }
```

- [ ] **Step 5: Inject into `escalateAndDecide`** (~797). At the top of the method body (before `const firstAnnounce`):

```ts
    const degraded = this.quotaDegradationNote(new Date());
    const fullSummary = degraded ? summary + degraded : summary;
    const suffix = degraded ? " · ⚠ degraded panel (quota) — see ESCALATION.md" : "";
```

Pass `fullSummary` (not `summary`) to `this.escalate(...)`:

```ts
      await this.escalate(
        state.session_id,
        state.iteration,
        reasonCode,
        fullSummary,
        state.signature_history,
        state.iteration_stats,
      );
```

Append `suffix` to BOTH returned reasons:

```ts
    if (firstAnnounce) {
      return {
        kind: "block",
        reason: `🟠 Reviewgate · GATE ESCALATED (${reasonCode}) — the gate gave up after repeated rounds without a clean pass and is no longer reviewing your changes. Read .reviewgate/ESCALATION.md, surface it to the human, and run \`reviewgate gate --hook reset\` (or restart the session) to re-arm. End your turn again to proceed.${suffix}`,
      };
    }
    return {
      kind: "allow_stop",
      reason: `🟠 Reviewgate · GATE ESCALATED (${reasonCode}) — not gating. See .reviewgate/ESCALATION.md.${suffix}`,
    };
```

- [ ] **Step 6: Run to verify it PASSES**

Run: `bun test tests/unit/loop-driver.test.ts -t "quota-degraded escalation note"`
Expected: all 3 pass.

- [ ] **Step 7: tsc + lint + the whole loop-driver test file**

Run: `bunx tsc --noEmit && bun run lint && bun test tests/unit/loop-driver.test.ts`
Expected: clean + green (existing escalation tests unaffected — no cooldown seeded → note is null → byte-identical output).

- [ ] **Step 8: Commit**

```bash
git add src/core/loop-driver.ts tests/unit/loop-driver.test.ts
git commit -m "feat(loop-driver): note a quota-degraded panel on escalation (diagnostic)"
```

---

## Task 2: Full verification + DoD

**Files:** none (verification only)

- [ ] **Step 1: Static + full suite**

Run: `bunx tsc --noEmit && bun run lint && bun test`
Expected: tsc clean, lint clean, all green.

- [ ] **Step 2: Build the binary**

Run: `bun run build`
Expected: `dist/reviewgate` produced, 0 errors.

- [ ] **Step 3: DoD review pipeline** (per project `CLAUDE.md`): run the agy reviewer (foreground, standalone Bash call) + an Opus reviewer over the branch diff, fix all findings, gate. Commit only after both PASS; do NOT push without explicit user permission.
```
