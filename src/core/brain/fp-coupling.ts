import { BrainEntrySchema } from "../../schemas/brain.ts";
import type { FpLedgerEntry } from "../../schemas/fp-ledger.ts";
import type { FpLedgerStore } from "../fp-ledger/store.ts";
import type { Embedder } from "./embeddings.ts";
import type { BrainStore } from "./store.ts";

// M5 Phase B3 — couple the FP-ledger to the Brain: every active/sticky FP entry
// gets a paired Brain `convention` entry (the human-readable "this is a known
// false positive — why"), cross-linked both ways. Idempotent (skips entries that
// already have linked_brain_id) and non-blocking (any embed/store error → paired:0,
// never throws into the caller). Contradiction-check is intentionally NOT here (B3b).
export async function pairActiveFpEntries(input: {
  fpStore: FpLedgerStore;
  brainStore: BrainStore;
  embedder: Embedder;
  embedCfg?: { model?: string; apiKeyEnv?: string; timeoutMs?: number };
  runId: string;
  nowIso: string;
}): Promise<{ paired: number }> {
  const snap = await input.fpStore.snapshot();
  const toPair = snap.entries.filter((e) => e.stage !== "candidate" && !e.linked_brain_id);
  if (toPair.length === 0) return { paired: 0 };

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
    return { paired: 0 }; // non-blocking: brain coupling never fails the gate
  }
  if (vecs.length !== toPair.length) return { paired: 0 };

  let paired = 0;
  for (let i = 0; i < toPair.length; i++) {
    const e = toPair[i] as FpLedgerEntry;
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
  return { paired };
}
