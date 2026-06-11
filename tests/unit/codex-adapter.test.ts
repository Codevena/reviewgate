// tests/unit/codex-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
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
    cfg: { enabled: true, auth: "oauth" as const, model: "gpt-5.5", timeoutMs: 60_000 },
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
      cfg: { enabled: true, auth: "oauth", model: "gpt-5.5", timeoutMs: 60_000 },
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
      cfg: { enabled: true, auth: "oauth", model: "gpt-5.5", timeoutMs: 60_000 },
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
      cfg: { enabled: true, auth: "oauth", model: "gpt-5.5", timeoutMs: 60_000 },
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
  });

  it("B2: complete() (judge path) ALSO passes --disable shell_tool (F-044)", async () => {
    // The judge/critic path must disable shell_tool too — agentic exec_command
    // exploration ends the turn without a final message, so complete() returns ""
    // and the judge silently no-ops to its default (no retry, unlike review()).
    const dir = mkdtempSync(join(tmpdir(), "rg-codex-cmpl-args-"));
    const argvFile = join(dir, "argv.txt");
    const bin = join(dir, "fake-cmpl-argv.sh");
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
[ -n "$LAST_MSG" ] && printf '%s' '{"contradicts":false}' > "$LAST_MSG"
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1,"cached_input_tokens":0}}'
exit 0
`,
      { mode: 0o755 },
    );
    chmodSync(bin, 0o755);
    const adapter = new CodexAdapter({ binPath: bin });
    const text = await adapter.complete("judge this", { model: "gpt-5.5", auth: "oauth" });
    expect(text).toContain('"contradicts":false');
    const argv = readFileSync(argvFile, "utf8").split("\n");
    const di = argv.indexOf("--disable");
    expect(di).toBeGreaterThanOrEqual(0);
    expect(argv[di + 1]).toBe("shell_tool");
    // F-09: the prompt is delivered via stdin (`codex exec -`), never argv —
    // the trailing positional is the `-` stdin sentinel, not the prompt text.
    expect(argv.filter((x) => x.length > 0).pop()).toBe("-");
    expect(argv).not.toContain("judge this");
  });

  it("forwards a sandbox profile into the spawn (argv begins with sandbox-exec on macOS)", async () => {
    if (platform() !== "darwin") return;
    // Build a fake codex bin that records its own argv to a file and writes a
    // valid review JSON to --output-last-message. When sandbox-exec wraps this
    // bin, the fake IS the sandboxed command — so we can observe the argv that
    // reached the wrapped command and confirm it includes --output-last-message
    // (i.e. spawnSafely passed the original args through to the sandboxed bin).
    const dir = mkdtempSync(join(tmpdir(), "rg-codex-sbx-"));
    const argvFile = join(dir, "argv.txt");
    const bin = join(dir, "fake-sbx.sh");
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
      cfg: { enabled: true, auth: "oauth" as const, model: "gpt-5.5", timeoutMs: 60_000 },
      reviewerId: "codex-plan",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "findings.md"),
      persona: "plan",
      diffPath: join(dir, "diff.patch"),
      sandbox: {
        profile: {
          sandboxRequested: true,
          fs: { readAllow: [], readDeny: [], readDenyGlobs: [], writeAllow: [] },
          net: { allow: [] },
          budget: { walltimeMs: 30_000 },
        },
        mode: "strict",
      },
    });
    expect(result.status).toBe("ok");
    // The fake bin ran as the sandboxed command; its recorded argv must contain
    // --output-last-message, proving the wrapped command executed end-to-end.
    const argv = readFileSync(argvFile, "utf8").split("\n").filter(Boolean);
    expect(argv).toContain("--output-last-message");
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

// ---------------------------------------------------------------------------
// Retry-once tests (Task 4)
// ---------------------------------------------------------------------------

function spawnCount(counter: string): number {
  return readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).length;
}

async function runWithModes(a1: string, a2: string, prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const counter = join(dir, "count.txt");
  writeFileSync(counter, "");
  process.env.RG_FAKE_COUNTER = counter;
  process.env.RG_FAKE_A1 = a1;
  process.env.RG_FAKE_A2 = a2;
  try {
    const adapter = new CodexAdapter({ binPath: ATTEMPT_BIN });
    const result = await adapter.review(makeReviewInput(dir));
    return { result, spawns: spawnCount(counter) };
  } finally {
    Reflect.deleteProperty(process.env, "RG_FAKE_COUNTER");
    Reflect.deleteProperty(process.env, "RG_FAKE_A1");
    Reflect.deleteProperty(process.env, "RG_FAKE_A2");
  }
}

describe("CodexAdapter retry-once", () => {
  it("3: unparseable then valid → retries once, status ok, two spawns", async () => {
    const { result, spawns } = await runWithModes("garbage", "ok", "rg-codex-3-");
    expect(result.status).toBe("ok");
    expect(spawns).toBe(2);
  });

  it("3b: non-zero exit then valid → retries once, status ok, two spawns", async () => {
    const { result, spawns } = await runWithModes("exit7", "ok", "rg-codex-3b-");
    expect(result.status).toBe("ok");
    expect(spawns).toBe(2);
  });

  it("3c: unparseable then no-output → error (no stale parse), two spawns", async () => {
    const { result, spawns } = await runWithModes("garbage", "none", "rg-codex-3c-");
    expect(result.status).toBe("error");
    expect(spawns).toBe(2);
    expect(result.statusDetail ?? "").toContain("(after retry)");
  });

  it("3d: error then quota on retry → quota-exhausted unchanged (no suffix), two spawns", async () => {
    const { result, spawns } = await runWithModes("garbage", "quota", "rg-codex-3d-");
    expect(result.status).toBe("quota-exhausted");
    expect(spawns).toBe(2);
    expect(result.statusDetail ?? "").not.toContain("(after retry)");
  });

  it("3e: both non-zero error → error with (after retry) suffix, two spawns", async () => {
    const { result, spawns } = await runWithModes("exit7", "exit7", "rg-codex-3e-");
    expect(result.status).toBe("error");
    expect(spawns).toBe(2);
    expect(result.statusDetail ?? "").toContain("(after retry)");
  });

  it("valid first time → no retry, one spawn", async () => {
    const { result, spawns } = await runWithModes("ok", "none", "rg-codex-ok-");
    expect(result.status).toBe("ok");
    expect(spawns).toBe(1);
  });

  it("abort: pre-aborted signal → no retry (one spawn)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-codex-abort-"));
    const counter = join(dir, "count.txt");
    writeFileSync(counter, "");
    process.env.RG_FAKE_COUNTER = counter;
    process.env.RG_FAKE_A1 = "exit7";
    process.env.RG_FAKE_A2 = "ok";
    try {
      const adapter = new CodexAdapter({ binPath: ATTEMPT_BIN });
      const ac = new AbortController();
      ac.abort();
      const result = await adapter.review({ ...makeReviewInput(dir), signal: ac.signal });
      expect(spawnCount(counter)).toBeLessThanOrEqual(1);
      expect(result.status).not.toBe("ok");
    } finally {
      Reflect.deleteProperty(process.env, "RG_FAKE_COUNTER");
      Reflect.deleteProperty(process.env, "RG_FAKE_A1");
      Reflect.deleteProperty(process.env, "RG_FAKE_A2");
    }
  });

  // F-045: a deadline-abort must produce a clear, distinct statusDetail (so the
  // orchestrator's per-fallback "[fallback from <p>: <status>]" prefix and logs
  // read as a deliberate cut, not a muddy generic crash) and must NOT carry the
  // generic "(after retry)" suffix — abort skips the retry.
  it("abort: pre-aborted signal → statusDetail marks deadline-aborted, no retry suffix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-codex-abort-detail-"));
    const counter = join(dir, "count.txt");
    writeFileSync(counter, "");
    process.env.RG_FAKE_COUNTER = counter;
    process.env.RG_FAKE_A1 = "exit7";
    process.env.RG_FAKE_A2 = "ok";
    try {
      const adapter = new CodexAdapter({ binPath: ATTEMPT_BIN });
      const ac = new AbortController();
      ac.abort();
      const result = await adapter.review({ ...makeReviewInput(dir), signal: ac.signal });
      expect(result.status).toBe("error");
      expect(result.statusDetail ?? "").toContain("deadline-aborted");
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
