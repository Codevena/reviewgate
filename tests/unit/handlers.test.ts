// tests/unit/handlers.test.ts
import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_TS_NO_SCOPING_SENTINEL, handleTrigger } from "../../src/hooks/handlers.ts";
import { dirtyFlagPath, reviewgateDir } from "../../src/utils/paths.ts";

describe("handleTrigger", () => {
  it("concurrent triggers leave no stray .tmp and a valid dirty.flag", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-trigger-"));
    mkdirSync(reviewgateDir(repo), { recursive: true });
    await Promise.all([
      handleTrigger({ repoRoot: repo, hookStdinRaw: '{"a":1}' }),
      handleTrigger({ repoRoot: repo, hookStdinRaw: '{"b":2}' }),
      handleTrigger({ repoRoot: repo, hookStdinRaw: '{"c":3}' }),
    ]);
    const dir = reviewgateDir(repo);
    const tmps = readdirSync(dir).filter((f) => f.includes("dirty.flag.") && f.endsWith(".tmp"));
    expect(tmps).toEqual([]); // every unique temp is consumed by its own rename
    // The final dirty.flag is valid JSON with a diff_hash.
    const body = JSON.parse(readFileSync(dirtyFlagPath(repo), "utf8")) as { diff_hash?: string };
    expect(typeof body.diff_hash).toBe("string");
  });

  it("captures base_ts on the first trigger and preserves it across the batch", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-trigger-ts-"));
    mkdirSync(reviewgateDir(repo), { recursive: true });
    await handleTrigger({ repoRoot: repo, hookStdinRaw: '{"edit":1}' });
    const first = JSON.parse(readFileSync(dirtyFlagPath(repo), "utf8")) as {
      base_ts?: string;
      ts?: string;
    };
    expect(typeof first.base_ts).toBe("string");
    expect(Number.isNaN(Date.parse(first.base_ts ?? ""))).toBe(false);
    // base_ts is back-dated by a safety margin (~30s) relative to the trigger time, so
    // a file created by the FIRST (triggering) edit — whose mtime slightly predates the
    // PostToolUse capture — is not wrongly excluded as pre-existing noise (codex CRIT).
    expect(Date.parse(first.ts ?? "") - Date.parse(first.base_ts ?? "")).toBeGreaterThanOrEqual(
      25_000,
    );
    // A later edit in the same batch updates `ts` but must PRESERVE base_ts.
    await new Promise((r) => setTimeout(r, 5));
    await handleTrigger({ repoRoot: repo, hookStdinRaw: '{"edit":2}' });
    const second = JSON.parse(readFileSync(dirtyFlagPath(repo), "utf8")) as {
      base_ts?: string;
      ts?: string;
    };
    expect(second.base_ts).toBe(first.base_ts); // batch-start, unchanged
    expect(second.ts).not.toBe(first.ts); // last-edit time advanced
  });

  it("never pairs an inherited base_sha with a fresh base_ts (synthesized/legacy flag — F-015)", async () => {
    // A SYNTHESIZED dirty.flag (deferred-flag consumption / HEAD-advanced path)
    // carries a base_sha but no base_ts. The next trigger is NOT the batch's
    // clean→dirty transition, so stamping `now − 30s` would scope batch-created
    // untracked files OUT of the re-review while keeping the old (possibly
    // hours-old) base_sha. It must fall back to the no-scoping sentinel instead.
    const repo = mkdtempSync(join(tmpdir(), "rg-trigger-synth-"));
    mkdirSync(reviewgateDir(repo), { recursive: true });
    const baseSha = "a".repeat(40);
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "deferred", ts: new Date().toISOString(), base_sha: baseSha }),
    );
    await handleTrigger({ repoRoot: repo, hookStdinRaw: '{"edit":1}' });
    const flag = JSON.parse(readFileSync(dirtyFlagPath(repo), "utf8")) as {
      base_sha?: string;
      base_ts?: string;
    };
    expect(flag.base_sha).toBe(baseSha); // review base preserved
    expect(flag.base_ts).toBe(BASE_TS_NO_SCOPING_SENTINEL); // NOT now−30s
  });

  it("preserves a synthesized flag's explicit no-scoping sentinel across later edits", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-trigger-sentinel-"));
    mkdirSync(reviewgateDir(repo), { recursive: true });
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({
        diff_hash: "deferred",
        ts: new Date().toISOString(),
        base_sha: "b".repeat(40),
        base_ts: BASE_TS_NO_SCOPING_SENTINEL,
      }),
    );
    await handleTrigger({ repoRoot: repo, hookStdinRaw: '{"edit":1}' });
    await handleTrigger({ repoRoot: repo, hookStdinRaw: '{"edit":2}' });
    const flag = JSON.parse(readFileSync(dirtyFlagPath(repo), "utf8")) as { base_ts?: string };
    expect(flag.base_ts).toBe(BASE_TS_NO_SCOPING_SENTINEL);
  });

  // S3a: writing .reviewgate/decisions/<iter>.jsonl (which an escalation block
  // message ORDERS the agent to do) must not arm a fresh dirty flag — that would
  // re-review an empty diff and silently neutralize the escalation.
  describe("S3a: excluded-path edits do not arm the flag", () => {
    it("a Write whose only path is under .reviewgate/ does NOT arm the dirty flag", async () => {
      const repo = mkdtempSync(join(tmpdir(), "rg-trigger-s3a-excl-"));
      mkdirSync(reviewgateDir(repo), { recursive: true });
      const stdin = JSON.stringify({
        session_id: "s1",
        tool_name: "Write",
        tool_input: { file_path: join(repo, ".reviewgate/decisions/3.jsonl") },
      });
      await handleTrigger({ repoRoot: repo, hookStdinRaw: stdin });
      expect(existsSync(dirtyFlagPath(repo))).toBe(false);
    });

    it("a Write to a real source file still arms the flag", async () => {
      const repo = mkdtempSync(join(tmpdir(), "rg-trigger-s3a-real-"));
      mkdirSync(reviewgateDir(repo), { recursive: true });
      const stdin = JSON.stringify({
        session_id: "s1",
        tool_name: "Write",
        tool_input: { file_path: join(repo, "src/a.ts") },
      });
      await handleTrigger({ repoRoot: repo, hookStdinRaw: stdin });
      expect(existsSync(dirtyFlagPath(repo))).toBe(true);
    });

    it("unparseable stdin still arms the flag (fail toward review)", async () => {
      const repo = mkdtempSync(join(tmpdir(), "rg-trigger-s3a-badjson-"));
      mkdirSync(reviewgateDir(repo), { recursive: true });
      await handleTrigger({ repoRoot: repo, hookStdinRaw: "not json" });
      expect(existsSync(dirtyFlagPath(repo))).toBe(true);
    });

    it("an UNKNOWN tool shape arms the flag even when the parsed path looks excluded (round-6 W2)", async () => {
      const repo = mkdtempSync(join(tmpdir(), "rg-trigger-s3a-unknown-"));
      mkdirSync(reviewgateDir(repo), { recursive: true });
      const stdin = JSON.stringify({
        session_id: "s1",
        tool_name: "SomeFutureMultiFileTool",
        tool_input: {
          file_path: join(repo, ".reviewgate/decisions/3.jsonl"),
          other_paths: ["src/a.ts"],
        },
      });
      await handleTrigger({ repoRoot: repo, hookStdinRaw: stdin });
      expect(existsSync(dirtyFlagPath(repo))).toBe(true);
    });

    it("a known tool with MORE than one extracted path arms the flag (shape not fully understood)", async () => {
      const repo = mkdtempSync(join(tmpdir(), "rg-trigger-s3a-multi-"));
      mkdirSync(reviewgateDir(repo), { recursive: true });
      // MultiEdit carrying its own top-level file_path PLUS an edits[] entry that
      // references a genuinely different file — editedPathsOf extracts 2 distinct
      // paths, so the "exactly one canonical path" shape assumption doesn't hold.
      const stdin = JSON.stringify({
        session_id: "s1",
        tool_name: "MultiEdit",
        tool_input: {
          file_path: join(repo, ".reviewgate/decisions/3.jsonl"),
          edits: [{ file_path: join(repo, "src/b.ts") }],
        },
      });
      await handleTrigger({ repoRoot: repo, hookStdinRaw: stdin });
      expect(existsSync(dirtyFlagPath(repo))).toBe(true);
    });
  });
});
