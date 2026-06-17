// tests/unit/triage-matrix.test.ts
import { describe, expect, it } from "bun:test";
import { computeDiffFacts } from "../../src/research/diff-facts.ts";
import { SMALL_DIFF_REVIEWER_TIMEOUT_MS, triageFromFacts } from "../../src/triage/matrix.ts";

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

  it("a SENSITIVE doc-only path still escalates (docOnly must not suppress sensitivity) (F-7)", () => {
    // `migrations/notes.md` is docs-kind (docOnly=true) AND sensitivity-tagged
    // ("migrations"). The sensitivity escalation must win — previously docOnly
    // precedence skipped the review entirely, discarding the escalation.
    const f = facts(
      "diff --git a/migrations/notes.md b/migrations/notes.md\n--- a/migrations/notes.md\n+++ b/migrations/notes.md\n@@ -1 +1 @@\n-a\n+b\n",
    );
    expect(f.docOnly).toBe(true);
    expect(f.sensitivityTags).toContain("migrations");
    const d = triageFromFacts(f);
    expect(d.riskClass).toBe("sensitive");
    expect(d.runReview).toBe(true);
    expect(d.budgetTier).toBe("expanded");
  });

  it("a non-sensitive doc-only path is still skipped (no over-escalation)", () => {
    const d = triageFromFacts(
      facts(
        "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n",
      ),
    );
    expect(d.riskClass).toBe("trivial");
    expect(d.runReview).toBe(false);
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

  // #7: small low-risk diffs get a conservative per-reviewer timeout cap; sensitive/docs and
  // large diffs keep each provider's full timeout (reviewerTimeoutCapMs null/absent).
  describe("size-aware reviewer timeout cap (#7)", () => {
    const bigDiff = `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1,40 @@\n-a\n${Array.from(
      { length: 40 },
      (_, i) => `+line${i}`,
    ).join("\n")}\n`;

    it("small (≤30 line) default diff → reviewerTimeoutCapMs set to the small-diff cap", () => {
      const d = triageFromFacts(
        facts(
          "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n",
        ),
      );
      expect(d.riskClass).toBe("default");
      expect(d.reviewerTimeoutCapMs).toBe(SMALL_DIFF_REVIEWER_TIMEOUT_MS);
    });

    it("large (>30 line) default diff → no cap (full provider timeout)", () => {
      const d = triageFromFacts(facts(bigDiff));
      expect(d.riskClass).toBe("default");
      expect(d.reviewerTimeoutCapMs ?? null).toBeNull();
    });

    it("sensitive diff → no cap regardless of size", () => {
      const d = triageFromFacts(
        facts(
          "diff --git a/src/auth/x.ts b/src/auth/x.ts\n--- a/src/auth/x.ts\n+++ b/src/auth/x.ts\n@@ -1 +1 @@\n-a\n+b\n",
        ),
      );
      expect(d.riskClass).toBe("sensitive");
      expect(d.reviewerTimeoutCapMs ?? null).toBeNull();
    });
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

  // F-17: lockfile-only diffs tier down to minimal instead of the full default panel.
  describe("lockfile-only tier (F-17)", () => {
    const lockDiff =
      "diff --git a/bun.lock b/bun.lock\n--- a/bun.lock\n+++ b/bun.lock\n@@ -1 +1 @@\n-a\n+b\n";

    it("lockfile-only diff → minimal tier, still reviewed", () => {
      const d = triageFromFacts(facts(lockDiff));
      expect(d.riskClass).toBe("minimal");
      expect(d.runReview).toBe(true);
      expect(d.budgetTier).toBe("minimal");
      expect(d.justification).toBe("Lockfile-only diff.");
    });

    it("mixed lockfile+code diff → stays default", () => {
      const mixed = `${lockDiff}diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n`;
      const d = triageFromFacts(facts(mixed));
      expect(d.riskClass).toBe("default");
    });
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
