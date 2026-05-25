// src/core/reputation/store.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Reputation, ReputationSchema, emptyReputation } from "../../schemas/reputation.ts";
import { flock } from "../../utils/flock.ts";
import { reputationJsonPath, reputationLockPath } from "../../utils/paths.ts";
import { type RepDerived, decayedCount, isUnreliable, trustScore } from "./score.ts";

export interface RecordInput {
  reviewerKey: string;
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

// Events whose time-decayed weight is negligible are dropped on write to keep
// reputation.json bounded. At 6 half-lives the weight is 0.5^6 ≈ 0.0156; the effect
// on the derived score is bounded and immaterial (both buckets prune proportionally,
// so `trust` stays near-invariant). Storage hygiene, not a scoring change.
const PRUNE_HALF_LIVES = 6;
const DEFAULT_HALF_LIFE_DAYS = 45; // mirrors the phases.reputation schema default

function pruneBucket(
  events: { ts: string; eid: string }[],
  now: Date,
  halfLifeDays: number,
): { ts: string; eid: string }[] {
  const horizonMs = PRUNE_HALF_LIVES * halfLifeDays * 24 * 60 * 60 * 1000;
  return events.filter((e) => {
    const ageMs = now.getTime() - Date.parse(e.ts);
    // Keep unparseable (NaN) and future/negative-age events — mirrors decayedCount,
    // which treats a non-finite/negative age as "fresh" (weight 1); they never age out.
    if (!Number.isFinite(ageMs) || ageMs < 0) return true;
    return ageMs <= horizonMs;
  });
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

  async record(events: RecordInput[], opts?: { now?: Date; halfLifeDays?: number }): Promise<void> {
    if (events.length === 0) return;
    const now = opts?.now ?? new Date();
    const halfLifeDays = opts?.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
    const lock = await flock(reputationLockPath(this.repoRoot));
    try {
      const rep = await this.snapshot();
      for (const ev of events) {
        let entry = rep.reviewers[ev.reviewerKey];
        if (!entry) {
          entry = { correct: [], wrong: [] };
          rep.reviewers[ev.reviewerKey] = entry;
        }
        const bucket = ev.outcome === "correct" ? entry.correct : entry.wrong;
        if (bucket.some((e) => e.eid === ev.eid)) continue;
        bucket.push({ ts: ev.ts, eid: ev.eid });
      }
      // Prune every reviewer's buckets (the write is happening anyway → keep the whole
      // file bounded). The *scoring* path uses decayed weights; a pruned event's weight is
      // <0.5^6 ≈ 1.6% of the real value, so decayed trust shifts imperceptibly. Raw counts
      // (shown by `doctor`) can visibly drop if old events are pruned. That is expected.
      for (const reviewerKey of Object.keys(rep.reviewers)) {
        const entry = rep.reviewers[reviewerKey];
        if (!entry) continue;
        entry.correct = pruneBucket(entry.correct, now, halfLifeDays);
        entry.wrong = pruneBucket(entry.wrong, now, halfLifeDays);
      }
      this.writeAtomic(ReputationSchema.parse(rep));
    } finally {
      await lock.release();
    }
  }

  private derive(
    reviewerKey: string,
    rep: Reputation,
    now: Date,
    halfLifeDays: number,
  ): RepDerived {
    const e = rep.reviewers[reviewerKey] ?? { correct: [], wrong: [] };
    const trust = trustScore(e.correct, e.wrong, now, halfLifeDays);
    const samples =
      decayedCount(e.correct, now, halfLifeDays) + decayedCount(e.wrong, now, halfLifeDays);
    return { trust, samples };
  }

  async unreliableReviewers(cfg: ReputationConfig, now: Date): Promise<Set<string>> {
    const rep = await this.snapshot();
    const out = new Set<string>();
    for (const reviewerKey of Object.keys(rep.reviewers)) {
      if (
        isUnreliable(
          this.derive(reviewerKey, rep, now, cfg.halfLifeDays),
          cfg.minSamples,
          cfg.trustFloor,
        )
      )
        out.add(reviewerKey);
    }
    return out;
  }

  async forDoctor(cfg: ReputationConfig, now: Date) {
    const rep = await this.snapshot();
    return Object.entries(rep.reviewers).map(([reviewerKey, e]) => {
      const d = this.derive(reviewerKey, rep, now, cfg.halfLifeDays);
      return {
        reviewer: reviewerKey,
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
