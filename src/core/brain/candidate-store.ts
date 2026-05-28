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

  /** Add a new candidate (no dedup yet — Task 3 adds dedup-by-(embedding, provider)). */
  async addOrMerge(c: BrainCandidate): Promise<void> {
    await this.mutate((entries) => ({ next: [...entries, c], result: undefined }));
  }
}
