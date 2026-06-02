// tests/unit/atomic-write.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../src/utils/atomic-write.ts";

describe("writeFileAtomic", () => {
  it("writes the exact content and leaves no .tmp sibling", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-atomic-"));
    const f = join(dir, "flag.json");
    writeFileAtomic(f, '{"a":1}', { mode: 0o600 });
    expect(readFileSync(f, "utf8")).toBe('{"a":1}');
    expect(existsSync(`${f}.tmp`)).toBe(false);
  });

  it("overwrites an existing file in full (no partial blend)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-atomic2-"));
    const f = join(dir, "flag.json");
    writeFileSync(f, '{"old":"much-longer-previous-content"}');
    writeFileAtomic(f, '{"new":1}');
    expect(readFileSync(f, "utf8")).toBe('{"new":1}');
  });
});
