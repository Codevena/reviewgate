// tests/unit/loop-driver.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { IterationResult } from "../../src/core/orchestrator.ts";
import { QuotaCooldownStore } from "../../src/core/quota-cooldown.ts";
import { StateStore } from "../../src/core/state-store.ts";
import { CodexAdapter } from "../../src/providers/codex.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";
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
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({ findings: [{ id: "F-001", severity: "CRITICAL" }] }),
    );
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
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({ findings: [{ id: "F-001", severity: "CRITICAL" }] }),
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
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({ findings: [{ id: "F-001", severity: "CRITICAL" }] }),
    );
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

  it("names the invalid line and WHY in the block message (too-short reason)", async () => {
    // F-088: a rejection whose reason is < 20 chars fails DecisionEntrySchema and
    // is silently dropped → the agent re-reads the SAME generic block, sees its
    // line IS in the file, and can loop without knowing the validation failed.
    // The block message must say which finding's decision was invalid and why.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQMALG");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({ findings: [{ id: "F-001", severity: "CRITICAL" }] }),
    );
    const dpath = decisionsPath(repo, 1);
    mkdirSync(dirname(dpath), { recursive: true });
    writeFileSync(
      dpath,
      `${JSON.stringify({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "rejected",
        reason: "nope", // 4 chars < 20 → schema fails
      })}\n`,
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
    if (decision.kind !== "block") throw new Error("expected block");
    // Must name the offending finding id and signal it was a validation problem.
    expect(decision.reason).toContain("F-001");
    expect(decision.reason).toMatch(/reason|20|invalid|rejected/i);
  });

  it("still blocks (not escalate) for unaddressed findings on a user-initiated stop", async () => {
    // stop_hook_active=false means a fresh user turn: ask the agent to address
    // findings (block), don't escalate yet.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQBLOCK");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({ findings: [{ id: "F-001", severity: "CRITICAL" }] }),
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

  it("does NOT escalate a converging cycle just because a transient ERROR left an empty signature row (F-001)", async () => {
    // maxIterations=3. Real reviewed rows strictly decrease (3 → 2); the middle
    // round was a reviewer ERROR which appends a 0-length signature row. The
    // convergence-grace check must SKIP that empty row, not read it as "0 real
    // findings" and abort a genuinely-progressing cycle.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQERR01");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      // idx0: 3 real findings · idx1: ERROR (empty) · idx2: 2 real findings
      signature_history: [["s1", "s2", "s3"], [], ["s1", "s2"]],
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
        diff: DOC_DIFF, // doc-only → triage skips the panel → PASS → re-arm
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    // The converging cycle must NOT have given up.
    expect(existsSync(join(repo, ".reviewgate", "ESCALATION.md"))).toBe(false);
    if (decision.kind === "block") expect(decision.reason).not.toMatch(/ESCALATED/);
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
            reviewer: { provider: "codex", model: "gpt-5.5", persona: "security" },
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

  it("escalation history shows REAL per-iteration CRIT/WARN for EARLIER iterations (Bug A)", async () => {
    // Earlier rows used to be hardcoded to 0 (only the last iter had real counts).
    // With iteration_stats persisted, every row shows its actual severity split.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQESCSTATS");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [["s1"], ["s1"], ["s1"]],
      iteration_stats: [
        { critical: 2, warn: 1, info: 0, cost_usd: 0, verdict: "FAIL" },
        { critical: 1, warn: 0, info: 0, cost_usd: 0, verdict: "FAIL" },
        { critical: 1, warn: 0, info: 0, cost_usd: 0, verdict: "FAIL" },
      ],
    }));
    writeDirty(repo);
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({ findings: [], counts: { critical: 1, warn: 0, info: 0 } }),
    );
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
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
    expect(md).toContain("| 1    | FAIL    | 2    | 1    |"); // iter1 CRIT=2 WARN=1 (was 0/0)
    expect(md).toContain("| 2    | FAIL    | 1    |"); // iter2 CRIT=1 (was 0)
  });

  it("does NOT mislabel non-passing iterations as 'FAIL' with 0/0 when iteration_stats is unavailable (back-compat) (F-090)", async () => {
    // Back-compat: state.json predates iteration_stats, so it loads as []. The
    // earlier per-iter rows must NOT be silently rendered as "FAIL · 0 CRIT · 0 WARN"
    // — a human auditing "why did this escalate" would read 0/0 FAIL as "there were
    // never any findings", contradicting the Final-findings section. Mark the
    // unavailable rows explicitly instead of asserting a fabricated FAIL/0/0.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQESCNOSTATS");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [["s1", "s2"], ["s1"], ["s1"]],
      iteration_stats: [], // back-compat: field absent in persisted state
    }));
    writeDirty(repo);
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({ findings: [], counts: { critical: 1, warn: 0, info: 0 } }),
    );
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
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
    // The last row (iter 3) still gets its real counts from pending.json.
    expect(md).toContain("| 3    | FAIL    | 1    |");
    // Earlier rows (iters 1-2) had findings but no stats → must be flagged as
    // unavailable, NOT "FAIL" with a fabricated 0/0 severity split.
    expect(md).not.toContain("| 1    | FAIL    | 0    | 0    |");
    expect(md).not.toContain("| 2    | FAIL    | 0    | 0    |");
    expect(md).toMatch(/\| 1 +\| n\/a/);
    expect(md).toMatch(/\| 2 +\| n\/a/);
  });

  it("decisions-gate ignores INFO/scope_demoted findings (only CRITICAL/WARN need decisions)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQGATEINFO");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          { id: "F-001", severity: "WARN" },
          { id: "F-002", severity: "INFO", scope_demoted: true },
        ],
      }),
    );
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
      stopHookActive: false,
    });
    const decision = await driver.run();
    // F-001 (WARN) addressed; F-002 (INFO) not required → gate proceeds → PASS on DOC_DIFF.
    expect(decision.kind).toBe("allow_stop");
  });

  it("re-arms and reviews NEW edits made after an escalation (does not silently allow un-reviewed code, F-002)", async () => {
    // Once escalated+announced, the dirty.flag is unlinked. Its reappearance means
    // the agent edited MORE code after the gate gave up — that new diff must be
    // reviewed, not waved through. State is escalated/announced at the iter-cap;
    // a fresh dirty.flag stands in for the post-escalation edits.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQRESC2");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      escalated: true,
      escalation_reason: "max-iterations",
      escalation_announced: true,
      signature_history: [["s1"], ["s1"], ["s1"]],
    }));
    writeDirty(repo); // new edits after the escalation
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
        diff: DOC_DIFF, // doc-only → triage skips panel → PASS on the re-armed cycle
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    const after = await state.load();
    // The new edits were reviewed in a fresh cycle (re-armed), NOT allowed via the
    // sticky-escalation short-circuit which would leave escalated=true untouched.
    expect(after.escalated).toBe(false);
    expect(after.iteration).toBe(0); // PASS on DOC_DIFF re-armed the budget
    expect(decision.kind).toBe("allow_stop");
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

  it("increments reputation_cycle_seq on a commit-recovery re-arm", async () => {
    // The commit-recovery re-arm (HEAD moved while ESCALATED) closes the cycle, so
    // it must bump reputation_cycle_seq just like the clean-PASS re-arm — otherwise
    // the recovered cycle's reputation event-ids would collide with the prior cycle's.
    // Uses a CODE diff so the post-recovery iteration FAILs (panel runs) → the
    // PASS-branch increment does NOT run, isolating the commit-recovery increment.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQREPCYCCOMMIT");
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
        // Code diff → panel runs → FAIL, so only the recovery-path increment fires.
        diff: "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-x\n+y\n",
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    expect(decision.kind).toBe("block"); // fresh iteration 1 FAILed
    const after = await state.load();
    expect(after.escalated).toBe(false); // re-armed on the commit
    expect(after.reputation_cycle_seq).toBe(1); // bumped once on the commit-recovery
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
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({ findings: [{ id: "F-001", severity: "CRITICAL" }] }),
    );
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

  it("escalates reject-rate-high when this cycle's confirmed-FP rate exceeds the threshold", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQREJECT");
    // iteration 2 < maxIterations(3); no equal trailing signatures (stuck won't
    // fire); cost 0 (OAuth) so cost-cap won't fire → reject-rate is the trigger.
    await state.update((cur) => ({ ...cur, iteration: 2 }));
    writeDirty(repo);
    const wrong = (id: string) => ({
      schema: "reviewgate.decision.v1",
      finding_id: id,
      verdict: "rejected",
      reason: "false positive on unchanged code xx",
      reviewer_was_wrong: true,
    });
    // 4 REAL blocking findings, all rejected as confirmed reviewer FPs → the
    // decisions-gate is satisfied (each addressed) and rate = 4/4 = 100% ≥ 80%.
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          { id: "F-001", severity: "CRITICAL" },
          { id: "F-002", severity: "CRITICAL" },
          { id: "F-003", severity: "WARN" },
          { id: "F-004", severity: "WARN" },
        ],
      }),
    );
    const dp = decisionsPath(repo, 2);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${[wrong("F-001"), wrong("F-002"), wrong("F-003"), wrong("F-004")].map((l) => JSON.stringify(l)).join("\n")}\n`,
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
    expect(decision.kind).toBe("block");
    expect(decision.reason).toContain("ESCALATED");
    expect(decision.reason).toContain("reject-rate-high");
    expect((await state.load()).escalation_reason).toBe("reject-rate-high");
    expect(existsSync(join(repo, ".reviewgate", "ESCALATION.md"))).toBe(true);
  });

  it("escalates reviewer-fp-streak when confirmed FPs accumulate ACROSS iterations (below the iter-cap)", async () => {
    // Reproduces the dogfood bug: a reviewer that hallucinates a FRESH confirmed-FP
    // CRITICAL each iteration (mutating signature) evades the signature-keyed
    // FP-ledger/stuck-detection AND the single-iteration reject-rate (1 FP/iter never
    // reaches the sample floor). With maxIterations raised (5) the iter-cap is NOT the
    // trigger — the cross-iteration FP streak (threshold 3) must escalate by itself.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQFPSTREAK");
    writeDirty(repo);
    const config = {
      ...defaultConfig,
      loop: { ...defaultConfig.loop, maxIterations: 5, fpStreakThreshold: 3 },
    };
    // Stub orchestrator: writes pending.json with ONE fresh CRITICAL each iteration
    // and returns FAIL with a DISTINCT signature (so stuck-detection never fires).
    const stub = {
      runIteration: async (opts: { runId: string; iter: number; signal?: AbortSignal }) => {
        writeFileSync(
          pendingJsonPath(repo),
          JSON.stringify({ findings: [{ id: "F-001", severity: "CRITICAL" }] }),
        );
        const summary: RunSummary = {
          verdict: "FAIL",
          source: "panel",
          counts: { critical: 1, warn: 0, info: 0 },
          cost_usd: 0,
          duration_ms: 1,
          demoted: 0,
          signatures: [`sig-${opts.iter}`],
          providers: [],
        };
        return {
          verdict: "FAIL" as const,
          costUsd: 0,
          durationMs: 1,
          signaturesThisIter: [`sig-${opts.iter}`],
          summary,
        };
      },
    };
    const mkDriver = () =>
      new LoopDriver({
        repoRoot: repo,
        config,
        state,
        audit: new AuditLogger(auditDir(repo)),
        orchestrator: stub,
        stopHookActive: false,
      });
    // Drive the FAIL → reject-as-confirmed-FP → re-review loop. Each round the agent
    // rejects the (fresh) finding with reviewer_was_wrong, exactly as in the dogfood.
    let decision = await mkDriver().run();
    for (let i = 1; i <= 6 && !decision.reason.includes("ESCALATED"); i++) {
      const dp = decisionsPath(repo, i);
      mkdirSync(dirname(dp), { recursive: true });
      writeFileSync(
        dp,
        `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "confirmed false positive, verified by grep at this commit xx", reviewer_was_wrong: true })}\n`,
      );
      decision = await mkDriver().run();
    }
    // reviewer-fp-streak ALLOWS the stop (the REVIEWER is the problem, not the
    // agent's code — blocking would punish correct rejections). It still writes
    // ESCALATION.md + warns the human to fix the reviewer config.
    expect(decision.kind).toBe("allow_stop");
    expect(decision.reason).toContain("ESCALATED");
    expect(decision.reason).toContain("reviewer-fp-streak");
    const after = await state.load();
    expect(after.escalation_reason).toBe("reviewer-fp-streak");
    // Escalated via the FP streak BELOW the iteration cap — not the max-iterations path.
    expect(after.iteration).toBeLessThan(5);
    expect(existsSync(join(repo, ".reviewgate", "ESCALATION.md"))).toBe(true);
  });

  it("learn loops absorb the prior iteration's decisions BEFORE escalation early-returns (shoal 2026-05-29 regression)", async () => {
    // Reproduces the shoal incident: opencode-security produced 3 hallucinated
    // CRITICAL/WARN findings, agent rejected all 3 with reviewer_was_wrong:true,
    // gate escalated on reviewer-fp-streak — but the FP-ledger and reputation
    // store were unchanged because both learn calls ran AFTER the escalation
    // check returned. Post-fix, both fire via `absorbPriorDecisions` before
    // any escalation check has a chance to early-return.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSHOALFPREGRESSION");
    writeDirty(repo);
    const config = {
      ...defaultConfig,
      loop: { ...defaultConfig.loop, maxIterations: 5, fpStreakThreshold: 3 },
      phases: {
        ...defaultConfig.phases,
        fpLedger: { enabled: true },
        // reputation is default-enabled in defaultConfig
      },
    };
    // Seed a pending.json AND a Finding that learnFromDecisions can map to a
    // signature → provider so the ledger actually writes an entry.
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            signature: "shoal-sig-1",
            severity: "CRITICAL",
            category: "correctness",
            rule_id: "phantom-race",
            file: "lib/foo.ts",
            line_start: 1,
            line_end: 1,
            message: "phantom",
            details: "details",
            reviewer: { provider: "opencode", model: "default", persona: "security" },
            confidence: 0.9,
            consensus: "singleton",
          },
        ],
      }),
    );
    const stub = {
      runIteration: async (opts: { runId: string; iter: number; signal?: AbortSignal }) => {
        const summary: RunSummary = {
          verdict: "FAIL",
          source: "panel",
          counts: { critical: 1, warn: 0, info: 0 },
          cost_usd: 0,
          duration_ms: 1,
          demoted: 0,
          signatures: [`sig-${opts.iter}`],
          providers: [],
        };
        return {
          verdict: "FAIL" as const,
          costUsd: 0,
          durationMs: 1,
          signaturesThisIter: [`sig-${opts.iter}`],
          summary,
        };
      },
    };
    const mkDriver = () =>
      new LoopDriver({
        repoRoot: repo,
        config,
        state,
        audit: new AuditLogger(auditDir(repo)),
        orchestrator: stub,
        stopHookActive: false,
      });
    // Drive the loop: write decisions, run, write decisions, run, ... until escalation.
    let decision = await mkDriver().run();
    for (let i = 1; i <= 6 && !decision.reason.includes("ESCALATED"); i++) {
      const dp = decisionsPath(repo, i);
      mkdirSync(dirname(dp), { recursive: true });
      writeFileSync(
        dp,
        `${JSON.stringify({
          schema: "reviewgate.decision.v1",
          finding_id: "F-001",
          verdict: "rejected",
          reason: "confirmed false positive, opencode hallucinated this race condition",
          reviewer_was_wrong: true,
        })}\n`,
      );
      decision = await mkDriver().run();
    }
    expect(decision.reason).toContain("ESCALATED");
    expect(decision.reason).toContain("reviewer-fp-streak");

    // THE REGRESSION ASSERTIONS — pre-fix these failed because the learn calls
    // never fired on the escalation path:
    // 1. FP-ledger has the hallucinated finding's signature recorded.
    const fpPath = join(repo, ".reviewgate", "learnings", "known_fp.jsonl");
    expect(existsSync(fpPath)).toBe(true);
    const fp = JSON.parse(readFileSync(fpPath, "utf8")) as {
      entries: Array<{ signature: string; rejects: Array<{ provider: string }> }>;
    };
    expect(fp.entries.length).toBeGreaterThan(0);
    expect(fp.entries[0]?.signature).toBe("shoal-sig-1");
    expect(fp.entries[0]?.rejects[0]?.provider).toBe("opencode");
    // 2. Reputation has opencode-security recorded as wrong at least once.
    const repPath = join(repo, ".reviewgate", "reputation.json");
    expect(existsSync(repPath)).toBe(true);
    const rep = JSON.parse(readFileSync(repPath, "utf8")) as {
      reviewers: Record<string, { correct: unknown[]; wrong: unknown[] }>;
    };
    const opencode = rep.reviewers["opencode:security"];
    expect(opencode).toBeDefined();
    expect(opencode?.wrong.length).toBeGreaterThan(0);
  });

  it("absorbs partial decisions BEFORE the decisions-unaddressed escalation early-returns (stop_hook_active)", async () => {
    // The OTHER early-return: stop_hook_active=true + a required finding left
    // unaddressed → `decisions-unaddressed` escalation at the TOP of the
    // iteration>0 block, ABOVE absorbPriorDecisions. If the agent rejected SOME
    // findings with reviewer_was_wrong before giving up, that valid FP signal
    // must still be learned, not lost to the early return.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXDECUNADDR");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    const config = {
      ...defaultConfig,
      phases: { ...defaultConfig.phases, fpLedger: { enabled: true } },
    };
    // F-001 will be rejected reviewer_was_wrong; F-002 (CRITICAL) is required and
    // left WITHOUT a decision → the decisions gate is NOT addressed.
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            signature: "decunaddr-sig-1",
            severity: "WARN",
            category: "correctness",
            rule_id: "phantom",
            file: "lib/foo.ts",
            line_start: 1,
            line_end: 1,
            message: "phantom",
            details: "details",
            reviewer: { provider: "opencode", model: "default", persona: "security" },
            confidence: 0.9,
            consensus: "singleton",
          },
          { id: "F-002", signature: "decunaddr-sig-2", severity: "CRITICAL" },
        ],
      }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "rejected",
        reason: "confirmed false positive, verified the symbol exists at lib/foo.ts",
        reviewer_was_wrong: true,
      })}\n`,
    );
    const stub = {
      runIteration: async () => ({
        verdict: "FAIL" as const,
        costUsd: 0,
        durationMs: 1,
        signaturesThisIter: ["x"],
        summary: {
          verdict: "FAIL",
          source: "panel",
          counts: { critical: 0, warn: 0, info: 0 },
          cost_usd: 0,
          duration_ms: 1,
          demoted: 0,
          signatures: ["x"],
          providers: [],
        } as RunSummary,
      }),
    };
    const decision = await new LoopDriver({
      repoRoot: repo,
      config,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: true,
    }).run();
    // It DOES escalate/block (F-002 unaddressed) — that part is unchanged…
    expect(decision.kind).toBe("block");
    // …but the valid F-001 reject must STILL have been learned before the return.
    const fpPath = join(repo, ".reviewgate", "learnings", "known_fp.jsonl");
    expect(existsSync(fpPath)).toBe(true);
    const fp = JSON.parse(readFileSync(fpPath, "utf8")) as {
      entries: Array<{ signature: string }>;
    };
    expect(fp.entries.some((e) => e.signature === "decunaddr-sig-1")).toBe(true);
  });

  it("folds prior reviewer_was_wrong rejections into cycle_rejected_signatures and passes them to the next run (2b)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXCYCLEREJ2B");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({ findings: [{ id: "F-001", signature: "sig-X", severity: "CRITICAL" }] }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "false positive, verified the symbol exists at x.ts:1", reviewer_was_wrong: true })}\n`,
    );
    let received: string[] | undefined;
    const stub = {
      runIteration: async (opts: { cycleRejectedSignatures?: string[] }) => {
        received = opts.cycleRejectedSignatures;
        return {
          verdict: "FAIL" as const,
          costUsd: 0,
          durationMs: 1,
          signaturesThisIter: ["s"],
          summary: {
            verdict: "FAIL",
            source: "panel",
            counts: { critical: 0, warn: 0, info: 0 },
            cost_usd: 0,
            duration_ms: 1,
            demoted: 0,
            signatures: ["s"],
            providers: [],
          } as RunSummary,
        };
      },
    };
    await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();
    expect(received).toContain("sig-X");
    expect((await state.load()).cycle_rejected_signatures).toContain("sig-X");
  });

  it("all-reviewers-quota-locked defers (allow-stop), keeps dirty.flag, does NOT advance iteration (1B)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXALLQUOTA1B");
    await state.update((cur) => ({ ...cur, iteration: 2 }));
    writeDirty(repo);
    const stub = {
      runIteration: async () => ({
        verdict: "ERROR" as const,
        allReviewersQuotaLocked: true,
        costUsd: 0,
        durationMs: 1,
        signaturesThisIter: [],
        summary: {
          verdict: "ERROR",
          source: "panel",
          counts: { critical: 0, warn: 0, info: 0 },
          cost_usd: 0,
          duration_ms: 1,
          demoted: 0,
          signatures: [],
          providers: [],
        } as RunSummary,
      }),
    };
    const decision = await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();
    // Transient quota outage → allow the stop (don't block the dev for hours) …
    expect(decision.kind).toBe("allow_stop");
    expect(decision.reason).toMatch(/quota/i);
    // … keep the dirty flag (re-review next turn after reset) …
    expect(existsSync(dirtyFlagPath(repo))).toBe(true);
    // … and do NOT advance the iteration (no real review happened → no march to max-iter).
    expect((await state.load()).iteration).toBe(2);
  });

  it("increments reputation_cycle_seq on a clean-PASS re-arm", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQREPCYC");
    writeDirty(repo);
    const passOrch = {
      runIteration: async () => ({
        verdict: "PASS" as const,
        costUsd: 0,
        durationMs: 1,
        signaturesThisIter: [],
        summary: {
          verdict: "PASS",
          source: "panel",
          counts: { critical: 0, warn: 0, info: 0 },
          cost_usd: 0,
          duration_ms: 1,
          demoted: 0,
          signatures: [],
          providers: [],
        } as RunSummary,
      }),
    };
    await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: passOrch,
      stopHookActive: false,
    }).run();
    expect((await state.load()).reputation_cycle_seq).toBe(1);
  });

  it("folds fp_rejects_history even when the streak breaker is disabled (fpStreakThreshold=0)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQFOLD");
    // one completed iteration (index 0) with one blocking finding F-001
    await state.update((cur) => ({ ...cur, iteration: 1, signature_history: [["sig-a"]] }));
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({ findings: [{ id: "F-001", severity: "CRITICAL" }] }),
    );
    mkdirSync(dirname(decisionsPath(repo, 1)), { recursive: true });
    writeFileSync(
      decisionsPath(repo, 1),
      `${JSON.stringify({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "rejected",
        reason: "verified false positive by runtime trace",
        reviewer_was_wrong: true,
      })}\n`,
    );
    writeDirty(repo);
    const cfg = {
      ...defaultConfig,
      loop: { ...defaultConfig.loop, fpStreakThreshold: 0, maxIterations: 99 },
    };
    // Use a code diff so fake-codex runs (FAIL verdict) — an empty diff triages to
    // PASS (panel skipped) which resets fp_rejects_history before the assertion.
    const CODE_DIFF =
      "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-x\n+y\n";
    const driver = new LoopDriver({
      repoRoot: repo,
      config: cfg,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: cfg,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: CODE_DIFF,
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    await driver.run();
    // iteration 1's decisions folded into fp_rejects_history[0] (decoupled from threshold)
    expect((await state.load()).fp_rejects_history[0]).toBe(1);
  });

  it("a padded reject rate does NOT mask the unaddressed-findings block", async () => {
    // The decisions-gate must take precedence: an agent cannot append unrelated
    // reviewer_was_wrong lines to force a reject-rate escape while leaving the
    // real blocking finding unaddressed.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQMASK");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    // A real blocking finding with NO decision for it.
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({ findings: [{ id: "F-001", severity: "CRITICAL" }] }),
    );
    // Padding: 4 distinct unrelated confirmed-FP lines (would push rate to 100%).
    const wrong = (id: string) => ({
      schema: "reviewgate.decision.v1",
      finding_id: id,
      verdict: "rejected",
      reason: "false positive on unchanged code xx",
      reviewer_was_wrong: true,
    });
    const dpath = decisionsPath(repo, 1);
    mkdirSync(dirname(dpath), { recursive: true });
    writeFileSync(
      dpath,
      `${[wrong("F-901"), wrong("F-902"), wrong("F-903"), wrong("F-904")].map((l) => JSON.stringify(l)).join("\n")}\n`,
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
    expect(decision.kind).toBe("block");
    expect(decision.reason).toContain("not yet addressed"); // decisions-gate wins
    expect(decision.reason).not.toContain("reject-rate-high");
  });

  it("folds prior accepted/action:fixed decisions into claimed_fixed_signatures and passes them to the next run (§4.3)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXCLAIMEDFIX");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          { id: "F-001", signature: "sig-fixed", severity: "WARN" },
          { id: "F-002", signature: "sig-elsewhere", severity: "WARN" },
        ],
      }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "fixed" })}\n` +
        `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-002", verdict: "accepted", action: "addressed-elsewhere" })}\n`,
    );
    let received: Record<string, number> | undefined;
    const stub = {
      runIteration: async (opts: { claimedFixedSignatures?: Record<string, number> }) => {
        received = opts.claimedFixedSignatures;
        return {
          verdict: "FAIL" as const,
          costUsd: 0,
          durationMs: 1,
          signaturesThisIter: ["s"],
          summary: {
            verdict: "FAIL",
            source: "panel",
            counts: { critical: 0, warn: 0, info: 0 },
            cost_usd: 0,
            duration_ms: 1,
            demoted: 0,
            signatures: ["s"],
            providers: [],
          } as RunSummary,
        };
      },
    };
    await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();
    // Only action:"fixed" is recorded; addressed-elsewhere is NOT.
    expect(received?.["sig-fixed"]).toBe(1);
    expect(received?.["sig-elsewhere"]).toBeUndefined();
    expect((await state.load()).claimed_fixed_signatures["sig-fixed"]).toBe(1);
  });

  it("keeps the EARLIEST claimed-fixed iter when the same signature is re-claimed in a later iteration (§4.3)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXCLAIMEDEARLIEST");
    // Pre-seed: sig-X was already recorded as claimed-fixed at iter 1, and we are now
    // folding iteration 2's decisions (which claim sig-X fixed AGAIN).
    await state.update((cur) => ({
      ...cur,
      iteration: 2,
      claimed_fixed_signatures: { "sig-X": 1 },
    }));
    writeDirty(repo);
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({ findings: [{ id: "F-001", signature: "sig-X", severity: "WARN" }] }),
    );
    const dp = decisionsPath(repo, 2);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "fixed" })}\n`,
    );
    let received: Record<string, number> | undefined;
    const stub = {
      runIteration: async (opts: { claimedFixedSignatures?: Record<string, number> }) => {
        received = opts.claimedFixedSignatures;
        return {
          verdict: "FAIL" as const,
          costUsd: 0,
          durationMs: 1,
          signaturesThisIter: ["s"],
          summary: {
            verdict: "FAIL",
            source: "panel",
            counts: { critical: 0, warn: 0, info: 0 },
            cost_usd: 0,
            duration_ms: 1,
            demoted: 0,
            signatures: ["s"],
            providers: [],
          } as RunSummary,
        };
      },
    };
    await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();
    // Earliest iter (1) preserved — NOT advanced to 2.
    expect(received?.["sig-X"]).toBe(1);
    expect((await state.load()).claimed_fixed_signatures["sig-X"]).toBe(1);
  });

  it("records BOTH representative and member signatures of an accepted/fixed clustered finding (§4.3)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXCLAIMEDMEMBER");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            signature: "rep-sig",
            severity: "WARN",
            members: [{ signature: "rep-sig" }, { signature: "mem-sig" }],
          },
        ],
      }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "accepted", action: "fixed" })}\n`,
    );
    let received: Record<string, number> | undefined;
    const stub = {
      runIteration: async (opts: { claimedFixedSignatures?: Record<string, number> }) => {
        received = opts.claimedFixedSignatures;
        return {
          verdict: "FAIL" as const,
          costUsd: 0,
          durationMs: 1,
          signaturesThisIter: ["s"],
          summary: {
            verdict: "FAIL",
            source: "panel",
            counts: { critical: 0, warn: 0, info: 0 },
            cost_usd: 0,
            duration_ms: 1,
            demoted: 0,
            signatures: ["s"],
            providers: [],
          } as RunSummary,
        };
      },
    };
    await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();
    expect(received?.["rep-sig"]).toBe(1);
    expect(received?.["mem-sig"]).toBe(1); // member signature captured too
    const persisted = (await state.load()).claimed_fixed_signatures;
    expect(persisted["rep-sig"]).toBe(1);
    expect(persisted["mem-sig"]).toBe(1);
  });

  it("records BOTH representative and member signatures of a reviewer_was_wrong rejection (2b key-space symmetry)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXREJMEMBER");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            signature: "rep-sig",
            severity: "WARN",
            members: [{ signature: "rep-sig" }, { signature: "mem-sig" }],
          },
        ],
      }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "false positive — verified the symbol exists at x.ts:1", reviewer_was_wrong: true })}\n`,
    );
    let received: string[] | undefined;
    const stub = {
      runIteration: async (opts: { cycleRejectedSignatures?: string[] }) => {
        received = opts.cycleRejectedSignatures;
        return {
          verdict: "FAIL" as const,
          costUsd: 0,
          durationMs: 1,
          signaturesThisIter: ["s"],
          summary: {
            verdict: "FAIL",
            source: "panel",
            counts: { critical: 0, warn: 0, info: 0 },
            cost_usd: 0,
            duration_ms: 1,
            demoted: 0,
            signatures: ["s"],
            providers: [],
          } as RunSummary,
        };
      },
    };
    await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();
    expect(received).toContain("rep-sig");
    expect(received).toContain("mem-sig");
    const persisted = (await state.load()).cycle_rejected_signatures;
    expect(persisted).toContain("rep-sig");
    expect(persisted).toContain("mem-sig");
  });
});

describe("LoopDriver stuck-signature threshold (configurable)", () => {
  const cfgWith = (stuckThreshold: number, maxIterations: number) => ({
    ...defaultConfig,
    loop: { ...defaultConfig.loop, stuckThreshold, maxIterations },
  });

  async function drive(opts: {
    stuckThreshold: number;
    maxIterations: number;
    history: string[][];
    iteration: number;
    diff: string;
  }) {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQSTUCK");
    await state.update((cur) => ({
      ...cur,
      iteration: opts.iteration,
      signature_history: opts.history,
    }));
    writeDirty(repo);
    const driver = new LoopDriver({
      repoRoot: repo,
      config: cfgWith(opts.stuckThreshold, opts.maxIterations),
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: cfgWith(opts.stuckThreshold, opts.maxIterations),
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: opts.diff,
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    return { decision, state };
  }

  it("default stuckThreshold=2: escalates on 2 identical signature iterations", async () => {
    const { decision, state } = await drive({
      stuckThreshold: 2,
      maxIterations: 3,
      history: [["sig1"], ["sig1"]],
      iteration: 2,
      diff: "",
    });
    expect(decision.kind).toBe("block");
    expect(decision.reason).toMatch(/ESCALATED/);
    expect((await state.load()).escalation_reason).toBe("stuck-signatures");
  });

  it("stuckThreshold=3: does NOT escalate on only 2 identical iterations", async () => {
    const { decision, state } = await drive({
      stuckThreshold: 3,
      maxIterations: 10,
      history: [["sig1"], ["sig1"]],
      iteration: 2,
      diff: DOC_DIFF, // doc-only → panel skipped → PASS, no stuck escalation
    });
    expect(decision.kind).toBe("allow_stop");
    expect((await state.load()).escalation_reason).not.toBe("stuck-signatures");
  });

  it("stuckThreshold=3: escalates once 3 identical iterations accumulate", async () => {
    const { decision, state } = await drive({
      stuckThreshold: 3,
      maxIterations: 10,
      history: [["sig1"], ["sig1"], ["sig1"]],
      iteration: 3,
      diff: "",
    });
    expect(decision.kind).toBe("block");
    expect(decision.reason).toMatch(/ESCALATED/);
    expect((await state.load()).escalation_reason).toBe("stuck-signatures");
  });
});

describe("LoopDriver convergence-aware max-iterations", () => {
  async function drive(
    history: string[][],
    iteration: number,
    opts: {
      maxIterations?: number;
      fpHistory?: number[];
      fpStreakThreshold?: number;
      latestFindingIds?: string[];
      latestWrongIds?: string[];
      latestAcceptedIds?: string[];
    } = {},
  ) {
    const {
      maxIterations = 3,
      fpHistory = [],
      fpStreakThreshold = 3,
      latestFindingIds,
      latestWrongIds = [],
      latestAcceptedIds = [],
    } = opts;
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQCONV");
    await state.update((cur) => ({
      ...cur,
      iteration,
      signature_history: history,
      fp_rejects_history: fpHistory,
    }));
    // Latest-iteration FP-rejects are computed fresh from pending + decisions:
    if (latestFindingIds) {
      writeFileSync(
        pendingJsonPath(repo),
        JSON.stringify({ findings: latestFindingIds.map((id) => ({ id, severity: "CRITICAL" })) }),
      );
      mkdirSync(dirname(decisionsPath(repo, iteration)), { recursive: true });
      const lines = [
        ...latestWrongIds.map((id) =>
          JSON.stringify({
            schema: "reviewgate.decision.v1",
            finding_id: id,
            verdict: "rejected",
            reason: "verified false positive by runtime trace",
            reviewer_was_wrong: true,
          }),
        ),
        ...latestAcceptedIds.map((id) =>
          JSON.stringify({
            schema: "reviewgate.decision.v1",
            finding_id: id,
            verdict: "accepted",
            action: "fixed",
            files_touched: ["x"],
          }),
        ),
      ];
      writeFileSync(
        decisionsPath(repo, iteration),
        `${lines.join("\n")}${lines.length ? "\n" : ""}`,
      );
    }
    writeDirty(repo);
    const cfg = {
      ...defaultConfig,
      loop: { ...defaultConfig.loop, maxIterations, stuckThreshold: 99, fpStreakThreshold },
    };
    const driver = new LoopDriver({
      repoRoot: repo,
      config: cfg,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: cfg,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: "",
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    return { decision, state, repo };
  }

  it("a CONVERGING loop (findings decreasing) does NOT escalate at maxIterations", async () => {
    // 5 → 3 findings: strictly decreasing → healthy progress → run another round.
    const { state } = await drive(
      [
        ["a", "b", "c", "d", "e"],
        ["a", "b", "c"],
      ],
      3,
    );
    expect((await state.load()).escalated).toBe(false);
  });

  it("a NON-progressing loop (findings rising/flat) escalates at maxIterations", async () => {
    const { decision, state } = await drive([["a"], ["a", "b"]], 3); // 1 → 2, rising
    expect(decision.kind).toBe("block");
    expect(decision.reason).toMatch(/ESCALATED/);
    expect((await state.load()).escalation_reason).toBe("max-iterations");
  });

  it("escalates at the hard cap (2× maxIterations) even while still converging", async () => {
    // 6 → 5 (decreasing) but iteration == hard cap → backstop escalates anyway.
    const { decision, state, repo } = await drive(
      [
        ["a", "b", "c", "d", "e", "f"],
        ["a", "b", "c", "d", "e"],
      ],
      6,
      { maxIterations: 3 },
    );
    expect(decision.kind).toBe("block");
    expect(decision.reason).toMatch(/ESCALATED/);
    expect((await state.load()).escalation_reason).toBe("max-iterations");
    expect(existsSync(join(repo, ".reviewgate", "ESCALATION.md"))).toBe(true);
  });

  it("REAL progress despite rising total count (FP churn) does NOT escalate", async () => {
    // total 4 → 5; but iter-1 had 1 FP and the latest (iter 2, 5 findings) has 3 FPs
    // → real 4 → 2 (decreasing). fp_rejects_history[0]=1 (prev); latest computed fresh=3.
    // ALL 5 latest findings are decided (F1–F3 reviewer_was_wrong, F4/F5 accepted+fixed)
    // so the decisions-gate is satisfied — the convergence-grace path is the PROVEN
    // reason the gate doesn't escalate, not an unaddressed-findings block.
    const { state } = await drive(
      [
        ["a", "b", "c", "d"],
        ["a", "b", "c", "d", "e"],
      ],
      3,
      {
        // fpStreakThreshold high so the cross-iteration FP-streak breaker (which 3
        // confirmed FPs in one iter would otherwise trip) does NOT fire — this
        // isolates the convergence-grace predicate as the reason the gate proceeds.
        fpStreakThreshold: 10,
        fpHistory: [1],
        latestFindingIds: ["F1", "F2", "F3", "F4", "F5"],
        latestWrongIds: ["F1", "F2", "F3"],
        latestAcceptedIds: ["F4", "F5"],
      },
    );
    // escalation_reason null ⇒ neither max-iterations nor any other escalation fired:
    // the grace let the loop proceed past the cap (real 3 → 2 is decreasing).
    const s = await state.load();
    expect(s.escalated).toBe(false);
    expect(s.escalation_reason).toBeNull();
  });

  it("all-FP latest with streak breaker ENABLED → grace (no 'not converging')", async () => {
    // BOTH iterations all-FP → prevReal=0 (2−2) and lastReal=0, so the first clause
    // (lastReal<prevReal = 0<0) is FALSE — grace can only come from (lastReal===0 &&
    // streakOn). This isolates the streak-gate, not the count-drop clause.
    const { state } = await drive(
      [
        ["a", "b"],
        ["a", "b"],
      ],
      3,
      {
        fpStreakThreshold: 3,
        fpHistory: [2],
        latestFindingIds: ["F1", "F2"],
        latestWrongIds: ["F1", "F2"],
      },
    );
    expect((await state.load()).escalated).toBe(false); // lastReal===0, streak on
  });

  it("all-FP latest with streak breaker DISABLED → escalates max-iterations", async () => {
    // Same shape (prevReal=0, lastReal=0) but streak OFF → (0===0 && false) → escalate.
    const { decision, state } = await drive(
      [
        ["a", "b"],
        ["a", "b"],
      ],
      3,
      {
        fpStreakThreshold: 0,
        fpHistory: [2],
        latestFindingIds: ["F1", "F2"],
        latestWrongIds: ["F1", "F2"],
      },
    );
    expect(decision.kind).toBe("block");
    expect((await state.load()).escalation_reason).toBe("max-iterations");
  });

  it("genuine non-convergence (real findings flat/rising) escalates", async () => {
    // real 2 → 3 (no FPs) → escalate "real findings not decreasing"
    const { state } = await drive(
      [
        ["a", "b"],
        ["a", "b", "c"],
      ],
      3,
      { fpHistory: [0], latestFindingIds: ["F1", "F2", "F3"], latestWrongIds: [] },
    );
    expect((await state.load()).escalation_reason).toBe("max-iterations");
  });
});

describe("LoopDriver cost-cap escalation", () => {
  it("escalates cost-cap once cost_usd_so_far reaches loop.costCapUsd", async () => {
    // apikey/openrouter mode accrues cost; once it hits the cap the gate escalates
    // to the human rather than burning more budget. (OAuth keeps cost 0, so this
    // path never fires there — hence it needs an explicit test.)
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQCOSTCAP");
    // Default cap is $1.50; put accrued cost above it.
    await state.update((cur) => ({ ...cur, cost_usd_so_far: 2.0 }));
    writeDirty(repo);
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
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
    expect(decision.kind).toBe("block");
    expect(decision.reason).toContain("ESCALATED");
    expect((await state.load()).escalation_reason).toBe("cost-cap");
    expect(existsSync(join(repo, ".reviewgate", "ESCALATION.md"))).toBe(true);
  });

  it("does NOT escalate cost-cap when costCapUsd is 0 (OAuth default — disabled)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQNOCAP");
    await state.update((cur) => ({ ...cur, cost_usd_so_far: 99 }));
    writeDirty(repo);
    const cfg = { ...defaultConfig, loop: { ...defaultConfig.loop, costCapUsd: 0 } };
    const driver = new LoopDriver({
      repoRoot: repo,
      config: cfg,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: cfg,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: DOC_DIFF,
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    expect((await state.load()).escalation_reason ?? "").not.toBe("cost-cap");
    expect(decision.kind).toBe("allow_stop"); // doc-only diff PASSes; cost-cap disabled
  });
});

describe("LoopDriver softPassPolicy", () => {
  const SOFT_SUMMARY: RunSummary = {
    verdict: "SOFT-PASS",
    source: "panel",
    counts: { critical: 0, warn: 1, info: 0 },
    cost_usd: 0,
    duration_ms: 1,
    demoted: 0,
    signatures: ["sig-w1"],
    providers: [],
  };
  const SOFT_RESULT: IterationResult = {
    verdict: "SOFT-PASS",
    costUsd: 0,
    durationMs: 1,
    signaturesThisIter: ["sig-w1"],
    summary: SOFT_SUMMARY,
  };
  const softOrch = { runIteration: async () => SOFT_RESULT };

  function softDriver(repo: string, state: StateStore, policy: "allow" | "block" | "ask-once") {
    return new LoopDriver({
      repoRoot: repo,
      config: { ...defaultConfig, loop: { ...defaultConfig.loop, softPassPolicy: policy } },
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: softOrch,
      stopHookActive: false,
    });
  }

  it("allow: SOFT-PASS opens the gate (allow_stop) and re-arms", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQSOFTA");
    writeDirty(repo);
    const decision = await softDriver(repo, state, "allow").run();
    expect(decision.kind).toBe("allow_stop");
    expect(existsSync(dirtyFlagPath(repo))).toBe(false);
    expect((await state.load()).iteration).toBe(0);
  });

  it("block: SOFT-PASS blocks the turn, keeps the dirty flag, advances iteration", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQSOFTB");
    writeDirty(repo);
    const decision = await softDriver(repo, state, "block").run();
    expect(decision.kind).toBe("block");
    expect(decision.reason).toContain("GATE CLOSED");
    expect(existsSync(dirtyFlagPath(repo))).toBe(true);
    expect((await state.load()).iteration).toBe(1);
  });

  it("ask-once: SOFT-PASS blocks ONCE, deletes dirty flag (re-stop allows), re-arms", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQSOFTC");
    writeDirty(repo);
    const decision = await softDriver(repo, state, "ask-once").run();
    expect(decision.kind).toBe("block");
    expect(decision.reason).toContain("SOFT-PASS");
    expect(existsSync(dirtyFlagPath(repo))).toBe(false);
    expect((await state.load()).iteration).toBe(0);
  });
});

describe("LoopDriver convergence grace vs confirmed-FP accumulation", () => {
  it("does NOT grant the convergence grace past the iter-cap when confirmed FPs are accumulating", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQCONVFP");
    writeDirty(repo);
    // At the cap (iteration=3=maxIter) with a finding-count down-tick (3→2) that
    // WOULD normally grant the convergence grace (continue past the cap). But the
    // FPs are in the EARLIER iteration (fp_rejects_history[0]=2), so real counts
    // are: prev=(3−2)=1, latest=(2−0)=2 → real count is RISING → not converging →
    // escalate. This tests the FP-discounted predicate: total goes down but the
    // discount reveals the real count is FP-driven and not actually improving.
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [
        ["a", "b", "c"],
        ["a", "b"],
      ],
      fp_rejects_history: [2, 0], // 2 FPs in iter-1, none in iter-2
      cumulative_fp_rejects: 2,
      fp_counted_through_iter: 2,
    }));
    const config = {
      ...defaultConfig,
      // fpStreakThreshold high so the FP-streak breaker itself does NOT fire — this
      // isolates the convergence-grace behaviour.
      loop: { ...defaultConfig.loop, maxIterations: 3, fpStreakThreshold: 10 },
    };
    let ran = false;
    const stub = {
      runIteration: async () => {
        ran = true;
        return {
          verdict: "PASS" as const,
          costUsd: 0,
          durationMs: 1,
          signaturesThisIter: [],
          summary: {
            verdict: "PASS",
            source: "panel",
            counts: { critical: 0, warn: 0, info: 0 },
            cost_usd: 0,
            duration_ms: 1,
            demoted: 0,
            signatures: [],
            providers: [],
          } as RunSummary,
        };
      },
    };
    const decision = await new LoopDriver({
      repoRoot: repo,
      config,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();
    expect(decision.reason).toContain("ESCALATED");
    expect((await state.load()).escalation_reason).toBe("max-iterations");
    expect(ran).toBe(false); // escalated BEFORE running another (wasteful) iteration
  });

  it("still grants the convergence grace when the cycle is clean (no confirmed FPs)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQCONVOK");
    writeDirty(repo);
    // Same down-tick, but cumulative_fp_rejects=0 → genuine convergence → the grace
    // applies, so the gate runs another iteration rather than escalating at the cap.
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [
        ["a", "b", "c"],
        ["a", "b"],
      ],
      cumulative_fp_rejects: 0,
      fp_counted_through_iter: 2,
    }));
    const config = {
      ...defaultConfig,
      loop: { ...defaultConfig.loop, maxIterations: 3, fpStreakThreshold: 10 },
    };
    let ran = false;
    const stub = {
      runIteration: async () => {
        ran = true;
        return {
          verdict: "PASS" as const,
          costUsd: 0,
          durationMs: 1,
          signaturesThisIter: [],
          summary: {
            verdict: "PASS",
            source: "panel",
            counts: { critical: 0, warn: 0, info: 0 },
            cost_usd: 0,
            duration_ms: 1,
            demoted: 0,
            signatures: [],
            providers: [],
          } as RunSummary,
        };
      },
    };
    const decision = await new LoopDriver({
      repoRoot: repo,
      config,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();
    expect(ran).toBe(true); // grace applied → another iteration ran
    expect(decision.reason).not.toContain("ESCALATED");
  });

  // --- PASS/SOFT-PASS clarity in the Stop-hook reason ---
  describe("Stop-hook reason: coverage + SOFT-PASS clarity", () => {
    const makeSummary = (
      verdict: "PASS" | "SOFT-PASS",
      providers: { provider: string; runs: number; errors: number; findings: number }[],
      warn = verdict === "SOFT-PASS" ? 1 : 0,
    ): RunSummary => ({
      verdict,
      source: "panel",
      counts: { critical: 0, warn, info: 0 },
      cost_usd: 0,
      duration_ms: 1,
      demoted: 0,
      signatures: warn > 0 ? ["sig-w1"] : [],
      providers: providers.map((p) => ({
        ...p,
        personas: ["security"],
        demoted: 0,
        cost_usd: 0,
        duration_ms: 1,
      })) as RunSummary["providers"],
    });

    const stubOrch = (summary: RunSummary, verdict: "PASS" | "SOFT-PASS") => ({
      runIteration: async () => ({
        verdict: verdict as "PASS" | "SOFT-PASS",
        costUsd: 0,
        durationMs: 1,
        signaturesThisIter: summary.signatures,
        summary,
      }),
    });

    async function decide(summary: RunSummary, verdict: "PASS" | "SOFT-PASS") {
      const repo = fakeRepo();
      const state = new StateStore(repo);
      await state.initialise("01HXQCOV");
      writeDirty(repo);
      return new LoopDriver({
        repoRoot: repo,
        config: defaultConfig,
        state,
        audit: new AuditLogger(auditDir(repo)),
        orchestrator: stubOrch(summary, verdict),
        stopHookActive: false,
      }).run();
    }

    it("PASS with full coverage stays terse with 🟢", async () => {
      const s = makeSummary("PASS", [
        { provider: "codex", runs: 1, errors: 0, findings: 0 },
        { provider: "claude-code", runs: 1, errors: 0, findings: 0 },
      ]);
      const d = await decide(s, "PASS");
      expect(d.kind).toBe("allow_stop");
      expect(d.reason).toContain("🟢");
      expect(d.reason).toContain("PASS");
      expect(d.reason).not.toContain("reduced coverage");
    });

    it("PASS with reduced coverage surfaces the gap (degraded reviewer note)", async () => {
      const s = makeSummary("PASS", [
        { provider: "codex", runs: 1, errors: 0, findings: 0 },
        { provider: "claude-code", runs: 1, errors: 1, findings: 0 }, // timed out / errored
      ]);
      const d = await decide(s, "PASS");
      expect(d.kind).toBe("allow_stop");
      expect(d.reason).toContain("reduced coverage");
      expect(d.reason).toContain("1 of 2"); // "1 of 2 reviewer did not complete"
    });

    it("SOFT-PASS uses 🟡 (visual distinction from PASS) in the lean path", async () => {
      const s = makeSummary("SOFT-PASS", [{ provider: "codex", runs: 1, errors: 0, findings: 1 }]);
      const d = await decide(s, "SOFT-PASS");
      expect(d.kind).toBe("allow_stop");
      expect(d.reason).toContain("🟡");
      expect(d.reason).toContain("SOFT-PASS");
      expect(d.reason).toContain("WARN"); // surfaces the warn count, the SOFT-PASS reason
    });

    it("SOFT-PASS with reduced coverage surfaces BOTH the warns and the coverage note", async () => {
      const s = makeSummary("SOFT-PASS", [
        { provider: "codex", runs: 1, errors: 0, findings: 1 },
        { provider: "gemini", runs: 1, errors: 1, findings: 0 },
      ]);
      const d = await decide(s, "SOFT-PASS");
      expect(d.reason).toContain("SOFT-PASS");
      expect(d.reason).toContain("WARN");
      expect(d.reason).toContain("reduced coverage");
    });
  });

  // --- ERROR-path Stop-hook clarity (which reviewer errored, how long) ---
  describe("Stop-hook reason: ERROR breakdown", () => {
    const errSummary = (
      providers: { provider: string; errors: number; duration_ms: number }[],
    ): RunSummary => ({
      verdict: "ERROR",
      source: "panel",
      counts: { critical: 0, warn: 0, info: 0 },
      cost_usd: 0,
      duration_ms: providers.reduce((a, p) => a + p.duration_ms, 0),
      demoted: 0,
      signatures: [],
      providers: providers.map((p) => ({
        provider: p.provider,
        personas: ["security"],
        runs: 1,
        errors: p.errors,
        findings: 0,
        demoted: 0,
        cost_usd: 0,
        duration_ms: p.duration_ms,
      })) as RunSummary["providers"],
    });

    const errOrch = (summary: RunSummary) => ({
      runIteration: async () => ({
        verdict: "ERROR" as const,
        costUsd: 0,
        durationMs: summary.duration_ms,
        signaturesThisIter: [] as string[],
        summary,
      }),
    });

    async function errDecide(summary: RunSummary) {
      const repo = fakeRepo();
      const state = new StateStore(repo);
      await state.initialise("01HXQERR");
      writeDirty(repo);
      return new LoopDriver({
        repoRoot: repo,
        config: defaultConfig,
        state,
        audit: new AuditLogger(auditDir(repo)),
        orchestrator: errOrch(summary),
        stopHookActive: false,
      }).run();
    }

    it("single errored reviewer: surfaces provider name + duration so agent can diagnose", async () => {
      // Real shoal case: claude-code-security timed out at 300s. The old message
      // said only "reviewer error" → agent misdiagnosed as "failing to start".
      const s = errSummary([{ provider: "claude-code", errors: 1, duration_ms: 300_019 }]);
      const d = await errDecide(s);
      expect(d.kind).toBe("block");
      expect(d.reason).toContain("🔴");
      expect(d.reason).toContain("claude-code");
      expect(d.reason).toContain("300.0s"); // duration tells timeout-vs-instant-error
      expect(d.reason).toContain("0 of 1");
      expect(d.reason).toContain("pending.md"); // points at the status_detail
    });

    it("multiple errored reviewers: lists each with its own duration", async () => {
      const s = errSummary([
        { provider: "claude-code", errors: 1, duration_ms: 300_000 },
        { provider: "gemini", errors: 1, duration_ms: 5_200 },
      ]);
      const d = await errDecide(s);
      expect(d.reason).toContain("claude-code");
      expect(d.reason).toContain("300.0s");
      expect(d.reason).toContain("gemini");
      expect(d.reason).toContain("5.2s");
      expect(d.reason).toContain("0 of 2");
    });

    it("no providers ran at all: honest 'no reviewer ran' message", async () => {
      const s = errSummary([]);
      const d = await errDecide(s);
      expect(d.kind).toBe("block");
      expect(d.reason).toContain("no reviewer ran");
    });
  });
});

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
    const cfg = {
      ...defaultConfig,
      loop: { ...defaultConfig.loop, maxIterations: 3, stuckThreshold: 99 },
    };
    const driver = new LoopDriver({
      repoRoot: repo,
      config: cfg,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: cfg,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: "",
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    const escMd = existsSync(join(repo, ".reviewgate", "ESCALATION.md"))
      ? readFileSync(join(repo, ".reviewgate", "ESCALATION.md"), "utf8")
      : "";
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

  it("no note when a configured reviewer's cooldown has expired", async () => {
    // codex IS a configured reviewer, but its cooldown reset_at is in the PAST →
    // activeUntil() returns null → the panel was not actually degraded → no note.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQDEGR");
    await state.update((cur) => ({ ...cur, iteration: 3, signature_history: [["a"], ["a", "b"]] }));
    new QuotaCooldownStore(repo).record(
      "codex",
      new Date(Date.now() - 3_600_000).toISOString(),
      new Date(),
    );
    writeDirty(repo);
    const cfg = {
      ...defaultConfig,
      loop: { ...defaultConfig.loop, maxIterations: 3, stuckThreshold: 99 },
    };
    const driver = new LoopDriver({
      repoRoot: repo,
      config: cfg,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: cfg,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: "",
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    const escMd = existsSync(join(repo, ".reviewgate", "ESCALATION.md"))
      ? readFileSync(join(repo, ".reviewgate", "ESCALATION.md"), "utf8")
      : "";
    expect(decision.reason).not.toContain("degraded panel");
    expect(escMd).not.toContain("Quota-degraded panel");
  });
});
