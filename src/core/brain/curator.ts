import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type BrainEntry,
  BrainEntrySchema,
  type EvidenceItem,
  type MemoryProposal,
  MemoryProposalSchema,
} from "../../schemas/brain.ts";
import { curatorDecisionsPath } from "../../utils/paths.ts";
import { type Embedder, cosineSimilarity } from "./embeddings.ts";
import type { BrainStore } from "./store.ts";

const DEDUP_THRESHOLD = 0.85;
const GROUP_THRESHOLD = 0.85;
const MAX_PROMOTIONS = 3;

// Known provider ids, longest first so longest-prefix matching is deterministic
// (`claude-code-security` must resolve to `claude-code`, never `claude`).
const KNOWN_PROVIDERS = ["claude-code", "openrouter", "codex", "gemini"] as const;

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

// Map a (trusted, orchestrator-stamped) reviewer_id to its provider id.
// Longest-prefix match against the known providers; fall back to the part before
// the last `-` only if none match. Never `split("-")[0]` — that would collapse
// `claude-code-security` to `claude` and break provider counting.
export function providerOf(reviewerId: string): string {
  for (const known of KNOWN_PROVIDERS) {
    if (reviewerId === known || reviewerId.startsWith(`${known}-`)) return known;
  }
  const cut = reviewerId.lastIndexOf("-");
  return cut > 0 ? reviewerId.slice(0, cut) : reviewerId;
}

// Distinct providers represented in a set of evidence items.
function providersIn(evidence: EvidenceItem[]): Set<string> {
  const s = new Set<string>();
  for (const e of evidence) if (e.reviewer_id) s.add(providerOf(e.reviewer_id));
  return s;
}

// Source quorum (rule 2/6) over a MERGED evidence set: ≥1 web-fetch item, OR
// ≥3 reviewer evidence items spanning ≥2 DISTINCT providers. Diff-derived groups
// require double (≥2 web-fetch, ≥6 reviewer items) per rule 6.
function quorumOk(evidence: EvidenceItem[], doubled: boolean): boolean {
  const web = evidence.filter((e) => e.kind === "web-fetch").length;
  const reviewerEv = evidence.filter(
    (e) => e.kind === "reviewer-finding" || e.kind === "reviewer-observation",
  ).length;
  const provs = providersIn(evidence).size;
  const webNeed = doubled ? 2 : 1;
  const revNeed = doubled ? 6 : 3;
  if (web >= webNeed) return true;
  return reviewerEv >= revNeed && provs >= 2;
}

function isDiffDerived(evidence: EvidenceItem[]): boolean {
  return evidence.some((e) => e.from_diff);
}

