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

const SECRETS_DENY = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  ".env",
  ".env.local",
  ".env.production",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "~/.netrc",
  "~/.git-credentials",
  "~/.npmrc",
  "~/.pypirc",
  "~/.config/gh",
  "~/.bash_history",
  "~/.zsh_history",
];

const BROAD_DENY = ["/Users", "/home", "/Volumes", "/tmp"];

export interface SandboxProfile {
  sandboxRequested: boolean;
  fs: {
    readAllow: string[];
    readDeny: string[];
    writeAllow: string[];
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
      fs: { readAllow: [], readDeny: [], writeAllow: [] },
      net: { allow: [] },
      budget: { walltimeMs: input.walltimeMs ?? 300_000 },
    };
  }

  const own = CREDENTIAL_PATHS[input.providerId];
  const others = (Object.keys(CREDENTIAL_PATHS) as ProviderId[])
    .filter((p) => p !== input.providerId)
    .flatMap((p) => CREDENTIAL_PATHS[p]);

  const readDeny = [...BROAD_DENY, ...SECRETS_DENY, ...others, ...(input.deniedReads ?? [])];
  const readAllow = [input.workingDir, input.tmpDir, ...own];
  const writeAllow = [input.findingsPath, input.tmpDir, ...own, ...(input.writablePaths ?? [])];

  return {
    sandboxRequested: true,
    fs: { readAllow, readDeny, writeAllow },
    net: { allow: NETWORK_ALLOW[input.providerId] },
    budget: { walltimeMs: input.walltimeMs ?? 300_000 },
  };
}
