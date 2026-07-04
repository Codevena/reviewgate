import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { neutralizeInjectionMarkers } from "../../diff/sanitizer.ts";
import { normalizeRuleId } from "../../diff/signature.ts";
import {
  type AgentLessonsIndex,
  AgentLessonsIndexSchema,
  type LessonEntry,
} from "../../schemas/agent-lessons.ts";
import type { FindingCategory } from "../../schemas/finding.ts";
import { flock } from "../../utils/flock.ts";
import { agentLessonsLockPath, agentLessonsPath, learningsDir } from "../../utils/paths.ts";

const DAY_MS = 86_400_000;
const EMPTY: AgentLessonsIndex = { schema: "reviewgate.agentlessons.v1", entries: [] };

export interface OccurrenceMeta {
  category: FindingCategory;
  rule_id: string;
  message: string; // caller sanitizes + clamps before passing
  file: string;
}

// Recurrence key: category + drift-tolerant rule_id. Same-mistake-different-line
// (distinct signatures) collapses into ONE lesson; the signature stays per-occurrence
// for idempotency only.
export function lessonKey(category: string, ruleId: string): string {
  return createHash("sha256")
    .update(`${category}|${normalizeRuleId(ruleId)}`)
    .digest("hex");
}

// Preserve a corrupt file for forensics before recovering empty (mirrors FpLedgerStore).
function backupCorrupt(p: string): void {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    renameSync(p, `${p}.corrupt.${ts}`);
  } catch {
    // best-effort only
  }
}

function maxEntryId(entries: LessonEntry[]): number {
  let max = 0;
  for (const e of entries) {
    const n = Number.parseInt(e.id.replace(/^AL-/, ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

export class AgentLessonsStore {
  constructor(private readonly repoRoot: string) {}

  // opts.backupCorrupt === false makes this a PURE read: a corrupt file is NOT renamed
  // (no fs mutation at all). The SessionStart injection + learn-status pass this so those
  // read-only paths never mutate .reviewgate/learnings/ (plan-gate WARN). The write path
  // (mutate) uses the default true so a corrupt store self-heals on the next write.
  async snapshot(opts?: { backupCorrupt?: boolean }): Promise<AgentLessonsIndex> {
    const p = agentLessonsPath(this.repoRoot);
    if (!existsSync(p)) return EMPTY;
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
      // A transient I/O error on an EXISTING store must NOT be misread as "empty" —
      // inside mutate() that empty snapshot would be atomically persisted, wiping every
      // accumulated lesson. Rethrow so the mutate fails loudly (the learn path .catch()es
      // → "no learning this round", not data loss). Mirrors FpLedgerStore.snapshot.
      throw err;
    }
    try {
      return AgentLessonsIndexSchema.parse(JSON.parse(raw));
    } catch {
      if (opts?.backupCorrupt !== false) backupCorrupt(p);
      return EMPTY;
    }
  }

  private persist(idx: AgentLessonsIndex): void {
    const p = agentLessonsPath(this.repoRoot);
    if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(idx, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
  }

  async mutate<T>(
    fn: (idx: AgentLessonsIndex) => { next: AgentLessonsIndex; result: T },
  ): Promise<T> {
    if (!existsSync(learningsDir(this.repoRoot)))
      mkdirSync(learningsDir(this.repoRoot), { recursive: true });
    const lock = await flock(agentLessonsLockPath(this.repoRoot));
    try {
      const cur = await this.snapshot();
      const { next, result } = fn(structuredClone(cur));
      AgentLessonsIndexSchema.parse(next);
      this.persist(next);
      return result;
    } finally {
      await lock.release();
    }
  }

  async recordOccurrence(
    meta: OccurrenceMeta,
    occ: { run_id: string; session_id: string; signature: string },
    nowIso: string,
  ): Promise<void> {
    const key = lessonKey(meta.category, meta.rule_id);
    // Human-readable display form: the RAW rule_id, but DEFANGED at write — injection markers
    // neutralized + backticks stripped — so it is safe rendered into injected lesson text AND
    // pending.md code spans, at every render site, without per-site sanitizing (plan-gate WARN).
    // The stored `rule_id` stays the normalized bucket token that matches `key`.
    const displayRuleId = neutralizeInjectionMarkers(meta.rule_id.trim()).replace(/`/g, "");
    await this.mutate((idx) => {
      let e = idx.entries.find((x) => x.key === key);
      if (!e) {
        const nextNum = Math.max(idx.seq ?? 0, maxEntryId(idx.entries)) + 1;
        idx.seq = nextNum;
        e = {
          id: `AL-${String(nextNum).padStart(3, "0")}`,
          key,
          category: meta.category,
          rule_id: normalizeRuleId(meta.rule_id),
          display_rule_id: displayRuleId,
          occurrences: [],
          exemplar_message: meta.message,
          first_seen_at: nowIso,
          last_seen_at: nowIso,
        };
        idx.entries.push(e);
      }
      // Idempotent on (run_id, signature): re-absorbing the same iteration's decisions
      // (e.g. an escalated gate re-firing its stop-hook before commit-recovery) must not
      // double-count. Mirrors the FP-ledger's (run_id, provider) dedup — and is why we
      // never cap occurrences (a dropped occurrence could no longer be seen as a dup).
      const dup = e.occurrences.some(
        (o) => o.run_id === occ.run_id && o.signature === occ.signature,
      );
      // True no-op on re-absorb. Unlike the FP-ledger (whose candidate decay keys on
      // entry.last_seen_at, so it bumps it here), our TTL decay keys on each
      // occurrence.ts — so a duplicate must touch NOTHING, or it would nudge the
      // ranking recency tiebreak without a real new occurrence (plan-gate WARN).
      if (dup) return { next: idx, result: undefined };
      e.occurrences.push({
        run_id: occ.run_id,
        session_id: occ.session_id,
        signature: occ.signature,
        file: meta.file,
        ts: nowIso,
      });
      e.exemplar_message = meta.message; // most-recent sanitized message wins
      e.display_rule_id = displayRuleId; // most-recent raw (sanitized) rule_id wins, like exemplar_message
      e.last_seen_at = nowIso;
      return { next: idx, result: undefined };
    });
  }

  // TTL decay: drop occurrences older than ttlDays; an entry left with none is removed.
  async decayPass(nowIso: string, ttlDays: number): Promise<void> {
    const nowMs = Date.parse(nowIso);
    await this.mutate((idx) => {
      const entries: LessonEntry[] = [];
      for (const e of idx.entries) {
        const kept = e.occurrences.filter((o) => (nowMs - Date.parse(o.ts)) / DAY_MS <= ttlDays);
        if (kept.length === 0) continue;
        // Re-derive the seen-at bounds from the SURVIVING occurrences so ranking/display
        // metadata never references a pruned event (plan-gate INFO).
        const times = kept.map((o) => Date.parse(o.ts)).sort((a, b) => a - b);
        const firstMs = times.at(0);
        const lastMs = times.at(-1);
        if (firstMs === undefined || lastMs === undefined) continue; // defensive, unreachable
        entries.push({
          ...e,
          occurrences: kept,
          first_seen_at: new Date(firstMs).toISOString(),
          last_seen_at: new Date(lastMs).toISOString(),
        });
      }
      return { next: { ...idx, entries }, result: undefined };
    });
  }
}
