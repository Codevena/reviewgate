// src/core/report-writer.ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Finding } from "../schemas/finding.ts";
import type { PendingReport } from "../schemas/pending-report.ts";
import { escalationMdPath, pendingJsonPath, pendingMdPath } from "../utils/paths.ts";

function ensureDir(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function fmtFinding(f: Finding): string {
  const sym = f.severity === "CRITICAL" ? "●" : f.severity === "WARN" ? "▲" : "·";
  const confirmed =
    f.confirmed_by && f.confirmed_by.length > 1
      ? ` (confirmed by ${f.confirmed_by.join(", ")})`
      : "";
  return [
    `### ${f.id}  ${sym} ${f.severity}  ·  ${f.file}:${f.line_start}  ·  ${f.rule_id}`,
    `**Category:** ${f.category}  ·  **Consensus:** ${f.consensus}  ·  **Confidence:** ${f.confidence.toFixed(2)}${confirmed}`,
    "",
    f.message,
    "",
    f.details,
    f.suggested_fix ? `\n**Suggested fix:**\n\`\`\`\n${f.suggested_fix}\n\`\`\`` : "",
    "",
  ].join("\n");
}

function renderMd(r: PendingReport): string {
  const head = [
    `# Reviewgate Report — iteration ${r.iter} of ${r.max_iter}`,
    "",
    `**Verdict:** ${r.verdict}  ·  ${r.counts.critical} CRITICAL · ${r.counts.warn} WARN · ${r.counts.info} INFO`,
    `**Reviewers:** ${r.reviewers.map((x) => `${x.id} (${x.status})`).join(" · ")}`,
    `**Cost:** $${r.cost_usd_total.toFixed(2)}  ·  **Duration:** ${(r.duration_ms_total / 1000).toFixed(1)}s  ·  **Git:** ${r.git.branch}@${r.git.sha.slice(0, 7)}`,
    "",
    "## Required actions",
    "",
    `For each finding below, append ONE line to \`.reviewgate/decisions/${r.iter}.jsonl\`:`,
    '- `{"schema":"reviewgate.decision.v1","finding_id":"F-XYZ","verdict":"accepted","action":"fixed","files_touched":[...]}`',
    '- `{"schema":"reviewgate.decision.v1","finding_id":"F-XYZ","verdict":"rejected","reason":"...","reviewer_was_wrong":true}`',
    "",
    "Reviewgate refuses to unblock until every finding ID has a decision.",
    "",
    "---",
    "",
  ].join("\n");

  const sections: string[] = [];
  const by: Record<"CRITICAL" | "WARN" | "INFO", Finding[]> = { CRITICAL: [], WARN: [], INFO: [] };
  for (const f of r.findings) by[f.severity].push(f);
  if (by.CRITICAL.length > 0) sections.push("## CRITICAL ●\n", ...by.CRITICAL.map(fmtFinding));
  if (by.WARN.length > 0) sections.push("## WARN ▲\n", ...by.WARN.map(fmtFinding));
  if (by.INFO.length > 0) sections.push("## INFO ·\n", ...by.INFO.map(fmtFinding));

  return head + sections.join("\n");
}

export interface EscalationInput {
  runId: string;
  iter: number;
  maxIter: number;
  reasonCode: "max-iterations" | "cost-cap" | "stuck-signatures" | "reject-rate-high";
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
  triggeredAt: string;
}

export class ReportWriter {
  constructor(private readonly repoRoot: string) {}

  async write(report: PendingReport): Promise<void> {
    const md = pendingMdPath(this.repoRoot);
    const json = pendingJsonPath(this.repoRoot);
    ensureDir(md);
    writeFileSync(md, renderMd(report), { mode: 0o600 });
    writeFileSync(json, JSON.stringify(report, null, 2), { mode: 0o600 });
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
    const top = input.topFindings.slice(0, 5).map(fmtFinding).join("\n");
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
      "## Final findings (last iteration)",
      top,
      "",
      "## Per-iteration history",
      "| Iter | Verdict | CRIT | WARN | Cost   | Findings |",
      "|------|---------|------|------|--------|----------|",
      rows,
      "",
      "## Suggested human actions",
      "- Review the listed findings yourself before committing.",
      "- If a finding is genuinely a false positive, run `reviewgate fp pin <signature>`.",
      "- If the panel diverges from your intent systematically, run `reviewgate config edit`.",
    ].join("\n");
    writeFileSync(p, out, { mode: 0o600 });
  }
}
