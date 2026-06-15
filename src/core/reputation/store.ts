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
  quarantine?: { enabled: boolean; floor: number };
}

// Events whose time-decayed weight is negligible are dropped on write to keep
// reputation.json bounded. At 6 half-lives the weight is 0.5^6 ≈ 0.0156; the effect
// on the derived score is bounded and immaterial (both buckets prune proportionally,
// so `trust` stays near-invariant). Storage hygiene, not a scoring change.
const PRUNE_HALF_LIVES = 6;
const DEFAULT_HALF_LIFE_DAYS = 45; // mirrors the phases.reputation schema default

// Best-effort: preserve a corrupt file for forensics before recovering empty
// (mirrors StateStore.loadOrRecover). Rename failures (e.g. a concurrent reader
// already moved it) are swallowed — recovery must never fail on the backup.
function backupCorrupt(p: string): void {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    renameSync(p, `${p}.corrupt.${ts}`);
  } catch {
    // best-effort only
  }
}

function pruneBucket(
  events: { ts: string; eid: string }[],
  now: Date,
  halfLifeDays: number,
): { ts: string; eid: string }[] {
  const horizonMs = PRUNE_HALF_LIVES * halfLifeDays * 24 * 60 * 60 * 1000;
  return events.filter((e) => {
    const ageMs = now.getTime() - Date.parse(e.ts);
    // DROP unparseable (NaN) and future-dated (negative-age) events as invalid.
    // The previous "keep them forever" behavior (mirroring decayedCount's
    // weight-1 treatment) defeated the bounded-file guarantee: a clock-skewed or
    // corrupt timestamp could never age out, so a stream of such events would
    // grow reputation.json without bound. Treating them as prunable trades a
    // negligible scoring effect (these are anomalies, not legitimate history)
    // for the storage bound the prune exists to enforce.
    if (!Number.isFinite(ageMs) || ageMs < 0) return false;
    return ageMs <= horizonMs;
  });
}

export class ReputationStore {
  constructor(private readonly repoRoot: string) {}

  async snapshot(): Promise<Reputation> {
    const p = reputationJsonPath(this.repoRoot);
    if (!existsSync(p)) return emptyReputation();
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch (err) {
      // existsSync→read TOCTOU: deleted in between is a genuine "no file".
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyReputation();
      // F-22: a transient I/O error (EACCES / EBUSY / AV lock / EIO / network FS)
      // on an EXISTING reputation.json must NOT be misread as "empty" — inside
      // record() that empty snapshot would be atomically persisted, silently
      // wiping every reviewer's accumulated trust history. Rethrow so the caller
      // fails loudly (learn/read paths .catch() → "no learning/demote this
      // round", not data loss). Mirrors StateStore.loadOrRecover.
      throw err;
    }
    try {
      return ReputationSchema.parse(JSON.parse(raw));
    } catch {
      // Genuine content corruption only (SyntaxError / ZodError). Preserve the
      // corrupt file for forensics (best-effort), then recover empty.
      backupCorrupt(p);
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
        const otherBucket = ev.outcome === "correct" ? entry.wrong : entry.correct;
        // Per-eid idempotency ACROSS both buckets: the eid is verdict-free
        // (session:cycle:iter:finding:reviewerKey), so a re-stop within the same
        // iteration that flips the verdict re-books the same eid with the OPPOSITE
        // outcome. Supersede the stale opposite-bucket entry so a single iteration
        // can never hold both a 'wrong' AND a 'correct' for one reviewer (F-20
        // hardening: the in-absorb last-wins fold can't see prior absorbs).
        const otherIdx = otherBucket.findIndex((e) => e.eid === ev.eid);
        if (otherIdx >= 0) otherBucket.splice(otherIdx, 1);
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

  private async reviewersBelow(
    floor: number,
    cfg: ReputationConfig,
    now: Date,
  ): Promise<Set<string>> {
    const rep = await this.snapshot();
    const out = new Set<string>();
    for (const reviewerKey of Object.keys(rep.reviewers)) {
      if (!reviewerKey.includes(":")) continue; // legacy bare-provider key (pre-Slice-B) → inert
      if (isUnreliable(this.derive(reviewerKey, rep, now, cfg.halfLifeDays), cfg.minSamples, floor))
        out.add(reviewerKey);
    }
    return out;
  }

  async unreliableReviewers(cfg: ReputationConfig, now: Date): Promise<Set<string>> {
    return this.reviewersBelow(cfg.trustFloor, cfg, now);
  }

  async quarantinedReviewers(cfg: ReputationConfig, now: Date): Promise<Set<string>> {
    if (!cfg.quarantine?.enabled) return new Set<string>();
    return this.reviewersBelow(cfg.quarantine.floor, cfg, now);
  }

  async forDoctor(cfg: ReputationConfig, now: Date) {
    const rep = await this.snapshot();
    const qFloor = cfg.quarantine?.enabled ? cfg.quarantine.floor : null;
    return Object.entries(rep.reviewers)
      .filter(([reviewerKey]) => reviewerKey.includes(":")) // hide legacy bare-provider keys
      .map(([reviewerKey, e]) => {
        const d = this.derive(reviewerKey, rep, now, cfg.halfLifeDays);
        return {
          reviewer: reviewerKey,
          correct: e.correct.length,
          wrong: e.wrong.length,
          trust: d.trust,
          demoting: isUnreliable(d, cfg.minSamples, cfg.trustFloor),
          quarantined: qFloor !== null && isUnreliable(d, cfg.minSamples, qFloor),
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
