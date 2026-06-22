// tests/unit/session-manifest.test.ts
//
// Slice A (P1): the baseline-delta ownership module. The PRIMARY guarantee under test is
// that a file is FOREIGN only if it is byte-identical to this session's SessionStart baseline
// — any change (incl. a Bash/sed edit, which the manifest never sees as a tool event) flips it
// to non-foreign → reviewed. Plus: idempotent baseline (resume-safe), session-keying, prune.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureSessionBaseline,
  computeForeignFiles,
  pruneOldSessionManifests,
  readSessionManifest,
  recordSessionOwned,
} from "../../src/core/session-manifest.ts";
import { sessionManifestPath } from "../../src/utils/paths.ts";

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-sess-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "--allow-empty", "-m", "init"],
    {
      cwd: dir,
    },
  );
  return dir;
}

function commit(dir: string, file: string, body: string): void {
  writeFileSync(join(dir, file), body);
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", "c"], {
    cwd: dir,
  });
}

describe("session-manifest baseline-delta ownership", () => {
  test("a dirty file unchanged since baseline is FOREIGN; once edited it is NOT (Bash-safe)", async () => {
    const repo = tmpRepo();
    commit(repo, "foreign.ts", "export const a = 1;\n");
    // A parallel agent has left this file dirty BEFORE our session starts.
    writeFileSync(join(repo, "foreign.ts"), "export const a = 2; // their edit\n");

    await captureSessionBaseline(repo, "sessA", new Date().toISOString());
    const m = readSessionManifest(repo, "sessA");
    expect(m?.baseline["foreign.ts"]).toBeDefined();

    // Unchanged since our baseline → foreign (we did not author the current state).
    expect(computeForeignFiles(repo, "sessA").has("foreign.ts")).toBe(true);

    // Now SOMEONE changes it (could be a Bash/sed edit by us — the manifest never saw a tool
    // event). The content hash differs from baseline → it is no longer foreign → reviewed.
    writeFileSync(join(repo, "foreign.ts"), "export const a = 3; // changed after baseline\n");
    expect(computeForeignFiles(repo, "sessA").has("foreign.ts")).toBe(false);
  });

  test("a clean start has an empty baseline → nothing is ever foreign (single-agent no-op)", async () => {
    const repo = tmpRepo();
    commit(repo, "mine.ts", "export const x = 1;\n");
    await captureSessionBaseline(repo, "sessClean", new Date().toISOString());
    expect(Object.keys(readSessionManifest(repo, "sessClean")?.baseline ?? {})).toHaveLength(0);
    // Now this session edits mine.ts — it was never in the baseline → not foreign → reviewed.
    writeFileSync(join(repo, "mine.ts"), "export const x = 2;\n");
    expect(computeForeignFiles(repo, "sessClean").has("mine.ts")).toBe(false);
  });

  test("recordSessionOwned keeps an unchanged baseline file reviewed (belt over the hash)", async () => {
    const repo = tmpRepo();
    commit(repo, "shared.ts", "export const s = 1;\n");
    writeFileSync(join(repo, "shared.ts"), "export const s = 2;\n");
    await captureSessionBaseline(repo, "sessB", new Date().toISOString());
    expect(computeForeignFiles(repo, "sessB").has("shared.ts")).toBe(true); // foreign before we own it
    recordSessionOwned(repo, "sessB", [join(repo, "shared.ts")]); // absolute path → relativized (M10)
    expect(readSessionManifest(repo, "sessB")?.owned).toContain("shared.ts");
    expect(computeForeignFiles(repo, "sessB").has("shared.ts")).toBe(false); // owned → reviewed
  });

  test("baseline capture is idempotent — a resume preserves the original baseline", async () => {
    const repo = tmpRepo();
    commit(repo, "pre.ts", "export const p = 1;\n");
    writeFileSync(join(repo, "pre.ts"), "export const p = 2;\n");
    await captureSessionBaseline(repo, "sessR", new Date().toISOString());
    const first = readSessionManifest(repo, "sessR")?.baseline;
    // The session now edits MORE; a second SessionStart (resume) must NOT fold this into baseline.
    writeFileSync(join(repo, "own.ts"), "export const o = 1;\n");
    await captureSessionBaseline(repo, "sessR", new Date().toISOString());
    expect(readSessionManifest(repo, "sessR")?.baseline).toEqual(first ?? {});
    expect(computeForeignFiles(repo, "sessR").has("own.ts")).toBe(false); // our new file isn't foreign
  });

  test("foreignness is session-keyed — a second session has its own (empty) baseline", async () => {
    const repo = tmpRepo();
    commit(repo, "f.ts", "export const f = 1;\n");
    writeFileSync(join(repo, "f.ts"), "export const f = 2;\n");
    await captureSessionBaseline(repo, "agentA", new Date().toISOString());
    // agentB starts LATER, with f.ts already dirty → f.ts is in agentB's baseline → foreign to B.
    await captureSessionBaseline(repo, "agentB", new Date().toISOString());
    expect(computeForeignFiles(repo, "agentB").has("f.ts")).toBe(true);
    // unknown session → no manifest → nothing foreign (fail-closed full review).
    expect(computeForeignFiles(repo, "ghost").size).toBe(0);
  });

  test("pruneOldSessionManifests drops manifests past the TTL, keeps fresh ones", async () => {
    const repo = tmpRepo();
    await captureSessionBaseline(repo, "old", new Date(0).toISOString()); // created_at = epoch
    await captureSessionBaseline(repo, "fresh", new Date().toISOString());
    pruneOldSessionManifests(repo, Date.now());
    expect(existsSync(sessionManifestPath(repo, "old"))).toBe(false);
    expect(existsSync(sessionManifestPath(repo, "fresh"))).toBe(true);
  });
});
