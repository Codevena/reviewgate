// src/core/report-writer.ts
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { neutralizeFences, neutralizeInjectionMarkers } from "../diff/sanitizer.ts";
import type { Finding } from "../schemas/finding.ts";
import type { PendingReport } from "../schemas/pending-report.ts";
import type { EscalationReason } from "../schemas/state.ts";
import { writeFileAtomic } from "../utils/atomic-write.ts";
import {
  escalationMdPath,
  pendingJsonPath,
  pendingMdPath,
  planReviewJsonPath,
  planReviewMdPath,
} from "../utils/paths.ts";

function ensureDir(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// Visual cue for cross-reviewer consensus, next to the severity marker, so an
// agent skims "is this lone or corroborated?" without reading the metadata line:
// ⚪ singleton/minority (weak signal — scrutinize), 🟡 majority (solid),
// 🟢 unanimous (all reviewers agree — highest confidence).
function consensusEmoji(c: Finding["consensus"]): string {
  if (c === "unanimous") return "🟢";
  if (c === "majority") return "🟡";
  return "⚪"; // singleton or minority
}

// Building finding badges: the hard-block 🔒 deterministic badge (for findings
// from the deterministic checker tier) AND the demote/suppression badges (scope,
// FP-ledger, critic, reputation, …). Builds a blockquote line ONLY when at
// least one flag applies — so clean findings render no extra noise. Lets the
// agent see at a glance whether a finding is a non-rejectable hard-block or
// was flagged as lower-confidence by the system.
export function findingBadges(f: Finding): string | null {
  const badges: string[] = [];
  if (f.deterministic)
    badges.push("🔒 deterministic check — fix it (re-runs automatically; not rejectable)");
  if (f.fact_invalid) badges.push("🔎 cited location not found — likely hallucinated");
  if (f.grounding_demoted) badges.push("🌫 cited token absent from corpus — likely fabricated");
  if (f.scope_demoted) badges.push("📍 outside changed lines");
  if (f.redaction_demoted)
    badges.push(
      "🙈 targets a <REDACTED:…> placeholder (stripped secret, not real code) — advisory",
    );
  if (f.critic_verdict === "likely_fp") badges.push("🧠 critic flagged as likely FP");
  if (f.fp_ledger_match?.suppressed) badges.push("📒 matches known-FP pattern");
  if (f.fp_cluster_match?.suppressed)
    badges.push(`📚 active FP cluster ${f.fp_cluster_match.cluster_key}`);
  if (f.low_confidence) badges.push("🎯 below confidence floor");
  if (f.reputation_demoted) badges.push("📉 reviewer reputation low");
  if (f.claimed_fixed_recurred)
    // A pinned recurrence that survived the demote chain (CRITICAL/WARN) is blocking →
    // assert the fix failed. One that was scope/fp-demoted to advisory INFO recurred but
    // is out-of-scope or a known FP, so soften the wording (claiming "did not resolve it"
    // on a non-blocking out-of-diff recurrence would mislead).
    badges.push(
      f.severity === "INFO"
        ? `⚠ claimed fixed @ iter ${f.claimed_fixed_recurred.iter} — recurred (advisory: out of scope or known FP)`
        : `⚠ claimed fixed @ iter ${f.claimed_fixed_recurred.iter} — still present; the fix did not resolve it`,
    );
  return badges.length === 0 ? null : `> ${badges.join("  ·  ")}`;
}

function fmtFinding(f: Finding): string {
  const sym = f.severity === "CRITICAL" ? "●" : f.severity === "WARN" ? "▲" : "·";
  const consEmoji = consensusEmoji(f.consensus);
  const confirmed =
    f.confirmed_by && f.confirmed_by.length > 1
      ? ` (confirmed by ${f.confirmed_by.join(", ")})`
      : "";
  // Show a range (line_start-line_end) for multi-line findings, plain line otherwise.
  const loc = f.line_end > f.line_start ? `${f.line_start}-${f.line_end}` : `${f.line_start}`;
  const badges = findingBadges(f);
  // Honesty at panel size 1: a "singleton" finding is ONE model's opinion, however
  // confidently phrased. Qualify it so the agent never reads `Confidence: 1.00` as
  // corroborated certainty (both 2026-06-05 field reports flagged this as a
  // trust-killer). Corroborated findings (majority/unanimous) keep the bare number.
  const consNote = f.consensus === "singleton" ? " (single reviewer, uncorroborated)" : "";
  // The reviewer-supplied free text (message/details/suggested_fix) is untrusted
  // LLM output rendered into pending.md, which the AGENT then reads with its Read
  // tool — defang injection markers (zero-width space keeps it human-readable, does
  // NOT destroy meaning) so a hallucinated finding can't smuggle directives into the
  // agent's context. suggested_fix is wrapped in a ``` fence → also collapse fences.
  const message = neutralizeInjectionMarkers(f.message);
  const details = neutralizeInjectionMarkers(f.details);
  const suggestedFix = f.suggested_fix
    ? neutralizeFences(neutralizeInjectionMarkers(f.suggested_fix))
    : undefined;
  return [
    `### ${f.id}  ${sym} ${f.severity} ${consEmoji}  ·  ${f.file}:${loc}  ·  ${f.rule_id}`,
    `**Category:** ${f.category}  ·  **Consensus:** ${f.consensus}  ·  **Confidence:** ${f.confidence.toFixed(2)}${consNote}${confirmed}`,
    ...(badges ? [badges] : []),
    "",
    message,
    "",
    details,
    suggestedFix ? `\n**Suggested fix:**\n\`\`\`\n${suggestedFix}\n\`\`\`` : "",
    "",
  ].join("\n");
}

function renderMd(r: PendingReport, mode: "gate" | "one-shot"): string {
  // Coverage warning: any reviewer that didn't finish OK (timeout/error/etc.)
  // reduces how many independent reviewers actually saw this diff. Surface it
  // prominently — a silently degraded panel could let a PASS through with less
  // scrutiny than configured.
  const degraded = r.reviewers.filter((x) => x.status !== "ok");
  // Render the captured stderr reason (one line, trimmed) next to each degraded
  // reviewer so a failure is self-explanatory in the report — without it a bare
  // "gemini: error" forces the agent to go spelunking for WHY (quota? auth? a
  // bad model id?). status_detail is persisted in pending.json but was never
  // shown here before.
  const degradedDetail = (x: PendingReport["reviewers"][number]): string => {
    const reason = x.status_detail
      ?.split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim();
    // status_detail is captured reviewer stderr (untrusted) rendered into pending.md
    // for the agent to read — defang injection markers so a crafted error line can't
    // smuggle directives into the agent's context.
    return reason
      ? `${x.id}: ${x.status} — ${neutralizeInjectionMarkers(reason.slice(0, 160))}`
      : `${x.id}: ${x.status}`;
  };
  const coverageBanner =
    degraded.length > 0
      ? [
          `> ⚠ **Reduced coverage:** ${degraded.length} of ${r.reviewers.length} reviewers did not complete (${degraded
            .map(degradedDetail)
            .join(
              "; ",
            )}). This verdict is based on the ${r.reviewers.length - degraded.length} reviewer(s) that finished.`,
          "",
        ]
      : [];
  // Honesty banner: when only ONE reviewer actually finished OK, the entire
  // self-correction design (cross-reviewer consensus, FP-ledger promotion,
  // reputation demote) is INERT — a lone hallucination has nothing to refute it.
  // Surface this even on a CLEAN single-reviewer run (the coverage banner above only
  // fires when a reviewer FAILED), so the agent treats lone findings as one opinion.
  const okReviewers = r.reviewers.filter((x) => x.status === "ok");
  const singleReviewerBanner =
    degraded.length === 0 && okReviewers.length === 1
      ? [
          `> ℹ️ **Single effective reviewer** (${okReviewers[0]?.id}): with one reviewer, consensus, FP-ledger promotion and reputation-demote are all inert. Treat any lone CRITICAL/WARN as one model's opinion — verify the cited code yourself before acting.`,
          "",
        ]
      : [];
  const actions =
    mode === "one-shot"
      ? []
      : [
          "## Required actions",
          "",
          `For each CRITICAL/WARN finding below, append ONE line to \`.reviewgate/decisions/${r.iter}.jsonl\` (Advisory findings need NO decision):`,
          '- `{"schema":"reviewgate.decision.v1","finding_id":"F-XYZ","verdict":"accepted","action":"fixed","files_touched":[...]}`',
          '- `{"schema":"reviewgate.decision.v1","finding_id":"F-XYZ","verdict":"rejected","reason":"...","reviewer_was_wrong":true}`',
          '- For a cosmetic WARN nit you won\'t fix (NOT security/correctness, NOT CRITICAL): `{"schema":"reviewgate.decision.v1","finding_id":"F-XYZ","verdict":"accepted","action":"acknowledged-low-value"}` — do NOT use this to wave away a real bug.',
          "",
          "Reviewgate refuses to unblock until every CRITICAL/WARN finding ID has a decision.",
          "",
        ];
  const head = [
    `# Reviewgate Report — iteration ${r.iter} of ${r.max_iter}`,
    "",
    `**Verdict:** ${r.verdict}  ·  ${r.counts.critical} CRITICAL · ${r.counts.warn} WARN · ${r.counts.info} INFO`,
    `**Reviewers:** ${r.reviewers.map((x) => `${x.id} (${x.status})`).join(" · ")}`,
    `**Cost:** $${r.cost_usd_total.toFixed(2)}  ·  **Duration:** ${(r.duration_ms_total / 1000).toFixed(1)}s  ·  **Git:** ${r.git.branch}@${r.git.sha.slice(0, 7)}`,
    "",
    ...coverageBanner,
    ...singleReviewerBanner,
    ...(r.panel_note ? [`> ⛔ **Panel:** ${r.panel_note}`, ""] : []),
    ...actions,
    "---",
    "",
  ].join("\n");

  // Advisory = INFO, or anything the aggregator demoted (scope_demoted) / the
  // FP-ledger suppressed. These need no decision (the decisions-gate ignores
  // them); render them in a separate section so the agent doesn't re-reject them.
  const isAdvisory = (f: Finding) =>
    f.severity === "INFO" ||
    f.scope_demoted === true ||
    f.fp_ledger_match?.suppressed === true ||
    f.fp_cluster_match?.suppressed === true;
  const blocking = r.findings.filter((f) => !isAdvisory(f));
  const advisory = r.findings.filter(isAdvisory);

  const sections: string[] = [];
  const crit = blocking.filter((f) => f.severity === "CRITICAL");
  const warn = blocking.filter((f) => f.severity === "WARN");
  if (crit.length > 0) sections.push("## CRITICAL ●\n", ...crit.map(fmtFinding));
  if (warn.length > 0) sections.push("## WARN ▲\n", ...warn.map(fmtFinding));
  if (advisory.length > 0) {
    sections.push(
      "## Advisory (out of scope / known FP — no decision needed) ·\n",
      ...advisory.map(fmtFinding),
    );
    // Optional learn-loop hint — only emitted in the agent-loop mode (NOT in
    // one-shot review-plan reports). Advisory findings carry no gating
    // semantics, but if the agent notices a reviewer hallucinated one, a
    // single optional decision line teaches the FP-ledger + reputation. The
    // signal would otherwise be lost: pre-this-hint a "F-XYZ halluziniert"
    // observation in chat just dies because INFO requires no decision.
    if (mode !== "one-shot") {
      sections.push(
        "### Optional: train Reviewgate on advisory hallucinations\n",
        "If you identify any advisory finding above as a reviewer hallucination, you may optionally write a decision line — it feeds the FP-ledger and reviewer reputation. No gating effect either way. `reason` must be ≥20 characters explaining why the reviewer was wrong:\n",
        '- `{"schema":"reviewgate.decision.v1","finding_id":"F-XYZ","verdict":"rejected","reason":"...","reviewer_was_wrong":true}`\n',
      );
    }
  }

  return head + sections.join("\n");
}

export interface EscalationInput {
  runId: string;
  iter: number;
  maxIter: number;
  reasonCode: EscalationReason;
  summary: string;
  perIter: Array<{
    iter: number;
    verdict: string;
    crit: number;
    warn: number;
    costUsd: number;
    findings: number;
  }>;
  topFindings: Finding[];
  // N4: per-finding disposition from the latest decisions/<iter>.jsonl, keyed by
  // finding id. The gate escalates as a PRECONDITION (before a new iteration), so
  // pending.json holds the PRIOR iteration's raw findings — but the agent has often
  // already addressed/rejected them. Joining the decisions here makes the report show
  // the CURRENT state instead of a stale "all open" snapshot. Absent id → "open".
  findingStatus?: Record<string, { state: "addressed" | "rejected" | "open"; reason?: string }>;
  triggeredAt: string;
}

// N4: render a finding with its post-decision status badge inserted right after the
// `### <id> …` header line, so the human reads whether each finding is still live.
function fmtFindingWithStatus(
  f: Finding,
  st: { state: "addressed" | "rejected" | "open"; reason?: string } | undefined,
): string {
  const base = fmtFinding(f);
  const state = st?.state ?? "open";
  const badge =
    state === "addressed"
      ? "✓ addressed"
      : state === "rejected"
        ? `✗ rejected${st?.reason ? `: ${st.reason}` : ""}`
        : "● open";
  const nl = base.indexOf("\n");
  if (nl < 0) return `${base}\n**Decision status:** ${badge}`;
  return `${base.slice(0, nl)}\n**Decision status:** ${badge}${base.slice(nl)}`;
}

export class ReportWriter {
  constructor(private readonly repoRoot: string) {}

  async write(report: PendingReport, opts?: { mode?: "gate" | "one-shot" }): Promise<void> {
    const mode = opts?.mode ?? "gate";
    // One-shot reviews write to their OWN files so they never clobber the gate's
    // pending.md/json (which the Stop-hook decisions loop reads).
    const md = mode === "one-shot" ? planReviewMdPath(this.repoRoot) : pendingMdPath(this.repoRoot);
    const json =
      mode === "one-shot" ? planReviewJsonPath(this.repoRoot) : pendingJsonPath(this.repoRoot);
    ensureDir(md);
    // Atomic tmp+rename: pending.{md,json} are read cross-process by the Stop-hook
    // decisions loop — a non-atomic writeFileSync could expose a half-written file.
    writeFileAtomic(md, renderMd(report, mode), { mode: 0o600 });
    writeFileAtomic(json, JSON.stringify(report, null, 2), { mode: 0o600 });
  }

  async writeEscalation(input: EscalationInput): Promise<void> {
    const p = escalationMdPath(this.repoRoot);
    ensureDir(p);
    const rows = input.perIter
      .map(
        (r) =>
          `| ${r.iter}    | ${r.verdict.padEnd(4)}    | ${r.crit}    | ${r.warn}    | $${r.costUsd.toFixed(2).padStart(5)} | ${r.findings}        |`,
      )
      .join("\n");
    // N4: bucket each finding by its post-decision status, sort OPEN-first (live
    // issues the human must still act on lead), then render with a status badge.
    const status = input.findingStatus ?? {};
    const stateOf = (f: Finding) => status[f.id]?.state ?? "open";
    const rank = (s: "open" | "rejected" | "addressed") =>
      s === "open" ? 0 : s === "rejected" ? 1 : 2;
    const ordered = input.topFindings
      .map((f, i) => ({ f, i }))
      .sort((a, b) => rank(stateOf(a.f)) - rank(stateOf(b.f)) || a.i - b.i)
      .map(({ f }) => f);
    const counts = { open: 0, addressed: 0, rejected: 0 };
    for (const f of input.topFindings) counts[stateOf(f)] += 1;
    const top = ordered
      .slice(0, 5)
      .map((f) => fmtFindingWithStatus(f, status[f.id]))
      .join("\n");
    const out = [
      "# Reviewgate Escalation",
      "",
      `**Session:** ${input.runId}  ·  **Iteration:** ${input.iter}/${input.maxIter}  ·  **Verdict:** ESCALATED`,
      `**Reason code:** ${input.reasonCode}`,
      `**Triggered at:** ${input.triggeredAt}`,
      "",
      "## Summary",
      input.summary,
      "",
      "## Final findings (status after the latest decisions)",
      `_${counts.open} open · ${counts.addressed} addressed · ${counts.rejected} rejected_`,
      "",
      top,
      "",
      "## Per-iteration history",
      "| Iter | Verdict | CRIT | WARN | Cost   | Findings |",
      "|------|---------|------|------|--------|----------|",
      rows,
      "",
      "## Suggested human actions",
      "- Review the listed findings yourself before committing.",
      "- To make a finding a sticky known-false-positive: find its id with `reviewgate fp list`, then `reviewgate fp pin --id <FP-id>`.",
      "- If the panel diverges from your intent systematically, edit `reviewgate.config.ts` (e.g. adjust reviewers/personas) and run `reviewgate doctor` to validate.",
    ].join("\n");
    // Atomic tmp+rename: ESCALATION.md may be read cross-process while written.
    writeFileAtomic(p, out, { mode: 0o600 });
  }
}
