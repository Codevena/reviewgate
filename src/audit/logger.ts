// src/audit/logger.ts
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AuditEvent, EventType, Trigger } from "../schemas/audit-event.ts";
import { AuditEventSchema } from "../schemas/audit-event.ts";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function canonical(o: unknown): string {
  // Stable stringify with sorted keys at every level.
  if (o === null || typeof o !== "object") return JSON.stringify(o);
  if (Array.isArray(o)) return `[${o.map(canonical).join(",")}]`;
  const keys = Object.keys(o as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((o as Record<string, unknown>)[k])}`).join(",")}}`;
}

export type AuditEventInput = {
  event: EventType;
  run_id: string;
  iter: number;
  trigger: Trigger;
} & Partial<Omit<AuditEvent, "schema" | "ts" | "prev_event_hash" | "this_event_hash">>;

export class AuditLogger {
  private lastHash = "";
  private filePath: string | null = null;
  private pruned = false;

  // `retentionDays` enforces config's `audit.retentionDays` (previously declared
  // but NEVER applied → the log grew forever): day-partitions older than the cutoff
  // are deleted once per logger lifetime, on the first append. null/<=0 disables
  // pruning (back-compat: the bare `new AuditLogger(dir)` callers are unaffected).
  constructor(
    private readonly auditDir: string,
    private readonly retentionDays: number | null = null,
  ) {}

  currentFilePath(): string {
    if (!this.filePath) this.filePath = this.computePath();
    return this.filePath;
  }

  // Prune whole day-partition directories (audit/YYYY/MM/DD) whose date is older
  // than `retentionDays` before today (UTC). Day-granularity matches the on-disk
  // layout written by computePath() and avoids rewriting hash-chained files (which
  // would invalidate the chain). Best-effort + idempotent: runs at most once per
  // logger instance and swallows fs errors so a prune hiccup never blocks an append.
  private pruneOldEntries(): void {
    if (this.pruned) return;
    this.pruned = true;
    const days = this.retentionDays;
    if (days === null || !Number.isFinite(days) || days <= 0) return;
    if (!existsSync(this.auditDir)) return;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    try {
      for (const yEnt of readdirSync(this.auditDir, { withFileTypes: true })) {
        if (!yEnt.isDirectory() || !/^\d{4}$/.test(yEnt.name)) continue;
        const yDir = join(this.auditDir, yEnt.name);
        for (const mEnt of readdirSync(yDir, { withFileTypes: true })) {
          if (!mEnt.isDirectory() || !/^\d{2}$/.test(mEnt.name)) continue;
          const mDir = join(yDir, mEnt.name);
          for (const dEnt of readdirSync(mDir, { withFileTypes: true })) {
            if (!dEnt.isDirectory() || !/^\d{2}$/.test(dEnt.name)) continue;
            // The directory date is the LAST moment of that UTC day (end-of-day):
            // only prune once the whole day is older than the cutoff.
            const dayEnd = Date.UTC(
              Number(yEnt.name),
              Number(mEnt.name) - 1,
              Number(dEnt.name) + 1,
            );
            if (dayEnd < cutoff) {
              rmSync(join(mDir, dEnt.name), { recursive: true, force: true });
            }
          }
        }
      }
    } catch {
      /* best-effort: never let pruning block an append */
    }
  }

  private computePath(): string {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    const dir = join(this.auditDir, String(y), m, d);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stamp = `${now.getUTCHours()}${String(now.getUTCMinutes()).padStart(2, "0")}${String(now.getUTCSeconds()).padStart(2, "0")}`;
    return join(dir, `${stamp}.jsonl`);
  }

  async append(input: AuditEventInput): Promise<AuditEvent> {
    // Enforce retention before writing (once per logger lifetime). Pruning happens
    // ON write so the log can't grow forever between sessions without ever being
    // trimmed; today's partition is never a prune target.
    this.pruneOldEntries();
    const base = {
      schema: "reviewgate.audit.v1" as const,
      ts: new Date().toISOString(),
      ...input,
      prev_event_hash: this.lastHash,
      this_event_hash: "",
    };
    const forHash = { ...base };
    (forHash as { this_event_hash?: unknown }).this_event_hash = undefined;
    const h = sha256(canonical(forHash));
    const event = AuditEventSchema.parse({ ...base, this_event_hash: h });
    appendFileSync(this.currentFilePath(), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    this.lastHash = h;
    return event;
  }
}
