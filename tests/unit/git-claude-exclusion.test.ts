// tests/unit/git-claude-exclusion.test.ts
//
// M-B5(c) / I-17 — the .claude/ harness config dir (where Reviewgate installs its
// Stop/PostToolUse hooks, e.g. .claude/settings.json) must be excluded from review.
// Reviewers have filesystem read access and explore it off-diff, flagging the
// "repo-local hooks = code execution" supply-chain pattern as a CRITICAL RCE on
// EVERY branch in a Reviewgate-enabled repo — a wolf-cry on the gate's OWN
// machinery. Excluding .claude/ (like .reviewgate/) makes the orchestrator's
// existing isExcludedFromReview filter drop those findings.
import { describe, expect, it } from "bun:test";
import { isExcludedFromReview } from "../../src/utils/git.ts";

describe("isExcludedFromReview — .claude harness config (I-17)", () => {
  it("excludes the .claude hook config that reviewers flag as RCE every branch", () => {
    expect(isExcludedFromReview(".claude/settings.json")).toBe(true);
    expect(isExcludedFromReview(".claude/settings.local.json")).toBe(true);
    expect(isExcludedFromReview(".claude/commands/foo.md")).toBe(true);
    expect(isExcludedFromReview(".claude")).toBe(true);
  });

  it("does not over-match normal source files", () => {
    expect(isExcludedFromReview("src/app/claude.ts")).toBe(false);
    expect(isExcludedFromReview("claude.config.ts")).toBe(false);
    expect(isExcludedFromReview("docs/.claude-notes.md")).toBe(false);
  });
});
