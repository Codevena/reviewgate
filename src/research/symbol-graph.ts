// src/research/symbol-graph.ts
import { readFileSync } from "node:fs";
import { Language, Parser, Query } from "web-tree-sitter";
import { spawnCapture } from "../utils/spawn-capture.ts";
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
  if (!tree) {
    // Parser also owns native (Emscripten) memory — release it on the early exit.
    p.delete();
    return null;
  }
  // Tree, Query and Parser each own WASM heap memory that is NOT garbage-collected;
  // without .delete() the Emscripten heap grows per parsed file and never shrinks.
  // Build all extracted data first, then release every native handle in finally
  // (deletes happen AFTER all node.text/captures are read — no use-after-free) (F-064).
  let symQ: Query | null = null;
  let callQ: Query | null = null;
  try {
    const symbols: SymbolInfo[] = [];
    symQ = new Query(lang, FN_QUERY);
    callQ = new Query(lang, CALL_QUERY);
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
  } finally {
    symQ?.delete();
    callQ?.delete();
    tree.delete();
    p.delete();
  }
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

// Returns null when the `rg` binary is UNAVAILABLE (so the caller can fall back),
// [] when rg ran but matched nothing (rg exits 1 on no matches), and the refs
// otherwise. ripgrep is an OPTIONAL dependency — CI and minimal hosts may not have
// it — so callers must not silently vanish when it is missing.
async function ripgrepCallers(
  symbol: string,
  repoRoot: string,
  signal?: AbortSignal,
): Promise<CallerRef[] | null> {
  const r = await spawnCapture("rg", ["-n", "--no-heading", "-w", symbol, repoRoot], {
    timeoutMs: 30_000,
    signal,
  });
  // null = rg untrustworthy → caller falls back to the bounded scan. ENOENT (not
  // installed), a timeout, AND an abort all qualify; rg exits 1 with no output on
  // no-match (→ [] = "definitively no callers"), 0 with output → parsed refs.
  if (r.spawnError || r.timedOut || r.aborted) return null;
  if (r.status !== 0 || !r.stdout) return [];
  const refs: CallerRef[] = [];
  for (const ln of r.stdout.split("\n")) {
    const m = ln.match(/^(.+?):(\d+):/);
    if (m?.[1] && m[2]) refs.push({ file: m[1], line: Number(m[2]) });
  }
  return refs;
}

const SCAN_FILE_CAP = 3000;
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Fallback when ripgrep is absent: a bounded built-in scan for word-boundary
// references to `symbol` across the repo's source files (skipping vendored/build
// dirs). Slower than rg, but keeps 1-hop caller detection working without the
// optional binary. Exported for direct testing of the no-ripgrep path.
export function scanCallersFallback(symbol: string, repoRoot: string): CallerRef[] {
  const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
  const refs: CallerRef[] = [];
  let scanned = 0;
  try {
    for (const abs of new Bun.Glob("**/*.{ts,tsx,js,py}").scanSync({
      cwd: repoRoot,
      absolute: true,
    })) {
      if (/(?:^|\/)(?:node_modules|\.git|\.reviewgate|\.antigravitycli|dist)\//.test(abs)) continue;
      if (++scanned > SCAN_FILE_CAP) break;
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i] as string)) refs.push({ file: abs, line: i + 1 });
      }
    }
  } catch {
    // best-effort — a glob/read failure just yields fewer callers
  }
  return refs;
}

// rg if available, else the built-in scan. On abort, return [] WITHOUT running
// the fallback scan — we're past the deadline, so do no further work.
async function findCallers(
  symbol: string,
  repoRoot: string,
  signal?: AbortSignal,
): Promise<CallerRef[]> {
  const rg = await ripgrepCallers(symbol, repoRoot, signal);
  if (rg) return rg;
  if (signal?.aborted) return [];
  return scanCallersFallback(symbol, repoRoot);
}

export async function buildSymbolGraph(input: {
  files: string[];
  repoRoot: string;
  signal?: AbortSignal | undefined;
}): Promise<SymbolGraph> {
  const symbols: SymbolInfo[] = [];
  for (const f of input.files) {
    // Stop parsing once the gate self-deadline aborts — tree-sitter parsing is
    // CPU-bound per file, so a large change set shouldn't be fully parsed after
    // the deadline has already fired.
    if (input.signal?.aborted) break;
    const parsed = await parseFile(f).catch(() => null);
    if (parsed) symbols.push(...parsed.symbols);
  }
  const callers: Record<string, CallerRef[]> = {};
  for (const s of symbols) {
    // Stop launching more `rg` calls once the gate self-deadline has aborted —
    // each is up to 30s, so N symbols could otherwise delay the fail-closed path.
    if (input.signal?.aborted) break;
    const refs = (await findCallers(s.name, input.repoRoot, input.signal)).filter(
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
