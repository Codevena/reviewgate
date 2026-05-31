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

  it("caps agy's review timeout at 90s even when the config asks for far more", async () => {
    // agy is a coding agent that either answers a small review fast or never (it
    // goes agentic and times out). Waiting the full configured 300s buys nothing,
    // so the adapter caps the agy review budget. A small configured timeout is
    // still honored as-is (see the 60000ms argv test above).
    const dir = mkdtempSync(join(tmpdir(), "rg-gem-cap-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const argsFile = join(dir, "argv.txt");
    process.env.RG_ARGS_OUT = argsFile;
    try {
      const adapter = new GeminiAdapter({ binPath: FAKE });
      await adapter.review({
        cfg: { enabled: true, auth: "oauth", model: "ignored", timeoutMs: 300_000 },
        reviewerId: "gemini-security",
        promptFile,
        workingDir: dir,
        findingsPath: join(dir, "f.md"),
        persona: "security",
        diffPath: join(dir, "d.patch"),
      });
      const argv = readFileSync(argsFile, "utf8").split("\n").filter(Boolean);
      expect(argv).toContain("--print-timeout");
      expect(argv).toContain("90000ms");
      expect(argv).not.toContain("300000ms");
    } finally {
      Reflect.deleteProperty(process.env, "RG_ARGS_OUT");
    }
  });

  it("exit 0 with agy's print-timeout sentinel → quota-exhausted (cooldown, not a generic error)", async () => {
    // The real failure mode: on a large review prompt agy runs an agentic loop,
    // gives up at --print-timeout, prints this exact line, and exits 0. It must
    // cool down + fail over, not be re-run (burning the full timeout) every turn.
    const dir = mkdtempSync(join(tmpdir(), "rg-gem-pt-"));
    const binPath = makeFakeBin(
      dir,
      "fake-gemini-printtimeout.sh",
      "#!/usr/bin/env bash\nprintf '%s\\n' 'Error: timed out waiting for response'\nexit 0\n",
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
    expect(res.status).toBe("quota-exhausted");
    expect(res.findings).toEqual([]);
    expect(res.statusDetail).toMatch(/print-timeout|agentic/i);
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

  it("exit 0 with a quota banner → status quota-exhausted (triggers cooldown/failover, F-043)", async () => {
    // agy can print a usage-limit banner and still exit 0. That must classify as
    // quota-exhausted (not a generic error or a clean PASS) so the orchestrator
    // cools the provider down and fails over instead of treating it as reviewed.
    const dir = mkdtempSync(join(tmpdir(), "rg-gem-quota0-"));
    const binPath = makeFakeBin(
      dir,
      "fake-gemini-quota.sh",
      "#!/usr/bin/env bash\nprintf '%s\\n' 'Error: resource_exhausted — usage limit'\nexit 0\n",
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
    expect(res.status).toBe("quota-exhausted");
  });
});

describe("GeminiAdapter.review — silent stall (agy quota hang)", () => {
  it("classifies a no-output watchdog/timeout kill as quota-exhausted (so it gets cooled down)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-gem-hang-"));
    // Fake agy that hangs producing nothing — mirrors a quota'd agy run
    // non-interactively (its banner is TTY-only). The adapter ties the zero-byte
    // watchdog to timeoutMs, so a small timeout kills the silent hang quickly.
    const hangBin = makeFakeBin(dir, "agy-hang.sh", "#!/usr/bin/env bash\nsleep 30\n");
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const adapter = new GeminiAdapter({ binPath: hangBin });
    const res = await adapter.review({
      // Tiny budget → the zero-byte watchdog (zeroByteWatchdogMs = budget) trips on
      // its first poll and SIGKILLs the silent hang; the wall-timeout backstop sits a
      // buffer above. The watchdog polls on a coarse 5s interval (spawn.ts), so allow
      // up to ~6s for the kill — see the explicit bun test timeout below.
      cfg: { enabled: true, auth: "oauth", model: "ignored", timeoutMs: 500 },
      reviewerId: "gemini-architecture",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "architecture",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.status).toBe("quota-exhausted");
    expect(res.verdict).toBe("ERROR");
    expect(res.statusDetail).toContain("TTY only");
  }, 12_000);
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
