// src/cli/commands/doctor.ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ReviewgateConfig } from "../../config/define-config.ts";
import { loadConfig } from "../../config/loader.ts";
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
export function curatorCheck(
  cfg: ReviewgateConfig,
  available: (id: ProviderId) => boolean,
): Check | null {
  const brain = cfg.phases.brain;
  if (!brain?.enabled || !brain.curator) return null; // no LLM judge → nothing to check
  const id = brain.curator.provider;
  const name = "brain curator (LLM judge)";
  if (!available(id)) {
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
    const cfg = await loadConfig(cfgExists ? cfgPath : null);
    checks.push(reviewersEnabledCheck(cfg));
    // Curator/judge availability: CLI providers need their CLI reachable;
    // openrouter needs OPENROUTER_API_KEY. ("claude-code" runs the `claude` CLI.)
    const CURATOR_BIN: Record<ProviderId, string | null> = {
      codex: "codex",
      gemini: "gemini",
      "claude-code": "claude",
      opencode: "opencode",
      openrouter: null,
    };
    const curatorAvailable = (id: ProviderId): boolean => {
      if (id === "openrouter") return Boolean(process.env.OPENROUTER_API_KEY);
      const bin = CURATOR_BIN[id];
      return bin ? checkBinary(bin, "").status === "ok" : false;
    };
    const cur = curatorCheck(cfg, curatorAvailable);
    if (cur) checks.push(cur);
  } catch (e) {
    checks.push({
      name: "reviewgate.config.ts load",
      status: "warn",
      detail: `failed to load — defaults will apply: ${(e as Error).message}`,
    });
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
