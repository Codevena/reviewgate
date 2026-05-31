export type ProviderId = "codex" | "claude-code" | "gemini" | "opencode";

const CREDENTIAL_PATHS: Record<ProviderId, string[]> = {
  codex: ["~/.codex", "~/.config/codex", "~/.openai"],
  "claude-code": ["~/.claude", "~/.config/claude"],
  gemini: ["~/.antigravity", "~/.gemini/antigravity-cli", "~/.config/gemini", "~/.gemini"],
  opencode: ["~/.config/opencode"],
};

const NETWORK_ALLOW: Record<ProviderId, string[]> = {
  codex: ["api.openai.com", "chatgpt.com"],
  "claude-code": ["api.anthropic.com", "claude.ai"],
  gemini: [
    "oauth2.googleapis.com",
    "accounts.google.com",
    "cloudcode-pa.googleapis.com",
    "www.googleapis.com",
    "generativelanguage.googleapis.com",
  ],
  opencode: ["openrouter.ai"],
};

// Secret DIRECTORIES / fixed paths — denied via an SBPL (subpath …) rule after
// realpath canonicalization. (Absolute or ~-prefixed.)
const SECRET_DIRS = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.netrc",
  "~/.git-credentials",
  "~/.npmrc",
  "~/.pypirc",
  "~/.config/gh",
  "~/.bash_history",
  "~/.zsh_history",
];

// Secret basename / extension GLOBS — denied via an SBPL (regex …) rule. NOT
// realpath'd (a glob has no single location). `(subpath "*.pem")` matches a file
// literally named "*.pem", not real .pem files — so these MUST take the regex path
// (emitting them as subpath was a real read-secret bypass; DoD-caught).
const SECRET_GLOBS = [".env", ".env.local", ".env.production", "*.pem", "*.key", "*.p12", "*.pfx"];

// NOTE: there is deliberately NO broad "/Users","/tmp" read-deny. The macOS SBPL
// model is (allow default) + deny-specific-secrets; a broad deny would block the
// repo + the reviewer's own working/tmp dirs AND conflict with writeAllow (which is
// necessarily under /private/tmp + the home dir), making the sandbox throw before
// spawning. Reads are open by default; only specific secrets are denied.

// A config deniedReads entry is a GLOB if it has no path separator (a bare
// basename like ".env") or contains a wildcard; otherwise it's a path/dir.
function isGlobPattern(s: string): boolean {
  return s.includes("*") || !s.includes("/");
}

export interface WriteTarget {
  path: string;
  kind: "file" | "dir";
  // Create the path with `kind` if missing when the sandbox is built. false = bind
  // only if it already exists (own-cred dirs: a missing one has no token to refresh
  // — don't fabricate an empty cred dir under the read-only home).
  createIfMissing: boolean;
}

export interface SandboxProfile {
  sandboxRequested: boolean;
  fs: {
    readAllow: string[];
    readDeny: string[]; // absolute/dir paths → SBPL (subpath …)
    readDenyGlobs: string[]; // basename/extension globs → SBPL (regex …); NOT realpath'd
    writeAllow: string[];
    // Classified companion to writeAllow — consumed by the Linux bwrap spawn path
    // to pre-create bind-mount targets with the correct kind before bwrap launches.
    writeTargets?: WriteTarget[];
  };
  net: { allow: string[] };
  budget: { walltimeMs: number };
}

export interface BuildInput {
  providerId: ProviderId;
  mode: "strict" | "permissive" | "off";
  workingDir: string;
  findingsPath: string;
  tmpDir: string;
  walltimeMs?: number;
  // From reviewgate.config.ts sandbox.{writablePaths,deniedReads}: additive to the
  // hard-coded write-allow / read-deny lists so a user can grant a needed write or
  // protect an extra path. Without this wiring those config keys are dead (F-058).
  writablePaths?: string[];
  deniedReads?: string[];
}

export function buildSandboxProfile(input: BuildInput): SandboxProfile {
  if (input.mode === "off") {
    return {
      sandboxRequested: false,
      fs: { readAllow: [], readDeny: [], readDenyGlobs: [], writeAllow: [], writeTargets: [] },
      net: { allow: [] },
      budget: { walltimeMs: input.walltimeMs ?? 300_000 },
    };
  }

  const own = CREDENTIAL_PATHS[input.providerId];
  const others = (Object.keys(CREDENTIAL_PATHS) as ProviderId[])
    .filter((p) => p !== input.providerId)
    .flatMap((p) => CREDENTIAL_PATHS[p]);

  // Split the user's deniedReads into dir/path denies (subpath) vs glob denies (regex).
  const cfgDenies = input.deniedReads ?? [];
  const cfgGlobs = cfgDenies.filter(isGlobPattern);
  const cfgPaths = cfgDenies.filter((d) => !isGlobPattern(d));

  // readDeny = specific secret DIRS + OTHER providers' cred dirs + user path denies.
  // NO broad roots (would block the repo/workdir). readDenyGlobs = basename/ext globs.
  const readDeny = [...SECRET_DIRS, ...others, ...cfgPaths];
  const readDenyGlobs = [...SECRET_GLOBS, ...cfgGlobs];
  const readAllow = [input.workingDir, input.tmpDir, ...own];
  const writeAllow = [input.findingsPath, input.tmpDir, ...own, ...(input.writablePaths ?? [])];
  const writeTargets: WriteTarget[] = [
    { path: input.findingsPath, kind: "file", createIfMissing: true },
    { path: input.tmpDir, kind: "dir", createIfMissing: true },
    ...own.map((p) => ({ path: p, kind: "dir" as const, createIfMissing: false })),
    ...(input.writablePaths ?? []).map((p) => ({
      path: p,
      kind: "dir" as const,
      createIfMissing: true,
    })),
  ];

  return {
    sandboxRequested: true,
    fs: { readAllow, readDeny, readDenyGlobs, writeAllow, writeTargets },
    net: { allow: NETWORK_ALLOW[input.providerId] },
    budget: { walltimeMs: input.walltimeMs ?? 300_000 },
  };
}
