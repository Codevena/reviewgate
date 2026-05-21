// tests/unit/loop-driver.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import { StateStore } from "../../src/core/state-store.ts";
import { CodexAdapter } from "../../src/providers/codex.ts";
import { auditDir, decisionsPath, dirtyFlagPath, pendingJsonPath } from "../../src/utils/paths.ts";

// A documentation-only diff: triage skips the panel → PASS without a reviewer.
const DOC_DIFF =
  "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n";

function writeDirty(repo: string): void {
  writeFileSync(
    dirtyFlagPath(repo),
    JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
  );
}

const FAKE_CODEX = join(process.cwd(), "tests/fixtures/fake-codex.sh");

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-loop-"));
  writeFileSync(join(dir, "foo.ts"), "x");
  return dir;
}

describe("LoopDriver", () => {
  it("returns allow_stop on PASS after one iteration", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQTEST"); // creates .reviewgate/ first
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: "",
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    expect(["allow_stop", "block"]).toContain(decision.kind);
  });

  it("with stop_hook_active=true and no dirty flag, allows stop (nothing to review)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQTEST2");
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: "",
        reasonOnFailEnabled: true,
      }),
      stopHookActive: true,
    });
    const decision = await driver.run();
    expect(decision.kind).toBe("allow_stop");
    expect(decision.reason).toContain("No code changes");
  });

  it("re-reviews in-chain (stop_hook_active=true) once prior decisions are addressed", async () => {
    // The agent fixed the iteration-1 finding and wrote decisions/1.jsonl during
    // a hook-forced continuation. The gate must NOT short-circuit on
    // stop_hook_active — it must run iteration 2 and verify the fix.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQCHAIN");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writeFileSync(pendingJsonPath(repo), JSON.stringify({ findings: [{ id: "F-001" }] }));
    const dpath = decisionsPath(repo, 1);
    mkdirSync(dirname(dpath), { recursive: true });
    writeFileSync(
      dpath,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "fixed" })}\n`,
    );
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: DOC_DIFF,
        reasonOnFailEnabled: true,
      }),
      stopHookActive: true,
    });
    const decision = await driver.run();
    expect(decision.kind).toBe("allow_stop");
    expect(decision.reason).toContain("iteration 2");
  });

  it("escalates (bounded) when a forced continuation leaves findings unaddressed", async () => {
    // stop_hook_active=true + prior findings + NO decisions written. Blocking
    // again would loop forever (decisions-gate never advances the iter counter),
    // so the gate escalates to the human and allows the stop.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQNODEC");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writeFileSync(pendingJsonPath(repo), JSON.stringify({ findings: [{ id: "F-001" }] }));
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: DOC_DIFF,
        reasonOnFailEnabled: true,
      }),
      stopHookActive: true,
    });
    const decision = await driver.run();
    expect(decision.kind).toBe("block");
    expect(decision.reason).toMatch(/ESCALATED/);
    expect(existsSync(join(repo, ".reviewgate", "ESCALATION.md"))).toBe(true);
  });

  it("treats a malformed/incomplete decision as unaddressed (fail-closed)", async () => {
    // A decision line that is valid JSON but not a valid DecisionEntry (no
    // verdict/action) must NOT satisfy the gate — otherwise an agent could
    // bypass it by writing {finding_id} stubs.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQMALF");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writeFileSync(pendingJsonPath(repo), JSON.stringify({ findings: [{ id: "F-001" }] }));
    const dpath = decisionsPath(repo, 1);
    mkdirSync(dirname(dpath), { recursive: true });
    writeFileSync(
      dpath,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001" })}\n`,
    );
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: DOC_DIFF,
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    expect(decision.kind).toBe("block");
    expect(decision.reason).toContain("not yet addressed");
  });

  it("still blocks (not escalate) for unaddressed findings on a user-initiated stop", async () => {
    // stop_hook_active=false means a fresh user turn: ask the agent to address
    // findings (block), don't escalate yet.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQBLOCK");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writeFileSync(pendingJsonPath(repo), JSON.stringify({ findings: [{ id: "F-001" }] }));
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: DOC_DIFF,
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    expect(decision.kind).toBe("block");
    expect(decision.reason).toContain("not yet addressed");
  });

  it("acknowledgePass=true blocks ONCE on a passing verdict so the agent is told", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQACK");
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    const audit = new AuditLogger(auditDir(repo));
    const config = { ...defaultConfig, loop: { ...defaultConfig.loop, acknowledgePass: true } };
    const driver = new LoopDriver({
      repoRoot: repo,
      config,
      state,
      audit,
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        // Doc-only diff → triage skips the panel → PASS without calling a reviewer.
        diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n",
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    expect(decision.kind).toBe("block");
    expect(decision.reason).toContain("PASS");
    expect(decision.reason).toContain("No action needed");
  });

  it("acknowledgePass=false (default) allows stop silently on a passing verdict", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQACK2");
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n",
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    expect(decision.kind).toBe("allow_stop");
  });

  it("escalates after maxIterations FAIL streak", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQTEST3");
    // Pre-populate state as if we've already failed 3 times.
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [["sig1"], ["sig1"], ["sig1"]],
    }));
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: "",
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    // First escalation BLOCKS once so the agent is told the gate gave up.
    const first = await driver.run();
    expect(first.kind).toBe("block");
    expect(first.reason).toMatch(/ESCALATED/);
    expect(existsSync(join(repo, ".reviewgate", "ESCALATION.md"))).toBe(true);

    // It is bounded: the dirty flag was consumed, so the re-stop allows.
    const second = await driver.run();
    expect(second.kind).toBe("allow_stop");
  });

  it("the escalation report includes the last iteration's findings + severity counts from pending.json", async () => {
    // Bug: ESCALATION.md's "Final findings" section was always empty (topFindings
    // hardcoded []) and the per-iteration CRIT/WARN columns always 0. Populate them
    // from the last iteration's pending.json so the report is useful standalone.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQESCREP");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [["s1"], ["s1"], ["s1"]],
    }));
    writeDirty(repo);
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-002",
            signature: "s1",
            severity: "CRITICAL",
            category: "quality",
            rule_id: "magic-number",
            file: "src/lib/quiz-mode.ts",
            line_start: 248,
            line_end: 248,
            message: "Hardcoded magic number 7200000",
            details: "use a named constant",
            reviewer: { provider: "codex", model: "gpt-5.4", persona: "security" },
            confidence: 0.97,
            consensus: "unanimous",
            confirmed_by: ["codex", "gemini"],
          },
        ],
        counts: { critical: 1, warn: 0, info: 0 },
      }),
    );
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: "",
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    expect(decision.reason).toMatch(/ESCALATED/);
    const md = readFileSync(join(repo, ".reviewgate", "ESCALATION.md"), "utf8");
    expect(md).toContain("Hardcoded magic number 7200000"); // findings populated
    expect(md).toContain("magic-number");
    expect(md).toContain("| 3    | FAIL    | 1    |"); // last iter CRIT = 1, not 0
  });

  it("PASS re-arms the budget (iteration resets to 0) so the next batch is reviewed", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQREARM");
    await state.update((cur) => ({ ...cur, iteration: 2 }));
    writeDirty(repo);
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: DOC_DIFF,
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    expect(decision.kind).toBe("allow_stop");
    const after = await state.load();
    expect(after.iteration).toBe(0);
    expect(after.escalated).toBe(false);
    expect(after.signature_history).toEqual([]);
  });

  it("a commit (HEAD change) re-arms an escalated gate instead of escalating again", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQCOMMIT");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      escalated: true,
      escalation_reason: "max-iterations",
      escalation_announced: true,
      last_reviewed_head_sha: "0000000aaaaaaa",
    }));
    writeDirty(repo);
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      headSha: "1111111bbbbbbb", // HEAD moved → a commit landed
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: DOC_DIFF,
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    // Re-armed → ran a fresh iteration 1 (PASS) instead of re-escalating.
    expect(decision.kind).toBe("allow_stop");
    expect(decision.reason).toContain("iteration 1");
    const after = await state.load();
    expect(after.escalated).toBe(false);
  });

  it("records the HEAD baseline on first sight (null) so a later commit re-arms an upgraded session", async () => {
    // Simulates a state.json written before last_reviewed_head_sha existed: it
    // defaults to null. An already-escalated session must still re-arm once the
    // user commits — but only AFTER a baseline has been recorded.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQUPGRADE");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      escalated: true,
      escalation_reason: "max-iterations",
      escalation_announced: false,
      last_reviewed_head_sha: null,
    }));
    writeDirty(repo);
    const audit = new AuditLogger(auditDir(repo));
    const mk = (headSha: string) =>
      new LoopDriver({
        repoRoot: repo,
        config: defaultConfig,
        state,
        audit,
        headSha,
        orchestrator: new Orchestrator({
          repoRoot: repo,
          config: defaultConfig,
          adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
          sandboxMode: "off",
          hostTier: "opus",
          diff: DOC_DIFF,
          reasonOnFailEnabled: true,
        }),
        stopHookActive: false,
      });

    // First stop: null baseline → record sha, still escalates (was escalated).
    const first = await mk("aaaaaaa").run();
    expect(first.kind).toBe("block");
    expect(first.reason).toMatch(/ESCALATED/);
    expect((await state.load()).last_reviewed_head_sha).toBe("aaaaaaa");

    // User commits → HEAD moves → next stop re-arms and reviews.
    writeDirty(repo);
    const second = await mk("bbbbbbb").run();
    expect(second.kind).toBe("allow_stop");
    expect(second.reason).toContain("iteration 1");
    expect((await state.load()).escalated).toBe(false);
  });

  it("a PASS re-arm clears prior-cycle decisions so a stale decision can't satisfy the next cycle", async () => {
    // Bug: decisions/<iter>.jsonl files are NOT cleared on a PASS re-arm. Because
    // the iteration counter resets to 0 and climbs again, the next cycle reuses
    // the same filenames — and allDecisionsAddressed() matches by finding_id only.
    // A stale "F-001 accepted/fixed" line from the prior cycle would then satisfy
    // the next cycle's F-001 gate without the agent addressing it. Re-arm must
    // wipe the decisions directory, exactly as the SessionStart reset does.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQSTALEDEC");
    await state.update((cur) => ({ ...cur, iteration: 2 }));
    const stale = decisionsPath(repo, 1);
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(
      stale,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "fixed" })}\n`,
    );
    writeDirty(repo);
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: DOC_DIFF, // doc-only → triage skip → PASS → re-arm
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    expect(decision.kind).toBe("allow_stop");
    expect((await state.load()).iteration).toBe(0); // re-armed
    expect(existsSync(stale)).toBe(false); // stale decision wiped
  });

  it("a commit recovering an escalated gate also clears prior-cycle decisions", async () => {
    // The other re-arm path: HEAD moved while ESCALATED → the human took over and
    // committed → budget resets to 0. That closes the cycle too, so stale
    // decisions must be wiped here as well, for the same reason as the PASS re-arm.
    // Uses a CODE diff so the post-recovery iteration FAILs (panel runs) — that
    // isolates the recovery-path clear from the PASS-branch clear.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQSTALEESC");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      escalated: true,
      escalation_reason: "max-iterations",
      escalation_announced: true,
      last_reviewed_head_sha: "0000000aaaaaaa",
    }));
    const stale = decisionsPath(repo, 1);
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(
      stale,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "fixed" })}\n`,
    );
    writeDirty(repo);
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      headSha: "1111111bbbbbbb", // HEAD moved → a commit landed
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        // Code diff → triage runs the panel → fake codex returns FAIL, so the
        // PASS-branch clear does NOT run; only the recovery-path clear can wipe.
        diff: "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-x\n+y\n",
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    expect(decision.kind).toBe("block"); // fresh iteration 1 FAILed
    expect((await state.load()).escalated).toBe(false); // re-armed on the commit
    expect(existsSync(stale)).toBe(false); // stale decision wiped at recovery
  });

  it("a commit while mid-FAIL (not escalated) does NOT re-arm or bypass the decisions gate", async () => {
    // Security: an agent must not be able to land unaddressed findings by
    // committing them. A HEAD move while NOT escalated must keep the budget and
    // still demand decisions for the prior iteration's findings.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQNOBYPASS");
    await state.update((cur) => ({
      ...cur,
      iteration: 1,
      escalated: false,
      last_reviewed_head_sha: "0000000aaaaaaa",
    }));
    writeDirty(repo);
    writeFileSync(pendingJsonPath(repo), JSON.stringify({ findings: [{ id: "F-001" }] }));
    // No decisions/1.jsonl written → findings unaddressed.
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      headSha: "1111111bbbbbbb", // a commit landed mid-FAIL
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: DOC_DIFF,
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    expect(decision.kind).toBe("block");
    expect(decision.reason).toContain("not yet addressed");
    // Budget preserved (not reset to 0).
    expect((await state.load()).iteration).toBe(1);
  });
});
