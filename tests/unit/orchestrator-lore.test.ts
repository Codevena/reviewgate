// tests/unit/orchestrator-lore.test.ts
//
// Task 6 (Lore v1) — orchestrator integration: reviewer injection, cache-key
// folding, verdict-neutral finding emission, and pending.md banners. See
// docs/superpowers/specs/2026-07-09-lore-design.md ("Retrieval + injection",
// "Staleness + reminder", "Canon guard", "Failure behavior") and
// docs/superpowers/plans/2026-07-09-lore-v1.md (Task 6).
//
// Stub + Orchestrator-construction pattern from orchestrator-checks.test.ts;
// the >30-line diff fixture (small-diff triage cap zeroes cooldown/timing
// mechanics) from orchestrator-budget-clamp.test.ts.
import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "../../src/config/define-config.ts";
import { appendApproval } from "../../src/core/lore/approvals.ts";
import { computeVerifiedTree } from "../../src/core/lore/staleness.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import { pendingJsonPath, pendingMdPath, planReviewJsonPath } from "../../src/utils/paths.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function sh(repo: string, cmd: string): void {
  execSync(cmd, { cwd: repo, env: GIT_ENV, stdio: ["ignore", "pipe", "ignore"] });
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rg-orch-lore-"));
  sh(repo, "git init -q -b main");
  return repo;
}

function commitAll(repo: string): void {
  sh(repo, "git add -A && git commit -q -m base");
}

function loreDirOf(repo: string): string {
  const dir = join(repo, ".reviewgate", "lore");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLoreEntry(
  repo: string,
  opts: {
    id: string;
    status: "draft" | "canon";
    anchors: string[];
    verifiedTree: string;
    body: string;
    verifiedAt?: string;
  },
): void {
  const anchorsYaml = opts.anchors.map((a) => `  - "${a}"`).join("\n");
  const content = [
    "---",
    "schema: reviewgate.lore.v1",
    `id: ${opts.id}`,
    `status: ${opts.status}`,
    "anchors:",
    anchorsYaml,
    `verified_at: ${opts.verifiedAt ?? "2026-07-01"}`,
    `verified_tree: "${opts.verifiedTree}"`,
    "---",
    opts.body,
    "",
  ].join("\n");
  writeFileSync(join(loreDirOf(repo), `${opts.id}.md`), content);
}

function writeBroadFiles(repo: string, count = 205): void {
  const dir = join(repo, "broad");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(dir, `f${i}.ts`), "x");
}

// >30 changed lines: at/below the triage small-diff threshold, cooldown/timing
// mechanics are zeroed out — this fixture (from orchestrator-budget-clamp.test.ts)
// avoids that cap.
const added = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join("\n");
const diff = `diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1,41 @@\n-a\n${added}\n`;

