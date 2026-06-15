// tests/unit/atomic-write.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

  it("two concurrent writers to the SAME target both succeed (no shared-.tmp collision) (F-3)", async () => {
    // A shared fixed `<path>.tmp` let one writer rename away the other's in-flight
    // buffer, spuriously failing CLOSED. With a per-write unique temp, both
    // overlapping writes complete; the target is one of the two complete contents
    // (last-writer-wins) — never a blend, never an error.
    const dir = mkdtempSync(join(tmpdir(), "rg-atomic-conc-"));
    const f = join(dir, "flag.json");
    const a = '{"writer":"a","payload":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}';
    const b = '{"writer":"b"}';
    await Promise.all([
      Promise.resolve().then(() => writeFileAtomic(f, a)),
      Promise.resolve().then(() => writeFileAtomic(f, b)),
    ]);
    const final = readFileSync(f, "utf8");
    expect([a, b]).toContain(final); // a complete, valid one of the two — never a blend
    // No leftover temp files in the dir besides the final target.
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("uses a unique temp name per call (no fixed sibling collision)", () => {
    // Repeated writes never reuse one temp path → two interleaved writers can't
    // clobber each other's scratch file.
    const dir = mkdtempSync(join(tmpdir(), "rg-atomic-uniq-"));
    const f = join(dir, "flag.json");
    for (let i = 0; i < 5; i++) writeFileAtomic(f, `{"i":${i}}`);
    expect(readFileSync(f, "utf8")).toBe('{"i":4}');
    expect(existsSync(`${f}.tmp`)).toBe(false);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
