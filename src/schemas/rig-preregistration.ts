// src/schemas/rig-preregistration.ts
// What a rig run commits to BEFORE it is allowed to run.
//
// Preregistration is the only mechanism that stops a post-hoc story being told about whichever
// number happened to look good. It is frozen in git before the pilot starts, so the direction
// each metric was EXPECTED to move is on record independently of how it actually moved. The
// same discipline `bench/preregistrations/` already follows — that schema is corpus-shaped
// (cases, repeats), so the rig gets its own rather than a distorted reuse.
import { z } from "zod";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);

export const RigPreregistrationSchema = z
  .object({
    schema: z.literal("reviewgate.rig.preregistration.v1"),
    registered_at: z.string(),
    /** The Reviewgate build being MEASURED — the gate binary the sandbox's hooks invoke. */
    release: z.string().min(1),
    attempt: z.string().min(1),
    /** The exact command the run will be started with, argv-split. */
    command: z.array(z.string()).min(3),
    roster: z
      .object({
        reviewers: z
          .array(
            z.object({ provider: z.string(), model: z.string(), persona: z.string() }).strict(),
          )
          // >= 2 distinct providers is a HARD constraint, not a preference: with one reviewer
          // consensus, FP-ledger promotion and reputation-demote are all inert, which is half
          // the suppression stack the rig exists to measure.
          .min(2),
        substitution_allowed: z.literal(false),
      })
      .strict()
      .refine((r) => new Set(r.reviewers.map((x) => x.provider)).size >= 2, {
        message: "at least two DISTINCT providers are required (see S-5)",
      }),
    turn_script: z
      .object({
        path: z.string(),
        id: z.string(),
        sha256: Sha256Schema,
        turns: z.number().int().positive(),
        seeded: z.number().int().positive(),
        clean: z.number().int().nonnegative(),
      })
      .strict(),
    /** Primary metrics are the ones the run is allowed to make a claim about. */
    metrics: z
      .object({
        primary: z.array(z.string()).min(1),
        exploratory: z.array(z.string()),
        /** Declared IN ADVANCE, per metric: the direction expected and why. */
        expectations: z.array(
          z
            .object({
              metric: z.string(),
              direction: z.enum(["higher-is-better", "lower-is-better", "descriptive"]),
              prediction: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
    hard_gates: z
      .object({
        max_turns: z.number().int().positive(),
        /** Abort rather than quietly continue past this many failed agent turns. */
        max_failed_turns: z.number().int().nonnegative(),
        cassette_required: z.literal(true),
      })
      .strict(),
    /** Stated up front so they cannot be discovered conveniently late. */
    known_limitations: z.array(z.string()).min(1),
  })
  .strict();

export type RigPreregistration = z.infer<typeof RigPreregistrationSchema>;
