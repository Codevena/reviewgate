// src/research/symbol-graph.ts
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Language, Parser, Query } from "web-tree-sitter";
import { safeReadContained } from "../utils/safe-read.ts";
import { spawnCapture } from "../utils/spawn-capture.ts";
import {
  RUNTIME_WASM,
  grammarForFile,
  resolveGrammarWasm,
  resolveRuntimeWasm,
} from "./grammars.ts";

// Per-file size cap before tree-sitter parse: a single large/minified changed file
// would otherwise load + build a parse tree of unbounded size (Emscripten heap that
// never shrinks). 2MB covers real hand-written sources with headroom.
const PARSE_FILE_CAP = 2 * 1024 * 1024;
const CALLER_FILE_CAP = 2 * 1024 * 1024;
const SCAN_FILE_CAP = 3000;
const EXCLUDED_CALLER_DIR_NAMES = [
  "node_modules",
  ".git",
  ".reviewgate",
  ".antigravitycli",
  "dist",
] as const;
const EXCLUDED_CALLER_DIR = new RegExp(
  `(?:^|/)(?:${EXCLUDED_CALLER_DIR_NAMES.map(escapeRegExp).join("|")})/`,
);

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

// Per-language symbol + call queries. A query may reference ONLY node types that exist in its
// OWN grammar — a TS node name in a Python query (or vice-versa) makes `new Query()` throw
// "Bad node name …". Selected by grammarForFile().lang. (Before: one TS-only pair, which
// matched nothing for Python AND threw on CALL_QUERY, and missed arrow-const/func-expr/class.)
const FN_QUERY_TS =
  "[(function_declaration name:(identifier) @n) (method_definition name:(property_identifier) @n) (function_signature name:(identifier) @n) (lexical_declaration (variable_declarator name:(identifier) @n value:[(arrow_function) (function_expression)])) (class_declaration name:(type_identifier) @n)] @sym";
const FN_QUERY_PY =
  "[(function_definition name:(identifier) @n) (class_definition name:(identifier) @n)] @sym";
const CALL_QUERY_TS =
  "(call_expression function: [(identifier) @c (member_expression property:(property_identifier) @c)])";
const CALL_QUERY_PY = "(call function: [(identifier) @c (attribute attribute:(identifier) @c)])";

function queriesFor(lang: string): { fn: string; call: string } {
  return lang === "python"
    ? { fn: FN_QUERY_PY, call: CALL_QUERY_PY }
    : { fn: FN_QUERY_TS, call: CALL_QUERY_TS };
}

// Per-run memo: a file is parsed at most once per process. enclosingSymbol (one
// call per finding) and buildSymbolGraph otherwise re-parse the same file many
// times. Files don't change mid-run, so caching by path is safe.
const parseCache = new Map<string, { symbols: SymbolInfo[] } | null>();

async function parseFile(
  file: string,
  repoRoot?: string,
): Promise<{ symbols: SymbolInfo[] } | null> {
  const cached = parseCache.get(file);
  if (cached !== undefined) return cached;
  const result = await parseFileUncached(file, repoRoot);
  parseCache.set(file, result);
  return result;
}

async function parseFileUncached(
  file: string,
  repoRoot?: string,
): Promise<{ symbols: SymbolInfo[] } | null> {
  const g = grammarForFile(file);
  if (!g) return null;
  const lang = await getLanguage(g.wasmFile);
  if (!lang) return null;
  // Symlink-safe, size-capped read BEFORE parsing: refuses a file that escapes the
  // containment root via symlink and never loads a >cap (large/minified) file into the
  // tree-sitter heap. `file` is absolute; contain it under repoRoot when the caller
  // supplied one, else under its own directory (still enforces the size + NUL guards).
  const code = safeReadContained(repoRoot ?? dirname(file), file, PARSE_FILE_CAP);
  if (code === null) return null;
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
    const q = queriesFor(g.lang);
    symQ = new Query(lang, q.fn);
    callQ = new Query(lang, q.call);
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
  } catch {
    // Malformed query / grammar mismatch → treat the file as unparseable so the caller
    // falls back to line windows, instead of throwing and killing the symbol graph for
    // this language. (`finally` below still releases the native handles.)
    return null;
  } finally {
    symQ?.delete();
    callQ?.delete();
    tree.delete();
    p.delete();
  }
}

/** A changed file's symbols (name, startLine, endLine, callees) from the per-language query,
 *  or null when the language is unsupported or the file is unparseable / over the parse size
 *  cap (caller falls back to line windows). Reuses the cached parseFile. */
