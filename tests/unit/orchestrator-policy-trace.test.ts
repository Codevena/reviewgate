import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_POLICY_ABLATIONS,
  resolvePolicyExecutionOptions,
} from "../../src/core/policy/replay.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("internal policy execution selection", () => {
  it("keeps legacy direct construction off and defaults the AuditLogger path to persist", () => {
    const direct = resolvePolicyExecutionOptions(undefined, false);
    const production = resolvePolicyExecutionOptions(undefined, true);

    expect(direct).toEqual({
      trace: "off",
      policyAblations: EMPTY_POLICY_ABLATIONS,
      authoritative: false,
    });
    expect(production).toEqual({
      trace: "persist",
      policyAblations: EMPTY_POLICY_ABLATIONS,
      authoritative: false,
    });
    expect(production.policyAblations.size).toBe(0);
  });

  it("preserves explicit internal memory mode and its ablation identity", () => {
    const ablations = new Set(["judgment.confidence"] as const);
    const resolved = resolvePolicyExecutionOptions(
      { trace: "memory", policyAblations: ablations, authoritative: true },
      false,
    );

    expect(resolved.trace).toBe("memory");
    expect(resolved.policyAblations).toBe(ablations);
    expect(resolved.authoritative).toBe(true);
  });
});

describe("policy ablations stay internal", () => {
  it("has no policyAblations mapping in Gate, Config, Setup, config schemas, or env parsing", async () => {
    const guardedFiles = [
      "src/cli/commands/gate.ts",
      "src/cli/commands/config.ts",
      "src/cli/commands/setup.ts",
    ];
    const configFiles = new Bun.Glob("src/config/**/*.ts");
    for await (const path of configFiles.scan({ cwd: REPO_ROOT, onlyFiles: true })) {
      guardedFiles.push(path);
    }

    for (const path of guardedFiles) {
      const source = readFileSync(join(REPO_ROOT, path), "utf8");
      expect(source, path).not.toContain("policyAblations");
    }
  });

  it("lets Gate read only the Rig capture sink, never a pass or ablation control", () => {
    const gate = readFileSync(join(REPO_ROOT, "src/cli/commands/gate.ts"), "utf8");
    const replayEnvReads = [...gate.matchAll(/process\.env\.([A-Z0-9_]*RIG[A-Z0-9_]*)/g)].map(
      (match) => match[1],
    );
    expect(replayEnvReads).toEqual(["REVIEWGATE_RIG_REPLAY_DIR"]);
    expect(gate).not.toMatch(/REVIEWGATE_(?:POLICY_)?ABLATION/);
    expect(gate).not.toMatch(/REVIEWGATE_POLICY_PASS/);
  });
});
