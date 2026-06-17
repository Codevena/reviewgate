// tests/unit/review-prompt-rule-citation.test.ts
// #6 (field report 2026-06-17): a reviewer cited a non-existent CLAUDE.md rule. The
// preamble must require rule-based findings to quote file+line. This guards the directive
// from silently regressing out of the prompt.
import { describe, expect, it } from "bun:test";
import { REVIEW_PROMPT_PREAMBLE } from "../../src/core/orchestrator.ts";

describe("REVIEW_PROMPT_PREAMBLE — rule-citation directive (#6)", () => {
  it("requires a finding that invokes a project/house rule to quote file+line", () => {
    expect(REVIEW_PROMPT_PREAMBLE).toContain("CLAUDE.md says");
    expect(REVIEW_PROMPT_PREAMBLE).toContain("quote the exact file and line");
  });

  it("tells the reviewer that assistant defaults are NOT this repo's rules", () => {
    expect(REVIEW_PROMPT_PREAMBLE.toLowerCase()).toContain("do not add comments");
    expect(REVIEW_PROMPT_PREAMBLE).toContain("NOT this repo's rules");
  });
});
