// tests/unit/orchestrator.test.ts
import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import { ReputationStore } from "../../src/core/reputation/store.ts";
import { CodexAdapter } from "../../src/providers/codex.ts";

const FAKE_CODEX = join(process.cwd(), "tests/fixtures/fake-codex.sh");
const FAKE_CODEX_ERROR = join(process.cwd(), "tests/fixtures/fake-codex-error.sh");

// Fake codex emitting a single WARN finding on the changed line → with a lone
// reviewer the aggregator yields SOFT-PASS (WARN, no consensus to hard-FAIL).
const WARN_CODEX_SCRIPT = `#!/usr/bin/env bash
set -u
LAST_MSG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output-last-message) LAST_MSG="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$LAST_MSG" ] && cat > "$LAST_MSG" <<'JSON'
{"verdict":"FAIL","findings":[{"severity":"WARN","category":"quality","rule_id":"w1","file":"foo.ts","line":1,"message":"warn finding","details":"d","confidence":0.9}]}
JSON
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20,"cached_input_tokens":50}}'
exit 0
`;
const SOFT_DIFF =
  "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;\n";

// Fake codex emitting a single CRITICAL quality finding on the changed line.
// This is NOT a security/correctness category, so reputation demotion applies.
const CRITICAL_QUALITY_CODEX_SCRIPT = `#!/usr/bin/env bash
set -u
LAST_MSG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output-last-message) LAST_MSG="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$LAST_MSG" ] && cat > "$LAST_MSG" <<'JSON'
{"verdict":"FAIL","findings":[{"severity":"CRITICAL","category":"quality","rule_id":"q1","file":"foo.ts","line":1,"message":"critical quality finding","details":"d","confidence":0.9}]}
JSON
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20,"cached_input_tokens":50}}'
exit 0
`;

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-orch-"));
  writeFileSync(join(dir, "foo.ts"), "function compare(a, b) { return a === b; }");
  return dir;
}

describe("Orchestrator", () => {
  it("runs one iteration end-to-end against a fake codex and writes pending.md", async () => {
    const repo = fakeRepo();
    const orch = new Orchestrator({
      repoRoot: repo,
      config: defaultConfig,
      adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-function compare(a, b) { return a == b; }\n+function compare(a, b) { return a === b; }\n",
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "01HXQTEST", iter: 1 });
    expect(result.verdict).toMatch(/PASS|SOFT-PASS|FAIL/);
    expect(existsSync(join(repo, ".reviewgate", "pending.md"))).toBe(true);
    expect(existsSync(join(repo, ".reviewgate", "pending.json"))).toBe(true);
  });

  it("fails CLOSED (ERROR, never PASS) when the reviewer subprocess errors", async () => {
    const repo = fakeRepo();
    const orch = new Orchestrator({
      repoRoot: repo,
      config: defaultConfig,
      adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX_ERROR }) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n",
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "01HXQERR", iter: 1 });
    // A failed reviewer must NOT be reported as PASS — that would silently
    // green-light the turn. It must surface as ERROR and write a FAIL report.
    expect(result.verdict).toBe("ERROR");
    const report = JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8")) as {
      verdict: string;
      reviewers: Array<{ status: string }>;
    };
    expect(report.verdict).toBe("FAIL");
    expect(report.reviewers[0]?.status).toBe("error");
  });

  it("fails CLOSED when a sandbox mode is requested but unavailable in M1", async () => {
    const repo = fakeRepo();
    const orch = new Orchestrator({
      repoRoot: repo,
      config: defaultConfig,
      adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxMode: "strict",
      hostTier: "opus",
      diff: "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n",
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "01HXQSB", iter: 1 });
    // strict/permissive cannot be honored in M1, so the orchestrator must
    // refuse to review rather than silently run the reviewer unisolated.
    expect(result.verdict).toBe("ERROR");
  });
});

describe("Orchestrator SOFT-PASS cache guard (softPassPolicy=block)", () => {
  function warnBin(repo: string): string {
    const p = join(repo, "fake-codex-warn.sh");
    writeFileSync(p, WARN_CODEX_SCRIPT, { mode: 0o755 });
    chmodSync(p, 0o755);
    return p;
  }
  function orchFor(repo: string, policy: "allow" | "block") {
    return new Orchestrator({
      repoRoot: repo,
      config: { ...defaultConfig, loop: { ...defaultConfig.loop, softPassPolicy: policy } },
      adapters: { codex: new CodexAdapter({ binPath: warnBin(repo) }) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: SOFT_DIFF,
      reasonOnFailEnabled: true,
    });
  }

  it("a lone WARN finding yields SOFT-PASS and is cached", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-soft-"));
    writeFileSync(join(repo, "foo.ts"), "const a = 2;\n");
    const r1 = await orchFor(repo, "allow").runIteration({ runId: "01HXQA", iter: 1 });
    expect(r1.verdict).toBe("SOFT-PASS");
    expect(r1.summary.source).toBe("panel");
    // Second identical run under the SAME (allow) policy is served from cache.
    const r2 = await orchFor(repo, "allow").runIteration({ runId: "01HXQA", iter: 2 });
    expect(r2.summary.source).toBe("cache");
  });

  it("does NOT serve a cached SOFT-PASS under softPassPolicy=block (re-runs the panel)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-softblk-"));
    writeFileSync(join(repo, "foo.ts"), "const a = 2;\n");
    // Run 1 (block) caches a SOFT-PASS under the block-policy cache key.
    const r1 = await orchFor(repo, "block").runIteration({ runId: "01HXQB", iter: 1 });
    expect(r1.verdict).toBe("SOFT-PASS");
    expect(r1.summary.source).toBe("panel");
    // Run 2 (block, same diff/config → same cache key): the guard must bypass the
    // cache so pending.json is repopulated with the WARN findings the gate needs.
    const r2 = await orchFor(repo, "block").runIteration({ runId: "01HXQB", iter: 2 });
    expect(r2.summary.source).toBe("panel");
  });
});

