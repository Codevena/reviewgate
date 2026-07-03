// tests/unit/loop-driver-quota-latch.test.ts
//
// S4a: bound + escalate the all-quota defer, with a stable post-escalation latch.
// handleAllQuotaLocked's defer was UNBOUNDED — every all-quota turn deferred
// forever with nothing but a console note. codex/agy quota reset windows reach
// days-to-weeks, so an unbounded defer ships the whole window un-reviewed with no
// human visibility. This bounds it (like handleInfraUnavailable) and, once
// escalated, LATCHES so the batch stays flagged + the human handoff stays stable
// (no ESCALATION.md churn) until a reviewer actually completes a real review.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { stopProbe } from "../../src/cli/commands/gate.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import type { ReviewgateConfig } from "../../src/config/define-config.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import type { IterationResult, IterationRunner } from "../../src/core/orchestrator.ts";
import { QuotaCooldownStore } from "../../src/core/quota-cooldown.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";
import { auditDir, dirtyFlagPath, escalationMdPath } from "../../src/utils/paths.ts";

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-quota-latch-"));
  writeFileSync(join(dir, "foo.ts"), "x");
  return dir;
}

interface DirtyFlagShape {
  diff_hash: string;
  ts: string;
  base_sha?: string;
}

function writeDirty(repo: string): void {
  writeFileSync(
    dirtyFlagPath(repo),
    JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
  );
}

function writeDirtyWithBase(repo: string, base: string): void {
  writeFileSync(
    dirtyFlagPath(repo),
    JSON.stringify({ diff_hash: "h", ts: new Date().toISOString(), base_sha: base }),
  );
}

function readFlag(repo: string): DirtyFlagShape {
  return JSON.parse(readFileSync(dirtyFlagPath(repo), "utf8")) as DirtyFlagShape;
}

const escPath = (repo: string) => escalationMdPath(repo);

function baseSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    verdict: "ERROR",
    source: "panel",
    counts: { critical: 0, warn: 0, info: 0 },
    cost_usd: 0,
    duration_ms: 1,
    demoted: 0,
    signatures: [],
    providers: [],
    ...overrides,
  } as RunSummary;
}

// Every attempted reviewer was quota-exhausted this turn — the pure all-quota
// outage handleAllQuotaLocked exists for.
function quotaLockedOrchestrator(): IterationRunner {
  return {
    runIteration: async (): Promise<IterationResult> => ({
      verdict: "ERROR",
      allReviewersQuotaLocked: true,
      costUsd: 0,
      durationMs: 1,
      signaturesThisIter: [],
      summary: baseSummary({ verdict: "ERROR" }),
    }),
  };
}

// Every attempted reviewer failed for a MIXED reason (quota/timeout/error) —
// handleInfraUnavailable's lane, distinct from the pure all-quota one.
function infraFailedOrchestrator(): IterationRunner {
  return {
    runIteration: async (): Promise<IterationResult> => ({
      verdict: "ERROR",
      allReviewersInfraFailed: true,
      costUsd: 0,
      durationMs: 1,
      signaturesThisIter: [],
      summary: baseSummary({ verdict: "ERROR" }),
    }),
  };
}

function passOrchestrator(): IterationRunner {
  return {
    runIteration: async (): Promise<IterationResult> => ({
      verdict: "PASS",
      costUsd: 0,
      durationMs: 1,
      signaturesThisIter: [],
      summary: baseSummary({ verdict: "PASS" }),
    }),
  };
}

function failOrchestrator(): IterationRunner {
  return {
    runIteration: async (): Promise<IterationResult> => ({
      verdict: "FAIL",
      costUsd: 0,
      durationMs: 1,
      signaturesThisIter: ["sig-recovery-fail"],
      summary: baseSummary({
        verdict: "FAIL",
        counts: { critical: 1, warn: 0, info: 0 },
        signatures: ["sig-recovery-fail"],
      }),
    }),
  };
}

// The escalation preconditions (cost-cap/max-iterations/stuck-signatures/…) all
// early-return before any panel runs; this stub proves runIteration is never
// reached on that path.
const neverRuns: IterationRunner = {
  runIteration: async (): Promise<IterationResult> => {
    throw new Error("orchestrator.runIteration must not run on the precondition defer path");
  },
};

