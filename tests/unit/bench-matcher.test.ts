import { describe, expect, it } from "bun:test";
import { type MatchInput, type MatcherFinding, matchCase } from "../../src/bench/matcher.ts";

// ── helpers ───────────────────────────────────────────────────────────────
function finding(p: Partial<MatcherFinding> & { id: string; line?: number }): MatcherFinding {
  const ls = p.lineStart ?? p.line ?? 42;
  return {
    id: p.id,
    file: p.file ?? "src/db.ts",
    lineStart: ls,
    lineEnd: p.lineEnd ?? ls,
    severity: p.severity ?? "CRITICAL",
    text: p.text ?? "sql injection via string concatenation",
  };
}

function baseInput(over: Partial<MatchInput> = {}): MatchInput {
  return {
    kind: "seeded-bug",
    expected: [{ tag: "sql-injection", file: "src/db.ts", line: 42, minSeverity: "WARN" }],
    allowed: [],
    strictRegion: true,
    changedHunks: [{ file: "src/db.ts", start: 40, end: 50 }],
    window: 5,
    findings: [],
    ...over,
  };
}

// ── the three-test match + counts ─────────────────────────────────────────
describe("matchCase — basic seeded-bug scoring", () => {
  it("credits a finding matching a label on all three tests as TP", () => {
    const r = matchCase(baseInput({ findings: [finding({ id: "f1" })] }));
    expect(r.tp).toBe(1);
    expect(r.fp).toBe(0);
    expect(r.fn).toBe(0);
    expect(r.findings.find((f) => f.findingId === "f1")?.outcome).toBe("TP");
    expect(r.findings.find((f) => f.findingId === "f1")?.labelIndex).toBe(0);
  });

  it("counts a label with no matching finding as FN", () => {
    const r = matchCase(baseInput({ findings: [] }));
    expect(r.fn).toBe(1);
    expect(r.fnLabels).toEqual([0]);
    expect(r.tp).toBe(0);
  });

  it("counts an in-region blocking finding matching no label as FP", () => {
    const r = matchCase(
      baseInput({
        findings: [
          finding({ id: "noise", line: 44, lineEnd: 44, text: "unrelated style nit here" }),
        ],
      }),
    );
    expect(r.fp).toBe(1);
    expect(r.findings.find((f) => f.findingId === "noise")?.outcome).toBe("FP");
  });
});

// ── region rules ──────────────────────────────────────────────────────────
describe("matchCase — strict_region", () => {
  it("scores an out-of-region blocking finding NEUTRAL (not FP) under strict_region", () => {
    const r = matchCase(
      baseInput({
        // valid label match so the case is not just noise
        findings: [
          finding({ id: "hit" }),
          finding({
            id: "outside",
            lineStart: 200,
            lineEnd: 200,
            text: "some other blocking issue",
          }),
        ],
      }),
    );
    expect(r.tp).toBe(1);
    expect(r.fp).toBe(0);
    expect(r.neutral).toBe(1);
    expect(r.findings.find((f) => f.findingId === "outside")?.outcome).toBe("NEUTRAL");
  });

  it("scores an out-of-region finding as FP when strict_region is false", () => {
    const r = matchCase(
      baseInput({
        strictRegion: false,
        findings: [
          finding({ id: "outside", lineStart: 200, lineEnd: 200, text: "other blocking issue" }),
        ],
      }),
    );
    expect(r.fp).toBe(1);
  });
});

// ── allowed incidentals ───────────────────────────────────────────────────
describe("matchCase — allowed incidentals", () => {
  it("scores a finding matching an allowed entry NEUTRAL", () => {
    const r = matchCase(
      baseInput({
        allowed: [{ tag: "unused-var", file: "src/db.ts", line: 41 }],
        findings: [
          finding({ id: "inc", lineStart: 41, lineEnd: 41, text: "unused var foo declared" }),
        ],
      }),
    );
    expect(r.neutral).toBe(1);
    expect(r.fp).toBe(0);
    expect(r.findings.find((f) => f.findingId === "inc")?.outcome).toBe("NEUTRAL");
  });

  it("applies the ±window tolerance to allowed matching (not exact-line-only)", () => {
    const r = matchCase(
      baseInput({
        allowed: [{ tag: "unused-var", file: "src/db.ts", line: 41 }],
        // finding 4 lines away — inside window=5
        findings: [finding({ id: "inc", lineStart: 45, lineEnd: 45, text: "unused var foo" })],
      }),
    );
    expect(r.neutral).toBe(1);
    expect(r.fp).toBe(0);
  });
});

