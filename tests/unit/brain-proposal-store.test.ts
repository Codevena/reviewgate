import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProposalStore,
  clearAllProposalPools,
  proposalSignature,
} from "../../src/core/brain/proposal-store.ts";
import type { MemoryProposal } from "../../src/schemas/brain.ts";
import {
  proposalsPoolDir,
  proposalsPoolErrorLog,
  proposalsPoolPath,
} from "../../src/utils/paths.ts";

function repo(): string {
  return mkdtempSync(join(tmpdir(), "rg-prop-"));
}

function mkProposal(over: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    type: "convention",
    scope: "this-repo",
    title: "use prepared statements",
    body: "all SQL must be parameterized",
    confidence: 0.8,
    tags: [],
    evidence: [
      {
        kind: "reviewer-observation",
        run_id: "R1",
        reviewer_id: "claude-code:security",
        snippet: "saw this in db.ts",
      },
    ],
    ...over,
  };
}

const NOW = "2026-05-28T20:00:00.000Z";
const RUN_A = "01KSQWAXV9QQEQR5FTTVAEYKH6";
const RUN_B = "01KSAW42AYF42TH1JNV8J320VZ";

describe("ProposalStore — basics", () => {
  it("readAll on missing file returns []", () => {
    const r = repo();
    expect(new ProposalStore(r, RUN_A).readAll()).toEqual([]);
  });

  it("appendIter persists one StoredProposal per proposal", () => {
    const r = repo();
    const s = new ProposalStore(r, RUN_A);
    s.appendIter(1, [mkProposal()], NOW);
    const lines = readFileSync(proposalsPoolPath(r, RUN_A), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const stored = JSON.parse(lines[0] as string);
    expect(stored.iter).toBe(1);
    expect(stored.appended_at).toBe(NOW);
    expect(stored.proposal.title).toBe("use prepared statements");
    expect(typeof stored.signature).toBe("string");
    expect(stored.signature.length).toBe(64);
  });

  it("appendIter is a no-op on empty input", () => {
    const r = repo();
    new ProposalStore(r, RUN_A).appendIter(1, [], NOW);
    expect(existsSync(proposalsPoolPath(r, RUN_A))).toBe(false);
  });
});

describe("ProposalStore — dedup-by-signature", () => {
  it("re-appending the same proposal in the same iter is a no-op", () => {
    const r = repo();
    const s = new ProposalStore(r, RUN_A);
    s.appendIter(1, [mkProposal()], NOW);
    s.appendIter(1, [mkProposal()], NOW);
    expect(s.readAll()).toHaveLength(1);
  });

  it("dedup spans iterations — same (title+body+reviewer_id) sig wins", () => {
    const r = repo();
    const s = new ProposalStore(r, RUN_A);
    s.appendIter(1, [mkProposal()], NOW);
    s.appendIter(2, [mkProposal()], NOW);
    const all = s.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.iter).toBe(1); // first writer wins
  });

  it("same title+body from a DIFFERENT provider is NOT deduped (different sig)", () => {
    const r = repo();
    const s = new ProposalStore(r, RUN_A);
    s.appendIter(1, [mkProposal()], NOW);
    s.appendIter(
      2,
      [
        mkProposal({
          evidence: [
            {
              kind: "reviewer-observation",
              run_id: "R2",
              reviewer_id: "opencode:security",
              snippet: "saw this in db.ts",
            },
          ],
        }),
      ],
      NOW,
    );
    const all = s.readAll();
    expect(all).toHaveLength(2);
    // The whole reason for the F2 work: different providers must NOT collapse.
    expect(new Set(all.map((x) => x.signature)).size).toBe(2);
  });
});

describe("ProposalStore — cross-iter pool (the F2 motivating case)", () => {
  it("readAll across two iterations returns proposals from both providers", () => {
    const r = repo();
    const s = new ProposalStore(r, RUN_A);

    s.appendIter(
      1,
      [
        mkProposal({
          title: "use prepared statements",
          evidence: [
            {
              kind: "reviewer-observation",
              run_id: "R1",
              reviewer_id: "claude-code:security",
              snippet: "iter1",
            },
          ],
        }),
      ],
      NOW,
    );

    s.appendIter(
      2,
      [
        mkProposal({
          title: "use prepared statements",
          evidence: [
            {
              kind: "reviewer-observation",
              run_id: "R1",
              reviewer_id: "opencode:security",
              snippet: "iter2",
            },
          ],
        }),
      ],
      NOW,
    );

    // The curator pool now contains BOTH providers' takes on the same convention
    // — the input it needs to reach the ≥2-distinct-providers quorum.
    const pool = s.proposals();
    expect(pool).toHaveLength(2);
    const providers = pool.flatMap((p) =>
      p.evidence.map((e) => e.reviewer_id).filter((x): x is string => Boolean(x)),
    );
    expect(new Set(providers).size).toBe(2);
  });
});

