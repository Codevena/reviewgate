// tests/unit/fp-ledger-store.property.test.ts
//
// Property-based invariants for the FP-ledger state machine (weakness #2: the
// subtle bugs F-017/F-018/F-019/F-020 all lived in this lifecycle). fast-check
// drives random sequences of recordReject / decayPass / pin / unpin and asserts
// the structural invariants hold after EVERY operation — not just the curated
// example cases the unit tests cover.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { FpLedgerStore } from "../../src/core/fp-ledger/store.ts";

const META = { rule_id: "r", category: "quality" as const, file: "a.ts", symbol: "foo" };
const SIGS = ["s0", "s1", "s2"] as const;
const PROVIDERS = ["codex", "gemini", "claude-code"] as const;
const RUNS = ["r0", "r1", "r2", "r3", "r4"] as const;
// Timestamps spanning >1 year so decay windows (60d/90d/180d) actually trigger.
const TS = [
  "2026-01-01T00:00:00Z",
  "2026-02-15T00:00:00Z",
  "2026-04-01T00:00:00Z",
  "2026-06-01T00:00:00Z",
  "2026-10-01T00:00:00Z",
  "2027-03-01T00:00:00Z",
] as const;

const opArb = fc.oneof(
  fc.record({
    kind: fc.constant("reject" as const),
    sig: fc.constantFrom(...SIGS),
    provider: fc.constantFrom(...PROVIDERS),
    run: fc.constantFrom(...RUNS),
    ts: fc.constantFrom(...TS),
  }),
  fc.record({ kind: fc.constant("decay" as const), ts: fc.constantFrom(...TS) }),
  fc.record({ kind: fc.constant("pin" as const), idx: fc.nat({ max: 10 }) }),
  fc.record({ kind: fc.constant("unpin" as const), idx: fc.nat({ max: 10 }) }),
);

const DAY_MS = 86_400_000;
const STICKY_DAYS = 90; // mirror store.ts: the widest decay window

describe("FpLedgerStore — property invariants", () => {
  it("upholds id-uniqueness, no-id-reuse, pinned⇒sticky, seq-monotonic, active≠candidate", async () => {
    await fc.assert(
      // `readNow` is generated (from the event timestamps + a near-future date) so
      // the activeSnapshot window is exercised non-trivially: at some readNow values
      // recent entries are active/sticky, at others everything has aged to candidate.
      fc.asyncProperty(
        fc.array(opArb, { minLength: 1, maxLength: 14 }),
        fc.constantFrom(...TS, "2027-03-15T00:00:00Z"),
        async (ops, readNowIso) => {
          const dir = mkdtempSync(join(tmpdir(), "rg-fpprop-"));
          const s = new FpLedgerStore(dir);
          const idToSig = new Map<string, string>(); // id MUST never map to two signatures (F-019)
          let lastSeq = -1;
          const readNow = new Date(readNowIso);
          const nowMs = readNow.getTime();
          try {
            for (const op of ops) {
              if (op.kind === "reject") {
                await s.recordReject(
                  op.sig,
                  META,
                  { run_id: op.run, provider: op.provider, reason: "x" },
                  op.ts,
                );
              } else if (op.kind === "decay") {
                await s.decayPass(op.ts);
              } else {
                const ids = (await s.snapshot()).entries.map((e) => e.id);
                if (ids.length > 0) {
                  const id = ids[op.idx % ids.length] as string;
                  if (op.kind === "pin") await s.pin(id, "human");
                  else await s.unpin(id);
                }
              }

              // --- invariants after every op ---
              const snap = await s.snapshot();
              const ids = snap.entries.map((e) => e.id);
              // (1) ids are unique within the ledger
              expect(new Set(ids).size).toBe(ids.length);
              // (2) seq is a monotonic non-decreasing high-water mark
              if (snap.seq !== undefined) {
                expect(snap.seq).toBeGreaterThanOrEqual(lastSeq);
                lastSeq = snap.seq;
              }
              for (const e of snap.entries) {
                // (3) an id is never reused for a DIFFERENT signature (F-019)
                const prev = idToSig.get(e.id);
                if (prev !== undefined) expect(prev).toBe(e.signature);
                idToSig.set(e.id, e.signature);
                // (4) a pinned entry is always sticky
                if (e.pinned_by) expect(e.stage).toBe("sticky");
              }
              // (5) activeSnapshot(now) only serves entries that GENUINELY earn a
              // non-candidate stage at `now` — an independent window oracle (NOT just
              // re-reading the method's own filter), so a stale entry served after its
              // rejects aged out of the window would FAIL here (F-017/F-018).
              for (const e of (await s.activeSnapshot(readNow)).values()) {
                expect(e.stage).not.toBe("candidate");
                if (e.pinned_by) continue; // pinned entries are sticky regardless of age
                // Mirror recompute()'s window exactly (`now - ts <= window`, so a
                // future-skewed reject still counts) — the point of the oracle is to
                // catch a PAST reject that aged out, i.e. the F-017/F-018 scenario.
                const inWindow = e.rejects.filter(
                  (r) => nowMs - Date.parse(r.ts) <= STICKY_DAYS * DAY_MS,
                );
                const distinctProviders = new Set(inWindow.map((r) => r.provider)).size;
                // Necessary condition for active(≥3/60d) OR sticky(≥5/90d), both ≥2 providers:
                // ≥3 qualifying rejects within 90d from ≥2 distinct providers.
                expect(inWindow.length).toBeGreaterThanOrEqual(3);
                expect(distinctProviders).toBeGreaterThanOrEqual(2);
              }
            }
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
