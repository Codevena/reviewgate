// tests/unit/symbol-graph.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Query } from "web-tree-sitter";
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

  it("stops parsing immediately when the signal is already aborted (deadline)", async () => {
    // An already-aborted signal must short-circuit the file-parse loop too (not
    // just the rg loop), so a hung deadline doesn't pay for parsing every file.
    const ac = new AbortController();
    ac.abort();
    const g = await buildSymbolGraph({
      files: [join(DIR, "a.ts"), join(DIR, "b.ts")],
      repoRoot: DIR,
      signal: ac.signal,
    });
    expect(g.symbols).toEqual([]);
    expect(g.callers).toEqual({});
  });

  it("finds callers WITHOUT ripgrep via the built-in scan fallback (CI has no rg)", () => {
    // Exercises the no-ripgrep path directly so a runner lacking `rg` still gets
    // 1-hop callers (was: callers silently empty → CI failure at the rg assertion).
    const refs = scanCallersFallback("alpha", DIR);
    expect(refs.some((r) => r.file.endsWith("b.ts"))).toBe(true);
  });

  it("excludes .antigravitycli/ files from the no-ripgrep caller scan", () => {
    // The fallback scan must not leak agy's working-tree artifact into research
    // context — a .antigravitycli/caller.ts referencing the symbol stays out.
    const repo = mkdtempSync(join(tmpdir(), "rg-symgraph-agy-"));
    writeFileSync(join(repo, "real.ts"), "gamma();\n");
    mkdirSync(join(repo, ".antigravitycli"), { recursive: true });
    writeFileSync(join(repo, ".antigravitycli", "caller.ts"), "gamma();\n");
    const refs = scanCallersFallback("gamma", repo);
    expect(refs.some((r) => r.file.endsWith("real.ts"))).toBe(true);
    expect(refs.some((r) => r.file.includes(".antigravitycli"))).toBe(false);
  });

  it("degrades gracefully for unsupported/missing files (no throw, array result)", async () => {
    const g = await buildSymbolGraph({ files: [join(DIR, "does-not-exist.xyz")], repoRoot: DIR });
    expect(Array.isArray(g.symbols)).toBe(true);
    expect(g.symbols.length).toBe(0);
  });

  it("releases native WASM memory: every Query built is .delete()'d (F-064)", async () => {
    // web-tree-sitter Query/Tree/Parser own Emscripten heap memory; without
    // .delete() the WASM heap grows per parsed file and never shrinks. Spy on the
    // Query prototype to confirm each query built during a parse is released, and
    // that parsing still returns correct symbols (deletes happen AFTER extraction).
    // A UNIQUE file (the per-process parseCache would otherwise skip re-parsing a
    // file an earlier test already parsed, building no new Query).
    const repo = mkdtempSync(join(tmpdir(), "rg-symgraph-leak-"));
    writeFileSync(join(repo, "leak.ts"), "function zeta() {\n  eta();\n}\nfunction eta() {}\n");
    const orig = Query.prototype.delete;
    let deletes = 0;
    Query.prototype.delete = function patched(this: Query) {
      deletes++;
      return orig.call(this);
    };
    try {
      const g = await buildSymbolGraph({ files: [join(repo, "leak.ts")], repoRoot: repo });
      // parsing still works (no use-after-delete)
      expect(g.symbols.find((s) => s.name === "zeta")?.callees).toContain("eta");
      // both queries (FN_QUERY + CALL_QUERY) for the file were released
      expect(deletes).toBeGreaterThanOrEqual(2);
    } finally {
      Query.prototype.delete = orig;
    }
  });
});