describe("Orchestrator reputation demote integration", () => {
  function criticalQualityBin(repo: string): string {
    const p = join(repo, "fake-codex-critical-quality.sh");
    writeFileSync(p, CRITICAL_QUALITY_CODEX_SCRIPT, { mode: 0o755 });
    chmodSync(p, 0o755);
    return p;
  }

  it("demotes a lone CRITICAL quality finding to WARN (SOFT-PASS) when codex is unreliable", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-rep-"));
    writeFileSync(join(repo, "foo.ts"), "const a = 2;\n");

    // Seed reputation: 10 "wrong" outcomes → codex is unreliable
    const store = new ReputationStore(repo);
    await store.record(
      Array.from({ length: 10 }, (_, i) => ({
        reviewerKey: "codex:security",
        outcome: "wrong" as const,
        eid: `w${i}`,
        ts: new Date().toISOString(),
      })),
    );

    const orch = new Orchestrator({
      repoRoot: repo,
      config: {
        ...defaultConfig,
        // Disable cache so the panel always runs
        cache: { ...defaultConfig.cache, enabled: false },
        phases: {
          ...defaultConfig.phases,
          reputation: {
            enabled: true,
            minSamples: 8,
            trustFloor: 0.35,
            halfLifeDays: 45,
            quarantine: { enabled: false, floor: 0.15 },
          },
        },
      },
      adapters: { codex: new CodexAdapter({ binPath: criticalQualityBin(repo) }) },
      sandboxMode: "off",
      hostTier: "opus",
      // Diff touches foo.ts line 1, matching the finding
      diff: SOFT_DIFF,
      reasonOnFailEnabled: true,
    });

    const result = await orch.runIteration({ runId: "01HXQREP1", iter: 1 });
    // The lone CRITICAL quality finding from codex (unreliable) should be demoted
    // to WARN → lone WARN with single reviewer → SOFT-PASS (not FAIL)
    expect(result.verdict).toBe("SOFT-PASS");
  });

  it("quarantines a sub-floor reviewer: skips its run and notes it (panel_note)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-quar-"));
    writeFileSync(join(repo, "foo.ts"), "const a = 2;\n");
    await new ReputationStore(repo).record(
      Array.from({ length: 10 }, (_, i) => ({
        reviewerKey: "codex:security" as const,
        outcome: "wrong" as const,
        eid: `w${i}`,
        ts: new Date().toISOString(),
      })),
    );
    const orch = new Orchestrator({
      repoRoot: repo,
      config: {
        ...defaultConfig,
        cache: { ...defaultConfig.cache, enabled: false },
        phases: {
          ...defaultConfig.phases,
          reputation: {
            enabled: true,
            minSamples: 8,
            trustFloor: 0.35,
            halfLifeDays: 45,
            quarantine: { enabled: true, floor: 0.15 },
          },
        },
      },
      adapters: { codex: new CodexAdapter({ binPath: criticalQualityBin(repo) }) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: SOFT_DIFF,
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "01HXQUAR1", iter: 1 });
    // Only configured reviewer (codex:security) is sub-floor → filtering would empty the panel →
    // FULL panel runs anyway → codex runs → its lone CRITICAL quality finding is still demoted by
    // Slice 1 (codex unreliable) → SOFT-PASS, with a panel_note about quarantine.
    expect(result.verdict).toBe("SOFT-PASS");
    const pending = JSON.parse(readFileSync(join(repo, ".reviewgate/pending.json"), "utf8"));
    expect(pending.panel_note).toContain("ran the full panel");
  });

  it("yields FAIL for a lone CRITICAL quality finding when reputation is disabled", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-rep-nodemo-"));
    writeFileSync(join(repo, "foo.ts"), "const a = 2;\n");

    // Seed reputation (same as above) but disable the reputation phase in config
    const store = new ReputationStore(repo);
    await store.record(
      Array.from({ length: 10 }, (_, i) => ({
        reviewerKey: "codex:security",
        outcome: "wrong" as const,
        eid: `w${i}`,
        ts: new Date().toISOString(),
      })),
    );

    const orch = new Orchestrator({
      repoRoot: repo,
      config: {
        ...defaultConfig,
        cache: { ...defaultConfig.cache, enabled: false },
        phases: {
          ...defaultConfig.phases,
          // Disable reputation so demotion does NOT happen
          reputation: {
            enabled: false,
            minSamples: 8,
            trustFloor: 0.35,
            halfLifeDays: 45,
            quarantine: { enabled: false, floor: 0.15 },
          },
        },
      },
      adapters: { codex: new CodexAdapter({ binPath: criticalQualityBin(repo) }) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: SOFT_DIFF,
      reasonOnFailEnabled: true,
    });

    const result = await orch.runIteration({ runId: "01HXQREP2", iter: 1 });
    // Without reputation demotion, the lone CRITICAL should still FAIL
    expect(result.verdict).toBe("FAIL");
  });
});
