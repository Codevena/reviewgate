import { expect, test } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";

test("phases.lore defaults to null (off)", () => {
  const cfg = defineConfig({});
  // Spec: `null` is the canonical OFF (not undefined) — this asserts the exact null the
  // defaults.ts `lore: null` entry produces, so removing that entry (→ undefined) would fail here.
  expect(cfg.phases.lore).toBeNull();
});

test("phases.lore accepts { enabled: false } and fills inner defaults", () => {
  const cfg = defineConfig({ phases: { lore: { enabled: false } } as never });
  expect(cfg.phases.lore).toMatchObject({
    enabled: false,
    maxInjectChars: 2000,
    reminderDailyCap: 1,
    rejectedReminderCooldownDays: 7,
  });
});

test("phases.lore fills inner defaults when enabled:true", () => {
  const cfg = defineConfig({ phases: { lore: { enabled: true } } as never });
  expect(cfg.phases.lore).toMatchObject({
    enabled: true,
    maxInjectChars: 2000,
    reminderDailyCap: 1,
    rejectedReminderCooldownDays: 7,
  });
});

test("phases.lore custom maxInjectChars round-trips", () => {
  const cfg = defineConfig({
    phases: { lore: { enabled: true, maxInjectChars: 500 } } as never,
  });
  expect(cfg.phases.lore).toMatchObject({
    enabled: true,
    maxInjectChars: 500,
    reminderDailyCap: 1,
    rejectedReminderCooldownDays: 7,
  });
});