function logDecision(repoRoot: string, line: object): void {
  const path = curatorDecisionsPath(repoRoot, (line as { run_id: string }).run_id);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

// A cluster of similar proposals across reviewers. The group accretes every
// member's evidence; its representative is the highest-confidence member.
interface ProposalGroup {
  members: MemoryProposal[];
  vecs: number[][];
  evidence: EvidenceItem[];
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

  // --- Embed every incoming proposal up front (title+body). Fail closed: if the
  // embedder errors we cannot group OR dedup, so we queue everything and promote
  // nothing — never silently degrade to single-provider promotion. ---
  let vecs: number[][];
  try {
    vecs = await input.embedder.embed(
      input.proposals.map((p) => `${p.title}\n${p.body}`),
      cfg,
    );
  } catch {
    for (const p of input.proposals) {
      res.queued++;
      log("queued", p.title, { rule_failed: "embed-error" });
    }
    return res;
  }
  if (vecs.length !== input.proposals.length) {
    for (const p of input.proposals) {
      res.queued++;
      log("queued", p.title, { rule_failed: "embed-error" });
    }
    return res;
  }

  // --- Group proposals by cosine ≥ GROUP_THRESHOLD. A proposal joins an existing
  // group if it matches ANY member; otherwise it starts a new group. Grouping is
  // how real cross-provider quorum is reconstructed: similar knowledge emitted by
  // DISTINCT reviewers accretes into one group whose merged evidence spans
  // multiple providers. ---
  const groups: ProposalGroup[] = [];
  for (let i = 0; i < input.proposals.length; i++) {
    const proposal = input.proposals[i] as MemoryProposal;
    const vec = vecs[i] as number[];
    let target: ProposalGroup | undefined;
    for (const g of groups) {
      const matches = g.vecs.some((mv) => {
        try {
          return cosineSimilarity(mv, vec) >= GROUP_THRESHOLD;
        } catch {
          return false;
        }
      });
      if (matches) {
        target = g;
        break;
      }
    }
    if (target) {
      target.members.push(proposal);
      target.vecs.push(vec);
      target.evidence.push(...proposal.evidence);
    } else {
      groups.push({ members: [proposal], vecs: [vec], evidence: [...proposal.evidence] });
    }
  }

  // --- Per-group gating + promotion. ---
  for (const group of groups) {
    // Representative = highest-confidence member, carrying the MERGED evidence.
    const rep = group.members.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    const mergedEvidence = group.evidence;
    const groupConfidence = Math.max(...group.members.map((m) => m.confidence));
    const title = rep.title;

    if (res.promoted + res.merged >= MAX_PROMOTIONS) {
      res.queued++;
      log("queued", title, { rule_failed: "rate-limit" });
      continue;
    }

    // Rule 1: schema (validate the representative + the merged evidence shape).
    const repWithMerged: MemoryProposal = { ...rep, evidence: mergedEvidence };
    if (!MemoryProposalSchema.safeParse(repWithMerged).success) {
      res.rejected++;
      log("rejected", title, { rule_failed: "schema" });
      continue;
    }

    // Rule 5: scope plausibility (M4 heuristic).
    if (rep.scope.startsWith("universal")) {
      res.rejected++;
      log("rejected", title, { rule_failed: "scope" });
      continue;
    }

    // Rule 6 + 2: (doubled) cross-provider quorum over the merged evidence.
    const doubled = isDiffDerived(mergedEvidence);
    if (!quorumOk(mergedEvidence, doubled)) {
      res.rejected++;
      log("rejected", title, { rule_failed: doubled ? "diff-quorum" : "quorum" });
      continue;
    }

    // The representative embedding (already computed above) drives dedup.
    const repIdx = input.proposals.indexOf(rep);
    const vec = (repIdx >= 0 ? vecs[repIdx] : group.vecs[0]) as number[];

    const snap = await input.store.snapshot();
    // Rule 3: consistency (same title already active).
    if (snap.entries.some((e) => e.status === "active" && e.title === title)) {
      res.rejected++;
      log("rejected", title, { rule_failed: "consistency" });
      continue;
    }

    // Rule 4: dedup vs EXISTING brain entries (cosine ≥ 0.85 → merge/bump).
    let dup: BrainEntry | undefined;
    try {
      dup = snap.entries.find(
        (e) => e.embedding && cosineSimilarity(e.embedding, vec) >= DEDUP_THRESHOLD,
      );
    } catch {
      dup = undefined;
    }
    if (dup) {
      const dupId = dup.id;
      await input.store.mutate((s) => {
        const t = s.entries.find((x) => x.id === dupId);
        if (t) {
          t.referenced_count += 1;
          t.last_referenced_at = input.nowIso;
        }
        return { next: s, result: undefined };
      });
      res.merged++;
      log("merged-duplicate", title, { entry_id: dupId });
      continue;
    }

    // Hybrid: optional LLM judgment on the fuzzy rules (consistency/scope/quality).
    if (input.judge) {
      let verdict: { accept: boolean; reason?: string };
      try {
        verdict = await input.judge(repWithMerged);
      } catch {
        res.queued++;
        log("queued", title, { rule_failed: "judge-error" });
        continue;
      }
      if (!verdict.accept) {
        res.rejected++;
        log("rejected", title, { rule_failed: "llm-judge" });
        continue;
      }
    }

    // Promote ONE representative entry per surviving group, allocating its id
    // inside the store's write lock to avoid the nextId/add TOCTOU race.
    const id = await input.store.addAllocatingId((allocId) =>
      BrainEntrySchema.parse({
        id: allocId,
        type: rep.type,
        scope: rep.scope,
        title,
        body: rep.body,
        tags: rep.tags,
        file_globs: mergedEvidence.flatMap((e) => (e.from_diff ? [e.from_diff.file] : [])),
        status: "candidate",
        referenced_count: 1,
        referencing_reviewers: [...providersIn(mergedEvidence)],
        confidence: groupConfidence,
        embedding: vec ?? null,
        evidence: mergedEvidence,
        created_at: input.nowIso,
        source_run_id: input.runId,
        ...(doubled ? { provenance: "diff-derived" as const } : {}),
      } satisfies BrainEntry),
    );
    res.promoted++;
    log("promoted", title, { entry_id: id });
  }
  return res;
}
