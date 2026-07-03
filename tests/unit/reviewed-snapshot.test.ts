// tests/unit/reviewed-snapshot.test.ts
//
// T1 (field report 2026-07-03): reviewed-snapshot substrate — per-file content
// hashes of the reviewed diff persisted each completed PANEL iteration, plus the
// coordinated cycle-region fields (populated by the region-suppression slice) and
// the pass_ledger schema (written by the content-identity slice). Pure substrate:
// this slice changes no verdict/gating behavior on its own.
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import type { IterationResult } from "../../src/core/orchestrator.ts";
import { snapshotReviewedFiles } from "../../src/core/reviewed-snapshot.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";
import { ReviewgateStateSchema, initialState } from "../../src/schemas/state.ts";
import { auditDir, dirtyFlagPath } from "../../src/utils/paths.ts";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-snap-"));
  writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
  writeFileSync(join(dir, "b.ts"), "const b = 2;\n");
  return dir;
}

function summaryFor(verdict: string): RunSummary {
  return {
    verdict,
    source: "panel",
    counts: { critical: verdict === "FAIL" ? 1 : 0, warn: 0, info: 0 },
    cost_usd: 0,
    duration_ms: 1,
    demoted: 0,
    from_critical_demoted: 0,
    signatures: [],
    providers: [],
  } as unknown as RunSummary;
}

function resultFor(
  verdict: "PASS" | "FAIL" | "ERROR",
  reviewedSnapshotFiles?: IterationResult["reviewedSnapshotFiles"],
): IterationResult {
  return {
    verdict,
    costUsd: 0,
    durationMs: 1,
    signaturesThisIter: verdict === "FAIL" ? ["sig-1"] : [],
    locationsThisIter: [],
    summary: summaryFor(verdict),
    ...(reviewedSnapshotFiles !== undefined ? { reviewedSnapshotFiles } : {}),
  };
}

function writeDirty(repo: string, baseSha?: string): void {
  writeFileSync(
    dirtyFlagPath(repo),
    JSON.stringify({
      diff_hash: "h",
      ts: new Date().toISOString(),
      ...(baseSha ? { base_sha: baseSha } : {}),
    }),
  );
}

function driverFor(repo: string, state: StateStore, result: IterationResult, headSha?: string) {
  return new LoopDriver({
    repoRoot: repo,
    config: defaultConfig,
    state,
    audit: new AuditLogger(auditDir(repo)),
    orchestrator: { runIteration: async () => result },
    stopHookActive: false,
    ...(headSha ? { headSha } : {}),
  });
}

describe("snapshotReviewedFiles", () => {
  it("hashes present files, tombstones deleted ones, marks symlinks unreadable — every path gets an entry", () => {
    const repo = fakeRepo();
    symlinkSync("/etc/hosts", join(repo, "evil.ts"));
    const snap = snapshotReviewedFiles(repo, ["a.ts", "b.ts", "gone.ts", "evil.ts"]);
    expect(Object.keys(snap).sort()).toEqual(["a.ts", "b.ts", "evil.ts", "gone.ts"]);
    expect(snap["a.ts"]).toEqual({ status: "present", hash: sha256("const a = 1;\n") });
    expect(snap["b.ts"]).toEqual({ status: "present", hash: sha256("const b = 2;\n") });
    expect(snap["gone.ts"]).toEqual({ status: "deleted", hash: null });
    // Symlink (would escape the repo) → unreadable, never followed/hashed.
    expect(snap["evil.ts"]).toEqual({ status: "unreadable", hash: null });
  });

  it("hashes a binary (NUL-containing) file over its RAW bytes (participates like any file)", () => {
    const repo = fakeRepo();
    writeFileSync(join(repo, "bin.ts"), "a\0b");
    expect(snapshotReviewedFiles(repo, ["bin.ts"])["bin.ts"]).toEqual({
      status: "present",
      hash: createHash("sha256").update(Buffer.from("a\0b")).digest("hex"),
    });
  });

  it("two contents differing only in invalid-UTF-8 bytes hash DIFFERENTLY (raw bytes, not the decode)", () => {
    const repo = fakeRepo();
    writeFileSync(join(repo, "x1.ts"), Buffer.from([0x61, 0xc3, 0x28, 0x62])); // a <invalid> b
    writeFileSync(join(repo, "x2.ts"), Buffer.from([0x61, 0xc3, 0x29, 0x62])); // differs inside the invalid seq
    const snap = snapshotReviewedFiles(repo, ["x1.ts", "x2.ts"]);
    expect(snap["x1.ts"]?.hash).not.toBe(snap["x2.ts"]?.hash);
  });
});

describe("state schema back-compat", () => {
  it("initialState carries the new substrate fields", () => {
    const s = initialState("01HXSNAP");
    expect(s.reviewed_snapshot).toBeNull();
    expect(s.cycle_rejected_dispositions).toEqual([]);
    expect(s.cycle_addressed_dispositions).toEqual([]);
    expect(s.region_suppressed_hits).toBe(0);
    expect(s.pass_ledger).toBeNull();
  });

  it("a state.json written before these fields still parses (defaults applied)", () => {
    const {
      reviewed_snapshot: _s,
      cycle_rejected_dispositions: _r,
      cycle_addressed_dispositions: _a,
      region_suppressed_hits: _h,
      pass_ledger: _l,
      ...legacy
    } = initialState("01HXLEGACY");
    const parsed = ReviewgateStateSchema.parse(legacy);
    expect(parsed.reviewed_snapshot).toBeNull();
    expect(parsed.cycle_rejected_dispositions).toEqual([]);
    expect(parsed.pass_ledger).toBeNull();
  });
});

