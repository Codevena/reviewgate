// src/schemas/rig-turn-script.ts
// The scripted turn list a longitudinal rig run drives a headless agent through. One
// entry per turn: what to ask for, and — when the turn deliberately introduces a known
// defect — the ground truth that makes recall measurable. Without a label there is no
// ground truth, and a run can only ever report precision plus impressions.
import { z } from "zod";

export const RigSeededDefectSchema = z
  .object({
    id: z.string().min(1),
    // Any-of phrasings, the same convention bench/cases/*/case.json labels use: a finding
    // counts as a catch when it mentions any ONE of these. Reviewers word the same defect
    // differently run to run, so a single exact string would score wording, not detection.
    tags: z.array(z.string().min(1)).min(1),
    severity: z.enum(["critical", "warn"]),
  })
  .strict();

export const RigTurnSchema = z
  .object({
    index: z.number().int().positive(),
    prompt: z.string().min(1),
    seeded: RigSeededDefectSchema.nullable(),
  })
  .strict();

export const RigTurnScriptSchema = z
  .object({
    schema: z.literal("reviewgate.rig.turn-script.v1"),
    // Charset-constrained, not just non-empty: the id is interpolated into the run id and
    // persisted in the manifest, and any later code that derives a path from it (an obvious
    // thing to do — one directory per run) would inherit a traversal from a `../` in a
    // user-supplied JSON file. Constraining it HERE fixes it for every consumer at once,
    // rather than asking each one to sanitise (gate finding F-004).
    id: z
      .string()
      .min(1)
      .regex(
        /^[A-Za-z0-9._-]+$/,
        "id must contain only letters, digits, dot, underscore or hyphen",
      ),
    turns: z.array(RigTurnSchema).min(1),
  })
  .strict()
  // Contiguous 1..n indices: the harvester joins per-turn snapshots to turns BY INDEX, so
  // a gap would silently drop a turn's ground truth — a seeded defect would vanish from
  // the recall denominator instead of failing loudly.
  .refine((s) => s.turns.every((t, i) => t.index === i + 1), {
    message: "turn indices must be contiguous starting at 1",
  });

export type RigSeededDefect = z.infer<typeof RigSeededDefectSchema>;
export type RigTurn = z.infer<typeof RigTurnSchema>;
export type RigTurnScript = z.infer<typeof RigTurnScriptSchema>;
