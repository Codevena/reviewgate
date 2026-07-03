// tests/unit/gate-stop-diff-always-flagged.test.ts
//
// S1-C1 (codex CRITICAL, reviewed 2026-07-03): Task 3 (ced0e54) rewrote the Stop
// probe so an uncommitted Bash-tool edit reaches `gatherReviewContext`, and that
// function DOES compute a correctly populated `ctx.diff` on the null-`last`
// fallthrough (see the "round-13 C1" pin in stop-fast-exit-tree-probe.test.ts).
// But `ctx.diff` living in memory is NOT the same as a review actually happening:
// `LoopDriver.run()` independently re-reads `.reviewgate/dirty.flag` FROM DISK, and
// when `last_reviewed_head_sha` is null the null-last branch never persists a flag
// (its `sinceLast` computation short-circuits to "" before the write is reached) —
// so the driver finds no flag and green-allows ("No code changes since last
// review") WITHOUT ever running the panel, even though the Orchestrator it just
// skipped was built with the real diff. Same failure mode if the pre-existing
// synthesis write (the non-null-`last` branch) throws (ENOSPC/EACCES) — that
// try/catch swallows the error and leaves no flag either.
//
// These tests drive the FULL `runGate({hook:"stop"})` pipeline (not just
// `gatherReviewContext`, which is exactly the layer the bug hid behind) with a
// stub reviewer that always reports a CRITICAL finding, so "was this actually
// reviewed" is observable as "did the turn BLOCK".
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/cli/commands/gate.ts";
import { StateStore } from "../../src/core/state-store.ts";
import { BASE_TS_NO_SCOPING_SENTINEL } from "../../src/hooks/handlers.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import { collectDiff, gitHeadSha, workingTreeStateHash } from "../../src/utils/git.ts";
import { dirtyFlagPath, reviewgateDir } from "../../src/utils/paths.ts";

function gitRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const run = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  run("init", "-q");
  run("config", "user.email", "t@t.t");
  run("config", "user.name", "t");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  run("add", "a.ts");
  run("commit", "-qm", "init");
  mkdirSync(reviewgateDir(repo), { recursive: true });
  return repo;
}

// In-process reviewer stub returning a single CRITICAL finding — mirrors the
// pattern in tests/unit/gate-synthesized-flag-base-ts.test.ts. Deterministic and
// subprocess-free (no fake-codex.sh spawn), so "the panel actually ran" is
// provable purely from the decision, without flaking on process I/O timing.
// `file` MUST be a path actually present in the reviewed diff — a finding on an
// out-of-diff file is scope-demoted to INFO (non-blocking) by the aggregator,
// which would silently defeat these tests' "did it block" signal.
function stubReviewer(file: string): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "stub", authMode: "oauth", error: null };
    },
    async review(input): Promise<ReviewResult> {
      const finding: Finding = {
        id: "F-001",
        signature: "fake-sig",
        severity: "CRITICAL",
        category: "security",
        rule_id: "fake-rule",
        file,
        line_start: 1,
        line_end: 1,
        message: "fake finding",
        details: "fake details",
        reviewer: { provider: "codex", model: "stub", persona: "security" },
        confidence: 0.9,
        consensus: "singleton",
      };
      return {
        reviewerId: input.reviewerId,
        verdict: "FAIL",
        findings: [finding],
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      };
    },
  };
}

