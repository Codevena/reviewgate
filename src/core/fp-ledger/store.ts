import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FindingCategory } from "../../schemas/finding.ts";
import {
  type FpLedgerEntry,
  type FpLedgerIndex,
  FpLedgerIndexSchema,
} from "../../schemas/fp-ledger.ts";
import { flock } from "../../utils/flock.ts";
import { fpLedgerLockPath, knownFpPath, learningsDir } from "../../utils/paths.ts";

const ACTIVE_REJECTS = 3;
const ACTIVE_DAYS = 60;
const STICKY_REJECTS = 5;
const STICKY_DAYS = 90;
const DAY_MS = 86_400_000;

export interface RejectMeta {
  rule_id: string;
  category: FindingCategory;
  file: string;
  symbol: string;
}

const EMPTY: FpLedgerIndex = { schema: "reviewgate.fpledger.v1", entries: [] };

// High-water mark for id allocation. Using the array LENGTH would reuse an id
// after decayPass() removes an entry and creates a gap (e.g. drop FP-001 while
// FP-002 survives → next would collide on FP-002), making pin/unpin and
// fp_ledger_match.pattern_id ambiguous. Allocate strictly above the max numeric
// id ever present; the only reuse is when the ledger is empty (no live refs).
function nextIdNumber(entries: FpLedgerEntry[]): number {
  let max = 0;
  for (const e of entries) {
    const n = Number.parseInt(e.id.replace(/^FP-/, ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function recompute(e: FpLedgerEntry, nowMs: number): FpLedgerEntry {
  if (e.pinned_by) return { ...e, stage: "sticky" };
  const within = (days: number) =>
    e.rejects.filter((r) => nowMs - Date.parse(r.ts) <= days * DAY_MS);
  const distinct = (rs: typeof e.rejects) => new Set(rs.map((r) => r.provider)).size;
  const win90 = within(STICKY_DAYS);
  const win60 = within(ACTIVE_DAYS);
  let stage: FpLedgerEntry["stage"] = "candidate";
  if (win90.length >= STICKY_REJECTS && distinct(win90) >= 2) stage = "sticky";
  else if (win60.length >= ACTIVE_REJECTS && distinct(win60) >= 2) stage = "active";
  return { ...e, stage, distinct_providers: [...new Set(e.rejects.map((r) => r.provider))] };
}

export class FpLedgerStore {
  constructor(private readonly repoRoot: string) {}

  async snapshot(): Promise<FpLedgerIndex> {
    const p = knownFpPath(this.repoRoot);
    if (!existsSync(p)) return EMPTY;
    try {
      return FpLedgerIndexSchema.parse(JSON.parse(readFileSync(p, "utf8")));
    } catch {
      return EMPTY;
    }
  }

  private persist(idx: FpLedgerIndex): void {
    const p = knownFpPath(this.repoRoot);
    if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(idx, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
  }

  async mutate<T>(fn: (idx: FpLedgerIndex) => { next: FpLedgerIndex; result: T }): Promise<T> {
    if (!existsSync(learningsDir(this.repoRoot)))
      mkdirSync(learningsDir(this.repoRoot), { recursive: true });
    const lock = await flock(fpLedgerLockPath(this.repoRoot));
    try {
      const cur = await this.snapshot();
      const { next, result } = fn(structuredClone(cur));
      FpLedgerIndexSchema.parse(next);
      this.persist(next);
      return result;
    } finally {
      await lock.release();
    }
  }

  async recordReject(
    signature: string,
    meta: RejectMeta,
    reject: { run_id: string; provider: string; reason: string },
    nowIso: string,
  ): Promise<void> {
    const nowMs = Date.parse(nowIso);
    await this.mutate((idx) => {
      let e = idx.entries.find((x) => x.signature === signature);
      if (!e) {
        e = {
          id: `FP-${String(nextIdNumber(idx.entries) + 1).padStart(3, "0")}`,
          signature,
          rule_id: meta.rule_id,
          category: meta.category,
          file: meta.file,
          symbol: meta.symbol,
          stage: "candidate",
          rejects: [],
          distinct_providers: [],
          first_seen_at: nowIso,
          last_seen_at: nowIso,
          created_at: nowIso,
        };
        idx.entries.push(e);
      }
      // Idempotent on (run_id, provider): a re-invocation of absorbPriorDecisions
      // (e.g. an escalated gate re-fires its stop-hook on the same iter's
      // decisions before commit-recovery resets state.iteration) MUST NOT
      // double-count the same rejection. Reputation already has this
      // guarantee via its `eid` field; this mirrors it for the FP ledger.
      const dup = e.rejects.some(
        (r) => r.run_id === reject.run_id && r.provider === reject.provider,
      );
      if (dup) {
        // Still bump last_seen_at so decay doesn't reap a re-confirmed entry.
        e.last_seen_at = nowIso;
        return { next: idx, result: undefined };
      }
      e.rejects.push({ ...reject, ts: nowIso });
      e.last_seen_at = nowIso;
      const updated = recompute(e, nowMs);
      Object.assign(e, updated);
      return { next: idx, result: undefined };
    });
  }

  async pin(id: string, by: string): Promise<boolean> {
    return this.mutate((idx) => {
      const e = idx.entries.find((x) => x.id === id);
      if (e) {
        e.pinned_by = by;
        e.stage = "sticky";
      }
      return { next: idx, result: Boolean(e) };
    });
  }

  async unpin(id: string): Promise<boolean> {
    return this.mutate((idx) => {
      const e = idx.entries.find((x) => x.id === id);
      if (e) {
        e.pinned_by = undefined;
        Object.assign(e, recompute(e, Date.now()));
      }
      return { next: idx, result: Boolean(e) };
    });
  }

  // candidate removed after 90d no new match; active→candidate after 180d.
  // sticky is RE-EVALUATED against the current window (not blindly kept): a sticky
  // whose qualifying rejects have all aged past STICKY_DAYS must fall back to
  // active/candidate, else it would suppress a genuinely-real finding at the same
  // signature forever (F-017). recompute() honours pinned_by, so a pinned sticky
  // stays sticky regardless of age.
  async decayPass(nowIso: string): Promise<void> {
    const nowMs = Date.parse(nowIso);
    await this.mutate((idx) => {
      const recomputed = idx.entries.map((e) => (e.stage === "sticky" ? recompute(e, nowMs) : e));
      const kept = recomputed.filter((e) => {
        if (e.stage === "sticky") return true;
        const ageDays = (nowMs - Date.parse(e.last_seen_at)) / DAY_MS;
        if (e.stage === "candidate") return ageDays <= 90;
        return true; // active: demote (not drop) below
      });
      for (const e of kept) {
        if (e.stage === "active" && (nowMs - Date.parse(e.last_seen_at)) / DAY_MS > 180) {
          e.stage = "candidate";
        }
      }
      return { next: { ...idx, entries: kept }, result: undefined };
    });
  }

  // active + sticky entries, keyed by signature, for prompt + aggregator use.
  // When `now` is given, each entry's stage is re-evaluated against the current
  // time window at read time (recompute is pure) so a stale sticky/active whose
  // qualifying rejects have aged out is never served as suppressing — the
  // read-time guarantee complementing decayPass's persisted self-heal (F-017).
  // Omitting `now` preserves the legacy persisted-stage read (used by tests/CLI).
  async activeSnapshot(now?: Date): Promise<Map<string, FpLedgerEntry>> {
    const snap = await this.snapshot();
    const nowMs = now ? now.getTime() : null;
    const m = new Map<string, FpLedgerEntry>();
    for (const e of snap.entries) {
      const eff = nowMs !== null ? recompute(e, nowMs) : e;
      if (eff.stage !== "candidate") m.set(eff.signature, eff);
    }
    return m;
  }
}
