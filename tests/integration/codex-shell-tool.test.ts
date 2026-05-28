// tests/integration/codex-shell-tool.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../../src/providers/codex.ts";

// Opt-in: only runs when RG_REAL_CODEX=1 is set, so the default `bun test`
// (and CI without codex/auth) skips it. Verifies the Slice-1 fix end-to-end
// against the real codex CLI: --disable shell_tool → one-shot parseable review,
// no exec_command/function_call exploration events.
const REAL = process.env.RG_REAL_CODEX === "1";
const d = REAL ? describe : describe.skip;

d("CodexAdapter against real codex CLI", () => {
  it("--disable shell_tool produces a parseable review with no shell exploration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-codex-real-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(
      promptFile,
      "You are reviewing an implementation plan. Output ONLY a single JSON object matching the provided schema. Plan: add an EbookCard using the shared Card with variant=glass; wire onArchived.",
    );
    writeFileSync(join(dir, "diff.patch"), "n/a");

    const adapter = new CodexAdapter();
    const result = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "gpt-5.5", timeoutMs: 300_000 },
      reviewerId: "codex-plan",
      promptFile,
      workingDir: process.cwd(),
      findingsPath: join(dir, "findings.md"),
      persona: "plan",
      diffPath: join(dir, "diff.patch"),
    });

    // Opt-in real run: a genuine quota throttle is environmental, not a regression — skip the smoke.
    if (result.status === "quota-exhausted") {
      console.warn("codex quota-exhausted — skipping real-CLI smoke assertions this run");
      return;
    }
    // Otherwise the fix must yield a clean, parseable review. error/timeout here = regression.
    expect(result.status).toBe("ok");
    const events = await Bun.file(result.rawEventsPath ?? "")
      .text()
      .catch(() => "");
    expect(events.length).toBeGreaterThan(0);
    expect(events).not.toContain("exec_command");
    expect(events).not.toContain('"type":"function_call"');
  }, 320_000);
});
