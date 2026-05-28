// src/core/brain/candidate-store.ts
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { type BrainCandidate, BrainCandidateSchema } from "../../schemas/brain.ts";
import { flock } from "../../utils/flock.ts";
import { brainCandidatesLockPath, brainCandidatesPath, brainDir } from "../../utils/paths.ts";
import { GROUP_THRESHOLD } from "./constants.ts";
import { cosineSimilarity } from "./embeddings.ts";

/** Cosine-similarity gate that never throws — wraps `cosineSimilarity` so a
 *  malformed embedding (zero-magnitude, length mismatch) can't crash an insert.
 *  Returns false on any cosine error: "we couldn't compare → treat as not-a-dup". */
function safeCosineAtLeast(a: number[], b: number[], threshold: number): boolean {
  try {
    return cosineSimilarity(a, b) >= threshold;
  } catch {
    return false;
  }
}

export class CandidateStore {
  constructor(private readonly repoRoot: string) {}

  async listAll(): Promise<BrainCandidate[]> {
    const p = brainCandidatesPath(this.repoRoot);
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, "utf8");
    const out: BrainCandidate[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(BrainCandidateSchema.parse(JSON.parse(t)));
      } catch {
        /* skip partial/invalid line — compaction squeezes it out */
      }
    }
    return out;
  }

  private persist(entries: BrainCandidate[]): void {
    const p = brainCandidatesPath(this.repoRoot);
    if (entries.length === 0) {
      if (existsSync(p)) unlinkSync(p);
      return;
    }
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, { mode: 0o600 });
    renameSync(tmp, p);
  }

  async mutate<T>(
    fn: (entries: BrainCandidate[]) => { next: BrainCandidate[]; result: T },
  ): Promise<T> {
    if (!existsSync(brainDir(this.repoRoot)))
      mkdirSync(brainDir(this.repoRoot), { recursive: true });
    const lock = await flock(brainCandidatesLockPath(this.repoRoot));
    try {
      const cur = await this.listAll();
      const { next, result } = fn(structuredClone(cur));
      for (const e of next) BrainCandidateSchema.parse(e);
      this.persist(next);
      return result;
    } finally {
      await lock.release();
    }
  }

  /** Add a new candidate, deduplicating by (same provider + cosine ≥ GROUP_THRESHOLD).
   *  A same-provider candidate with a sufficiently similar embedding means "this provider
   *  already said this" — no-op. A different-provider candidate is always added (quorum-relevant). */
  async addOrMerge(c: BrainCandidate): Promise<void> {
    await this.mutate((entries) => {
      // Dedup: a SAME-provider candidate with an embedding cosine ≥ GROUP_THRESHOLD
      // means "this provider already said this" — no-op (don't inflate the pool
      // with one provider's repeated observations).
      // (Schema enforces embedding.length ≥ 1 at parse time in listAll; the catch
      //  inside safeCosineAtLeast is defense-in-depth for any other cosine error —
      //  never crash an insert.)
      const dup = entries.find(
        (e) =>
          e.provider === c.provider &&
          e.embedding_model === c.embedding_model &&
          safeCosineAtLeast(e.embedding, c.embedding, GROUP_THRESHOLD),
      );
      return dup
        ? { next: entries, result: undefined }
        : { next: [...entries, c], result: undefined };
    });
  }
}
