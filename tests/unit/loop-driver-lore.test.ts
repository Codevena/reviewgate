// tests/unit/loop-driver-lore.test.ts
//
// Lore v1 (2026-07-09), Task 7 — LoopDriver ENFORCEMENT: decision forcing (a lore
// reminder/canon-promotion finding is decision-required exactly like G0), the
// once-per-local-calendar-day reminder cap, the rejected-reminder cooldown, the
// §4.3-style "claimed fixed but still stale" re-verification (which bypasses the
// daily cap), and canon-promotion approval-ledger writes. See
// docs/superpowers/specs/2026-07-09-lore-design.md ("Staleness + reminder",
// "Canon guard") and .superpowers/sdd/task-7-brief.md.
//
// Stub-orchestrator pattern from loop-driver-defer-incomplete-runs.test.ts.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import { computeVerifiedTree } from "../../src/core/lore/staleness.ts";
import type { IterationResult, IterationRunner } from "../../src/core/orchestrator.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";
import type { ReviewgateState } from "../../src/schemas/state.ts";
import { auditDir, decisionsPath, dirtyFlagPath, pendingJsonPath } from "../../src/utils/paths.ts";

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-lore-"));
  writeFileSync(join(dir, "foo.ts"), "x");
  return dir;
}

function writeDirty(repo: string): void {
  writeFileSync(
    dirtyFlagPath(repo),
    JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
  );
}

function writeDecision(
  repo: string,
  iter: number,
  entry: { finding_id: string; verdict: "accepted" | "rejected"; [k: string]: unknown },
): void {
  const dp = decisionsPath(repo, iter);
  mkdirSync(dirname(dp), { recursive: true });
  writeFileSync(dp, `${JSON.stringify({ schema: "reviewgate.decision.v1", ...entry })}\n`);
}

// LOCAL calendar date, mirroring the production localDateString() under test —
// intentionally NOT toISOString() (that's UTC and the whole point of this
// feature is local-timezone semantics).
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const PASS_SUMMARY: RunSummary = {
  verdict: "PASS",
  source: "panel",
  counts: { critical: 0, warn: 0, info: 0 },
  cost_usd: 0,
  duration_ms: 1,
  demoted: 0,
  signatures: [],
  providers: [],
};

// A fully-valid Finding (matches buildLoreFinding's shape in orchestrator.ts) so
// it survives BOTH the loose readers (previousFindingIds, absorbLoreDecisions)
// AND any strict FindingSchema.safeParse reader (readPendingReport) that shares
// pending.json.
function loreFinding(kind: "reminder" | "canon-promotion", entryId: string, idNum = 1) {
  return {
    id: `F-L${String(idNum).padStart(2, "0")}`,
    signature: `lore:${kind}:${entryId}`,
    severity: "INFO",
    category: "quality",
    rule_id: kind === "reminder" ? "lore.reminder" : "lore.canon-guard",
    file: `.reviewgate/lore/${entryId}.md`,
    line_start: 1,
    line_end: 1,
    message: `Lore entry \`${entryId}\` needs attention.`,
    details: "details",
    reviewer: { provider: "lore", model: "deterministic", persona: "lore" },
    confidence: 1,
    consensus: "singleton",
    lore: kind,
  };
}

function writePending(repo: string, findings: unknown[]): void {
  writeFileSync(pendingJsonPath(repo), JSON.stringify({ findings }));
}

// A lore entry markdown file on disk, matching src/schemas/lore.ts frontmatter.
function writeLoreEntry(
  repo: string,
  opts: { id: string; anchors: string[]; verifiedTree: string },
): void {
  const dir = join(repo, ".reviewgate", "lore");
  mkdirSync(dir, { recursive: true });
  const anchorsYaml = opts.anchors.map((a) => `  - "${a}"`).join("\n");
  const content = [
    "---",
    "schema: reviewgate.lore.v1",
    `id: ${opts.id}`,
    "status: canon",
    "anchors:",
    anchorsYaml,
    "verified_at: 2026-07-01",
    `verified_tree: "${opts.verifiedTree}"`,
    "---",
    "This entry documents an invariant — the WHY, not what the code already says.",
    "",
  ].join("\n");
  writeFileSync(join(dir, `${opts.id}.md`), content);
}

