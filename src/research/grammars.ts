// src/research/grammars.ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GrammarInfo {
  lang: string;
  wasmFile: string;
  tier: "full" | "basic";
}

const EXT_GRAMMAR: Record<string, GrammarInfo> = {
  ".ts": { lang: "typescript", wasmFile: "tree-sitter-typescript.wasm", tier: "full" },
  ".tsx": { lang: "tsx", wasmFile: "tree-sitter-tsx.wasm", tier: "full" },
  ".js": { lang: "typescript", wasmFile: "tree-sitter-typescript.wasm", tier: "full" },
  ".jsx": { lang: "tsx", wasmFile: "tree-sitter-tsx.wasm", tier: "full" },
  ".py": { lang: "python", wasmFile: "tree-sitter-python.wasm", tier: "full" },
};

// Resolution order matters: the binary-adjacent `grammars/` dir (bundled at build
// time, version-matched to the compiled web-tree-sitter) MUST win over a consumer
// project's node_modules — otherwise a compiled reviewgate launched inside another
// repo could load that repo's differently-versioned wasm. In dev mode the
// binary-adjacent path is absent (execPath is `bun`), so it falls through to
// node_modules.
export function resolveGrammarWasm(wasmFile: string): string | null {
  const candidates = [
    join(dirname(process.execPath), "grammars", wasmFile),
    join(process.cwd(), "node_modules/tree-sitter-typescript", wasmFile),
    join(process.cwd(), "node_modules/tree-sitter-python", wasmFile),
    join(process.cwd(), "dist/grammars", wasmFile),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

// The web-tree-sitter ENGINE runtime (`web-tree-sitter.wasm`) that `Parser.init()`
// loads — distinct from the per-language grammar wasms above. Inside a
// `bun build --compile` binary it is NOT embedded, so Parser.init() tries to read
// it from the binary's virtual FS root (`/$bunfs/root/web-tree-sitter.wasm`) and
// aborts with ENOENT — silently emptying every symbol graph. We copy it next to
// the grammars at build time and point Parser.init's `locateFile` here.
export const RUNTIME_WASM = "web-tree-sitter.wasm";

export function resolveRuntimeWasm(): string | null {
  // Binary-adjacent first (see resolveGrammarWasm): the engine wasm must match the
  // web-tree-sitter JS compiled into THIS binary, so the bundled copy wins over a
  // consumer project's node_modules. Dev mode falls through to node_modules.
  const candidates = [
    join(dirname(process.execPath), "grammars", RUNTIME_WASM),
    join(process.cwd(), "node_modules/web-tree-sitter", RUNTIME_WASM),
    join(process.cwd(), "dist/grammars", RUNTIME_WASM),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function grammarForFile(path: string): GrammarInfo | null {
  const ext = path.slice(path.lastIndexOf("."));
  return EXT_GRAMMAR[ext] ?? null;
}
