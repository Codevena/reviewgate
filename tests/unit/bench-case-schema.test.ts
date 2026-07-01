import { describe, expect, it } from "bun:test";
import { BenchCaseSchema } from "../../src/schemas/bench-case.ts";

const validSeeded = {
  schema: "reviewgate.bench.case.v1",
  id: "sql-injection-001",
  kind: "seeded-bug",
  language: "ts",
  expected: [{ tag: "sql-injection", file: "src/db.ts", line: 42, min_severity: "CRITICAL" }],
  source: "hand-written",
};

describe("BenchCaseSchema", () => {
  it("parses a valid seeded-bug case", () => {
    const r = BenchCaseSchema.safeParse(validSeeded);
    expect(r.success).toBe(true);
  });

  it("parses a valid clean case with empty expected", () => {
    const r = BenchCaseSchema.safeParse({
      ...validSeeded,
      id: "refactor-001",
      kind: "clean",
      expected: [],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a clean case that carries expected labels", () => {
    const r = BenchCaseSchema.safeParse({ ...validSeeded, kind: "clean" });
    expect(r.success).toBe(false);
  });

  it("defaults strict_region to true when omitted", () => {
    const r = BenchCaseSchema.parse(validSeeded);
    expect(r.strict_region).toBe(true);
  });

  it("coerces a lowercase min_severity to the canonical token", () => {
    const r = BenchCaseSchema.parse({
      ...validSeeded,
      expected: [{ tag: "x", file: "a.ts", line: 1, min_severity: "critical" }],
    });
    expect(r.expected[0]?.min_severity).toBe("CRITICAL");
  });

  it("rejects a non-positive line number", () => {
    const r = BenchCaseSchema.safeParse({
      ...validSeeded,
      expected: [{ tag: "x", file: "a.ts", line: 0, min_severity: "WARN" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown schema tag", () => {
    const r = BenchCaseSchema.safeParse({ ...validSeeded, schema: "reviewgate.bench.case.v2" });
    expect(r.success).toBe(false);
  });

  it("rejects an id containing path-traversal", () => {
    expect(BenchCaseSchema.safeParse({ ...validSeeded, id: "../../evil" }).success).toBe(false);
    expect(BenchCaseSchema.safeParse({ ...validSeeded, id: "a/b" }).success).toBe(false);
    expect(BenchCaseSchema.safeParse({ ...validSeeded, id: ".." }).success).toBe(false);
  });

  it("rejects an expected/allowed file with a parent-traversal segment or absolute path", () => {
    expect(
      BenchCaseSchema.safeParse({
        ...validSeeded,
        expected: [{ tag: "x", file: "../../../etc/passwd", line: 1, min_severity: "WARN" }],
      }).success,
    ).toBe(false);
    expect(
      BenchCaseSchema.safeParse({
        ...validSeeded,
        expected: [{ tag: "x", file: "/etc/passwd", line: 1, min_severity: "WARN" }],
      }).success,
    ).toBe(false);
    expect(
      BenchCaseSchema.safeParse({
        ...validSeeded,
        allowed: [{ tag: "x", file: "../secrets", line: 1 }],
      }).success,
    ).toBe(false);
  });

  it("rejects a single-dot / dot-segment / UNC / windows-drive file path", () => {
    const bad = ["/etc/passwd", "..", "../x", ".", "a/./b", "a//b", "\\\\server\\share", "C:\\x"];
    for (const file of bad) {
      expect(
        BenchCaseSchema.safeParse({
          ...validSeeded,
          expected: [{ tag: "x", file, line: 1, min_severity: "WARN" }],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects an id of '.' or '..' or a leading-dot hidden name", () => {
    for (const id of [".", "..", ".git"]) {
      expect(BenchCaseSchema.safeParse({ ...validSeeded, id }).success).toBe(false);
    }
  });

  it("rejects a seeded-bug case with no expected labels", () => {
    const r = BenchCaseSchema.safeParse({ ...validSeeded, kind: "seeded-bug", expected: [] });
    expect(r.success).toBe(false);
  });

  it("rejects a path containing a null byte or control character", () => {
    for (const file of ["src/db\x00.ts", "src/db\nmalicious.ts"]) {
      expect(
        BenchCaseSchema.safeParse({
          ...validSeeded,
          expected: [{ tag: "x", file, line: 1, min_severity: "WARN" }],
        }).success,
      ).toBe(false);
    }
  });

  it("caps the allowed array length", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      tag: `t${i}`,
      file: "a.ts",
      line: i + 1,
    }));
    expect(BenchCaseSchema.safeParse({ ...validSeeded, allowed: many }).success).toBe(false);
  });

  it("rejects a case with more expected labels than the cap", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      tag: `t${i}`,
      file: "a.ts",
      line: i + 1,
      min_severity: "WARN" as const,
    }));
    expect(BenchCaseSchema.safeParse({ ...validSeeded, expected: many }).success).toBe(false);
  });

  it("accepts optional allowed incidentals", () => {
    const r = BenchCaseSchema.parse({
      ...validSeeded,
      allowed: [{ tag: "unused-var", file: "src/db.ts", line: 40 }],
    });
    expect(r.allowed).toHaveLength(1);
  });
});
