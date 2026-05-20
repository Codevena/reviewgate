// tests/unit/brain-paths.test.ts
import { describe, expect, it } from "bun:test";
import {
  brainArchivePath,
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
});
