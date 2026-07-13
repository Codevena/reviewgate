import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import {
  __resetBwrapCache,
  __resetSandboxExecCache,
  bwrapAvailable,
  sandboxExecAvailable,
} from "../../src/sandbox/availability.ts";
import { buildSandboxProfile } from "../../src/sandbox/profile-builder.ts";
import { buildMacosSbpl, globToSbplRegex } from "../../src/sandbox/sbpl.ts";

// ── Finding 1: own-cred-under-deny overlap is dead-on-arrival ───────────────
describe("buildSandboxProfile — own-cred / readDeny overlap (F: dead-on-arrival)", () => {
  it("stock defaults never grant broad write access to .reviewgate control-plane state", () => {
    expect(defaultConfig.sandbox.writablePaths).toEqual([]);
    const p = buildSandboxProfile({
      providerId: "codex",
      mode: "strict",
      workingDir: "/repo",
      findingsPath: "/repo/.reviewgate/findings/codex.md",
      tmpDir: "/tmp/rg-run-1",
      writablePaths: defaultConfig.sandbox.writablePaths,
      deniedReads: defaultConfig.sandbox.deniedReads,
    });
    expect(p.fs.writeAllow).not.toContain("/repo/.reviewgate/");
    expect(p.fs.writeAllow).not.toContain("/repo/.reviewgate/state.json");
    expect(p.fs.writeAllow).not.toContain("/repo/.reviewgate/control-plane.json");
    expect(p.fs.writeAllow).toContain("/repo/.reviewgate/findings/codex.md");
  });

  it("does NOT throw building an SBPL with the STOCK default config (no ~/.config deny over own-cred)", () => {
    // Reproduce the real call shape: feed the shipped default sandbox config in.
    // Pre-fix this threw `SBPL conflict … nested` because a "~/.config" deny nested
    // over the codex own-cred write-allow "~/.config/codex".
    const p = buildSandboxProfile({
      providerId: "codex",
      mode: "strict",
      workingDir: "/repo",
      findingsPath: "/repo/.reviewgate/findings/codex.md",
      tmpDir: "/tmp/rg-run-1",
      writablePaths: defaultConfig.sandbox.writablePaths,
      deniedReads: defaultConfig.sandbox.deniedReads,
    });
    expect(() => buildMacosSbpl(p)).not.toThrow();
  });

  it("default deniedReads no longer contains the over-broad ~/.config", () => {
    expect(defaultConfig.sandbox.deniedReads).not.toContain("~/.config");
  });

  it("still denies a foreign secret dir (~/.ssh) under the stock default config", () => {
    const p = buildSandboxProfile({
      providerId: "codex",
      mode: "strict",
      workingDir: "/repo",
      findingsPath: "/repo/.reviewgate/findings/codex.md",
      tmpDir: "/tmp/rg-run-1",
      writablePaths: defaultConfig.sandbox.writablePaths,
      deniedReads: defaultConfig.sandbox.deniedReads,
    });
    expect(p.fs.readDeny).toContain("~/.ssh");
    const sbpl = buildMacosSbpl(p);
    expect(sbpl).toContain('(subpath "~/.ssh")');
  });

  it("filters a user deniedReads ancestor of an OWN-cred dir, but keeps a FOREIGN-cred deny", () => {
    // codex own-cred dirs include ~/.config/codex; a "~/.config" user deny would
    // nest over it → must be dropped. A foreign provider's cred dir (claude's
    // ~/.config/claude) is still masked via the `others` list.
    const p = buildSandboxProfile({
      providerId: "codex",
      mode: "strict",
      workingDir: "/repo",
      findingsPath: "/repo/.reviewgate/findings/codex.md",
      tmpDir: "/tmp/rg-run-1",
      deniedReads: ["~/.config"],
    });
    expect(p.fs.readDeny).not.toContain("~/.config");
    // Foreign provider (claude-code) cred dir still denied.
    expect(p.fs.readDeny.some((d) => d.includes(".config/claude"))).toBe(true);
    expect(() => buildMacosSbpl(p)).not.toThrow();
  });
});