// ── partial matches / near-miss ───────────────────────────────────────────
describe("matchCase — near-miss", () => {
  it("scores an in-region location-only match as FP badged near_miss (never voided)", () => {
    const r = matchCase(
      baseInput({
        // right location, wrong tag → not a TP, but in-region → FP + near_miss
        findings: [finding({ id: "close", text: "possible off-by-one in loop bound" })],
      }),
    );
    expect(r.tp).toBe(0);
    expect(r.fp).toBe(1);
    expect(r.fn).toBe(1);
    const c = r.findings.find((f) => f.findingId === "close");
    expect(c?.outcome).toBe("FP");
    expect(c?.nearMiss).toBe(true);
  });
});

// ── severity ──────────────────────────────────────────────────────────────
describe("matchCase — severity", () => {
  it("marks a TP whose severity exceeds min_severity as severity_overshoot", () => {
    const r = matchCase(
      baseInput({
        expected: [{ tag: "sql-injection", file: "src/db.ts", line: 42, minSeverity: "WARN" }],
        findings: [finding({ id: "f1", severity: "CRITICAL" })],
      }),
    );
    expect(r.tp).toBe(1);
    expect(r.findings.find((f) => f.findingId === "f1")?.severityOvershoot).toBe(true);
  });

  it("does NOT credit a finding below the label's min_severity (fails the severity test)", () => {
    const r = matchCase(
      baseInput({
        expected: [{ tag: "sql-injection", file: "src/db.ts", line: 42, minSeverity: "CRITICAL" }],
        findings: [finding({ id: "weak", severity: "WARN" })],
      }),
    );
    expect(r.tp).toBe(0);
    expect(r.fn).toBe(1);
    expect(r.fp).toBe(1); // in-region blocking finding, unmatched
  });

  it("excludes INFO (advisory) findings from scoring by default", () => {
    const r = matchCase(
      baseInput({
        findings: [finding({ id: "info", severity: "INFO", text: "sql injection note" })],
      }),
    );
    expect(r.tp).toBe(0);
    expect(r.fp).toBe(0);
    expect(r.fn).toBe(1);
    expect(r.findings.find((f) => f.findingId === "info")).toBeUndefined();
  });

  it("scores INFO findings when includeAdvisory is set", () => {
    const r = matchCase(
      baseInput({
        includeAdvisory: true,
        expected: [{ tag: "sql-injection", file: "src/db.ts", line: 42, minSeverity: "INFO" }],
        findings: [finding({ id: "info", severity: "INFO" })],
      }),
    );
    expect(r.tp).toBe(1);
  });
});

// ── clean cases ───────────────────────────────────────────────────────────
describe("matchCase — clean cases", () => {
  it("scores an in-region blocking finding on a clean case as FP", () => {
    const r = matchCase(
      baseInput({
        kind: "clean",
        expected: [],
        findings: [finding({ id: "fp", text: "some blocking concern" })],
      }),
    );
    expect(r.fp).toBe(1);
    expect(r.fn).toBe(0);
  });

  it("scores an out-of-region finding on a clean case NEUTRAL (pre-existing, not punished)", () => {
    const r = matchCase(
      baseInput({
        kind: "clean",
        expected: [],
        findings: [
          finding({ id: "pre", lineStart: 300, lineEnd: 300, text: "pre-existing issue" }),
        ],
      }),
    );
    expect(r.neutral).toBe(1);
    expect(r.fp).toBe(0);
  });

  it("scores a clean case with zero findings as all-zero (a clean pass)", () => {
    const r = matchCase(baseInput({ kind: "clean", expected: [], findings: [] }));
    expect(r.tp).toBe(0);
    expect(r.fp).toBe(0);
    expect(r.fn).toBe(0);
  });
});

