// src/cli/commands/review-plan.ts
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { ulid } from "ulid";
import { loadEffectiveConfig } from "../../config/global.ts";
import { Orchestrator } from "../../core/orchestrator.ts";
import type { ProviderAdapter } from "../../providers/adapter-base.ts";
import type { ProviderId } from "../../providers/registry.ts";
import { collectGitInfo } from "../../utils/git.ts";
import { detectHostModel } from "../../utils/host-model.ts";
import { planReviewMdPath } from "../../utils/paths.ts";
import { buildAdapters } from "../build-adapters.ts";

export interface ReviewPlanInput {
  repoRoot: string;
  files: string[];
  providerOverrides?: Partial<Record<ProviderId, ProviderAdapter>>;
  sandboxModeOverride?: "strict" | "permissive" | "off";
}

export interface ReviewPlanOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Normalize a user path to repo-relative. Reject paths that escape the repo —
// git diff --no-index on an absolute/escaping path emits non-repo-relative
// headers and broken findings.
function toRepoRelative(repoRoot: string, file: string): { rel: string } | { error: string } {
  const abs = resolve(repoRoot, file);
  const rel = relative(repoRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { error: `path is outside the repository: ${file}` };
  }
  if (!existsSync(abs)) {
    return { error: `file not found: ${file}` };
  }
  return { rel };
}

// Synthesize a full-content diff for a single file via `git diff --no-index`.
// Exit code 1 means "differences exist" (always true vs /dev/null) — success.
function synthDiff(repoRoot: string, rel: string): { diff: string } | { error: string } {
  const r = spawnSync("git", ["diff", "--no-color", "--no-index", "/dev/null", rel], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (r.status !== null && r.status > 1) {
    return { error: `git diff failed for ${rel}: ${r.stderr ?? ""}` };
  }
  const out = r.stdout ?? "";
  if (out.includes("Binary files")) {
    return { error: `cannot review binary file: ${rel}` };
  }
  if (!out.trim()) {
    return { error: `no content to review in ${rel}` };
  }
  return { diff: out };
}

export async function runReviewPlan(input: ReviewPlanInput): Promise<ReviewPlanOutput> {
  if (input.files.length === 0) {
    return { exitCode: 2, stdout: "", stderr: "review-plan: no files given\n" };
  }
  const cfg = await loadEffectiveConfig({
    cwd: input.repoRoot,
    env: process.env as Record<string, string | undefined>,
    home: homedir(),
  });

  const diffs: string[] = [];
  for (const f of input.files) {
    const norm = toRepoRelative(input.repoRoot, f);
    if ("error" in norm) return { exitCode: 2, stdout: "", stderr: `review-plan: ${norm.error}\n` };
    const d = synthDiff(input.repoRoot, norm.rel);
    if ("error" in d) return { exitCode: 2, stdout: "", stderr: `review-plan: ${d.error}\n` };
    diffs.push(d.diff);
  }
  const diff = diffs.join("\n");

  // review-plan forces every reviewer to cfg.docReview.persona (see forcePersona
  // below) → pass it so the cassette reviewerId-uniqueness check uses the effective
  // (forced) persona, catching same-provider reviewers that collapse onto one id.
  const adapters = buildAdapters(cfg, input.providerOverrides, undefined, cfg.docReview.persona);

  const host = detectHostModel({ env: process.env as Record<string, string>, hookStdin: null });
  const gitInfo = collectGitInfo(input.repoRoot);
  const orchestrator = new Orchestrator({
    repoRoot: input.repoRoot,
    config: cfg,
    adapters,
    sandboxMode: input.sandboxModeOverride ?? cfg.sandbox.mode,
    hostTier: host.tier,
    diff,
    gitInfo,
    reasonOnFailEnabled: true,
    forcePersona: cfg.docReview.persona,
    reportMode: "one-shot",
  });

  const result = await orchestrator.runIteration({ runId: ulid(), iter: 1 });

  let report = "";
  try {
    report = readFileSync(planReviewMdPath(input.repoRoot), "utf8");
  } catch {
    report = "";
  }
  const pass = result.verdict === "PASS" || result.verdict === "SOFT-PASS";
  const summary = `\nReviewgate review-plan: ${result.verdict}\n`;
  return {
    exitCode: pass ? 0 : 1,
    stdout: `${report}${summary}`,
    stderr:
      result.verdict === "ERROR" ? "review-plan: reviewer error (no reviewer completed)\n" : "",
  };
}