function zeroFindingsStub(state: { calls: number; prompts: string[] }): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      state.calls++;
      state.prompts.push(readFileSync(inp.promptFile, "utf8"));
      return {
        reviewerId: inp.reviewerId,
        verdict: "PASS",
        findings: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

function criticalFindingStub(state: { calls: number }): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      state.calls++;
      const finding: Finding = {
        id: "F-1",
        signature: "sig-critical-1",
        severity: "CRITICAL",
        category: "correctness",
        rule_id: "test-critical-rule",
        file: "foo.ts",
        line_start: 1,
        line_end: 1,
        message: "a real critical finding",
        details: "details for the critical finding",
        reviewer: { provider: "codex", model: "m", persona: "security" },
        confidence: 1,
        consensus: "singleton",
      };
      return {
        reviewerId: inp.reviewerId,
        verdict: "FAIL",
        findings: [finding],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 1,
        rawEventsPath: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

function warnFindingStub(state: { calls: number }): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      state.calls++;
      const finding: Finding = {
        id: "F-1",
        signature: "sig-warn-1",
        severity: "WARN",
        category: "correctness",
        rule_id: "test-warn-rule",
        file: "foo.ts",
        line_start: 1,
        line_end: 1,
        message: "a real warn finding",
        details: "details for the warn finding",
        reviewer: { provider: "codex", model: "m", persona: "security" },
        confidence: 1,
        consensus: "singleton",
      };
      return {
        reviewerId: inp.reviewerId,
        verdict: "FAIL",
        findings: [finding],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 1,
        rawEventsPath: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

function orch(
  repo: string,
  adapter: ProviderAdapter,
  loreConfig: Record<string, unknown> = { enabled: true },
) {
  return new Orchestrator({
    repoRoot: repo,
    config: defineConfig({
      phases: {
        review: { reviewers: [{ provider: "codex", persona: "security" }] },
        triage: null,
        lore: loreConfig as never,
      },
    }),
    adapters: { codex: adapter },
    sandboxMode: "off",
    hostTier: "opus",
    diff,
    reasonOnFailEnabled: true,
  });
}

// M-1: same shape as orch() but reportMode:"one-shot" (review-plan path) — lore
// must skip entirely (see the loreCfg gating in orchestrator.ts).
function orchOneShot(
  repo: string,
  adapter: ProviderAdapter,
  loreConfig: Record<string, unknown> = { enabled: true },
) {
  return new Orchestrator({
    repoRoot: repo,
    config: defineConfig({
      phases: {
        review: { reviewers: [{ provider: "codex", persona: "security" }] },
        triage: null,
        lore: loreConfig as never,
      },
    }),
    adapters: { codex: adapter },
    sandboxMode: "off",
    hostTier: "opus",
    diff,
    reasonOnFailEnabled: true,
    reportMode: "one-shot",
  });
}

// biome-ignore lint/suspicious/noExplicitAny: reading raw pending.json in tests
function loreFindingsFrom(pending: any): any[] {
  return (pending.findings ?? []).filter((f: { lore?: string }) => f.lore !== undefined);
}

describe("orchestrator lore integration", () => {
  it("(a) an approved, anchored canon entry's header + body reach the reviewer prompt", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "foo.ts"), "original content");
    const tree = computeVerifiedTree(repo, ["foo.ts"]);
    writeLoreEntry(repo, {
      id: "foo-invariant",
      status: "canon",
      anchors: ["foo.ts"],
      verifiedTree: tree,
      body: "Foo must stay under the concurrency limit. Why: a 2026 incident took prod down.",
    });
    appendApproval(repo, "foo-invariant", "test", new Date());
    commitAll(repo);

    const state = { calls: 0, prompts: [] as string[] };
    const res = await orch(repo, zeroFindingsStub(state)).runIteration({ runId: "R", iter: 1 });

    expect(res.verdict).toBe("PASS");
    expect(state.calls).toBe(1);
    expect(state.prompts[0]).toContain("Project lore");
    expect(state.prompts[0]).toContain("foo-invariant");
    expect(state.prompts[0]).toContain("concurrency limit");
  });

  it("(b) draft, unapproved-canon, and broad-anchor entries do NOT reach the prompt", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "foo.ts"), "original content");
    const tree = computeVerifiedTree(repo, ["foo.ts"]);

    writeLoreEntry(repo, {
      id: "draft-entry",
      status: "draft",
      anchors: ["foo.ts"],
      verifiedTree: tree,
      body: "DRAFT_MARKER_TEXT must never leak into the prompt from an unapproved draft entry.",
    });
    writeLoreEntry(repo, {
      id: "unapproved-entry",
      status: "canon",
      anchors: ["foo.ts"],
      verifiedTree: tree,
      body: "UNAPPROVED_MARKER_TEXT must never leak — there is no approvals ledger line for it.",
    });
    writeBroadFiles(repo);
    writeLoreEntry(repo, {
      id: "broad-entry",
      status: "canon",
      anchors: ["foo.ts", "broad/**"],
      verifiedTree: "irrelevant",
      body: "BROAD_MARKER_TEXT must never leak — its anchors match more than 200 files.",
    });
    appendApproval(repo, "broad-entry", "test", new Date());
    commitAll(repo);

    const state = { calls: 0, prompts: [] as string[] };
    const res = await orch(repo, zeroFindingsStub(state)).runIteration({ runId: "R", iter: 1 });

    expect(res.verdict).toBe("PASS");
    const prompt = state.prompts[0] ?? "";
    expect(prompt).not.toContain("DRAFT_MARKER_TEXT");
    expect(prompt).not.toContain("UNAPPROVED_MARKER_TEXT");
    expect(prompt).not.toContain("BROAD_MARKER_TEXT");
  }, 15000);

  it("(c) editing a lore entry's body flips the review cache key (re-invokes the panel)", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "foo.ts"), "original content");
    const tree = computeVerifiedTree(repo, ["foo.ts"]);
    writeLoreEntry(repo, {
      id: "cache-entry",
      status: "canon",
      anchors: ["foo.ts"],
      verifiedTree: tree,
      body: "Initial body text that is long enough to pass the forty character minimum.",
    });
    appendApproval(repo, "cache-entry", "test", new Date());
    commitAll(repo);

    const state = { calls: 0, prompts: [] as string[] };

    const r1 = await orch(repo, zeroFindingsStub(state)).runIteration({ runId: "R", iter: 1 });
    expect(r1.verdict).toBe("PASS");
    expect(state.calls).toBe(1);

    // Control: an identical run is a cache HIT (panel NOT re-invoked).
    const rHit = await orch(repo, zeroFindingsStub(state)).runIteration({ runId: "R", iter: 2 });
    expect(rHit.verdict).toBe("PASS");
    expect(state.calls).toBe(1);

    // Edit only the lore entry's BODY (anchors/verified_tree unchanged, so
    // staleness is untouched) — the rendered lore block changes, which must
    // invalidate the cache key.
    writeLoreEntry(repo, {
      id: "cache-entry",
      status: "canon",
      anchors: ["foo.ts"],
      verifiedTree: tree,
      body: "EDITED body text, different from before and still long enough to pass.",
    });
    const r2 = await orch(repo, zeroFindingsStub(state)).runIteration({ runId: "R", iter: 3 });
    expect(r2.verdict).toBe("PASS");
    expect(state.calls).toBe(2);
  });

  it("(d) a stale, diff-touched canon entry + an allowed budget emits exactly one reminder; verdict stays PASS", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "foo.ts"), "content v1");
    writeLoreEntry(repo, {
      id: "stale-entry",
      status: "canon",
      anchors: ["foo.ts"],
      verifiedTree: "0".repeat(64), // deliberately wrong → stale
      body: "This entry documents an invariant that is now stale relative to foo.ts's content.",
    });
    appendApproval(repo, "stale-entry", "test", new Date());
    commitAll(repo);

    const state = { calls: 0, prompts: [] as string[] };
    const res = await orch(repo, zeroFindingsStub(state)).runIteration({
      runId: "R",
      iter: 1,
      loreReminderBudget: { allowed: true, cooldownIds: [] },
    });

    expect(res.verdict).toBe("PASS");
    const pending = JSON.parse(readFileSync(pendingJsonPath(repo), "utf8"));
    const loreFindings = loreFindingsFrom(pending);
    expect(loreFindings).toHaveLength(1);
    expect(loreFindings[0].lore).toBe("reminder");
    expect(loreFindings[0].severity).toBe("INFO");
    expect(loreFindings[0].file).toBe(".reviewgate/lore/stale-entry.md");
  });

  it("(Task 7) a claimed-fixed-but-still-stale entry's reminder message notes the self-reported-fix bypass", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "foo.ts"), "content v1");
    writeLoreEntry(repo, {
      id: "stale-entry",
      status: "canon",
      anchors: ["foo.ts"],
      verifiedTree: "0".repeat(64), // deliberately wrong → stale
      body: "This entry documents an invariant that is now stale relative to foo.ts's content.",
    });
    appendApproval(repo, "stale-entry", "test", new Date());
    commitAll(repo);

    const state = { calls: 0, prompts: [] as string[] };
    const res = await orch(repo, zeroFindingsStub(state)).runIteration({
      runId: "R",
      iter: 1,
      loreReminderBudget: { allowed: true, cooldownIds: [], claimedFixedStaleIds: ["stale-entry"] },
    });

    expect(res.verdict).toBe("PASS");
    const pending = JSON.parse(readFileSync(pendingJsonPath(repo), "utf8"));
    const loreFindings = loreFindingsFrom(pending).filter((f) => f.lore === "reminder");
    expect(loreFindings).toHaveLength(1);
    expect(loreFindings[0].message).toContain("previously marked this fixed");
    expect(loreFindings[0].details).toContain("STILL don't match verified_tree");
  });

  it("(Task 7) a claimed-fixed-but-still-stale candidate is preferred over a non-claimed stale entry that would otherwise win the tiebreak", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "foo.ts"), "content v1");
    // Older verified_at → would normally win the "oldest verified_at" tiebreak
    // (both anchor the SAME single diff file, so matched-file counts tie).
    writeLoreEntry(repo, {
      id: "alpha-entry",
      status: "canon",
      anchors: ["foo.ts"],
      verifiedTree: "0".repeat(64),
      verifiedAt: "2020-01-01",
      body: "This entry documents an invariant that is now stale relative to foo.ts's content.",
    });
    writeLoreEntry(repo, {
      id: "stale-entry",
      status: "canon",
      anchors: ["foo.ts"],
      verifiedTree: "1".repeat(64),
      verifiedAt: "2025-01-01", // newer — would normally LOSE the tiebreak
      body: "This entry documents an invariant that is now stale relative to foo.ts's content.",
    });
    appendApproval(repo, "alpha-entry", "test", new Date());
    appendApproval(repo, "stale-entry", "test", new Date());
    commitAll(repo);

    const state = { calls: 0, prompts: [] as string[] };
    const res = await orch(repo, zeroFindingsStub(state)).runIteration({
      runId: "R",
      iter: 1,
      loreReminderBudget: { allowed: true, cooldownIds: [], claimedFixedStaleIds: ["stale-entry"] },
    });

    expect(res.verdict).toBe("PASS");
    const pending = JSON.parse(readFileSync(pendingJsonPath(repo), "utf8"));
    const loreFindings = loreFindingsFrom(pending).filter((f) => f.lore === "reminder");
    expect(loreFindings).toHaveLength(1);
    expect(loreFindings[0].file).toBe(".reviewgate/lore/stale-entry.md");
  });

  it("(e) allowed:false suppresses the reminder", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "foo.ts"), "content v1");
    writeLoreEntry(repo, {
      id: "stale-entry",
      status: "canon",
      anchors: ["foo.ts"],
      verifiedTree: "0".repeat(64),
      body: "This entry documents an invariant that is now stale relative to foo.ts's content.",
    });
    appendApproval(repo, "stale-entry", "test", new Date());
    commitAll(repo);

    const state = { calls: 0, prompts: [] as string[] };
    const res = await orch(repo, zeroFindingsStub(state)).runIteration({
      runId: "R",
      iter: 1,
      loreReminderBudget: { allowed: false, cooldownIds: [] },
    });

    expect(res.verdict).toBe("PASS");
    const pending = JSON.parse(readFileSync(pendingJsonPath(repo), "utf8"));
    expect(loreFindingsFrom(pending).filter((f) => f.lore === "reminder")).toHaveLength(0);
  });

  it("(e) an id present in cooldownIds suppresses the reminder", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "foo.ts"), "content v1");
    writeLoreEntry(repo, {
      id: "stale-entry",
      status: "canon",
      anchors: ["foo.ts"],
      verifiedTree: "0".repeat(64),
      body: "This entry documents an invariant that is now stale relative to foo.ts's content.",
    });
    appendApproval(repo, "stale-entry", "test", new Date());
    commitAll(repo);

    const state = { calls: 0, prompts: [] as string[] };
    const res = await orch(repo, zeroFindingsStub(state)).runIteration({
      runId: "R",
      iter: 1,
      loreReminderBudget: { allowed: true, cooldownIds: ["stale-entry"] },
    });

    expect(res.verdict).toBe("PASS");
    const pending = JSON.parse(readFileSync(pendingJsonPath(repo), "utf8"));
    expect(loreFindingsFrom(pending).filter((f) => f.lore === "reminder")).toHaveLength(0);
  });

  it("(d) absent loreReminderBudget defaults to allowed:false (fail quiet — no reminder)", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "foo.ts"), "content v1");
    writeLoreEntry(repo, {
      id: "stale-entry",
      status: "canon",
      anchors: ["foo.ts"],
      verifiedTree: "0".repeat(64),
      body: "This entry documents an invariant that is now stale relative to foo.ts's content.",
    });
    appendApproval(repo, "stale-entry", "test", new Date());
    commitAll(repo);

    const state = { calls: 0, prompts: [] as string[] };
    // No loreReminderBudget passed at all (Task 7 not wired up yet).
    const res = await orch(repo, zeroFindingsStub(state)).runIteration({ runId: "R", iter: 1 });

    expect(res.verdict).toBe("PASS");
    const pending = JSON.parse(readFileSync(pendingJsonPath(repo), "utf8"));
    expect(loreFindingsFrom(pending).filter((f) => f.lore === "reminder")).toHaveLength(0);
  });

  it("(f) an unapproved born-canon entry emits a canon-promotion finding regardless of budget", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "foo.ts"), "content");
    commitAll(repo); // baseline WITHOUT the lore entry

    writeLoreEntry(repo, {
      id: "born-canon-entry",
      status: "canon",
      anchors: ["nonexistent-file.ts"], // zero-match: isolate this test to the guard only
      verifiedTree: "irrelevant",
      body: "This entry is born directly as canon without prior approval, which the guard must catch.",
    });
    // Left uncommitted + unapproved on purpose.

    const state = { calls: 0, prompts: [] as string[] };
    const res = await orch(repo, zeroFindingsStub(state)).runIteration({
      runId: "R",
      iter: 1,
      loreReminderBudget: { allowed: false, cooldownIds: [] },
    });

    expect(res.verdict).toBe("PASS");
    const pending = JSON.parse(readFileSync(pendingJsonPath(repo), "utf8"));
    const promos = loreFindingsFrom(pending).filter((f) => f.lore === "canon-promotion");
    expect(promos).toHaveLength(1);
    expect(promos[0].file).toBe(".reviewgate/lore/born-canon-entry.md");
    expect(promos[0].severity).toBe("INFO");
  });

  it("(g) a CRITICAL panel finding suppresses the reminder but NOT the canon-promotion guard", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "foo.ts"), "content v1");
    writeLoreEntry(repo, {
      id: "stale-entry",
      status: "canon",
      anchors: ["foo.ts"],
      verifiedTree: "0".repeat(64),
      body: "This entry documents an invariant that is now stale relative to foo.ts's content.",
    });
    appendApproval(repo, "stale-entry", "test", new Date());
    commitAll(repo);

    // Unapproved born-canon entry, added AFTER the base commit.
    writeLoreEntry(repo, {
      id: "promo-entry",
      status: "canon",
      anchors: ["zzz-nomatch.ts"],
      verifiedTree: "irrelevant",
      body: "This entry is born as canon without approval — the guard must fire even under a CRITICAL.",
    });

    const state = { calls: 0 };
    const res = await orch(repo, criticalFindingStub(state)).runIteration({
      runId: "R",
      iter: 1,
      loreReminderBudget: { allowed: true, cooldownIds: [] },
    });

    expect(res.verdict).not.toBe("PASS");
    const pending = JSON.parse(readFileSync(pendingJsonPath(repo), "utf8"));
    const lore = loreFindingsFrom(pending);
    expect(lore.filter((f) => f.lore === "reminder")).toHaveLength(0);
    expect(lore.filter((f) => f.lore === "canon-promotion")).toHaveLength(1);
  });

  it("(h) invalid and broad lore entries produce a pending.md banner naming them", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "foo.ts"), "content");
    writeFileSync(
      join(loreDirOf(repo), "broken-entry.md"),
      "not frontmatter at all, so this file fails to parse cleanly and stays invalid",
    );
    writeBroadFiles(repo);
    writeLoreEntry(repo, {
      id: "too-broad-entry",
      status: "canon",
      anchors: ["broad/**"],
      verifiedTree: "irrelevant",
      body: "This entry's anchor matches far more than two hundred files in the repo tree.",
    });
    appendApproval(repo, "too-broad-entry", "test", new Date());
    commitAll(repo);

    const state = { calls: 0, prompts: [] as string[] };
    const res = await orch(repo, zeroFindingsStub(state)).runIteration({ runId: "R", iter: 1 });

    expect(res.verdict).toBe("PASS");
    const md = readFileSync(pendingMdPath(repo), "utf8");
    expect(md).toContain("broken-entry.md");
    expect(md).toContain("too-broad-entry");
  }, 15000);

  it("phases.lore: null (off) never touches the prompt or emits lore findings", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "foo.ts"), "original content");
    const tree = computeVerifiedTree(repo, ["foo.ts"]);
    writeLoreEntry(repo, {
      id: "foo-invariant",
      status: "canon",
      anchors: ["foo.ts"],
      verifiedTree: tree,
      body: "Foo must stay under the concurrency limit. Why: a 2026 incident took prod down.",
    });
    appendApproval(repo, "foo-invariant", "test", new Date());
    commitAll(repo);

    const state = { calls: 0, prompts: [] as string[] };
    const res = await orch(repo, zeroFindingsStub(state), null as never).runIteration({
      runId: "R",
      iter: 1,
      loreReminderBudget: { allowed: true, cooldownIds: [] },
    });

    expect(res.verdict).toBe("PASS");
    expect(state.prompts[0] ?? "").not.toContain("Project lore");
    const pending = JSON.parse(readFileSync(pendingJsonPath(repo), "utf8"));
    expect(loreFindingsFrom(pending)).toHaveLength(0);
  });

  it("(I-1) a born-canon promotion appearing AFTER the cache was populated invalidates the byte cache and re-fires the panel + finding", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "foo.ts"), "original content");
    commitAll(repo); // baseline WITHOUT any lore dir/entry

    const state = { calls: 0, prompts: [] as string[] };

    // Iteration 1: clean run, no lore entries at all — populates the byte cache
    // AND (since this PASS is earned at full scope with zero lore findings)
    // the pass ledger.
    const r1 = await orch(repo, zeroFindingsStub(state)).runIteration({ runId: "R", iter: 1 });
    expect(r1.verdict).toBe("PASS");
    expect(state.calls).toBe(1);

    // Introduce a born-canon lore entry AFTER the cache was populated, WITHOUT
    // touching the reviewed CODE diff at all — the `diff` fed to runIteration is
    // the exact same 40-line fixture both times (.reviewgate/ is excluded from
    // the real diff anyway, so this mirrors production: a lore-only change never
    // appears in the reviewed diff bytes). Left deliberately UNCOMMITTED and
    // UNAPPROVED — a canon-promotion is BY DEFINITION unapproved (test (f)/(g)
    // confirm the guard fires on this exact shape in isolation).
    writeLoreEntry(repo, {
      id: "surprise-canon",
      status: "canon",
      anchors: ["nonexistent-file.ts"], // zero-match: isolates this test to the guard only
      verifiedTree: "irrelevant",
      body: "This entry is born directly as canon without approval — the promotion guard must catch it.",
    });

    const r2 = await orch(repo, zeroFindingsStub(state)).runIteration({ runId: "R", iter: 2 });
    expect(r2.verdict).toBe("PASS");
    // The load-bearing assertion: the panel actually re-ran. Without the
    // `lorePromotions` cache-key fold, `loreText` stays "" (an unapproved
    // canon entry is never injected) and the byte/content-cache short-circuit
    // returns findings:[] BEFORE the lore-findings-emission block ever runs —
    // the promotion would be silently swallowed for as long as the code diff
    // keeps hitting cache.
    expect(state.calls).toBe(2);
    const pending = JSON.parse(readFileSync(pendingJsonPath(repo), "utf8"));
    const promos = loreFindingsFrom(pending).filter((f) => f.lore === "canon-promotion");
    expect(promos).toHaveLength(1);
    expect(promos[0].file).toBe(".reviewgate/lore/surprise-canon.md");
  });

  it("(M-1) reportMode:'one-shot' skips lore entirely — no prompt injection, no findings, no loreOutcomes", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "foo.ts"), "content v1");
    writeLoreEntry(repo, {
      id: "stale-entry",
      status: "canon",
      anchors: ["foo.ts"],
      verifiedTree: "0".repeat(64), // deliberately wrong → stale, would normally remind
      body: "This entry documents an invariant that is now stale relative to foo.ts's content.",
    });
    appendApproval(repo, "stale-entry", "test", new Date());
    commitAll(repo);

    const state = { calls: 0, prompts: [] as string[] };
    const res = await orchOneShot(repo, zeroFindingsStub(state)).runIteration({
      runId: "R",
      iter: 1,
      // Budget explicitly allowed — if lore ran, this WOULD produce a reminder.
      loreReminderBudget: { allowed: true, cooldownIds: [] },
    });

    expect(res.verdict).toBe("PASS");
    expect(state.prompts[0] ?? "").not.toContain("Project lore");
    // loreOutcomes must be entirely absent — lore processing never ran this
    // iteration (same contract as phases.lore off/null).
    expect(res.loreOutcomes).toBeUndefined();
    const pending = JSON.parse(readFileSync(planReviewJsonPath(repo), "utf8"));
    expect(loreFindingsFrom(pending)).toHaveLength(0);
  });

  it("(M-2) a lore INFO finding never changes the aggregated verdict or CRITICAL/WARN counts", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "foo.ts"), "content v1");
    writeLoreEntry(repo, {
      id: "stale-entry",
      status: "canon",
      anchors: ["foo.ts"],
      verifiedTree: "0".repeat(64), // deliberately wrong → stale + touched by the diff
      body: "This entry documents an invariant that is now stale relative to foo.ts's content.",
    });
    appendApproval(repo, "stale-entry", "test", new Date());
    commitAll(repo);

    const state = { calls: 0 };
    const res = await orch(repo, warnFindingStub(state)).runIteration({
      runId: "R",
      iter: 1,
      loreReminderBudget: { allowed: true, cooldownIds: [] },
    });

    // A singleton WARN alone yields SOFT-PASS with counts {critical:0, warn:1,
    // info:0} (verified against the panel-only baseline). Adding the lore
    // reminder must reproduce the IDENTICAL verdict and IDENTICAL
    // critical/warn counts — only `info` may move, by exactly the lore
    // finding count.
    expect(res.verdict).toBe("SOFT-PASS");
    const pending = JSON.parse(readFileSync(pendingJsonPath(repo), "utf8"));
    expect(pending.counts.critical).toBe(0);
    expect(pending.counts.warn).toBe(1);
    expect(pending.counts.info).toBe(1);
    const loreFindings = loreFindingsFrom(pending);
    expect(loreFindings).toHaveLength(1);
    expect(loreFindings[0].lore).toBe("reminder");
    expect(loreFindings[0].severity).toBe("INFO");
    // The non-lore (panel) finding is untouched — still exactly the one WARN.
    const nonLore = pending.findings.filter((f: { lore?: string }) => f.lore === undefined);
    expect(nonLore).toHaveLength(1);
    expect(nonLore[0].severity).toBe("WARN");
  });
});
