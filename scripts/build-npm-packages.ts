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
    homepage: "https://github.com/Codevena/reviewgate#readme",
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
      "Multi-agent code review gate for Claude Code's agent loop — blocks the agent from ending its turn until an independent LLM reviewer panel signs off.",
    license: "MIT",
    author: "Markus Wiesecke (https://github.com/Codevena)",
    homepage: "https://github.com/Codevena/reviewgate#readme",
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
