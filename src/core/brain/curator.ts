import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type BrainEntry,
  BrainEntrySchema,
  type MemoryProposal,
  MemoryProposalSchema,
} from "../../schemas/brain.ts";
import { curatorDecisionsPath } from "../../utils/paths.ts";
import { type Embedder, cosineSimilarity } from "./embeddings.ts";
import type { BrainStore } from "./store.ts";

const DEDUP_THRESHOLD = 0.85;
const MAX_PROMOTIONS = 3;

export interface CuratorInput {
  repoRoot: string;
  runId: string;
  proposals: MemoryProposal[];
  store: BrainStore;
  embedder: Embedder;
  embedCfg?: { model: string; apiKeyEnv?: string; timeoutMs: number };
  nowIso: string;
  // Hybrid: optional LLM judgment (only when phases.brain.curator is configured).
  // Runs AFTER the deterministic gates pass, on rules 3 (consistency) + 5 (scope/
  // quality). Rejecting drops the proposal; a judge error fails closed (queue).
  judge?: (proposal: MemoryProposal) => Promise<{ accept: boolean; reason?: string }>;
}
export interface CuratorResult {
  promoted: number;
  rejected: number;
  queued: number;
  merged: number;
}

function providers(p: MemoryProposal): Set<string> {
  const s = new Set<string>();
  for (const e of p.evidence)
    if (e.reviewer_id) s.add(e.reviewer_id.split("-")[0] ?? e.reviewer_id);
  return s;
}
function quorumOk(p: MemoryProposal, doubled: boolean): boolean {
  const web = p.evidence.filter((e) => e.kind === "web-fetch").length;
  const reviewerEv = p.evidence.filter(
    (e) => e.kind === "reviewer-finding" || e.kind === "reviewer-observation",
  ).length;
  const provs = providers(p).size;
  const webNeed = doubled ? 2 : 1;
  const revNeed = doubled ? 6 : 3;
  if (web >= webNeed) return true;
  return reviewerEv >= revNeed && provs >= 2;
}
function isDiffDerived(p: MemoryProposal): boolean {
  return p.evidence.some((e) => e.from_diff);
}
function logDecision(repoRoot: string, line: object): void {
  const path = curatorDecisionsPath(repoRoot, (line as { run_id: string }).run_id);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

export async function runCurator(input: CuratorInput): Promise<CuratorResult> {
  const res: CuratorResult = { promoted: 0, rejected: 0, queued: 0, merged: 0 };
  const cfg = input.embedCfg ?? { model: "embed", timeoutMs: 8000 };
  const log = (decision: string, title: string, extra: Record<string, unknown> = {}) =>
    logDecision(input.repoRoot, {
      schema: "reviewgate.curator.v1",
      run_id: input.runId,
      proposal_title: title,
      decision,
      provider: "curator",
      ts: input.nowIso,
      ...extra,
    });

  for (const proposal of input.proposals) {
    if (res.promoted + res.merged >= MAX_PROMOTIONS) {
      res.queued++;
      log("queued", proposal.title, { rule_failed: "rate-limit" });
      continue;
    }
    // Rule 1: schema
    if (!MemoryProposalSchema.safeParse(proposal).success) {
      res.rejected++;
      log("rejected", proposal.title, { rule_failed: "schema" });
      continue;
    }
    // Rule 5: scope plausibility (M4 heuristic)
    if (proposal.scope.startsWith("universal")) {
      res.rejected++;
      log("rejected", proposal.title, { rule_failed: "scope" });
      continue;
    }
    // Rule 6 + 2: (doubled) quorum
    const doubled = isDiffDerived(proposal);
    if (!quorumOk(proposal, doubled)) {
      res.rejected++;
      log("rejected", proposal.title, { rule_failed: doubled ? "diff-quorum" : "quorum" });
      continue;
    }
    // Rule 4: dedup (fail-closed)
    let vec: number[];
    try {
      [vec] = (await input.embedder.embed([`${proposal.title}\n${proposal.body}`], cfg)) as [
        number[],
      ];
    } catch {
      res.queued++;
      log("queued", proposal.title, { rule_failed: "embed-error" });
      continue;
    }
    const snap = await input.store.snapshot();
    // Rule 3: consistency (same title already active)
    if (snap.entries.some((e) => e.status === "active" && e.title === proposal.title)) {
      res.rejected++;
      log("rejected", proposal.title, { rule_failed: "consistency" });
      continue;
    }
    const dup = snap.entries.find(
      (e) => e.embedding && cosineSimilarity(e.embedding, vec ?? []) >= DEDUP_THRESHOLD,
    );
    if (dup) {
      await input.store.mutate((s) => {
        const t = s.entries.find((x) => x.id === dup.id);
        if (t) {
          t.referenced_count += 1;
          t.last_referenced_at = input.nowIso;
        }
        return { next: s, result: undefined };
      });
      res.merged++;
      log("merged-duplicate", proposal.title, { entry_id: dup.id });
      continue;
    }
    // Hybrid: optional LLM judgment on the fuzzy rules (consistency/scope/quality).
    if (input.judge) {
      let verdict: { accept: boolean; reason?: string };
      try {
        verdict = await input.judge(proposal);
      } catch {
        res.queued++;
        log("queued", proposal.title, { rule_failed: "judge-error" });
        continue;
      }
      if (!verdict.accept) {
        res.rejected++;
        log("rejected", proposal.title, { rule_failed: "llm-judge" });
        continue;
      }
    }
    // Promote as candidate
    const id = await input.store.nextId();
    const entry: BrainEntry = BrainEntrySchema.parse({
      id,
      type: proposal.type,
      scope: proposal.scope,
      title: proposal.title,
      body: proposal.body,
      tags: proposal.tags,
      file_globs: proposal.evidence.flatMap((e) => (e.from_diff ? [e.from_diff.file] : [])),
      status: "candidate",
      referenced_count: 1,
      referencing_reviewers: [],
      confidence: proposal.confidence,
      embedding: vec ?? null,
      evidence: proposal.evidence,
      created_at: input.nowIso,
      source_run_id: input.runId,
      ...(doubled ? { provenance: "diff-derived" as const } : {}),
    });
    await input.store.add(entry);
    res.promoted++;
    log("promoted", proposal.title, { entry_id: id });
  }
  return res;
}