// Marks the sole configured reviewer (codex) quota-capped so
// quotaDegradationNote / the deferableOnQuota precondition path is live.
function capCodex(repo: string): void {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  new QuotaCooldownStore(repo).record("codex", future, new Date());
}

function mkDriver(
  repo: string,
  state: StateStore,
  config: ReviewgateConfig,
  orchestrator: IterationRunner,
): LoopDriver {
  return new LoopDriver({
    repoRoot: repo,
    config,
    state,
    audit: new AuditLogger(auditDir(repo)),
    orchestrator,
    stopHookActive: false,
    freshHeadSha: async () => null, // unused stub — no real git repo in these fixtures
  });
}

function capConfig(n: number): ReviewgateConfig {
  return { ...defaultConfig, loop: { ...defaultConfig.loop, quotaDeferMaxConsecutive: n } };
}

describe("S4a: bounded + escalated + latched all-quota defer", () => {
  it("all-quota defers are bounded: cap+1 consecutive all-quota turns escalate", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQBOUND1");
    const config = capConfig(1);
    writeDirty(repo);

    // Turn 1: all-quota → defer, counter 1.
    const d1 = await mkDriver(repo, state, config, quotaLockedOrchestrator()).run();
    expect(d1.kind).toBe("allow_stop");
    expect(d1.reason).toMatch(/DEFERRED/);
    let st = await state.load();
    expect(st.consecutive_quota_defers).toBe(1);
    expect(st.escalated).toBe(false);
    expect(existsSync(escPath(repo))).toBe(false);

    // Turn 2: still all-quota, now OVER the cap → escalates.
    const d2 = await mkDriver(repo, state, config, quotaLockedOrchestrator()).run();
    expect(d2.reason).toMatch(/ESCALAT/);
    expect(d2.reason).toContain("quota-exhausted-persistent");
    expect(existsSync(escPath(repo))).toBe(true);
    st = await state.load();
    expect(st.escalated).toBe(true);
    expect(st.escalation_reason).toBe("quota-exhausted-persistent");
    expect(st.consecutive_quota_defers).toBe(0); // reset by the announce
  });

  it("quotaDeferMaxConsecutive=0 (defer disabled) hard-blocks an all-quota turn immediately", async () => {
    // DoD WARN: `cap > 0 && next > cap` never fires at cap=0, so cap=0 fell
    // through to the under-cap defer branch FOREVER — unbounded defers, the exact
    // fail-open S4a exists to close. Mirror handleInfraUnavailable's documented
    // cap-0 semantic: defer disabled → hard-block immediately (no escalation —
    // a hard block is the prior behavior the opt-out restores, not a handoff).
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQCAPZERO1");
    const config = capConfig(0);
    writeDirty(repo);

    const decision = await mkDriver(repo, state, config, quotaLockedOrchestrator()).run();

    expect(decision.kind).toBe("block");
    expect(decision.reason).toMatch(/CLOSED/);
    expect(existsSync(dirtyFlagPath(repo))).toBe(true); // flag survives — re-review next turn
    expect(existsSync(escPath(repo))).toBe(false); // a hard-block is not an escalation write
    const st = await state.load();
    expect(st.escalated).toBe(false);
  });

  it("a successful review resets the all-quota defer streak", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQRESET1");
    const config = capConfig(1);

    writeDirty(repo);
    await mkDriver(repo, state, config, quotaLockedOrchestrator()).run();
    expect((await state.load()).consecutive_quota_defers).toBe(1);

    // An ok (PASS) review breaks the streak.
    writeDirty(repo);
    await mkDriver(repo, state, config, passOrchestrator()).run();
    expect((await state.load()).consecutive_quota_defers).toBe(0);

    // A fresh all-quota turn starts counting from zero again — no escalation.
    writeDirty(repo);
    const d3 = await mkDriver(repo, state, config, quotaLockedOrchestrator()).run();
    expect(d3.kind).toBe("allow_stop");
    expect(d3.reason).not.toMatch(/ESCALAT/);
    const st = await state.load();
    expect(st.consecutive_quota_defers).toBe(1);
    expect(st.escalated).toBe(false);
  });

  // Plan-Gate W1: the defer must never degrade into a silent PASS or unflag the work.
  it("INVARIANT: every all-quota defer keeps the dirty flag, never emits PASS, and the base survives to recovery", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQINVAR1");
    const config = capConfig(1);
    const base = "a".repeat(40);
    writeDirtyWithBase(repo, base);

    // cap(1) + 3 = 4 consecutive all-quota turns, crossing the escalation at turn 2.
    for (let turn = 1; turn <= 4; turn++) {
      const decision = await mkDriver(repo, state, config, quotaLockedOrchestrator()).run();
      expect(decision.kind).toBe("allow_stop");
      expect(decision.reason).not.toMatch(/GATE OPEN|PASS/);
      expect(existsSync(dirtyFlagPath(repo))).toBe(true);
      expect(readFlag(repo).base_sha).toBe(base);
      if (turn >= 2) {
        expect(decision.reason).toContain("ESCALATION.md");
      }
    }

    // Recovery: a reviewer completes a real (FAIL) review of the full ORIGINAL batch.
    await mkDriver(repo, state, config, failOrchestrator()).run();
    expect(existsSync(dirtyFlagPath(repo))).toBe(true); // FAIL keeps the flag armed
    expect(readFlag(repo).base_sha).toBe(base); // same original base — nothing exits scope
    const st = await state.load();
    expect(st.escalated).toBe(false); // latch cleared by the real verdict
    expect(st.escalation_reason).toBeNull();
  });

  // Plan-Gate I1: the two quota-defer consumers share consecutive_quota_defers —
  // interleavings must accumulate, not reset each other.
  it("degraded-panel defer and all-quota defer interleave into one streak", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQINTERL1");
    const config = capConfig(2);

    // Turn 1: a DEGRADED-PANEL defer — the OTHER quota-defer consumer
    // (escalateAndDecide's own precondition-time check for stuck-signatures),
    // reusing the #10 fixture shape (iteration=2, a 2-long identical signature
    // history, codex capped).
    await state.update((cur) => ({
      ...cur,
      iteration: 2,
      signature_history: [["s1"], ["s1"]],
    }));
    capCodex(repo);
    writeDirty(repo);
    const d1 = await mkDriver(repo, state, config, neverRuns).run();
    expect(d1.kind).toBe("allow_stop");
    expect(d1.reason).toMatch(/DEFERRED/);
    expect((await state.load()).consecutive_quota_defers).toBe(1);
    expect((await state.load()).escalated).toBe(false);

    // Reset the confounding preconditions (iteration/signature_history) so turns
    // 2-3 exercise handleAllQuotaLocked in isolation from turn 1's mechanism.
    // consecutive_quota_defers is deliberately left untouched — it carries over
    // from turn 1, which is exactly the shared-counter behavior under test.
    await state.update((cur) => ({ ...cur, iteration: 0, signature_history: [] }));

    // Turn 2: all-quota-locked, under the shared cap (1 -> 2, not yet > 2) → defers.
    writeDirty(repo);
    const d2 = await mkDriver(repo, state, config, quotaLockedOrchestrator()).run();
    expect(d2.kind).toBe("allow_stop");
    expect(d2.reason).not.toMatch(/ESCALAT/);
    expect((await state.load()).consecutive_quota_defers).toBe(2);

    // Turn 3: still all-quota-locked, now OVER the shared cap (2 -> 3 > 2) → escalates.
    writeDirty(repo);
    const d3 = await mkDriver(repo, state, config, quotaLockedOrchestrator()).run();
    expect(d3.reason).toMatch(/ESCALAT/);
    const st = await state.load();
    expect(st.escalated).toBe(true);
    expect(st.escalation_reason).toBe("quota-exhausted-persistent");
  });

  it("a persistent all-quota outage announces exactly ONCE and never re-arms the batch across 6 turns", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQONCE1");
    const config = capConfig(1);
    const base = "b".repeat(40);
    // A distinctive non-zero baseline so "not wiped by Path B" is a meaningful
    // assertion (0 -> 0 would be indistinguishable from a silent wipe).
    await state.update((cur) => ({ ...cur, iteration: 1, signature_history: [["a"]] }));
    writeDirtyWithBase(repo, base);

    let announceContent: string | null = null;
    for (let turn = 1; turn <= 6; turn++) {
      const decision = await mkDriver(repo, state, config, quotaLockedOrchestrator()).run();
      expect(decision.kind).toBe("allow_stop");
      expect(readFlag(repo).base_sha).toBe(base);
      if (turn === 2) {
        expect(existsSync(escPath(repo))).toBe(true);
        announceContent = readFileSync(escPath(repo), "utf8");
      } else if (turn > 2) {
        expect(decision.reason).toContain("ESCALATION.md");
        // Exactly one write: the file is byte-identical to what turn 2 produced.
        expect(announceContent).not.toBeNull();
        expect(readFileSync(escPath(repo), "utf8")).toBe(announceContent as string);
      }
    }

    const st = await state.load();
    // Path B's re-arm (which would zero these) never fired while latched.
    expect(st.iteration).toBe(1);
    expect(st.signature_history).toEqual([["a"]]);
  });

  it("the quota ANNOUNCE turn itself keeps the dirty flag, and the probe re-enters the quota path", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQANNOUNCE1");
    const config = capConfig(1);
    writeDirty(repo);

    await mkDriver(repo, state, config, quotaLockedOrchestrator()).run(); // turn 1: defer
    const announce = await mkDriver(repo, state, config, quotaLockedOrchestrator()).run(); // turn 2: announce
    expect(announce.reason).toMatch(/ESCALAT/);
    expect((await state.load()).escalation_reason).toBe("quota-exhausted-persistent");

    // The unlink exemption applied — the flag survives the announce itself.
    expect(existsSync(dirtyFlagPath(repo))).toBe(true);

    // The probe must take the lock path (never stand down) on the very next stop.
    const probe = await stopProbe(
      repo,
      async () => "H",
      async () => "T",
    );
    expect(probe).toBe("review");
  });

  it("quota recovery clears the quota-escalation latch and reviews the full batch", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQRECOVER1");
    const config = capConfig(1);
    const base = "c".repeat(40);
    writeDirtyWithBase(repo, base);

    await mkDriver(repo, state, config, quotaLockedOrchestrator()).run(); // defer (1)
    await mkDriver(repo, state, config, quotaLockedOrchestrator()).run(); // escalate (reset to 0)
    await mkDriver(repo, state, config, quotaLockedOrchestrator()).run(); // latched defer (1)
    expect((await state.load()).consecutive_quota_defers).toBe(1);
    expect(readFlag(repo).base_sha).toBe(base); // still the original batch, unwidened

    // Quota returns — a reviewer completes a real (PASS) review.
    await mkDriver(repo, state, config, passOrchestrator()).run();

    const st = await state.load();
    expect(st.escalated).toBe(false);
    expect(st.escalation_reason).toBeNull();
    expect(st.consecutive_quota_defers).toBe(0);
  });

  it("an infra ERROR does NOT clear the quota-escalation latch", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQINFRAERR1");
    const config = capConfig(1);
    writeDirty(repo);

    await mkDriver(repo, state, config, quotaLockedOrchestrator()).run(); // defer (1)
    await mkDriver(repo, state, config, quotaLockedOrchestrator()).run(); // escalate
    expect((await state.load()).escalation_reason).toBe("quota-exhausted-persistent");
    const escBefore = readFileSync(escPath(repo), "utf8");

    // Next turn: every reviewer crashes for a MIXED (not pure-quota) reason.
    const decision = await mkDriver(repo, state, config, infraFailedOrchestrator()).run();
    expect(decision.kind).toBe("allow_stop"); // infra-defer, not blocked

    const st = await state.load();
    expect(st.escalated).toBe(true); // latch survives
    expect(st.escalation_reason).toBe("quota-exhausted-persistent");
    expect(readFileSync(escPath(repo), "utf8")).toBe(escBefore); // untouched
  });

  it("a BLOCKING recovery verdict clears the latch but keeps the flag and its ORIGINAL base", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQBLOCKREC1");
    const config = capConfig(1);
    const base = "d".repeat(40);
    writeDirtyWithBase(repo, base);

    await mkDriver(repo, state, config, quotaLockedOrchestrator()).run(); // defer
    await mkDriver(repo, state, config, quotaLockedOrchestrator()).run(); // escalate
    expect((await state.load()).escalation_reason).toBe("quota-exhausted-persistent");
    const flagBefore = readFlag(repo);

    // Quota returns — the panel reviews and FAILS (a real, blocking verdict).
    const decision = await mkDriver(repo, state, config, failOrchestrator()).run();
    expect(decision.kind).toBe("block"); // the normal FAIL loop takes over

    const st = await state.load();
    expect(st.escalated).toBe(false); // latch cleared
    expect(st.escalation_reason).toBeNull();
    expect(existsSync(dirtyFlagPath(repo))).toBe(true); // flag still armed (normal FAIL loop)
    expect(readFlag(repo).base_sha).toBe(flagBefore.base_sha); // original base — nothing exits scope
  });

  it("a misconfig ERROR (neither all-quota nor all-infra) never clears the quota-escalation latch", async () => {
    // Exercises the `result.verdict !== "ERROR"` half of quotaLatchClears in the
    // MAIN post-iteration state update: a plain ERROR (mapping failure/misconfig,
    // allReviewersQuotaLocked and allReviewersInfraFailed both absent) bypasses
    // BOTH early-return defer branches above it and reaches that block directly —
    // the only ERROR shape that does. Nothing was reviewed, so the latch must
    // survive; clearing on it would erase the persistent quota handoff.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQMISCONF1");
    const config = capConfig(1);
    await state.update((cur) => ({
      ...cur,
      escalated: true,
      escalation_reason: "quota-exhausted-persistent",
      escalation_announced: true,
      escalated_head_sha: "H1",
      escalated_tree_hash: "T1",
    }));
    writeDirty(repo);

    const misconfigError: IterationRunner = {
      runIteration: async (): Promise<IterationResult> => ({
        verdict: "ERROR",
        costUsd: 0,
        durationMs: 1,
        signaturesThisIter: [],
        summary: baseSummary({ verdict: "ERROR" }),
      }),
    };
    const decision = await mkDriver(repo, state, config, misconfigError).run();
    expect(decision.kind).toBe("block"); // the normal misconfig-ERROR hard-block

    const st = await state.load();
    expect(st.escalated).toBe(true); // latch survives — nothing was reviewed
    expect(st.escalation_reason).toBe("quota-exhausted-persistent");
    expect(st.escalated_head_sha).toBe("H1"); // announce-time markers survive too
    expect(st.escalated_tree_hash).toBe("T1");
    expect(existsSync(dirtyFlagPath(repo))).toBe(true);
  });

  it("a mid-outage commit does not recover the quota latch (Path A exemption)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQMIDCOMMIT1");
    const config = capConfig(1);
    await state.update((cur) => ({
      ...cur,
      escalated: true,
      escalation_reason: "quota-exhausted-persistent",
      escalation_announced: true,
      last_reviewed_head_sha: "H0",
      escalated_head_sha: "H1", // recorded at the announce
      escalated_tree_hash: "T1",
    }));
    const base = "e".repeat(40);
    writeDirtyWithBase(repo, base);

    const decision = await new LoopDriver({
      repoRoot: repo,
      config,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: quotaLockedOrchestrator(),
      stopHookActive: false,
      headSha: "H2", // a commit landed AFTER the announce, mid-outage
      freshHeadSha: async () => "H2",
    }).run();

    // Still latched — a commit during a quota outage is new UNREVIEWED work
    // joining the still-flagged batch, not a recovery (nothing was reviewed;
    // there are no findings a commit could address).
    expect(decision.kind).toBe("allow_stop");
    const st = await state.load();
    expect(st.escalated).toBe(true);
    expect(st.escalation_reason).toBe("quota-exhausted-persistent");
    expect(st.last_reviewed_head_sha).toBe("H0"); // NOT advanced past the commit
    expect(existsSync(dirtyFlagPath(repo))).toBe(true);
    expect(readFlag(repo).base_sha).toBe(base); // the eventual recovery review covers
    // pre- AND post-commit work from the original base.
  });
});
