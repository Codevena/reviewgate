import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Range } from "../../src/diff/hunks.ts";
import { collectFileContext } from "../../src/research/file-context.ts";

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-fctx-"));
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);
  return dir;
}
const opts = (repoRoot: string, ranges: [string, Range[]][]) => ({
  repoRoot,
  changedRanges: new Map(ranges),
  totalBudgetBytes: 32_000,
  perFileBytes: 400,
  windowLines: 3,
});

describe("collectFileContext", () => {
  test("small file → whole-file block", async () => {
    const repo = repoWith({ "a.ts": "export const x = 1;\n" });
    const out = await collectFileContext(opts(repo, [["a.ts", [[1, 2]]]]));
    expect(out).toContain("### a.ts");
    expect(out).toContain("export const x = 1;");
    expect(out).not.toContain("scoped");
  });

  test("large TS file, change in one function → that body + outline, NOT the unrelated body", async () => {
    const big = `${"// pad\n".repeat(80)}function target() {\n  return 42;\n}\nfunction unrelatedHuge() {\n${"  const q = 1;\n".repeat(60)}}\n`;
    const repo = repoWith({ "b.ts": big });
    const out = await collectFileContext(opts(repo, [["b.ts", [[81, 84]]]]));
    expect(out).toContain("scoped");
    expect(out).toContain("function target()");
    expect(out).toContain("// symbols:");
    expect(out).toContain("unrelatedHuge");
    expect(out).not.toContain("const q = 1;");
  });

  test("nested method-in-class → outermost (class) body once, not double", async () => {
    const cls = `${"// pad\n".repeat(60)}class Svc {\n  run() {\n    return doWork();\n  }\n}\n`;
    const repo = repoWith({ "c.ts": cls });
    const out = await collectFileContext(opts(repo, [["c.ts", [[63, 64]]]]));
    expect(out).toContain("class Svc");
    expect(out.split("return doWork();").length - 1).toBe(1);
  });

  test("large non-TS file (.go) → line window, no outline, not omitted", async () => {
    const go = `${"// pad\n".repeat(120)}func Target() int {\n\treturn 7\n}\n`;
    const repo = repoWith({ "d.go": go });
    const out = await collectFileContext(opts(repo, [["d.go", [[121, 123]]]]));
    expect(out).toContain("func Target()");
    expect(out).not.toContain("// symbols:");
    expect(out).not.toContain("(omitted");
  });

  test("total budget bounds output", async () => {
    const f = `${"x".repeat(1000)}\n`;
    const repo = repoWith({ "a.ts": `const a=()=>{${f}};\n`, "z.ts": `const z=()=>{${f}};\n` });
    const out = await collectFileContext({
      ...opts(repo, [
        ["a.ts", [[1, 2]]],
        ["z.ts", [[1, 2]]],
      ]),
      totalBudgetBytes: 1200,
    });
    expect(out.length).toBeLessThanOrEqual(1200);
  });

  test("symlink / excluded path is skipped", async () => {
    const repo = repoWith({ "real.ts": "const ok = 1;\n" });
    const out = await collectFileContext(
      opts(repo, [
        ["real.ts", [[1, 2]]],
        [".reviewgate/state.json", [[1, 2]]],
      ]),
    );
    expect(out).toContain("real.ts");
    expect(out).not.toContain(".reviewgate/state.json");
  });
});
