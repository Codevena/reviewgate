/**
 * src/research/imports.ts
 *
 * extractImportedLibs(repoRoot, changedFiles) → the external (non-relative,
 * non-builtin) npm packages imported by the changed files, each resolved to a
 * pinned version where possible. Feeds the Context7 docs fetch (M6).
 *
 * Parsing uses tree-sitter (the SAME parser init + language cache as
 * symbol-graph.ts, via the exported `getLanguage`). A narrow regex is used ONLY
 * as a labelled fallback when a tree-sitter parse fails — regex over-matches
 * comments/strings and misses `import type`/namespace/dynamic-`import()`/CJS
 * `require`, so it must not be the primary path.
 *
 * Scope (M6): JS/TS files only; version resolution from root `package.json` +
 * `bun.lock`. Other ecosystems/lockfiles are an explicit unsupported case
 * (version `null`).
 */

import { relative } from "node:path";
import type { Language, Node } from "web-tree-sitter";
import { Parser, Query } from "web-tree-sitter";
import { safeReadContained } from "../utils/safe-read.ts";
import { grammarForFile } from "./grammars.ts";
import { getLanguage } from "./symbol-graph.ts";

// Project files are read here as trusted reviewer context AND fed to the synchronous
// regex/JSONC fallbacks on the review hot path. safeReadContained refuses symlinks
// escaping the repo and caps size — the cap also bounds the input the (linear,
// non-backtracking) fallback regexes scan, so a huge/minified file can't burn CPU.
const IMPORTS_FILE_CAP = 1024 * 1024;

export interface ImportedLib {
  name: string;
  version: string | null;
  fromFiles: string[];
}

// Node core builtins (bare specifiers) — dropped. `node:` prefixed specifiers
// are dropped separately by prefix.
const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

const JS_TS_LANGS = new Set(["typescript", "tsx"]);

/** Strip surrounding quotes / backticks from a tree-sitter string node's text. */
function stringNodeValue(node: Node): string | null {
  const frag = node.namedChildren.find((c) => c?.type === "string_fragment");
  if (frag) return frag.text;
  const t = node.text;
  return t.replace(/^['"`]|['"`]$/g, "");
}

/** First string-literal argument of a call's `arguments` node, if any. */
function firstStringArg(args: Node | null): string | null {
  if (!args) return null;
  for (const child of args.namedChildren) {
    if (child?.type === "string") return stringNodeValue(child);
  }
  return null;
}

/** Tree-sitter extraction of module specifiers from a JS/TS source string. */
function treeSitterSpecifiers(rootNode: Node, lang: Language): string[] {
  const specs: string[] = [];
  const q = new Query(lang, "[(import_statement) @imp (call_expression) @call]");
  for (const match of q.matches(rootNode)) {
    for (const cap of match.captures) {
      const node = cap.node;
      if (node.type === "import_statement") {
        // import x from "m" | import "m" | import type {…} from "m" | import * as ns from "m"
        const source = node.childForFieldName("source");
        if (source) {
          const v = stringNodeValue(source);
          if (v) specs.push(v);
        }
        continue;
      }
      // call_expression — dynamic import("m") or require("m")
      const fn = node.childForFieldName("function");
      if (!fn) continue;
      const isDynamicImport = fn.type === "import" || fn.text === "import";
      const isRequire = fn.type === "identifier" && fn.text === "require";
      if (isDynamicImport || isRequire) {
        const v = firstStringArg(node.childForFieldName("arguments"));
        if (v) specs.push(v);
      }
    }
  }
  return specs;
}

/**
 * Labelled regex fallback — used ONLY when tree-sitter parsing fails. Narrow:
 * matches quoted module specifiers in from / require() / import() / bare-import
 * positions. Deliberately conservative (it can miss; it should not over-match).
 */
function regexSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((m = re.exec(code)) !== null) {
      if (m[1]) specs.push(m[1]);
    }
  }
  return specs;
}

