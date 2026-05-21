// src/research/symbol-graph.ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Language, Parser, Query } from "web-tree-sitter";
import {
  RUNTIME_WASM,
  grammarForFile,
  resolveGrammarWasm,
  resolveRuntimeWasm,
} from "./grammars.ts";

export interface SymbolInfo {
  name: string;
  startLine: number;
  endLine: number;
  callees: string[];
}
export interface CallerRef {
  file: string;
  line: number;
}
export interface SymbolGraph {
  symbols: SymbolInfo[];
  callers: Record<string, CallerRef[]>;
}

type LoadedLanguage = Awaited<ReturnType<typeof Language.load>>;

let parserReady: Promise<void> | null = null;
const langCache = new Map<string, LoadedLanguage>();

// web-tree-sitter loads its engine runtime via an Emscripten `locateFile` hook.
// The default resolves `web-tree-sitter.wasm` relative to the script, which in a
// compiled binary is the absent `/$bunfs/root/…` → Parser.init() aborts. Point it
// at the resolved runtime wasm (next to the grammars in the binary, or
// node_modules in dev). Returns undefined in dev-with-no-runtime so Parser.init
// keeps its default behavior.
function parserInitOptions(): { locateFile: (scriptName: string) => string } | undefined {
  const runtime = resolveRuntimeWasm();
  if (!runtime) return undefined;
  // Redirect ONLY the engine runtime wasm; preserve the default for any other
  // file Emscripten's locateFile is consulted for (grammars are loaded via an
  // explicit absolute path through Language.load, not through locateFile).
  return {
    locateFile: (scriptName: string) => (scriptName.endsWith(RUNTIME_WASM) ? runtime : scriptName),
  };
}

// Exported so other research modules (e.g. imports.ts) reuse the SAME parser
// init + language cache rather than re-initialising tree-sitter differently.
export async function getLanguage(wasmFile: string): Promise<LoadedLanguage | null> {
  const path = resolveGrammarWasm(wasmFile);
  if (!path) return null;
  const cached = langCache.get(wasmFile);
  if (cached) return cached;
  if (!parserReady) parserReady = Parser.init(parserInitOptions());
  await parserReady;
  const lang = await Language.load(path);
  langCache.set(wasmFile, lang);
  return lang;
}

const FN_QUERY =
  "[(function_declaration name:(identifier) @n) (method_definition name:(property_identifier) @n) (function_signature name:(identifier) @n)] @sym";
const CALL_QUERY =
  "(call_expression function: [(identifier) @c (member_expression property:(property_identifier) @c)])";

// Per-run memo: a file is parsed at most once per process. enclosingSymbol (one
// call per finding) and buildSymbolGraph otherwise re-parse the same file many
// times. Files don't change mid-run, so caching by path is safe.
const parseCache = new Map<string, { symbols: SymbolInfo[] } | null>();

async function parseFile(file: string): Promise<{ symbols: SymbolInfo[] } | null> {
  const cached = parseCache.get(file);
  if (cached !== undefined) return cached;
  const result = await parseFileUncached(file);
  parseCache.set(file, result);
  return result;
}

async function parseFileUncached(file: string): Promise<{ symbols: SymbolInfo[] } | null> {
  const g = grammarForFile(file);
  if (!g) return null;
  const lang = await getLanguage(g.wasmFile);
  if (!lang) return null;
  let code: string;
  try {
    code = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const p = new Parser();
  p.setLanguage(lang);
  const tree = p.parse(code);
  if (!tree) return null;
  const symbols: SymbolInfo[] = [];
  const symQ = new Query(lang, FN_QUERY);
  const callQ = new Query(lang, CALL_QUERY);
  for (const match of symQ.matches(tree.rootNode)) {
    const symNode = match.captures.find((c) => c.name === "sym")?.node;
    const nameNode = match.captures.find((c) => c.name === "n")?.node;
    if (!symNode || !nameNode) continue;
    const callees = [...new Set(callQ.captures(symNode).map((c) => c.node.text))];
    symbols.push({
      name: nameNode.text,
      startLine: symNode.startPosition.row + 1,
      endLine: symNode.endPosition.row + 1,
      callees,
    });
  }
  return { symbols };
}

export async function enclosingSymbol(
  file: string,
  line: number,
): Promise<{ name: string; startLine: number } | null> {
  const parsed = await parseFile(file).catch(() => null);
  if (!parsed) return null;
  const hit = parsed.symbols.find((s) => line >= s.startLine && line <= s.endLine);
  return hit ? { name: hit.name, startLine: hit.startLine } : null;
}

function ripgrepCallers(symbol: string, repoRoot: string): CallerRef[] {
  const r = spawnSync("rg", ["-n", "--no-heading", "-w", symbol, repoRoot], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return [];
  const refs: CallerRef[] = [];
  for (const ln of r.stdout.split("\n")) {
    const m = ln.match(/^(.+?):(\d+):/);
    if (m?.[1] && m[2]) refs.push({ file: m[1], line: Number(m[2]) });
  }
  return refs;
}

export async function buildSymbolGraph(input: {
  files: string[];
  repoRoot: string;
}): Promise<SymbolGraph> {
  const symbols: SymbolInfo[] = [];
  for (const f of input.files) {
    const parsed = await parseFile(f).catch(() => null);
    if (parsed) symbols.push(...parsed.symbols);
  }
  const callers: Record<string, CallerRef[]> = {};
  for (const s of symbols) {
    const refs = ripgrepCallers(s.name, input.repoRoot).filter(
      (r) =>
        r.file.endsWith(".ts") ||
        r.file.endsWith(".tsx") ||
        r.file.endsWith(".js") ||
        r.file.endsWith(".py"),
    );
    if (refs.length) callers[s.name] = refs;
  }
  return { symbols, callers };
}
