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
import {
  type DeepPartial,
  type ReviewgateConfig,
  defineConfig,
} from "../../config/define-config.ts";
import { diffFromDefaults } from "../../config/diff-defaults.ts";
import { loadEffectiveConfig, resolveGlobalConfigPath } from "../../config/global.ts";
import { serializeConfig } from "../../config/serialize.ts";
import { isProviderAvailable } from "../../providers/availability.ts";
import type { ProviderId } from "../../providers/registry.ts";
import { type CustomAnswers, buildCustomConfig, buildQuickPreset } from "../setup/build-config.ts";
import {
  MODEL_DEFAULT,
  RECOMMENDED_DEFAULTS,
  type WizardDefaults,
  answersFromConfig,
} from "../setup/prefill.ts";
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
    // Single backup slot — a prior .bak is overwritten (git is the real history).
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
  const hasExisting = existsSync(targetPath) || (globalPath !== null && existsSync(globalPath));
  const defaults: WizardDefaults = hasExisting
    ? answersFromConfig(await loadEffectiveConfig({ cwd: input.repoRoot, env, home }))
    : RECOMMENDED_DEFAULTS;
  if (input.global) {
    if (!globalPath) {
      outro("setup aborted: no resolvable global config dir — set XDG_CONFIG_HOME or HOME");
      return 1;
    }
    targetPath = globalPath;
  } else if (globalPath) {
    const target = await select({
      message: "Where should this config be saved?",
      options: [
        { value: "project", label: `This project (${targetPath})` },
        { value: "global", label: `My global default (${globalPath})` },
      ],
    });
    if (isCancel(target)) return cancelOut();
    if (target === "global") targetPath = globalPath;
  }
  // else: no resolvable global path → default to the project path (no prompt)

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
    const custom = await runCustom(env, orKey, defaults);
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
  defaults: WizardDefaults,
): Promise<DeepPartial<ReviewgateConfig> | null> {
  const avail = (p: ProviderId) =>
    isProviderAvailable(p, p === "openrouter" ? "OPENROUTER_API_KEY" : undefined, { env });

  const picked = await multiselect({
    message: "Reviewers (space to toggle)",
    options: REVIEWER_PROVIDERS.map((p) => {
      const hint = avail(p) ? undefined : p === "openrouter" ? "no API key" : "CLI not found";
      return hint !== undefined ? { value: p, label: p, hint } : { value: p, label: p };
    }),
    initialValues: defaults.reviewerProviders,
    required: true,
  });
  if (isCancel(picked)) return null;

  const reviewers: CustomAnswers["reviewers"] = [];
  for (const p of picked as ProviderId[]) {
    const seed = defaults.perReviewer[p];
    const persona = await select({
      message: `${p}: persona`,
      options: PERSONAS.map((x) => ({ value: x, label: x })),
      initialValue: seed?.persona ?? "security",
    });
    if (isCancel(persona)) return null;
    const model = await promptModelWithProbe(p, authFor(p), seed?.model ?? MODEL_DEFAULT[p]);
    if (model === null) return null;

    // Quota-failover chain: only providers OTHER than this reviewer that are
    // actually available (CLI/key reachable) — a fallback to a missing CLI is a
    // no-op. Optional; empty selection = no failover for this slot.
    let fallback: ProviderId[] = [];
    const fbCandidates = REVIEWER_PROVIDERS.filter((x) => x !== p && avail(x));
    if (fbCandidates.length > 0) {
      const fb = await multiselect({
        message: `${p}: quota-failover fallback(s) — used ONLY if ${p} hits its usage cap (space to toggle, enter to skip)`,
        options: fbCandidates.map((x) => ({ value: x, label: x })),
        initialValues: (seed?.fallback ?? []).filter((x) => fbCandidates.includes(x)),
        required: false,
      });
      if (isCancel(fb)) return null;
      fallback = fb as ProviderId[];
    }
    reviewers.push({ provider: p, persona: String(persona), model, fallback });
  }

  const wantCritic = await confirm({
    message: "Enable the critic (demote-only FP pass)?",
    initialValue: Boolean(defaults.critic),
  });
  if (isCancel(wantCritic)) return null;
  let critic: CustomAnswers["critic"] = null;
  if (wantCritic) {
    const cp = await select({
      message: "Critic provider",
      options: REVIEWER_PROVIDERS.map((p) => ({ value: p, label: p })),
      initialValue: defaults.critic?.provider ?? "codex",
    });
    if (isCancel(cp)) return null;
    const provider = cp as ProviderId;
    const cm = await promptModelWithProbe(
      provider,
      authFor(provider),
      defaults.critic?.model ?? MODEL_DEFAULT[provider],
    );
    if (cm === null) return null;
    critic = { provider, persona: "fp-filter", model: cm };
  }

  const wantBrain = await confirm({
    message: "Enable the brain (repo memory + curator)?",
    initialValue: Boolean(defaults.brainCurator) || orKey,
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
      initialValue: defaults.brainCurator?.provider ?? "codex",
    });
    if (isCancel(cur)) return null;
    const provider = cur as ProviderId;
    const cm = await promptModelWithProbe(
      provider,
      authFor(provider),
      defaults.brainCurator?.model ?? MODEL_DEFAULT[provider],
    );
    if (cm === null) return null;
    brain = { curator: { provider, persona: "fp-filter", model: cm } };
  }

  const fp = await confirm({
    message: "Enable the FP-ledger (learn rejected false positives)?",
    initialValue: defaults.fpLedger,
  });
  if (isCancel(fp)) return null;

  const rep = await confirm({
    message: "Enable reviewer reputation (down-weight a chronically-wrong reviewer)?",
    initialValue: defaults.reputation,
  });
  if (isCancel(rep)) return null;

  const ctx = await confirm({
    message: "Enable contextDocs (inject current library docs)?",
    initialValue: defaults.contextDocs,
  });
  if (isCancel(ctx)) return null;
  if (ctx) note("contextDocs works keyless; set CONTEXT7_API_KEY for higher rate limits.");

  return buildCustomConfig({
    reviewers,
    critic,
    brain,
    fpLedger: Boolean(fp),
    contextDocs: Boolean(ctx),
    reputation: Boolean(rep),
  });
}

