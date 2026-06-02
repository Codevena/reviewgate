import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImplicitOutcomeStore } from "../../src/core/learnings/implicit-outcomes.ts";
import type { ImplicitOutcome } from "../../src/schemas/implicit-outcome.ts";

const oc = (signature: string, iter = 1): ImplicitOutcome => ({
  schema: "reviewgate.implicit_outcome.v1",
  signature,
  reviewer_key: "codex:security",
  category: "correctness",
  demote_reason: "critic_likely_fp",
  run_id: "RUN",
  iter,
  created_at: "2026-06-02T00:00:00Z",
});

describe("ImplicitOutcomeStore", () => {
  it("appends and reloads outcomes", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-io-"));
    const store = new ImplicitOutcomeStore(repo);
    await store.append([oc("a"), oc("b")], 5000);
    const all = await store.load();
    expect(all.map((o) => o.signature)).toEqual(["a", "b"]);
  });

  it("is a no-op on empty input", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-io2-"));
    const store = new ImplicitOutcomeStore(repo);
    await store.append([], 5000);
    expect(await store.load()).toEqual([]);
  });

  it("prunes to cap, dropping the OLDEST", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-io3-"));
    const store = new ImplicitOutcomeStore(repo);
    await store.append([oc("old1"), oc("old2"), oc("old3")], 5000);
    await store.append([oc("new1"), oc("new2")], 3);
    const all = await store.load();
    expect(all.length).toBe(3);
    expect(all.map((o) => o.signature)).toEqual(["old3", "new1", "new2"]);
  });

  it("skips malformed lines on load (tolerant reader)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-io4-"));
    const store = new ImplicitOutcomeStore(repo);
    await store.append([oc("a")], 5000);
    const { appendFileSync } = await import("node:fs");
    const { implicitOutcomesPath } = await import("../../src/utils/paths.ts");
    appendFileSync(implicitOutcomesPath(repo), "not json\n");
    const all = await store.load();
    expect(all.map((o) => o.signature)).toEqual(["a"]);
  });
});
