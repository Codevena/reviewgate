// tests/unit/proposal-evidence.test.ts
import { describe, expect, it } from "bun:test";
import { buildProposalEvidence } from "../../src/core/orchestrator.ts";

describe("buildProposalEvidence", () => {
  it("synthesizes a default reviewer-observation when the proposal has NO evidence", () => {
    // A reviewer that proposes a convention without attaching structured evidence
    // would otherwise die at normalizeProposal's evidence.min(1) gate. Synthesize
    // one observation stamped with the emitting provider so it survives and counts
    // toward cross-provider quorum. It must NOT be from_diff (keeps it general).
    const ev = buildProposalEvidence(undefined, "run-1", "codex-security");
    expect(ev).toHaveLength(1);
    expect(ev[0]?.kind).toBe("reviewer-observation");
    expect(ev[0]?.reviewer_id).toBe("codex-security");
    expect(ev[0]?.run_id).toBe("run-1");
    expect("from_diff" in (ev[0] ?? {})).toBe(false);
  });

  it("synthesizes the default when the evidence array is empty", () => {
    const ev = buildProposalEvidence([], "run-1", "gemini-architecture");
    expect(ev).toHaveLength(1);
    expect(ev[0]?.reviewer_id).toBe("gemini-architecture");
  });

  it("synthesizes the default when evidence is present but ALL items have an invalid kind", () => {
    // A reviewer that emits evidence with unusable `kind`s would otherwise have
    // those items dropped by normalizeProposal, leaving zero evidence → rejected
    // at the evidence.min(1) gate. Replace invalid-only evidence with one valid
    // stamped observation.
    const ev = buildProposalEvidence(
      [{ kind: "GARBAGE" }, { kind: "also-bad" }],
      "run-3",
      "claude-code-adversarial",
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]?.kind).toBe("reviewer-observation");
    expect(ev[0]?.reviewer_id).toBe("claude-code-adversarial");
  });

  it("keeps valid evidence items and drops only the invalid ones", () => {
    const ev = buildProposalEvidence(
      [{ kind: "GARBAGE" }, { kind: "reviewer-finding" }],
      "run-4",
      "codex-security",
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]?.kind).toBe("reviewer-finding");
  });

  it("maps provided evidence, always stamping the emitting run + reviewer (anti-collusion)", () => {
    const ev = buildProposalEvidence(
      [
        {
          kind: "reviewer-finding",
          reviewer_id: "LLM-CLAIMED-OTHER", // must be overwritten
          from_diff: { file: "a.ts", line_start: 1, line_end: 2 },
        },
      ],
      "run-2",
      "codex-security",
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]?.kind).toBe("reviewer-finding");
    expect(ev[0]?.reviewer_id).toBe("codex-security"); // emitter, not LLM text
    expect(ev[0]?.run_id).toBe("run-2");
    expect(ev[0]?.from_diff).toEqual({ file: "a.ts", line_start: 1, line_end: 2 });
  });
});
