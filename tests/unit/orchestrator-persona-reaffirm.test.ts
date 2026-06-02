import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSONA_REAFFIRM, reaffirmFor, resolvePersonas } from "../../src/core/personas.ts";

const PERSONAS = ["security", "quality", "performance", "testing", "correctness"];
const map = resolvePersonas(mkdtempSync(join(tmpdir(), "rg-rf-")), PERSONAS);

describe("reaffirmFor (persona reaffirmation)", () => {
  it("returns the security auditor reaffirmation for the security persona", () => {
    expect(reaffirmFor("security", map).toLowerCase()).toContain("security");
  });
  it("gives quality/performance/testing their OWN reaffirmation, not the security one", () => {
    const security = reaffirmFor("security", map);
    for (const p of ["quality", "performance", "testing", "correctness"]) {
      const r = reaffirmFor(p, map);
      expect(r).not.toBe(security);
      expect(r.toLowerCase()).not.toContain("security auditor");
    }
  });
  it("falls back to a NEUTRAL default for an unknown persona, not the security text", () => {
    const fallback = reaffirmFor("totally-unknown-persona", map);
    expect(fallback).not.toBe(PERSONA_REAFFIRM.security);
    expect(fallback.toLowerCase()).not.toContain("security auditor");
  });
});