export async function fileSymbols(file: string, repoRoot?: string): Promise<SymbolInfo[] | null> {
  const parsed = await parseFile(file, repoRoot).catch(() => null);
  return parsed ? parsed.symbols : null;
}

export async function enclosingSymbol(
  file: string,
  line: number,
  repoRoot?: string,
): Promise<{ name: string; startLine: number } | null> {
  const parsed = await parseFile(file, repoRoot).catch(() => null);
  if (!parsed) return null;
  // The INNERMOST enclosing symbol: for a line inside a nested function, several
  // symbols' [startLine,endLine] spans contain it; pick the one with the SMALLEST
  // span (tightest fit) so a nested helper isn't mis-attributed to its outer fn.
  let hit: SymbolInfo | null = null;
  for (const s of parsed.symbols) {
    if (line < s.startLine || line > s.endLine) continue;
    if (!hit || s.endLine - s.startLine < hit.endLine - hit.startLine) hit = s;
  }
  return hit ? { name: hit.name, startLine: hit.startLine } : null;
}

// Returns null when the `rg` binary is UNAVAILABLE (so the caller can fall back),
// [] when rg ran but matched nothing (rg exits 1 on no matches), and the refs
// otherwise. ripgrep is an OPTIONAL dependency — CI and minimal hosts may not have
// it — so callers must not silently vanish when it is missing.
export function classifyRipgrepExit(status: number | null): "matches" | "no-match" | "fallback" {
  if (status === 0) return "matches";
  if (status === 1) return "no-match";
  return "fallback";
}

export function buildRipgrepCallerArgs(symbol: string): string[] {
  const exclusions = EXCLUDED_CALLER_DIR_NAMES.flatMap((dir) => ["--glob", `!**/${dir}/**`]);
  return ["--json", "--no-config", "-w", ...exclusions, "--", symbol, "."];
}

async function ripgrepCallers(
  symbol: string,
  repoRoot: string,
  signal?: AbortSignal,
): Promise<CallerRef[] | null> {
  const r = await spawnCapture("rg", buildRipgrepCallerArgs(symbol), {
    cwd: repoRoot,
    timeoutMs: 30_000,
    signal,
  });
  // null = rg untrustworthy → caller falls back to the bounded scan. ENOENT (not
  // installed), a timeout, AND an abort all qualify; rg exits 1 with no output on
  // no-match (→ [] = "definitively no callers"), 0 with output → parsed refs.
  if (r.spawnError || r.timedOut || r.aborted || r.truncated) return null;
  const exit = classifyRipgrepExit(r.status);
  if (exit === "fallback") return null;
  if (exit === "no-match") return [];
  const parsed = parseRipgrepJson(r.stdout);
  if (parsed === null) return null;
  return normalizeCallerRefs(repoRoot, symbol, parsed);
}

/** Parse ripgrep's JSON-lines protocol without delimiter ambiguity. `null` means
 * malformed/untrustworthy output and makes the caller use the safe fallback. */
export function parseRipgrepJson(stdout: string): CallerRef[] | null {
  const refs: CallerRef[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }
    if (!event || typeof event !== "object") return null;
    const typed = event as {
      type?: unknown;
      data?: { path?: { text?: unknown; bytes?: unknown }; line_number?: unknown };
    };
    if (typed.type !== "match") continue;
    const file = typed.data?.path?.text;
    const lineNumber = typed.data?.line_number;
    // Non-UTF8 paths arrive as `bytes`; Reviewgate cannot render those safely in
    // trusted text context, so reject the rg batch and let the contained fallback
    // decide whether the platform can represent them.
    if (typeof file !== "string" || !Number.isInteger(lineNumber) || Number(lineNumber) < 1) {
      return null;
    }
    refs.push({ file, line: Number(lineNumber) });
  }
  return refs;
}

