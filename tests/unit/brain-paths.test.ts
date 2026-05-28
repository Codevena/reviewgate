// tests/unit/brain-paths.test.ts
import { describe, expect, it } from "bun:test";
import {
  brainArchivePath,
  brainCandidatesLockPath,
  brainCandidatesPath,
  brainDir,
  brainJsonPath,
  brainLockPath,
  brainMdPath,
  brainSnapshotsDir,
  brainSourcesPath,
  curatorDecisionsPath,
} from "../../src/utils/paths.ts";

describe("brain paths", () => {
  it("derives all brain paths under .reviewgate/brain", () => {
    const r = "/repo";
    expect(brainDir(r)).toBe("/repo/.reviewgate/brain");
    expect(brainJsonPath(r)).toBe("/repo/.reviewgate/brain/brain.json");
    expect(brainMdPath(r)).toBe("/repo/.reviewgate/brain/brain.md");
    expect(brainSourcesPath(r)).toBe("/repo/.reviewgate/brain/sources.jsonl");
    expect(brainArchivePath(r)).toBe("/repo/.reviewgate/brain/archive.md");
    expect(brainLockPath(r)).toBe("/repo/.reviewgate/brain/.lock");
    expect(brainSnapshotsDir(r)).toBe("/repo/.reviewgate/brain/snapshots");
    expect(curatorDecisionsPath(r, "RUN1")).toBe(
      "/repo/.reviewgate/brain/proposals/curator-decisions/RUN1.jsonl",
    );
  });

  it("sanitizes a malicious runId so it cannot escape the curator-decisions dir", () => {
    const r = "/repo";
    const base = "/repo/.reviewgate/brain/proposals/curator-decisions";
    // path-traversal + separators are stripped to the allowed [A-Za-z0-9_-] set.
    const p = curatorDecisionsPath(r, "../../../../etc/passwd");
    expect(p.startsWith(`${base}/`)).toBe(true);
    expect(p.includes("..")).toBe(false);
    expect(p).toBe(`${base}/etcpasswd.jsonl`);

    // forward + back slashes and dots are stripped, keeping the file in-dir.
    expect(curatorDecisionsPath(r, "a/b\\c.d")).toBe(`${base}/abcd.jsonl`);

    // a runId that sanitizes to empty is rejected outright.
    expect(() => curatorDecisionsPath(r, "../../")).toThrow();
    expect(() => curatorDecisionsPath(r, "/")).toThrow();
  });
});

describe("brain candidates paths", () => {
  it("brainCandidatesPath = .reviewgate/brain/candidates.jsonl", () => {
    expect(brainCandidatesPath("/repo")).toBe("/repo/.reviewgate/brain/candidates.jsonl");
  });
  it("brainCandidatesLockPath = .reviewgate/brain/candidates.lock", () => {
    expect(brainCandidatesLockPath("/repo")).toBe("/repo/.reviewgate/brain/candidates.lock");
  });
});
