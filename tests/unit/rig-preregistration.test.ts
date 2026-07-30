import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RigPreregistrationSchema } from "../../src/schemas/rig-preregistration.ts";

// Every guard here exists because a preregistration that validates while being internally
// inconsistent is worse than no preregistration: it carries the authority of a frozen
// document without the integrity that authority is supposed to rest on.

const SHA = "f9d88cfce5a0dc4d2a91449f43c032684b730e5daaafb954c59b6d0fb7a127cf";

function prereg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "reviewgate.rig.preregistration.v1",
    registered_at: "2026-07-30T00:40:00.000Z",
    release: "0.1.0-alpha.15",
    attempt: "t",
    command: ["reviewgate", "rig", "run"],
    roster: {
      reviewers: [
        { provider: "openrouter", model: "deepseek/deepseek-v3.2", persona: "security" },
        { provider: "ollama", model: "glm-5.2:cloud", persona: "correctness" },
      ],
      substitution_allowed: false,
    },
    turn_script: {
      path: "rig/scripts/pilot-01.json",
      id: "p",
      sha256: SHA,
      turns: 12,
      seeded: 5,
      clean: 7,
    },
    metrics: {
      primary: ["M3 recall"],
      exploratory: [],
      expectations: [{ metric: "M3 recall", direction: "higher-is-better", prediction: "≥ 0.6" }],
    },
    hard_gates: { max_turns: 12, max_failed_turns: 3, cassette_required: true },
    known_limitations: ["n is small"],
    ...over,
  };
}

describe("rig preregistration schema", () => {
  test("accepts a well-formed document", () => {
    expect(() => RigPreregistrationSchema.parse(prereg())).not.toThrow();
  });

  test("rejects a non-ISO registered_at — the freeze time must be machine-verifiable", () => {
    expect(() => RigPreregistrationSchema.parse(prereg({ registered_at: "soon" }))).toThrow();
    expect(() => RigPreregistrationSchema.parse(prereg({ registered_at: "" }))).toThrow();
  });

  test("rejects an uppercase sha256 — one hash must have one spelling", () => {
    const t = prereg().turn_script as Record<string, unknown>;
    expect(() =>
      RigPreregistrationSchema.parse(prereg({ turn_script: { ...t, sha256: SHA.toUpperCase() } })),
    ).toThrow();
  });

  test("rejects a single-provider roster — consensus/FP-ledger/reputation would be inert", () => {
    expect(() =>
      RigPreregistrationSchema.parse(
        prereg({
          roster: {
            reviewers: [
              { provider: "openrouter", model: "a", persona: "security" },
              { provider: "openrouter", model: "b", persona: "correctness" },
            ],
            substitution_allowed: false,
          },
        }),
      ),
    ).toThrow();
  });

  test("rejects a turn script whose seeded + clean does not account for every turn", () => {
    const t = prereg().turn_script as Record<string, unknown>;
    expect(() =>
      RigPreregistrationSchema.parse(prereg({ turn_script: { ...t, seeded: 4 } })),
    ).toThrow();
  });

  test("rejects a traversing or absolute turn-script path", () => {
    const t = prereg().turn_script as Record<string, unknown>;
    for (const bad of ["../../etc/passwd", "/tmp/evil.json", "rig/../../x.json"]) {
      expect(() =>
        RigPreregistrationSchema.parse(prereg({ turn_script: { ...t, path: bad } })),
      ).toThrow();
    }
  });

  test("rejects a primary metric with no pre-committed expectation", () => {
    // The exact post-hoc-story hole: name two primary metrics, commit a direction for only
    // one, then after the run add whichever expectation flatters the result.
    expect(() =>
      RigPreregistrationSchema.parse(
        prereg({
          metrics: {
            primary: ["M3 recall", "M2 slope"],
            exploratory: [],
            expectations: [
              { metric: "M3 recall", direction: "higher-is-better", prediction: "≥ 0.6" },
            ],
          },
        }),
      ),
    ).toThrow();
  });

  test("rejects a defeatable abort gate (max_failed_turns >= max_turns)", () => {
    expect(() =>
      RigPreregistrationSchema.parse(
        prereg({ hard_gates: { max_turns: 12, max_failed_turns: 12, cassette_required: true } }),
      ),
    ).toThrow();
  });

  test("the SHIPPED pilot-01 preregistration validates", () => {
    // Resolved from this file, not the CWD, so the test does not depend on where it is run.
    const path = join(import.meta.dir, "..", "..", "rig", "preregistrations", "pilot-01.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(() => RigPreregistrationSchema.parse(doc)).not.toThrow();
    // The frozen document must keep satisfying every guard added after it was frozen — a
    // preregistration that had to be edited to survive its own schema is not preregistered.
    expect(doc.turn_script.seeded + doc.turn_script.clean).toBe(doc.turn_script.turns);
    expect(new Set(doc.roster.reviewers.map((r: { provider: string }) => r.provider)).size).toBe(2);
  });
});
