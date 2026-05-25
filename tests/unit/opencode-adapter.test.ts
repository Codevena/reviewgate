// tests/unit/opencode-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeAdapter } from "../../src/providers/opencode.ts";

const FAKE_COMPLETE = join(process.cwd(), "tests/fixtures/fake-opencode-complete.sh");

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

  it("omits -m for the 'default' model (uses opencode's configured default) but passes -m for a real id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-oc-args-"));
    const argsFile = join(dir, "args.txt");
    // Fake records its argv to $OC_ARGS_FILE, then emits valid review JSON.
    const bin = makeFakeBin(
      dir,
      "fake-opencode-args.sh",
      `#!/usr/bin/env bash\nprintf '%s ' "$@" > "$OC_ARGS_FILE"\nprintf '%s\\n' '{"verdict":"PASS","findings":[]}'\nexit 0\n`,
    );
    const promptFile = join(dir, "p.txt");
    writeFileSync(promptFile, "review");
    writeFileSync(join(dir, "d.patch"), "diff");
    process.env.OC_ARGS_FILE = argsFile;
    const adapter = new OpenCodeAdapter({ binPath: bin });
    const base = {
      reviewerId: "opencode-x",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "security",
      diffPath: join(dir, "d.patch"),
    };

    await adapter.review({
      ...base,
      cfg: { enabled: true, auth: "oauth", model: "default", timeoutMs: 60_000 },
    });
    expect(readFileSync(argsFile, "utf8")).not.toContain("-m");

    await adapter.review({
      ...base,
      cfg: { enabled: true, auth: "oauth", model: "opencode/minimax-m2.7", timeoutMs: 60_000 },
    });
    const withModel = readFileSync(argsFile, "utf8");
    expect(withModel).toContain("-m");
    expect(withModel).toContain("opencode/minimax-m2.7");
    process.env.OC_ARGS_FILE = undefined;
  });

  it("exit 0 with unparseable stdout → verdict ERROR (not empty PASS)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-oc-garbage-"));
    const binPath = makeFakeBin(
      dir,
      "fake-opencode-garbage.sh",
      `#!/usr/bin/env bash\nprintf '%s\\n' 'garbage, not a review'\nexit 0\n`,
    );
    const promptFile = join(dir, "prompt.txt");
    const diffPath = join(dir, "diff.patch");
    writeFileSync(promptFile, "review this");
    writeFileSync(diffPath, "diff --git a/a.ts b/a.ts");

    const adapter = new OpenCodeAdapter({ binPath });
    const result = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "minimax/minimax-m2.7", timeoutMs: 60_000 },
      reviewerId: "opencode-security",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "findings.md"),
      persona: "security",
      diffPath,
    });
    expect(result.verdict).toBe("ERROR");
    expect(result.status).toBe("error");
    expect(result.findings).toEqual([]);
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

describe("OpenCodeAdapter.complete (judge completion)", () => {
  it("returns the stdout text containing the judge JSON", async () => {
    const adapter = new OpenCodeAdapter({ binPath: FAKE_COMPLETE });
    const text = await adapter.complete("judge this", { model: "default", auth: "oauth" });
    expect(text).toContain('"contradicts":false');
  });

  it("throws on non-zero exit", async () => {
    process.env.RG_FAKE_FAIL = "1";
    const adapter = new OpenCodeAdapter({ binPath: FAKE_COMPLETE });
    await expect(adapter.complete("p", { model: "default", auth: "oauth" })).rejects.toThrow();
    Reflect.deleteProperty(process.env, "RG_FAKE_FAIL");
  });

  it("returns '' on empty stdout (no throw)", async () => {
    process.env.RG_FAKE_EMPTY = "1";
    const adapter = new OpenCodeAdapter({ binPath: FAKE_COMPLETE });
    const text = await adapter.complete("p", { model: "default", auth: "oauth" });
    expect(text).toBe("");
    Reflect.deleteProperty(process.env, "RG_FAKE_EMPTY");
  });
});
