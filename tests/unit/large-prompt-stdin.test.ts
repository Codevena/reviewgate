// tests/unit/large-prompt-stdin.test.ts
// Regression for the shoal "E2BIG: argument list too long" gate-closed bug
// (2026-06-02): the claude/gemini reviewer adapters passed the entire review
// prompt — research.md + the full review-base diff — as a single argv string
// (`-p "<prompt>"`). On a large batch (e.g. a fresh Tauri scaffold, ~7.6k lines)
// that prompt exceeds the OS ARG_MAX, so posix_spawn fails with E2BIG before the
// reviewer even starts → 0 reviewers ok → the gate fails closed on a non-finding.
// The fix delivers the prompt over STDIN (which `claude -p` / `agy -p` read),
// removing the argv-size ceiling entirely.
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../../src/providers/claude.ts";
import { CodexAdapter } from "../../src/providers/codex.ts";
import { GeminiAdapter } from "../../src/providers/gemini.ts";
import { OpenCodeAdapter } from "../../src/providers/opencode.ts";

/** Write a temp executable bash script and return its path. */
function makeFakeBin(dir: string, name: string, script: string): string {
  const p = join(dir, name);
  writeFileSync(p, script, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

// A fake `claude -p` that records its argv AND its stdin to files, then emits a
// valid result envelope — mirroring how the real CLI reads the prompt from stdin
// when run in a pipe (`cat prompt | claude -p`).
function makeStdinClaudeBin(dir: string, argvFile: string, stdinFile: string): string {
  return makeFakeBin(
    dir,
    "fake-claude-stdin.sh",
    `#!/usr/bin/env bash
set -u
: > "${argvFile}"
for a in "$@"; do printf '%s\\n' "$a" >> "${argvFile}"; done
cat > "${stdinFile}"
cat <<'JSON'
{"type":"result","subtype":"success","result":"{\\"verdict\\":\\"PASS\\",\\"findings\\":[]}","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1},"session_id":"fake"}
JSON
exit 0
`,
  );
}

// A fake `claude -p --output-format json` for complete(): records argv + stdin,
// then emits a result envelope whose `result` is a plain completion string.
function makeStdinCompleteBin(dir: string, argvFile: string, stdinFile: string): string {
  return makeFakeBin(
    dir,
    "fake-claude-complete-stdin.sh",
    `#!/usr/bin/env bash
set -u
: > "${argvFile}"
for a in "$@"; do printf '%s\\n' "$a" >> "${argvFile}"; done
cat > "${stdinFile}"
cat <<'JSON'
{"type":"result","subtype":"success","result":"COMPLETE_OK","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1},"session_id":"fake"}
JSON
exit 0
`,
  );
}

// ~2 MB: comfortably over macOS ARG_MAX (~1 MB total for argv+env), so passing
// this as a single argv element fails with E2BIG at posix_spawn — the real bug.
const HUGE = 2_000_000;
const MARKER = "REVIEWGATE_STDIN_MARKER";

describe("ClaudeAdapter — large prompt delivery (E2BIG regression)", () => {
  it("delivers a prompt larger than ARG_MAX via stdin, not argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-cl-big-"));
    const argvFile = join(dir, "argv.txt");
    const stdinCapture = join(dir, "stdin.txt");
    const bin = makeStdinClaudeBin(dir, argvFile, stdinCapture);
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, `${MARKER}\n${"x".repeat(HUGE)}`);
    const adapter = new ClaudeAdapter({ binPath: bin });

    // Currently throws "E2BIG: argument list too long" at spawn; after the fix the
    // spawn succeeds and yields a clean (empty-findings) review.
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
    // The prompt arrived via stdin...
    expect(readFileSync(stdinCapture, "utf8")).toContain(MARKER);
    // ...and was NOT placed in argv (that is what blew past ARG_MAX).
    expect(readFileSync(argvFile, "utf8")).not.toContain(MARKER);
  });

  it("complete() (judge/critic/curator) delivers a >ARG_MAX prompt via stdin too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-cl-cbig-"));
    const argvFile = join(dir, "argv.txt");
    const stdinCapture = join(dir, "stdin.txt");
    const bin = makeStdinCompleteBin(dir, argvFile, stdinCapture);
    const adapter = new ClaudeAdapter({ binPath: bin });

    const text = await adapter.complete(`${MARKER}\n${"x".repeat(HUGE)}`, {
      model: "claude-sonnet-4-6",
      auth: "oauth",
    });

    expect(text).toBe("COMPLETE_OK");
    expect(readFileSync(stdinCapture, "utf8")).toContain(MARKER);
    expect(readFileSync(argvFile, "utf8")).not.toContain(MARKER);
  });
});

