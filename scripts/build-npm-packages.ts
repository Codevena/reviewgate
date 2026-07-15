// scripts/build-npm-packages.ts
// Builds the five publishable npm packages into npm-dist/: a main `reviewgate`
// launcher package + four `@codevena/reviewgate-<os>-<arch>` prebuilt-binary packages.
// Pure helpers (TARGETS / pkgName / platformManifest / mainManifest) are unit-tested;
// the build orchestration (cross-compile + assemble) runs under `import.meta.main`.

export interface Target {
  bunTarget: string;
  os: "darwin" | "linux";
  cpu: "arm64" | "x64";
}

export const TARGETS: Target[] = [
  { bunTarget: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
  { bunTarget: "bun-darwin-x64", os: "darwin", cpu: "x64" },
  { bunTarget: "bun-linux-x64", os: "linux", cpu: "x64" },
  { bunTarget: "bun-linux-arm64", os: "linux", cpu: "arm64" },
];

export function pkgName(t: Target): string {
  return `@codevena/reviewgate-${t.os}-${t.cpu}`;
}

const REPO = "git+https://github.com/Codevena/reviewgate.git";

export function platformManifest(t: Target, version: string): Record<string, unknown> {
  return {
    name: pkgName(t),
    version,
    description: `Reviewgate prebuilt binary for ${t.os}-${t.cpu}.`,
    license: "MIT",
    author: "Markus Wiesecke (https://github.com/Codevena)",
    homepage: "https://reviewgate.codevena.dev/",
    repository: { type: "git", url: REPO },
    os: [t.os],
    cpu: [t.cpu],
    ...(t.os === "linux" ? { libc: ["glibc"] } : {}),
    // No "personas": it is .gitkeep-only and resolved at runtime from .reviewgate/personas/,
    // never relative to the binary — shipping it is dead weight (plan-gate finding).
    files: ["reviewgate", "grammars", "bin-templates"],
  };
}

export function mainManifest(version: string): Record<string, unknown> {
  return {
    name: "reviewgate",
    version,
    description:
      "Independent code-review control loop for Claude Code and Codex — verifies diffs, requires explicit finding outcomes, and records honest defer/escalation states.",
    license: "MIT",
    author: "Markus Wiesecke (https://github.com/Codevena)",
    homepage: "https://reviewgate.codevena.dev/",
    repository: { type: "git", url: REPO },
    bugs: { url: "https://github.com/Codevena/reviewgate/issues" },
    keywords: [
      "claude-code",
      "code-review",
      "ai-agent",
      "llm",
      "codex",
      "gemini",
      "openrouter",
      "developer-tools",
      "cli",
    ],
    bin: { reviewgate: "bin/reviewgate.cjs" },
    // EXACT version pins — the consumer must get the matching platform build.
    optionalDependencies: Object.fromEntries(TARGETS.map((t) => [pkgName(t), version])),
    engines: { node: ">=20" },
    files: ["bin"],
  };
}

// ---- build orchestration (run: bun run scripts/build-npm-packages.ts) ----
if (import.meta.main) {
  const { $ } = await import("bun");
  const { rmSync, mkdirSync, copyFileSync, writeFileSync, readdirSync } = await import("node:fs");
  const { basename, join } = await import("node:path");

  const root = process.cwd();
  const rootPkg = JSON.parse(await Bun.file(join(root, "package.json")).text()) as {
    version: string;
  };
  const version = process.env.REVIEWGATE_VERSION ?? rootPkg.version;
  const onlyCurrent = process.env.REVIEWGATE_BUILD_ONLY_CURRENT === "1";
  const targets = onlyCurrent
    ? TARGETS.filter((t) => t.os === process.platform && t.cpu === process.arch)
    : TARGETS;
  if (onlyCurrent && targets.length === 0) {
    throw new Error(`no Reviewgate target matches host ${process.platform}-${process.arch}`);
  }

  const distRoot = join(root, "npm-dist");
  rmSync(distRoot, { recursive: true, force: true });

  // grammar + asset sources (same set as `bun run build`)
  // Bun installs packages as symlinks (pnpm-style node_modules); Bun.Glob.scan does NOT
  // traverse symlinked dirs, so it misses the tree-sitter grammars. readdirSync follows
  // the symlink and lists the real entries.
  const wasmIn = (rel: string) =>
    readdirSync(join(root, rel))
      .filter((f) => f.endsWith(".wasm"))
      .map((f) => join(root, rel, f));
  const grammars = [
    ...wasmIn("node_modules/web-tree-sitter"),
    ...wasmIn("node_modules/tree-sitter-typescript"),
    ...wasmIn("node_modules/tree-sitter-python"),
  ];

  for (const t of targets) {
    const dir = join(distRoot, pkgName(t)); // join handles the @scope/name split
    mkdirSync(join(dir, "grammars"), { recursive: true });
    mkdirSync(join(dir, "bin-templates"), { recursive: true });
    console.error(`building ${pkgName(t)} (${t.bunTarget}) …`);
    // NOTE: outfile is under npm-dist/ ONLY — never dist/ (the live symlinked gate binary).
    // Force NODE_ENV=production so bun's DCE keeps the --version handler even when the
    // caller (e.g. bun test / some CI environments) sets NODE_ENV=test.
    await $`bun build src/cli/index.ts --compile --target=${t.bunTarget} --outfile ${join(dir, "reviewgate")}`
      .cwd(root)
      .env({ ...process.env, NODE_ENV: "production" });
    for (const g of grammars) copyFileSync(g, join(dir, "grammars", basename(g)));
    for (const sh of ["gate.sh", "trigger.sh", "reset.sh", "pre-push.sh"]) {
      copyFileSync(join(root, "bin-templates", sh), join(dir, "bin-templates", sh));
    }
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify(platformManifest(t, version), null, 2)}\n`,
    );
  }

  // main package
  const mainDir = join(distRoot, "main");
  mkdirSync(join(mainDir, "bin"), { recursive: true });
  copyFileSync(join(root, "bin", "reviewgate.cjs"), join(mainDir, "bin", "reviewgate.cjs"));
  writeFileSync(
    join(mainDir, "package.json"),
    `${JSON.stringify(mainManifest(version), null, 2)}\n`,
  );

  console.error(`npm-dist/ built @ ${version} (${targets.length} platform package(s) + main).`);
}
