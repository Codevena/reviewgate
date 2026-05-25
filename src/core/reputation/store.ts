// src/core/reputation/store.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Reputation, ReputationSchema, emptyReputation } from "../../schemas/reputation.ts";
import { flock } from "../../utils/flock.ts";
import { reputationJsonPath, reputationLockPath } from "../../utils/paths.ts";
import { type RepDerived, decayedCount, isUnreliable, trustScore } from "./score.ts";

export interface RecordInput {
  provider: string;
  outcome: "correct" | "wrong";
  eid: string;
  ts: string;
}

export interface ReputationConfig {
  enabled: boolean;
  minSamples: number;
  trustFloor: number;
  halfLifeDays: number;
}

export class ReputationStore {
  constructor(private readonly repoRoot: string) {}

  async snapshot(): Promise<Reputation> {
    const p = reputationJsonPath(this.repoRoot);
    if (!existsSync(p)) return emptyReputation();
    try {
      return ReputationSchema.parse(JSON.parse(readFileSync(p, "utf8")));
    } catch {
      return emptyReputation();
    }
  }

  async record(events: RecordInput[]): Promise<void> {
    if (events.length === 0) return;
    const lock = await flock(reputationLockPath(this.repoRoot));
    try {
      const rep = await this.snapshot();
      for (const ev of events) {
        let entry = rep.reviewers[ev.provider];
        if (!entry) {
          entry = { correct: [], wrong: [] };
          rep.reviewers[ev.provider] = entry;
        }
        const bucket = ev.outcome === "correct" ? entry.correct : entry.wrong;
        if (bucket.some((e) => e.eid === ev.eid)) continue;
        bucket.push({ ts: ev.ts, eid: ev.eid });
      }
      this.writeAtomic(ReputationSchema.parse(rep));
    } finally {
      await lock.release();
    }
  }

  private derive(provider: string, rep: Reputation, now: Date, halfLifeDays: number): RepDerived {
    const e = rep.reviewers[provider] ?? { correct: [], wrong: [] };
    const trust = trustScore(e.correct, e.wrong, now, halfLifeDays);
    const samples =
      decayedCount(e.correct, now, halfLifeDays) + decayedCount(e.wrong, now, halfLifeDays);
    return { trust, samples };
  }

  async unreliableProviders(cfg: ReputationConfig, now: Date): Promise<Set<string>> {
    const rep = await this.snapshot();
    const out = new Set<string>();
    for (const provider of Object.keys(rep.reviewers)) {
      if (
        isUnreliable(
          this.derive(provider, rep, now, cfg.halfLifeDays),
          cfg.minSamples,
          cfg.trustFloor,
        )
      )
        out.add(provider);
    }
    return out;
  }

  async forDoctor(cfg: ReputationConfig, now: Date) {
    const rep = await this.snapshot();
    return Object.entries(rep.reviewers).map(([provider, e]) => {
      const d = this.derive(provider, rep, now, cfg.halfLifeDays);
      return {
        provider,
        correct: e.correct.length,
        wrong: e.wrong.length,
        trust: d.trust,
        demoting: isUnreliable(d, cfg.minSamples, cfg.trustFloor),
      };
    });
  }

  private writeAtomic(rep: Reputation): void {
    const p = reputationJsonPath(this.repoRoot);
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${p}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify(rep, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
  }
}
