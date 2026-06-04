// tests/unit/triage-matrix.test.ts
import { describe, expect, it } from "bun:test";
import { computeDiffFacts } from "../../src/research/diff-facts.ts";
import { triageFromFacts } from "../../src/triage/matrix.ts";

function facts(diff: string) {
  return computeDiffFacts(diff);
}

describe("triageFromFacts (deterministic)", () => {
  it("doc-only → skip review", () => {
    const d = triageFromFacts(
      facts(
        "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n",
      ),
    );
    expect(d.runReview).toBe(false);
    expect(d.riskClass).toBe("trivial");
  });
  it("sensitive path (auth) → expanded budget, higher loop cap", () => {
    const d = triageFromFacts(
      facts(
        "diff --git a/src/auth/x.ts b/src/auth/x.ts\n--- a/src/auth/x.ts\n+++ b/src/auth/x.ts\n@@ -1 +1 @@\n-a\n+b\n",
      ),
    );
    expect(d.riskClass).toBe("sensitive");
    expect(d.budgetTier).toBe("expanded");
    expect(d.loopCap).toBeGreaterThanOrEqual(5);
  });
  it("default code change → standard", () => {
    const d = triageFromFacts(
      facts(
        "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n",
      ),
    );
    expect(d.riskClass).toBe("default");
    expect(d.runReview).toBe(true);
  });

  const docDiff =
    "diff --git a/docs/superpowers/specs/x.md b/docs/superpowers/specs/x.md\n--- a/docs/superpowers/specs/x.md\n+++ b/docs/superpowers/specs/x.md\n@@ -1 +1 @@\n-a\n+b\n";

  it("docReview disabled → doc-only still skipped", () => {
    const d = triageFromFacts(facts(docDiff), {
      enabled: false,
      globs: ["docs/superpowers/specs/**"],
      persona: "plan",
    });
    expect(d.runReview).toBe(false);
    expect(d.riskClass).toBe("trivial");
  });

  it("docReview enabled + glob match → reviewed as docs", () => {
    const d = triageFromFacts(facts(docDiff), {
      enabled: true,
      globs: ["docs/superpowers/specs/**"],
      persona: "plan",
    });
    expect(d.runReview).toBe(true);
    expect(d.riskClass).toBe("docs");
    expect(d.budgetTier).toBe("minimal");
  });

  it("docReview enabled + no glob match → skipped", () => {
    const d = triageFromFacts(facts(docDiff), {
      enabled: true,
      globs: ["docs/other/**"],
      persona: "plan",
    });
    expect(d.runReview).toBe(false);
  });

  it("invalid glob fails open (no match → skip), does not throw", () => {
    const d = triageFromFacts(facts(docDiff), {
      enabled: true,
      globs: ["["],
      persona: "plan",
    });
    expect(d.runReview).toBe(false);
  });

  // N1: small, low-risk diffs should not get the same 3-round soft cap as a big or
  // sensitive change. Triage emits maxIterationsOverride; the loop-driver caps to it.
  describe("size-tiered iteration cap (N1)", () => {
    const smallDefault =
      "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";

    it("small low-risk diff → maxIterationsOverride 2", () => {
      const d = triageFromFacts(facts(smallDefault));
      expect(d.riskClass).toBe("default");
      expect(d.maxIterationsOverride).toBe(2);
    });

    it("small SENSITIVE diff → no override (auth stays heavy)", () => {
      const d = triageFromFacts(
        facts(
          "diff --git a/src/auth/x.ts b/src/auth/x.ts\n--- a/src/auth/x.ts\n+++ b/src/auth/x.ts\n@@ -1 +1 @@\n-a\n+b\n",
        ),
      );
      expect(d.riskClass).toBe("sensitive");
      expect(d.maxIterationsOverride).toBeNull();
    });

    it("large low-risk diff (above the small-diff line threshold) → no override", () => {
      const body = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join("\n");
      const big = `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n${body}\n`;
      const d = triageFromFacts(facts(big));
      expect(d.riskClass).toBe("default");
      expect(d.maxIterationsOverride).toBeNull();
    });

    it("doc-only diff → no override", () => {
      const d = triageFromFacts(
        facts(
          "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n",
        ),
      );
      expect(d.maxIterationsOverride).toBeNull();
    });
  });
});
