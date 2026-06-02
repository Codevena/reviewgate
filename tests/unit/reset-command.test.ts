import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      "state.json",
      "dirty.flag",
      "pending.md",
      "pending.json",
      "research.md",
      "ESCALATION.md",
      "decisions",
    ]) {
      expect(existsSync(join(rg, p))).toBe(false);
    }
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