describe("LoopDriver snapshot persistence", () => {
  it("a FAIL iteration persists the manifest with iter/verdict/base_sha", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSNAP1");
    writeDirty(repo, "basesha123");
    const files = snapshotReviewedFiles(repo, ["a.ts"]);
    await driverFor(repo, state, resultFor("FAIL", files)).run();
    const st = await state.load();
    expect(st.reviewed_snapshot).toEqual({
      iter: 1,
      verdict: "FAIL",
      base_sha: "basesha123",
      files: { "a.ts": { status: "present", hash: sha256("const a = 1;\n") } },
      blocking_files: [],
    });
  });

  it("a FAIL result WITHOUT a manifest leaves no snapshot (fail-safe: delta-scope stays inert)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSNAP2");
    writeDirty(repo);
    await driverFor(repo, state, resultFor("FAIL")).run();
    expect((await state.load()).reviewed_snapshot).toBeNull();
  });

  it("a PASS clears the snapshot and cycle regions (re-arm)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSNAP3");
    await state.update((cur) => ({
      ...cur,
      reviewed_snapshot: {
        iter: 1,
        verdict: "FAIL",
        base_sha: null,
        files: { "a.ts": { status: "present" as const, hash: "x" } },
        blocking_files: [],
      },
      region_suppressed_hits: 2,
    }));
    writeDirty(repo);
    await driverFor(repo, state, resultFor("PASS")).run();
    const st = await state.load();
    expect(st.reviewed_snapshot).toBeNull();
    expect(st.cycle_rejected_dispositions).toEqual([]);
    expect(st.cycle_addressed_dispositions).toEqual([]);
    expect(st.region_suppressed_hits).toBe(0);
  });

  it("a misconfig ERROR preserves the previous snapshot (no real review happened)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSNAP4");
    const prior = {
      iter: 1,
      verdict: "FAIL",
      base_sha: null,
      files: { "a.ts": { status: "present" as const, hash: "priorhash" } },
      blocking_files: ["a.ts"],
    };
    await state.update((cur) => ({ ...cur, iteration: 1, reviewed_snapshot: prior }));
    writeDirty(repo);
    await driverFor(repo, state, resultFor("ERROR")).run();
    expect((await state.load()).reviewed_snapshot).toEqual(prior);
  });

  it("commit re-arm of an escalated gate clears snapshot/regions/hits but LEAVES pass_ledger", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSNAP5");
    const ledger = {
      head_sha: "aaa",
      env_hash: "env",
      files: { "a.ts": { status: "present" as const, hash: "h1" } },
    };
    await state.update((cur) => ({
      ...cur,
      iteration: 2,
      escalated: true,
      last_reviewed_head_sha: "aaa",
      reviewed_snapshot: {
        iter: 2,
        verdict: "FAIL",
        base_sha: null,
        files: { "a.ts": { status: "present" as const, hash: "h2" } },
        blocking_files: [],
      },
      cycle_rejected_dispositions: [
        {
          key: "1:F-001",
          file: "a.ts",
          start_line: 1,
          end_line: 5,
          severity: "WARN" as const,
          categories: ["quality" as const],
          reason: "rejected because the reviewer misread the guard",
        },
      ],
      region_suppressed_hits: 3,
      pass_ledger: ledger,
    }));
    writeDirty(repo);
    // HEAD moved while escalated → commit re-arm resets the cycle. The stub then
    // FAILs without a manifest, so reviewed_snapshot ends null (not re-populated).
    await driverFor(repo, state, resultFor("FAIL"), "bbb").run();
    const st = await state.load();
    expect(st.reviewed_snapshot).toBeNull();
    expect(st.cycle_rejected_dispositions).toEqual([]);
    expect(st.cycle_addressed_dispositions).toEqual([]);
    expect(st.region_suppressed_hits).toBe(0);
    expect(st.pass_ledger).toEqual(ledger); // survives the re-arm
  });

  it("post-escalation-edit re-arm clears snapshot/regions/hits but LEAVES pass_ledger", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSNAP6");
    const ledger = {
      head_sha: "aaa",
      env_hash: "env",
      files: { "a.ts": { status: "present" as const, hash: "h1" } },
    };
    await state.update((cur) => ({
      ...cur,
      iteration: 2,
      escalated: true,
      escalation_announced: true,
      reviewed_snapshot: {
        iter: 2,
        verdict: "FAIL",
        base_sha: null,
        files: { "a.ts": { status: "present" as const, hash: "h2" } },
        blocking_files: [],
      },
      region_suppressed_hits: 1,
      pass_ledger: ledger,
    }));
    writeDirty(repo);
    await driverFor(repo, state, resultFor("FAIL")).run();
    const st = await state.load();
    // Fresh cycle after the re-arm; stub FAIL had no manifest → snapshot null.
    expect(st.reviewed_snapshot).toBeNull();
    expect(st.region_suppressed_hits).toBe(0);
    expect(st.pass_ledger).toEqual(ledger);
  });
});
