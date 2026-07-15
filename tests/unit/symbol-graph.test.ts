// tests/unit/symbol-graph.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Query } from "web-tree-sitter";
import * as symbolGraphModule from "../../src/research/symbol-graph.ts";
import {
  buildSymbolGraph,
  classifyRipgrepExit,
  enclosingSymbol,
  fileSymbols,
  parseRipgrepJson,
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
    expect(g.callers.alpha?.some((ref) => ref.file === "b.ts")).toBe(true);
    expect(JSON.stringify(g.callers)).not.toContain(DIR);
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
    expect(refs.some((r) => r.file === "b.ts")).toBe(true);
    expect(JSON.stringify(refs)).not.toContain(DIR);
  });

  it("fallback refuses outside symlinks before reading caller content", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-symgraph-link-"));
    const outside = mkdtempSync(join(tmpdir(), "rg-symgraph-outside-"));
    const target = join(outside, "secret.ts");
    writeFileSync(target, "outsideSecret();\n");
    const link = join(repo, "leak.ts");
    symlinkSync(target, link);
    // Proves the injectable candidate list is honored: an implementation that
    // ignores it and scans the whole repo would find this ordinary file.
    writeFileSync(join(repo, "ordinary.ts"), "outsideSecret();\n");

    expect(scanCallersFallback("outsideSecret", repo, [link])).toEqual([]);
  });

  it("fallback refuses oversized caller files instead of loading them", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-symgraph-large-"));
    writeFileSync(join(repo, "huge.ts"), `${"x".repeat(2 * 1024 * 1024)}\noversizedCall();\n`);

    expect(scanCallersFallback("oversizedCall", repo)).toEqual([]);
  });

  it("bounds candidate attempts even when every fallback path is unreadable", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-symgraph-cap-"));
    let yielded = 0;
    function* missingCandidates() {
      while (yielded < 4000) {
        yielded++;
        yield join(repo, `missing-${yielded}.ts`);
      }
    }

    expect(scanCallersFallback("neverFound", repo, missingCandidates())).toEqual([]);
    // for-of fetches one final candidate before the body can observe the cap.
    expect(yielded).toBeLessThanOrEqual(3001);
  });

  it("does not spend the fallback scan cap on excluded vendor paths", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-symgraph-vendor-cap-"));
    const sourceDir = join(repo, "src");
    mkdirSync(sourceDir, { recursive: true });
    const caller = join(sourceDir, "caller.ts");
    writeFileSync(caller, "firstPartyCall();\n");

    function* vendorHeavyCandidates() {
      for (let i = 0; i < 3000; i++) {
        yield join(repo, "node_modules", `dependency-${i}.ts`);
      }
      yield caller;
    }

    expect(scanCallersFallback("firstPartyCall", repo, vendorHeavyCandidates())).toEqual([
      { file: "src/caller.ts", line: 1 },
    ]);
  });

  it("parses rg --json paths without colon/newline/Unicode ambiguity", () => {
    const names = ["dir:12:file.ts", "line\nbreak.py", "grüße.ts"];
    const output = names
      .map((file, i) =>
        JSON.stringify({
          type: "match",
          data: {
            path: { text: file },
            lines: { text: "alpha();\n" },
            line_number: i + 1,
            absolute_offset: 0,
            submatches: [],
          },
        }),
      )
      .join("\n");

    expect(parseRipgrepJson(output)).toEqual(names.map((file, i) => ({ file, line: i + 1 })));
    expect(parseRipgrepJson("{malformed")).toBeNull();
  });

  it("applies the same contained vendor exclusions to ripgrep caller refs", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-symgraph-rg-normalize-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "node_modules", "dependency"), { recursive: true });
    writeFileSync(join(repo, "src", "caller.ts"), "sharedSymbol();\n");
    writeFileSync(join(repo, "node_modules", "dependency", "caller.ts"), "sharedSymbol();\n");

    const normalize = (
      symbolGraphModule as unknown as {
        normalizeCallerRefs?: (
          repoRoot: string,
          symbol: string,
          refs: Array<{ file: string; line: number }>,
        ) => Array<{ file: string; line: number }>;
      }
    ).normalizeCallerRefs;

    expect(normalize).toBeDefined();
    expect(
      normalize?.(repo, "sharedSymbol", [
        { file: "node_modules/dependency/caller.ts", line: 1 },
        { file: "src/caller.ts", line: 1 },
        { file: "src/caller.ts", line: 2 },
      ]),
    ).toEqual([{ file: "src/caller.ts", line: 1 }]);
  });

  it("excludes fallback-ignored directories in the ripgrep scan itself", () => {
    const buildArgs = (
      symbolGraphModule as unknown as {
        buildRipgrepCallerArgs?: (symbol: string) => string[];
      }
    ).buildRipgrepCallerArgs;

    expect(buildArgs).toBeDefined();
    const args = buildArgs?.("sharedSymbol") ?? [];
    for (const dir of ["node_modules", ".git", ".reviewgate", ".antigravitycli", "dist"]) {
      expect(args).toContain("--glob");
      expect(args).toContain(`!**/${dir}/**`);
    }
  });

  it("falls back on real ripgrep errors while treating exit 1 as no matches", () => {
    expect(classifyRipgrepExit(0)).toBe("matches");
    expect(classifyRipgrepExit(1)).toBe("no-match");
    expect(classifyRipgrepExit(2)).toBe("fallback");
    expect(classifyRipgrepExit(null)).toBe("fallback");
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

  it("captures TS arrow-const, exported arrow, function-expression, class, method", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-sym-ts-"));
    const f = join(dir, "x.ts");
    writeFileSync(
      f,
      [
        "export const Widget = (p: number) => {",
        "  return p + 1;",
        "};",
        "const helper = function () { return 2; };",
        "class Box {",
        "  area() { return 3; }",
        "}",
        "function plain() { return 4; }",
      ].join("\n"),
    );
    const syms = await fileSymbols(f, dir);
    const names = (syms ?? []).map((s) => s.name).sort();
    expect(names).toContain("Widget");
    expect(names).toContain("helper");
    expect(names).toContain("Box");
    expect(names).toContain("area");
    expect(names).toContain("plain");
    const w = (syms ?? []).find((s) => s.name === "Widget");
    expect(w?.startLine).toBe(1);
    expect(w?.endLine).toBe(3);
  });

  it("captures Python def and class (previously zero — both queries were TS-only)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-sym-py-"));
    const f = join(dir, "x.py");
    writeFileSync(
      f,
      ["def foo():", "    bar()", "", "class C:", "    def m(self):", "        pass"].join("\n"),
    );
    const syms = await fileSymbols(f, dir);
    const names = (syms ?? []).map((s) => s.name).sort();
    expect(names).toContain("foo");
    expect(names).toContain("C");
    const foo = (syms ?? []).find((s) => s.name === "foo");
    expect(foo?.callees).toContain("bar");
  });

  it("enclosingSymbol resolves a line inside an arrow-const body (was null before)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-sym-enc-"));
    const f = join(dir, "y.ts");
    writeFileSync(
      f,
      ["export const Widget = () => {", "  const z = 1;", "  return z;", "};"].join("\n"),
    );
    const sym = await enclosingSymbol(f, 2, dir);
    expect(sym?.name).toBe("Widget");
  });

  it("fileSymbols returns null for an unsupported extension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-sym-unsup-"));
    const f = join(dir, "x.rb");
    writeFileSync(f, "def foo; end\n");
    expect(await fileSymbols(f, dir)).toBeNull();
  });
});
