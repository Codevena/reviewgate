export type ProviderId = "codex" | "claude-code" | "gemini" | "opencode";

const CREDENTIAL_PATHS: Record<ProviderId, string[]> = {
  codex: ["~/.codex", "~/.config/codex", "~/.openai"],
  "claude-code": ["~/.claude", "~/.config/claude"],
  gemini: ["~/.config/gemini", "~/.gemini"],
  opencode: ["~/.config/opencode"],
};

const NETWORK_ALLOW: Record<ProviderId, string[]> = {
  codex: ["api.openai.com", "chatgpt.com"],
  "claude-code": ["api.anthropic.com", "claude.ai"],
  gemini: ["generativelanguage.googleapis.com", "aiplatform.googleapis.com"],
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

  const readDeny = [...BROAD_DENY, ...SECRETS_DENY, ...others];
  const readAllow = [input.workingDir, input.tmpDir, ...own];
  const writeAllow = [input.findingsPath, input.tmpDir];

  return {
    sandboxRequested: true,
    fs: { readAllow, readDeny, writeAllow },
    net: { allow: NETWORK_ALLOW[input.providerId] },
    budget: { walltimeMs: input.walltimeMs ?? 300_000 },
  };
}
