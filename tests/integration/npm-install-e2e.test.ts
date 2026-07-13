// tests/integration/npm-install-e2e.test.ts
import { describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const HOST_PKG = `@codevena/reviewgate-${process.platform}-${process.arch}`;
const hasNpm = spawnSync("npm", ["--version"], { encoding: "utf8" }).status === 0;
const supported =
  ["darwin", "linux"].includes(process.platform) && ["arm64", "x64"].includes(process.arch);

// OPT-IN: this test builds binaries + runs a real `npm install`, so it is gated on
// RG_E2E=1 and never runs under a bare `bun test` (incl. the DoD suite). Run it with:
//   RG_E2E=1 bun test tests/integration/npm-install-e2e.test.ts
// (build:npm writes only to npm-dist/, never dist/ — it does not redeploy the live gate.)
function packFilename(stage: string, dir: string): string {
  const out = execFileSync("npm", ["pack", "--json", "--pack-destination", stage, dir], {
    encoding: "utf8",
  });
  const parsed = JSON.parse(out) as Array<{ filename: string }>;
  if (!parsed[0]) throw new Error("npm pack produced no output");
  return parsed[0].filename;
}

describe.if(process.env.RG_E2E === "1" && hasNpm && supported)("npm install end-to-end", () => {
  it("packs, installs, bakes the node_modules binary path, and the gate shim execs it", () => {
    // 1. Build only the host platform package + main, then pack both.
    // NODE_ENV must be "production" here: bun test sets NODE_ENV=test, and bun's build
    // compiler uses it for dead-code elimination — building with NODE_ENV=test strips the
    // citty --version handler from the compiled binary, making the next assertion fail.
    execFileSync("bun", ["run", "build:npm"], {
      cwd: REPO,
      env: { ...process.env, REVIEWGATE_BUILD_ONLY_CURRENT: "1", NODE_ENV: "production" },
      stdio: "inherit",
    });
    const stage = mkdtempSync(join(tmpdir(), "rg-e2e-stage-"));
    const mainTgz = packFilename(stage, join(REPO, "npm-dist", "main"));
    const platTgz = packFilename(stage, join(REPO, "npm-dist", HOST_PKG));

    // 2. Consumer project: install the main tarball, override the host platform dep to the local tarball.
    const proj = mkdtempSync(join(tmpdir(), "rg-e2e-proj-"));
    writeFileSync(
      join(proj, "package.json"),
      JSON.stringify({
        name: "rg-e2e",
        version: "1.0.0",
        private: true,
        dependencies: { reviewgate: `file:${join(stage, mainTgz)}` },
        overrides: { [HOST_PKG]: `file:${join(stage, platTgz)}` },
      }),
    );
    // A real consumer does not review installed dependencies or Reviewgate's
    // generated runtime directory. Keeping those out of Git also makes the final
    // shim assertion exercise the unchanged-tree fast path instead of launching
    // real reviewer CLIs against node_modules.
    writeFileSync(join(proj, ".gitignore"), "node_modules/\n.reviewgate/\n");
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: proj,
      stdio: "inherit",
    });

    // 3. The host platform package resolved; `reviewgate --version` runs through launcher → binary.
    const platBin = join(proj, "node_modules", HOST_PKG, "reviewgate");
    expect(existsSync(platBin)).toBe(true);
    const ver = execFileSync(join(proj, "node_modules", ".bin", "reviewgate"), ["--version"], {
      encoding: "utf8",
    });
    expect(ver.trim().length).toBeGreaterThan(0);

    // 4. `reviewgate init` in a git repo bakes the node_modules platform-binary path.
    execFileSync("git", ["init", "-q"], { cwd: proj });
    execFileSync(
      join(proj, "node_modules", ".bin", "reviewgate"),
      ["init", "--quick", "--host", "both", "--skip-doctor"],
      {
        cwd: proj,
        stdio: "inherit",
      },
    );
    const gateShim = readFileSync(join(proj, ".reviewgate", "bin", "gate"), "utf8");
    // init bakes process.execPath which the OS may canonicalise (e.g. macOS /var/folders →
    // /private/var/folders via the Seatbelt symlink). Use realpathSync so the assertion
    // works on both macOS (symlinked tmpdir) and Linux (no symlink, no-op).
    expect(gateShim).toContain(`RG_BIN='${realpathSync(platBin)}'`);
    const policyStatus = execFileSync(
      join(proj, "node_modules", ".bin", "reviewgate"),
      ["config", "status"],
      { cwd: proj, encoding: "utf8" },
    );
    expect(policyStatus).toContain("Gate policy: APPROVED");
    const codexHooks = JSON.parse(readFileSync(join(proj, ".codex", "hooks.json"), "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    expect(codexHooks.hooks?.Stop).toBeDefined();
    expect(existsSync(join(proj, ".claude", "settings.json"))).toBe(true);

    // Establish the normal post-install baseline. Without this, the smoke would
    // ask live reviewer providers to inspect package.json and the generated
    // config, which tests provider availability rather than package wiring.
    execFileSync("git", ["add", "--all"], { cwd: proj });
    execFileSync("git", ["commit", "-q", "-m", "test baseline"], {
      cwd: proj,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Reviewgate Test",
        GIT_AUTHOR_EMAIL: "reviewgate@example.invalid",
        GIT_COMMITTER_NAME: "Reviewgate Test",
        GIT_COMMITTER_EMAIL: "reviewgate@example.invalid",
      },
    });

    // 5. The baked gate shim execs the binary (no 127, no fail-closed "not on PATH" message).
    const gate = spawnSync(join(proj, ".reviewgate", "bin", "gate"), [], {
      cwd: proj,
      encoding: "utf8",
      input: "",
    });
    expect(gate.status).toBe(0);
    expect(gate.stdout).not.toContain("is not on PATH and no baked path resolved");
  }, 180_000);
});
