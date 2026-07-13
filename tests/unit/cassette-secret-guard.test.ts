// tests/unit/cassette-secret-guard.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const HIGH_ENTROPY = /[A-Za-z0-9+/=_-]{32,}/g;
function shannon(s: string): number {
  const counts: Record<string, number> = {};
  for (const ch of s) counts[ch] = (counts[ch] ?? 0) + 1;
  let h = 0;
  for (const c of Object.values(counts)) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const ROOTS = ["tests/fixtures/cassettes", ".reviewgate/cassettes/golden", "assets/demo"];
const PUBLIC_DEMO_CASSETTE = "assets/demo/alpha11-openrouter.jsonl";

describe("committed cassette secret guard", () => {
  it("no committed cassette contains a high-entropy secret-like token", async () => {
    const offenders: string[] = [];
    const scannedCassettes: string[] = [];
    for (const root of ROOTS) {
      if (!existsSync(root)) continue;
      for await (const f of new Glob("**/*.jsonl").scan(root)) {
        scannedCassettes.push(join(root, f));
        const text = readFileSync(join(root, f), "utf8");
        for (const m of text.match(HIGH_ENTROPY) ?? []) {
          if (/^[0-9a-f]{64}$/.test(m)) continue; // sha256 hashes are expected
          if (shannon(m) >= 4.0) offenders.push(`${root}/${f}: ${m.slice(0, 12)}…`);
        }
      }
    }
    expect(scannedCassettes).toContain(PUBLIC_DEMO_CASSETTE);
    expect(offenders).toEqual([]);
  });
});