describe("a non-empty Stop diff always persists a dirty flag or fail-closes (S1-C1)", () => {
  it("(a) last=null + no flag + uncommitted Bash edit + a CRITICAL finding → BLOCK, never the green message", async () => {
    const repo = gitRepo("rg-stopc1-nulllast-");
    await new StateStore(repo).initialise("01STOPC1NULLLAST"); // last_reviewed_head_sha = null (fresh)
    // Simulated Bash-tool edit: no Edit/Write tool ran, so no PostToolUse fired —
    // there is genuinely no dirty.flag on disk, exactly the S1 scenario.
    writeFileSync(join(repo, "sneaky.ts"), "export const evil = 1;\n");
    expect(existsSync(dirtyFlagPath(repo))).toBe(false);

    const out = await runGate({
      repoRoot: repo,
      hook: "stop",
      hookStdinRaw: "{}",
      providerOverrides: { codex: stubReviewer("sneaky.ts") },
      sandboxModeOverride: "off",
    });

    expect(out.exitCode).toBe(0);
    const decision = JSON.parse(out.stdout || "{}") as { decision?: string; reason?: string };
    // Pre-fix (ced0e54): the null-last branch never persists a dirty.flag despite
    // ctx.diff being correctly populated; LoopDriver re-reads the flag from disk,
    // finds none, and returns allow_stop ("No code changes since last review") with
    // EMPTY stdout — the stub reviewer's CRITICAL finding is never even fetched.
    // Post-fix: the belt persists a flag (or fails closed), so the panel runs and
    // the CRITICAL finding actually blocks the turn.
    expect(decision.decision).toBe("block");
    expect(out.stderr.toLowerCase()).not.toContain("no code changes");
    // Belt-flag shape on the null-`last` path: no base to preserve → base_sha is
    // OMITTED (working-tree review), with the no-scoping base_ts sentinel.
    const flag = JSON.parse(readFileSync(dirtyFlagPath(repo), "utf8")) as {
      base_sha?: string;
      base_ts?: string;
    };
    expect(flag.base_sha).toBeUndefined();
    expect(flag.base_ts).toBe(BASE_TS_NO_SCOPING_SENTINEL);
  }, 30_000);

  it("(b) last≠null + HEAD unchanged + tree DIFFERS (uncommitted Bash edit) stays reviewed end-to-end through runGate", async () => {
    const repo = gitRepo("rg-stopc1-treediffers-");
    const sha = await gitHeadSha(repo);
    const tree = await workingTreeStateHash(repo);
    const state = new StateStore(repo);
    await state.initialise("01STOPC1TREEDIFF");
    await state.update((cur) => ({
      ...cur,
      last_reviewed_head_sha: sha,
      last_reviewed_tree_hash: tree,
    }));
    writeFileSync(join(repo, "sneaky2.ts"), "export const y = 2;\n");
    expect(existsSync(dirtyFlagPath(repo))).toBe(false);

    const out = await runGate({
      repoRoot: repo,
      hook: "stop",
      hookStdinRaw: "{}",
      providerOverrides: { codex: stubReviewer("sneaky2.ts") },
      sandboxModeOverride: "off",
    });

    expect(out.exitCode).toBe(0);
    const decision = JSON.parse(out.stdout || "{}") as { decision?: string };
    expect(decision.decision).toBe("block");
  }, 30_000);

  it("(c) dirty.flag persistence failure fails CLOSED — never lets LoopDriver's disk re-read green-allow", async () => {
    // chmod-based EACCES injection requires a non-root process (root bypasses
    // Unix permission bits, so the forced write failure wouldn't materialize).
    if (typeof process.getuid === "function" && process.getuid() === 0) return;

    const repo = gitRepo("rg-stopc1-writefail-");
    await new StateStore(repo).initialise("01STOPC1WRITEFAIL"); // last=null
    writeFileSync(join(repo, "sneaky3.ts"), "export const z = 3;\n");

    // Everything BEFORE the diff is computed (gate-lock acquire, state load) must
    // still succeed, so we can't chmod .reviewgate up front — flock() would fail
    // first with a DIFFERENT (pre-existing) "could not acquire the gate lock"
    // block, not the belt's dirty-flag-specific one. Instead we flip the directory
    // read-only as a side effect of the injected collectDiffFn, which fires from
    // inside gatherReviewContext AFTER the lock/state are already held — so ONLY
    // the belt's writeFileAtomic(dirty.flag) is denied.
    let chmodApplied = false;
    let out: Awaited<ReturnType<typeof runGate>>;
    try {
      out = await runGate({
        repoRoot: repo,
        hook: "stop",
        hookStdinRaw: "{}",
        providerOverrides: { codex: stubReviewer("sneaky3.ts") },
        sandboxModeOverride: "off",
        collectDiffFn: async (...args: Parameters<typeof collectDiff>) => {
          const result = await collectDiff(...args);
          if (!chmodApplied) {
            chmodSync(reviewgateDir(repo), 0o555); // r-x: existsSync still works, writes don't
            chmodApplied = true;
          }
          return result;
        },
      });
    } finally {
      if (chmodApplied) chmodSync(reviewgateDir(repo), 0o755); // restore for tmpdir cleanup
    }

    expect(out.exitCode).toBe(0);
    const decision = JSON.parse(out.stdout || "{}") as { decision?: string; reason?: string };
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("GATE CLOSED");
    expect(decision.reason?.toLowerCase()).toContain("dirty.flag");
    // The write genuinely failed — nothing was silently left half-persisted.
    expect(existsSync(dirtyFlagPath(repo))).toBe(false);
  }, 30_000);

  it("(d) the belt flag preserves base_sha = last_reviewed_head_sha when known (no under-review window next cycle)", async () => {
    // A base-LESS belt flag is only safe when there IS no known base: if `last`
    // is non-null and the belt fires (the pre-existing synthesis never persisted a
    // flag), a base-less flag makes the NEXT cycle diff working-tree-only —
    // silently dropping committed last..HEAD work from scope if THIS turn's
    // review FAILs (fail-open on the follow-up cycle). The belt must carry
    // base_sha = last whenever the state knows it; only the null-`last` case
    // (test a) legitimately omits it.
    //
    // Belt-firing scenario with a non-null `last`, no fs-failure injection needed:
    // HEAD advanced past `last` (probe → review), but the working tree was
    // reverted to the exact last-reviewed content — so `sinceLast` (diff vs
    // `last`) is EMPTY and the synthesis block never runs (no flag persisted),
    // while the fallback HEAD-relative diff is non-empty (the uncommitted revert)
    // → the belt is the only thing that writes the flag.
    const repo = gitRepo("rg-stopc1-beltbase-");
    const run = (...a: string[]) => execFileSync("git", a, { cwd: repo });
    const lastSha = await gitHeadSha(repo); // "last reviewed" = the v1 commit
    if (lastSha === null) throw new Error("test setup: HEAD sha unavailable");
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    run("add", "a.ts");
    run("commit", "-qm", "v2"); // HEAD moves past lastSha (e.g. committed via Bash)
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n"); // Bash-revert to v1 content
    const state = new StateStore(repo);
    await state.initialise("01STOPC1BELTBASE");
    await state.update((cur) => ({ ...cur, last_reviewed_head_sha: lastSha }));
    expect(existsSync(dirtyFlagPath(repo))).toBe(false);

    const out = await runGate({
      repoRoot: repo,
      hook: "stop",
      hookStdinRaw: "{}",
      providerOverrides: { codex: stubReviewer("a.ts") },
      sandboxModeOverride: "off",
    });

    expect(out.exitCode).toBe(0);
    const decision = JSON.parse(out.stdout || "{}") as { decision?: string };
    expect(decision.decision).toBe("block"); // CRITICAL on the reverted file → the flag survives
    const flag = JSON.parse(readFileSync(dirtyFlagPath(repo), "utf8")) as {
      base_sha?: string;
      base_ts?: string;
    };
    expect(flag.base_sha).toBe(lastSha); // the known base is preserved, not dropped
    expect(flag.base_ts).toBe(BASE_TS_NO_SCOPING_SENTINEL);
  }, 30_000);
});
