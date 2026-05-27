// tests/unit/codex-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../../src/providers/codex.ts";

const PRETEND_CODEX_BIN = join(process.cwd(), "tests/fixtures/fake-codex.sh");
const FAKE_CODEX_COMPLETE = join(process.cwd(), "tests/fixtures/fake-codex-complete.sh");
const ATTEMPT_BIN = join(process.cwd(), "tests/fixtures/fake-codex-attempt.sh");

function makeReviewInput(dir: string, persona = "plan") {
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "REVIEW_PROMPT_BODY");
  writeFileSync(join(dir, "diff.patch"), "diff");
  return {
    cfg: { enabled: true, auth: "oauth" as const, model: "gpt-5.4", timeoutMs: 60_000 },
    reviewerId: "codex-plan",
    promptFile,
    workingDir: dir,
    findingsPath: join(dir, "findings.md"),
    persona,
    diffPath: join(dir, "diff.patch"),
  };
}

// Fake codex that exits 0 but writes NON-JSON to --output-last-message (mirrors a
// truncated / malformed real run that still exits cleanly), plus a valid usage event.
const GARBAGE_CODEX_SCRIPT = `#!/usr/bin/env bash
set -u
LAST_MSG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output-last-message) LAST_MSG="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$LAST_MSG" ] && printf '%s' 'this is not json {{{' > "$LAST_MSG"
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20,"cached_input_tokens":50}}'
exit 0
`;

describe("CodexAdapter (mocked binary)", () => {
  it("parses findings and usage from a fake codex run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-codex-"));
    const promptFile = join(dir, "prompt.txt");
    const findingsPath = join(dir, "findings.md");
    const diffPath = join(dir, "diff.patch");
    writeFileSync(promptFile, "review this");
    writeFileSync(diffPath, "diff --git a/x b/x");

    const adapter = new CodexAdapter({ binPath: PRETEND_CODEX_BIN });
    const result = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "gpt-5.4", timeoutMs: 60_000 },
      reviewerId: "codex-security",
      promptFile,
      workingDir: dir,
      findingsPath,
      persona: "security",
      diffPath,
    });
    expect(result.status).toBe("ok");
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it("exit 0 with unparseable last-message → verdict ERROR (not empty PASS)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-codex-garbage-"));
    const binPath = join(dir, "fake-codex-garbage.sh");
    writeFileSync(binPath, GARBAGE_CODEX_SCRIPT, { mode: 0o755 });
    chmodSync(binPath, 0o755);
    const promptFile = join(dir, "prompt.txt");
    const diffPath = join(dir, "diff.patch");
    writeFileSync(promptFile, "review this");
    writeFileSync(diffPath, "diff --git a/x b/x");

    const adapter = new CodexAdapter({ binPath });
    const result = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "gpt-5.4", timeoutMs: 60_000 },
      reviewerId: "codex-security",
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

  it("B: review() passes --disable shell_tool before the prompt positional", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-codex-args-"));
    const argvFile = join(dir, "argv.txt");
    const bin = join(dir, "fake-argv.sh");
    writeFileSync(
      bin,
      `#!/usr/bin/env bash
set -u
: > "${argvFile}"
for a in "$@"; do printf '%s\\n' "$a" >> "${argvFile}"; done
LAST_MSG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output-last-message) LAST_MSG="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$LAST_MSG" ] && printf '%s' '{"verdict":"PASS","findings":[]}' > "$LAST_MSG"
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1,"cached_input_tokens":0}}'
exit 0
`,
      { mode: 0o755 },
    );
    chmodSync(bin, 0o755);
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "REVIEW_PROMPT_BODY");
    writeFileSync(join(dir, "diff.patch"), "diff");

    const adapter = new CodexAdapter({ binPath: bin });
    const result = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "gpt-5.4", timeoutMs: 60_000 },
      reviewerId: "codex-plan",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "findings.md"),
      persona: "plan",
      diffPath: join(dir, "diff.patch"),
    });
    expect(result.status).toBe("ok");

    const argv = readFileSync(argvFile, "utf8").split("\n");
    const di = argv.indexOf("--disable");
    expect(di).toBeGreaterThanOrEqual(0);
    expect(argv[di + 1]).toBe("shell_tool");
    expect(argv).toContain("--output-schema");
    expect(argv).toContain("--output-last-message");
    expect(argv.filter((x) => x.length > 0).pop()).toBe("REVIEW_PROMPT_BODY");
    expect(di).toBeLessThan(argv.lastIndexOf("REVIEW_PROMPT_BODY"));
  });

  it("3f: exit-0 empty last-message with quota banner → quota-exhausted, one spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-codex-q-"));
    const counter = join(dir, "count.txt");
    writeFileSync(counter, "");
    process.env.RG_FAKE_COUNTER = counter;
    process.env.RG_FAKE_A1 = "quota";
    process.env.RG_FAKE_A2 = "none";
    try {
      const adapter = new CodexAdapter({ binPath: ATTEMPT_BIN });
      const result = await adapter.review(makeReviewInput(dir));
      expect(result.status).toBe("quota-exhausted");
      expect(readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).length).toBe(1);
      expect(result.statusDetail ?? "").not.toContain("(after retry)");
    } finally {
      Reflect.deleteProperty(process.env, "RG_FAKE_COUNTER");
      Reflect.deleteProperty(process.env, "RG_FAKE_A1");
      Reflect.deleteProperty(process.env, "RG_FAKE_A2");
    }
  });
});

describe("CodexAdapter.complete (judge completion)", () => {
  it("returns the last-message text and passes NO --output-schema", async () => {
    // If complete() wrongly passed --output-schema, the fake exits 3 -> throw.
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX_COMPLETE });
    const text = await adapter.complete("judge this", { model: "gpt-x", auth: "oauth" });
    expect(text).toContain('"contradicts":false');
  });

  it("remaps apiKeyEnv -> OPENAI_API_KEY only under auth=apikey", async () => {
    const prev = process.env.OPENAI_API_KEY;
    Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
    process.env.RG_TEST_CDX_KEY = "sentinel-cdx";
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX_COMPLETE });
    const apikey = await adapter.complete("p", {
      model: "m",
      apiKeyEnv: "RG_TEST_CDX_KEY",
      auth: "apikey",
    });
    expect(apikey).toContain("k=sentinel-cdx");
    const oauth = await adapter.complete("p", {
      model: "m",
      apiKeyEnv: "RG_TEST_CDX_KEY",
      auth: "oauth",
    });
    expect(oauth).toContain("k=NONE");
    Reflect.deleteProperty(process.env, "RG_TEST_CDX_KEY");
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  });

  it("throws on non-zero exit", async () => {
    process.env.RG_FAKE_FAIL = "1";
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX_COMPLETE });
    await expect(adapter.complete("p", { model: "m", auth: "oauth" })).rejects.toThrow();
    Reflect.deleteProperty(process.env, "RG_FAKE_FAIL");
  });

  it("returns '' on an empty last-message file (no throw)", async () => {
    process.env.RG_FAKE_EMPTY = "1";
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX_COMPLETE });
    const text = await adapter.complete("p", { model: "m", auth: "oauth" });
    expect(text).toBe("");
    Reflect.deleteProperty(process.env, "RG_FAKE_EMPTY");
  });
});
