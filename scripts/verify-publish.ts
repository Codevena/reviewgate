// scripts/verify-publish.ts
//
// Publish preflight: validate the generated npm-dist/ set before `npm publish`.
// Checks the launcher, the four platform packages (non-empty binary + all 4 grammars +
// shims + os/cpu), that all five versions match, and that the main package pins each
// platform package at an EXACT version, maps bin correctly, sets engines.node, and
// declares no runtime dependencies.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TARGETS, pkgName } from "./build-npm-packages.ts";

const GRAMMARS = [
  "web-tree-sitter.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-python.wasm",
];

export function verifyNpmDist(
  distRoot: string,
  opts: { minBinaryBytes?: number } = {},
): { ok: boolean; errors: string[] } {
  const minBinaryBytes = opts.minBinaryBytes ?? 1_000_000;
  const errors: string[] = [];
  const mainPkgPath = join(distRoot, "main", "package.json");
  if (!existsSync(mainPkgPath)) return { ok: false, errors: ["main/package.json missing — run `bun run build:npm`"] };

  const main = JSON.parse(readFileSync(mainPkgPath, "utf8")) as {
    version: string;
    bin?: Record<string, string>;
    engines?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const version = main.version;

  const launcher = join(distRoot, "main", "bin", "reviewgate.cjs");
  if (!existsSync(launcher)) errors.push("main launcher bin/reviewgate.cjs missing");
  else if (!readFileSync(launcher, "utf8").startsWith("#!")) errors.push("main launcher missing the node shebang");

  if (main.bin?.reviewgate !== "bin/reviewgate.cjs")
    errors.push(`main bin.reviewgate must be "bin/reviewgate.cjs" (got ${main.bin?.reviewgate ?? "nothing"})`);
  if (!main.engines?.node) errors.push("main package must set engines.node");
  if (main.dependencies && Object.keys(main.dependencies).length > 0)
    errors.push("main package must declare NO runtime dependencies");

  for (const t of TARGETS) {
    const name = pkgName(t);
    const dir = join(distRoot, name);
    const pj = join(dir, "package.json");
    if (!existsSync(pj)) {
      errors.push(`${name}: package.json missing`);
      continue;
    }
    const m = JSON.parse(readFileSync(pj, "utf8")) as { version: string; os?: string[]; cpu?: string[] };
    if (m.version !== version) errors.push(`${name}: version ${m.version} != main ${version}`);
    if (JSON.stringify(m.os) !== JSON.stringify([t.os])) errors.push(`${name}: os must be ["${t.os}"]`);
    if (JSON.stringify(m.cpu) !== JSON.stringify([t.cpu])) errors.push(`${name}: cpu must be ["${t.cpu}"]`);
    const bin = join(dir, "reviewgate");
    if (!existsSync(bin)) errors.push(`${name}: binary 'reviewgate' missing`);
    else if (statSync(bin).size < minBinaryBytes)
      errors.push(`${name}: binary is too small (${statSync(bin).size} < ${minBinaryBytes}) — empty/failed compile?`);
    for (const g of GRAMMARS)
      if (!existsSync(join(dir, "grammars", g))) errors.push(`${name}: grammars/${g} missing`);
    for (const sh of ["gate.sh", "trigger.sh", "reset.sh", "pre-push.sh"])
      if (!existsSync(join(dir, "bin-templates", sh))) errors.push(`${name}: bin-templates/${sh} missing`);
    const pin = main.optionalDependencies?.[name];
    if (pin !== version) errors.push(`${name}: main must pin it EXACTLY at ${version} (got ${pin ?? "nothing"})`);
  }

  return { ok: errors.length === 0, errors };
}

if (import.meta.main) {
  const distRoot = join(process.cwd(), "npm-dist");
  const { ok, errors } = verifyNpmDist(distRoot);
  if (!ok) {
    console.error(`verify:npm — npm-dist is not publishable:\n  ${errors.join("\n  ")}`);
    process.exit(1);
  }
  console.error("verify:npm — npm-dist verified (launcher + 4 platform packages, versions pinned).");
}
