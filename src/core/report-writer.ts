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
import { PROTECT_MIN_DECISIONS, lowPrecisionAdvisory } from "./provider-precision.ts";

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
  if (f.hypothetical_demoted)
    badges.push(
      "⏳ demoted CRITICAL→WARN — reviewer text is hypothetical/future, not a present defect",
    );
  // G0 (field report 2026-06-21): a finding a VALUE-JUDGMENT demoter lowered from a CRITICAL stays
  // decision-required on SOFT-PASS (it does NOT silently re-arm). Render only while still blocking
  // (CRITICAL/WARN): an INFO one was further suppressed by a structural/agent off-ramp (e.g. the
  // reject → cycleRejected path) and no longer needs a decision, so the prompt would mislead.
  if (f.demoted_from_critical && f.severity !== "INFO")
    badges.push(
      "⬇ was CRITICAL, one-step-demoted — decide before passing (don't reflexively acknowledge)",
    );
  if (f.scope_demoted) badges.push("📍 outside changed lines");
  // Slice A (P1): on a file this session did not author — advisory (parallel agent / pre-existing).
  if (f.foreign_to_session)
    badges.push(
      "👥 on a file this session did not edit (parallel agent / pre-existing) — advisory; if it truly isn't yours, record an out-of-scope decision",
    );
  if (f.test_severity_demoted) badges.push("📁 security finding on a test/fixture file — advisory");
  // Slice D (P5): a CRITICAL on a docs/markdown file capped to WARN (stale doc ≠ data-loss bug).
  if (f.docs_severity_capped)
    badges.push("📝 docs file — capped CRITICAL→WARN; still decide before passing");
  // Slice C (P4): a lone uncorroborated CRITICAL — honest framing, NOT a downgrade (still blocks).
  if (f.lone_critical_uncorroborated)
    badges.push(
      "🚧 lone CRITICAL — single reviewer, uncorroborated; verify the cited code yourself, then fix (action:fixed) or reject (reviewer_was_wrong) with a concrete reason",
    );
  if (f.redaction_demoted)
    badges.push(
      "🙈 targets a <REDACTED:…> placeholder (stripped secret, not real code) — advisory",
    );
  if (f.location_recurred)
    badges.push(
      "🔁 this region was raised in an earlier iteration this cycle — verify it is a genuinely NEW issue before re-fixing (possible reviewer contradiction)",
    );
  if (f.stable_code)
    badges.push(
      "↔ on code you haven't edited this cycle (unchanged across the loop) — scrutinize whether this is genuinely new or reviewer non-determinism",
    );
  if (f.rule_citation_unverified)
    badges.push(
      "📜 asserts a project/house rule without a file:line citation — verify the rule exists",
    );
  // S4 (field report 2026-06-23): the reviewer's self-quoted evidence line is not in the cited file
  // → likely reasoned on stale/absent context (the moot lone-CRITICAL class). Render-only advisory.
  if (f.evidence_mismatch)
    badges.push(
      "🔎 the line this finding cites as evidence is not present in the file — likely reasoned on stale or absent context; verify the cited code yourself before acting",
    );
  if (f.critic_verdict === "likely_fp") badges.push("🧠 critic flagged as likely FP");
  if (f.fp_ledger_match?.suppressed) badges.push("📒 matches known-FP pattern");
  if (f.fp_cluster_match?.suppressed)
    badges.push(`📚 active FP cluster ${f.fp_cluster_match.cluster_key}`);
  if (f.low_confidence) badges.push("🎯 below confidence floor");
  // #4: only assert "kept blocking" while the finding IS still blocking. The protect flag is
  // stamped in the critic pass BEFORE the hard suppressors (scopeToDiff/fpActive/cycleRejected)
  // run; if one of them later demotes this finding to advisory INFO, the "kept blocking" badge
  // would be a lie (codex DoD) — so gate it on a non-INFO severity.
  if (f.protected_high_precision && f.severity !== "INFO")
    badges.push("🛡 kept blocking — high-track-record reviewer (soft demote overridden)");
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
  // P1 (field report 2026-06-21): a GATING (CRITICAL/WARN) finding raised SOLELY by
  // low-precision reviewer(s) gets a loud up-front advisory so the agent verifies it cheaply
  // before an expensive caller sweep. Render-only — severity/verdict unchanged; a
  // high-precision corroborator clears it. (Demoting it would fail open under the default
  // soft-pass policy, so we annotate rather than demote.)
  if (f.severity !== "INFO") {
    const adv = lowPrecisionAdvisory(f);
    if (adv) badges.push(`⚠ ${adv}`);
  }
  return badges.length === 0 ? null : `> ${badges.join("  ·  ")}`;
}