// A fake `agy -p` that records argv + stdin then prints a bare review JSON verbatim
// (agy has no envelope — stdout IS the review). Mirrors the real CLI being driven
// with the prompt on stdin instead of as a positional argument.
function makeStdinAgyBin(dir: string, argvFile: string, stdinFile: string, stdout: string): string {
  return makeFakeBin(
    dir,
    "fake-agy-stdin.sh",
    `#!/usr/bin/env bash
set -u
: > "${argvFile}"
for a in "$@"; do printf '%s\\n' "$a" >> "${argvFile}"; done
cat > "${stdinFile}"
printf '%s\\n' '${stdout}'
exit 0
`,
  );
}

describe("GeminiAdapter (agy) — large prompt delivery (E2BIG regression)", () => {
  // NOTE: real-agy stdin verification is PENDING — agy is rate-limited (~2 days as of
  // 2026-06-02). A probe confirmed `agy -p` with no positional prompt does NOT reject
  // at argparse (the invocation shape is accepted), but whether agy semantically reads
  // the piped prompt must be re-confirmed against the live CLI once quota returns.
  it("review() delivers a prompt larger than ARG_MAX via stdin, not argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-agy-big-"));
    const argvFile = join(dir, "argv.txt");
    const stdinCapture = join(dir, "stdin.txt");
    const bin = makeStdinAgyBin(dir, argvFile, stdinCapture, '{"verdict":"PASS","findings":[]}');
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, `${MARKER}\n${"x".repeat(HUGE)}`);
    const adapter = new GeminiAdapter({ binPath: bin });

    const res = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "gemini", timeoutMs: 60_000 },
      reviewerId: "gemini-security",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "security",
      diffPath: join(dir, "d.patch"),
    });

    expect(res.status).toBe("ok");
    expect(readFileSync(stdinCapture, "utf8")).toContain(MARKER);
    expect(readFileSync(argvFile, "utf8")).not.toContain(MARKER);
  });

  it("complete() delivers a >ARG_MAX prompt via stdin too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-agy-cbig-"));
    const argvFile = join(dir, "argv.txt");
    const stdinCapture = join(dir, "stdin.txt");
    const bin = makeStdinAgyBin(dir, argvFile, stdinCapture, "COMPLETE_OK");
    const adapter = new GeminiAdapter({ binPath: bin });

    const text = await adapter.complete(`${MARKER}\n${"x".repeat(HUGE)}`, {
      model: "gemini",
      auth: "oauth",
    });

    expect(text).toContain("COMPLETE_OK");
    expect(readFileSync(stdinCapture, "utf8")).toContain(MARKER);
    expect(readFileSync(argvFile, "utf8")).not.toContain(MARKER);
  });
});

