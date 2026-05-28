import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type BrainEntry,
  BrainEntrySchema,
  type EvidenceItem,
  type MemoryProposal,
  MemoryProposalSchema,
  VALID_BRAIN_ENTRY_TYPES,
  VALID_EVIDENCE_KINDS,
} from "../../schemas/brain.ts";
import { curatorDecisionsPath } from "../../utils/paths.ts";
import type { CandidateStore } from "./candidate-store.ts";
import { GROUP_THRESHOLD } from "./constants.ts";
import { type Embedder, cosineSimilarity } from "./embeddings.ts";
import type { BrainStore } from "./store.ts";

/**
 * normalizeProposal — coerce a raw (unknown) proposal into a valid
 * MemoryProposal shape, tolerating common formatting variance (overlong
 * title/body, unknown type, missing/defaultable optional fields, bad evidence
 * items) without fabricating data or weakening security rules.
 *
 * Returns null only when the proposal is irrecoverably malformed:
 *   - title is not a string
 *   - zero valid evidence items remain after dropping malformed ones
 *   - the assembled proposal still fails MemoryProposalSchema
 * An unknown/missing `type` is NOT a reject reason — it defaults to "convention".
 */
// Why a raw proposal could not be normalized — surfaced as `schema_detail` in the
// curator-decisions log so a recurring reject cause is diagnosable. "shape" means
// the assembled proposal still failed MemoryProposalSchema (e.g. a web-fetch
// evidence item missing source_url/body_sha256/fetched_at).
export type NormalizeResult =
  | { ok: true; value: MemoryProposal }
  | { ok: false; reason: "not-object" | "title" | "evidence" | "shape" };

export function normalizeProposalResult(p: unknown): NormalizeResult {
  if (p === null || typeof p !== "object") return { ok: false, reason: "not-object" };
  const raw = p as Record<string, unknown>;

  // title: must be a string; trim + truncate to 80 chars.
  if (typeof raw.title !== "string") return { ok: false, reason: "title" };
  const title = raw.title.trim().slice(0, 80);

  // body: must be a string (may be empty); truncate to 500 chars.
  const body = typeof raw.body === "string" ? raw.body.slice(0, 500) : "";

  // type: default an unknown/missing value to "convention" (the generic
  // catch-all) rather than rejecting — reviewers routinely use loose type labels
  // ("security", "best-practice"), and losing the knowledge is worse than
  // bucketing it as a convention.
  const type = (
    typeof raw.type === "string" && VALID_BRAIN_ENTRY_TYPES.has(raw.type) ? raw.type : "convention"
  ) as MemoryProposal["type"];

  // scope: if non-empty string keep; else default to "this-repo".
  const scope = typeof raw.scope === "string" && raw.scope.length > 0 ? raw.scope : "this-repo";

  // confidence: coerce to number, clamp [0,1]; default 0.5.
  let confidence = 0.5;
  if (typeof raw.confidence === "number" && !Number.isNaN(raw.confidence)) {
    confidence = Math.min(1, Math.max(0, raw.confidence));
  } else if (typeof raw.confidence === "string") {
    const parsed = Number(raw.confidence);
    if (!Number.isNaN(parsed)) confidence = Math.min(1, Math.max(0, parsed));
  }

  // tags: keep if array of strings; else [].
  const tags =
    Array.isArray(raw.tags) && (raw.tags as unknown[]).every((t) => typeof t === "string")
      ? (raw.tags as string[])
      : [];

  // evidence: keep only items with a valid `kind`; preserve all other fields.
  const rawEvidence = Array.isArray(raw.evidence) ? (raw.evidence as unknown[]) : [];
  const evidence = rawEvidence.filter(
    (e) =>
      e !== null &&
      typeof e === "object" &&
      VALID_EVIDENCE_KINDS.has((e as Record<string, unknown>).kind as string),
  ) as EvidenceItem[];

  // A proposal needs ≥1 valid evidence item.
  if (evidence.length === 0) return { ok: false, reason: "evidence" };

  const normalized = { type, scope, title, body, evidence, confidence, tags };
  const result = MemoryProposalSchema.safeParse(normalized);
  return result.success ? { ok: true, value: result.data } : { ok: false, reason: "shape" };
}

export function normalizeProposal(p: unknown): MemoryProposal | null {
  const r = normalizeProposalResult(p);
  return r.ok ? r.value : null;
}