function loreConfig() {
  return {
    ...defaultConfig,
    phases: {
      ...defaultConfig.phases,
      lore: {
        enabled: true,
        maxInjectChars: 2000,
        reminderDailyCap: 1,
        rejectedReminderCooldownDays: 7,
      },
    },
  };
}

type CapturedBudget =
  | { allowed: boolean; cooldownIds: string[]; claimedFixedStaleIds?: string[] }
  | undefined;

// Captures the loreReminderBudget the driver passed into runIteration, and
// returns `result` (defaulting to a bare PASS).
function budgetCaptureStub(
  captured: CapturedBudget[],
  result: Partial<IterationResult> = {},
): IterationRunner {
  return {
    runIteration: async (opts): Promise<IterationResult> => {
      captured.push(opts.loreReminderBudget);
      return {
        verdict: "PASS",
        costUsd: 0,
        durationMs: 1,
        signaturesThisIter: [],
        summary: PASS_SUMMARY,
        ...result,
      };
    },
  };
}

function driver(repo: string, state: StateStore, orchestrator: IterationRunner): LoopDriver {
  return new LoopDriver({
    repoRoot: repo,
    config: loreConfig(),
    state,
    audit: new AuditLogger(auditDir(repo)),
    orchestrator,
    stopHookActive: false,
    freshHeadSha: async () => null,
  });
}

