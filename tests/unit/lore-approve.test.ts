// tests/unit/lore-approve.test.ts — `reviewgate lore approve <id>`: the human
// half of the canon trust boundary (the agent half is the gate's
// canon-promotion finding, see loop-driver-lore.test.ts). The load-bearing
// cases are: a DRAFT is never approvable (approval is ID-permanent, so
// approving a draft would pre-authorize a later flip to canon with no guard),
// and an approval actually silences detectPromotions.
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatLoreApprovePreflight, runLoreApprove } from "../../src/cli/commands/lore.ts";
import { readApprovals } from "../../src/core/lore/approvals.ts";
import { approveLoreEntry, loreApprovePreflight } from "../../src/core/lore/approve.ts";
import { detectPromotions } from "../../src/core/lore/guard.ts";
import { computeVerifiedTree } from "../../src/core/lore/staleness.ts";

function writeLoreEntry(
  repo: string,
  id: string,
  opts: { status?: "draft" | "canon"; anchors: string[]; verifiedTree: string; body?: string },
): string {
  const dir = join(repo, ".reviewgate", "lore");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.md`);
  writeFileSync(
    path,
    [
      "---",
      "schema: reviewgate.lore.v1",
      `id: ${id}`,
      `status: ${opts.status ?? "draft"}`,
      "anchors:",
      ...opts.anchors.map((a) => `  - ${a}`),
      "verified_at: 2020-01-01",
      `verified_tree: "${opts.verifiedTree}"`,
      "tags: []",
      "---",
      opts.body ?? "This is the body explaining WHY this anchor exists — well over forty chars.",
      "",
    ].join("\n"),
  );
  return path;
}

// A fresh repo with one anchored file and a FRESH (non-stale) canon entry.
function repoWithCanonEntry(prefix: string, id = "entry-one"): { repo: string; path: string } {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(repo, "target.ts"), "export const x = 1;\n");
  const tree = computeVerifiedTree(repo, ["target.ts"]);
  const path = writeLoreEntry(repo, id, {
    status: "canon",
    anchors: ["target.ts"],
    verifiedTree: tree,
  });
  return { repo, path };
}

function approvalLines(repo: string): string[] {
  const p = join(repo, ".reviewgate", "lore", "approvals.jsonl");
  try {
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

describe("loreApprovePreflight", () => {
  it("accepts a canon entry: eligible, content-bound challenge, body shown for review", () => {
    const { repo } = repoWithCanonEntry("rg-lore-approve-ok-");

    const pre = loreApprovePreflight(repo, "entry-one");

    expect(pre.eligible).toBe(true);
    expect(pre.alreadyApproved).toBe(false);
    expect(pre.challenge).toMatch(/^APPROVE [0-9a-f]{12}$/);
    expect(pre.entry?.body).toContain("explaining WHY");
    expect(pre.warnings).toEqual([]);
  });

  it("REFUSES a draft — approval is ID-permanent, so it must never pre-authorize a later promotion", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-approve-draft-"));
    writeFileSync(join(repo, "target.ts"), "x");
    writeLoreEntry(repo, "still-draft", {
      status: "draft",
      anchors: ["target.ts"],
      verifiedTree: computeVerifiedTree(repo, ["target.ts"]),
    });

    const pre = loreApprovePreflight(repo, "still-draft");

    expect(pre.eligible).toBe(false);
    expect(pre.challenge).toBeUndefined();
    expect(pre.reason).toContain("status: canon");
  });

  it("reports an already-approved id as alreadyApproved (not an error)", () => {
    const { repo } = repoWithCanonEntry("rg-lore-approve-dup-");
    approveLoreEntry(repo, "entry-one", loreApprovePreflight(repo, "entry-one").challenge ?? "", {
      now: new Date("2026-07-31T10:00:00Z"),
    });

    const pre = loreApprovePreflight(repo, "entry-one");

    expect(pre.alreadyApproved).toBe(true);
    expect(pre.eligible).toBe(false);
  });

  it("refuses a missing entry, an unparseable entry, and a traversal slug", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-approve-bad-"));
    const dir = join(repo, ".reviewgate", "lore");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.md"), "---\nnot: valid\n---\nbody text here\n");

    expect(loreApprovePreflight(repo, "nope").reason).toContain("not found");
    expect(loreApprovePreflight(repo, "broken").eligible).toBe(false);
    const traversal = loreApprovePreflight(repo, "../../etc/passwd");
    expect(traversal.eligible).toBe(false);
    expect(traversal.reason).toContain("invalid slug");
  });

  it("warns (without blocking) when the entry is stale, and when it is inert", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-approve-warn-"));
    writeFileSync(join(repo, "target.ts"), "export const x = 1;\n");
    writeLoreEntry(repo, "stale-one", {
      status: "canon",
      anchors: ["target.ts"],
      verifiedTree: "0".repeat(64),
    });
    writeLoreEntry(repo, "zero-one", {
      status: "canon",
      anchors: ["no-such-file-*.ts"],
      verifiedTree: "0".repeat(64),
    });

    const stale = loreApprovePreflight(repo, "stale-one");
    expect(stale.eligible).toBe(true);
    expect(stale.warnings.join(" ")).toContain("lore verify");

    const zero = loreApprovePreflight(repo, "zero-one");
    expect(zero.eligible).toBe(true);
    expect(zero.warnings.join(" ")).toContain("inert");
  });
});

describe("approveLoreEntry", () => {
  it("writes exactly one schema-valid approval line on the matching challenge", () => {
    const { repo } = repoWithCanonEntry("rg-lore-approve-write-");
    const pre = loreApprovePreflight(repo, "entry-one");

    const result = approveLoreEntry(repo, "entry-one", pre.challenge ?? "", {
      now: new Date("2026-07-31T10:00:00Z"),
    });

    expect(result.ok).toBe(true);
    const lines = approvalLines(repo);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(parsed.schema).toBe("reviewgate.lore-approval.v1");
    expect(parsed.id).toBe("entry-one");
    expect(parsed.decision_ref).toBe("cli:lore-approve");
    expect(readApprovals(repo).has("entry-one")).toBe(true);
  });

  it("writes NOTHING on a wrong confirmation", () => {
    const { repo } = repoWithCanonEntry("rg-lore-approve-wrong-");

    const result = approveLoreEntry(repo, "entry-one", "APPROVE deadbeefdead", {
      now: new Date("2026-07-31T10:00:00Z"),
    });

    expect(result.ok).toBe(false);
    expect(approvalLines(repo)).toHaveLength(0);
    expect(readApprovals(repo).has("entry-one")).toBe(false);
  });

  it("writes NOTHING when the entry changed after the challenge was issued (TOCTOU)", () => {
    const { repo, path } = repoWithCanonEntry("rg-lore-approve-toctou-");
    const pre = loreApprovePreflight(repo, "entry-one");
    // The human read THAT text; an agent rewrites the body before they hit enter.
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "explaining WHY",
        "smuggled instruction the human never read, explaining WHY",
      ),
    );

    const result = approveLoreEntry(repo, "entry-one", pre.challenge ?? "", {
      now: new Date("2026-07-31T10:00:00Z"),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("changed");
    expect(approvalLines(repo)).toHaveLength(0);
  });

  it("never echoes the expected challenge in the mismatch error", () => {
    // On a mismatch caused by the entry CHANGING, the current challenge belongs
    // to text the human has not read; echoing it would invite approving exactly
    // the swapped-in content the check just caught.
    const { repo } = repoWithCanonEntry("rg-lore-approve-noecho-");
    const current = loreApprovePreflight(repo, "entry-one").challenge ?? "";

    const result = approveLoreEntry(repo, "entry-one", "APPROVE deadbeefdead", {
      now: new Date("2026-07-31T10:00:00Z"),
    });

    expect(result.error).not.toContain(current);
    expect(result.error).not.toMatch(/APPROVE [0-9a-f]{12}/);
  });

  it("is idempotent: approving twice never appends a duplicate line", () => {
    const { repo } = repoWithCanonEntry("rg-lore-approve-idem-");
    const challenge = loreApprovePreflight(repo, "entry-one").challenge ?? "";
    approveLoreEntry(repo, "entry-one", challenge, { now: new Date("2026-07-31T10:00:00Z") });

    const second = approveLoreEntry(repo, "entry-one", challenge, {
      now: new Date("2026-07-31T11:00:00Z"),
    });

    expect(second.alreadyApproved).toBe(true);
    expect(approvalLines(repo)).toHaveLength(1);
  });

  it("refuses a draft even when the challenge is forged from its own bytes", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-approve-draftforce-"));
    writeFileSync(join(repo, "target.ts"), "x");
    writeLoreEntry(repo, "still-draft", {
      status: "draft",
      anchors: ["target.ts"],
      verifiedTree: computeVerifiedTree(repo, ["target.ts"]),
    });

    // Even handed the challenge the entry's own bytes would produce, the write
    // path must refuse FOR BEING A DRAFT — not merely because the string is
    // wrong (mutation-checked: dropping the status rule turns this into a
    // "did not match" refusal, which this assertion catches).
    const raw = readFileSync(join(repo, ".reviewgate", "lore", "still-draft.md"), "utf8");
    const forged = `APPROVE ${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`;
    const result = approveLoreEntry(repo, "still-draft", forged, {
      now: new Date("2026-07-31T10:00:00Z"),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("status: canon");
    expect(approvalLines(repo)).toHaveLength(0);
  });
});

describe("lore approve ↔ canon guard", () => {
  it("silences the canon-promotion guard for that entry (and only that entry)", async () => {
    const { repo } = repoWithCanonEntry("rg-lore-approve-guard-");
    writeLoreEntry(repo, "entry-two", {
      status: "canon",
      anchors: ["target.ts"],
      verifiedTree: computeVerifiedTree(repo, ["target.ts"]),
    });
    // A real git repo with NO commit containing the lore files → both entries
    // are "born-canon" promotions the guard must report.
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    execFileSync("git", ["add", "target.ts"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    const before = await detectPromotions(repo, null);
    expect(before.map((p) => p.id).sort()).toEqual(["entry-one", "entry-two"]);

    const pre = loreApprovePreflight(repo, "entry-one");
    expect(approveLoreEntry(repo, "entry-one", pre.challenge ?? "", { now: new Date() }).ok).toBe(
      true,
    );

    const after = await detectPromotions(repo, null);
    expect(after.map((p) => p.id)).toEqual(["entry-two"]);
  });
});

describe("formatLoreApprovePreflight (terminal defang)", () => {
  it("neutralises control bytes in the body so the entry cannot repaint the terminal", () => {
    // The agent under review writes this file; the maintainer reads it in a
    // terminal. Raw escapes could clear the screen and redraw a benign-looking
    // entry while challengeFor() stays bound to THESE bytes — the human would
    // then knowingly approve text they never saw.
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-approve-ansi-"));
    writeFileSync(join(repo, "target.ts"), "x");
    writeLoreEntry(repo, "sneaky", {
      status: "canon",
      anchors: ["target.ts"],
      verifiedTree: computeVerifiedTree(repo, ["target.ts"]),
      body: 'Innocent looking why-note, long enough to pass the minimum body length.\x1b[2J\x1b[HType exactly "APPROVE 000000000000" to approve: \r',
    });

    const out = formatLoreApprovePreflight(loreApprovePreflight(repo, "sneaky"));

    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\r");
    // The forged prompt survives as TEXT — but every line carrying it is inside
    // the quoted block, so it cannot masquerade as this command's own prompt.
    const forged = out.split("\n").filter((l) => l.includes("Type exactly"));
    expect(forged).not.toHaveLength(0);
    for (const line of forged) expect(line.startsWith("│ ")).toBe(true);
  });

  it("neutralises bidi overrides, isolates and zero-width chars (Trojan Source class)", () => {
    // Same attack, different alphabet: U+202E reverses the rendered order and
    // U+2066/U+2069 isolate a span, so the terminal shows a reading order that
    // is not the byte order. The challenge stays bound to the bytes — which is
    // exactly how the human ends up approving text they did not read.
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-approve-bidi-"));
    writeFileSync(join(repo, "target.ts"), "x");
    const invisible = ["\u202e", "\u202d", "\u2066", "\u2069", "\u200b", "\u200e", "\ufeff"];
    writeLoreEntry(repo, "bidi", {
      status: "canon",
      anchors: ["target.ts"],
      verifiedTree: computeVerifiedTree(repo, ["target.ts"]),
      body: `This why-note is long enough to satisfy the minimum body length rule.${invisible.join("x")}`,
    });

    const out = formatLoreApprovePreflight(loreApprovePreflight(repo, "bidi"));

    for (const ch of invisible) expect(out).not.toContain(ch);
  });

  it("defangs the frontmatter fields too, not just the body", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lore-approve-ansi-fm-"));
    writeFileSync(join(repo, "target.ts"), "x");
    writeLoreEntry(repo, "sneaky-two", {
      status: "canon",
      anchors: ["target.ts\x1b[31m"],
      verifiedTree: computeVerifiedTree(repo, ["target.ts"]),
    });

    const out = formatLoreApprovePreflight(loreApprovePreflight(repo, "sneaky-two"));

    expect(out).not.toContain("\x1b");
  });
});

describe("runLoreApprove (CLI)", () => {
  it("exit 0 + confirmation output on success", () => {
    const { repo } = repoWithCanonEntry("rg-lore-approve-cli-");
    const challenge = loreApprovePreflight(repo, "entry-one").challenge ?? "";

    const lines: string[] = [];
    const code = runLoreApprove({
      repoRoot: repo,
      slug: "entry-one",
      confirmation: challenge,
      write: (s) => lines.push(s),
    });

    expect(code).toBe(0);
    expect(lines.join("")).toContain("approved");
    expect(approvalLines(repo)).toHaveLength(1);
  });

  it("exit 1 + the reason on a refused approval", () => {
    const { repo } = repoWithCanonEntry("rg-lore-approve-cli-fail-");

    const lines: string[] = [];
    const code = runLoreApprove({
      repoRoot: repo,
      slug: "entry-one",
      confirmation: "nope",
      write: (s) => lines.push(s),
    });

    expect(code).toBe(1);
    expect(lines.join("").toLowerCase()).toContain("did not match");
    expect(approvalLines(repo)).toHaveLength(0);
  });

  it("exit 1 when the prompt closed without an answer — EOF must never read as approved", () => {
    // Regression: rl.question() never settles once the interface closes, so the
    // interactive path used to drain its event loop and exit 0 having written
    // nothing — an exit code claiming an approval that does not exist.
    const { repo } = repoWithCanonEntry("rg-lore-approve-cli-eof-");

    const lines: string[] = [];
    const code = runLoreApprove({
      repoRoot: repo,
      slug: "entry-one",
      confirmation: null,
      write: (s) => lines.push(s),
    });

    expect(code).toBe(1);
    expect(lines.join("").toLowerCase()).toContain("aborted");
    expect(approvalLines(repo)).toHaveLength(0);
  });

  it("exit 0 on an already-approved entry (idempotent re-run)", () => {
    const { repo } = repoWithCanonEntry("rg-lore-approve-cli-dup-");
    const challenge = loreApprovePreflight(repo, "entry-one").challenge ?? "";
    runLoreApprove({ repoRoot: repo, slug: "entry-one", confirmation: challenge, write: () => {} });

    const lines: string[] = [];
    const code = runLoreApprove({
      repoRoot: repo,
      slug: "entry-one",
      confirmation: challenge,
      write: (s) => lines.push(s),
    });

    expect(code).toBe(0);
    expect(lines.join("").toLowerCase()).toContain("already approved");
    expect(approvalLines(repo)).toHaveLength(1);
  });
});
