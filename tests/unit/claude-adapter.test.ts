// tests/unit/claude-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../../src/providers/claude.ts";

const FAKE = join(process.cwd(), "tests/fixtures/fake-claude.sh");
const FAKE_COMPLETE = join(process.cwd(), "tests/fixtures/fake-claude-complete.sh");

/** Helper: write a temp executable bash script and return its path. */
function makeFakeBin(dir: string, name: string, script: string): string {
  const p = join(dir, name);
  writeFileSync(p, script, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

describe("ClaudeAdapter (mocked)", () => {
  it("parses findings + usage from the result envelope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-cl-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const adapter = new ClaudeAdapter({ binPath: FAKE });
    const res = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "claude-sonnet-4-6", timeoutMs: 60_000 },
      reviewerId: "claude-adversarial",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "adversarial",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.status).toBe("ok");
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]?.reviewer.provider).toBe("claude-code");
    expect(res.usage.inputTokens).toBe(300);
    expect(res.usage.outputTokens).toBe(40);
  });

  it("exit 0 with literal 'null' output → ERROR, no uncaught throw", async () => {
    // `JSON.parse("null")` returns null (valid JSON), so `env.result` would throw
    // an uncaught TypeError and crash the adapter instead of failing closed.
    const dir = mkdtempSync(join(tmpdir(), "rg-cl-null-"));
    const binPath = makeFakeBin(
      dir,
      "fake-claude-null.sh",
      "#!/usr/bin/env bash\nprintf '%s' 'null'\nexit 0\n",
    );
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const adapter = new ClaudeAdapter({ binPath });
    const res = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "claude-sonnet-4-6", timeoutMs: 60_000 },
      reviewerId: "claude-adversarial",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "adversarial",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.verdict).toBe("ERROR");
    expect(res.status).toBe("error");
  });

  it("exit 0 with unparseable output → verdict ERROR (not empty PASS)", async () => {
    // `claude -p --output-format json` buffers and can truncate before emitting
    // a valid result envelope. An exit-0 run with no parseable review must fail
    // CLOSED (status !== "ok" → excluded from okRuns), exactly like codex/opencode.
    const dir = mkdtempSync(join(tmpdir(), "rg-cl-garbage-"));
    const binPath = makeFakeBin(
      dir,
      "fake-claude-garbage.sh",
      "#!/usr/bin/env bash\nprintf '%s\\n' 'garbage, not a review'\nexit 0\n",
    );
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const adapter = new ClaudeAdapter({ binPath });
    const res = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "claude-sonnet-4-6", timeoutMs: 60_000 },
      reviewerId: "claude-adversarial",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "adversarial",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.verdict).toBe("ERROR");
    expect(res.status).toBe("error");
    expect(res.findings).toEqual([]);
  });
});

describe("ClaudeAdapter.complete (judge completion)", () => {
  it("returns the raw model text containing the judge JSON", async () => {
    const adapter = new ClaudeAdapter({ binPath: FAKE_COMPLETE });
    const text = await adapter.complete("judge this", {
      model: "claude-sonnet-4-6",
      auth: "oauth",
    });
    expect(text).toContain('"contradicts":false');
  });

  it("remaps apiKeyEnv -> ANTHROPIC_API_KEY only under auth=apikey", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
    process.env.RG_TEST_CL_KEY = "sentinel-cl";
    const adapter = new ClaudeAdapter({ binPath: FAKE_COMPLETE });
    const apikey = await adapter.complete("p", {
      model: "m",
      apiKeyEnv: "RG_TEST_CL_KEY",
      auth: "apikey",
    });
    expect(apikey).toContain("k=sentinel-cl");
    const oauth = await adapter.complete("p", {
      model: "m",
      apiKeyEnv: "RG_TEST_CL_KEY",
      auth: "oauth",
    });
    expect(oauth).toContain("k=NONE");
    Reflect.deleteProperty(process.env, "RG_TEST_CL_KEY");
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  });

  it("throws on non-zero exit (caller falls back to default)", async () => {
    process.env.RG_FAKE_FAIL = "1";
    const adapter = new ClaudeAdapter({ binPath: FAKE_COMPLETE });
    await expect(adapter.complete("p", { model: "m", auth: "oauth" })).rejects.toThrow();
    Reflect.deleteProperty(process.env, "RG_FAKE_FAIL");
  });

  it("returns '' on a result-less envelope (no throw)", async () => {
    process.env.RG_FAKE_EMPTY = "1";
    const adapter = new ClaudeAdapter({ binPath: FAKE_COMPLETE });
    const text = await adapter.complete("p", { model: "m", auth: "oauth" });
    expect(text).toBe("");
    Reflect.deleteProperty(process.env, "RG_FAKE_EMPTY");
  });

  it("surfaces a timeout as 'timeout' (not a bare exit=-1) in the error", async () => {
    process.env.RG_FAKE_SLOW = "1";
    const adapter = new ClaudeAdapter({ binPath: FAKE_COMPLETE });
    await expect(
      adapter.complete("p", { model: "m", auth: "oauth", timeoutMs: 200 }),
    ).rejects.toThrow(/timeout/);
    Reflect.deleteProperty(process.env, "RG_FAKE_SLOW");
  });

  it("cleans up its temp run dir on success (no leak)", async () => {
    // Isolate via a private TMPDIR so concurrent test PROCESSES (which also create
    // rg-cl-cmpl-* dirs in the shared os.tmpdir()) can't pollute the assertion —
    // os.tmpdir() honours TMPDIR at call time, and complete() mkdtemps under it.
    const isolated = mkdtempSync(join(tmpdir(), "rg-cl-tmpbase-"));
    const prevTmp = process.env.TMPDIR;
    process.env.TMPDIR = isolated;
    try {
      const adapter = new ClaudeAdapter({ binPath: FAKE_COMPLETE });
      await adapter.complete("judge this", { model: "m", auth: "oauth" });
      const leaked = readdirSync(isolated).filter((n) => n.startsWith("rg-cl-cmpl-"));
      expect(leaked).toEqual([]);
    } finally {
      if (prevTmp === undefined) Reflect.deleteProperty(process.env, "TMPDIR");
      else process.env.TMPDIR = prevTmp;
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
