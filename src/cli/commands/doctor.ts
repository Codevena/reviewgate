// src/cli/commands/doctor.ts
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CRITIC_TAIL_RESERVE_MS,
  PANEL_TAIL_RESERVE_MS,
  POST_ABORT_SETTLE_MS_DEFAULT,
  SETUP_BUDGET_MS_DEFAULT,
} from "../../config/budgets.ts";
import { controlPlaneStatus } from "../../config/control-plane.ts";
import type { ReviewgateConfig } from "../../config/define-config.ts";
import { loadEffectiveConfig } from "../../config/global.ts";
import { BrainStore } from "../../core/brain/store.ts";
import { classifyEntry } from "../../core/lore/staleness.ts";
import { loadLore } from "../../core/lore/store.ts";
import { QuotaCooldownStore } from "../../core/quota-cooldown.ts";
import { ReputationStore } from "../../core/reputation/store.ts";
import { installedHosts } from "../../hosts/hooks.ts";
import { isProviderAvailable } from "../../providers/availability.ts";
import type { ProviderId } from "../../providers/registry.ts";
import { resolveGrammarWasm } from "../../research/grammars.ts";
import { sandboxRuntimeAvailable } from "../../sandbox/availability.ts";
import { checkSandboxHealth } from "../../sandbox/doctor-check.ts";
import { worktreeInfo } from "../../utils/git.ts";
import { detectHostModel } from "../../utils/host-model.ts";
import { anyHooksInstalled } from "./init.ts";

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  hint?: string;
}

/**
 * Maps the doctor checks to a process exit code. Only a hard `fail` is a failure
 * (exit 2); `warn`s are advisory (optional CLIs absent, no OpenRouter key, etc.)
 * and a green-by-design minimal install (e.g. codex-only) must exit 0 so it does
 * not break `reviewgate doctor && ...` chains or CI health gates.
 */
export function doctorExitCode(checks: Check[]): number {
  return checks.some((c) => c.status === "fail") ? 2 : 0;
}