// A fake `codex exec` that records argv + stdin, writes a valid review JSON to
// the --output-last-message file, and emits a turn.completed usage event —
// mirroring the real CLI being driven with `codex exec -` (positional `-` means
// "read the prompt from stdin").
function makeStdinCodexBin(
  dir: string,
  argvFile: string,
  stdinFile: string,
  lastMsg: string,
): string {
  return makeFakeBin(
    dir,
    "fake-codex-stdin.sh",
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
cat > "${stdinFile}"
[ -n "$LAST_MSG" ] && printf '%s' '${lastMsg}' > "$LAST_MSG"
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1,"cached_input_tokens":0}}'
exit 0
`,
  );
}

describe("CodexAdapter — large prompt delivery (E2BIG regression, F-09)", () => {
  it("review() delivers a prompt larger than ARG_MAX via stdin (`codex exec -`), not argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-cdx-big-"));
    const argvFile = join(dir, "argv.txt");
    const stdinCapture = join(dir, "stdin.txt");
    const bin = makeStdinCodexBin(dir, argvFile, stdinCapture, '{"verdict":"PASS","findings":[]}');
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, `${MARKER}\n${"x".repeat(HUGE)}`);
    const adapter = new CodexAdapter({ binPath: bin });

    const res = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "gpt-5.5", timeoutMs: 60_000 },
      reviewerId: "codex-security",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "security",
      diffPath: join(dir, "d.patch"),
    });

    expect(res.status).toBe("ok");
    // The prompt arrived via stdin...
    expect(readFileSync(stdinCapture, "utf8")).toContain(MARKER);
    // ...and argv carries only the `-` stdin sentinel, never the prompt body.
    const argv = readFileSync(argvFile, "utf8");
    expect(argv).not.toContain(MARKER);
    expect(argv.split("\n").filter(Boolean).pop()).toBe("-");
  });

  it("complete() (judge/critic) delivers a >ARG_MAX prompt via stdin too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-cdx-cbig-"));
    const argvFile = join(dir, "argv.txt");
    const stdinCapture = join(dir, "stdin.txt");
    const bin = makeStdinCodexBin(dir, argvFile, stdinCapture, "COMPLETE_OK");
    const adapter = new CodexAdapter({ binPath: bin });

    const text = await adapter.complete(`${MARKER}\n${"x".repeat(HUGE)}`, {
      model: "gpt-5.5",
      auth: "oauth",
    });

    expect(text).toContain("COMPLETE_OK");
    expect(readFileSync(stdinCapture, "utf8")).toContain(MARKER);
    const argv = readFileSync(argvFile, "utf8");
    expect(argv).not.toContain(MARKER);
    expect(argv.split("\n").filter(Boolean).pop()).toBe("-");
  });

  it("review() retry attempt re-delivers the (augmented) prompt via stdin, not argv", async () => {
    // Attempt 1 exits 0 with an unparseable last-message → retriable error;
    // attempt 2 must carry prompt + retry directive over stdin as well.
    const dir = mkdtempSync(join(tmpdir(), "rg-cdx-retry-big-"));
    const argvFile = join(dir, "argv.txt");
    const stdinCapture = join(dir, "stdin.txt");
    const bin = makeFakeBin(
      dir,
      "fake-codex-retry-stdin.sh",
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
cat > "${stdinCapture}"
case "$LAST_MSG" in
  *last.2.md) [ -n "$LAST_MSG" ] && printf '%s' '{"verdict":"PASS","findings":[]}' > "$LAST_MSG" ;;
  *) [ -n "$LAST_MSG" ] && printf '%s' 'not json {{{' > "$LAST_MSG" ;;
esac
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1,"cached_input_tokens":0}}'
exit 0
`,
    );
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, `${MARKER}\n${"x".repeat(HUGE)}`);
    const adapter = new CodexAdapter({ binPath: bin });

    const res = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "gpt-5.5", timeoutMs: 60_000 },
      reviewerId: "codex-security",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "security",
      diffPath: join(dir, "d.patch"),
    });

    expect(res.status).toBe("ok");
    // Last (= retry) invocation: prompt + retry directive over stdin, argv clean.
    const stdinText = readFileSync(stdinCapture, "utf8");
    expect(stdinText).toContain(MARKER);
    expect(stdinText).toContain("Output ONLY the single JSON object");
    expect(readFileSync(argvFile, "utf8")).not.toContain(MARKER);
  });
});

// A fake `opencode run` that records argv + stdin then prints a bare review JSON
// to stdout — mirroring the real CLI reading the message from stdin when no
// positional message argument is given (live-verified, opencode 1.17.0).
function makeStdinOpencodeBin(
  dir: string,
  argvFile: string,
  stdinFile: string,
  stdout: string,
): string {
  return makeFakeBin(
    dir,
    "fake-opencode-stdin.sh",
    `#!/usr/bin/env bash
set -u
: > "${argvFile}"
for a in "$@"; do printf '%s\\n' "$a" >> "${argvFile}"; done
cat > "${stdinFile}"
printf '%s\\n' '${stdout}'
exit 0
`,
  );
}

describe("OpenCodeAdapter — large prompt delivery (E2BIG regression, F-10)", () => {
  it("review() delivers a prompt larger than ARG_MAX via stdin, not argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-oc-big-"));
    const argvFile = join(dir, "argv.txt");
    const stdinCapture = join(dir, "stdin.txt");
    const bin = makeStdinOpencodeBin(
      dir,
      argvFile,
      stdinCapture,
      '{"verdict":"PASS","findings":[]}',
    );
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, `${MARKER}\n${"x".repeat(HUGE)}`);
    const adapter = new OpenCodeAdapter({ binPath: bin });

    const res = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "default", timeoutMs: 60_000 },
      reviewerId: "opencode-security",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "security",
      diffPath: join(dir, "d.patch"),
    });

    expect(res.status).toBe("ok");
    expect(readFileSync(stdinCapture, "utf8")).toContain(MARKER);
    expect(readFileSync(argvFile, "utf8")).not.toContain(MARKER);
  });

  it("complete() delivers a >ARG_MAX prompt via stdin too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-oc-cbig-"));
    const argvFile = join(dir, "argv.txt");
    const stdinCapture = join(dir, "stdin.txt");
    const bin = makeStdinOpencodeBin(dir, argvFile, stdinCapture, "COMPLETE_OK");
    const adapter = new OpenCodeAdapter({ binPath: bin });

    const text = await adapter.complete(`${MARKER}\n${"x".repeat(HUGE)}`, {
      model: "default",
      auth: "oauth",
    });

    expect(text).toContain("COMPLETE_OK");
    expect(readFileSync(stdinCapture, "utf8")).toContain(MARKER);
    expect(readFileSync(argvFile, "utf8")).not.toContain(MARKER);
  });
});
