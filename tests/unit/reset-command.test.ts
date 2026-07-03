import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReset } from "../../src/cli/commands/reset.ts";
import { handleReset } from "../../src/hooks/handlers.ts";

function seedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rg-reset-"));
  const rg = join(root, ".reviewgate");
  mkdirSync(join(rg, "decisions"), { recursive: true });
  writeFileSync(join(rg, "state.json"), "{}");
  writeFileSync(join(rg, "dirty.flag"), "{}");
  writeFileSync(join(rg, "pending.md"), "# findings");
  writeFileSync(join(rg, "pending.json"), "[]");
  writeFileSync(join(rg, "research.md"), "research");
  writeFileSync(join(rg, "ESCALATION.md"), "escalated");
  writeFileSync(join(rg, "decisions", "1.jsonl"), "{}\n");
  return root;
}

describe("handleReset summary", () => {
  it("removes all per-session artifacts and reports them in cleared", async () => {
    const root = seedRepo();
    const { cleared } = await handleReset({ repoRoot: root });
    const rg = join(root, ".reviewgate");
    for (const p of [
      "dirty.flag",
      "pending.md",
      "pending.json",
      "research.md",
      "ESCALATION.md",
      "decisions",
    ]) {
      expect(existsSync(join(rg, p))).toBe(false);
    }
    // S1: state.json is no longer left absent — the reset re-seeds a fresh
    // state (reviewed-through markers) rather than the stale "{}" stub seedRepo
    // wrote, so the very next Stop has an honest baseline instead of an
    // unconditional last===null fast-exit (core-loop#2).
    expect(existsSync(join(rg, "state.json"))).toBe(true);
    const st = JSON.parse(readFileSync(join(rg, "state.json"), "utf8"));
    expect(st.iteration).toBe(0);
    expect(cleared).toContain("dirty flag");
    expect(cleared).toContain("session state");
    expect(cleared).toContain("pending findings");
    expect(cleared).toContain("decisions");
    expect(cleared).toContain("research");
    expect(cleared).toContain("escalation");
  });

  it("returns an empty cleared list when nothing is present", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-reset-empty-"));
    mkdirSync(join(root, ".reviewgate"), { recursive: true });
    const { cleared } = await handleReset({ repoRoot: root });
    expect(cleared).toEqual([]);
  });
});

describe("runReset command", () => {
  it("clears artifacts and prints a re-armed summary listing them", async () => {
    const root = seedRepo();
    let out = "";
    const code = await runReset({
      repoRoot: root,
      write: (s) => {
        out += s;
      },
    });
    expect(code).toBe(0);
    expect(out).toContain("gate re-armed");
    expect(out).toContain("Cleared:");
    expect(out).toContain("pending findings");
    expect(out).toContain("Preserved: FP-ledger & brain");
    expect(existsSync(join(root, ".reviewgate", "pending.md"))).toBe(false);
  });

  it("prints 'nothing to clear' on an already-clean .reviewgate", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-reset-clean-"));
    mkdirSync(join(root, ".reviewgate"), { recursive: true });
    let out = "";
    const code = await runReset({
      repoRoot: root,
      write: (s) => {
        out += s;
      },
    });
    expect(code).toBe(0);
    expect(out).toContain("nothing to clear");
  });

  it("prints a gentle hint and exits 0 when .reviewgate is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-reset-noinit-"));
    let out = "";
    const code = await runReset({
      repoRoot: root,
      write: (s) => {
        out += s;
      },
    });
    expect(code).toBe(0);
    expect(out).toContain("doesn't look like a Reviewgate");
  });

  it("clears the same artifacts as the gate --hook reset path (parity)", async () => {
    // Both runReset and the SessionStart hook drive the SAME handleReset, so a
    // freshly seeded tree must end up identically empty either way. state.json
    // is EXCLUDED here (S1): it is re-seeded, not left absent — see the
    // dedicated "removes all per-session artifacts" test above.
    const viaCommand = seedRepo();
    await runReset({ repoRoot: viaCommand, write: () => {} });
    const viaHook = seedRepo();
    await handleReset({ repoRoot: viaHook });
    for (const p of [
      "dirty.flag",
      "pending.md",
      "pending.json",
      "research.md",
      "decisions",
      "ESCALATION.md",
    ]) {
      expect(existsSync(join(viaCommand, ".reviewgate", p))).toBe(false);
      expect(existsSync(join(viaHook, ".reviewgate", p))).toBe(false);
    }
    expect(existsSync(join(viaCommand, ".reviewgate", "state.json"))).toBe(true);
    expect(existsSync(join(viaHook, ".reviewgate", "state.json"))).toBe(true);
  });
});