describe("LoopDriver lore enforcement (Task 7)", () => {
  // --- (a) DECISION FORCING ---------------------------------------------------

  it("(a) a lore finding with no matching decision BLOCKS, naming the finding id", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01LOREA1");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writePending(repo, [loreFinding("reminder", "stale-entry")]);
    const orchestrator: IterationRunner = {
      runIteration: async () => {
        throw new Error("must not run — the decisions gate should block first");
      },
    };
    const decision = await driver(repo, state, orchestrator).run();
    expect(decision.kind).toBe("block");
    expect(decision.reason).toContain("F-L01");
  });

  it("(a) a decision addressing the lore finding does NOT block on the decisions gate", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01LOREA2");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writePending(repo, [loreFinding("reminder", "stale-entry")]);
    writeDecision(repo, 1, { finding_id: "F-L01", verdict: "accepted", action: "fixed" });
    const captured: CapturedBudget[] = [];
    const decision = await driver(repo, state, budgetCaptureStub(captured)).run();
    expect(decision.kind).not.toBe("block");
    // Reaching the panel run at all proves the decisions gate did not block.
    expect(captured.length).toBe(1);
  });

  // --- (b) DAILY CAP ------------------------------------------------------------

  it("(b) allowed is false when lore_reminder_last_date is today (local)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01LOREB1");
    await state.update((cur) => ({ ...cur, lore_reminder_last_date: todayLocal() }));
    writeDirty(repo);
    const captured: CapturedBudget[] = [];
    await driver(repo, state, budgetCaptureStub(captured)).run();
    expect(captured[0]?.allowed).toBe(false);
  });

  it("(b) allowed is true when lore_reminder_last_date is a different (past) date", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01LOREB2");
    await state.update((cur) => ({ ...cur, lore_reminder_last_date: "2020-01-01" }));
    writeDirty(repo);
    const captured: CapturedBudget[] = [];
    await driver(repo, state, budgetCaptureStub(captured)).run();
    expect(captured[0]?.allowed).toBe(true);
  });

  it("(b) a run whose loreOutcomes.reminderEmittedId is set advances lore_reminder_last_date to today", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01LOREB3");
    writeDirty(repo);
    const captured: CapturedBudget[] = [];
    await driver(
      repo,
      state,
      budgetCaptureStub(captured, {
        loreOutcomes: { reminderEmittedId: "stale-entry", promotions: [] },
      }),
    ).run();
    const st = await state.load();
    expect(st.lore_reminder_last_date).toBe(todayLocal());
  });

  it("(b) a run with NO reminderEmittedId leaves lore_reminder_last_date untouched", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01LOREB4");
    await state.update((cur) => ({ ...cur, lore_reminder_last_date: "2020-01-01" }));
    writeDirty(repo);
    const captured: CapturedBudget[] = [];
    await driver(
      repo,
      state,
      budgetCaptureStub(captured, { loreOutcomes: { promotions: [] } }),
    ).run();
    const st = await state.load();
    expect(st.lore_reminder_last_date).toBe("2020-01-01");
  });

  it("(b) phases.lore disabled: the budget is always the disabled default", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01LOREB5");
    writeDirty(repo);
    const captured: CapturedBudget[] = [];
    const off = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig, // phases.lore is null (off) in defaultConfig
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: budgetCaptureStub(captured),
      stopHookActive: false,
      freshHeadSha: async () => null,
    });
    await off.run();
    expect(captured[0]).toEqual({ allowed: false, cooldownIds: [], claimedFixedStaleIds: [] });
  });

  // --- (c) COOLDOWN ---------------------------------------------------------------

  it("(c) a rejected reminder decision writes a future-dated cooldown that populates cooldownIds", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01LOREC1");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writePending(repo, [loreFinding("reminder", "stale-entry")]);
    writeDecision(repo, 1, {
      finding_id: "F-L01",
      verdict: "rejected",
      reason: "still accurate, no change needed right now",
    });
    const captured: CapturedBudget[] = [];
    await driver(repo, state, budgetCaptureStub(captured)).run();

    const st = await state.load();
    expect(Object.keys(st.lore_rejection_cooldowns)).toContain("stale-entry");
    const untilMs = Date.parse(st.lore_rejection_cooldowns["stale-entry"] as string);
    expect(untilMs).toBeGreaterThan(Date.now());
    // Same-turn effect: absorbLoreDecisions runs before computeLoreReminderBudget,
    // so the cooldown is already reflected in THIS run's outgoing budget.
    expect(captured[0]?.cooldownIds).toContain("stale-entry");
  });

  // --- (d) CLAIMED-FIXED re-verification -------------------------------------------

  it("(d1) a fixed decision on a reminder finding records the entry id in lore_claimed_fixed", async () => {
    const repo = fakeRepo();
    // The entry file must actually exist — a "reminder" finding always originates
    // from a real lore entry, and computeLoreReminderBudget re-verifies the claim
    // against the live tree LATER IN THIS SAME TURN (§4.3-style, "verified, not
    // trusted"): a claim for an entry that can't be found is dropped as "gone",
    // which would otherwise mask the very write this test checks. Deliberately
    // still-stale (wrong verified_tree) so the same-turn reclassification KEEPS it.
    writeLoreEntry(repo, { id: "stale-entry", anchors: ["foo.ts"], verifiedTree: "0".repeat(64) });
    const state = new StateStore(repo);
    await state.initialise("01LORED1");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writePending(repo, [loreFinding("reminder", "stale-entry")]);
    writeDecision(repo, 1, { finding_id: "F-L01", verdict: "accepted", action: "fixed" });
    const captured: CapturedBudget[] = [];
    await driver(repo, state, budgetCaptureStub(captured)).run();

    const st = await state.load();
    expect(st.lore_claimed_fixed).toContain("stale-entry");
  });

  it("(d2) a claimed-fixed entry that is STILL stale bypasses the daily cap and is reported in claimedFixedStaleIds", async () => {
    const repo = fakeRepo();
    writeFileSync(join(repo, "foo.ts"), "content v2"); // real content, deliberately mismatched below
    writeLoreEntry(repo, {
      id: "stale-entry",
      anchors: ["foo.ts"],
      verifiedTree: "0".repeat(64), // wrong on purpose -> classifyEntry === "stale"
    });
    const state = new StateStore(repo);
    await state.initialise("01LORED2");
    await state.update((cur) => ({
      ...cur,
      lore_claimed_fixed: ["stale-entry"],
      lore_reminder_last_date: todayLocal(), // the daily cap is ALREADY consumed
    }));
    writeDirty(repo);
    const captured: CapturedBudget[] = [];
    await driver(repo, state, budgetCaptureStub(captured)).run();

    expect(captured[0]?.allowed).toBe(true); // bypass despite the consumed cap
    expect(captured[0]?.claimedFixedStaleIds).toContain("stale-entry");
    // The claim itself survives (still stale) — re-classification does not drop it.
    const st = await state.load();
    expect(st.lore_claimed_fixed).toContain("stale-entry");
  });

  it("(d3) a claimed-fixed entry that is now FRESH is cleared and does NOT bypass the cap", async () => {
    const repo = fakeRepo();
    writeFileSync(join(repo, "foo.ts"), "content that matches the verified tree");
    const tree = computeVerifiedTree(repo, ["foo.ts"]);
    writeLoreEntry(repo, { id: "stale-entry", anchors: ["foo.ts"], verifiedTree: tree }); // FRESH
    const state = new StateStore(repo);
    await state.initialise("01LORED3");
    await state.update((cur) => ({
      ...cur,
      lore_claimed_fixed: ["stale-entry"],
      lore_reminder_last_date: todayLocal(), // the daily cap is ALREADY consumed
    }));
    writeDirty(repo);
    const captured: CapturedBudget[] = [];
    await driver(repo, state, budgetCaptureStub(captured)).run();

    expect(captured[0]?.allowed).toBe(false); // no bypass — cap stays consumed
    expect(captured[0]?.claimedFixedStaleIds).toEqual([]);
    const st = await state.load();
    expect(st.lore_claimed_fixed).toEqual([]); // the resolved claim is dropped
  });

  it("(d4) a claimed-fixed entry whose file is gone is dropped (never throws)", async () => {
    const repo = fakeRepo();
    // No .reviewgate/lore/vanished-entry.md written at all.
    const state = new StateStore(repo);
    await state.initialise("01LORED4");
    await state.update((cur) => ({
      ...cur,
      lore_claimed_fixed: ["vanished-entry"],
      lore_reminder_last_date: todayLocal(),
    }));
    writeDirty(repo);
    const captured: CapturedBudget[] = [];
    await driver(repo, state, budgetCaptureStub(captured)).run();

    expect(captured[0]?.allowed).toBe(false);
    expect(captured[0]?.claimedFixedStaleIds).toEqual([]);
    const st = await state.load();
    expect(st.lore_claimed_fixed).toEqual([]);
  });

  // --- (e) APPROVAL-LEDGER WRITES ---------------------------------------------------

  it("(e1) a fixed decision on a canon-promotion finding appends exactly one approvals.jsonl line", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01LOREE1");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writePending(repo, [loreFinding("canon-promotion", "promo-entry")]);
    writeDecision(repo, 1, { finding_id: "F-L01", verdict: "accepted", action: "fixed" });
    const captured: CapturedBudget[] = [];
    await driver(repo, state, budgetCaptureStub(captured)).run();

    const approvalsPath = join(repo, ".reviewgate", "lore", "approvals.jsonl");
    expect(existsSync(approvalsPath)).toBe(true);
    const lines = readFileSync(approvalsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed.id).toBe("promo-entry");
    expect(parsed.decision_ref).toBe("F-L01");
  });

  it("(e2) a rejected decision on a canon-promotion finding does NOT append an approvals line", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01LOREE2");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writePending(repo, [loreFinding("canon-promotion", "promo-entry")]);
    writeDecision(repo, 1, {
      finding_id: "F-L01",
      verdict: "rejected",
      reason: "reverting to draft status manually, not approved",
    });
    const captured: CapturedBudget[] = [];
    await driver(repo, state, budgetCaptureStub(captured)).run();

    const approvalsPath = join(repo, ".reviewgate", "lore", "approvals.jsonl");
    expect(existsSync(approvalsPath)).toBe(false);
  });

  // --- (f) CLEAN-PASS DECISION FORCING ---------------------------------------------
  // The CRITICAL fix: a lore finding emitted on an otherwise-clean diff yields
  // verdict PASS (lore findings are INFO). Without the loreDecisionRequired gate term
  // the round RE-ARMS (iteration→0, dirty flag + decisions cleared, allow_stop): the
  // reminder is shown and the daily cap consumed, but the agent is NEVER forced to
  // decide. These drive a REAL run from iteration 0 (the case the original suite
  // missed by pre-seeding iteration:1) and assert it blocks + advances instead.

  it("(f1) a clean PASS that emitted a lore reminder BLOCKS and advances (does NOT re-arm)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01LOREF1"); // iteration 0 = fresh batch, no prior decisions-gate
    writeDirty(repo);
    const captured: CapturedBudget[] = [];
    const decision = await driver(
      repo,
      state,
      budgetCaptureStub(captured, {
        verdict: "PASS",
        loreOutcomes: { reminderEmittedId: "stale-entry", promotions: [] },
      }),
    ).run();

    // Blocks instead of re-arming — same mechanics as G0's softPassBlocks.
    expect(decision.kind).toBe("block");
    const st = await state.load();
    // Iteration ADVANCED (not reset to 0) so the next stop lands at iteration>0 and
    // the decisions-gate forces a decision for the lore finding.
    expect(st.iteration).toBe(1);
    // Dirty flag PRESERVED so the next stop actually re-reviews + gates (the re-arm
    // path would have deleted it).
    expect(existsSync(dirtyFlagPath(repo))).toBe(true);
    // The daily cap was still consumed (the reminder is verdict-neutral).
    expect(st.lore_reminder_last_date).toBe(todayLocal());
    // Honest block reason: points at pending.md and names the lore finding (not a
    // misleading "CRITICAL/WARN" line over a 0/0 summary).
    expect(decision.reason).toContain(".reviewgate/pending.md");
    expect(decision.reason.toLowerCase()).toContain("lore");
  });

  it("(f2) a clean PASS that produced a canon-promotion BLOCKS and advances", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01LOREF2");
    writeDirty(repo);
    const captured: CapturedBudget[] = [];
    const decision = await driver(
      repo,
      state,
      budgetCaptureStub(captured, {
        verdict: "PASS",
        loreOutcomes: { promotions: ["promo-entry"] },
      }),
    ).run();

    expect(decision.kind).toBe("block");
    const st = await state.load();
    expect(st.iteration).toBe(1);
    expect(existsSync(dirtyFlagPath(repo))).toBe(true);
    expect(decision.reason.toLowerCase()).toContain("lore");
  });

  it("(f3) a clean PASS with NO lore outcomes still re-arms (allow_stop) — happy path intact", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01LOREF3");
    writeDirty(repo);
    const captured: CapturedBudget[] = [];
    const decision = await driver(repo, state, budgetCaptureStub(captured)).run();

    // No loreOutcomes → loreDecisionRequired is false → the round re-arms as before.
    expect(decision.kind).toBe("allow_stop");
    const st = await state.load();
    expect(st.iteration).toBe(0);
    expect(existsSync(dirtyFlagPath(repo))).toBe(false);
  });

  // --- (g) IDEMPOTENT DECISION ABSORPTION ------------------------------------------
  // The IMPORTANT fix: on a timeout / all-quota / all-infra DEFER the iteration stays
  // fixed and decisions/<iter>.jsonl is intact, so the next attempt RE-ABSORBS the same
  // decisions. Without idempotency guards that appends a DUPLICATE approvals.jsonl line
  // and RE-EXTENDS a rejected reminder's cooldown. This calls the absorb path twice over
  // the same iteration and asserts each side effect fires exactly once.

  it("(g1) re-absorbing the same iteration writes exactly ONE approval line and never re-extends a cooldown", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01LOREG1");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writePending(repo, [
      loreFinding("canon-promotion", "promo-entry", 1),
      loreFinding("reminder", "stale-entry", 2),
    ]);
    // decisions/1.jsonl with BOTH a fixed canon-promotion and a rejected reminder.
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${[
        {
          schema: "reviewgate.decision.v1",
          finding_id: "F-L01",
          verdict: "accepted",
          action: "fixed",
        },
        {
          schema: "reviewgate.decision.v1",
          finding_id: "F-L02",
          verdict: "rejected",
          reason: "still accurate, no change needed right now",
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );

    const d = driver(repo, state, budgetCaptureStub([]));
    // absorbLoreDecisions is private; invoke it directly (the "call the absorb path
    // twice" option the brief sanctions) — deterministic, no defer machinery needed.
    const absorb = (s: ReviewgateState) =>
      (
        d as unknown as { absorbLoreDecisions(s: ReviewgateState): Promise<void> }
      ).absorbLoreDecisions(s);

    await absorb(await state.load());
    const afterFirst = await state.load();
    const cooldownAfterFirst = afterFirst.lore_rejection_cooldowns["stale-entry"];
    expect(typeof cooldownAfterFirst).toBe("string");

    // A measurable gap so a NON-idempotent cooldown write would produce a strictly
    // later ISO `until` on the second pass (mutation observability); the guard keeps
    // it byte-identical regardless.
    await new Promise((r) => setTimeout(r, 12));

    // Second absorb over the SAME iteration (mirrors a deferred re-run reloading state).
    await absorb(await state.load());
    const afterSecond = await state.load();

    // Approval: exactly ONE line (not two).
    const approvalsPath = join(repo, ".reviewgate", "lore", "approvals.jsonl");
    const lines = readFileSync(approvalsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    expect(lines).toHaveLength(1);

    // Cooldown: `until` is IDENTICAL after the second absorb (not pushed later).
    expect(afterSecond.lore_rejection_cooldowns["stale-entry"]).toBe(cooldownAfterFirst);
  });
});
