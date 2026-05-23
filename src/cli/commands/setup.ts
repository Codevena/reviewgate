import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { defaultConfig } from "../../config/defaults.ts";
import {
  type DeepPartial,
  type ReviewgateConfig,
  defineConfig,
} from "../../config/define-config.ts";
import { diffFromDefaults } from "../../config/diff-defaults.ts";
import { resolveGlobalConfigPath } from "../../config/global.ts";
import { serializeConfig } from "../../config/serialize.ts";
import { isProviderAvailable } from "../../providers/availability.ts";
import type { ProviderId } from "../../providers/registry.ts";
import { type CustomAnswers, buildCustomConfig, buildQuickPreset } from "../setup/build-config.ts";
import { probeModel } from "../setup/probe.ts";
import { runDoctor } from "./doctor.ts";

export function setupTip(isTty: boolean): string | null {
  return isTty
    ? "Tip: run `reviewgate setup` to configure reviewers, brain & critic interactively."
    : null;
}

export interface FinalizeInput {
  partial: DeepPartial<ReviewgateConfig>;
  targetPath: string;
  print: boolean;
}
export interface FinalizeResult {
  text: string;
  wrotePath: string | null;
}

// Validate (defineConfig) -> minimal diff -> serialize -> (print | backup+write).
// Throws on validation failure BEFORE any write (never leaves a broken file).
export function finalizeSetup(input: FinalizeInput): FinalizeResult {
  const validated = defineConfig(input.partial as Parameters<typeof defineConfig>[0]);
  const minimal = diffFromDefaults(validated);
  const text = serializeConfig(minimal as Record<string, unknown>);
  if (input.print) return { text, wrotePath: null };
  if (existsSync(input.targetPath)) {
    copyFileSync(input.targetPath, `${input.targetPath}.bak`);
  } else {
    mkdirSync(dirname(input.targetPath), { recursive: true });
  }
  writeFileSync(input.targetPath, text);
  return { text, wrotePath: input.targetPath };
}

export interface SetupInput {
  repoRoot: string;
  global?: boolean;
  print?: boolean;
  env?: Record<string, string | undefined>;
  home?: string;
}

const PERSONAS = ["security", "architecture", "adversarial"] as const;
const REVIEWER_PROVIDERS: ProviderId[] = [
  "codex",
  "gemini",
  "claude-code",
  "openrouter",
  "opencode",
];
const MODEL_DEFAULT: Record<ProviderId, string> = {
  codex: defaultConfig.providers.codex.model,
  gemini: defaultConfig.providers.gemini.model,
  "claude-code": defaultConfig.providers["claude-code"].model,
  openrouter: defaultConfig.providers.openrouter.model,
  opencode: defaultConfig.providers.opencode.model,
};

function authFor(p: ProviderId): "oauth" | "openrouter" {
  return p === "openrouter" ? "openrouter" : "oauth";
}

function cancelOut(): number {
  cancel("setup cancelled, no changes written");
  return 1;
}

export async function runSetup(input: SetupInput): Promise<number> {
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const home = input.home ?? homedir();
  const orKey = Boolean(env.OPENROUTER_API_KEY);
  intro("reviewgate setup");

  // 1. Target
  const globalPath = resolveGlobalConfigPath(env, home);
  let targetPath = join(input.repoRoot, "reviewgate.config.ts");
  if (input.global) {
    if (!globalPath) {
      cancel("no resolvable global config dir — set XDG_CONFIG_HOME or HOME");
      return 1;
    }
    targetPath = globalPath;
  } else {
    const target = await select({
      message: "Where should this config be saved?",
      options: [
        { value: "project", label: `This project (${targetPath})` },
        ...(globalPath ? [{ value: "global", label: `My global default (${globalPath})` }] : []),
      ],
    });
    if (isCancel(target)) return cancelOut();
    if (target === "global" && globalPath) targetPath = globalPath;
  }

  // 2. Mode
  const mode = await select({
    message: "Setup mode",
    options: [
      { value: "quick", label: "Quick (recommended preset)" },
      { value: "custom", label: "Custom (configure everything)" },
    ],
  });
  if (isCancel(mode)) return cancelOut();

  let partial: DeepPartial<ReviewgateConfig>;
  if (mode === "quick") {
    if (!orKey) {
      note("brain needs OPENROUTER_API_KEY — leaving it off (set the key and re-run setup).");
    }
    partial = buildQuickPreset({ openrouterKeyPresent: orKey });
  } else {
    const custom = await runCustom(env, orKey);
    if (!custom) return cancelOut();
    partial = custom;
  }

  // 3. Finalize
  const result = finalizeSetup({ partial, targetPath, print: Boolean(input.print) });
  if (input.print) {
    process.stdout.write(`${result.text}\n`);
    outro("(--print) nothing written");
    return 0;
  }

  // 4. Doctor — let it print its own lines directly; then summarize.
  note(`wrote ${result.wrotePath}`);
  const code = await runDoctor({ repoRoot: input.repoRoot });
  outro(
    code === 0
      ? "setup complete — doctor: all green"
      : code === 1
        ? "setup complete — doctor reported warnings (see above)"
        : "setup complete — doctor reported failures (see above)",
  );
  return 0;
}