const DEDUP_THRESHOLD = 0.85;
// GROUP_THRESHOLD (0.78) is looser than DEDUP_THRESHOLD: paraphrases of the SAME
// convention from different reviewers embed to similar-but-not-identical vectors.
// At 0.85 they stayed separate single-provider singletons and never reached
// cross-provider quorum; 0.78 lets genuine paraphrases cluster while still
// separating distinct concepts. (Dedup vs EXISTING brain entries stays strict at
// 0.85 to avoid collapsing distinct memories.) The constant lives in
// `./constants.ts` so candidate-store.ts can reuse it without an import cycle.
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
  embedCfg?: { model: string; apiKeyEnv?: string; timeoutMs?: number };
  nowIso: string;
  // Cross-run quorum: pool of candidates from prior runs (Task 5).
  candidateStore?: CandidateStore;
  crossRunCfg?: { enabled: boolean; ttlDays: number; maxEntries: number };
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
// reviewer evidence from ≥provNeed DISTINCT providers (each contributing ≥1
// item). The INTEGRITY constraint that resists collusion is the DISTINCT-PROVIDER
// count, not the raw item count — so the item floor is scaled to `provNeed`
// (≥1 reviewer item per required provider), NOT a fixed ≥3. The panel synthesizes
// ~1 evidence item per proposal, so the realistic best case — two distinct
// providers independently proposing the same convention — is exactly 2 items /
// 2 providers; the old fixed ≥3-item floor made that (and therefore essentially
// ALL real convergence) unpromotable, which is why the brain never promoted.
// Diff-derived groups are more speculative, so they keep the STRICTER provider
// quorum (≥3 vs ≥2). Web path (≥1 / ≥2 web-fetch) unchanged.
function quorumOk(evidence: EvidenceItem[], doubled: boolean): boolean {
  const web = evidence.filter((e) => e.kind === "web-fetch").length;
  const reviewerEv = evidence.filter(
    (e) => e.kind === "reviewer-finding" || e.kind === "reviewer-observation",
  ).length;
  const provs = providersIn(evidence).size;
  const webNeed = doubled ? 2 : 1;
  const provNeed = doubled ? 3 : 2;
  if (web >= webNeed) return true;
  return reviewerEv >= provNeed && provs >= provNeed;
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

  // Bound the candidate pool's growth: drop entries older than ttlDays, then cap
  // to maxEntries (oldest dropped first). Runs once per curator invocation so
  // the pool can't accumulate forever even if no new run reads-then-deletes.
  if (input.candidateStore && input.crossRunCfg?.enabled) {
    await input.candidateStore.prune(new Date(input.nowIso), {
      ttlDays: input.crossRunCfg.ttlDays,
      maxEntries: input.crossRunCfg.maxEntries,
    });
  }

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

  // --- Normalize each incoming proposal (tolerate overlong title/body +
  // imperfect evidence items) before grouping. Proposals that cannot be
  // repaired (no string title, unknown type, zero valid evidence) are rejected
  // here with rule_failed:"schema" — identical to the rule-1 path below.
  // Surviving normalized proposals replace the originals for all downstream
  // logic (grouping, dedup, promotion). ---
  const normalizedProposals: MemoryProposal[] = [];
  const normalizedVecs: number[][] = [];
  for (let i = 0; i < input.proposals.length; i++) {
    const raw = input.proposals[i] as MemoryProposal;
    const norm = normalizeProposalResult(raw);
    if (!norm.ok) {
      res.rejected++;
      log("rejected", typeof raw.title === "string" ? raw.title : "(unknown)", {
        rule_failed: "schema",
        schema_detail: norm.reason,
      });
      continue;
    }
    normalizedProposals.push(norm.value);
    normalizedVecs.push(vecs[i] as number[]);
  }

  // --- Group proposals by cosine ≥ GROUP_THRESHOLD. A proposal joins an existing
  // group if it matches ANY member; otherwise it starts a new group. Grouping is
  // how real cross-provider quorum is reconstructed: similar knowledge emitted by
  // DISTINCT reviewers accretes into one group whose merged evidence spans
  // multiple providers. ---
  const groups: ProposalGroup[] = [];
  for (let i = 0; i < normalizedProposals.length; i++) {
    const proposal = normalizedProposals[i] as MemoryProposal;
    const vec = normalizedVecs[i] as number[];
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

  // --- Cross-run quorum pool snapshot. Hoisted OUT of the per-group loop:
  // the candidate pool doesn't change between groups in a single run, so paying
  // one full-file JSONL read + parse here (vs once per group) is the only sane
  // shape. Pool view is read once per run; both the cross-run quorum match below
  // and the delete-on-promote step reuse it. ---
  const pool =
    input.candidateStore && input.crossRunCfg?.enabled
      ? await input.candidateStore.listAll()
      : null;

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
    const repParse = MemoryProposalSchema.safeParse(repWithMerged);
    if (!repParse.success) {
      res.rejected++;
      log("rejected", title, {
        rule_failed: "schema",
        schema_detail: `merged:${repParse.error.issues[0]?.path.join(".") || "shape"}`,
      });
      continue;
    }

    // Rule 5: scope plausibility (M4 heuristic).
    if (rep.scope.startsWith("universal")) {
      res.rejected++;
      log("rejected", title, { rule_failed: "scope" });
      continue;
    }

    // Representative embedding — computed once per group; reused by both the
    // cross-run match below AND the dedup-vs-existing-brain step further down.
    const repIdx = normalizedProposals.indexOf(rep);
    const repEmbed = (repIdx >= 0 ? normalizedVecs[repIdx] : group.vecs[0]) as number[];

    // Rule 6 + 2: (doubled) cross-provider quorum over the merged evidence.
    const doubled = isDiffDerived(mergedEvidence);

    // --- Cross-run quorum: candidates from prior runs whose embedding matches
    // this group's representative contribute their provider to the distinct-set
    // that quorumOk counts. Inert when the hoisted `pool` is null (candidateStore
    // absent or crossRunCfg.enabled=false).
    let crossRunEvidence: EvidenceItem[] = mergedEvidence;
    let matchedCandidateIds: string[] = []; // captured here for the delete-on-promote step below
    if (pool) {
      const matched = pool.filter((c) => {
        if (c.embedding_model !== cfg.model) return false;
        try {
          return cosineSimilarity(c.embedding, repEmbed) >= GROUP_THRESHOLD;
        } catch {
          return false;
        }
      });
      matchedCandidateIds = matched.map((m) => m.id);
      // Synthesize one reviewer-observation evidence item per matched candidate-
      // provider so the unchanged quorumOk function sees them as distinct
      // providers. These synthetic items are NOT persisted into the BrainEntry's
      // evidence (they exist solely so the unchanged quorumOk function can count
      // provider distinctness across runs).
      crossRunEvidence = [
        ...mergedEvidence,
        ...matched.map(
          (m): EvidenceItem => ({
            kind: "reviewer-observation",
            snippet: `(cross-run from ${m.source_run_id})`,
            reviewer_id: m.provider,
            run_id: m.source_run_id,
          }),
        ),
      ];
    }

    if (!quorumOk(crossRunEvidence, doubled)) {
      res.rejected++;
      log("rejected", title, { rule_failed: doubled ? "diff-quorum" : "quorum" });
      // Cross-run: persist this rep so a future run from a DIFFERENT provider can
      // complete the quorum. Single-provider reps from THIS run only — never
      // store a rep whose merged in-run evidence already spans ≥2 providers but
      // failed on the (stricter) diff-quorum path.
      if (input.candidateStore && input.crossRunCfg?.enabled) {
        const providersThisRun = new Set(
          mergedEvidence
            .filter(
              (e) =>
                (e.kind === "reviewer-observation" || e.kind === "reviewer-finding") &&
                e.reviewer_id,
            )
            .map((e) => e.reviewer_id as string),
        );
        if (providersThisRun.size === 1) {
          const provider = [...providersThisRun][0] as string;
          await input.candidateStore.addOrMerge({
            id: `BC-${randomUUID()}`,
            title: rep.title,
            body: rep.body,
            scope: rep.scope,
            type: rep.type,
            embedding: repEmbed,
            embedding_model: cfg.model,
            provider,
            source_run_id: input.runId,
            created_at: input.nowIso,
            evidence_kinds: [...new Set(mergedEvidence.map((e) => e.kind))],
            confidence: rep.confidence,
          });
        }
      }
      continue;
    }

    // Dedup vs EXISTING brain entries uses the same representative embedding.
    const vec = repEmbed;

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
          // UNION the re-proposing providers into referencing_reviewers (deduped,
          // deterministic). Without this the set stays frozen at the creation
          // providers and the candidate→active distinct-provider floor is never met.
          t.referencing_reviewers = [
            ...new Set([...t.referencing_reviewers, ...providersIn(mergedEvidence)]),
          ].sort();
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
    if (input.candidateStore && matchedCandidateIds.length > 0) {
      await input.candidateStore.deleteByIds(matchedCandidateIds);
    }
    log("promoted", title, { entry_id: id });
  }
  return res;
}