export function agentHostHooksCheck(repoRoot: string): Check {
  const hosts = installedHosts(repoRoot);
  if (hosts.length === 0) {
    return {
      name: "agent host hooks",
      status: "warn",
      detail: "no Claude Code or Codex Reviewgate hooks found in this checkout",
      hint: "Run `reviewgate init` (or `reviewgate init --hooks-only --host both`).",
    };
  }
  if (hosts.includes("codex")) {
    return {
      name: "agent host hooks",
      status: "warn",
      detail: `${hosts.join(" + ")} installed; Codex activation is user-controlled and its per-hash trust state is not visible to Reviewgate`,
      hint: "Start or restart Codex in this repo, open `/hooks`, inspect SessionStart/PostToolUse/Stop, and trust their exact current hash. Repeat only after the definitions change.",
    };
  }
  return {
    name: "agent host hooks",
    status: "ok",
    detail: "claude hooks installed",
  };
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

// A single effective reviewer structurally disables three of the four noise-
// suppression layers: consensus demote (everything is `singleton`), FP-ledger
// promotion (needs distinct providers >= 2), and reputation demote (per-provider).
// Only confidenceFloor survives — so a single-reviewer panel is much noisier and
// converges slower (field report 2026-06-03). Surface it. Returns null at >=2 (the
// healthy case) and at 0 (reviewersEnabledCheck owns that harder ERROR), so this
// fires only at exactly one enabled reviewer.
export function singleReviewerCheck(cfg: ReviewgateConfig): Check | null {
  const enabled = [
    ...new Set(
      cfg.phases.review.reviewers.map((r) => r.provider).filter((p) => cfg.providers[p]?.enabled),
    ),
  ];
  if (enabled.length !== 1) return null;
  return {
    name: "reviewer panel size",
    status: "warn",
    detail: `Single effective reviewer (${enabled[0]}): consensus, FP-ledger promotion, and reputation demote are all inert — expect more lone-finding noise and slower convergence.`,
    hint: "Add a 2nd provider to phases.review.reviewers and enable it in providers.<id> so corroboration and cross-provider FP-suppression engage.",
  };
}

// loop.acknowledgePass turns every clean PASS into a one-time block so the agent
// is TOLD the review passed. It is NOT agent-loop-safe: paired with a pending
// policy candidate (a house-rule change awaiting TTY-only `config approve`) or an
// actively-editing agent it re-blocks every turn, and an agent cannot clear the
// nag itself. notify.desktop is the loop-safe way to surface a pass. Advisory
// (warn), never a hard fail. Returns null when off (the default). (FlashBuddy field bug.)
export function acknowledgePassCheck(cfg: ReviewgateConfig): Check | null {
  if (!cfg.loop.acknowledgePass) return null;
  return {
    name: "loop.acknowledgePass",
    status: "warn",
    detail:
      "acknowledgePass blocks every clean PASS for the agent to acknowledge — not agent-loop-safe. With a pending policy candidate (e.g. a house-rule change awaiting `reviewgate config approve`) or an actively-editing agent it re-nags every turn, and a TTY-only approval an agent can't run means the loop never clears itself.",
    hint: "Prefer loop.acknowledgePass:false + notify.desktop:true (the loop-safe pass notification).",
  };
}

// Lore (per-repo curated project knowledge, draft->canon). Optional/advisory —
// never a hard `fail`, only `ok`/`warn`, mirroring curatorCheck's posture. Returns
// null when `phases.lore` is null (off, the default), matching curatorCheck's
// null-when-not-applicable contract. Healthy = no parse-invalid files, no
// zero-match anchors, no broad (>200-file) anchors; `stale` entries alone don't
// flip the status (staleness is informational here — the reminder mechanics live
// in the loop-driver, not doctor). synchronous: loadLore/classifyEntry are both
// synchronous by contract (see src/core/lore/staleness.ts header).
export function loreCheck(repoRoot: string, cfg: ReviewgateConfig): Check | null {
  if (!cfg.phases.lore) return null;
  const name = "lore";
  const { entries, invalid } = loadLore(repoRoot);
  let canon = 0;
  let draft = 0;
  let stale = 0;
  let inert = 0;
  const issues: string[] = [];
  for (const inv of invalid) issues.push(`${inv.file}: ${inv.error}`);
  for (const entry of entries) {
    if (entry.status === "canon") canon++;
    else draft++;
    const cls = classifyEntry(repoRoot, entry);
    if (cls.state === "stale") stale++;
    if (cls.state === "broad") {
      inert++;
      issues.push(`${entry.id}: anchor too broad — narrow it`);
    } else if (cls.state === "zero-match") {
      inert++;
      issues.push(`${entry.id}: anchors match zero files`);
    }
  }
  if (issues.length === 0) {
    return {
      name,
      status: "ok",
      detail: `${canon} canon, ${draft} draft, ${stale} stale, ${inert} inert`,
    };
  }
  return { name, status: "warn", detail: issues.join("; ") };
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
          : id === "ollama"
            ? "Set OLLAMA_API_KEY in your environment (Ollama Cloud), or point providers.ollama.baseUrl at a local daemon."
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
          : id === "ollama"
            ? "Set OLLAMA_API_KEY in your environment (Ollama Cloud), or point providers.ollama.baseUrl at a local daemon."
            : `Install/authenticate the '${id}' CLI — the critic runs it.`,
    };
  }
  return { name, status: "ok", detail: id };
}

