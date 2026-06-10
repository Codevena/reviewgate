// tests/unit/opencode-quota-exit0.test.ts
// F-11: the opencode exit-0-but-unparseable path must run the same quota-banner
// check codex/claude/gemini all have (F-043). Several CLIs print their
// quota/usage-limit banner and still exit 0; classifying that as a generic fast
// "error" records no cooldown (cooldownEffectFor returns null for a fast error),
// so the capped provider is re-burned every iteration and the orchestrator's
// allReviewersQuotaLocked infra-defer classification is defeated when opencode
// is the last provider standing.
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAdapter } from "../../src/providers/opencode.ts";

function makeFakeBin(dir: string, name: string, script: string): string {
  const p = join(dir, name);
  writeFileSync(p, script, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

function reviewInput(dir: string, promptFile: string) {
  return {
    cfg: { enabled: true, auth: "oauth", model: "default", timeoutMs: 60_000 },
    reviewerId: "opencode-security",
    promptFile,
    workingDir: dir,
    findingsPath: join(dir, "f.md"),
    persona: "security",
    diffPath: join(dir, "d.patch"),
  } as Parameters<OpenCodeAdapter["review"]>[0];
}

describe("OpenCodeAdapter.review — exit 0 quota banner (F-043 / F-11)", () => {
  it("exit 0 with a quota banner on stdout → status quota-exhausted (cooldown/failover fires)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-oc-quota0-"));
    // Drain stdin (the prompt now arrives piped), then print a quota banner and
    // exit 0 — mirrors a capped opencode/MiniMax run that still exits cleanly.
    const binPath = makeFakeBin(
      dir,
      "fake-opencode-quota.sh",
      `#!/usr/bin/env bash
cat > /dev/null
printf '%s\\n' 'Error: quota exceeded — upgrade your plan'
exit 0
`,
    );
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const adapter = new OpenCodeAdapter({ binPath });
    const res = await adapter.review(reviewInput(dir, promptFile));
    expect(res.verdict).toBe("ERROR");
    expect(res.status).toBe("quota-exhausted");
    expect(res.statusDetail).toContain("quota/usage-limit banner");
  });

  it("exit 0 with non-quota unparseable output stays a generic error (no false cooldown)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-oc-garb0-"));
    const binPath = makeFakeBin(
      dir,
      "fake-opencode-garbage.sh",
      `#!/usr/bin/env bash
cat > /dev/null
printf '%s\\n' 'truncated nonsense {{{'
exit 0
`,
    );
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const adapter = new OpenCodeAdapter({ binPath });
    const res = await adapter.review(reviewInput(dir, promptFile));
    expect(res.verdict).toBe("ERROR");
    expect(res.status).toBe("error");
    expect(res.statusDetail).toContain("no valid review JSON");
  });
});