// #8 bundling (field report 2026-06-17): when the aggregator folds findings of >1 category
// under one representative, the agent must disposition ALL folded concerns with one decision.
// The aggregator already appends a "merges concerns categorized as: …" sentence to details;
// this turns that buried prose into an explicit, scannable checklist of the distinct concerns
// (category · rule_id · provider), so the agent can tick each off. Render-only — the merge,
// verdict and decision-fold accounting are unchanged (one finding_id still dispositions all).
function renderFoldedConcerns(f: Finding): string | null {
  const members = f.members ?? [];
  const cats = new Set<string>([f.category, ...members.map((m) => m.category)]);
  if (cats.size <= 1 || members.length === 0) return null;
  const seen = new Set<string>();
  const items: string[] = [];
  const add = (category: string, ruleId: string, provider: string) => {
    const key = `${category}::${ruleId}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(
      `- **${category}** · \`${neutralizeInjectionMarkers(ruleId)}\` (reported by ${neutralizeInjectionMarkers(provider)})`,
    );
  };
  add(f.category, f.rule_id, f.reviewer.provider);
  for (const m of members) add(m.category, m.rule_id, m.provider);
  if (items.length <= 1) return null;
  return [
    "**Folded concerns — one decision on this finding dispositions ALL of them:**",
    ...items,
  ].join("\n");
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
  // #8: advisory per-provider precision (pure metadata; never affects the verdict).
  // Rendered as a metadata line, NOT a badge — a badge would imply a demote happened.
  const precisionLine =
    f.reviewer_precision && f.reviewer_precision.length > 0
      ? `**Reviewer track record:** ${f.reviewer_precision
          .map(
            (p) =>
              `${p.provider} ${p.precision === null ? "n/a" : `${Math.round(p.precision * 100)}%`} (${p.tp} TP / ${p.fp} FP)`,
          )
          .join(" · ")}`
      : null;
  const foldedConcerns = renderFoldedConcerns(f);
  return [
    `### ${f.id}  ${sym} ${f.severity} ${consEmoji}  ·  ${f.file}:${loc}  ·  ${f.rule_id}`,
    `**Category:** ${f.category}  ·  **Consensus:** ${f.consensus}  ·  **Confidence:** ${f.confidence.toFixed(2)}${consNote}${confirmed}`,
    ...(precisionLine ? [precisionLine] : []),
    ...(badges ? [badges] : []),
    "",
    message,
    "",
    details,
    ...(foldedConcerns ? ["", foldedConcerns] : []),
    suggestedFix ? `\n**Suggested fix:**\n\`\`\`\n${suggestedFix}\n\`\`\`` : "",
    "",
  ].join("\n");
}

// #3/#5: a reviewer is "low track record" for the collapse heuristic at precision below
// this floor (the field report's 29%-precision reviewer is well under it). Render-only — it
// only changes WHERE a note renders (collapsed block vs inline), never WHETHER it renders.
const LOW_TRACK_RECORD_PRECISION = 0.4;
// Cold-start / exploration budget (flashbuddy peer-review watch-item #1): a reviewer only
// becomes collapse-eligible once it is CALIBRATED — i.e. it has the SAME minimum number of
// decisions the #4 protect path requires (PROTECT_MIN_DECISIONS). Below that, all its findings
// surface in full so a new-but-correct reviewer can bootstrap a track record instead of being
// pre-emptively folded on a noisy first few calls. Sharing the protect threshold keeps a single
// "is this reviewer calibrated?" definition for both the low-trust collapse and the high-trust
// protect (symmetric: < floor ⇒ collapse, ≥ high-water ⇒ protect, in between ⇒ neither).
const COLLAPSE_MIN_DECISIONS = PROTECT_MIN_DECISIONS;

