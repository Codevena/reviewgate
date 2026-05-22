// tests/unit/report-file.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReportFile } from "../../src/stats/report-file.ts";

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-rf-"));
  return join(dir, "nested", "2026-W20.md"); // nested dir must be created
}

describe("writeReportFile", () => {
  it("creates the dir and writes the content (overwrite mode)", () => {
    const p = tmpFile();
    writeReportFile(p, "hello", { exclusive: false });
    expect(readFileSync(p, "utf8")).toBe("hello");
    writeReportFile(p, "world", { exclusive: false });
    expect(readFileSync(p, "utf8")).toBe("world");
  });

  it("exclusive mode creates if absent and refuses to overwrite", () => {
    const p = tmpFile();
    expect(writeReportFile(p, "first", { exclusive: true })).toBe(true);
    expect(writeReportFile(p, "second", { exclusive: true })).toBe(false);
    expect(readFileSync(p, "utf8")).toBe("first");
  });

  it("leaves no temp files behind", () => {
    const p = tmpFile();
    writeReportFile(p, "x", { exclusive: true });
    const dir = join(p, "..");
    const leftovers = [...new Bun.Glob("*.tmp").scanSync({ cwd: dir })];
    expect(leftovers).toEqual([]);
  });
});
