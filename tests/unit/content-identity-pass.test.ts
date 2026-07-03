// tests/unit/content-identity-pass.test.ts
//
// T5 / R3 (field report 2026-07-03): content-identity PASS short-circuit. A
// commit / --amend / PR re-fire re-serializes IDENTICAL content into different
// diff bytes, defeating the byte-keyed verdict cache — the field agent got a
// full panel re-run after every amend. The pass_ledger records WHAT passed a
// clean full-coverage panel; a later gate fire whose diff files are all
// byte-identical to it (IDENTICAL keysets, adversarial review 2026-07-03)
// short-circuits to a 'content-cache' PASS. The round-trip tests below run a
// REAL passing panel (in-process adapter stub) to capture the env_hash the
// serve side must accept, then prove the second run spawns no panel by giving
// it an adapter that would FAIL the review.
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { IterationResult } from "../../src/core/orchestrator.ts";
import { snapshotReviewedFiles } from "../../src/core/reviewed-snapshot.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import type { PassLedger } from "../../src/schemas/state.ts";
import { auditDir, dirtyFlagPath } from "../../src/utils/paths.ts";

const CODE = "export const a = 1;\n";
const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-export const a = 0;
+export const a = 1;
`;

function cfg() {
  return {
    ...defaultConfig,
    phases: {
      ...defaultConfig.phases,
      review: {
        ...defaultConfig.phases.review,
        reviewers: [{ provider: "codex" as const, persona: "security" }],
      },
      critic: null,
      triage: null,
    },
  };
}

const stub = (verdict: "PASS" | "FAIL", findings: Finding[] = []): ProviderAdapter => ({
  id: "codex",
  async preflight() {
    return { available: true, version: "x", authMode: "oauth" as const, error: null };
  },
  async review(inp: { reviewerId: string }) {
    return {
      reviewerId: inp.reviewerId,
      verdict,
      findings,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
      durationMs: 1,
      exitCode: 0,
      rawEventsPath: "",
      rawText: "",
      status: "ok",
    } satisfies ReviewResult;
  },
});

function repoWithCode(): string {
  const repo = mkdtempSync(join(tmpdir(), "rg-content-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), CODE);
  return repo;
}

function orch(repo: string, adapter: ProviderAdapter, diff = DIFF) {
  return new Orchestrator({
    repoRoot: repo,
    config: cfg(),
    adapters: { codex: adapter },
    sandboxMode: "off",
    hostTier: "opus",
    diff,
    reasonOnFailEnabled: true,
  });
}

// One real passing panel run → the ledger the write side would persist.
async function seedLedger(repo: string): Promise<{ ledger: PassLedger; first: IterationResult }> {
  const first = await orch(repo, stub("PASS")).runIteration({ runId: "01HXSEED", iter: 1 });
  expect(first.verdict).toBe("PASS");
  expect(first.passLedgerEligible).toBe(true);
  expect(typeof first.passLedgerEnvHash).toBe("string");
  return {
    first,
    ledger: {
      head_sha: "abc",
      env_hash: first.passLedgerEnvHash as string,
      files: first.reviewedSnapshotFiles as PassLedger["files"],
    },
  };
}

describe("content-identity PASS short-circuit (R3)", () => {
  it("round-trip: byte-identical re-fire → content-cache PASS with NO panel spawned", async () => {
    const repo = repoWithCode();
    const { ledger } = await seedLedger(repo);
    // The second run's adapter would FAIL the review — a PASS proves no panel ran.
    const res = await orch(repo, stub("FAIL")).runIteration({
      runId: "01HXSERVE",
      iter: 1,
      passLedger: ledger,
    });
    expect(res.verdict).toBe("PASS");
    expect(res.summary.source).toBe("content-cache");
    expect(res.costUsd).toBe(0);
  });

  it("one changed byte → full review (no short-circuit)", async () => {
    const repo = repoWithCode();
    const { ledger } = await seedLedger(repo);
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    const res = await orch(repo, stub("PASS")).runIteration({
      runId: "01HXBYTE",
      iter: 1,
      passLedger: ledger,
    });
    expect(res.summary.source).not.toBe("content-cache");
  });

  it("KEYSET equality both directions: a ledger file missing from the current diff blocks the serve (adversarial CRITICAL)", async () => {
    // The passed batch covered {src/a.ts, src/b.ts}; the agent then reverted b.ts
    // to base, shrinking the diff to {src/a.ts}. The subset matches per-file — but
    // the resulting tree combination was never reviewed. Must NOT short-circuit.
    const repo = repoWithCode();
    const { ledger } = await seedLedger(repo);
    const superset: PassLedger = {
      ...ledger,
      files: {
        ...ledger.files,
        "src/b.ts": { status: "present", hash: "hash-of-b-at-pass-time" },
      },
    };
    const res = await orch(repo, stub("PASS")).runIteration({
      runId: "01HXSUBSET",
      iter: 1,
      passLedger: superset,
    });
    expect(res.summary.source).not.toBe("content-cache");
  });

  it("env_hash mismatch (config/version/behavior change) → full review", async () => {
    const repo = repoWithCode();
    const { ledger } = await seedLedger(repo);
    const res = await orch(repo, stub("PASS")).runIteration({
      runId: "01HXENV",
      iter: 1,
      passLedger: { ...ledger, env_hash: "stale-environment-hash" },
    });
    expect(res.summary.source).not.toBe("content-cache");
  });

  it("a diff entry invisible to the manifest (pure rename — zero content lines) blocks the serve", async () => {
    // diff-facts drops zero-added/removed entries, so the manifest misses the
    // rename; the header-count guard must force a full review.
    const repo = repoWithCode();
    const { ledger } = await seedLedger(repo);
    const diffWithRename = `${DIFF}diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts
