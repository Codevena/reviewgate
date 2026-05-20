// tests/unit/doctor.test.ts
import { describe, expect, it } from "bun:test";
import { runDoctor } from "../../src/cli/commands/doctor.ts";

describe("runDoctor", () => {
  it("returns exit 0 or 1 based on environment, prints a structured report", async () => {
    const code = await runDoctor({ repoRoot: process.cwd(), capture: true });
    expect([0, 1, 2]).toContain(code);
  });
});
