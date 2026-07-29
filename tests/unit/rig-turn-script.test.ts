import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadTurnScript } from "../../src/rig/turn-script.ts";
import { RigTurnScriptSchema } from "../../src/schemas/rig-turn-script.ts";

// Resolved from this file, not from process.cwd(): the shipped script must be found the
// same way whether the suite is run from the repo root or a subdirectory.
const PILOT_01 = join(import.meta.dir, "..", "..", "rig", "scripts", "pilot-01.json");

describe("rig turn script schema", () => {
  test("accepts a minimal clean turn", () => {
    const parsed = RigTurnScriptSchema.parse({
      schema: "reviewgate.rig.turn-script.v1",
      id: "pilot-01",
      turns: [{ index: 1, prompt: "Add an add() function.", seeded: null }],
    });
    const [first] = parsed.turns;
    expect(first?.seeded).toBeNull();
  });

  test("rejects a seeded defect with an empty tag list", () => {
    expect(() =>
      RigTurnScriptSchema.parse({
        schema: "reviewgate.rig.turn-script.v1",
        id: "pilot-01",
        turns: [
          {
            index: 1,
            prompt: "x",
            seeded: { id: "path-traversal", tags: [], severity: "critical" },
          },
        ],
      }),
    ).toThrow();
  });

  test("rejects non-contiguous turn indices", () => {
    expect(() =>
      RigTurnScriptSchema.parse({
        schema: "reviewgate.rig.turn-script.v1",
        id: "pilot-01",
        turns: [
          { index: 1, prompt: "a", seeded: null },
          { index: 3, prompt: "b", seeded: null },
        ],
      }),
    ).toThrow();
  });

  test("rejects a script id that could become a path component", () => {
    // The id flows into runId and the persisted manifest; any later code that derives a
    // directory from it (one per run is the obvious design) would inherit a traversal from
    // a user-supplied JSON file. Constrained at the schema so every consumer is covered.
    for (const id of ["../escape", "a/b", "with space", "semi;colon"]) {
      expect(() =>
        RigTurnScriptSchema.parse({
          schema: "reviewgate.rig.turn-script.v1",
          id,
          turns: [{ index: 1, prompt: "x", seeded: null }],
        }),
      ).toThrow();
    }
  });

  test("still accepts ordinary ids", () => {
    // Guards the over-correction: a charset rule that also rejected `pilot-01` would make
    // the rule look like it works while breaking every real script.
    for (const id of ["pilot-01", "run_2", "v1.2"]) {
      expect(
        RigTurnScriptSchema.parse({
          schema: "reviewgate.rig.turn-script.v1",
          id,
          turns: [{ index: 1, prompt: "x", seeded: null }],
        }).id,
      ).toBe(id);
    }
  });
});

describe("the shipped pilot-01 script", () => {
  test("is valid and has the documented shape", () => {
    const s = loadTurnScript(PILOT_01);
    expect(s.turns).toHaveLength(12);
    expect(s.turns.filter((t) => t.seeded !== null)).toHaveLength(5);
  });

  test("never places two seeded turns back to back", () => {
    // The FP-burden slope (M2) is fitted over turns that produced findings; clean turns
    // must stay spread across the whole run or the slope is fitted on one half of it.
    const flags = loadTurnScript(PILOT_01).turns.map((t) => t.seeded !== null);
    expect(flags.some((seeded, i) => i > 0 && seeded && flags[i - 1])).toBe(false);
  });

  test("spreads seeded turns across both halves of the run", () => {
    // Recall and the FP slope must not be measured on disjoint halves: if every seeded
    // turn sat early, recall would describe a cold run and the slope a warm one.
    const s = loadTurnScript(PILOT_01);
    const seeded = s.turns.filter((t) => t.seeded !== null).map((t) => t.index);
    const mid = s.turns.length / 2;
    expect(seeded.some((i) => i <= mid)).toBe(true);
    expect(seeded.some((i) => i > mid)).toBe(true);
  });

  test("every seeded defect id is unique, so a catch maps to exactly one turn", () => {
    const s = loadTurnScript(PILOT_01);
    const ids = s.turns.flatMap((t) => (t.seeded ? [t.seeded.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