describe("ProposalStore — isolation", () => {
  it("different runIds use different files (no cross-run leakage)", () => {
    const r = repo();
    new ProposalStore(r, RUN_A).appendIter(1, [mkProposal({ title: "A-title" })], NOW);
    new ProposalStore(r, RUN_B).appendIter(1, [mkProposal({ title: "B-title" })], NOW);

    const a = new ProposalStore(r, RUN_A).proposals();
    const b = new ProposalStore(r, RUN_B).proposals();
    expect(a.map((p) => p.title)).toEqual(["A-title"]);
    expect(b.map((p) => p.title)).toEqual(["B-title"]);
  });

  it("runId with path-traversal chars sanitizes safely", () => {
    const r = repo();
    const evil = "../../etc/passwd";
    // Sanitized runId strips '/.\' → "etcpasswd", so the write lands inside the
    // proposals dir, not on the filesystem root.
    new ProposalStore(r, evil).appendIter(1, [mkProposal()], NOW);
    const written = proposalsPoolPath(r, evil);
    expect(written.includes("..")).toBe(false);
    expect(existsSync(written)).toBe(true);
  });
});

describe("ProposalStore — robustness", () => {
  it("readAll skips malformed/truncated lines but returns the good ones", () => {
    const r = repo();
    const s = new ProposalStore(r, RUN_A);
    s.appendIter(1, [mkProposal()], NOW);
    // Simulate a crash mid-write: append a partial JSON line.
    const p = proposalsPoolPath(r, RUN_A);
    writeFileSync(p, `${readFileSync(p, "utf8")}{"iter":2,"appended_at":"`);
    const back = s.readAll();
    expect(back).toHaveLength(1);
    expect(back[0]?.proposal.title).toBe("use prepared statements");
  });

  it("readAll skips entries that fail schema validation", () => {
    const r = repo();
    const s = new ProposalStore(r, RUN_A);
    s.appendIter(1, [mkProposal()], NOW);
    const p = proposalsPoolPath(r, RUN_A);
    // A complete but schema-invalid line (missing required fields).
    writeFileSync(p, `${readFileSync(p, "utf8")}{"iter":2,"junk":true}\n`);
    expect(s.readAll()).toHaveLength(1);
  });
});

describe("ProposalStore — clear", () => {
  it("clear() removes the pool file; idempotent on missing", () => {
    const r = repo();
    const s = new ProposalStore(r, RUN_A);
    s.appendIter(1, [mkProposal()], NOW);
    expect(existsSync(proposalsPoolPath(r, RUN_A))).toBe(true);
    s.clear();
    expect(existsSync(proposalsPoolPath(r, RUN_A))).toBe(false);
    // idempotent
    s.clear();
    expect(existsSync(proposalsPoolPath(r, RUN_A))).toBe(false);
  });
});

describe("clearAllProposalPools — reset path", () => {
  it("wipes every run's pool file but keeps errors.jsonl", () => {
    const r = repo();
    new ProposalStore(r, RUN_A).appendIter(1, [mkProposal()], NOW);
    new ProposalStore(r, RUN_B).appendIter(1, [mkProposal()], NOW);
    // Drop an errors.jsonl side-file so we can prove it survives.
    writeFileSync(proposalsPoolErrorLog(r), '{"ts":"x"}\n');

    clearAllProposalPools(r);

    expect(existsSync(proposalsPoolPath(r, RUN_A))).toBe(false);
    expect(existsSync(proposalsPoolPath(r, RUN_B))).toBe(false);
    expect(existsSync(proposalsPoolErrorLog(r))).toBe(true);
  });

  it("no-op on a fresh repo (no proposals dir yet)", () => {
    const r = repo();
    // Doesn't throw; doesn't create the dir.
    clearAllProposalPools(r);
    expect(existsSync(proposalsPoolDir(r))).toBe(false);
  });
});

describe("proposalSignature — deterministic", () => {
  it("two structurally identical proposals produce the same sig", () => {
    expect(proposalSignature(mkProposal())).toBe(proposalSignature(mkProposal()));
  });
  it("changing the reviewer_id changes the sig", () => {
    const a = proposalSignature(mkProposal());
    const b = proposalSignature(
      mkProposal({
        evidence: [
          {
            kind: "reviewer-observation",
            run_id: "R1",
            reviewer_id: "gemini:security",
            snippet: "saw this in db.ts",
          },
        ],
      }),
    );
    expect(a).not.toBe(b);
  });
});
