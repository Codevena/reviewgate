// tests/unit/opencode-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAdapter } from "../../src/providers/opencode.ts";

/** Helper: write a temp executable bash script and return its path. */
function makeFakeBin(dir: string, name: string, script: string): string {
  const p = join(dir, name);
  writeFileSync(p, script, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

const PASS_SCRIPT = `#!/usr/bin/env bash
printf '%s\\n' '{"verdict":"FAIL","findings":[{"severity":"CRITICAL","category":"security","rule_id":"x","file":"a.ts","line":1,"message":"m","details":"d","confidence":0.9}]}'
exit 0
`;

const FAIL_SCRIPT = `#!/usr/bin/env bash
echo "opencode: fatal error" >&2
exit 1
`;

describe("OpenCodeAdapter (mocked binary)", () => {
  it("parses a CRITICAL finding from successful opencode run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-oc-"));
    const binPath = makeFakeBin(dir, "fake-opencode-ok.sh", PASS_SCRIPT);
    const promptFile = join(dir, "prompt.txt");
    const diffPath = join(dir, "diff.patch");
    const findingsPath = join(dir, "findings.md");
    writeFileSync(promptFile, "review this diff for issues");
    writeFileSync(diffPath, "diff --git a/a.ts b/a.ts");

    const adapter = new OpenCodeAdapter({ binPath });
    const result = await adapter.review({
      cfg: {
        enabled: true,
        auth: "oauth",
        model: "minimax/minimax-m2.7",
        timeoutMs: 60_000,
      },
      reviewerId: "opencode-security",
      promptFile,
      workingDir: dir,
      findingsPath,
      persona: "security",
      diffPath,
    });

    expect(result.status).toBe("ok");
    expect(result.verdict).toBe("FAIL");
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.findings[0]?.reviewer.provider).toBe("opencode");
    expect(result.findings[0]?.severity).toBe("CRITICAL");
    // opencode gives no token stats
    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
    expect(result.usage.costUsd).toBe(0);
    expect(result.usage.quotaUsedPct).toBeNull();
  });

  it("returns status=error and verdict=ERROR when opencode exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-oc-err-"));
    const binPath = makeFakeBin(dir, "fake-opencode-err.sh", FAIL_SCRIPT);
    const promptFile = join(dir, "prompt.txt");
    const diffPath = join(dir, "diff.patch");
    const findingsPath = join(dir, "findings.md");
    writeFileSync(promptFile, "review this");
    writeFileSync(diffPath, "diff --git a/a.ts b/a.ts");

    const adapter = new OpenCodeAdapter({ binPath });
    const result = await adapter.review({
      cfg: {
        enabled: true,
        auth: "oauth",
        model: "minimax/minimax-m2.7",
        timeoutMs: 60_000,
      },
      reviewerId: "opencode-security",
      promptFile,
      workingDir: dir,
      findingsPath,
      persona: "security",
      diffPath,
    });

    expect(result.status).toBe("error");
    expect(result.verdict).toBe("ERROR");
    expect(result.findings).toHaveLength(0);
    expect(result.statusDetail).toContain("opencode");
  });
});