`;
    const res = await orch(repo, stub("PASS"), diffWithRename).runIteration({
      runId: "01HXRENAME",
      iter: 1,
      passLedger: ledger,
    });
    expect(res.summary.source).not.toBe("content-cache");
  });

  it("an unreadable ledger entry never short-circuits", async () => {
    const repo = repoWithCode();
    const { ledger } = await seedLedger(repo);
    const res = await orch(repo, stub("PASS")).runIteration({
      runId: "01HXUNREAD",
      iter: 1,
      passLedger: {
        ...ledger,
        files: { "src/a.ts": { status: "unreadable", hash: null } },
      },
    });
    expect(res.summary.source).not.toBe("content-cache");
  });

  it("eligibility: a PASS earned under cycle-rejected narrowing may NOT seed the ledger", async () => {
    const repo = repoWithCode();
    const res = await orch(repo, stub("PASS")).runIteration({
      runId: "01HXNARROW",
      iter: 2,
      cycleRejectedSignatures: ["sig-rejected-earlier"],
    });
    expect(res.verdict).toBe("PASS");
    expect(res.passLedgerEligible).toBe(false);
  });
});

describe("S5: ledgerEnvHash compatibility across the cycleRejected/claimedFixed cache-key fold", () => {
  // S5 appends `|cyc:…`/`|cfx:…` segments to the env-hash inputs, but ONLY when the respective
  // suppression set is NON-empty (empty → empty segment). T5's pass_ledger reuse depends on the
  // env_hash staying byte-identical for the suppression-free case, so a ledger written on one
  // suppression-free run is still served on the next.
  //
  // We assert this as a RELATIVE invariant, NOT against a pinned absolute literal. `ledgerEnvHash`
  // deliberately folds in `RG_VERSION` (a reviewgate upgrade must invalidate the ledger), so any
  // absolute golden value is VERSION-COUPLED and breaks on every release version bump — which is
  // exactly what happened (a literal pinned under an earlier alpha failed the release-tag verify).
  // The checks below capture the real contract — empty cyc/cfx contributes nothing; a non-empty
  // set changes the hash — without that release-fragility. `runId` is not an env-hash input, so
  // two runs against the same fixture differ ONLY by the suppression segments.

  // A FRESH repo per run — each is its own cold cache, so every run is a MISS that actually
  // recomputes and RETURNS the env-hash. Reusing one repo would let the 2nd run HIT the 1st's
  // byte cache (identical key ⇒ empty segments add nothing — the very thing we assert), but a
  // cache-served result carries no env-hash, so the field would read `undefined`. Two
  // identical-content fixtures share every env-hash input (config, conventions, topology,
  // version) and differ ONLY by the suppression segments under test.
  it("omitted vs explicit-empty cycleRejected/claimedFixed → identical env_hash (empty adds nothing)", async () => {
    const omitted = await orch(repoWithCode(), stub("PASS")).runIteration({
      runId: "01HXS5A",
      iter: 1,
    });
    const explicitEmpty = await orch(repoWithCode(), stub("PASS")).runIteration({
      runId: "01HXS5B",
      iter: 1,
      cycleRejectedSignatures: [],
      claimedFixedSignatures: {},
    });
    expect(explicitEmpty.passLedgerEnvHash).toBe(omitted.passLedgerEnvHash);
  });

  it("a non-empty claimedFixedSignatures changes env_hash", async () => {
    const empty = await orch(repoWithCode(), stub("PASS")).runIteration({
      runId: "01HXS5A2",
      iter: 1,
    });
    const nonEmpty = await orch(repoWithCode(), stub("PASS")).runIteration({
      runId: "01HXS5C",
      iter: 1,
      claimedFixedSignatures: { "sig-b": 2 },
    });
    expect(nonEmpty.passLedgerEnvHash).not.toBe(empty.passLedgerEnvHash);
  });

  it("a non-empty cycleRejectedSignatures changes env_hash", async () => {
    const empty = await orch(repoWithCode(), stub("PASS")).runIteration({
      runId: "01HXS5A3",
      iter: 1,
    });
    const nonEmpty = await orch(repoWithCode(), stub("PASS")).runIteration({
      runId: "01HXS5D",
      iter: 1,
      cycleRejectedSignatures: ["sig-x"],
    });
    expect(nonEmpty.passLedgerEnvHash).not.toBe(empty.passLedgerEnvHash);
  });
});

describe("pass_ledger persistence (loop-driver)", () => {
  function summaryFor(verdict: string, source = "panel", providers: unknown[] = []): RunSummary {
    return {
      verdict,
      source,
      counts: { critical: 0, warn: 0, info: 0 },
      cost_usd: 0,
      duration_ms: 1,
      demoted: 0,
      from_critical_demoted: 0,
      signatures: [],
      providers,
    } as unknown as RunSummary;
  }

  const OK_PROVIDER = {
    provider: "codex",
    personas: ["security"],
    runs: 1,
    errors: 0,
    findings: 0,
    demoted: 0,
    cost_usd: 0,
    duration_ms: 5,
  };

  async function runDriver(repo: string, state: StateStore, result: IterationResult) {
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    return await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: { runIteration: async () => result },
      stopHookActive: false,
      freshHeadSha: async () => null, // S3b: unused stub for pre-existing fixtures
      headSha: "headsha1",
    }).run();
  }

  function fakeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "rg-ledger-"));
    writeFileSync(join(dir, "src-a.ts"), "x");
    return dir;
  }

  it("a clean full-coverage panel PASS writes the ledger with the orchestrator's env hash", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXLEDGER1");
    const files = snapshotReviewedFiles(repo, ["src-a.ts"]);
    await runDriver(repo, state, {
      verdict: "PASS",
      costUsd: 0,
      durationMs: 1,
      signaturesThisIter: [],
      locationsThisIter: [],
      reviewedSnapshotFiles: files,
      passLedgerEligible: true,
      passLedgerEnvHash: "env-hash-from-orchestrator",
      summary: summaryFor("PASS", "panel", [OK_PROVIDER]),
    });
    const st = await state.load();
    expect(st.pass_ledger?.head_sha).toBe("headsha1");
    expect(st.pass_ledger?.env_hash).toBe("env-hash-from-orchestrator");
    expect(st.pass_ledger?.files).toEqual(files);
  });

  it("a PASS without an env hash writes NO ledger (fail-safe)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXLEDGER1B");
    await runDriver(repo, state, {
      verdict: "PASS",
      costUsd: 0,
      durationMs: 1,
      signaturesThisIter: [],
      locationsThisIter: [],
      reviewedSnapshotFiles: snapshotReviewedFiles(repo, ["src-a.ts"]),
      passLedgerEligible: true,
      summary: summaryFor("PASS", "panel", [OK_PROVIDER]),
    });
    expect((await state.load()).pass_ledger).toBeNull();
  });

  it("a preliminary PASS (reduced coverage) writes NO ledger", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXLEDGER2");
    await runDriver(repo, state, {
      verdict: "PASS",
      costUsd: 0,
      durationMs: 1,
      signaturesThisIter: [],
      locationsThisIter: [],
      reviewedSnapshotFiles: snapshotReviewedFiles(repo, ["src-a.ts"]),
      passLedgerEligible: true,
      passLedgerEnvHash: "env",
      // 0 ok providers vs 1 configured reviewer → preliminaryReason != null
      summary: summaryFor("PASS", "panel", []),
    });
    expect((await state.load()).pass_ledger).toBeNull();
  });

  it("a content-cache PASS leaves the existing ledger untouched", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXLEDGER3");
    const existing = {
      head_sha: "old",
      env_hash: "env",
      files: { "src-a.ts": { status: "present" as const, hash: "h" } },
    };
    await state.update((cur) => ({ ...cur, pass_ledger: existing }));
    await runDriver(repo, state, {
      verdict: "PASS",
      costUsd: 0,
      durationMs: 1,
      signaturesThisIter: [],
      locationsThisIter: [],
      summary: summaryFor("PASS", "content-cache"),
    });
    expect((await state.load()).pass_ledger).toEqual(existing);
  });

  it("a FAIL leaves the existing ledger untouched", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXLEDGER4");
    const existing = {
      head_sha: "old",
      env_hash: "env",
      files: { "src-a.ts": { status: "present" as const, hash: "h" } },
    };
    await state.update((cur) => ({ ...cur, pass_ledger: existing }));
    await runDriver(repo, state, {
      verdict: "FAIL",
      costUsd: 0,
      durationMs: 1,
      signaturesThisIter: ["sig-1"],
      locationsThisIter: [],
      summary: {
        ...summaryFor("FAIL", "panel", [OK_PROVIDER]),
        counts: { critical: 1, warn: 0, info: 0 },
      } as RunSummary,
    });
    expect((await state.load()).pass_ledger).toEqual(existing);
  });
});
