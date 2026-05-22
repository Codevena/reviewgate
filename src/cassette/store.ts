// src/cassette/store.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type CassetteEntry, CassetteEntrySchema } from "../schemas/cassette.ts";

// Append-only JSONL: a single appendFileSync of one line is atomic on POSIX, so the
// concurrent panel (Promise.allSettled) can record without a lock or lost entries.
// Single-process only — cross-process recording to one cassette is unsupported.
export async function appendEntry(path: string, entry: CassetteEntry): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export function loadCassette(path: string): CassetteEntry[] {
  const raw = readFileSync(path, "utf8");
  const out: CassetteEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(CassetteEntrySchema.parse(JSON.parse(t)));
    } catch {
      console.warn(`cassette: skipping malformed line in ${path}`);
    }
  }
  return out;
}

export interface CassetteEnv {
  mode: "record" | "replay";
  path: string;
}

// Parse REVIEWGATE_CASSETTE="record:<path>" | "replay:<path>". `value` defaults to
// the env var so callers can pass it explicitly in tests.
export function cassetteFromEnv(
  value: string | undefined = process.env.REVIEWGATE_CASSETTE,
): CassetteEnv | null {
  if (!value) return null;
  const m = value.match(/^(record|replay):(.+)$/);
  if (!m) return null;
  return { mode: m[1] as "record" | "replay", path: m[2] as string };
}
