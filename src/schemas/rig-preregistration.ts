// src/schemas/rig-preregistration.ts
// What a rig run commits to BEFORE it is allowed to run.
//
// Preregistration is the only mechanism that stops a post-hoc story being told about whichever
// number happened to look good. It is frozen in git before the pilot starts, so the direction
// each metric was EXPECTED to move is on record independently of how it actually moved. The
// same discipline `bench/preregistrations/` already follows — that schema is corpus-shaped
// (cases, repeats), so the rig gets its own rather than a distorted reuse.
import { z } from "zod";

// LOWERCASE only, deliberately unlike bench's case-insensitive twin: `shasum`/`sha256sum`
// emit lowercase, and accepting both cases would let two spellings of the SAME hash compare
// unequal as strings — an integrity field that silently fails to match is worse than one that
// refuses the input.
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * A repo-relative path with no traversal.
 *
 * The field is declarative — nothing resolves it at parse time — but it names the file whose
 * hash pins this run's ground truth, and a preregistration is exactly the document where a
 * quietly-wrong path must not be representable.
 */
const RepoRelativePathSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, "must be a repo-relative path")
  .refine((p) => !p.split("/").includes(".."), { message: "must not contain a '..' segment" });

export const RigPreregistrationSchema = z
  .object({
    schema: z.literal("reviewgate.rig.preregistration.v1"),
    // ISO-8601, not a bare string: the ENTIRE claim a preregistration makes is "this was
    // written before the run". A field that accepts "soon", "" or a non-date cannot carry
    // that claim, and the format check is what makes the freeze time machine-verifiable
    // rather than a convention.
    registered_at: z.string().datetime(),
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
        path: RepoRelativePathSchema,
        id: z.string(),
        sha256: Sha256Schema,
        turns: z.number().int().positive(),
        seeded: z.number().int().positive(),
        clean: z.number().int().nonnegative(),
      })
      .strict()
      // seeded + clean MUST account for every turn. Without this an inconsistent trio
      // validates, and since recall's denominator is the seeded count, a preregistration
      // claiming 5 seeded of 12 turns while the script has 4 would go unnoticed.
      .refine((s) => s.seeded + s.clean === s.turns, {
        message: "seeded + clean must equal turns",
        path: ["turns"],
      }),
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
      .strict()
      // EVERY primary metric needs a pre-committed direction. This is the refinement that
      // makes preregistration mean anything: without it a document can name M2 and M3 as the
      // metrics it will make claims about, commit expectations for neither, and after the run
      // add an expectation for whichever one happened to look good — while still being able to
      // point at a file frozen in git. That is the precise failure preregistration exists to
      // prevent, so it is enforced rather than trusted.
      .refine(
        (m) => {
          const declared = new Set(m.expectations.map((e) => e.metric));
          return m.primary.every((p) => declared.has(p));
        },
        {
          message: "every primary metric must have a pre-committed expectation",
          path: ["expectations"],
        },
      ),
    hard_gates: z
      .object({
        max_turns: z.number().int().positive(),
        /** Abort rather than quietly continue past this many failed agent turns. */
        max_failed_turns: z.number().int().nonnegative(),
        cassette_required: z.literal(true),
      })
      .strict()
      // A gate that can be set to "never fire" is not a gate. max_failed_turns >= max_turns
      // means every turn could fail and the run would still be allowed to finish and report,
      // and because preregistrations are frozen before the run there is no later recourse.
      .refine((g) => g.max_failed_turns < g.max_turns, {
        message: "max_failed_turns must be < max_turns, or the abort gate can never fire",
        path: ["max_failed_turns"],
      }),
    /** Stated up front so they cannot be discovered conveniently late. */
    known_limitations: z.array(z.string()).min(1),
  })
  .strict();

export type RigPreregistration = z.infer<typeof RigPreregistrationSchema>;
