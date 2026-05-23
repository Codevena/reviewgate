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
    }),
  ),
});

export type QuotaCooldown = z.infer<typeof QuotaCooldownSchema>;
