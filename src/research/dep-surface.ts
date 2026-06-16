// src/research/dep-surface.ts
import { join } from "node:path";
import { neutralizeFences, neutralizeInjectionMarkers } from "../diff/sanitizer.ts";
import { safeReadContained } from "../utils/safe-read.ts";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REEXPORT_FILES = 30;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const VERSION_OK = /^[\w.\-+]+$/;

export interface DepSurfaceLib {
  name: string;
  version: string | null;
  bindings: string[];
}
export interface DepSurfaceOpts {
  repoRoot: string;
  libs: DepSurfaceLib[];
  budgetBytes: number;
  signal?: AbortSignal;
}

// JSON.parse a package.json read via safeReadContained; null on any failure.
function readJson(repoRoot: string, rel: string): Record<string, unknown> | null {
  const raw = safeReadContained(repoRoot, rel, 1_000_000);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Pick the types entry (relative path under the package) from package.json.
function typesEntry(pkgJson: Record<string, unknown>): string | null {
  const exp = pkgJson.exports as Record<string, unknown> | undefined;
  const dot = exp?.["."] as unknown;
  const fromCond = (c: unknown): string | null => {
    if (typeof c === "string") return null; // a string export is JS, not types
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      if (typeof o.types === "string") return o.types;
      for (const k of ["import", "require", "default"]) {
        const sub = o[k];
        if (
          sub &&
          typeof sub === "object" &&
          typeof (sub as Record<string, unknown>).types === "string"
        )
          return (sub as Record<string, unknown>).types as string;
      }
    }
    return null;
  };
  return (
    fromCond(dot) ??
    (typeof pkgJson.types === "string" ? pkgJson.types : null) ??
    (typeof pkgJson.typings === "string" ? pkgJson.typings : null)
  );
}

// Resolve a "./x"-style relative type ref under the package to an existing .d.ts rel-path.
function resolveDts(repoRoot: string, baseRel: string, ref: string): string | null {
  const dir = join(baseRel, "..");
  const norm = join(dir, ref);
  const candidates = [
    norm,
    `${norm}.d.ts`,
    `${norm}.d.cts`,
    `${norm}.d.mts`,
    join(norm, "index.d.ts"),
  ];
  for (const c of candidates) {
    if (safeReadContained(repoRoot, c, MAX_FILE_BYTES) !== null) {
      return c;
    }
  }
  return null;
}

// Collect identifier-whitelisted export names + followed re-export files from a .d.ts.
function extractNames(text: string): { names: Set<string>; reexports: string[] } {
  const names = new Set<string>();
  const reexports: string[] = [];
  const add = (n: string) => {
    if (IDENT.test(n)) names.add(n);
  };
  const declRe =
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of text.matchAll(declRe)) add(m[1] as string);
  // export { a, b as c }  (with or without `from "./x"`)
  const braceRe = /export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/g;
  for (const m of text.matchAll(braceRe)) {
    for (const part of (m[1] as string).split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      const asMatch = seg.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      add(asMatch ? (asMatch[1] as string) : (seg.split(/\s+/)[0] as string));
    }
    if (m[2]) reexports.push(m[2] as string);
  }
  // export * from "./x"  and  export * as ns from "./x" (the `ns` binding is itself an export)
  for (const m of text.matchAll(
    /export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*['"]([^'"]+)['"]/g,
  )) {
    if (m[1]) add(m[1] as string);
    reexports.push(m[2] as string);
  }
  return { names, reexports };
}