// Prompts for a model (pre-filled with the provider default), optionally live-probes it,
// and on a probe FAILURE offers re-enter / keep-anyway (spec §6). Returns the chosen model
// string, or null if the user cancelled. A successful OR un-verifiable probe (the provider
// has no completion API → cannot verify) just accepts the entered model.
async function promptModelWithProbe(
  provider: ProviderId,
  auth: "oauth" | "openrouter",
  initialModel: string = MODEL_DEFAULT[provider],
): Promise<string | null> {
  let initial = initialModel;
  for (;;) {
    const model = await text({ message: `${provider}: model`, initialValue: initial });
    if (isCancel(model)) return null;
    const chosen = String(model);

    const verify = await confirm({
      message: `Verify ${provider}/${chosen} with a test call?`,
      initialValue: true,
    });
    if (isCancel(verify)) return null;
    if (!verify) return chosen;

    const s = spinner();
    s.start(`probing ${provider}/${chosen} (${auth})…`);
    const r = await probeModel({
      provider,
      model: chosen,
      auth,
      ...(provider === "openrouter" ? { apiKeyEnv: "OPENROUTER_API_KEY" } : {}),
    });
    s.stop(r.ok ? "✓ model responds" : r.skipped ? `⚠ ${r.detail}` : `✗ ${r.detail}`);

    // Success or un-verifiable → accept. Only a genuine failure offers re-enter/keep.
    if (r.ok || r.skipped) return chosen;
    const next = await select({
      message: `${provider}/${chosen} did not verify — what now?`,
      options: [
        { value: "reenter", label: "Re-enter the model" },
        { value: "keep", label: "Keep it anyway" },
      ],
      initialValue: "reenter",
    });
    if (isCancel(next)) return null;
    if (next === "keep") return chosen;
    initial = chosen; // re-enter, pre-filled with the last attempt
  }
}