// The Custom walk. Returns null on cancel.
async function runCustom(
  env: Record<string, string | undefined>,
  orKey: boolean,
): Promise<DeepPartial<ReviewgateConfig> | null> {
  const avail = (p: ProviderId) =>
    isProviderAvailable(p, p === "openrouter" ? "OPENROUTER_API_KEY" : undefined, { env });

  const picked = await multiselect({
    message: "Reviewers (space to toggle)",
    options: REVIEWER_PROVIDERS.map((p) => {
      const hint = avail(p) ? undefined : p === "openrouter" ? "no API key" : "CLI not found";
      return hint !== undefined ? { value: p, label: p, hint } : { value: p, label: p };
    }),
    initialValues: ["codex"] as ProviderId[],
    required: true,
  });
  if (isCancel(picked)) return null;

  const reviewers: CustomAnswers["reviewers"] = [];
  for (const p of picked as ProviderId[]) {
    const persona = await select({
      message: `${p}: persona`,
      options: PERSONAS.map((x) => ({ value: x, label: x })),
    });
    if (isCancel(persona)) return null;
    const model = await text({ message: `${p}: model`, initialValue: MODEL_DEFAULT[p] });
    if (isCancel(model)) return null;
    const verified = await maybeProbe(p, String(model), authFor(p));
    if (verified === "cancel") return null;
    reviewers.push({ provider: p, persona: String(persona), model: String(model) });
  }

  const wantCritic = await confirm({
    message: "Enable the critic (demote-only FP pass)?",
    initialValue: false,
  });
  if (isCancel(wantCritic)) return null;
  let critic: CustomAnswers["critic"] = null;
  if (wantCritic) {
    const cp = await select({
      message: "Critic provider",
      options: REVIEWER_PROVIDERS.map((p) => ({ value: p, label: p })),
    });
    if (isCancel(cp)) return null;
    critic = { provider: cp as ProviderId, persona: "fp-filter" };
  }

  const wantBrain = await confirm({
    message: "Enable the brain (repo memory + curator)?",
    initialValue: orKey,
  });
  if (isCancel(wantBrain)) return null;
  let brain: CustomAnswers["brain"] = null;
  if (wantBrain) {
    if (!orKey) {
      note(
        "brain needs OPENROUTER_API_KEY — config will be written but memory stays inert until you set it.",
      );
    }
    const cur = await select({
      message: "Curator (LLM judge — a non-reviewer like opencode is more independent)",
      options: REVIEWER_PROVIDERS.map((p) => ({ value: p, label: p })),
      initialValue: "codex" as ProviderId,
    });
    if (isCancel(cur)) return null;
    brain = { curator: { provider: cur as ProviderId, persona: "fp-filter" } };
  }

  const fp = await confirm({
    message: "Enable the FP-ledger (learn rejected false positives)?",
    initialValue: true,
  });
  if (isCancel(fp)) return null;

  const ctx = await confirm({
    message: "Enable contextDocs (inject current library docs)?",
    initialValue: false,
  });
  if (isCancel(ctx)) return null;
  if (ctx) note("contextDocs works keyless; set CONTEXT7_API_KEY for higher rate limits.");

  return buildCustomConfig({
    reviewers,
    critic,
    brain,
    fpLedger: Boolean(fp),
    contextDocs: Boolean(ctx),
  });
}

// Reports the probe result inline and continues (keep). Returns "cancel" on prompt cancel.
async function maybeProbe(
  provider: ProviderId,
  model: string,
  auth: "oauth" | "openrouter",
): Promise<"ok" | "kept" | "cancel"> {
  const verify = await confirm({
    message: `Verify ${provider}/${model} with a test call?`,
    initialValue: true,
  });
  if (isCancel(verify)) return "cancel";
  if (!verify) return "kept";
  const s = spinner();
  s.start(`probing ${provider}/${model} (${auth})…`);
  const r = await probeModel({
    provider,
    model,
    auth,
    ...(provider === "openrouter" ? { apiKeyEnv: "OPENROUTER_API_KEY" } : {}),
  });
  s.stop(r.ok ? "✓ model responds" : r.skipped ? `⚠ ${r.detail}` : `✗ ${r.detail}`);
  return "ok";
}
