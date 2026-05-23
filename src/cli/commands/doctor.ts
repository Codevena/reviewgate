// src/cli/commands/doctor.ts
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReviewgateConfig } from "../../config/define-config.ts";
import { loadEffectiveConfig } from "../../config/global.ts";
import { isProviderAvailable } from "../../providers/availability.ts";
import type { ProviderId } from "../../providers/registry.ts";
import { resolveGrammarWasm } from "../../research/grammars.ts";
import { checkSandboxHealth } from "../../sandbox/doctor-check.ts";
import { detectHostModel } from "../../utils/host-model.ts";

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  hint?: string;
}

// Resolves whether a provider can actually run. For CLI providers this probes the
// CLI; for openrouter it checks the CONFIGURED key env var (apiKeyEnv) — which may
// differ from the "OPENROUTER_API_KEY" default per provider/embeddings config, so
// the caller passes the relevant name rather than hard-coding it.
export type ProviderAvailable = (id: ProviderId, apiKeyEnv?: string) => boolean;

// A reviewer must be BOTH listed in phases.review.reviewers AND enabled in
// providers.<id> (only codex is enabled by default). If it is listed but not
// enabled the panel produces zero runs — the gate now fails CLOSED (ERROR) rather
// than silently passing, but the cause is non-obvious, so warn about it here.
export function reviewersEnabledCheck(cfg: ReviewgateConfig): Check {
  const name = "reviewer providers enabled";
  const disabled = [
    ...new Set(
      cfg.phases.review.reviewers.map((r) => r.provider).filter((p) => !cfg.providers[p]?.enabled),
    ),
  ];
  if (disabled.length === 0) {
    return {
      name,
      status: "ok",
      detail: `${cfg.phases.review.reviewers.length} reviewer(s) configured + enabled`,
    };
  }
  return {
    name,
    status: "warn",
    detail: `configured but NOT enabled in providers: ${disabled.join(", ")} → the gate cannot review and will ERROR`,
    hint: `Set providers.${disabled[0]}.enabled = true in reviewgate.config.ts (a reviewer must be listed in phases.review.reviewers AND enabled in providers).`,
  };
}

// The brain Curator / FP↔Brain Contradiction judge calls the curator provider's
// adapter.complete(). Its adapter is always built (a consumed provider), so the
// failure mode is NOT "disabled" — it is "the CLI/key isn't actually usable", in
// which case complete() throws and the judge SILENTLY falls back to its default
// (accept / no-contradiction). doctor was previously silent about this. When a
// curator is configured, confirm its provider can run; otherwise warn. `available`
// is injected so the check stays pure/testable.
export function curatorCheck(cfg: ReviewgateConfig, available: ProviderAvailable): Check | null {
  const brain = cfg.phases.brain;
  if (!brain?.enabled || !brain.curator) return null; // no LLM judge → nothing to check
  const id = brain.curator.provider;
  const name = "brain curator (LLM judge)";
  if (!available(id, cfg.providers[id]?.apiKeyEnv)) {
    return {
      name,
      status: "warn",
      detail: `'${id}' configured but its CLI/API key is unavailable → the judge silently falls back to its default (accept / no-contradiction)`,
      hint:
        id === "openrouter"
          ? "Set OPENROUTER_API_KEY in your environment (the curator uses it for completions)."
          : `Install/authenticate the '${id}' CLI — the curator runs it via complete().`,
    };
  }
  const alsoReviewer = cfg.phases.review.reviewers.some((r) => r.provider === id);
  return {
    name,
    status: "ok",
    detail: `${id} (${brain.curator.persona})${
      alsoReviewer
        ? " — note: also a reviewer; a non-reviewer judge (e.g. opencode) is more independent"
        : ""
    }`,
  };
}

// The critic is a demote-only pass (likely-FP → INFO). If its provider can't run,
// the critic errors and NO findings are demoted — not dangerous (fail-safe: more
// findings survive), but worth surfacing since the user configured it expecting it
// to work. Same availability notion as the curator.
export function criticCheck(cfg: ReviewgateConfig, available: ProviderAvailable): Check | null {
  const critic = cfg.phases.critic;
  if (!critic) return null;
  const id = critic.provider;
  const name = "critic provider";
  if (!available(id, cfg.providers[id]?.apiKeyEnv)) {
    return {
      name,
      status: "warn",
      detail: `'${id}' configured but its CLI/API key is unavailable → the critic can't run and no findings will be demoted`,
      hint:
        id === "openrouter"
          ? "Set OPENROUTER_API_KEY in your environment."
          : `Install/authenticate the '${id}' CLI — the critic runs it.`,
    };
  }
  return { name, status: "ok", detail: id };
}

