// src/cli/commands/reset.ts
import { existsSync } from "node:fs";
import { handleReset } from "../../hooks/handlers.ts";
import { reviewgateDir } from "../../utils/paths.ts";

export interface ResetCommandInput {
  repoRoot: string;
  // Injectable for tests; defaults to process.stdout (matches the fp/stats commands).
  write?: (s: string) => void;
}

/**
 * User-facing `reviewgate reset`: re-arm the gate by clearing this session's
 * review state. Shares handleReset with the SessionStart hook (1:1 parity) and
 * reads NO stdin, so it cannot hang on an interactive TTY. Always exits 0 —
 * reset is idempotent and best-effort.
 */
export async function runReset(input: ResetCommandInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  if (!existsSync(reviewgateDir(input.repoRoot))) {
    out(
      "🔄 Reviewgate reset — this directory doesn't look like a Reviewgate-initialised repo (no .reviewgate/). Nothing to do.\n",
    );
    return 0;
  }
  const { cleared } = await handleReset({ repoRoot: input.repoRoot });
  if (cleared.length === 0) {
    out("🔄 Reviewgate reset — gate re-armed (nothing to clear).\n");
    return 0;
  }
  out("🔄 Reviewgate reset — gate re-armed.\n");
  out(`   Cleared: ${cleared.join(", ")}.\n`);
  out("   Preserved: FP-ledger & brain.\n");
  return 0;
}
