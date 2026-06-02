import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { type ImplicitOutcome, ImplicitOutcomeSchema } from "../../schemas/implicit-outcome.ts";
import { writeFileAtomic } from "../../utils/atomic-write.ts";
import { flock } from "../../utils/flock.ts";
import { implicitOutcomesLockPath, implicitOutcomesPath, learningsDir } from "../../utils/paths.ts";

/** Write-only learning-signal corpus of demoted/dropped findings. flock'd,
 *  atomic, prune-at-write (oldest-drop). */
export class ImplicitOutcomeStore {
  constructor(private readonly repoRoot: string) {}

  async load(): Promise<ImplicitOutcome[]> {
    const p = implicitOutcomesPath(this.repoRoot);
    if (!existsSync(p)) return [];
    const out: ImplicitOutcome[] = [];
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(ImplicitOutcomeSchema.parse(JSON.parse(t)));
      } catch {
        /* skip partial/old-schema line */
      }
    }
    return out;
  }

  /** Append `outcomes`, then prune to the newest `cap` lines (oldest dropped). */
  async append(outcomes: ImplicitOutcome[], cap: number): Promise<void> {
    if (outcomes.length === 0) return;
    const dir = learningsDir(this.repoRoot);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const lock = await flock(implicitOutcomesLockPath(this.repoRoot));
    try {
      const merged = [...(await this.load()), ...outcomes];
      const kept = merged.length > cap ? merged.slice(merged.length - cap) : merged;
      writeFileAtomic(
        implicitOutcomesPath(this.repoRoot),
        `${kept.map((o) => JSON.stringify(o)).join("\n")}\n`,
        { mode: 0o600 },
      );
    } finally {
      await lock.release();
    }
  }
}