// ── Finding 3: relative writablePaths resolve against repoRoot, not $HOME ────
describe("buildSandboxProfile — relative writablePaths resolve against repo root", () => {
  it("joins a relative writablePath onto workingDir (repo root), not $HOME", () => {
    const p = buildSandboxProfile({
      providerId: "codex",
      mode: "strict",
      workingDir: "/repo",
      findingsPath: "/repo/.reviewgate/findings/codex.md",
      tmpDir: "/tmp/rg-run-1",
      writablePaths: [".reviewgate/"],
    });
    // node:path join keeps a trailing slash from the last segment.
    expect(p.fs.writeAllow).toContain("/repo/.reviewgate/");
    // It must NOT leave the bare relative entry (which spawn.ts would join onto $HOME).
    expect(p.fs.writeAllow).not.toContain(".reviewgate/");
    expect(p.fs.writeTargets?.some((t) => t.path === "/repo/.reviewgate/")).toBe(true);
  });

  it("leaves an absolute or ~-prefixed writablePath untouched", () => {
    const p = buildSandboxProfile({
      providerId: "codex",
      mode: "strict",
      workingDir: "/repo",
      findingsPath: "/repo/.reviewgate/findings/codex.md",
      tmpDir: "/tmp/rg-run-1",
      writablePaths: ["/abs/cache", "~/.cache/rg"],
    });
    expect(p.fs.writeAllow).toContain("/abs/cache");
    expect(p.fs.writeAllow).toContain("~/.cache/rg");
  });
});

// ── Finding 2: SBPL raw-regex-literal injection via glob denies ─────────────
describe('globToSbplRegex — cannot break out of the #"…" literal (F: injection)', () => {
  it("strips a double-quote so it cannot terminate the regex literal early", () => {
    const out = globToSbplRegex('evil".pem');
    // `#"…"` is a RAW regex literal (no string-escape layer; backslashes are verbatim),
    // so an embedded `"` cannot be escaped — it MUST be removed. No interior quote.
    const inner = out.slice(2, -1); // strip leading #" and trailing "
    expect(inner).not.toContain('"');
    expect(out.startsWith('#"')).toBe(true);
    expect(out.endsWith('$"')).toBe(true);
  });

  it("strips a newline / CR / NUL so it cannot corrupt the lexer", () => {
    const out = globToSbplRegex("a\nb\r.key\0");
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\r");
    expect(out).not.toContain("\0");
  });

  it('a `"`-bearing glob keeps the (deny file-read* …) line balanced (no orphaned tail)', () => {
    const sbpl = buildMacosSbpl({
      sandboxRequested: true,
      fs: { readAllow: [], readDeny: [], readDenyGlobs: ['x".key', "a(b)"], writeAllow: [] },
      net: { allow: [] },
      budget: { walltimeMs: 300_000 },
    });
    expect(sbpl).toContain("(regex ");
    const denyLine = sbpl.split("\n").find((l) => l.includes("(deny file-read*")) ?? "";
    // A stray `"` would have closed a literal early, leaving an ODD quote count and
    // orphaning the rest of the rule. Balanced literals → even count.
    const quotes = (denyLine.match(/"/g) ?? []).length;
    expect(quotes % 2).toBe(0);
  });

  it("does NOT double regex backslashes — raw literal, single-backslash form unchanged", () => {
    // Matches the existing sbpl.test.ts contract and the design spec's `#"…\.env$"`.
    expect(globToSbplRegex("*.pem")).toBe('#"(^|/)[^/]*\\.pem$"');
    expect(globToSbplRegex(".env")).toBe('#"(^|/)\\.env$"');
  });
});

// ── Finding 4: availability probes are bounded (don't hang forever) ─────────
describe("sandbox availability probes are bounded", () => {
  it("sandboxExecAvailable resolves well under the wall-clock budget (no unbounded hang)", async () => {
    __resetSandboxExecCache();
    const start = Date.now();
    const r = await sandboxExecAvailable();
    expect(typeof r).toBe("boolean");
    // PROBE_TIMEOUT_MS is 5s; a healthy probe finishes far sooner. This guards the
    // regression where a missing timeout let a hung probe block forever.
    expect(Date.now() - start).toBeLessThan(8_000);
  });

  it("bwrapAvailable resolves well under the wall-clock budget", async () => {
    __resetBwrapCache();
    const start = Date.now();
    const r = await bwrapAvailable();
    expect(typeof r).toBe("boolean");
    expect(Date.now() - start).toBeLessThan(8_000);
  });
});
