// tests/unit/handlers.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleTrigger } from "../../src/hooks/handlers.ts";
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
});