/** Reduce a module specifier to its package name, or null if not an external pkg. */
export function specToPackage(spec: string): string | null {
  if (!spec) return null;
  if (spec.startsWith(".") || spec.startsWith("/")) return null; // relative / absolute
  if (spec.startsWith("node:")) return null; // explicit builtin
  if (spec.startsWith("@")) {
    // scoped: keep "@scope/name", drop deeper segments. Reject empty-scope "@/..."
    // — that's a tsconfig path alias (e.g. "@/lib"), NOT a scoped npm package
    // (a real one is "@scope/name" with a non-empty scope like "@prisma/client").
    const parts = spec.split("/");
    if (parts.length < 2 || parts[0] === "@" || !parts[0] || !parts[1]) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  const name = spec.split("/")[0];
  if (!name || NODE_BUILTINS.has(name)) return null;
  return name;
}

// Exported for N5 collaborator-context collection (which keeps the RELATIVE
// specifiers this module's specToPackage() discards). Returns EVERY module
// specifier (relative, external, builtin) in a JS/TS file; [] for other languages.
export async function specifiersFromFile(repoRoot: string, file: string): Promise<string[]> {
  const grammar = grammarForFile(file);
  if (!grammar || !JS_TS_LANGS.has(grammar.lang)) return []; // JS/TS only for M6
  const code = safeReadContained(repoRoot, file, IMPORTS_FILE_CAP);
  if (code === null) return [];
  try {
    const lang = await getLanguage(grammar.wasmFile);
    if (!lang) return regexSpecifiers(code); // grammar wasm unavailable → fallback
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(code);
    if (!tree) return regexSpecifiers(code);
    return treeSitterSpecifiers(tree.rootNode, lang);
  } catch {
    return regexSpecifiers(code); // labelled fallback on any parse error
  }
}

/** Local import binding → package name for one JS/TS file (default / `* as ns` / named incl.
 *  `as` alias). Relative/builtin sources skipped. Empty map for non-JS/TS or parse failure. */
export async function importBindings(repoRoot: string, file: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const g = grammarForFile(file);
  if (!g || !JS_TS_LANGS.has(g.lang)) return out;
  const lang = await getLanguage(g.wasmFile);
  if (!lang) return out;
  const code = safeReadContained(repoRoot, relative(repoRoot, file) || file, 2_000_000);
  if (code === null) return out;
  let parser: Parser | null = null;
  let q: Query | null = null;
  try {
    parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(code);
    if (!tree) return out;
    q = new Query(lang, "(import_statement) @imp");
    for (const m of q.matches(tree.rootNode)) {
      const node = m.captures[0]?.node;
      if (!node) continue;
      const source = node.childForFieldName("source");
      const spec = source ? stringNodeValue(source) : null;
      const pkg = spec ? specToPackage(spec) : null;
      if (!pkg) continue;
      for (const child of walkClause(node)) {
        if (child.type === "identifier" && child.parent?.type === "import_clause")
          out.set(child.text, pkg);
        else if (child.type === "namespace_import") {
          const id = child.namedChildren.find((c) => c.type === "identifier");
          if (id) out.set(id.text, pkg);
        } else if (child.type === "import_specifier") {
          const alias = child.childForFieldName("alias");
          const name = child.childForFieldName("name");
          const local = (alias ?? name)?.text;
          if (local) out.set(local, pkg);
        }
      }
    }
    tree.delete();
    return out;
  } catch {
    return out;
  } finally {
    q?.delete();
    parser?.delete();
  }
}

function walkClause(importNode: Node): Node[] {
  const acc: Node[] = [];
  const visit = (n: Node) => {
    if (n.type === "identifier" || n.type === "namespace_import" || n.type === "import_specifier")
      acc.push(n);
    for (const c of n.namedChildren) visit(c);
  };
  visit(importNode);
  return acc;
}

// --- version resolution ------------------------------------------------------

/** Normalise a package.json range spec to an exact version, or null if unsupported. */
function cleanDeclaredVersion(spec: string): string | null {
  const m = spec.trim().match(/^[\^~]?(\d+\.\d+\.\d+[\w.+-]*)$/);
  return m?.[1] ?? null;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function readPackageJson(repoRoot: string): PackageJson | null {
  const raw = safeReadContained(repoRoot, "package.json", IMPORTS_FILE_CAP);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

/** Parse bun.lock (JSONC — tolerant of trailing commas) → { name → exact version }. */
function readBunLockVersions(repoRoot: string): Record<string, string> {
  // bun.lock can be large; cap generously but bound it so the JSONC fallback scan
  // never runs over an unbounded (or symlinked-out-of-repo) file.
  const raw = safeReadContained(repoRoot, "bun.lock", 8 * 1024 * 1024);
  if (raw === null) return {};
  let parsed: { packages?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    // bun.lock is JSONC: strip trailing commas before `}`/`]`, then retry.
    try {
      parsed = JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"));
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.packages ?? {})) {
    // Only top-level (direct) entries: key === package name. value[0] = "name@version".
    if (key.includes("/") && !key.startsWith("@")) continue; // nested dep path
    const ident = Array.isArray(value) ? value[0] : undefined;
    if (typeof ident !== "string") continue;
    const at = ident.lastIndexOf("@");
    if (at <= 0) continue; // need a name before the @ (skip "@x" with no version)
    const name = ident.slice(0, at);
    const version = ident.slice(at + 1);
    if (name === key && /^\d/.test(version)) out[name] = version;
  }
  return out;
}

/**
 * Strip JSONC so tsconfig.json parses: removes // and block comments + trailing
 * commas. String-AWARE — a naive regex would eat `/*` that occurs inside path-glob
 * string values (e.g. "./src/*"), so we scan char-by-char and only strip comment
 * markers outside of string literals.
 */
function stripJsonc(raw: string): string {
  let out = "";
  let inStr = false;
  let quote = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += raw[i + 1] ?? "";
        i++;
      } else if (c === quote) {
        inStr = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i++; // skip the closing "/" (loop's i++ skips "*")
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1"); // trailing commas (values are simple)
}

/**
 * tsconfig `compilerOptions.paths` aliases (e.g. `@/`, `~/`, `#config`, and
 * mid-pattern wildcards) so they aren't mistaken for npm packages. Each key becomes
 * a matcher (TS allows ONE `*` wildcard anywhere → split into prefix+suffix at the
 * star; globless keys match exactly; the bare catch-all `*` is skipped, else it
 * would drop EVERY import). JSONC-tolerant; does NOT follow `extends` (root tsconfig
 * only — the common case; bare `@/` is still caught by specToPackage regardless).
 */
function readTsconfigAliasMatchers(repoRoot: string): ((spec: string) => boolean)[] {
  // The raw tsconfig text is fed to the synchronous, char-by-char stripJsonc scanner;
  // cap + symlink-contain it so that scan never runs over an unbounded/escaped file.
  const raw = safeReadContained(repoRoot, "tsconfig.json", IMPORTS_FILE_CAP);
  if (raw === null) return [];
  let parsed: { compilerOptions?: { paths?: Record<string, unknown> } };
  try {
    parsed = JSON.parse(stripJsonc(raw));
  } catch {
    return [];
  }
  const paths = parsed.compilerOptions?.paths;
  if (!paths || typeof paths !== "object") return [];
  const matchers: ((spec: string) => boolean)[] = [];
  for (const key of Object.keys(paths)) {
    if (!key) continue;
    const star = key.indexOf("*");
    if (star === -1) {
      matchers.push((s) => s === key); // exact alias, e.g. "#config"
      continue;
    }
    const prefix = key.slice(0, star); // "@/*"→"@/", "~/*"→"~/", "foo/*/bar"→"foo/"
    const suffix = key.slice(star + 1); // "foo/*/bar"→"/bar"; trailing-* → ""
    if (!prefix && !suffix) continue; // bare "*" catch-all → skip (matches everything)
    matchers.push(
      (s) =>
        s.length >= prefix.length + suffix.length && s.startsWith(prefix) && s.endsWith(suffix),
    );
  }
  return matchers;
}

export async function extractImportedLibs(
  repoRoot: string,
  changedFiles: string[],
): Promise<ImportedLib[]> {
  const aliasMatchers = readTsconfigAliasMatchers(repoRoot);
  const isAliased = (spec: string): boolean => aliasMatchers.some((m) => m(spec));
  // name → set of files that referenced it (insertion order preserved).
  const byName = new Map<string, Set<string>>();
  for (const file of changedFiles) {
    const specs = await specifiersFromFile(repoRoot, file);
    for (const spec of specs) {
      if (isAliased(spec)) continue; // tsconfig path alias → not an npm package
      const pkg = specToPackage(spec);
      if (!pkg) continue;
      const files = byName.get(pkg) ?? new Set<string>();
      files.add(file);
      byName.set(pkg, files);
    }
  }
  if (byName.size === 0) return [];

  const pkgJson = readPackageJson(repoRoot);
  const declared: Record<string, string> = {
    ...pkgJson?.dependencies,
    ...pkgJson?.devDependencies,
    ...pkgJson?.peerDependencies,
  };
  const locked = readBunLockVersions(repoRoot);

  const libs: ImportedLib[] = [];
  for (const [name, files] of byName) {
    const version = locked[name] ?? (declared[name] ? cleanDeclaredVersion(declared[name]) : null);
    libs.push({ name, version, fromFiles: [...files] });
  }
  return libs;
}
