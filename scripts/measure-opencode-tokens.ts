// scripts/measure-opencode-tokens.ts
// Token oracle for Qwen cost measurements. opencode records per-call token usage
// in its own session DB; reading it is free and immediate, where the Bailian
// console is a manual round-trip that only aggregates by the hour.
//
// Coefficient measured 2026-08-07: 2.38% of the 2500-credit weekly window for
// 49,043 tokens = 1.21 credits per 1K tokens. `total` already includes cached
// input, and the credit weighting of cached vs. uncached input is unknown — so
// this is an upper-bound estimate whenever the cache is hot.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TokenUsage {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export const DEFAULT_DB_PATH = join(homedir(), ".local/share/opencode/opencode.db");
export const CREDITS_PER_1K_TOKENS = 1.21;

export function readLatestUsage(
  model: string,
  limit = 50,
  dbPath: string = DEFAULT_DB_PATH,
): TokenUsage | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query("select data from message order by rowid desc limit ?")
      .all(limit) as Array<{ data: string }>;
    for (const row of rows) {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(row.data) as Record<string, unknown>;
      } catch {
        continue; // a malformed row is not a reason to lose the measurement
      }
      const id = (message.modelID ?? message.model) as string | undefined;
      if (id !== model) continue;
      const t = message.tokens as
        | {
            total?: number;
            input?: number;
            output?: number;
            reasoning?: number;
            cache?: { read?: number; write?: number };
          }
        | undefined;
      if (!t) continue;
      return {
        total: t.total ?? 0,
        input: t.input ?? 0,
        output: t.output ?? 0,
        reasoning: t.reasoning ?? 0,
        cacheRead: t.cache?.read ?? 0,
        cacheWrite: t.cache?.write ?? 0,
      };
    }
    return null;
  } finally {
    db.close();
  }
}

export function creditsFor(usage: TokenUsage, perThousand = CREDITS_PER_1K_TOKENS): number {
  return (usage.total / 1000) * perThousand;
}

if (import.meta.main) {
  const model = process.argv[2] ?? "qwen3.8-max";
  const usage = readLatestUsage(model);
  if (!usage) {
    console.error(`no usage recorded for model "${model}"`);
    process.exit(1);
  }
  // process.stdout.write, not console.log: biome's lint/suspicious/noConsoleLog flags
  // it and the global CLAUDE.md forbids console.log in favour of console.warn/error.
  // `scripts/` sits outside both the lint glob (`src tests bin`) and the format glob
  // (`src tests`), so nothing catches this today — but a later widening would.
  process.stdout.write(
    `${JSON.stringify({ model, ...usage, credits: Number(creditsFor(usage).toFixed(2)) }, null, 2)}\n`,
  );
}
