// src/schemas/rig-manifest.ts
// What `reviewgate rig run` writes after every turn and `rig harvest` reads back.
//
// It gets a schema for the same reason every other persisted artifact here does: the
// harvester consumes this file from disk, possibly written by an older binary or hand-edited
// after a partial run, and it derives ground-truth attribution from it. A `JSON.parse` +
// structural trust would let a missing `turns` entry read as "this run had fewer turns"
// rather than as a broken artifact. The driver's own types are inferred from this schema so
// the writer and the reader cannot drift apart.
import { z } from "zod";

export const RigManifestTurnSchema = z
  .object({
    index: z.number().int().positive(),
    /** Absolute path recorded at run time; the harvester prefers the manifest-relative
     *  location so a results directory stays harvestable after it is moved. */
    snapshotDir: z.string().min(1),
    agentExitCode: z.number().int(),
    wallMs: z.number().int().nonnegative(),
    /**
     * Did the gate actually review this turn? `false` means the turn produced no measurement:
     * the change was still flagged at turn end and no audit events were written. An exit code
     * of 0 does NOT imply this — pilot-01 turn 1 exited 0 after 12 minutes with the Stop hook
     * never having fired. Optional so manifests written before this field still parse.
     */
    gateReviewed: z.boolean().optional(),
    /**
     * Byte range this turn appended to the recording cassette, `null` when the run was not
     * recording. INSURANCE, deliberately written before it has a consumer.
     *
     * The harvested result carries POST-aggregation findings, so an ablation over it can only
     * bound the layers that overwrite a severity outright (fp-ledger sets INFO directly and
     * the original is persisted nowhere). The cassette holds the RAW pre-aggregation reviewer
     * findings, which would turn those bounds into point estimates — but only if the entries
     * can be addressed PER TURN, which needs exactly these offsets. Recording them costs one
     * `statSync` per turn and is free only until the pilot runs; afterwards recovering them
     * means re-driving the agent at real quota cost. Optional in the schema so manifests
     * written before this field still parse.
     */
    cassetteBytes: z
      .object({ before: z.number().int().nonnegative(), after: z.number().int().nonnegative() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export const RigManifestSchema = z
  .object({
    schema: z.literal("reviewgate.rig.manifest.v1"),
    runId: z.string().min(1),
    scriptId: z.string().min(1),
    outDir: z.string().min(1),
    /** Cassette the run recorded into, or null when it was not recording. */
    cassettePath: z.string().nullable().optional(),
    turns: z.array(RigManifestTurnSchema),
  })
  .strict();

export type RigManifestTurn = z.infer<typeof RigManifestTurnSchema>;
export type RigManifest = z.infer<typeof RigManifestSchema>;
