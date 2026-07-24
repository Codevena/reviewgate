// src/schemas/quota-cooldown.ts
import { z } from "zod";

// Persistent per-provider quota cooldown. Survives SessionStart resets (it is the
// account's quota state, not per-session), so it lives in its OWN file under
// .reviewgate/ — NOT in state.json (which `--hook reset` wipes).
export const QuotaCooldownSchema = z.object({
  schema: z.literal("reviewgate.quota-cooldown.v1"),
  providers: z.record(
    z.string(),
    z.object({
      reset_at: z.string(), // ISO; the provider is considered capped until this
      recorded_at: z.string(),
      source: z.enum(["parsed", "default"]), // whether reset_at came from the error text
      // Consecutive default-source failures (timeout / silent agy quota stall with no
      // parseable reset). Drives the escalating backoff in recordBackoff: 5min → 20min
      // → 4h cap. Absent/0 on a parsed reset (we know the exact reset, no guessing).
      // Optional for back-compat with cooldown files written before this field existed.
      consecutive_failures: z.number().int().nonnegative().optional(),
      // The CAUSE of a default-source backoff: a genuine quota/rate-limit signal, an
      // INFERRED quota (a guess off a zero-output stall — agy's banner is TTY-only), a
      // reviewer timeout, or a slow error. Lets the degradation note label honestly
      // ("quota inferred, unconfirmed" / "timed out — backing off" vs "quota until")
      // instead of calling every backoff "quota" (field reports: a merely-slow reviewer
      // reported as quota-capped 2026-06; an agy crawl-hang reported as a confident
      // quota cap 2026-07-23). A "parsed" reset is always a real quota, so it carries
      // none. Optional for back-compat; old enum values remain valid.
      reason: z.enum(["quota", "inferred-quota", "timeout", "error"]).optional(),
    }),
  ),
});

export type QuotaCooldown = z.infer<typeof QuotaCooldownSchema>;