// The brain's read-path injection AND the curator's pairing both embed text via the
// OpenRouter embeddings provider. With brain enabled but OPENROUTER_API_KEY unset,
// the embedder is unavailable → those memory features are SILENTLY skipped. (The
// embeddings provider is always openrouter per the schema.)
export function brainEmbeddingsCheck(
  cfg: ReviewgateConfig,
  available: ProviderAvailable,
): Check | null {
  const brain = cfg.phases.brain;
  if (!brain?.enabled) return null;
  const name = "brain embeddings";
  if (!available("openrouter", brain.embeddings.apiKeyEnv)) {
    return {
      name,
      status: "warn",
      detail:
        "brain is enabled but OPENROUTER_API_KEY is unset → memory injection + curator pairing are silently disabled (no embedder)",
      hint: "Set OPENROUTER_API_KEY in your environment (the brain embeds memories via OpenRouter).",
    };
  }
  return { name, status: "ok", detail: `openrouter / ${brain.embeddings.model}` };
}

// contextDocs works keyless (lower rate limit), so this is informational (always ok) — it just
// surfaces whether CONTEXT7_API_KEY is set. cfg is the validated effective config, so when
// contextDocs is enabled cd.apiKeyEnv is always populated (schema default CONTEXT7_API_KEY).
export function contextDocsCheck(
  cfg: ReviewgateConfig,
  env: Record<string, string | undefined>,
): Check | null {
  const cd = cfg.phases.contextDocs;
  if (!cd?.enabled) return null;
  const keyName = cd.apiKeyEnv;
  const set = Boolean(env[keyName]);
  return {
    name: "contextDocs",
    status: "ok",
    detail: set
      ? `enabled (${keyName} set)`
      : `enabled (${keyName} unset — keyless works; set it for higher rate limits)`,
  };
}

// A reviewer's `fallback` chain only rescues a quota-exhausted primary if at
// least one listed provider is BOTH configured (providers.<id> present) and
// available (CLI/key resolves). A chain whose every candidate is missing is a
// silent no-op — warn so the user fixes it before the primary actually caps out.
export function fallbackChainCheck(
  cfg: ReviewgateConfig,
  available: ProviderAvailable,
): Check | null {
  const withChains = cfg.phases.review.reviewers.filter((r) => (r.fallback?.length ?? 0) > 0);
  if (withChains.length === 0) return null;
  const broken: string[] = [];
  for (const r of withChains) {
    const usable = (r.fallback ?? []).some(
      (fb) => cfg.providers[fb] != null && available(fb, cfg.providers[fb]?.apiKeyEnv),
    );
    if (!usable) broken.push(r.provider);
  }
  if (broken.length === 0) {
    return {
      name: "reviewer fallback chains",
      status: "ok",
      detail: `${withChains.length} reviewer(s) have a usable quota-failover chain`,
    };
  }
  return {
    name: "reviewer fallback chains",
    status: "warn",
    detail: `no configured+available fallback for: ${broken.join(", ")} → a quota hit there means reduced coverage`,
    hint: "Ensure each provider listed in `fallback` is present under providers.<id> and its CLI/key is reachable.",
  };
}

// doctor cannot detect quota exhaustion proactively (a --version probe never
// makes a billed call), so it surfaces it RETROSPECTIVELY: if the last review
// recorded a `quota-exhausted` reviewer, warn that the provider was recently
// capped. `readPending` is injected for testability (prod reads pending.json).
export function recentQuotaCheck(
  reviewers: Array<{ provider: string; status: string }> | null,
): Check | null {
  if (!reviewers) return null;
  const capped = [
    ...new Set(reviewers.filter((r) => r.status === "quota-exhausted").map((r) => r.provider)),
  ];
  if (capped.length === 0) return null;
  return {
    name: "provider quota",
    status: "warn",
    detail: `recently hit a usage limit: ${capped.join(", ")} (from the last review) → relies on the fallback chain until quota resets`,
    hint: "This is transient; configure a `fallback` chain for affected reviewers so coverage holds while quota is exhausted.",
  };
}

function checkBinary(bin: string, name: string): Check {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (r.status === 0)
    return { name, status: "ok", detail: (r.stdout ?? "").trim().split("\n")[0] ?? "" };
  return {
    name,
    status: "fail",
    detail: `${bin} --version exit=${r.status ?? "spawn error"}`,
    ...(r.error?.message ? { hint: r.error.message } : {}),
  };
}

export interface DoctorInput {
  repoRoot: string;
  capture?: boolean;
}

