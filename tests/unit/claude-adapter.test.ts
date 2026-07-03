// tests/unit/claude-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  it("reviewer JSON whose only finding dies on the LINE-TYPE guard → status error, never PASS (S2)", async () => {
    // verdict FAIL, one finding with line as string "42" — fails the typeof
    // guard BEFORE any category handling → 0 mapped findings. Must fail closed
    // (ERROR), never silently collapse to an empty PASS.
    const dir = mkdtempSync(join(tmpdir(), "rg-cl-linetype-"));
    const binPath = makeFakeBin(
      dir,
      "fake-claude-linetype.sh",
      [
        "#!/usr/bin/env bash",
        "cat <<'JSON'",
        "{",
        '  "type": "result",',
        '  "subtype": "success",',
        '  "result": "{\\"verdict\\":\\"FAIL\\",\\"findings\\":[{\\"severity\\":\\"CRITICAL\\",\\"category\\":\\"correctness\\",\\"rule_id\\":\\"cl-rule\\",\\"file\\":\\"a.ts\\",\\"line\\":\\"42\\",\\"message\\":\\"bad line type\\",\\"details\\":\\"d\\",\\"confidence\\":0.9}]}",',
        '  "total_cost_usd": 0,',
        '  "usage": { "input_tokens": 10, "output_tokens": 5 },',
        '  "session_id": "fake"',
        "}",
        "JSON",
        "exit 0",
        "",
      ].join("\n"),
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
    expect(res.status).toBe("error");
    expect(res.verdict).toBe("ERROR");
    expect(res.findings).toEqual([]);
    expect(res.statusDetail ?? "").toMatch(
      /survived mapping|no blocking finding|blocking-severity/,
    );
    // Triageability (round-11 W4): the lossy-ERROR result points at the SAME
    // rawEventsPath the ok-path would have returned, and the counts ride along.
    expect(res.rawEventsPath).toBeTruthy();
    expect(res.rawEventsPath.endsWith("out.json")).toBe(true);
    expect(res.statusDetail ?? "").toMatch(/dropped \d+, blocking \d+/);
  });

  it("UNKNOWN category with an otherwise-valid finding also fails closed (S2, round-3 I1)", async () => {
    // verdict FAIL, one finding with category "vibes", numeric line 42 — passes
    // the typeof guard, dies in FindingSchema.safeParse → 0 mapped findings.
    const dir = mkdtempSync(join(tmpdir(), "rg-cl-unkcat-"));
    const binPath = makeFakeBin(
      dir,
      "fake-claude-unkcat.sh",
      [
        "#!/usr/bin/env bash",
        "cat <<'JSON'",
        "{",
        '  "type": "result",',
        '  "subtype": "success",',
        '  "result": "{\\"verdict\\":\\"FAIL\\",\\"findings\\":[{\\"severity\\":\\"CRITICAL\\",\\"category\\":\\"vibes\\",\\"rule_id\\":\\"cl-rule\\",\\"file\\":\\"a.ts\\",\\"line\\":42,\\"message\\":\\"bad category\\",\\"details\\":\\"d\\",\\"confidence\\":0.9}]}",',
        '  "total_cost_usd": 0,',
        '  "usage": { "input_tokens": 10, "output_tokens": 5 },',
        '  "session_id": "fake"',
        "}",
        "JSON",
        "exit 0",
        "",
      ].join("\n"),
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
    expect(res.status).toBe("error");
    expect(res.verdict).toBe("ERROR");
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

describe("ClaudeAdapter — hermetic spawn (no host MCP/hooks leak into the reviewer)", () => {
  // The hook-free temp CWD only escapes PROJECT-level .claude/settings.json. Without
  // these flags a nested `claude -p` still loads the HOST user-level ~/.claude (every
  // configured MCP server — incl. Gmail/Calendar/Drive connectors — plus SessionStart
  // hooks) into the reviewer subprocess: a blocking MCP init can stall it to the
  // watchdog, and the reviewer gains the host's connected-service access. Verified
  // live 2026-06-01: the flags cut injected host context ~10.3K→5.5K tokens (-40%
  // cost) with no slowdown and OAuth intact.
  function fakeArgvBin(dir: string, argvFile: string): string {
    return makeFakeBin(
      dir,
      "fake-claude-argv.sh",
      `#!/usr/bin/env bash
set -u
: > "${argvFile}"
for a in "$@"; do printf '%s\\n' "$a" >> "${argvFile}"; done
cat <<'JSON'
{"type":"result","subtype":"success","result":"{\\"verdict\\":\\"PASS\\",\\"findings\\":[]}","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1},"session_id":"fake"}
JSON
exit 0
`,
    );
  }

  it("review() passes --strict-mcp-config and --setting-sources project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-cl-argv-"));
    const argvFile = join(dir, "argv.txt");
    const bin = fakeArgvBin(dir, argvFile);
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const adapter = new ClaudeAdapter({ binPath: bin });
    const res = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "claude-sonnet-4-6", timeoutMs: 60_000 },
      reviewerId: "claude-security",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "security",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.status).toBe("ok");
    const argv = readFileSync(argvFile, "utf8").split("\n").filter(Boolean);
    expect(argv).toContain("--strict-mcp-config");
    const si = argv.indexOf("--setting-sources");
    expect(si).toBeGreaterThanOrEqual(0);
    expect(argv[si + 1]).toBe("project");
  });

  it("complete() (judge) is hermetic too — same flags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-cl-cargv-"));
    const argvFile = join(dir, "argv.txt");
    const bin = fakeArgvBin(dir, argvFile);
    const adapter = new ClaudeAdapter({ binPath: bin });
    await adapter.complete("judge this", { model: "claude-sonnet-4-6", auth: "oauth" });
    const argv = readFileSync(argvFile, "utf8").split("\n").filter(Boolean);
    expect(argv).toContain("--strict-mcp-config");
    const si = argv.indexOf("--setting-sources");
    expect(si).toBeGreaterThanOrEqual(0);
    expect(argv[si + 1]).toBe("project");
  });
});
