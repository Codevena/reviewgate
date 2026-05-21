import { BrainEntrySchema } from "../../schemas/brain.ts";
import type { FpLedgerEntry } from "../../schemas/fp-ledger.ts";
import type { FpLedgerStore } from "../fp-ledger/store.ts";
import type { Embedder } from "./embeddings.ts";
import type { BrainStore } from "./store.ts";

// M5 Phase B3b — contradiction judge: decides whether treating this FP as a known
// false positive CONTRADICTS any pre-existing active brain entry (e.g. an
// anti-pattern asserting the very thing the FP says to ignore). Returns the
// conflicting entry id + reason. Implemented by the orchestrator via the curator's
// LLM provider; unit-tested with a stub.
export type ContradictionJudge = (input: {
  fp: { rule_id: string; file: string };
  brainEntries: { id: string; title: string; body: string; type: string }[];
}) => Promise<{ contradicts: boolean; brain_entry_id?: string; reason?: string }>;

// M5 Phase B3 — couple the FP-ledger to the Brain: every active/sticky FP entry
// gets a paired Brain `convention` entry (the human-readable "this is a known
// false positive — why"), cross-linked both ways. Idempotent (skips entries that
// already have linked_brain_id OR contradicts_brain_id) and non-blocking (any
// embed/store error → paired:0, never throws into the caller).
//
// B3b: when a `judge` is supplied, each entry is first checked against the
// PRE-EXISTING active brain entries. If the judge says it contradicts one, the
// pairing is skipped and the FP entry is marked with `contradicts_brain_id`
// (recorded for human review via `fp show`, and a "don't re-check" marker). A
// judge error fails OPEN to pairing (a judge hiccup must not lose the pairing).
export async function pairActiveFpEntries(input: {
  fpStore: FpLedgerStore;
  brainStore: BrainStore;
  embedder: Embedder;
  embedCfg?: { model?: string; apiKeyEnv?: string; timeoutMs?: number };
  runId: string;
  nowIso: string;
  judge?: ContradictionJudge;
}): Promise<{ paired: number; contradictions: number }> {
  const snap = await input.fpStore.snapshot();
  const toPair = snap.entries.filter(
    (e) => e.stage !== "candidate" && !e.linked_brain_id && !e.contradicts_brain_id,
  );
  if (toPair.length === 0) return { paired: 0, contradictions: 0 };

  // Pre-existing active brain entries for the B3b contradiction check (snapshot
  // ONCE, before we add any of this run's pairings).
  const activeBrain = input.judge
    ? (await input.brainStore.snapshot()).entries
        .filter((e) => e.status === "active")
        .map((e) => ({ id: e.id, title: e.title, body: e.body, type: e.type as string }))
    : [];

  const title = (e: FpLedgerEntry) =>
    `Known false positive: ${e.rule_id} in ${e.file}`.slice(0, 80);
  const body = (e: FpLedgerEntry) => {
    const reasons = e.rejects
      .map((r) => r.reason)
      .filter((r) => r && r.trim().length > 0)
      .slice(-3);
    return `Maintainers confirmed this is NOT a real issue (providers: ${e.distinct_providers.join(", ")}). ${reasons.join("; ")}`.slice(
      0,
      500,
    );
  };

  let vecs: number[][];
  try {
    vecs = await input.embedder.embed(
      toPair.map((e) => `${title(e)}\n${body(e)}`),
      input.embedCfg,
    );
  } catch {
    return { paired: 0, contradictions: 0 }; // non-blocking: never fails the gate
  }
  if (vecs.length !== toPair.length) return { paired: 0, contradictions: 0 };

  let paired = 0;
  let contradictions = 0;
  for (let i = 0; i < toPair.length; i++) {
    const e = toPair[i] as FpLedgerEntry;

    // B3b: skip-and-flag if this known-FP contradicts a pre-existing active brain
    // entry. Judge errors fail OPEN (proceed to pair) so a hiccup never drops it.
    if (input.judge && activeBrain.length > 0) {
      let verdict: { contradicts: boolean; brain_entry_id?: string; reason?: string };
      try {
        verdict = await input.judge({
          fp: { rule_id: e.rule_id, file: e.file },
          brainEntries: activeBrain,
        });
      } catch {
        verdict = { contradicts: false };
      }
      if (verdict.contradicts) {
        const conflictId = verdict.brain_entry_id ?? activeBrain[0]?.id ?? "unknown";
        await input.fpStore.mutate((idx) => {
          const t = idx.entries.find((x) => x.id === e.id);
          if (t) t.contradicts_brain_id = conflictId;
          return { next: idx, result: undefined };
        });
        contradictions++;
        continue; // do NOT create a brain note that contradicts an existing memory
      }
    }

    try {
      const brainId = await input.brainStore.addAllocatingId((allocId) =>
        BrainEntrySchema.parse({
          id: allocId,
          type: "convention",
          scope: "this-repo",
          title: title(e),
          body: body(e),
          tags: ["false-positive", e.rule_id],
          file_globs: [e.file],
          status: "candidate",
          referenced_count: 1,
          referencing_reviewers: [...e.distinct_providers],
          confidence: 0.9,
          embedding: vecs[i] ?? null,
          evidence: [],
          created_at: input.nowIso,
          source_run_id: input.runId,
          linked_fp_id: e.id,
        }),
      );
      await input.fpStore.mutate((idx) => {
        const t = idx.entries.find((x) => x.id === e.id);
        if (t) t.linked_brain_id = brainId;
        return { next: idx, result: undefined };
      });
      paired++;
    } catch {
      // best-effort per entry; continue with the rest
    }
  }
  return { paired, contradictions };
}