// S6 grounding layer 2 (LLM judge) demotes a CRITICAL whose claim isn't supported by the
// actual code, via the provider's adapter.complete(). If the provider can't run, the judge
// silently no-ops (fail-safe: nothing demoted, the CRITICAL stays blocking) — but the user
// configured it expecting fabricated CRITICALs to be caught, so surface it like the critic.
export function groundingCheck(cfg: ReviewgateConfig, available: ProviderAvailable): Check | null {
  const grounding = cfg.phases.grounding;
  if (!grounding) return null;
  const id = grounding.provider;
  const name = "grounding judge";
  if (!available(id, cfg.providers[id]?.apiKeyEnv)) {
    return {
      name,
      status: "warn",
      detail: `'${id}' configured but its CLI/API key is unavailable → the grounding judge can't run and no fabricated CRITICALs will be demoted`,
      hint:
        id === "openrouter"
          ? "Set OPENROUTER_API_KEY in your environment (the grounding judge uses it for completions)."
          : id === "ollama"
            ? "Set OLLAMA_API_KEY in your environment (Ollama Cloud), or point providers.ollama.baseUrl at a local daemon."
            : `Install/authenticate the '${id}' CLI — the grounding judge runs it via complete().`,
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

// What the brain has actually LEARNED in this repo (reads .reviewgate/brain/brain.json).
// Distinct from brainEmbeddingsCheck (which only reports whether the embedder COULD run):
// this answers "is the gate accumulating memory?". Informational (always ok) — an empty
// brain is normal early on. Quorum needs ≥2 DISTINCT providers proposing the same
// convention; with cross-run candidates (default on) this can span runs, so a
// single-reviewer panel with provider variation across runs (via failover) can still
// promote over time.
export async function brainMemoryCheck(
  repoRoot: string,
  cfg: ReviewgateConfig,
): Promise<Check | null> {
  if (!cfg.phases.brain?.enabled) return null;
  const name = "brain memory";
  const entries = (await new BrainStore(repoRoot).snapshot()).entries;
  if (entries.length === 0) {
    return {
      name,
      status: "ok",
      detail:
        "enabled — no memories learned yet (promotion needs ≥2 distinct providers; with cross-run candidates this can span across runs)",
    };
  }
  const by = (s: string) => entries.filter((e) => e.status === s).length;
  const parts = (["active", "candidate", "stale", "archived"] as const)
    .map((s) => ({ s, n: by(s) }))
    .filter(({ n }) => n > 0)
    .map(({ s, n }) => `${n} ${s}`);
  return { name, status: "ok", detail: `${entries.length} memories (${parts.join(", ")})` };
}

// Reviewer reputation: surfaces per-reviewer (provider:persona) trust scores from the reputation store.
// Only runs when reputation is enabled; warns when any reviewer is in demoting state
// (trust below floor with enough samples). Analogous to brainMemoryCheck.
export async function reputationCheck(
  repoRoot: string,
  cfg: ReviewgateConfig,
): Promise<Check | null> {
  const rep = cfg.phases.reputation;
  if (!rep?.enabled) return null;
  const name = "reviewer reputation";
  const rows = await new ReputationStore(repoRoot).forDoctor(rep, new Date());
  if (rows.length === 0) {
    return { name, status: "ok", detail: "enabled — no reputation data yet" };
  }
  const demoting = rows.filter((r) => r.demoting);
  const detail = rows
    .map(
      (r) =>
        `${r.reviewer} ${r.correct}✓/${r.wrong}✗ (trust ${r.trust.toFixed(2)})${r.demoting ? " ⚠ demoting" : ""}${r.quarantined ? " ⛔ quarantined" : ""}`,
    )
    .join(" · ");
  return {
    name,
    status: demoting.length > 0 ? "warn" : "ok",
    detail,
    ...(demoting.length > 0
      ? {
          hint: "This is learned finding calibration, not a provider outage or login failure. Run `reviewgate learn status` to inspect the history.",
        }
      : {}),
  };
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

// The Stop-hook timeout MUST stay ABOVE the gate's own self-deadline
// (loop.runTimeoutMs): if an agent host kills the hook before the gate aborts
// itself, the turn ends NON-BLOCKING = un-reviewed (fail-open). So a too-LOW
// Stop-hook timeout is the dangerous misconfig (the opposite of intuition — the
// naive "lower it to shorten hangs" breaks the invariant). Also flags a
// SessionStart hook with no timeout (a wedged reset stalls session start).
// Returns null when the reviewgate Stop hook isn't installed (nothing to check).
export function hookTimeoutCheck(repoRoot: string, cfg: ReviewgateConfig): Check | null {
  const installed: Array<{
    host: "claude" | "codex";
    path: string;
    stop: { timeout?: number };
    reset?: { timeout?: number };
  }> = [];
  for (const file of [
    { host: "claude" as const, path: join(repoRoot, ".claude", "settings.json") },
    { host: "codex" as const, path: join(repoRoot, ".codex", "hooks.json") },
  ]) {
    if (!existsSync(file.path)) continue;
    try {
      const settings = JSON.parse(readFileSync(file.path, "utf8")) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ command?: string; timeout?: number }> }>>;
      };
      const groups = settings.hooks ?? {};
      const findHook = (event: string, binSuffix: string) =>
        (groups[event] ?? [])
          .flatMap((g) => g.hooks ?? [])
          .find((h) => h.command?.includes(binSuffix));
      const stop = findHook("Stop", ".reviewgate/bin/gate");
      const reset = findHook("SessionStart", ".reviewgate/bin/reset");
      if (stop)
        installed.push({ host: file.host, path: file.path, stop, ...(reset ? { reset } : {}) });
    } catch {
      /* malformed hook documents are handled by init; don't invent timeout data */
    }
  }
  if (installed.length === 0) return null;

  const runTimeoutS = Math.round(cfg.loop.runTimeoutMs / 1000);
  // The Stop-hook timeout must exceed runTimeoutMs by enough to cover everything
  // that runs OUTSIDE the self-deadline: the shared setup budget (config + lock +
  // git/diff) PLUS the post-abort settle cap. DERIVED from the source-of-truth
  // budget constants (config/budgets.ts) — not a literal — so a future change to
  // either budget can't silently invalidate the fail-open margin (M-A0). Too thin
  // a margin → the OS kills the gate mid-run with empty stdout = fail-open.
  const MIN_SETUP_MARGIN_S = Math.ceil(
    (SETUP_BUDGET_MS_DEFAULT + POST_ABORT_SETTLE_MS_DEFAULT) / 1000,
  );
  // The invariant (config/budgets.ts) is STRICT: setup + runTimeoutMs + settle <
  // OS Stop-hook timeout. At margin == setup+settle the sum EQUALS the timeout,
  // leaving no room for post-settle state/audit/stdout work → boundary fail-open.
  // So require the margin to STRICTLY exceed MIN_SETUP_MARGIN_S, and recommend an
  // extra teardown slack on top (the default 2400s hook covers 1800 + 150 + 30 amply).
  const TEARDOWN_SLACK_S = 30;
  const recommendedStopS = runTimeoutS + MIN_SETUP_MARGIN_S + TEARDOWN_SLACK_S;
  const issues: string[] = [];
  for (const hook of installed) {
    const prefix = installed.length > 1 ? `${hook.host}: ` : "";
    if (hook.stop.timeout === undefined) {
      issues.push(`${prefix}Stop hook has no timeout`);
    } else if (hook.stop.timeout * 1000 <= cfg.loop.runTimeoutMs) {
      issues.push(
        `${prefix}Stop-hook timeout (${hook.stop.timeout}s) ≤ gate self-deadline loop.runTimeoutMs (${runTimeoutS}s) → the hook is killed mid-review (non-blocking) and a turn can end UN-reviewed (fail-open)`,
      );
    } else if (
      hook.stop.timeout !== undefined &&
      hook.stop.timeout - runTimeoutS <= MIN_SETUP_MARGIN_S
    ) {
      issues.push(
        `${prefix}Stop-hook timeout (${hook.stop.timeout}s) leaves only ${hook.stop.timeout - runTimeoutS}s margin over loop.runTimeoutMs (${runTimeoutS}s) — at or under the ${MIN_SETUP_MARGIN_S}s needed for pre-deadline setup (git/state load) + post-abort settle. The gate can be OS-killed mid-run (fail-open)`,
      );
    }
    if (hook.reset && hook.reset.timeout === undefined) {
      issues.push(
        `${prefix}SessionStart hook has no timeout → a wedged reset can stall session start`,
      );
    }
  }
  if (issues.length === 0) {
    return {
      name: "hook timeouts",
      status: "ok",
      detail: `${installed.map((hook) => hook.host).join(" + ")}: Stop-hook timeout > loop.runTimeoutMs (${runTimeoutS}s); SessionStart bounded`,
    };
  }
  return {
    name: "hook timeouts",
    status: "warn",
    detail: issues.join(" · "),
    hint: `Set the Stop-hook timeout to ≥ ${recommendedStopS}s (loop.runTimeoutMs ${runTimeoutS}s + ${MIN_SETUP_MARGIN_S}s setup margin) in ${installed.map((hook) => hook.path.replace(`${repoRoot}/`, "")).join(" and ")}. To shorten hangs, lower BOTH together (e.g. runTimeoutMs 420s + Stop-hook timeout 540s), and give SessionStart a timeout (e.g. 30).`,
  };
}

// Advisory: worst-case panel wall-clock vs loop.runTimeoutMs, mirroring the
// runtime's TWO-reserve model (do not lump the reserves): reviewers run
// unclamped iff slowestChain + PANEL_TAIL_RESERVE_MS fits; the sequential
// critic runs unclamped iff slowestChain + critic + CRITIC_TAIL_RESERVE_MS
// fits. Worst case = slowestChain + max(PANEL_TAIL, critic + CRITIC_TAIL).
// Slot chains = primary + declared fallbacks (sequential inside one slot;
// slots are parallel). Reviewer budget-clamping degrades an oversized config
// gracefully — truncated reviews of large diffs (reduced review quality),
// skipped fallbacks, skipped critic — instead of aborting, but the user should
// size deliberately, so WARN, never FAIL. Last-resort failover is unbounded by
// declaration and deliberately excluded (the runtime clamp bounds it).
export function panelBudgetCheck(cfg: ReviewgateConfig): Check {
  const providers = cfg.providers as Record<string, { timeoutMs?: number } | undefined>;
  const t = (p: string): number => providers[p]?.timeoutMs ?? 300_000;
  const chains = (cfg.phases.review.reviewers ?? []).map(
    (r) => t(r.provider) + (r.fallback ?? []).reduce((s, fb) => s + t(fb), 0),
  );
  const slowestChainMs = chains.length ? Math.max(...chains) : 0;
  const criticMs = cfg.phases.critic ? t(cfg.phases.critic.provider) : 0;
  const tailMs = Math.max(
    PANEL_TAIL_RESERVE_MS,
    criticMs > 0 ? criticMs + CRITIC_TAIL_RESERVE_MS : 0,
  );
  const worstMs = slowestChainMs + tailMs;
  const runMs = cfg.loop.runTimeoutMs;
  const fits = runMs <= 0 || worstMs <= runMs;
  return {
    name: "panel budget vs loop.runTimeoutMs",
    status: fits ? "ok" : "warn",
    detail: fits
      ? `worst-case panel ${Math.round(worstMs / 1000)}s fits loop.runTimeoutMs ${Math.round(runMs / 1000)}s`
      : `worst-case panel wall-clock ${Math.round(worstMs / 1000)}s (slowest slot chain ${Math.round(slowestChainMs / 1000)}s + ${Math.round(tailMs / 1000)}s tail: max(panel reserve, critic + critic reserve)) exceeds loop.runTimeoutMs (${Math.round(runMs / 1000)}s) — the gate will budget-clamp instead of timing out: reviews of large diffs get CUT SHORT (reduced quality), late fallbacks and the critic get skipped`,
    ...(fits
      ? {}
      : {
          hint: "Raise loop.runTimeoutMs (and the Stop-hook timeout with it: setup 120s + runTimeoutMs + settle 30s must stay below it), or lower per-provider timeoutMs / shorten fallback chains.",
        }),
  };
}

// The single dependency the hooks rely on but that nothing else checked: can the
// gate shim actually RESOLVE a runnable `reviewgate` binary? The shim runs under
// the (often non-login) PATH the agent-host hook process inherits; a bare
// `exec reviewgate` that isn't on that PATH exits 127 with empty stdout, which
// the host may read as successful — a SILENT no-op gate. `init` now bakes an
// absolute path into the shim and the shim fails closed; this verifies what the
// installed shim will actually invoke. Returns null when the Stop hook isn't
// wired. `runs` is injected for testability (prod probes the real binary).
// Worktree blindness (P8, field report 2026-06-21): Reviewgate arms per-checkout, but a
// git worktree shares only .git — it has NO .reviewgate/ or repo-local host hooks,
// so the Stop gate never fires there and worktree work ends UN-reviewed (fail-open). The
// main checkout's hooks do NOT propagate into a linked worktree. When `doctor` is run INSIDE
// a linked worktree that lacks the reviewgate hooks, FAIL loudly — a silent-OK doctor here
// is exactly the trap. Returns null outside a linked worktree (nothing to check).
export async function worktreeGatedCheck(repoRoot: string): Promise<Check | null> {
  const info = await worktreeInfo(repoRoot);
  if (!info.isLinkedWorktree) return null;
  if (anyHooksInstalled(repoRoot)) {
    return {
      name: "worktree gating",
      status: "ok",
      detail: "inside a git worktree with the Reviewgate hooks installed here",
    };
  }
  return {
    name: "worktree gating",
    status: "fail",
    detail:
      "you are inside a git WORKTREE with NO Reviewgate hooks — the gate is OFF here, so worktree edits end UN-reviewed (fail-open). A worktree shares only .git; the main checkout's hooks do not propagate.",
    hint: "Run `reviewgate init` in this worktree to gate it, or do the work in (or merge to) the gated main checkout.",
  };
}

export function gateBinaryReachableCheck(
  repoRoot: string,
  runs: (bin: string) => boolean = (bin) => {
    try {
      return spawnSync(bin, ["--version"], { timeout: 5000, stdio: "ignore" }).status === 0;
    } catch {
      return false;
    }
  },
): Check | null {
  const name = "gate binary reachable";
  if (!anyHooksInstalled(repoRoot)) return null;

  const shimPath = join(repoRoot, ".reviewgate", "bin", "gate");
  const shimSrc = existsSync(shimPath) ? readFileSync(shimPath, "utf8") : "";
  const resilient = shimSrc.includes("RG_BIN=");
  // The shim assigns RG_BIN='<path>' (single-quoted, with any embedded ' escaped as
  // '\''). Decode that exact shell form rather than a naive regex, which would
  // truncate a path containing a single quote at the first quote boundary.
  const rhs = shimSrc.match(/^RG_BIN=(.*)$/m)?.[1] ?? "";
  const decoded =
    rhs.length >= 2 && rhs.startsWith("'") && rhs.endsWith("'")
      ? rhs.slice(1, -1).split("'\\''").join("'")
      : "";
  const baked = decoded && decoded !== "__REVIEWGATE_BIN__" ? decoded : "";

  const bakedOk = baked !== "" && existsSync(baked) && runs(baked);
  const pathOk = runs("reviewgate");

  if (!bakedOk && !pathOk) {
    return {
      name,
      status: "fail",
      detail:
        "the gate hook cannot resolve a runnable `reviewgate` binary (no baked path, none on PATH) → the Stop gate fails closed and BLOCKS every turn (an old shim would instead silently ALLOW it — a no-op gate)",
      hint: "Put the reviewgate binary on PATH (e.g. symlink dist/reviewgate into ~/.local/bin) or re-run `reviewgate init` with the binary installed, then re-run doctor.",
    };
  }
  if (!resilient) {
    return {
      name,
      status: "warn",
      detail:
        "an OLD hook shim is installed (bare `exec reviewgate`): if `reviewgate` ever leaves the hook's PATH it exits 127 with empty stdout, which the agent host may treat as successful (silent no-op gate)",
      hint: "Re-run `reviewgate init` to install the PATH-resilient, fail-closed shim (baked binary path + block-on-unresolved).",
    };
  }
  if (baked && !bakedOk && pathOk) {
    return {
      name,
      status: "warn",
      detail: `baked path '${baked}' is missing/unrunnable; the shim falls back to 'reviewgate' on PATH`,
      hint: "Re-run `reviewgate init` to re-bake the current binary path into the hooks.",
    };
  }
  return {
    name,
    status: "ok",
    detail: bakedOk ? `baked path runs: ${baked}` : "'reviewgate' resolves on PATH (no baked path)",
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

// Active quota cooldowns: providers reviewgate is currently skipping (straight to
// their fallback) because a prior review hit their usage cap, with the remembered
// reset time. Informational — it auto-resumes once the reset passes.
export function quotaCooldownCheck(repoRoot: string, now: Date): Check | null {
  const active = new QuotaCooldownStore(repoRoot).activeSnapshot(now);
  const entries = Object.entries(active);
  if (entries.length === 0) return null;
  return {
    name: "provider quota cooldown",
    status: "warn",
    detail: `skipping to fallback until reset: ${entries
      .map(([p, t]) => `${p} → ${t}`)
      .join(", ")} (auto-resumes after; no config change)`,
  };
}

export function checkBinary(bin: string, name: string, timeoutMs = 5_000): Check {
  // Doctor is itself a recovery tool, so a wedged provider CLI must not wedge
  // diagnosis indefinitely. Version probes should be near-instant; a bounded
  // failure remains visible in the report and frees the child deterministically.
  const r = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
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
  checks.push(agentHostHooksCheck(input.repoRoot));

  const sb = await checkSandboxHealth();
  checks.push({
    name: `sandbox (${sb.platform})`,
    status: sb.available ? "ok" : "fail",
    detail: sb.detail,
    ...(sb.remediation ? { hint: sb.remediation } : {}),
  });

  try {
    const policy = await controlPlaneStatus(input.repoRoot);
    const pending = policy.state?.pending;
    const missingBaselineIsFatal = !policy.state && anyHooksInstalled(input.repoRoot);
    checks.push({
      name: "gate policy control plane",
      status: !policy.state
        ? missingBaselineIsFatal
          ? "fail"
          : "warn"
        : pending?.classification === "invalid" || pending?.classification === "approval-required"
          ? "fail"
          : pending
            ? "warn"
            : "ok",
      detail: !policy.state
        ? "no last-known-good baseline"
        : pending
          ? `${pending.classification}; approved=${policy.state.approved_effective_fingerprint.slice(0, 12)} candidate=${pending.effective_fingerprint?.slice(0, 12) ?? "invalid"}`
          : `approved ${policy.state.approved_effective_fingerprint.slice(0, 12)}`,
      ...(!policy.state
        ? {
            hint: missingBaselineIsFatal
              ? "Hooks are installed but the LKG is missing. Run `reviewgate config approve` from a TTY."
              : "Run `reviewgate init` to install hooks and record the initial approved policy.",
          }
        : pending?.classification === "approval-required"
          ? {
              hint: "Complete a gate pass under the LKG, then run `reviewgate config approve` from a TTY.",
            }
          : pending?.classification === "invalid"
            ? {
                hint: "Fix reviewgate.config.ts; invalid present config never falls back to defaults.",
              }
            : {}),
    });
  } catch (err) {
    checks.push({
      name: "gate policy control plane",
      status: "fail",
      detail: (err as Error).message,
    });
  }

  const host = detectHostModel({ env: process.env as Record<string, string>, hookStdin: null });
  checks.push({
    name: "host-model detection",
    status: host.source === "fallback:assume-opus" ? "warn" : "ok",
    detail: `agent-host=${host.agentHost} tier=${host.tier} source=${host.source}${host.modelId ? ` model=${host.modelId}` : ""}`,
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
  // cause). A present config that fails to load is a control-plane failure.
  try {
    const cfg = await loadEffectiveConfig({
      cwd: input.repoRoot,
      env: process.env as Record<string, string | undefined>,
      home: homedir(),
    });
    checks.push(reviewersEnabledCheck(cfg));
    const solo = singleReviewerCheck(cfg);
    if (solo) checks.push(solo);
    const ack = acknowledgePassCheck(cfg);
    if (ack) checks.push(ack);
    // gemini → agy is OAuth-only; an apikey auth on the gemini provider is inert.
    const gem = cfg.providers.gemini;
    if (gem?.enabled && gem.auth === "apikey") {
      checks.push({
        name: "gemini auth",
        status: "warn",
        detail: 'gemini runs the agy CLI (OAuth only); auth:"apikey" has no effect — remove it.',
      });
    }
    // Provider availability: CLI providers need their CLI reachable; openrouter
    // needs its CONFIGURED key env var set (defaults to OPENROUTER_API_KEY, but a
    // provider/embeddings config may name a different one). ("claude-code" runs the
    // `claude` CLI.)
    const curatorAvailable: ProviderAvailable = (id, apiKeyEnv) =>
      isProviderAvailable(id, apiKeyEnv);
    const crit = criticCheck(cfg, curatorAvailable);
    if (crit) checks.push(crit);
    const grounding = groundingCheck(cfg, curatorAvailable);
    if (grounding) checks.push(grounding);
    const emb = brainEmbeddingsCheck(cfg, curatorAvailable);
    if (emb) checks.push(emb);
    const mem = await brainMemoryCheck(input.repoRoot, cfg);
    if (mem) checks.push(mem);
    const rep = await reputationCheck(input.repoRoot, cfg);
    if (rep) checks.push(rep);
    const cur = curatorCheck(cfg, curatorAvailable);
    if (cur) checks.push(cur);
    const lc = loreCheck(input.repoRoot, cfg);
    if (lc) checks.push(lc);
    const cd = contextDocsCheck(cfg, process.env as Record<string, string | undefined>);
    if (cd) checks.push(cd);
    const fb = fallbackChainCheck(cfg, curatorAvailable);
    if (fb) checks.push(fb);
    const ht = hookTimeoutCheck(input.repoRoot, cfg);
    if (ht) checks.push(ht);
    checks.push(panelBudgetCheck(cfg));
    const gb = gateBinaryReachableCheck(input.repoRoot);
    if (gb) checks.push(gb);
    const sbMode = cfg.sandbox.mode;
    if (sbMode !== "off") {
      const ok = await sandboxRuntimeAvailable();
      checks.push({
        name: "sandbox isolation",
        status: ok ? "ok" : sbMode === "strict" ? "fail" : "warn",
        detail: ok
          ? `OS sandbox available (mode=${sbMode})`
          : `OS sandbox unavailable — mode=${sbMode} will ${sbMode === "strict" ? "REFUSE to review (fail closed)" : "run reviewers UNISOLATED"}`,
      });
    }
  } catch (e) {
    checks.push({
      name: "reviewgate.config.ts load",
      status: "fail",
      detail: `failed to load — the gate will keep using its LKG and block adoption: ${(e as Error).message}`,
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

  // Worktree blindness (P8): loud FAIL when run inside an un-gated linked worktree.
  // Outside the config try so it surfaces even when reviewgate.config.ts fails to load.
  const wt = await worktreeGatedCheck(input.repoRoot);
  if (wt) checks.push(wt);

  // Active quota cooldowns (remembered reset time → auto-skip to fallback).
  const cd = quotaCooldownCheck(input.repoRoot, new Date());
  if (cd) checks.push(cd);

  // Optional reviewer CLIs (M2). These are only needed if enabled in config;
  // report as warn (not fail) when absent so codex-only setups stay green.
  for (const [bin, name] of [
    ["agy", "Antigravity CLI agy (gemini reviewer; gemini CLI sunsets 2026-06-18)"],
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

  return doctorExitCode(checks);
}