// Best-effort: members of `export const <binding>: { m1; m2 }` or `namespace <binding> { ... }`.
function extractBindingMembers(text: string, binding: string): string[] {
  if (!IDENT.test(binding)) return [];
  const out = new Set<string>();
  // Brace-match the `{ ... }` body starting at `openIndex` (the offset of the `{`),
  // returning the inner slice (capped so a pathological file can't run away).
  const matchBody = (openIndex: number): string => {
    let depth = 0;
    let i = openIndex;
    for (; i < text.length && i < openIndex + 50_000; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    return text.slice(openIndex + 1, i);
  };
  // const binding: { ... } — capture the inline object body (single level).
  const constRe = new RegExp(
    `(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+${binding}\\s*:\\s*\\{`,
  );
  const cm = constRe.exec(text);
  if (cm) {
    const body = matchBody(cm.index + cm[0].length - 1); // -1 lands on the `{`
    for (const m of body.matchAll(/(?:^|[;{,\n])\s*([A-Za-z_$][\w$]*)\s*[?(:<]/g))
      out.add(m[1] as string);
  }
  // namespace binding { export ... } — scan ONLY the namespace body (brace-matched),
  // not the whole file, so unrelated top-level declarations aren't mis-attributed.
  const nsRe = new RegExp(`namespace\\s+${binding}\\s*\\{`);
  const nm = nsRe.exec(text);
  if (nm) {
    const body = matchBody(nm.index + nm[0].length - 1); // -1 lands on the `{`
    for (const m of body.matchAll(/(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g))
      out.add(m[1] as string);
  }
  return [...out].filter((n) => IDENT.test(n));
}

export async function collectDepSurface(opts: DepSurfaceOpts): Promise<string> {
  const { repoRoot, libs, budgetBytes, signal } = opts;
  const blocks: string[] = [];
  let used = 0;
  for (const lib of [...libs].sort((a, b) => a.name.localeCompare(b.name))) {
    signal?.throwIfAborted();
    if (used >= budgetBytes) break;
    const pkgDir = lib.name.startsWith("@")
      ? join("node_modules", ...lib.name.split("/"))
      : join("node_modules", lib.name);
    const pj = readJson(repoRoot, join(pkgDir, "package.json"));
    if (!pj) continue;
    let entry = typesEntry(pj) ?? "index.d.ts";
    entry = entry.replace(/^\.\//, "");
    let entryRel = join(pkgDir, entry);
    if (safeReadContained(repoRoot, entryRel, MAX_FILE_BYTES) === null) {
      const alt = ["index.d.ts", "index.d.cts", "index.d.mts"]
        .map((x) => join(pkgDir, x))
        .find((c) => safeReadContained(repoRoot, c, MAX_FILE_BYTES) !== null);
      if (!alt) continue;
      entryRel = alt;
    }
    // BFS the re-export graph (depth 2, ≤30 files), collecting names.
    const names = new Set<string>();
    const seen = new Set<string>();
    let frontier: { rel: string; depth: number }[] = [{ rel: entryRel, depth: 0 }];
    const entryText = safeReadContained(repoRoot, entryRel, MAX_FILE_BYTES) ?? "";
    while (frontier.length && seen.size < MAX_REEXPORT_FILES) {
      const next: { rel: string; depth: number }[] = [];
      for (const { rel, depth } of frontier) {
        if (seen.has(rel) || seen.size >= MAX_REEXPORT_FILES) continue;
        seen.add(rel);
        const text =
          rel === entryRel ? entryText : (safeReadContained(repoRoot, rel, MAX_FILE_BYTES) ?? "");
        const { names: ns, reexports } = extractNames(text);
        for (const n of ns) names.add(n);
        if (depth < 2)
          for (const ref of reexports) {
            const r = resolveDts(repoRoot, rel, ref);
            if (r && !seen.has(r)) next.push({ rel: r, depth: depth + 1 });
          }
      }
      frontier = next;
    }
    // Best-effort members of used object bindings (from the entry text only).
    const memberLines: string[] = [];
    for (const b of lib.bindings) {
      const ms = extractBindingMembers(entryText, b);
      if (ms.length) memberLines.push(`${b}: { ${[...new Set(ms)].sort().join(", ")} }`);
    }
    const version = lib.version && VERSION_OK.test(lib.version) ? lib.version : null;
    const header = `### ${specSafe(lib.name)}${version ? `@${version}` : ""}`;
    const exportLine = `exports: ${[...names].sort().join(", ")}`;
    const raw = [header, exportLine, ...memberLines].join("\n");
    // Defense-in-depth (the identifier-whitelist above is the primary guarantee — every name
    // matches IDENT, so it has no CR/LF/space/marker; the only newlines are the structural
    // ones we joined, kept for readability).
    const clean = neutralizeFences(neutralizeInjectionMarkers(raw));
    if (used + clean.length + 1 > budgetBytes) {
      blocks.push(`${clean.slice(0, Math.max(0, budgetBytes - used))}\n…`);
      break;
    }
    blocks.push(clean);
    used += clean.length + 1;
  }
  return blocks.join("\n\n");
}

// Package name is already constrained by specToPackage, but keep the header injection-proof.
function specSafe(name: string): string {
  return /^@?[\w.\-/]+$/.test(name) ? name : "dependency";
}
