// tests/unit/quota-defer-config.test.ts
//
// #10 plumbing: the new consecutive_quota_defers state field defaults to 0 (and
// is present in a fresh initialState), and loop.quotaDeferMaxConsecutive defaults
// to 1 (field report 2026-07-03 recalibration), including when omitted from a parsed config.
import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { ConfigSchema } from "../../src/config/define-config.ts";
import { initialState } from "../../src/schemas/state.ts";

describe("#10 quota-defer plumbing", () => {
  it("initialState starts the quota-defer counter at 0", () => {
    expect(initialState("01HXTEST0000").consecutive_quota_defers).toBe(0);
  });

  it("defaultConfig.loop.quotaDeferMaxConsecutive is 1", () => {
    expect(defaultConfig.loop.quotaDeferMaxConsecutive).toBe(1);
  });

  it("a parsed config with the field omitted re-defaults to 1", () => {
    // Strip the field so the parse exercises the zod `.default(1)`, not the value
    // already baked into defaultConfig.
    const { quotaDeferMaxConsecutive: _omit, ...loopWithout } = defaultConfig.loop;
    const parsed = ConfigSchema.parse({ ...defaultConfig, loop: loopWithout });
    expect(parsed.loop.quotaDeferMaxConsecutive).toBe(1);
  });
});