export async function runDoctor(input: DoctorInput): Promise<number> {
  const checks: Check[] = [];

  checks.push(checkBinary("codex", "codex CLI"));
  checks.push(checkBinary("git", "git"));

  const sb = await checkSandboxHealth();
  checks.push({
    name: `sandbox (${sb.platform})`,
    status: sb.available ? "ok" : "fail",
    detail: sb.detail,
    ...(sb.remediation ? { hint: sb.remediation } : {}),
  });

  const host = detectHostModel({ env: process.env as Record<string, string>, hookStdin: null });
  checks.push({
    name: "host-model detection",
    status: host.source === "fallback:assume-opus" ? "warn" : "ok",
    detail: `tier=${host.tier} source=${host.source}${host.modelId ? ` model=${host.modelId}` : ""}`,
    ...(host.source === "fallback:assume-opus"
      ? {
          hint: "Set REVIEWGATE_HOST_MODEL or CLAUDE_MODEL to your active Claude model for accurate downgrade.",
        }
      : {}),
  });

  const cfgPath = join(input.repoRoot, "reviewgate.config.ts");
  const cfgExists = existsSync(cfgPath);
  checks.push({
    name: "reviewgate.config.ts",
    status: cfgExists ? "ok" : "warn",
    detail: cfgExists ? "present" : "missing (defaults will apply)",
  });

  // Inspect the effective config: warn if a configured reviewer is not enabled in
  // providers (else the panel runs 0 reviewers → the gate ERRORs with no obvious
  // cause). A config that fails to load is surfaced as a warn rather than crashing.
  try {
    const cfg = await loadEffectiveConfig({
      cwd: input.repoRoot,
      env: process.env as Record<string, string | undefined>,
      home: homedir(),
    });
    checks.push(reviewersEnabledCheck(cfg));
    // Provider availability: CLI providers need their CLI reachable; openrouter
    // needs its CONFIGURED key env var set (defaults to OPENROUTER_API_KEY, but a
    // provider/embeddings config may name a different one). ("claude-code" runs the
    // `claude` CLI.)
    const curatorAvailable: ProviderAvailable = (id, apiKeyEnv) =>
      isProviderAvailable(id, apiKeyEnv);
    const crit = criticCheck(cfg, curatorAvailable);
    if (crit) checks.push(crit);
    const emb = brainEmbeddingsCheck(cfg, curatorAvailable);
    if (emb) checks.push(emb);
    const cur = curatorCheck(cfg, curatorAvailable);
    if (cur) checks.push(cur);
    const cd = contextDocsCheck(cfg, process.env as Record<string, string | undefined>);
    if (cd) checks.push(cd);
    const fb = fallbackChainCheck(cfg, curatorAvailable);
    if (fb) checks.push(fb);
  } catch (e) {
    checks.push({
      name: "reviewgate.config.ts load",
      status: "warn",
      detail: `failed to load — defaults will apply: ${(e as Error).message}`,
    });
  }

  // Retrospective quota warning from the last recorded review (best-effort —
  // missing/unparseable pending.json is simply skipped).
  try {
    const pendingPath = join(input.repoRoot, ".reviewgate", "pending.json");
    if (existsSync(pendingPath)) {
      const parsed = JSON.parse(readFileSync(pendingPath, "utf8")) as {
        reviewers?: Array<{ provider: string; status: string }>;
      };
      const q = recentQuotaCheck(parsed.reviewers ?? null);
      if (q) checks.push(q);
    }
  } catch {
    // ignore — quota hint is advisory
  }

  // Optional reviewer CLIs (M2). These are only needed if enabled in config;
  // report as warn (not fail) when absent so codex-only setups stay green.
  for (const [bin, name] of [
    ["gemini", "gemini CLI (optional)"],
    ["claude", "claude CLI (optional)"],
  ] as const) {
    const c = checkBinary(bin, name);
    checks.push({ ...c, status: c.status === "fail" ? "warn" : c.status });
  }
  checks.push({
    name: "OPENROUTER_API_KEY",
    status: process.env.OPENROUTER_API_KEY ? "ok" : "warn",
    detail: process.env.OPENROUTER_API_KEY
      ? "set"
      : "unset (needed for openrouter reviewers AND the brain's embeddings/curator)",
  });

  const rg = checkBinary("rg", "ripgrep (optional)");
  checks.push({ ...rg, status: rg.status === "fail" ? "warn" : rg.status });

  const grammar = resolveGrammarWasm("tree-sitter-typescript.wasm");
  checks.push({
    name: "tree-sitter grammars",
    status: grammar ? "ok" : "warn",
    detail: grammar ? grammar : "no grammar wasm found (symbol graph disabled; reviews still run)",
  });

  if (!input.capture) {
    for (const c of checks) {
      const sym = c.status === "ok" ? "✓" : c.status === "warn" ? "⚠" : "✗";
      process.stdout.write(`${sym}  ${c.name}: ${c.detail}\n`);
      if (c.hint) process.stdout.write(`    hint: ${c.hint}\n`);
    }
  }

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  if (fails > 0) return 2;
  if (warns > 0) return 1;
  return 0;
}
