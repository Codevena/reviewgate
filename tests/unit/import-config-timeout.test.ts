// tests/unit/import-config-timeout.test.ts
// Config is data-only: executable TypeScript is rejected by the literal parser
// before any top-level code can run or wedge the Stop hook.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

  it("rejects executable top-level code without running it", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "rg-cfg-marker-")), "executed");
    const p = tmpFile(
      "throws.config.ts",
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "owned"); export default {};`,
    );
    let err: Error | undefined;
    try {
      await importConfigDefault(p);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects a never-resolving top-level await immediately instead of executing it", async () => {
    const p = tmpFile("hang.config.ts", "await new Promise(() => {}); export default {};");
    const start = Date.now();
    let err: Error | undefined;
    try {
      await importConfigDefault(p, { timeoutMs: 100 });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err?.message ?? "").toMatch(/expected `export`|executable expression/i);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("rejects expressions inside an otherwise valid object", async () => {
    const p = tmpFile("env.config.ts", "export default { model: process.env.SECRET }; ");
    await expect(importConfigDefault(p)).rejects.toThrow(/executable expression/i);
  });
});
