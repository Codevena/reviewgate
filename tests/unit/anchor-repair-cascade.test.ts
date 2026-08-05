// tests/unit/anchor-repair-cascade.test.ts
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate } from "../../src/core/aggregator.ts";
import { validateFindingFacts } from "../../src/core/fact-check.ts";
import { findingBadges } from "../../src/core/report-writer.ts";
import type { Finding } from "../../src/schemas/finding.ts";

// Temp dirs created by this file's tests, removed after the run whether tests pass or fail.
const createdDirs: string[] = [];
afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

function fin(over: Partial<Finding>): Finding {
  return {
    id: "F-x",
    signature: "s",
    severity: "WARN",
    category: "security",
    rule_id: "r",
    file: "src/store.ts",
    line_start: 25,
    line_end: 25,
    message: "m",
    details: "d",
    reviewer: { provider: "ollama", model: "glm-5.2:cloud", persona: "correctness" },
    confidence: 0.55,
    consensus: "singleton",
    ...over,
  };
}

describe("anchor_repaired survives a dedup merge", () => {
  // WITHOUT the OR-propagation: anchor_repaired is undefined on the merged finding (it lived on
  // the member, and ties-keep-first made the UNrepaired finding the representative) -> the badge
  // and pilot-03's count both disappear in exactly the cascade case.
  // WITH it: anchor_repaired is true on the single merged finding.
  it("OR-propagates anchor_repaired from a merged member to the representative", () => {
    const r = aggregate({
      findings: [
        fin({
          signature: "sigA",
          line_start: 25,
          line_end: 25,
          rule_id: "path-traversal-readtemplate",
        }),
        fin({
          signature: "sigB",
          line_start: 26,
          line_end: 26,
          rule_id: "path-traversal",
          anchor_repaired: true,
          reviewer: {
            provider: "openrouter",
            model: "deepseek/deepseek-v3.2",
            persona: "security",
          },
          confidence: 0.9,
        }),
      ],
      reviewersTotal: 2,
    });
    expect(r.dedupedFindings.length).toBe(1);
    expect(r.dedupedFindings[0]?.anchor_repaired).toBe(true);
    expect(r.dedupedFindings[0]?.consensus).toBe("majority");
  });
});

describe("anchor_repaired badge", () => {
  // WITHOUT the badge: findingBadges returns null for a repaired finding -> the agent sees a
  // silently corrected line number and no signal that a reviewer mis-anchored.
  // WITH it: the badge text is present.
  it("renders a badge naming the repair", () => {
    const out = findingBadges(fin({ anchor_repaired: true }));
    expect(out).toContain("re-anchored");
  });

  it("renders no such badge for an ordinary finding", () => {
    expect(findingBadges(fin({}))).toBeNull();
  });
});

// The 27-line src/store.ts exactly as turn 2's diff created it. Line 26 is the quoted evidence.
const STORE_TS = `${[
  "import { readFileSync } from 'node:fs'",
  "",
  "export interface KVStore<K, V> {",
  "  get(key: K): V | undefined",
  "  set(key: K, value: V): void",
  "  has(key: K): boolean",
  "}",
  "",
  "export function createStore<K, V>(): KVStore<K, V> {",
  "  const entries = new Map<K, V>()",
  "",
  "  return {",
  "    get(key) {",
  "      return entries.get(key)",
  "    },",
  "    set(key, value) {",
  "      entries.set(key, value)",
  "    },",
  "    has(key) {",
  "      return entries.has(key)",
  "    },",
  "  }",
  "}",
  "",
  "export function readTemplate(name: string): string {",
  "  return readFileSync(`./templates/${name}`, 'utf8')",
  "}",
].join("\n")}\n`;

describe("pilot-02 turn 2 — the full cascade", () => {
  // WITHOUT the fix: F-002 is demoted as fabricated (INFO + fact_invalid) and stays 42 lines
  // from F-001, so nothing merges, both stay `singleton`, and the critic demotes F-001 to INFO
  // -> 2 findings, 0 blocking. This is what pilot-02 recorded.
  // WITH the fix: F-002 re-anchors 67 -> 26, merges with F-001 at 25, consensus becomes
  // `majority`, the critic is barred -> 1 finding, blocking WARN.
  it("repairs the anchor, merges, corroborates, and stays blocking", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-turn2-"));
    createdDirs.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "store.ts"), STORE_TS);

    const evidence = "  return readFileSync(`./templates/${name}`, 'utf8')";
    const raw: Finding[] = [
      fin({
        signature: "sigF001",
        rule_id: "path-traversal-readtemplate",
        line_start: 25,
        line_end: 27,
        confidence: 0.55,
        evidence_line: evidence,
        message: "readTemplate interpolates 'name' directly into a filesystem path",
      }),
      fin({
        signature: "sigF002",
        rule_id: "path-traversal",
        line_start: 67,
        line_end: 67,
        confidence: 0.9,
        evidence_line: evidence,
        message: "Path traversal vulnerability in readTemplate.",
        reviewer: { provider: "openrouter", model: "deepseek/deepseek-v3.2", persona: "security" },
      }),
    ];

    const checked = validateFindingFacts(raw, dir, new Set());
    expect(checked.find((f) => f.signature === "sigF002")?.line_start).toBe(26);

    const r = aggregate({
      findings: checked,
      reviewersTotal: 2,
      changedRanges: new Map([["src/store.ts", [[1, 27]] as Array<[number, number]>]]),
      scopeToDiff: true,
      // The critic called the weaker detection a likely FP, exactly as it did in the pilot.
      critic: new Map([["sigF001", { verdict: "likely_fp" }]]),
    });

    expect(r.dedupedFindings.length).toBe(1);
    expect(r.dedupedFindings[0]?.consensus).toBe("majority");
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.critic_verdict).toBe("keep");
    expect(r.dedupedFindings[0]?.anchor_repaired).toBe(true);
    expect(r.dedupedFindings[0]?.scope_demoted).toBeUndefined();
    expect(r.dedupedFindings[0]?.fact_invalid).toBeUndefined();
  });
});
