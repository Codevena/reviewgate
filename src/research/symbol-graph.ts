// src/research/symbol-graph.ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Language, Parser, Query } from "web-tree-sitter";
import { grammarForFile, resolveGrammarWasm } from "./grammars.ts";

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

async function getLanguage(wasmFile: string): Promise<LoadedLanguage | null> {
  const path = resolveGrammarWasm(wasmFile);
  if (!path) return null;
  const cached = langCache.get(wasmFile);
  if (cached) return cached;
  if (!parserReady) parserReady = Parser.init();
  await parserReady;
  const lang = await Language.load(path);
  langCache.set(wasmFile, lang);
  return lang;
}

const FN_QUERY =
  "[(function_declaration name:(identifier) @n) (method_definition name:(property_identifier) @n) (function_signature name:(identifier) @n)] @sym";
const CALL_QUERY =
  "(call_expression function: [(identifier) @c (member_expression property:(property_identifier) @c)])";

async function parseFile(file: string): Promise<{ symbols: SymbolInfo[] } | null> {
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
