import { describe, expect, it } from "bun:test";
import { groundFindings } from "../../src/core/grounding.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function mk(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig-1",
    severity: "CRITICAL",
    category: "correctness",
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
      [mk({ category: "security", details: "Calling `auth.refreshToken` leaks the secret." })],
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
});
