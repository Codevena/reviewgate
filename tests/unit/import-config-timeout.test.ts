// tests/unit/import-config-timeout.test.ts
// F-008: importConfigDefault runs on the gate hot path (Stop hook). A config module
// that THROWS must reject (caller falls back to defaults); a config with a hanging
// top-level await must be bounded by a timeout (never hang the gate forever).
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importConfigDefault } from "../../src/config/import-config.ts";

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-cfgtest-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe("importConfigDefault hardening", () => {
  it("returns the default export for a normal config (precedence preserved)", async () => {
    const p = tmpFile("ok.config.ts", "export default { providers: {} };");
    const def = (await importConfigDefault(p)) as { providers?: unknown };
    expect(def).toBeDefined();
    expect(def.providers).toBeDefined();
  });

  it("rejects (does not hang) on a config whose top-level code throws", async () => {
    const p = tmpFile(
      "throws.config.ts",
      "throw new Error('boom from user config'); export default {};",
    );
    let err: Error | undefined;
    try {
      await importConfigDefault(p);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
  });

  it("enforces a timeout on a config with a never-resolving top-level await", async () => {
    const p = tmpFile("hang.config.ts", "await new Promise(() => {}); export default {};");
    const start = Date.now();
    let err: Error | undefined;
    try {
      await importConfigDefault(p, { timeoutMs: 100 });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err?.message ?? "").toMatch(/timeout/i);
    // Must have returned via the timeout, not hung.
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});