// ── optimal 1:1 assignment ────────────────────────────────────────────────
describe("matchCase — optimal assignment", () => {
  it("maximises cardinality: does not consume a flexible finding on the nearest label and strand another", () => {
    // Two labels; f_both could match either, f_only matches only label B.
    // Greedy-by-nearest could take f_both for A, then B for f_only — fine — but if
    // f_both is nearer to B, greedy would take B and strand A. Max-cardinality keeps both.
    const input = baseInput({
      changedHunks: [{ file: "src/db.ts", start: 1, end: 100 }],
      expected: [
        { tag: "sql-injection", file: "src/db.ts", line: 10, minSeverity: "WARN" },
        { tag: "path-traversal", file: "src/db.ts", line: 12, minSeverity: "WARN" },
      ],
      findings: [
        // f_both matches path-traversal tag AND is near line 12; only path-traversal tag though
        finding({ id: "f_pt", lineStart: 12, lineEnd: 12, text: "path traversal via join" }),
        // f_sql matches sql-injection near line 10
        finding({ id: "f_sql", lineStart: 10, lineEnd: 10, text: "sql injection in query" }),
      ],
    });
    const r = matchCase(input);
    expect(r.tp).toBe(2);
    expect(r.fn).toBe(0);
    expect(r.fp).toBe(0);
  });

  it("stays bounded on a pathological many-label × many-candidate input (no F^L blowup)", () => {
    // 20 labels, each with ~6 tag/location-matching findings → exhaustive recursion
    // would be ~7^20 ≈ 8e16 calls and hang. The guard must fall back to a bounded
    // polynomial assignment and return promptly.
    const L = 20;
    const perLabel = 6;
    const expected = Array.from({ length: L }, (_, j) => ({
      tag: "sql-injection",
      file: "src/db.ts",
      line: 10 + j,
      minSeverity: "WARN" as const,
    }));
    const findings: MatcherFinding[] = [];
    for (let j = 0; j < L; j++) {
      for (let k = 0; k < perLabel; k++) {
        findings.push(
          finding({ id: `f_${j}_${k}`, lineStart: 10 + j, lineEnd: 10 + j, text: "sql injection" }),
        );
      }
    }
    const start = performance.now();
    const r = matchCase(
      baseInput({
        changedHunks: [{ file: "src/db.ts", start: 1, end: 1000 }],
        expected,
        findings,
      }),
    );
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(1000);
    // Still correct: every label can be matched by a distinct finding → full recall.
    expect(r.tp).toBe(L);
    expect(r.fn).toBe(0);
  });

  it("the large-case fallback still returns a MAXIMUM-cardinality matching (not greedy-min-cost)", () => {
    // Contention pair: labelA can match X(cheap) or Y; labelB can match ONLY X.
    // A min-cost-first greedy strands labelB (1 match); max-cardinality matches both.
    // Pad with isolated labels so the search space trips the exhaustive cap and the
    // fallback path runs.
    const expected = [
      { tag: "alpha", file: "src/db.ts", line: 20, minSeverity: "WARN" as const },
      { tag: "beta", file: "src/db.ts", line: 20, minSeverity: "WARN" as const },
    ];
    const findings: MatcherFinding[] = [
      finding({ id: "X", lineStart: 20, lineEnd: 20, text: "alpha beta bug" }),
      finding({ id: "Y", lineStart: 20, lineEnd: 20, text: "alpha bug" }),
    ];
    // 18 isolated filler labels/findings, far apart → each a clean 1:1 TP.
    for (let j = 0; j < 18; j++) {
      const line = 1000 + j * 10;
      expected.push({ tag: `iso${j}`, file: "src/db.ts", line, minSeverity: "WARN" });
      findings.push(
        finding({ id: `iso${j}`, lineStart: line, lineEnd: line, text: `iso${j} bug` }),
      );
    }
    const r = matchCase(
      baseInput({ changedHunks: [{ file: "src/db.ts", start: 1, end: 2000 }], expected, findings }),
    );
    // 18 filler + BOTH contention labels = 20; a greedy fallback would yield 19.
    expect(r.tp).toBe(20);
    expect(r.fn).toBe(0);
  });

  it("is deterministic under finding ordering (same result regardless of input order)", () => {
    const mk = (order: MatcherFinding[]) =>
      matchCase(
        baseInput({
          changedHunks: [{ file: "src/db.ts", start: 1, end: 100 }],
          expected: [{ tag: "sql-injection", file: "src/db.ts", line: 10, minSeverity: "WARN" }],
          findings: order,
        }),
      );
    const a = finding({ id: "a", lineStart: 8, lineEnd: 8, text: "sql injection here" });
    const b = finding({ id: "b", lineStart: 12, lineEnd: 12, text: "sql injection here" });
    const r1 = mk([a, b]);
    const r2 = mk([b, a]);
    // Only one can be TP (1 label); the nearer one (line 8, dist 2 vs 2) → tie broken by id "a".
    const tp1 = r1.findings.find((f) => f.outcome === "TP")?.findingId;
    const tp2 = r2.findings.find((f) => f.outcome === "TP")?.findingId;
    expect(tp1).toBe(tp2);
  });
});
