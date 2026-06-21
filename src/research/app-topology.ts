// src/research/app-topology.ts
import { dirname } from "node:path";
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

// Mirror the symbol-graph walk exclusions, plus common build dirs. Applied to the relative
// glob path so we never read a vendored/built package.json as a repo "app".
const EXCLUDE =
  /(?:^|\/)(?:node_modules|\.git|\.reviewgate|\.antigravitycli|dist|build|out|\.next|\.nuxt|\.svelte-kit|coverage)\//;

// Bound the FS walk: Bun.Glob cannot prune node_modules from the walk itself, so cap the
// number of package.json paths we consider (this runs on the gate's timed research path).
const SCAN_CAP = 5000;

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
  let matches: string[];
  try {
    matches = [...new Bun.Glob("**/package.json").scanSync({ cwd: repoRoot })];
  } catch {
    return [];
  }
  const entries: AppTopologyEntry[] = [];
  let scanned = 0;
  for (const rel of matches) {
    if (++scanned > SCAN_CAP) break;
    if (EXCLUDE.test(rel)) continue;
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
    const framework = detectFramework([...depObj(pkg.dependencies), ...depObj(pkg.devDependencies)]);
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
