import { expect, test } from "bun:test";
import { renderPolicyMeasurement } from "../../src/stats/policy/render.ts";

test("exports the policy measurement Markdown renderer", () => {
  expect(typeof renderPolicyMeasurement).toBe("function");
});
