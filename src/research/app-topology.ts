// src/research/app-topology.ts
import { type Dirent, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { safeReadContained } from "../utils/safe-read.ts";

export interface AppTopologyEntry {
  /** Repo-relative directory of the package ("" = repo root). */
  dir: string;
  /** package.json "name" (attacker-controllable — neutralize before rendering). */
  name: string;
  /** Detected framework label (from the fixed allowlist below — inert/code-side). */
  framework: string;
}

// package.json is read as trusted reviewer context — use the symlink-safe, realpath-
// contained, size-capped read (a package.json could be a symlink pointing outside the repo).
const PKG_CAP = 64 * 1024;

// Directory names we never descend into. Bun.Glob's `**/package.json` cannot PRUNE the walk,
// so it would synchronously traverse a huge node_modules/vendor tree on the Stop-hook hot path
// (codex DoD) — instead we hand-walk and skip these (+ all dot-dirs) so node_modules is never
// entered at all.
const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".reviewgate",
  ".antigravitycli",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  "vendor",
]);
// Hot-path bounds: the gate's research phase runs under the self-deadline, so the pruned walk
// is hard-capped on depth, directories visited, and package.json candidates collected.
const MAX_DEPTH = 6;
const MAX_DIRS_WALKED = 2000;
const MAX_PKG_CANDIDATES = 400;

// Pruned, bounded, depth-limited package.json walk. NEVER descends into node_modules/build/
// dot-dirs (so it can't block on a giant vendor tree) and does NOT follow symlinked dirs
// (isDirectory() is false for a symlink — avoids loops + repo escape). Returns repo-relative
// paths. Iterative (explicit stack) so a deep tree can't blow the call stack.
function findPackageJsons(repoRoot: string): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: repoRoot, depth: 0 }];
  let walked = 0;
  while (stack.length > 0 && out.length < MAX_PKG_CANDIDATES && walked < MAX_DIRS_WALKED) {
    const top = stack.pop();
    if (!top) break;
    walked++;
    let entries: Dirent[];
    try {
      entries = readdirSync(top.dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir (permissions / race) — skip, best-effort
    }
    for (const e of entries) {
      if (e.isFile()) {
        if (e.name === "package.json") out.push(relative(repoRoot, join(top.dir, "package.json")));
      } else if (
        e.isDirectory() &&
        top.depth < MAX_DEPTH &&
        !e.name.startsWith(".") &&
        !EXCLUDE_DIRS.has(e.name)
      ) {
        stack.push({ dir: join(top.dir, e.name), depth: top.depth + 1 });
      }
    }
  }
  return out;
}

// Ordered framework detection: META-frameworks first (so Next wins over its bundled React,
// SvelteKit over Svelte), then bundlers, then server frameworks, then bare libraries. First
// match wins. Labels are a FIXED code-side allowlist → inert in the trusted prompt section.
const FRAMEWORKS: ReadonlyArray<{ label: string; match: (dep: string) => boolean }> = [
  { label: "Next.js", match: (d) => d === "next" },
  { label: "Remix", match: (d) => d.startsWith("@remix-run/") },
  { label: "Astro", match: (d) => d === "astro" },
  { label: "Nuxt", match: (d) => d === "nuxt" || d === "nuxt3" },
  { label: "SvelteKit", match: (d) => d === "@sveltejs/kit" },
  { label: "Angular", match: (d) => d === "@angular/core" },
  { label: "Vite", match: (d) => d === "vite" },
  { label: "NestJS", match: (d) => d === "@nestjs/core" },
  { label: "Express", match: (d) => d === "express" },
  { label: "Fastify", match: (d) => d === "fastify" },
  { label: "React", match: (d) => d === "react" },
  { label: "Vue", match: (d) => d === "vue" },
  { label: "Svelte", match: (d) => d === "svelte" },
];

function detectFramework(deps: string[]): string | null {
  for (const f of FRAMEWORKS) {
    if (deps.some((d) => f.match(d))) return f.label;
  }
  return null;
}

// Enumerate the repo's apps/packages and map each path-prefix to its framework, so a reviewer
// can attribute a file/route to the right app in a monorepo (the P10 fix for the field-report
// FP where a reviewer conflated a Vite SPA with a Next.js app). ADVISORY only — purely
// informational trusted context; it never touches the verdict/suppression path.
export function loadAppTopology(repoRoot: string, maxApps = 12): AppTopologyEntry[] {
  const entries: AppTopologyEntry[] = [];
  for (const rel of findPackageJsons(repoRoot)) {
    const raw = safeReadContained(repoRoot, rel, PKG_CAP);
    if (raw === null) continue;
    let pkg: { name?: unknown; dependencies?: unknown; devDependencies?: unknown };
    try {
      pkg = JSON.parse(raw);
    } catch {
      continue;
    }
    const depObj = (o: unknown): string[] =>
      o && typeof o === "object" ? Object.keys(o as Record<string, unknown>) : [];
    const framework = detectFramework([
      ...depObj(pkg.dependencies),
      ...depObj(pkg.devDependencies),
    ]);
    if (!framework) continue; // a package with no recognizable framework adds no signal
    const dir = rel === "package.json" ? "" : dirname(rel);
    const name = typeof pkg.name === "string" && pkg.name.trim() ? pkg.name : dir || "(root)";
    entries.push({ dir, name, framework });
  }
  // Deterministic order (no Date/random): shallowest path first, then alphabetical, so the
  // root + top-level apps win the maxApps cap predictably.
  entries.sort((a, b) => {
    const depth = (d: string) => (d ? d.split("/").length : 0);
    return depth(a.dir) - depth(b.dir) || a.dir.localeCompare(b.dir);
  });
  return entries.slice(0, maxApps);
}
