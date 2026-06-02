import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaCooldownStore, parseQuotaResetAt } from "../../src/core/quota-cooldown.ts";

const NOW = new Date("2026-05-23T12:00:00.000Z");

describe("parseQuotaResetAt", () => {
  test("parses codex's 'try again at <date>' banner (ordinal stripped)", () => {
    const iso = parseQuotaResetAt(
      "ERROR: You've hit your usage limit. ... or try again at May 27th, 2026 12:57 AM.",
      NOW,
    );
    expect(iso).not.toBeNull();
    expect(new Date(iso as string).getTime()).toBeGreaterThan(NOW.getTime());
    // Same day-of-month regardless of TZ rendering.
    expect(new Date(iso as string).toISOString()).toContain("2026-05-2");
  });

  test("parses codex's TIME-ONLY 'try again at 1:30 AM' as the next local occurrence", () => {
    // codex's real usage-limit banner is time-only ("...or try again at 1:30 AM.").
    // Date.parse can't read a bare clock time, so this used to fall through to the
    // 15-min DEFAULT_COOLDOWN_MS — the inaccurate "23:40 guess" seen in 2026-06-02
    // dogfood when codex was actually capped until 1:30 AM.
    const iso = parseQuotaResetAt(
      "ERROR: You've hit your usage limit. ... or try again at 1:30 AM.",
      NOW,
    );
    expect(iso).not.toBeNull();
    const d = new Date(iso as string);
    // Local wall-clock 01:30 (assertion is TZ-independent: getHours()/getMinutes() are local).
    expect(d.getHours()).toBe(1);
    expect(d.getMinutes()).toBe(30);
    // Next occurrence: strictly in the future, never more than 24h out.
    expect(d.getTime()).toBeGreaterThan(NOW.getTime());
    expect(d.getTime() - NOW.getTime()).toBeLessThanOrEqual(24 * 60 * 60_000);
  });

  test("parses a time-only 'try again at 1:30 PM' (12h PM → local 13:30)", () => {
    const iso = parseQuotaResetAt("You've hit your usage limit. Try again at 1:30 PM.", NOW);
    expect(iso).not.toBeNull();
    const d = new Date(iso as string);
    expect(d.getHours()).toBe(13);
    expect(d.getMinutes()).toBe(30);
  });

  test("parses the reset time even when embedded in codex JSONL events (trailing JSON)", () => {
    const events =
      '{"type":"error","message":"You\'ve hit your usage limit. ... or try again at May 27th, 2026 12:57 AM."}}{"type":"turn.failed"}';
    const iso = parseQuotaResetAt(events, NOW);
    expect(iso).not.toBeNull();
    // 4 days out — within the 30-day guard, NOT swallowed into a garbage date.
    expect(new Date(iso as string).getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("parses a 'retry after N seconds' rate-limit message", () => {
    const iso = parseQuotaResetAt("HTTP 429: rate limited, retry after 120 seconds", NOW);
    expect(iso).toBe(new Date(NOW.getTime() + 120_000).toISOString());
  });

  test("parses agy's relative 'Resets in 25m38s' duration", () => {
    const iso = parseQuotaResetAt(
      "⚠ Individual quota reached. Contact your administrator to enable overages. Resets in 25m38s.",
      NOW,
    );
    expect(iso).toBe(new Date(NOW.getTime() + (25 * 60 + 38) * 1000).toISOString());
  });

  test("parses relative durations with h/m/s, m-only, and s-only", () => {
    expect(parseQuotaResetAt("Resets in 1h2m3s", NOW)).toBe(
      new Date(NOW.getTime() + (3600 + 120 + 3) * 1000).toISOString(),
    );
    expect(parseQuotaResetAt("resets in 25m", NOW)).toBe(
      new Date(NOW.getTime() + 25 * 60_000).toISOString(),
    );
    expect(parseQuotaResetAt("resets in 90s", NOW)).toBe(
      new Date(NOW.getTime() + 90_000).toISOString(),
    );
  });

  test("does not treat a bare 'resets in' with no duration as a reset", () => {
    expect(parseQuotaResetAt("the cache resets in the background", NOW)).toBeNull();
  });

  test("returns null when no reset hint is present", () => {
    expect(parseQuotaResetAt("RESOURCE_EXHAUSTED: quota exceeded", NOW)).toBeNull();
    expect(parseQuotaResetAt("", NOW)).toBeNull();
    expect(parseQuotaResetAt(undefined, NOW)).toBeNull();
  });

  test("rejects a parsed time in the past or absurdly far out", () => {
    expect(parseQuotaResetAt("try again at January 1st, 2020 00:00 AM", NOW)).toBeNull();
    expect(parseQuotaResetAt("try again at May 27th, 2099 12:00 PM", NOW)).toBeNull();
  });
});

describe("QuotaCooldownStore", () => {
  const repo = () => mkdtempSync(join(tmpdir(), "rg-cd-"));

  test("write is atomic: leaves no stray .tmp and produces a readable file", () => {
    const r = repo();
    const s = new QuotaCooldownStore(r);
    s.record("codex", new Date(NOW.getTime() + 60_000).toISOString(), NOW);
    const dir = join(r, ".reviewgate");
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(s.activeUntil("codex", NOW)).not.toBeNull();
  });

  test("records a cooldown and reports it active until the reset time", () => {
    const r = repo();
    const s = new QuotaCooldownStore(r);
    const resetAt = new Date(NOW.getTime() + 3_600_000).toISOString();
    s.record("codex", resetAt, NOW);
    expect(s.activeUntil("codex", NOW)).toBe(resetAt);
    // persisted to disk
    const onDisk = JSON.parse(readFileSync(join(r, ".reviewgate", "quota-cooldowns.json"), "utf8"));
    expect(onDisk.providers.codex.reset_at).toBe(resetAt);
  });

  test("a cooldown expires once now passes the reset time", () => {
    const r = repo();
    const s = new QuotaCooldownStore(r);
    const resetAt = new Date(NOW.getTime() + 1000).toISOString();
    s.record("codex", resetAt, NOW);
    const later = new Date(NOW.getTime() + 5000);
    expect(s.activeUntil("codex", later)).toBeNull();
  });

  test("clear removes the cooldown (provider recovered)", () => {
    const r = repo();
    const s = new QuotaCooldownStore(r);
    s.record("codex", new Date(NOW.getTime() + 3_600_000).toISOString(), NOW);
    s.clear("codex");
    expect(s.activeUntil("codex", NOW)).toBeNull();
  });

  test("a fresh store with no file reports nothing active", () => {
    const s = new QuotaCooldownStore(repo());
    expect(s.activeUntil("codex", NOW)).toBeNull();
  });
});

describe("QuotaCooldownStore.skipUntil (re-probe window)", () => {
  const repo = () => mkdtempSync(join(tmpdir(), "rg-cd-skip-"));
  const future = new Date(NOW.getTime() + 3 * 24 * 3_600_000).toISOString(); // 3 days out

  test("skips while the cooldown is active AND recorded recently", () => {
    const s = new QuotaCooldownStore(repo());
    s.record("codex", future, NOW); // recorded_at = NOW
    expect(s.skipUntil("codex", new Date(NOW.getTime() + 10 * 60_000))).toBe(future); // 10 min later → still skip
  });

  test("RE-PROBES (returns null) once the re-probe window elapses, even if reset is far off", () => {
    const s = new QuotaCooldownStore(repo());
    s.record("codex", future, NOW); // recorded_at = NOW, reset 3 days out
    const after = new Date(NOW.getTime() + 31 * 60_000); // > 30-min re-probe window
    expect(s.activeUntil("codex", after)).toBe(future); // doctor still SEES it
    expect(s.skipUntil("codex", after)).toBeNull(); // but the gate re-probes (doesn't skip)
  });

  test("does not skip once the cooldown itself has expired", () => {
    const s = new QuotaCooldownStore(repo());
    s.record("codex", new Date(NOW.getTime() + 1000).toISOString(), NOW);
    expect(s.skipUntil("codex", new Date(NOW.getTime() + 5000))).toBeNull();
  });

  test("no entry → never skips", () => {
    expect(new QuotaCooldownStore(repo()).skipUntil("codex", NOW)).toBeNull();
  });
});
