// tests/unit/symbol-graph.test.ts
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  buildSymbolGraph,
  enclosingSymbol,
  scanCallersFallback,
} from "../../src/research/symbol-graph.ts";

const DIR = join(process.cwd(), "tests/fixtures/symgraph");

describe("symbol-graph", () => {
  it("finds the enclosing symbol for a line in a TS file", async () => {
    const sym = await enclosingSymbol(join(DIR, "a.ts"), 2);
    expect(sym?.name).toBe("alpha");
    expect(sym?.startLine).toBe(1);
  });

  it("lists 1-hop callees (tree-sitter) and callers (ripgrep)", async () => {
    const g = await buildSymbolGraph({ files: [join(DIR, "a.ts")], repoRoot: DIR });
    const alpha = g.symbols.find((s) => s.name === "alpha");
    expect(alpha?.callees).toContain("beta");
    expect(g.callers.alpha?.some((ref) => ref.file.endsWith("b.ts"))).toBe(true);
  });

  it("finds callers WITHOUT ripgrep via the built-in scan fallback (CI has no rg)", () => {
    // Exercises the no-ripgrep path directly so a runner lacking `rg` still gets
    // 1-hop callers (was: callers silently empty → CI failure at the rg assertion).
    const refs = scanCallersFallback("alpha", DIR);
    expect(refs.some((r) => r.file.endsWith("b.ts"))).toBe(true);
  });

  it("degrades gracefully for unsupported/missing files (no throw, array result)", async () => {
    const g = await buildSymbolGraph({ files: [join(DIR, "does-not-exist.xyz")], repoRoot: DIR });
    expect(Array.isArray(g.symbols)).toBe(true);
    expect(g.symbols.length).toBe(0);
  });
});
