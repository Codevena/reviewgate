// tests/unit/state-store.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../../src/core/state-store.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rg-state-"));
}

describe("StateStore", () => {
  it("initialises a fresh state.json with the given session id", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    const s = await store.initialise("01HXQTEST");
    expect(s.session_id).toBe("01HXQTEST");
    expect(s.iteration).toBe(0);
    expect(existsSync(join(dir, ".reviewgate", "state.json"))).toBe(true);
  });

  it("loads existing valid state", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    await store.initialise("01HXQ1");
    const s = await store.load();
    expect(s.session_id).toBe("01HXQ1");
  });

  it("recovers from corruption by backing up and reinitialising", async () => {
    const dir = tmp();
    // Create .reviewgate dir and write corrupt state.json
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, ".reviewgate"), { recursive: true });
    writeFileSync(join(dir, ".reviewgate", "state.json"), "{not valid json");
    const store = new StateStore(dir);
    const s = await store.loadOrRecover("01HXQNEW");
    expect(s.recovered_from).toBe("corruption");
    expect(s.session_id).toBe("01HXQNEW");
    // Backup exists
    const files = await (await import("node:fs/promises")).readdir(join(dir, ".reviewgate"));
    expect(files.some((f) => f.startsWith("state.json.corrupt."))).toBe(true);
  });

  it("updates state atomically", async () => {
    const dir = tmp();
    const store = new StateStore(dir);
    await store.initialise("01HXQ2");
    await store.update((s) => ({ ...s, iteration: 1, cost_usd_so_far: 0.12 }));
    const after = await store.load();
    expect(after.iteration).toBe(1);
    expect(after.cost_usd_so_far).toBe(0.12);
  });
});
