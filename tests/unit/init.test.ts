import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hooksInstalled, runInit } from "../../src/cli/commands/init.ts";
import { loadConfig } from "../../src/config/loader.ts";

function tmp() {
  return mkdtempSync(join(tmpdir(), "rg-init-"));
}

describe("hooksInstalled", () => {
  it("is false on a fresh repo (no settings.json) and true after runInit", async () => {
    const repo = tmp();
    expect(hooksInstalled(repo)).toBe(false);
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    expect(hooksInstalled(repo)).toBe(true);
  });

  it("scaffolds a bounded SessionStart hook (timeout, so a wedged reset can't stall start)", async () => {
    const repo = tmp();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string; timeout?: number }> }> };
    };
    const reset = settings.hooks.SessionStart.flatMap((g) => g.hooks).find((h) =>
      h.command.includes(".reviewgate/bin/reset"),
    );
    expect(reset?.timeout).toBe(30);
  });

  it("shell-quotes the hook command paths so a repo path with spaces doesn't word-split", async () => {
    const repo = tmp();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const allCmds = Object.values(settings.hooks)
      .flat()
      .flatMap((g) => g.hooks)
      .map((h) => h.command)
      .filter((c) => c.includes(".reviewgate/bin/"));
    expect(allCmds.length).toBeGreaterThanOrEqual(3); // trigger + gate + reset
    for (const cmd of allCmds) {
      // The path must be wrapped in double-quotes so ${CLAUDE_PROJECT_DIR} (which can
      // contain spaces) is protected from shell word-splitting.
      expect(cmd).toBe(`"${cmd.replace(/^"|"$/g, "")}"`);
      expect(cmd.startsWith('"${CLAUDE_PROJECT_DIR}/.reviewgate/bin/')).toBe(true);
      expect(cmd.endsWith('"')).toBe(true);
    }
  });

  it("is false when settings.json exists but has no reviewgate hooks", async () => {
    const repo = tmp();
    await Bun.write(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "echo hi" }] }] } }),
    );
    expect(hooksInstalled(repo)).toBe(false);
  });

  it("is false and does not throw when settings.json contains invalid/garbage JSON", async () => {
    const repo = tmp();
    const settingsDir = join(repo, ".claude");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, "settings.json"), "garbage value { invalid json");
    expect(hooksInstalled(repo)).toBe(false);
  });

  it("is false and does not throw when settings.json has incorrect structure", async () => {
    const repo = tmp();
    const settingsDir = join(repo, ".claude");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(settingsDir, { recursive: true });

    // hooks is null
    writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({ hooks: null }));
    expect(hooksInstalled(repo)).toBe(false);

    // hooks is a string
    writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({ hooks: "not-an-object" }));
    expect(hooksInstalled(repo)).toBe(false);

    // hooks.Stop is not an array
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({ hooks: { Stop: { matcher: "*", hooks: [] } } }),
    );
    expect(hooksInstalled(repo)).toBe(false);

    // entries in hooks.Stop don't have hooks array
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ matcher: "*" }] } }),
    );
    expect(hooksInstalled(repo)).toBe(false);
  });
});

