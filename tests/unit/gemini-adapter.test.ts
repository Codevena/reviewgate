// tests/unit/gemini-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiAdapter } from "../../src/providers/gemini.ts";

const FAKE = join(process.cwd(), "tests/fixtures/fake-gemini.sh");
const FAKE_COMPLETE = join(process.cwd(), "tests/fixtures/fake-gemini-complete.sh");

/** Helper: write a temp executable bash script and return its path. */
function makeFakeBin(dir: string, name: string, script: string): string {
  const p = join(dir, name);
  writeFileSync(p, script, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

describe("GeminiAdapter (agy, mocked)", () => {
  it("parses findings from plain stdout; usage is zero (agy has no token stats)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-gem-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const adapter = new GeminiAdapter({ binPath: FAKE });
    const res = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "ignored", timeoutMs: 60_000 },
      reviewerId: "gemini-architecture",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "architecture",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.status).toBe("ok");
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]?.reviewer.provider).toBe("gemini");
    expect(res.usage.inputTokens).toBe(0);
    expect(res.usage.outputTokens).toBe(0);
  });

  it("spawns agy with the right argv: -p + skip-permissions, NO -m/-o/--add-dir/--approval-mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-gem-args-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const argsFile = join(dir, "argv.txt");
    process.env.RG_ARGS_OUT = argsFile;
    try {
      const adapter = new GeminiAdapter({ binPath: FAKE });
      await adapter.review({
        cfg: { enabled: true, auth: "oauth", model: "ignored", timeoutMs: 60_000 },
        reviewerId: "gemini-security",
        promptFile,
        workingDir: dir,
        findingsPath: join(dir, "f.md"),
        persona: "security",
        diffPath: join(dir, "d.patch"),
      });
      const argv = readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
      expect(argv).toContain("-p");
      expect(argv).toContain("--dangerously-skip-permissions");
      expect(argv).toContain("--print-timeout");
      expect(argv).toContain("60000ms");
      expect(argv).not.toContain("-m");
      expect(argv).not.toContain("-o");
      expect(argv).not.toContain("--add-dir");
      expect(argv).not.toContain("--approval-mode");
    } finally {
      Reflect.deleteProperty(process.env, "RG_ARGS_OUT");
    }
  });

  it("returns verdict ERROR + quota-exhausted status with no findings on a non-zero exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-gem-err-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    process.env.RG_FAKE_EXIT_FAIL = "1";
    try {
      const adapter = new GeminiAdapter({ binPath: FAKE });
      const res = await adapter.review({
        cfg: { enabled: true, auth: "oauth", model: "ignored", timeoutMs: 60_000 },
        reviewerId: "gemini-security",
        promptFile,
        workingDir: dir,
        findingsPath: join(dir, "f.md"),
        persona: "security",
        diffPath: join(dir, "d.patch"),
      });
      expect(res.verdict).toBe("ERROR");
      expect(res.status).toBe("quota-exhausted");
      expect(res.findings).toEqual([]);
      expect(res.usage.inputTokens).toBe(0);
      expect(res.usage.outputTokens).toBe(0);
    } finally {
      Reflect.deleteProperty(process.env, "RG_FAKE_EXIT_FAIL");
    }
  });

  it("exit 0 with unparseable stdout → verdict ERROR (not empty PASS)", async () => {
    // agy `-p` print mode buffers and can truncate before emitting valid JSON.
    // An exit-0 run with no parseable review must fail CLOSED (status !== "ok" →
    // excluded from okRuns), exactly like codex/opencode — never a silent empty PASS.
    const dir = mkdtempSync(join(tmpdir(), "rg-gem-garbage-"));
    const binPath = makeFakeBin(
      dir,
      "fake-gemini-garbage.sh",
      "#!/usr/bin/env bash\nprintf '%s\\n' 'garbage, not a review'\nexit 0\n",
    );
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const adapter = new GeminiAdapter({ binPath });
    const res = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "ignored", timeoutMs: 60_000 },
      reviewerId: "gemini-security",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "security",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.verdict).toBe("ERROR");
    expect(res.status).toBe("error");
    expect(res.findings).toEqual([]);
  });
});

describe("GeminiAdapter.complete (judge completion)", () => {
  it("returns the raw stdout text containing the judge JSON", async () => {
    const adapter = new GeminiAdapter({ binPath: FAKE_COMPLETE });
    const text = await adapter.complete("judge this", { model: "ignored", auth: "oauth" });
    expect(text).toContain('"contradicts":false');
  });

  it("throws on non-zero exit", async () => {
    process.env.RG_FAKE_FAIL = "1";
    try {
      const adapter = new GeminiAdapter({ binPath: FAKE_COMPLETE });
      await expect(adapter.complete("p", { model: "m", auth: "oauth" })).rejects.toThrow();
    } finally {
      Reflect.deleteProperty(process.env, "RG_FAKE_FAIL");
    }
  });

  it("returns '' on empty stdout (no throw)", async () => {
    process.env.RG_FAKE_EMPTY = "1";
    try {
      const adapter = new GeminiAdapter({ binPath: FAKE_COMPLETE });
      const text = await adapter.complete("p", { model: "m", auth: "oauth" });
      expect(text).toBe("");
    } finally {
      Reflect.deleteProperty(process.env, "RG_FAKE_EMPTY");
    }
  });
});
