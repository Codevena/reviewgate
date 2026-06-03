import { describe, expect, it } from "bun:test";
import { groundFindings } from "../../src/core/grounding.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function mk(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig-1",
    severity: "CRITICAL",
    // quality = a non-exempt category, so the layer-1 demote logic is exercised. Security/
    // correctness CRITICALs are EXEMPT from layer 1 (see the dedicated test below).
    category: "quality",
    rule_id: "x",
    file: "src/app.css",
    line_start: 1,
    line_end: 1,
    message: "issue",
    details: "details",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  };
}

// Corpus = what the reviewer was actually shown (diff + full content of changed files).
const CORPUS = `
:root { --muted: #F5F1EB; }
.btn { color: var(--muted); }
export function getCost() { return { tts: 1 }; }
const token = auth.session.id;
`;

describe("groundFindings (S6 layer 1)", () => {
  it("demotes a CRITICAL citing a CSS var absent from the corpus", () => {
    const out = groundFindings(
      [mk({ details: "The token --muted-bg: 210 40% 96.1% breaks dark mode." })],
      CORPUS,
    );
    expect(out[0]?.severity).toBe("WARN");
    expect(out[0]?.grounding_demoted).toBe(true);
    expect(out[0]?.details).toContain("not found");
  });

  it("keeps a CRITICAL whose cited CSS var IS in the corpus", () => {
    const out = groundFindings([mk({ details: "The --muted token is wrong." })], CORPUS);
    expect(out[0]?.severity).toBe("CRITICAL");
    expect(out[0]?.grounding_demoted).toBeUndefined();
  });

  it("keeps a CRITICAL with no extractable code token (prose, fail-safe)", () => {
    const out = groundFindings(
      [mk({ message: "dark mode looks broken", details: "the colors are off" })],
      CORPUS,
    );
    expect(out[0]?.severity).toBe("CRITICAL");
    expect(out[0]?.grounding_demoted).toBeUndefined();
  });

  it("does not touch WARN findings (CRITICAL-only scope)", () => {
    const out = groundFindings(
      [mk({ severity: "WARN", details: "the --ghost-token is absent" })],
      CORPUS,
    );
    expect(out[0]?.severity).toBe("WARN");
    expect(out[0]?.grounding_demoted).toBeUndefined();
  });

  it("demotes a CRITICAL citing an absent backtick code token", () => {
    const out = groundFindings(
      [mk({ details: "Calling `auth.refreshToken` is dead code." })],
      CORPUS,
    );
    expect(out[0]?.severity).toBe("WARN");
    expect(out[0]?.grounding_demoted).toBe(true);
  });

  it("keeps a CRITICAL citing a dotted backtick token present in the corpus", () => {
    const out = groundFindings([mk({ details: "`auth.session` is mishandled here." })], CORPUS);
    expect(out[0]?.severity).toBe("CRITICAL");
    expect(out[0]?.grounding_demoted).toBeUndefined();
  });

  it("ignores backtick prose spans (multi-word, not code-shaped)", () => {
    const out = groundFindings([mk({ details: "`the muted color` is wrong" })], CORPUS);
    expect(out[0]?.severity).toBe("CRITICAL");
    expect(out[0]?.grounding_demoted).toBeUndefined();
  });

  // F-001: a real CRITICAL may cite a present core symbol PLUS an incidental absent
  // dotted ref (a helper in an unchanged file). Code refs only trigger when ALL are
  // absent — so this stays a blocking CRITICAL.
  it("keeps a CRITICAL whose core dotted token is present even if an incidental dotted token is absent (F-001)", () => {
    const out = groundFindings(
      [mk({ details: "`auth.session` is fine but `helper.format` leaks" })],
      CORPUS,
    );
    expect(out[0]?.severity).toBe("CRITICAL");
    expect(out[0]?.grounding_demoted).toBeUndefined();
  });

  it("still demotes a CRITICAL citing an absent CSS var even when a dotted token is present (CSS is high-precision)", () => {
    const out = groundFindings(
      [mk({ details: "the `auth.session` theme uses --ghost-color" })],
      CORPUS,
    );
    expect(out[0]?.severity).toBe("WARN");
    expect(out[0]?.grounding_demoted).toBe(true);
  });

  // F-001 iter 3: layer 1 is a deterministic heuristic over the finding's own
  // (untrusted-derived) text — it must NEVER weaken a security/correctness CRITICAL (that
  // is layer 2's job, which reads the actual code). Otherwise an absent token in
  // attacker-influenced finding text is a fail-open.
  it("NEVER demotes a security CRITICAL, even citing an absent token (exempt — fail-open guard)", () => {
    const out = groundFindings(
      [mk({ category: "security", details: "leak via --ghost-token" })],
      CORPUS,
    );
    expect(out[0]?.severity).toBe("CRITICAL");
    expect(out[0]?.grounding_demoted).toBeUndefined();
  });

  it("NEVER demotes a correctness CRITICAL citing an absent token (exempt)", () => {
    const out = groundFindings(
      [mk({ category: "correctness", details: "wrong via --ghost-token" })],
      CORPUS,
    );
    expect(out[0]?.severity).toBe("CRITICAL");
    expect(out[0]?.grounding_demoted).toBeUndefined();
  });
});