describe("runInit", () => {
  it("creates .claude/settings.json with Reviewgate hooks merged in", async () => {
    const repo = tmp();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(s.hooks).toBeDefined();
    expect(Array.isArray(s.hooks.PostToolUse)).toBe(true);
    expect(Array.isArray(s.hooks.Stop)).toBe(true);
    expect(Array.isArray(s.hooks.SessionStart)).toBe(true);
    expect(JSON.stringify(s.hooks).includes(".reviewgate/bin/")).toBe(true);
  });

  it("copies bin templates to .reviewgate/bin/ and makes them executable", async () => {
    const repo = tmp();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    for (const f of ["trigger", "gate", "reset"]) {
      const p = join(repo, ".reviewgate", "bin", f);
      expect(existsSync(p)).toBe(true);
      const stat = await (await import("node:fs/promises")).stat(p);
      // Owner-exec bit set
      expect(stat.mode & 0o100).toBeGreaterThan(0);
    }
  });

  it("appends Reviewgate entries to .gitignore without duplicating existing lines", async () => {
    const repo = tmp();
    // Pre-existing .gitignore with one of our lines
    await Bun.write(join(repo, ".gitignore"), "node_modules\n.reviewgate/audit/\n");
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const gi = readFileSync(join(repo, ".gitignore"), "utf8");
    expect((gi.match(/\.reviewgate\/audit\//g) ?? []).length).toBe(1);
    expect(gi).toContain(".reviewgate/state.json");
  });

  it("is idempotent: running twice does not duplicate hooks", async () => {
    const repo = tmp();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(s.hooks.Stop.length).toBe(1);
    expect(s.hooks.PostToolUse.length).toBe(1);
  });

  it("rejects an invalid --mode with a clean, user-facing message (no internal 'M1' jargon)", async () => {
    const repo = tmp();
    let err: Error | undefined;
    try {
      // Cast: simulating a bad value that the CLI flag could pass through.
      await runInit({ repoRoot: repo, mode: "foo" as "agent-loop" });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = err?.message ?? "";
    // Must not leak the internal milestone codename.
    expect(msg).not.toContain("M1");
    // Must name the offending value and the only valid one.
    expect(msg).toContain("foo");
    expect(msg).toContain("agent-loop");
  });

  it("scaffolds a reviewgate.config.ts that validates with fpLedger + brain + codex curator on", async () => {
    const repo = tmp();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const cfgPath = join(repo, "reviewgate.config.ts");
    expect(existsSync(cfgPath)).toBe(true);
    // Must load + validate through the real loader (catches a malformed scaffold).
    const cfg = await loadConfig(cfgPath);
    expect(cfg.phases.fpLedger?.enabled).toBe(true);
    expect(cfg.phases.brain?.enabled).toBe(true);
    expect(cfg.phases.brain?.curator?.provider).toBe("opencode");
    // openrouter must be enabled — the brain's embeddings depend on it.
    expect(cfg.providers.openrouter?.enabled).toBe(true);
    expect(cfg.phases.brain?.embeddings.provider).toBe("openrouter");
    // The scaffold MUST pin the upstream provider, else OpenRouter routes
    // deepseek/* to an arbitrary (expensive) upstream — real money.
    expect(cfg.providers.openrouter?.model).toBe("deepseek/deepseek-v4-flash");
    expect(cfg.providers.openrouter?.openrouterProvider).toEqual({ only: ["alibaba"] });
    // openrouter (deepseek-flash) is a low-precision PAID model — it must NOT be a reviewer
    // failover by default (new users shouldn't fall to it when codex is quota'd). The free
    // OAuth chain covers failover; openrouter stays enabled for EMBEDDINGS only. Matches the
    // defaults.ts + setup-wizard chain.
    const codexReviewer = cfg.phases.review.reviewers?.[0];
    expect(codexReviewer?.fallback ?? []).toEqual(["gemini", "claude-code"]);
    expect(codexReviewer?.fallback ?? []).not.toContain("openrouter");
  });
});

describe("runInit .gitignore — nested coverage + migration (P9)", () => {
  function gitInit(repo: string) {
    execFileSync("git", ["init", "-q"], { cwd: repo });
  }
  // git check-ignore -q exits 0 when the path IS ignored, 1 when it is not.
  function isIgnored(repo: string, path: string): boolean {
    try {
      execFileSync("git", ["check-ignore", "-q", "--", path], { cwd: repo });
      return true;
    } catch {
      return false;
    }
  }

  it("ignores nested AND top-level .reviewgate/ runtime state, keeping golden cassettes trackable at every depth", async () => {
    const repo = tmp();
    gitInit(repo);
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    // nested runtime state must be ignored (the field-report leak)
    expect(isIgnored(repo, "backend/.reviewgate/state.json")).toBe(true);
    expect(isIgnored(repo, "backend/.reviewgate/audit/x.json")).toBe(true);
    expect(isIgnored(repo, "packages/api/.reviewgate/cache/y.json")).toBe(true);
    // top-level runtime state still ignored
    expect(isIgnored(repo, ".reviewgate/state.json")).toBe(true);
    expect(isIgnored(repo, ".reviewgate/cassettes/run1.json")).toBe(true);
    // golden cassettes remain trackable at root AND nested (the re-include trap)
    expect(isIgnored(repo, ".reviewgate/cassettes/golden/g.json")).toBe(false);
    expect(isIgnored(repo, "backend/.reviewgate/cassettes/golden/g.json")).toBe(false);
    // committed brain memory stays trackable (must NOT be ignored)
    expect(isIgnored(repo, ".reviewgate/brain/brain.json")).toBe(false);
    expect(isIgnored(repo, ".reviewgate/brain/brain.md")).toBe(false);
    // but brain runtime subdirs are ignored
    expect(isIgnored(repo, ".reviewgate/brain/proposals/pool/p.json")).toBe(true);
  });

  it("ignores the field-reported newly-leaking artifacts (reputation.json, quota-cooldowns.json, learnings/, plan-review.*)", async () => {
    const repo = tmp();
    gitInit(repo);
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    expect(isIgnored(repo, ".reviewgate/reputation.json")).toBe(true);
    expect(isIgnored(repo, ".reviewgate/quota-cooldowns.json")).toBe(true);
    expect(isIgnored(repo, ".reviewgate/learnings/x.json")).toBe(true);
    expect(isIgnored(repo, ".reviewgate/plan-review.md")).toBe(true);
    expect(isIgnored(repo, "backend/.reviewgate/reputation.json")).toBe(true);
  });

  it("migrates a pre-P9 root-anchored .gitignore: strips stale lines, preserves user lines + order, idempotent", async () => {
    const repo = tmp();
    gitInit(repo);
    // Simulate a repo init'd before P9: the prior root-anchored block + unrelated user lines.
    await Bun.write(
      join(repo, ".gitignore"),
      [
        "node_modules",
        ".env",
        "# Reviewgate (auto-added; edit reviewgate.config.ts to override)",
        ".reviewgate/audit/",
        ".reviewgate/cassettes/",
        "!.reviewgate/cassettes/golden/",
        ".reviewgate/state.json",
        "dist/",
        "",
      ].join("\n"),
    );
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const gi = readFileSync(join(repo, ".gitignore"), "utf8");
    const lines = gi.split("\n");
    // Unrelated user lines survive, in their original relative order.
    expect(lines).toContain("node_modules");
    expect(lines).toContain(".env");
    expect(lines).toContain("dist/");
    expect(lines.indexOf("node_modules")).toBeLessThan(lines.indexOf(".env"));
    // The stale root-anchored dir-exclude is removed (it would re-break root golden tracking).
    expect(lines.filter((l) => l.trim() === ".reviewgate/cassettes/")).toHaveLength(0);
    expect(lines.filter((l) => l.trim() === ".reviewgate/audit/")).toHaveLength(0);
    // The new un-anchored form is present.
    expect(gi).toContain("**/.reviewgate/state.json");
    expect(gi).toContain("**/.reviewgate/cassettes/*");
    // Golden still trackable at root after the migration.
    expect(isIgnored(repo, ".reviewgate/cassettes/golden/g.json")).toBe(false);
    // Second init does not duplicate the managed block.
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const gi2 = readFileSync(join(repo, ".gitignore"), "utf8");
    expect((gi2.match(/\*\*\/\.reviewgate\/state\.json/g) ?? []).length).toBe(1);
    expect((gi2.match(/node_modules/g) ?? []).length).toBe(1);
  });
});
