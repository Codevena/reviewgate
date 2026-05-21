import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runFpAudit,
  runFpList,
  runFpPin,
  runFpShow,
  runFpUnpin,
} from "../../src/cli/commands/fp.ts";
import { FpLedgerStore } from "../../src/core/fp-ledger/store.ts";

const meta = {
  rule_id: "magic-number",
  category: "quality" as const,
  file: "src/a.ts",
  symbol: "",
};

async function seed(repo: string, stage: "candidate" | "active") {
  const s = new FpLedgerStore(repo);
  const t = "2026-05-21T00:00:00Z";
  await s.recordReject("sigA", meta, { run_id: "r1", provider: "codex", reason: "x" }, t);
  if (stage === "active") {
    await s.recordReject("sigA", meta, { run_id: "r2", provider: "gemini", reason: "x" }, t);
    await s.recordReject("sigA", meta, { run_id: "r3", provider: "codex", reason: "x" }, t);
  }
  return s;
}

describe("fp CLI", () => {
  it("list prints entries; empty repo prints a friendly message", async () => {
    const empty = mkdtempSync(join(tmpdir(), "rg-fpcli-e-"));
    let out = "";
    expect(
      await runFpList({
        repoRoot: empty,
        write: (s) => {
          out += s;
        },
      }),
    ).toBe(0);
    expect(out).toContain("No FP-ledger entries");

    const repo = mkdtempSync(join(tmpdir(), "rg-fpcli-l-"));
    await seed(repo, "active");
    out = "";
    expect(
      await runFpList({
        repoRoot: repo,
        write: (s) => {
          out += s;
        },
      }),
    ).toBe(0);
    expect(out).toContain("FP-001");
    expect(out).toContain("active");
    expect(out).toContain("src/a.ts");
  });

  it("show prints the entry + rejects; missing id returns 1", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpcli-s-"));
    await seed(repo, "active");
    let out = "";
    expect(
      await runFpShow({
        repoRoot: repo,
        id: "FP-001",
        write: (s) => {
          out += s;
        },
      }),
    ).toBe(0);
    expect(out).toContain("sigA");
    expect(out).toContain("codex");
    expect(await runFpShow({ repoRoot: repo, id: "FP-404" })).toBe(1);
  });

  it("pin by id makes the entry sticky; unpin reverts", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpcli-pin-"));
    await seed(repo, "candidate");
    let out = "";
    expect(
      await runFpPin({
        repoRoot: repo,
        id: "FP-001",
        by: "markus",
        write: (s) => {
          out += s;
        },
      }),
    ).toBe(0);
    expect((await new FpLedgerStore(repo).snapshot()).entries[0]?.stage).toBe("sticky");
    expect(await runFpUnpin({ repoRoot: repo, id: "FP-001" })).toBe(0);
    expect((await new FpLedgerStore(repo).snapshot()).entries[0]?.stage).toBe("candidate");
  });

  it("pin by signature resolves to the id; unknown target returns 1; no target returns 2", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpcli-pinsig-"));
    await seed(repo, "candidate");
    expect(await runFpPin({ repoRoot: repo, signature: "sigA", by: "markus" })).toBe(0);
    expect((await new FpLedgerStore(repo).snapshot()).entries[0]?.stage).toBe("sticky");
    expect(await runFpPin({ repoRoot: repo, signature: "nope", by: "markus" })).toBe(1);
    expect(await runFpPin({ repoRoot: repo, by: "markus" })).toBe(2);
  });

  it("audit groups active/sticky entries by first-seen provider; skips candidates", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fpcli-audit-"));
    await seed(repo, "active"); // sigA active, first reject by codex
    const s = new FpLedgerStore(repo);
    await s.recordReject(
      "sigCand",
      meta,
      { run_id: "c1", provider: "gemini", reason: "x" },
      "2026-05-21T00:00:00Z",
    );
    let out = "";
    expect(
      await runFpAudit({
        repoRoot: repo,
        write: (s2) => {
          out += s2;
        },
      }),
    ).toBe(0);
    expect(out).toContain("codex"); // group header for the active entry
    expect(out).toContain("FP-001");
    expect(out).not.toContain("sigCand"); // candidate excluded
  });
});
