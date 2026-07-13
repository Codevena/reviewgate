import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analysePolicyChange,
  approveControlPlane,
  bootstrapControlPlane,
  controlPlaneStatus,
  effectiveConfigFingerprint,
  finalizeControlPlaneReview,
  resolveControlPlaneConfig,
} from "../../src/config/control-plane.ts";
import { defineConfig } from "../../src/config/define-config.ts";
import { loadEffectiveConfig } from "../../src/config/global.ts";
import { handleTrigger } from "../../src/hooks/handlers.ts";
import { collectDiff } from "../../src/utils/git.ts";
import {
  controlPlaneFlagPath,
  controlPlaneStatePath,
  dirtyFlagPath,
} from "../../src/utils/paths.ts";

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function envFor(home: string) {
  return { env: {} as Record<string, string | undefined>, home };
}

function writeConfig(repo: string, body: string): void {
  writeFileSync(join(repo, "reviewgate.config.ts"), `export default ${body};\n`);
}

function gitRepo(prefix: string): { repo: string; home: string; base: string } {
  const repo = temp(prefix);
  const home = temp(`${prefix}home-`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@example.test"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  writeConfig(repo, "{ loop: { softPassPolicy: 'allow' } }");
  execFileSync("git", ["add", "a.ts", "reviewgate.config.ts"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  return { repo, home, base };
}

describe("gate policy control plane", () => {
  it("uses the last-known-good config until a non-monotonic candidate passes review and is explicitly approved", async () => {
    const repo = temp("rg-control-lkg-");
    const home = temp("rg-control-home-");
    writeConfig(repo, "{ providers: { codex: { model: 'approved-model' } } }");
    await bootstrapControlPlane({ cwd: repo, ...envFor(home), approvedVia: "init" });

    writeConfig(repo, "{ providers: { codex: { model: 'candidate-model' } } }");
    const pending = await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    expect(pending.config.providers.codex.model).toBe("approved-model");
    expect(pending.change?.classification).toBe("approval-required");

    // Human approval is impossible until a complete gate pass under the LKG.
    const challenge = `APPROVE ${pending.observedEffectiveFingerprint?.slice(0, 12)}`;
    expect((await controlPlaneStatus(repo, envFor(home))).challenge).toBeNull();
    await expect(approveControlPlane(repo, challenge, envFor(home))).rejects.toThrow(
      /not yet passed a gate run/i,
    );

    const finalized = await finalizeControlPlaneReview(repo, pending, envFor(home));
    expect(finalized.kind).toBe("approval-required");
    const status = await controlPlaneStatus(repo, envFor(home));
    expect(status.state?.pending?.reviewed_under_lkg_at).not.toBeNull();
    expect(status.challenge).toBe(challenge);

    await approveControlPlane(repo, challenge, envFor(home));
    const approved = await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    expect(approved.change).toBeNull();
    expect(approved.config.providers.codex.model).toBe("candidate-model");
  });

  it("auto-adopts only a provable strengthening after a pass under the prior policy", async () => {
    const repo = temp("rg-control-strong-");
    const home = temp("rg-control-home-");
    writeConfig(repo, "{}");
    await bootstrapControlPlane({ cwd: repo, ...envFor(home), approvedVia: "init" });
    writeConfig(repo, "{ sandbox: { mode: 'strict' }, loop: { softPassPolicy: 'block' } }");
    const pending = await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    expect(pending.config.sandbox.mode).toBe("off");
    expect(pending.change?.classification).toBe("strengthening");
    expect((await finalizeControlPlaneReview(repo, pending, envFor(home))).kind).toBe(
      "auto-approved",
    );
    const approved = await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    expect(approved.config.sandbox.mode).toBe("strict");
    expect(approved.config.loop.softPassPolicy).toBe("block");
  });

  it("requires approval for provider, reviewer and shell-check additions", () => {
    const approved = defineConfig({
      providers: {
        opencode: { enabled: false, auth: "oauth", model: "test-model", timeoutMs: 30_000 },
      },
      phases: { checks: null },
    });
    const withProvider = defineConfig({
      providers: {
        opencode: { enabled: true, auth: "oauth", model: "test-model", timeoutMs: 30_000 },
      },
      phases: { checks: null },
    });
    const withReviewer = defineConfig({
      phases: {
        review: {
          reviewers: [
            ...approved.phases.review.reviewers,
            { provider: "opencode", persona: "security" },
          ],
        },
      },
    });
    const withCheck = defineConfig({
      phases: { checks: { commands: [{ name: "test", run: "bun test" }] } },
    });

    expect(analysePolicyChange(approved, withProvider).classification).toBe("approval-required");
    expect(analysePolicyChange(approved, withReviewer).classification).toBe("approval-required");
    expect(analysePolicyChange(approved, withCheck).classification).toBe("approval-required");
  });

  it("detects a safer shipped-default change even when config source bytes did not change", async () => {
    const repo = temp("rg-control-runtime-default-");
    const home = temp("rg-control-home-");
    writeConfig(repo, "{}");
    await bootstrapControlPlane({ cwd: repo, ...envFor(home), approvedVia: "init" });
    const statePath = controlPlaneStatePath(repo);
    const legacy = JSON.parse(readFileSync(statePath, "utf8"));
    legacy.approved_config.sandbox.writablePaths = [".reviewgate/"];
    legacy.approved_effective_fingerprint = effectiveConfigFingerprint(legacy.approved_config);
    writeFileSync(statePath, `${JSON.stringify(legacy, null, 2)}\n`);

    const pending = await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    expect(pending.config.sandbox.writablePaths).toEqual([".reviewgate/"]); // LKG for this pass
    expect(pending.change?.classification).toBe("strengthening");
    await finalizeControlPlaneReview(repo, pending, envFor(home));
    expect(
      (await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) })).config.sandbox
        .writablePaths,
    ).toEqual([]);
  });

  it("never carries an LKG-pass marker across a changed effective candidate", async () => {
    const repo = temp("rg-control-runtime-marker-");
    const home = temp("rg-control-home-");
    writeConfig(repo, "{ providers: { codex: { model: 'approved' } } }");
    await bootstrapControlPlane({ cwd: repo, ...envFor(home), approvedVia: "init" });
    writeConfig(repo, "{ providers: { codex: { model: 'candidate' } } }");
    const candidate = await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    await finalizeControlPlaneReview(repo, candidate, envFor(home));

    const statePath = controlPlaneStatePath(repo);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.pending.reviewed_under_lkg_at).not.toBeNull();
    // Simulate the same source bytes having produced a different effective policy
    // in an older/newer binary. The old review marker belongs to that fingerprint.
    state.pending.effective_fingerprint = "f".repeat(64);
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

    await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    const refreshed = JSON.parse(readFileSync(statePath, "utf8"));
    expect(refreshed.pending.reviewed_under_lkg_at).toBeNull();
    expect(refreshed.pending.effective_fingerprint).toBe(candidate.observedEffectiveFingerprint);
  });

  it("keeps using the LKG and marks a present invalid config instead of falling back to defaults", async () => {
    const repo = temp("rg-control-invalid-");
    const home = temp("rg-control-home-");
    writeConfig(repo, "{ sandbox: { mode: 'strict' } }");
    await bootstrapControlPlane({ cwd: repo, ...envFor(home), approvedVia: "init" });
    writeFileSync(
      join(repo, "reviewgate.config.ts"),
      "export default { sandbox: process.env.PWNED };\n",
    );
    await expect(loadEffectiveConfig({ cwd: repo, ...envFor(home) })).rejects.toThrow(
      /executable expression/i,
    );
    const resolution = await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    expect(resolution.config.sandbox.mode).toBe("strict");
    expect(resolution.change?.classification).toBe("invalid");
    expect(existsSync(controlPlaneStatePath(repo))).toBe(true);
  });

  it("an Edit config-only mutation arms only the special control-plane flag", async () => {
    const { repo } = gitRepo("rg-control-edit-");
    writeConfig(repo, "{ loop: { softPassPolicy: 'block' } }");
    await handleTrigger({
      repoRoot: repo,
      hookStdinRaw: JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "reviewgate.config.ts") },
      }),
    });
    expect(existsSync(controlPlaneFlagPath(repo))).toBe(true);
    expect(existsSync(dirtyFlagPath(repo))).toBe(false);
  });

  it("a Bash config-only uncommitted mutation is detected without any hook flag", async () => {
    const { repo, home } = gitRepo("rg-control-bash-");
    await bootstrapControlPlane({ cwd: repo, ...envFor(home), approvedVia: "init" });
    writeConfig(repo, "{ loop: { softPassPolicy: 'block' } }"); // Bash-style write: no trigger
    expect(existsSync(controlPlaneFlagPath(repo))).toBe(false);
    const resolution = await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    expect(resolution.change).not.toBeNull();
    expect((await collectDiff(repo)).trim()).toBe(""); // special path, never normal reviewer diff
  });

  it("an uncommitted code+config mutation reviews code normally and policy separately", async () => {
    const { repo, home } = gitRepo("rg-control-mixed-uncommitted-");
    await bootstrapControlPlane({ cwd: repo, ...envFor(home), approvedVia: "init" });
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    writeConfig(repo, "{ loop: { softPassPolicy: 'block' } }");
    const diff = await collectDiff(repo);
    expect(diff).toContain("a.ts");
    expect(diff).not.toContain("reviewgate.config.ts");
    expect((await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) })).change).not.toBeNull();
  });

  it("a committed config-only mutation stays out of the normal diff but cannot disappear", async () => {
    const { repo, home, base } = gitRepo("rg-control-committed-config-");
    await bootstrapControlPlane({ cwd: repo, ...envFor(home), approvedVia: "init" });
    writeConfig(repo, "{ loop: { softPassPolicy: 'block' } }");
    execFileSync("git", ["add", "reviewgate.config.ts"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "policy"], { cwd: repo });
    expect((await collectDiff(repo, base)).trim()).toBe("");
    expect((await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) })).change).not.toBeNull();
  });

  it("a committed code+config mutation preserves code coverage and separate policy detection", async () => {
    const { repo, home, base } = gitRepo("rg-control-committed-mixed-");
    await bootstrapControlPlane({ cwd: repo, ...envFor(home), approvedVia: "init" });
    writeFileSync(join(repo, "a.ts"), "export const a = 3;\n");
    writeConfig(repo, "{ loop: { softPassPolicy: 'block' } }");
    execFileSync("git", ["add", "a.ts", "reviewgate.config.ts"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "mixed"], { cwd: repo });
    const diff = await collectDiff(repo, base);
    expect(diff).toContain("a.ts");
    expect(diff).not.toContain("reviewgate.config.ts");
    expect((await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) })).change).not.toBeNull();
  });

  it("deleting control-plane state from an initialized repo never blesses the current config", async () => {
    const repo = temp("rg-control-missing-");
    const home = temp("rg-control-home-");
    writeConfig(repo, "{}");
    mkdirSync(join(repo, ".reviewgate", "bin"), { recursive: true });
    writeFileSync(join(repo, ".reviewgate", "bin", "gate"), "#!/bin/sh\n");
    await expect(resolveControlPlaneConfig({ cwd: repo, ...envFor(home) })).rejects.toThrow(
      /last-known-good baseline/i,
    );
  });

  it("writes a human-readable dedicated policy report", async () => {
    const repo = temp("rg-control-report-");
    const home = temp("rg-control-home-");
    writeConfig(repo, "{}");
    await bootstrapControlPlane({ cwd: repo, ...envFor(home), approvedVia: "init" });
    writeConfig(repo, "{ providers: { codex: { model: 'changed' } } }");
    await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    const report = readFileSync(join(repo, ".reviewgate", "POLICY_CHANGE.md"), "utf8");
    expect(report).toContain("Gate policy changed");
    expect(report).toContain("last-known-good");
  });

  it("clears a stale pending candidate and special flag when the config is reverted byte-for-byte", async () => {
    const repo = temp("rg-control-revert-");
    const home = temp("rg-control-home-");
    const approvedSource = "export default {};\n";
    writeFileSync(join(repo, "reviewgate.config.ts"), approvedSource);
    await bootstrapControlPlane({ cwd: repo, ...envFor(home), approvedVia: "init" });
    writeConfig(repo, "{ providers: { codex: { model: 'candidate' } } }");
    await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    expect((await controlPlaneStatus(repo, envFor(home))).state?.pending).not.toBeNull();
    writeFileSync(join(repo, "reviewgate.config.ts"), approvedSource);
    const reverted = await resolveControlPlaneConfig({ cwd: repo, ...envFor(home) });
    expect(reverted.change).toBeNull();
    expect((await controlPlaneStatus(repo, envFor(home))).state?.pending).toBeNull();
  });
});
