// src/research/research-writer.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TriageDecision } from "../schemas/triage.ts";
import type { Conventions } from "./conventions.ts";
import type { DiffFacts } from "./diff-facts.ts";
import type { SymbolGraph } from "./symbol-graph.ts";

export interface ResearchInput {
  repoRoot: string;
  facts: DiffFacts;
  triage: TriageDecision;
  symbolGraph: SymbolGraph;
  conventions: Conventions;
}

export function researchPath(repoRoot: string): string {
  return join(repoRoot, ".reviewgate", "research.md");
}

function gitLog(repoRoot: string, file: string): string {
  const r = spawnSync("git", ["log", "-3", "--oneline", "--", file], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (r.status !== 0 || !r.stdout.trim()) return "";
  return r.stdout.trim().split("\n").slice(0, 3).join("; ");
}

export async function writeResearch(input: ResearchInput): Promise<string> {
  const lines: string[] = [
    "# Reviewgate Research",
    "",
    `**Risk class:** ${input.triage.riskClass}  ·  **Budget:** ${input.triage.budgetTier}  ·  **Loop cap:** ${input.triage.loopCap}`,
    `**Triage:** ${input.triage.justification}`,
    "",
    "## Changed files",
    ...input.facts.files.map((f) => {
      const hist = gitLog(input.repoRoot, f.path);
      return `- ${f.path} (${f.kind}, +${f.added}/-${f.removed})${hist ? ` — recent: ${hist}` : ""}`;
    }),
    "",
    `**Sensitivity tags:** ${input.facts.sensitivityTags.join(", ") || "none"}`,
    "",
    "## Symbol graph (1-hop)",
    ...(input.symbolGraph.symbols.length
      ? input.symbolGraph.symbols.map(
          (s) =>
            `- ${s.name} (L${s.startLine}-${s.endLine}) calls: ${s.callees.join(", ") || "—"}; callers: ${
              (input.symbolGraph.callers[s.name] ?? [])
                .map((c) => `${c.file}:${c.line}`)
                .slice(0, 5)
                .join(", ") || "—"
            }`,
        )
      : ["_No symbol graph (unsupported language or grammar unavailable)._"]),
    "",
    "## Project conventions",
    input.conventions.summary,
    "",
  ];
  const p = researchPath(input.repoRoot);
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.join("\n"), { mode: 0o600 });
  return p;
}
