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
  })
  .strict();

export const RigManifestSchema = z
  .object({
    schema: z.literal("reviewgate.rig.manifest.v1"),
    runId: z.string().min(1),
    scriptId: z.string().min(1),
    outDir: z.string().min(1),
    turns: z.array(RigManifestTurnSchema),
  })
  .strict();

export type RigManifestTurn = z.infer<typeof RigManifestTurnSchema>;
export type RigManifest = z.infer<typeof RigManifestSchema>;
