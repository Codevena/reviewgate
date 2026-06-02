import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// `buildReport` is not a top-level export; it is exposed via the `__test` bag.
import { __test } from "../../src/cli/commands/learn-status.ts";
import { ImplicitOutcomeStore } from "../../src/core/learnings/implicit-outcomes.ts";
import type { ImplicitOutcome } from "../../src/schemas/implicit-outcome.ts";

const { buildReport } = __test;

const oc = (reason: ImplicitOutcome["demote_reason"]): ImplicitOutcome => ({
  schema: "reviewgate.implicit_outcome.v1",
  signature: "s",
  reviewer_key: "codex:security",
  category: "correctness",
  demote_reason: reason,
  run_id: "RUN",
  iter: 1,
  created_at: "2026-06-02T00:00:00Z",
});

describe("learn status — implicit outcomes section", () => {
  it("reports total + by-reason breakdown", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-ls-io-"));
    await new ImplicitOutcomeStore(repo).append(
      [oc("scope_demoted"), oc("critic_likely_fp")],
      5000,
    );
    const report = await buildReport({ repoRoot: repo });
    expect(report.implicit_outcomes.total).toBe(2);
    expect(report.implicit_outcomes.by_reason.scope_demoted).toBe(1);
    expect(report.implicit_outcomes.by_reviewer["codex:security"]).toBe(2);
  });

  it("reports zero when the file is absent", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-ls-io2-"));
    const report = await buildReport({ repoRoot: repo });
    expect(report.implicit_outcomes.total).toBe(0);
  });
});
