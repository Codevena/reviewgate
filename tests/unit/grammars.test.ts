// tests/unit/grammars.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveGrammarWasm, resolveRuntimeWasm } from "../../src/research/grammars.ts";

describe("grammars path resolution", () => {
  it("resolves a grammar .wasm to an existing file (dev: node_modules)", () => {
    const p = resolveGrammarWasm("tree-sitter-typescript.wasm");
    expect(p).not.toBeNull();
    expect(existsSync(p as string)).toBe(true);
  });

  // The web-tree-sitter ENGINE runtime wasm (distinct from the grammar wasms)
  // must be locatable too — otherwise Parser.init() aborts inside the compiled
  // binary with "ENOENT … web-tree-sitter.wasm" and every symbol graph is empty.
  it("resolves the web-tree-sitter runtime wasm to an existing file", () => {
    const p = resolveRuntimeWasm();
    expect(p).not.toBeNull();
    expect((p as string).endsWith("web-tree-sitter.wasm")).toBe(true);
    expect(existsSync(p as string)).toBe(true);
  });

  // Regression guard: the symbol graph is empty in the COMPILED binary unless the
  // build copies the engine runtime wasm next to the grammars. This only manifests
  // in `dist/reviewgate` (source-mode `bun test` loads it from node_modules), so a
  // dropped copy step would otherwise pass CI silently. Lock the build step down.
  it("the build script bundles the web-tree-sitter runtime wasm into dist/grammars", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.scripts.build).toContain("web-tree-sitter/web-tree-sitter.wasm");
    expect(pkg.scripts.build).toContain("dist/grammars");
  });
});
