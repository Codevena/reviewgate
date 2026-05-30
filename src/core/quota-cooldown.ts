// src/core/quota-cooldown.ts
// Remembers WHEN a quota-capped provider's limit resets, so the gate can skip it
// straight to the fallback while capped (saving the ~7s failed primary attempt
// every review) and automatically resume using it once the reset passes — no
// timer, no config edit. The cooldown is best-effort: if the reset time can't be
// parsed from the provider's error, a conservative DEFAULT window is used.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type QuotaCooldown, QuotaCooldownSchema } from "../schemas/quota-cooldown.ts";

/** Fallback cooldown when the error carries no parseable reset time. */
export const DEFAULT_COOLDOWN_MS = 15 * 60_000;
/** Reject a parsed reset further out than this (guards against garbage dates). */
const MAX_COOLDOWN_MS = 30 * 24 * 60 * 60_000; // 30 days
/**
 * How long to keep SKIPPING a cooled-down provider before re-probing it once.
 * A parsed reset can over-estimate (a provider often recovers BEFORE the time it
 * quoted), and while skipping we never retry it — so without this the strongest
 * reviewer stays idle for days after it is actually back. Re-probe at most once
 * per window: one ~7s failed attempt if still capped, vs. early-recovery detection
 * within the window.
 */
export const REPROBE_INTERVAL_MS = 30 * 60_000;

/**
 * Extract the reset time from a quota/rate-limit error. Handles codex's
 * "try again at May 27th, 2026 12:57 AM." banner and generic "retry after N
 * seconds". Returns an ISO string strictly in (now, now+30d], else null.
 */
export function parseQuotaResetAt(text: string | undefined | null, now: Date): string | null {
  if (!text) return null;

  // "retry after 120 seconds" / "retry-after: 120"
  const after = text.match(/retry[ -]?after:?\s*(\d+)\s*(seconds?|secs?|s)?\b/i);
  if (after) {
    const secs = Number(after[1]);
    if (Number.isFinite(secs) && secs > 0) {
      const t = now.getTime() + secs * 1000;
      if (t - now.getTime() <= MAX_COOLDOWN_MS) return new Date(t).toISOString();
    }
  }

  // "try again at <date>" — capture up to the first delimiter (period, quote,
  // brace, comma-quote, or newline) so a banner embedded in JSONL events
  // ("…12:57 AM.\"}}") doesn't swallow the trailing JSON into the date string.
  // Strip ordinal suffixes (27th → 27) before parsing.
  const at = text.match(/try again (?:at|on)\s+([^."}\n]+)/i);
  if (at?.[1]) {
    const cleaned = at[1].replace(/(\d{1,2})(st|nd|rd|th)\b/gi, "$1").trim();
    const t = Date.parse(cleaned);
    if (Number.isFinite(t) && t > now.getTime() && t - now.getTime() <= MAX_COOLDOWN_MS) {
      return new Date(t).toISOString();
    }
  }

  // agy's relative "Resets in 25m38s" / "resets in 1h2m3s" / "resets in 90s". The
  // duration group is all-optional, so a bare "resets in <words>" captures empty →
  // 0 seconds → ignored (not treated as a reset).
  const rel = text.match(/resets? in\s+((?:\d+\s*h)?(?:\d+\s*m)?(?:\d+\s*s)?)/i);
  if (rel?.[1]) {
    const h = /(\d+)\s*h/i.exec(rel[1]);
    const m = /(\d+)\s*m/i.exec(rel[1]);
    const s = /(\d+)\s*s/i.exec(rel[1]);
    const secs =
      (h ? Number(h[1]) * 3600 : 0) + (m ? Number(m[1]) * 60 : 0) + (s ? Number(s[1]) : 0);
    if (secs > 0) {
      const t = now.getTime() + secs * 1000;
      if (t - now.getTime() <= MAX_COOLDOWN_MS) return new Date(t).toISOString();
    }
  }
  return null;
}

const EMPTY: QuotaCooldown = { schema: "reviewgate.quota-cooldown.v1", providers: {} };

/**
 * File-backed per-provider cooldown store (.reviewgate/quota-cooldowns.json).
 * Synchronous read-modify-write — the orchestrator applies all updates ONCE after
 * the (parallel) panel settles, so there is no concurrent writer.
 */
export class QuotaCooldownStore {
  private readonly path: string;
  constructor(repoRoot: string) {
    this.path = join(repoRoot, ".reviewgate", "quota-cooldowns.json");
  }

  private read(): QuotaCooldown {
    if (!existsSync(this.path)) return structuredClone(EMPTY);
    try {
      return QuotaCooldownSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private write(c: QuotaCooldown): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Atomic: write to a unique temp, then rename into place — a process killed
    // mid-write can never leave a truncated quota-cooldowns.json (mirrors
    // StateStore.writeAtomic). Unique suffix so concurrent writers don't share a tmp.
    const tmp = `${this.path}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** ISO reset time if `provider` is still capped at `now`, else null. */
  activeUntil(provider: string, now: Date): string | null {
    const e = this.read().providers[provider];
    if (!e) return null;
    return Date.parse(e.reset_at) > now.getTime() ? e.reset_at : null;
  }

  /**
   * The reset time to SKIP `provider` until, or null if it should be ATTEMPTED.
   * Skips while the cooldown is active AND it was recorded within the last
   * REPROBE_INTERVAL — so once that window elapses the provider is re-probed once
   * (returns null → don't skip) to catch an early recovery before the parsed
   * reset. A successful re-probe clears the cooldown; a still-capped one re-records
   * it (resetting the window). Distinct from `activeUntil`, which `doctor` uses to
   * SHOW the cooldown regardless of the re-probe window.
   */
  skipUntil(provider: string, now: Date): string | null {
    const e = this.read().providers[provider];
    if (!e) return null;
    if (Date.parse(e.reset_at) <= now.getTime()) return null; // cooldown expired
    if (now.getTime() - Date.parse(e.recorded_at) >= REPROBE_INTERVAL_MS) return null; // due to re-probe
    return e.reset_at;
  }

  /** Record (or refresh) a cooldown for `provider` until `resetAt`. */
  record(
    provider: string,
    resetAt: string,
    now: Date,
    source: "parsed" | "default" = "parsed",
  ): void {
    const c = this.read();
    c.providers[provider] = { reset_at: resetAt, recorded_at: now.toISOString(), source };
    this.write(c);
  }

  /** Clear a provider's cooldown (it ran successfully → quota recovered). */
  clear(provider: string): void {
    const c = this.read();
    if (!c.providers[provider]) return;
    delete c.providers[provider];
    this.write(c);
  }

  /** Snapshot of providers currently capped at `now` → their reset time. */
  activeSnapshot(now: Date): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [p, e] of Object.entries(this.read().providers)) {
      if (Date.parse(e.reset_at) > now.getTime()) out[p] = e.reset_at;
    }
    return out;
  }
}