// #3/#5 (field report 2026-06-17): a solo, low-track-record, non-security/correctness INFO is
// noise the agent must mentally filter (the 29%-precision openrouter flood). Fold these into a
// collapsed block so they stay present (never dropped) but don't dilute the in-scope advisory
// list. Keys off the #8 reviewer_precision cell already attached to the finding.
function isLowTrustSoloInfo(f: Finding): boolean {
  if (f.severity !== "INFO") return false;
  if (f.consensus !== "singleton" && f.consensus !== "minority") return false;
  // Never collapse a security/correctness note, even uncorroborated INFO.
  if (f.category === "security" || f.category === "correctness") return false;
  if ((f.members ?? []).some((m) => m.category === "security" || m.category === "correctness")) {
    return false;
  }
  const cells = f.reviewer_precision ?? [];
  // Require a CALIBRATED track record (≥ COLLAPSE_MIN_DECISIONS samples) before collapsing —
  // a reviewer still inside its exploration budget surfaces in full (watch-item #1).
  return cells.some(
    (c) =>
      c.precision !== null &&
      c.precision < LOW_TRACK_RECORD_PRECISION &&
      c.tp + c.fp >= COLLAPSE_MIN_DECISIONS,
  );
}

function renderMd(r: PendingReport, mode: "gate" | "one-shot", collapseLowTrust = true): string {
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
  // Slice 3 (field report #6): large-diff warning. The matching stderr warning is emitted
  // in gate.ts (outside the loop self-deadline, so it survives a timeout-abort that writes
  // no report); this banner is the in-report copy with the remediation.
  const largeDiffBanner = r.large_diff
    ? [
        `> ⚠ **Large diff:** ${r.large_diff.files} files / ${Math.round(
          r.large_diff.bytes / 1000,
        )} KB. If the review times out, raise \`loop.runTimeoutMs\` in \`reviewgate.config.ts\` AND the Stop-hook \`timeout\` in \`.claude/settings.json\` — both, or the OS kills the hook before Reviewgate's deadline and the turn ends un-reviewed (fail-open).`,
        "",
      ]
    : [];
  // #7: workspace-not-quiescent warning (the settle-check hit its cap). Advisory.
  const unsettledBanner = r.workspace_unsettled
    ? [
        `> ⚠ **Workspace not quiescent:** a file was still being written ~${r.workspace_unsettled.last_write_ms_ago}ms before this review (waited ${r.workspace_unsettled.waited_ms}ms for it to settle). This review may reflect a HALF-FINISHED state — if findings look spurious, let the writer (a background build/codegen or a parallel session) finish, then re-run.`,
        "",
      ]
    : [];
  // P11: a PURE docs-only review (every changed file is prose/markdown) — frame it as a
  // spec/docs review so a prose finding (e.g. a framework misread in a design doc) reads with
  // prose-review weight, not code-review CRITICAL weight. Render-only; the verdict is unchanged.
  const docsReviewBanner = r.docs_review
    ? [
        "> 📄 **Spec / docs review** (prose, not code): every changed file is documentation. Findings are about the PROSE — verify any framework/library attribution before treating a finding as blocking, and don't expect typecheck/lint to apply. The verdict/severity are unchanged.",
        "",
      ]
    : [];
  // #4: advisory hint when a false-positive class is fragmenting on a file but not
  // auto-suppressing — recommend a house rule (the durable fix).
  // file + rule_ids are reviewer-SUPPLIED (stored verbatim in the FP-ledger), so
  // neutralize injection markers like fmtFinding does for message/details.
  const fragmentationBanner = (r.fp_fragmentation ?? []).flatMap((f) => {
    const file = neutralizeInjectionMarkers(f.file);
    const ruleIds = f.sample_rule_ids
      .map((id) => `\`${neutralizeInjectionMarkers(id)}\``)
      .join(", ");
    // P2 (field report 2026-06-21): an auto-suppressor for these recurring classes can't be
    // made fail-safe (it would hide a future real finding), so the durable fix stays the
    // explicit house rule — but emit it as a PASTE-READY snippet so it's one copy-paste, not
    // a per-run "go configure it yourself" chore. Reviewer-supplied file/rule_ids are embedded
    // inside a TS string literal here, so strip quotes/backticks/newlines (beyond the injection
    // neutralize) so a hostile name can't break the snippet's syntax.
    const snippetSafe = (s: string) =>
      neutralizeInjectionMarkers(s)
        .replace(/[`"\\\r\n]+/g, " ")
        .trim();
    const fileLit = snippetSafe(f.file);
    const ruleIdsLit = f.sample_rule_ids.map(snippetSafe).join(", ");
    return [
      `> ⚠ **Fragmenting false-positive class:** \`${file}\` has ${f.distinct_signatures} distinct rejected-FP findings (e.g. ${ruleIds}; ${f.total_rejects} rejects) that aren't promoting to auto-suppression (fragmented rule_ids / single reviewer). The durable, fail-safe fix is a **house rule** asserting the repo's ground truth — it suppresses the class AT THE SOURCE (the reviewer stops hallucinating it) and invalidates cached verdicts. Paste this into \`reviewgate.config.ts\` and replace the placeholder with the real ground truth:`,
      "",
      "```ts",
      "// reviewgate.config.ts",
      "export default {",
      "  phases: { review: { houseRules: [",
      `    "In ${fileLit}: <state the repo's ground truth here> — reviewers keep flagging ${ruleIdsLit} as false positives.",`,
      "  ] } },",
      "};",
      "```",
      "",
    ];
  });
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
          '- For a VALID concern you VERIFIED does not apply here (the reviewer was right to raise it, but you checked — e.g. against prod — and it\'s moot; allowed even on CRITICAL/security): `{"schema":"reviewgate.decision.v1","finding_id":"F-XYZ","verdict":"accepted","action":"verified-not-applicable","reason":"the verification evidence, >=20 chars"}` — the reason is REQUIRED; this is reputation-NEUTRAL and is NOT an FP claim (don\'t use reviewer_was_wrong when the reviewer wasn\'t wrong).',
          "",
          "Reviewgate refuses to unblock until every CRITICAL/WARN finding ID has a decision.",
          "",
          // #5: converging off-ramp — surfaced once the loop is iterating, to break the
          // treadmill where re-editing spawns fresh reviews instead of converging.
          ...(r.iter >= 2
            ? [
                `> ⤷ **Converging tip (iteration ${r.iter}):** prefer fixing a finding definitively or rejecting it (reviewer_was_wrong) over adding new code — each new edit spawns a fresh review and can prolong this loop. A finding you reject as a false positive is suppressed if it recurs.`,
                "",
              ]
            : []),
        ];
  const head = [
    `# Reviewgate Report — iteration ${r.iter} of ${r.max_iter}`,
    "",
    `**Verdict:** ${r.verdict}  ·  ${r.counts.critical} CRITICAL · ${r.counts.warn} WARN · ${r.counts.info} INFO`,
    `**Reviewers:** ${r.reviewers.map((x) => `${x.id} (${x.status})`).join(" · ")}`,
    `**Cost:** $${r.cost_usd_total.toFixed(2)}  ·  **Duration:** ${(r.duration_ms_total / 1000).toFixed(1)}s  ·  **Git:** ${r.git.branch}@${r.git.sha.slice(0, 7)}`,
    "",
    ...coverageBanner,
    ...docsReviewBanner,
    ...singleReviewerBanner,
    ...largeDiffBanner,
    ...unsettledBanner,
    ...fragmentationBanner,
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
  const advisoryAll = r.findings.filter(isAdvisory);
  // #2 (field report 2026-06-17): hard-separate repo-wide (out-of-diff) findings from the
  // agent's own in-scope advisory list. scope_demoted is the repo-wide marker — these are
  // findings on files/lines the change never touched (e.g. SQL/Redis issues in untouched
  // files). They are ALREADY non-blocking + decision-free (aggregator verdict counting +
  // the loop-driver decision gate scope to CRITICAL/WARN), so this is a pure presentation
  // split that stops the agent's must-read list from being diluted by pre-existing code.
  const outOfDiff = advisoryAll.filter((f) => f.scope_demoted === true);
  const inScopeAdvisory = advisoryAll.filter((f) => f.scope_demoted !== true);

  const sections: string[] = [];
  const crit = blocking.filter((f) => f.severity === "CRITICAL");
  const warn = blocking.filter((f) => f.severity === "WARN");
  if (crit.length > 0) sections.push("## CRITICAL ●\n", ...crit.map(fmtFinding));
  if (warn.length > 0) sections.push("## WARN ▲\n", ...warn.map(fmtFinding));
  if (inScopeAdvisory.length > 0) {
    // #3/#5: fold solo low-track-record INFO into a collapsed block (render-only; nothing
    // dropped). The rest render inline as before.
    const collapsed = collapseLowTrust ? inScopeAdvisory.filter(isLowTrustSoloInfo) : [];
    const inline = inScopeAdvisory.filter((f) => !collapsed.includes(f));
    sections.push("## Advisory (out of scope / known FP — no decision needed) ·\n");
    if (inline.length > 0) sections.push(...inline.map(fmtFinding));
    if (collapsed.length > 0) {
      const provs = [
        ...new Set(
          collapsed.flatMap((f) =>
            (f.reviewer_precision ?? [])
              .filter((c) => c.precision !== null && c.precision < LOW_TRACK_RECORD_PRECISION)
              .map(
                (c) =>
                  `${c.provider} ${c.precision === null ? "n/a" : `${Math.round(c.precision * 100)}%`}`,
              ),
          ),
        ),
      ].join(", ");
      sections.push(
        `<details>\n<summary>▸ ${collapsed.length} low-track-record advisory note(s) from ${provs} — expand if relevant</summary>\n`,
        ...collapsed.map(fmtFinding),
        "</details>\n",
      );
    }
  }
  if (outOfDiff.length > 0) {
    sections.push(
      "## Existing code (advisory — pre-existing, not introduced by this change; NOT gated) 📍\n",
      "These findings are on files/lines your change did not touch. They are advisory only and require NO decision — fix them separately if you choose.\n",
      ...outOfDiff.map(fmtFinding),
    );
  }
  // Optional learn-loop hint — only emitted in the agent-loop mode (NOT in
  // one-shot review-plan reports). Advisory findings carry no gating
  // semantics, but if the agent notices a reviewer hallucinated one, a
  // single optional decision line teaches the FP-ledger + reputation. The
  // signal would otherwise be lost: pre-this-hint a "F-XYZ halluziniert"
  // observation in chat just dies because INFO requires no decision.
  if (advisoryAll.length > 0 && mode !== "one-shot") {
    sections.push(
      "### Optional: train Reviewgate on advisory hallucinations\n",
      "If you identify any advisory finding above as a reviewer hallucination, you may optionally write a decision line — it feeds the FP-ledger and reviewer reputation. No gating effect either way. `reason` must be ≥20 characters explaining why the reviewer was wrong:\n",
      '- `{"schema":"reviewgate.decision.v1","finding_id":"F-XYZ","verdict":"rejected","reason":"...","reviewer_was_wrong":true}`\n',
    );
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

  async write(
    report: PendingReport,
    opts?: { mode?: "gate" | "one-shot"; collapseLowTrustSoloInfo?: boolean },
  ): Promise<void> {
    const mode = opts?.mode ?? "gate";
    const collapseLowTrust = opts?.collapseLowTrustSoloInfo !== false;
    // One-shot reviews write to their OWN files so they never clobber the gate's
    // pending.md/json (which the Stop-hook decisions loop reads).
    const md = mode === "one-shot" ? planReviewMdPath(this.repoRoot) : pendingMdPath(this.repoRoot);
    const json =
      mode === "one-shot" ? planReviewJsonPath(this.repoRoot) : pendingJsonPath(this.repoRoot);
    ensureDir(md);
    // Atomic tmp+rename: pending.{md,json} are read cross-process by the Stop-hook
    // decisions loop — a non-atomic writeFileSync could expose a half-written file.
    writeFileAtomic(md, renderMd(report, mode, collapseLowTrust), { mode: 0o600 });
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
      ...(input.reasonCode === "findings-out-of-scope"
        ? [
            "- These findings are on files the reporting session did NOT author (a parallel agent's / pre-existing uncommitted work in a shared checkout). The agent correctly declined to edit foreign code — route them to the owning agent/session, or review them yourself.",
            "- To avoid this in multi-agent runs, isolate work per `git worktree` (each its own `reviewgate init`), or keep foreign findings advisory (the default `outOfDiffBlocking: []`).",
          ]
        : input.reasonCode === "session-disowned"
          ? [
              "- These findings are on a parallel agent's COMMITTED work that entered the reporting session's reviewed diff in a shared checkout; the reporting session produced NO work in this change-set, so it honestly disowned it (the gate did not fake a pass). Route them to the owning agent/session, or review them yourself.",
              "- This is the committed-foreign analog of the worktree blind spot: to avoid it in multi-agent runs, isolate each agent in its own `git worktree` (each its own `reviewgate init`) so one session's commits never enter another's review base.",
            ]
          : []),
      "- Review the listed findings yourself before committing.",
      "- To make a finding a sticky known-false-positive: find its id with `reviewgate fp list`, then `reviewgate fp pin --id <FP-id>`.",
      "- If the panel diverges from your intent systematically, edit `reviewgate.config.ts` (e.g. adjust reviewers/personas) and run `reviewgate doctor` to validate.",
    ].join("\n");
    // Atomic tmp+rename: ESCALATION.md may be read cross-process while written.
    writeFileAtomic(p, out, { mode: 0o600 });
  }
}
