// tests/unit/lore-guard.test.ts
//
// Task 4 — Lore v1: committed approvals ledger + deterministic, raw-text
// canon-promotion guard (docs/superpowers/specs/2026-07-09-lore-design.md,
// "Canon guard (deterministic, no LLM)"). `.reviewgate/` is excluded from the
// reviewer diff, so this guard diffs lore files itself: `draft → canon`
// transitions AND entries BORN as canon must both raise a decision-required
// finding, unless already approved in the committed ledger.
import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendApproval, readApprovals } from "../../src/core/lore/approvals.ts";
import { detectPromotions } from "../../src/core/lore/guard.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function sh(repo: string, cmd: string): string {
  return execSync(cmd, { cwd: repo, env: GIT_ENV, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rg-lore-guard-"));
  sh(repo, "git init -q -b main");
  return repo;
}

function commitAll(repo: string, msg: string): string {
  sh(repo, `git add -A && git commit -q -m ${JSON.stringify(msg)}`);
  return sh(repo, "git rev-parse HEAD");
}

function loreEntry(status: string, id = "widget-invariant"): string {
  return `---
schema: reviewgate.lore.v1
id: ${id}
status: ${status}
anchors:
  - "src/widget.ts"
verified_at: 2026-07-09
verified_tree: "abc123"
---
Some body text that is definitely long enough to pass the min body length check.`;
}

function writeLore(repo: string, id: string, content: string): void {
  const dir = join(repo, ".reviewgate", "lore");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), content);
}

describe("detectPromotions", () => {
  it("(a) detects a draft→canon transition against a committed base", async () => {
    const repo = initRepo();
    writeLore(repo, "widget-invariant", loreEntry("draft"));
    const base = commitAll(repo, "base: draft entry");
    writeLore(repo, "widget-invariant", loreEntry("canon")); // uncommitted flip
    const result = await detectPromotions(repo, base);
    expect(result).toEqual([{ id: "widget-invariant", kind: "transition" }]);
  });

  it("(b) detects a new uncommitted file born as canon", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "README.md"), "x");
    const base = commitAll(repo, "base");
    writeLore(repo, "new-rule", loreEntry("canon", "new-rule"));
    const result = await detectPromotions(repo, base);
    expect(result).toEqual([{ id: "new-rule", kind: "born-canon" }]);
  });

  it("(c) detects a malformed file with a raw `status: canon` line (raw-text scan, no schema validity required)", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "README.md"), "x");
    const base = commitAll(repo, "base");
    const dir = join(repo, ".reviewgate", "lore");
    mkdirSync(dir, { recursive: true });
    // Broken frontmatter: no closing `---` fence, but a raw `status: canon` line.
    writeFileSync(join(dir, "broken.md"), "status: canon\nthis is not valid frontmatter at all");
    const result = await detectPromotions(repo, base);
    expect(result).toEqual([{ id: "broken", kind: "born-canon" }]);
  });

  it("(d) filters out ids already present in the approvals ledger (idempotent)", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "README.md"), "x");
    const base = commitAll(repo, "base");
    writeLore(repo, "new-rule", loreEntry("canon", "new-rule"));
    appendApproval(repo, "new-rule", "decision-ref-1", new Date("2026-07-09T00:00:00Z"));
    const result = await detectPromotions(repo, base);
    expect(result).toEqual([]);
  });

  it("(g) WARN-2 spec amendment: approval is id-permanent — a fresh draft→canon transition after a committed canon→draft→canon round-trip is still suppressed", async () => {
    const repo = initRepo();
    // The id was approved once, in the past (a decision's `fixed` action wrote
    // this line for the ORIGINAL promotion).
    appendApproval(repo, "widget-invariant", "decision-ref-1", new Date("2026-07-01T00:00:00Z"));
    writeLore(repo, "widget-invariant", loreEntry("canon"));
    commitAll(repo, "base0: entry approved canon");

    // Round-trip: canon -> draft (committed) -> canon again (uncommitted). Without
    // the id-permanent approval this is a completely FRESH draft→canon transition
    // against `base` and detectPromotions would (correctly, on its own) flag it.
    writeLore(repo, "widget-invariant", loreEntry("draft"));
    const base = commitAll(repo, "revert to draft");
    writeLore(repo, "widget-invariant", loreEntry("canon"));

    const result = await detectPromotions(repo, base);
    // Amended spec (2026-07-09/10, "Canon guard"): approval is id-permanent in
    // v1 — once approved, subsequent promotions of that id (including this
    // round-trip) reuse the original approval and are NOT re-guarded. Per-epoch
    // re-approval is a documented v2 follow-up, not a v1 regression to fix.
    expect(result).toEqual([]);
  });

  it("(e) baseSha: null compares against HEAD (proves the HEAD fallback path is taken)", async () => {
    const repo = initRepo();
    writeLore(repo, "widget-invariant", loreEntry("draft"));
    commitAll(repo, "base: draft entry"); // committed status is draft — this becomes HEAD
    writeLore(repo, "widget-invariant", loreEntry("canon")); // uncommitted flip, never diffed against `base`
    const result = await detectPromotions(repo, null);
    expect(result).toEqual([{ id: "widget-invariant", kind: "transition" }]);
  });

  it("returns no promotion when status is unchanged (canon at base, canon now)", async () => {
    const repo = initRepo();
    writeLore(repo, "widget-invariant", loreEntry("canon"));
    const base = commitAll(repo, "base: already canon");
    const result = await detectPromotions(repo, base);
    expect(result).toEqual([]);
  });
});

describe("approvals ledger", () => {
  it("(f) round-trips an approval and tolerates a malformed line", () => {
    const repo = initRepo();
    appendApproval(repo, "widget-invariant", "decision-ref-1", new Date("2026-07-09T00:00:00Z"));
    const path = join(repo, ".reviewgate", "lore", "approvals.jsonl");
    const existing = readFileSync(path, "utf8");
    // Append a malformed JSON line and a well-formed-JSON-but-wrong-schema line.
    writeFileSync(path, `${existing}not json at all\n{"schema":"wrong-version"}\n`);
    const ids = readApprovals(repo);
    expect(ids.has("widget-invariant")).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("returns an empty set when the approvals file does not exist", () => {
    const repo = initRepo();
    expect(readApprovals(repo)).toEqual(new Set());
  });
});
