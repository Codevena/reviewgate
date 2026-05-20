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

export function resolveGrammarWasm(wasmFile: string): string | null {
  const candidates = [
    join(process.cwd(), "node_modules/tree-sitter-typescript", wasmFile),
    join(process.cwd(), "node_modules/tree-sitter-python", wasmFile),
    join(dirname(process.execPath), "grammars", wasmFile),
    join(process.cwd(), "dist/grammars", wasmFile),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function grammarForFile(path: string): GrammarInfo | null {
  const ext = path.slice(path.lastIndexOf("."));
  return EXT_GRAMMAR[ext] ?? null;
}