function escapesRoot(rel: string): boolean {
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Resolve, no-follow-read and canonicalize one repository-controlled caller path.
 * Conversion to `/` happens only after native containment and symlink checks. */
function readContainedCaller(repoRoot: string, raw: string): { file: string; text: string } | null {
  let repoReal: string;
  try {
    repoReal = realpathSync(repoRoot);
  } catch {
    return null;
  }

  const lexicalRoot = resolve(repoRoot);
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(lexicalRoot, raw);
  let relLexical = relative(lexicalRoot, abs);
  let walkRoot = lexicalRoot;
  if (escapesRoot(relLexical)) {
    // A symlinked repo root can legitimately receive paths expressed through its
    // canonical spelling. Accept that spelling, but never a parent/sibling path.
    relLexical = relative(repoReal, abs);
    walkRoot = repoReal;
    if (escapesRoot(relLexical)) return null;
  }

  // Reject every symlink component below the accepted root. safeReadContained
  // already rejects final symlinks and outside-resolving intermediate symlinks;
  // this stricter walk also refuses contained intermediate symlinks so the path
  // rendered to trusted research has one stable repository spelling.
  let cursor = walkRoot;
  for (const part of relLexical.split(sep)) {
    if (!part) continue;
    cursor = resolve(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return null;
    } catch {
      return null;
    }
  }

  const text = safeReadContained(repoRoot, abs, CALLER_FILE_CAP, repoReal);
  if (text === null) return null;
  let candidateReal: string;
  try {
    candidateReal = realpathSync(abs);
  } catch {
    return null;
  }
  const relReal = relative(repoReal, candidateReal);
  if (escapesRoot(relReal)) return null;
  return { file: relReal.split(sep).join("/"), text };
}

function isExcludedCallerCandidate(repoRoot: string, raw: string): boolean {
  const root = resolve(repoRoot);
  const candidateAbsolute = isAbsolute(raw) ? raw : resolve(root, raw);
  const candidateRelative = relative(root, candidateAbsolute).split(sep).join("/");
  return EXCLUDED_CALLER_DIR.test(candidateRelative);
}

function readNormalizedCaller(
  repoRoot: string,
  raw: string,
): { file: string; text: string } | null {
  // Cheap lexical exclusion prevents obvious dependency/build paths from being
  // read. The contained-path result is checked again so canonical paths cannot
  // make the rg and fallback implementations disagree.
  if (isExcludedCallerCandidate(repoRoot, raw)) return null;
  const contained = readContainedCaller(repoRoot, raw);
  if (!contained || EXCLUDED_CALLER_DIR.test(contained.file)) return null;
  return contained;
}

/** Apply the same contained, repo-relative and vendor-exclusion contract to rg
 * records that the built-in fallback applies to scanned candidates. */
export function normalizeCallerRefs(
  repoRoot: string,
  symbol: string,
  refs: CallerRef[],
): CallerRef[] {
  const normalizedRefs: CallerRef[] = [];
  const containedByPath = new Map<string, ReturnType<typeof readNormalizedCaller>>();
  const symbolRef = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
  for (const ref of refs) {
    let normalized = containedByPath.get(ref.file);
    if (!containedByPath.has(ref.file)) {
      normalized = readNormalizedCaller(repoRoot, ref.file);
      containedByPath.set(ref.file, normalized);
    }
    if (!normalized) continue;
    const matchedLine = normalized.text.split("\n")[ref.line - 1];
    if (matchedLine !== undefined && symbolRef.test(matchedLine)) {
      normalizedRefs.push({ file: normalized.file, line: ref.line });
    }
  }
  return normalizedRefs;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Fallback when ripgrep is absent: a bounded built-in scan for word-boundary
// references to `symbol` across the repo's source files (skipping vendored/build
// dirs). Slower than rg, but keeps 1-hop caller detection working without the
// optional binary. Exported for direct testing of the no-ripgrep path.
export function scanCallersFallback(
  symbol: string,
  repoRoot: string,
  candidatePaths?: Iterable<string>,
): CallerRef[] {
  const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
  const refs: CallerRef[] = [];
  let scanned = 0;
  const repoAbsolute = resolve(repoRoot);
  try {
    const candidates =
      candidatePaths ??
      new Bun.Glob("**/*.{ts,tsx,js,py}").scanSync({ cwd: repoRoot, absolute: true });
    for (const raw of candidates) {
      // Glob traversal can encounter thousands of dependency/build files before
      // first-party source. Exclude obvious native paths before either charging
      // the bounded scan budget or reading bytes. Keep the contained-path check
      // below as a second line for symlinks/canonical paths.
      if (isExcludedCallerCandidate(repoAbsolute, raw)) continue;
      if (++scanned > SCAN_FILE_CAP) break;
      const contained = readNormalizedCaller(repoRoot, raw);
      if (!contained) continue;
      const lines = contained.text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i] as string)) refs.push({ file: contained.file, line: i + 1 });
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
  if (rg !== null) return rg;
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
    const parsed = await parseFile(f, input.repoRoot).catch(() => null);
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
