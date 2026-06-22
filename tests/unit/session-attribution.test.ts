// tests/unit/session-attribution.test.ts
//
// S2 (field report 2026-06-23): computeSessionAttributableFiles returns the subset of the
// reviewed diff files this session is responsible for, using ONLY sound UNCOMMITTED signals
// (owned ∪ baseline-net-changed ∪ dirty-now-not-baseline). This is the load-bearing guard for
// the out-of-session honest handoff: a file the session has uncommitted skin in is ALWAYS
// attributable (so the agent can never disown its own live work). Fail-CLOSED: on any error /
// no manifest / no session_id it returns ALL diff files (everything attributable → disown
// unavailable). R1: path-space normalization — owned/baseline (canonical) vs dirtyNow (raw git).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureSessionBaseline,
  computeSessionAttributableFiles,
  recordSessionOwned,
  stampSessionAttribution,
} from "../../src/core/session-manifest.ts";

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-attr-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync(
    "git",
    ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "--allow-empty", "-m", "init"],
    { cwd: dir },
  );
  return dir;
}

describe("computeSessionAttributableFiles (S2)", () => {
  test("an OWNED (tool-edited) file is attributable", async () => {
    const repo = tmpRepo();
    await captureSessionBaseline(repo, "s", new Date().toISOString());
    recordSessionOwned(repo, "s", ["mine.ts"]);
    const set = computeSessionAttributableFiles(repo, "s", ["mine.ts"], ["mine.ts"]);
    expect(set.has("mine.ts")).toBe(true);
  });

  test("a baseline file CHANGED since SessionStart is attributable; byte-IDENTICAL is NOT", async () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, "pre.ts"), "v1\n"); // pre-existing dirty before our session
    await captureSessionBaseline(repo, "s", new Date().toISOString());

    // byte-identical to baseline → a parallel agent's untouched dirty work → NOT attributable
    expect(computeSessionAttributableFiles(repo, "s", ["pre.ts"], ["pre.ts"]).has("pre.ts")).toBe(
      false,
    );

    // now the session net-changes it → attributable
    writeFileSync(join(repo, "pre.ts"), "v2 changed by us\n");
    expect(computeSessionAttributableFiles(repo, "s", ["pre.ts"], ["pre.ts"]).has("pre.ts")).toBe(
      true,
    );
  });

  test("a dirty-now file NOT in the baseline (created/first-touched this session) is attributable", async () => {
    const repo = tmpRepo();
    await captureSessionBaseline(repo, "s", new Date().toISOString());
    writeFileSync(join(repo, "new.ts"), "created this session\n");
    const set = computeSessionAttributableFiles(repo, "s", ["new.ts"], ["new.ts"]);
    expect(set.has("new.ts")).toBe(true);
  });

  test("a committed-foreign file (not owned, not in baseline, not dirty-now) is NOT attributable", async () => {
    const repo = tmpRepo();
    await captureSessionBaseline(repo, "s", new Date().toISOString());
    // A parallel agent committed this file → it is in the diff but the working tree is clean for it.
    const set = computeSessionAttributableFiles(repo, "s", ["seo-spec.ts"], []);
    expect(set.has("seo-spec.ts")).toBe(false);
  });

  test("no manifest → ALL diff files attributable (fail-closed = disown unavailable)", () => {
    const repo = tmpRepo();
    const set = computeSessionAttributableFiles(repo, "never-captured", ["a.ts", "b.ts"], []);
    expect(set.has("a.ts")).toBe(true);
    expect(set.has("b.ts")).toBe(true);
  });

  test("empty session_id → ALL diff files attributable (fail-closed)", () => {
    const repo = tmpRepo();
    const set = computeSessionAttributableFiles(repo, "", ["a.ts"], []);
    expect(set.has("a.ts")).toBe(true);
  });

  test("stampSessionAttribution stamps per-finding flag + whole_diff_attributable", () => {
    const findings = [
      { file: "mine.ts", id: "F1" },
      { file: "theirs.ts", id: "F2" },
    ];
    const out = stampSessionAttribution(findings, new Set(["mine.ts"]));
    expect(out.findings.find((f) => f.id === "F1")?.session_attributable).toBe(true);
    expect(out.findings.find((f) => f.id === "F2")?.session_attributable).toBe(false);
    expect(out.wholeDiffAttributable).toBe(true);
  });

  test("stampSessionAttribution: empty attributable set → whole_diff_attributable false, all findings false", () => {
    const out = stampSessionAttribution([{ file: "theirs.ts" }], new Set<string>());
    expect(out.wholeDiffAttributable).toBe(false);
    expect(out.findings[0]?.session_attributable).toBe(false);
  });

  test("stampSessionAttribution normalizes finding.file before membership (R1)", () => {
    const out = stampSessionAttribution([{ file: "./mine.ts" }], new Set(["mine.ts"]));
    expect(out.findings[0]?.session_attributable).toBe(true);
  });

  test("R1: an OWNED file is attributable even when diff/dirty paths arrive un-normalized", async () => {
    const repo = tmpRepo();
    await captureSessionBaseline(repo, "s", new Date().toISOString());
    recordSessionOwned(repo, "s", ["src/mine.ts"]);
    // diff file passed with a non-canonical "./" prefix must still match the canonical owned key.
    const set = computeSessionAttributableFiles(repo, "s", ["./src/mine.ts"], []);
    expect([...set].some((p) => p.endsWith("src/mine.ts"))).toBe(true);
  });
});
