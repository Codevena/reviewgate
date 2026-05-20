// src/audit/logger.ts
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
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

  constructor(private readonly auditDir: string) {}

  currentFilePath(): string {
    if (!this.filePath) this.filePath = this.computePath();
    return this.filePath;
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
