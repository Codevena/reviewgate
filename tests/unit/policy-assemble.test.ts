import { describe, expect, test } from "bun:test";
import {
  PolicyMeasurementAuthorityError,
  assemblePolicyMeasurement,
} from "../../src/stats/policy/assemble.ts";

describe("policy measurement assembly authority", () => {
  test("exposes a typed exit-4 authority error", () => {
    const error = new PolicyMeasurementAuthorityError(
      "artifact-ref-invalid",
      "fixture reference escaped its declared root",
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.exitCode).toBe(4);
    expect(error.code).toBe("artifact-ref-invalid");
    expect(error.message).toBe(
      "policy measurement: artifact-ref-invalid — fixture reference escaped its declared root",
    );
  });

  test("rejects all three caller paths outside the declared repository root", async () => {
    for (const path of ["../prereg.json", "../bench.json", "../rig.json"] as const) {
      const paths = {
        preregistrationPath: "bench/preregistrations/policy.json",
        benchBundlePath: "bench/results/policy-measurement/attempt/bench.json",
        rigManifestPath: "rig/policy-scenarios.json",
      };
      if (path.includes("prereg")) paths.preregistrationPath = path;
      else if (path.includes("bench")) paths.benchBundlePath = path;
      else paths.rigManifestPath = path;
      await expect(
        assemblePolicyMeasurement({ repoRoot: "/tmp/reviewgate-assembly-unit", ...paths }),
      ).rejects.toMatchObject({ exitCode: 4, code: "artifact-ref-invalid" });
    }
  });
});
