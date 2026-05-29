// tests/unit/no-raw-json-parse-guard.test.ts
//
// Structural guard: the untrusted-output boundary (every reviewer/critic adapter)
// must parse JSON only through `safeJsonParse`/`parseUntrusted` (src/utils/safe-json.ts),
// never a raw `JSON.parse(...)`. A raw parse followed by a property access is the
// fail-OPEN crash class the audit kept finding (JSON.parse("null").field → TypeError
// → gate crashes → turn ends un-reviewed). This test fails the build if a new raw
// `JSON.parse(` sneaks into those files — making the whole class structurally
// impossible, not just the instances fixed so far.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const ROOT = process.cwd();

// Files at the untrusted boundary that must route JSON parsing through safe-json.
function boundaryFiles(): string[] {
  const files = [...new Glob("src/providers/*.ts").scanSync(ROOT)].map((p) => join(ROOT, p));
  files.push(join(ROOT, "src/core/critic.ts"));
  return files;
}

// Strip line comments so a `// JSON.parse(...)` explanation doesn't trip the guard.
function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => {
    const t = l.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  });
}

describe("no raw JSON.parse at the untrusted boundary", () => {
  it("providers/* and critic.ts parse JSON only via safe-json (no raw JSON.parse)", () => {
    const offenders: string[] = [];
    for (const file of boundaryFiles()) {
      const lines = codeLines(readFileSync(file, "utf8"));
      lines.forEach((l, i) => {
        if (l.includes("JSON.parse(")) offenders.push(`${file}:${i + 1}  ${l.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the canonical safe parser lives in src/utils/safe-json.ts", () => {
    const src = readFileSync(join(ROOT, "src/utils/safe-json.ts"), "utf8");
    // safe-json IS the one place a raw JSON.parse is allowed (inside a try/catch).
    expect(src).toContain("JSON.parse(");
    expect(src).toContain("export function safeJsonParse");
    expect(src).toContain("export function parseUntrusted");
  });
});
