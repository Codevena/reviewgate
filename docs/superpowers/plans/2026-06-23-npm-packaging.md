# npm-proper Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Reviewgate to npm as a main `reviewgate` launcher package plus four `@codevena/reviewgate-<os>-<arch>` prebuilt-binary packages, so `npm i -g reviewgate` installs only the matching platform binary and `reviewgate init` bakes a working, fail-closed Stop hook.

**Architecture:** The esbuild/Biome pattern — npm's `os`/`cpu` fields install one platform package; a tiny pure-CJS launcher (`bin/reviewgate.cjs`) resolves that package and **spawns** its self-contained binary, forwarding argv+stdio. Because it spawns (not in-process dispatch), `process.execPath` inside every subcommand is the binary, so the existing hook-path baking keeps working unchanged.

**Tech Stack:** Bun (build/test/runtime), `bun build --compile` cross-compilation, Node.js CJS launcher, npm (publish), GitHub Actions (release).

## Global Constraints

- Platform packages: `@codevena/reviewgate-<os>-<arch>` for exactly `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`. Main package: `reviewgate` (unscoped).
- Platform package `os`/`cpu` must be `[<os>]`/`[<cpu>]`; linux packages also `libc: ["glibc"]`.
- Main package declares **NO runtime `dependencies`**, `engines.node >= 20`, and **NO `os`/`cpu`** (installs everywhere; launcher errors clearly on unsupported platforms).
- Main `optionalDependencies` pin each platform package at the **EXACT** version string (no `^`/`~`).
- All five package manifests share one identical version (single source: `REVIEWGATE_VERSION` env in CI, else repo-root `package.json` version).
- Platform package layout mirrors `dist/`: binary `reviewgate` at the package ROOT, with sibling `grammars/`, `bin-templates/`, `personas/`.
- No install scripts (must work under `npm ci --ignore-scripts`). No Windows, no musl (documented).
- Any broken baked binary path must make the gate **fail closed** (block), never silent-pass.
- Publish always with `--access public --provenance`; platform packages first, then main.

---

### Task 1: JS launcher (`bin/reviewgate.cjs`)

**Files:**
- Create: `bin/reviewgate.cjs`
- Test: `tests/unit/npm-launcher.test.ts`

**Interfaces:**
- Consumes: nothing (standalone Node CJS script).
- Produces: an executable that, given a resolvable `@codevena/reviewgate-<platform>-<arch>` package, spawns `<pkgRoot>/reviewgate` with the forwarded args and propagates its exit code; otherwise exits 1 with a `no prebuilt binary` message on stderr.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/npm-launcher.test.ts
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAUNCHER = join(import.meta.dir, "..", "..", "bin", "reviewgate.cjs");
const HOST_PKG = `@codevena/reviewgate-${process.platform}-${process.arch}`;

function tmp() {
  return mkdtempSync(join(tmpdir(), "rg-launch-"));
}

describe("bin/reviewgate.cjs launcher", () => {
  it("resolves the host platform package and forwards argv + exit code", () => {
    const root = tmp();
    const pkgDir = join(root, "node_modules", HOST_PKG);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: HOST_PKG, version: "0.0.0" }));
    // Fake "binary": a shell script that echoes its args and exits 7.
    const fakeBin = join(pkgDir, "reviewgate");
    writeFileSync(fakeBin, '#!/bin/sh\necho "ARGS:$*"\nexit 7\n');
    chmodSync(fakeBin, 0o755);

    const res = spawnSync(process.execPath, [LAUNCHER, "foo", "bar"], {
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: join(root, "node_modules") },
    });
    expect(res.stdout).toContain("ARGS:foo bar");
    expect(res.status).toBe(7);
  });

  it("exits 1 with a clear message when no platform package resolves", () => {
    const root = tmp(); // empty: no node_modules at all
    const res = spawnSync(process.execPath, [LAUNCHER, "doctor"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: join(root, "node_modules") },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no prebuilt binary");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/npm-launcher.test.ts`
Expected: FAIL — `bin/reviewgate.cjs` does not exist (spawn returns ENOENT / non-matching output).

- [ ] **Step 3: Write the launcher**

```js
// bin/reviewgate.cjs
#!/usr/bin/env node
"use strict";
// Reviewgate npm launcher. Resolves the prebuilt platform package and execs its
// self-contained binary, forwarding argv + stdio. Pure CJS, zero dependencies.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const PKG = `@codevena/reviewgate-${process.platform}-${process.arch}`;

let pkgRoot;
try {
  // Resolve the package.json (always present) and take its directory; avoids any
  // dependence on an `exports` map for the binary subpath.
  pkgRoot = path.dirname(require.resolve(`${PKG}/package.json`));
} catch {
  process.stderr.write(
    `reviewgate: no prebuilt binary for ${process.platform}-${process.arch}.\n` +
      `Supported platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64 (glibc).\n` +
      `If you installed with --no-optional or --ignore-scripts, reinstall without them.\n` +
      `Or install from a GitHub release: https://github.com/Codevena/reviewgate#install\n`,
  );
  process.exit(1);
}

const bin = path.join(pkgRoot, "reviewgate");
const res = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
if (res.error) {
  process.stderr.write(`reviewgate: failed to run the platform binary (${bin}): ${res.error.message}\n`);
  process.exit(1);
}
process.exit(res.status === null ? 1 : res.status);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/npm-launcher.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add bin/reviewgate.cjs tests/unit/npm-launcher.test.ts
git commit -m "feat(npm): pure-CJS launcher that resolves+spawns the platform binary"
```

---

### Task 2: init bake — extract `resolveBakedBin` + ephemeral-npx warning

**Files:**
- Modify: `src/cli/commands/init.ts` (replace the inline `bakedBin` expression at ~line 241; print the warning)
- Test: `tests/unit/init-bake.test.ts` (new)

**Interfaces:**
- Produces: `export function resolveBakedBin(execPath: string): { bakedBin: string; warning: string | null }`
  - basename not matching `/reviewgate/i` → `{ bakedBin: "", warning: null }` (bun-dev runtime; shim falls back to PATH).
  - execPath path contains `/_npx/` → `{ bakedBin: execPath, warning: <ephemeral message> }`.
  - otherwise → `{ bakedBin: execPath, warning: null }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/init-bake.test.ts
import { describe, expect, it } from "bun:test";
import { resolveBakedBin } from "../../src/cli/commands/init.ts";

describe("resolveBakedBin", () => {
  it("bakes a normal install path (global or local node_modules), no warning", () => {
    const r = resolveBakedBin("/Users/x/.npm-global/lib/node_modules/@codevena/reviewgate-darwin-arm64/reviewgate");
    expect(r.bakedBin).toBe("/Users/x/.npm-global/lib/node_modules/@codevena/reviewgate-darwin-arm64/reviewgate");
    expect(r.warning).toBeNull();
  });

  it("bakes the curl|sh install path, no warning", () => {
    const r = resolveBakedBin("/Users/x/.reviewgate/v0.1.0-alpha.1/reviewgate");
    expect(r.bakedBin).toBe("/Users/x/.reviewgate/v0.1.0-alpha.1/reviewgate");
    expect(r.warning).toBeNull();
  });

  it("does NOT bake the bun-dev runtime (basename is 'bun')", () => {
    const r = resolveBakedBin("/opt/homebrew/bin/bun");
    expect(r.bakedBin).toBe("");
    expect(r.warning).toBeNull();
  });

  it("bakes but WARNS on an ephemeral npx cache path", () => {
    const r = resolveBakedBin("/Users/x/.npm/_npx/abc123/node_modules/@codevena/reviewgate-darwin-arm64/reviewgate");
    expect(r.bakedBin).toContain("/_npx/");
    expect(r.warning).toContain("npx");
    expect(r.warning).toContain("npm i -g reviewgate");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/init-bake.test.ts`
Expected: FAIL — `resolveBakedBin` is not exported.

- [ ] **Step 3: Add `resolveBakedBin` and use it in `runInit`**

In `src/cli/commands/init.ts`, add this exported function near the top (after the imports / `shSingleQuote`):

```ts
// Decide what absolute binary path to bake into the hook shims, given the path of the
// binary that ran `init`. The launcher SPAWNS the compiled binary, so under an npm
// install process.execPath is the platform binary (basename "reviewgate"), not node —
// the same regex that gates the curl|sh and dev cases handles npm with no extra branch.
// An ephemeral `npx` cache path is still baked (it works right now) but warned about,
// because npx may garbage-collect it and the gate would then fail closed.
export function resolveBakedBin(execPath: string): { bakedBin: string; warning: string | null } {
  if (!/reviewgate/i.test(basename(execPath))) return { bakedBin: "", warning: null };
  if (execPath.includes("/_npx/")) {
    return {
      bakedBin: execPath,
      warning:
        "the reviewgate binary is in an ephemeral npx cache and may be garbage-collected, " +
        "which would make the Stop gate fail closed. For a durable gate, install it with " +
        "`npm i -g reviewgate` (or as a project devDependency) and re-run `reviewgate init`.",
    };
  }
  return { bakedBin: execPath, warning: null };
}
```

Then replace the inline computation (currently `const bakedBin = /reviewgate/i.test(basename(process.execPath)) ? process.execPath : "";`) with:

```ts
  const { bakedBin, warning: bakedWarning } = resolveBakedBin(process.execPath);
  if (bakedWarning) console.error(`reviewgate init: WARNING — ${bakedWarning}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/init-bake.test.ts tests/unit/init.test.ts`
Expected: PASS (new bake tests + the existing init suite unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/init.ts tests/unit/init-bake.test.ts
git commit -m "feat(npm): resolveBakedBin — npm execPath bakes unchanged; warn on ephemeral npx cache"
```

---

### Task 3: Package-manifest helpers in `scripts/build-npm-packages.ts`

**Files:**
- Create: `scripts/build-npm-packages.ts` (helpers only in this task; the build orchestration is Task 4)
- Test: `tests/unit/build-npm-packages.test.ts`

**Interfaces:**
- Produces:
  - `interface Target { bunTarget: string; os: "darwin" | "linux"; cpu: "arm64" | "x64" }`
  - `const TARGETS: Target[]` (the four targets)
  - `function pkgName(t: Target): string` → `@codevena/reviewgate-<os>-<cpu>`
  - `function platformManifest(t: Target, version: string): Record<string, unknown>`
  - `function mainManifest(version: string): Record<string, unknown>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/build-npm-packages.test.ts
import { describe, expect, it } from "bun:test";
import {
  TARGETS,
  mainManifest,
  pkgName,
  platformManifest,
} from "../../scripts/build-npm-packages.ts";

describe("npm package manifests", () => {
  it("covers exactly the four supported targets", () => {
    expect(TARGETS.map(pkgName).sort()).toEqual(
      [
        "@codevena/reviewgate-darwin-arm64",
        "@codevena/reviewgate-darwin-x64",
        "@codevena/reviewgate-linux-arm64",
        "@codevena/reviewgate-linux-x64",
      ].sort(),
    );
  });

  it("platformManifest sets os/cpu and (linux only) libc:[glibc]", () => {
    const darwin = platformManifest({ bunTarget: "bun-darwin-arm64", os: "darwin", cpu: "arm64" }, "1.2.3");
    expect(darwin.name).toBe("@codevena/reviewgate-darwin-arm64");
    expect(darwin.version).toBe("1.2.3");
    expect(darwin.os).toEqual(["darwin"]);
    expect(darwin.cpu).toEqual(["arm64"]);
    expect(darwin.libc).toBeUndefined();
    expect(darwin.files).toEqual(["reviewgate", "grammars", "bin-templates", "personas"]);

    const linux = platformManifest({ bunTarget: "bun-linux-x64", os: "linux", cpu: "x64" }, "1.2.3");
    expect(linux.libc).toEqual(["glibc"]);
  });

  it("mainManifest pins each platform pkg EXACTLY, declares no runtime deps, no os/cpu", () => {
    const m = mainManifest("1.2.3") as {
      name: string;
      bin: Record<string, string>;
      optionalDependencies: Record<string, string>;
      dependencies?: Record<string, string>;
      os?: unknown;
      cpu?: unknown;
      engines: Record<string, string>;
    };
    expect(m.name).toBe("reviewgate");
    expect(m.bin).toEqual({ reviewgate: "bin/reviewgate.cjs" });
    for (const t of TARGETS) {
      expect(m.optionalDependencies[pkgName(t)]).toBe("1.2.3"); // exact, not ^1.2.3
    }
    expect(m.dependencies).toBeUndefined();
    expect(m.os).toBeUndefined();
    expect(m.cpu).toBeUndefined();
    expect(m.engines.node).toBe(">=20");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/build-npm-packages.test.ts`
Expected: FAIL — module/exports do not exist.

- [ ] **Step 3: Write the helpers**

```ts
// scripts/build-npm-packages.ts
// Builds the five publishable npm packages into npm-dist/: a main `reviewgate`
// launcher package + four `@codevena/reviewgate-<os>-<arch>` prebuilt-binary packages.
// Pure helpers (TARGETS / pkgName / platformManifest / mainManifest) are unit-tested;
// the build orchestration (cross-compile + assemble) runs under `import.meta.main`.

export interface Target {
  bunTarget: string;
  os: "darwin" | "linux";
  cpu: "arm64" | "x64";
}

export const TARGETS: Target[] = [
  { bunTarget: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
  { bunTarget: "bun-darwin-x64", os: "darwin", cpu: "x64" },
  { bunTarget: "bun-linux-x64", os: "linux", cpu: "x64" },
  { bunTarget: "bun-linux-arm64", os: "linux", cpu: "arm64" },
];

export function pkgName(t: Target): string {
  return `@codevena/reviewgate-${t.os}-${t.cpu}`;
}

const REPO = "git+https://github.com/Codevena/reviewgate.git";

export function platformManifest(t: Target, version: string): Record<string, unknown> {
  return {
    name: pkgName(t),
    version,
    description: `Reviewgate prebuilt binary for ${t.os}-${t.cpu}.`,
    license: "MIT",
    author: "Markus Wiesecke (https://github.com/Codevena)",
    homepage: "https://github.com/Codevena/reviewgate#readme",
    repository: { type: "git", url: REPO },
    os: [t.os],
    cpu: [t.cpu],
    ...(t.os === "linux" ? { libc: ["glibc"] } : {}),
    files: ["reviewgate", "grammars", "bin-templates", "personas"],
  };
}

export function mainManifest(version: string): Record<string, unknown> {
  return {
    name: "reviewgate",
    version,
    description:
      "Multi-agent code review gate for Claude Code's agent loop — blocks the agent from ending its turn until an independent LLM reviewer panel signs off.",
    license: "MIT",
    author: "Markus Wiesecke (https://github.com/Codevena)",
    homepage: "https://github.com/Codevena/reviewgate#readme",
    repository: { type: "git", url: REPO },
    bugs: { url: "https://github.com/Codevena/reviewgate/issues" },
    keywords: [
      "claude-code",
      "code-review",
      "ai-agent",
      "llm",
      "codex",
      "gemini",
      "openrouter",
      "developer-tools",
      "cli",
    ],
    bin: { reviewgate: "bin/reviewgate.cjs" },
    // EXACT version pins — the consumer must get the matching platform build.
    optionalDependencies: Object.fromEntries(TARGETS.map((t) => [pkgName(t), version])),
    engines: { node: ">=20" },
    files: ["bin"],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/build-npm-packages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-npm-packages.ts tests/unit/build-npm-packages.test.ts
git commit -m "feat(npm): package-manifest helpers (TARGETS, platform/main manifests)"
```

---

### Task 4: Build orchestration — assemble `npm-dist/`

**Files:**
- Modify: `scripts/build-npm-packages.ts` (add the `import.meta.main` orchestration)
- Modify: `package.json` (add `"build:npm"` script)
- Modify: `.gitignore` (ignore `npm-dist/` and `*.tgz`)

**Interfaces:**
- Consumes: `TARGETS`, `pkgName`, `platformManifest`, `mainManifest` (Task 3); `bin/reviewgate.cjs` (Task 1).
- Produces: a populated `npm-dist/` tree: `npm-dist/main/{package.json,bin/reviewgate.cjs}` and `npm-dist/@codevena/reviewgate-<os>-<cpu>/{package.json,reviewgate,grammars/,bin-templates/,personas/}`.
- Honors env: `REVIEWGATE_VERSION` (else root `package.json` version) and `REVIEWGATE_BUILD_ONLY_CURRENT=1` (build only the host target — used by the integration test for speed).

- [ ] **Step 1: Append the orchestration to `scripts/build-npm-packages.ts`**

```ts
// ---- build orchestration (run: bun run scripts/build-npm-packages.ts) ----
if (import.meta.main) {
  const { $ } = await import("bun");
  const { rmSync, mkdirSync, cpSync, copyFileSync, writeFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");

  const root = process.cwd();
  const rootPkg = JSON.parse(await Bun.file(join(root, "package.json")).text()) as { version: string };
  const version = process.env.REVIEWGATE_VERSION ?? rootPkg.version;
  const onlyCurrent = process.env.REVIEWGATE_BUILD_ONLY_CURRENT === "1";
  const targets = onlyCurrent
    ? TARGETS.filter((t) => t.os === process.platform && t.cpu === process.arch)
    : TARGETS;
  if (onlyCurrent && targets.length === 0) {
    throw new Error(`no Reviewgate target matches host ${process.platform}-${process.arch}`);
  }

  const distRoot = join(root, "npm-dist");
  rmSync(distRoot, { recursive: true, force: true });

  // grammar + asset sources (same set as `bun run build`)
  const grammars = [
    "node_modules/web-tree-sitter/web-tree-sitter.wasm",
    ...(await Array.fromAsync(new Bun.Glob("node_modules/tree-sitter-typescript/*.wasm").scan({ cwd: root }))).map((p) => join(root, p)),
    ...(await Array.fromAsync(new Bun.Glob("node_modules/tree-sitter-python/*.wasm").scan({ cwd: root }))).map((p) => join(root, p)),
  ];

  for (const t of targets) {
    const dir = join(distRoot, pkgName(t)); // join handles the @scope/name split
    mkdirSync(join(dir, "grammars"), { recursive: true });
    mkdirSync(join(dir, "bin-templates"), { recursive: true });
    console.error(`building ${pkgName(t)} (${t.bunTarget}) …`);
    await $`bun build src/cli/index.ts --compile --target=${t.bunTarget} --outfile ${join(dir, "reviewgate")}`.cwd(root);
    for (const g of grammars) copyFileSync(g, join(dir, "grammars", g.split("/").pop()!));
    for (const sh of ["gate.sh", "trigger.sh", "reset.sh", "pre-push.sh"]) {
      copyFileSync(join(root, "bin-templates", sh), join(dir, "bin-templates", sh));
    }
    cpSync(join(root, "src", "personas"), join(dir, "personas"), { recursive: true });
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(platformManifest(t, version), null, 2)}\n`);
  }

  // main package
  const mainDir = join(distRoot, "main");
  mkdirSync(join(mainDir, "bin"), { recursive: true });
  copyFileSync(join(root, "bin", "reviewgate.cjs"), join(mainDir, "bin", "reviewgate.cjs"));
  writeFileSync(join(mainDir, "package.json"), `${JSON.stringify(mainManifest(version), null, 2)}\n`);

  console.error(`npm-dist/ built @ ${version} (${targets.length} platform package(s) + main).`);
}
```

- [ ] **Step 2: Add the `build:npm` script and gitignore entries**

In `package.json` `scripts`, add:

```json
    "build:npm": "bun run build && bun run scripts/build-npm-packages.ts",
```

(The `bun run build` prerequisite ensures `node_modules` grammars exist; the orchestration reads them.)

Append to `.gitignore` (under the existing `dist` line):

```
npm-dist
*.tgz
```

- [ ] **Step 3: Run the build and verify the tree (manual integration check)**

Run: `bun run build:npm`
Expected: `npm-dist/main/package.json`, `npm-dist/main/bin/reviewgate.cjs`, and all four `npm-dist/@codevena/reviewgate-*/` dirs each containing `reviewgate`, `grammars/web-tree-sitter.wasm`, `bin-templates/gate.sh`, `personas/`.

Verify quickly:

```bash
ls npm-dist/@codevena/*/reviewgate && ls npm-dist/main/bin/reviewgate.cjs && \
  node -e "const m=require('./npm-dist/main/package.json'); console.log(m.version, Object.keys(m.optionalDependencies))"
```

Expected: four binaries + the launcher listed; version printed with all four `@codevena/...` keys.

- [ ] **Step 4: Run the unit suite (no regressions)**

Run: `bun test tests/unit/build-npm-packages.test.ts && bunx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-npm-packages.ts package.json .gitignore
git commit -m "feat(npm): build:npm orchestration — assemble npm-dist (4 platform pkgs + main)"
```

---

### Task 5: Repurpose `verify-publish` + retire root direct-publish

**Files:**
- Modify: `scripts/verify-publish.ts` (replace `verifyDist` with `verifyNpmDist`)
- Modify: `tests/unit/verify-publish.test.ts` (rewrite for `verifyNpmDist`)
- Modify: `package.json` (remove `bin`, `files`, `prepublishOnly`; add `verify:npm`)

**Interfaces:**
- Consumes: `TARGETS`, `pkgName` (Task 3).
- Produces: `export function verifyNpmDist(distRoot: string): { ok: boolean; errors: string[] }` — validates the generated set: launcher present + shebang; main has no `dependencies`; every platform package present with binary + `grammars/web-tree-sitter.wasm` + 4 shims + correct `os`/`cpu`; all five versions identical; main `optionalDependencies` pin each platform exactly.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/verify-publish.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGETS, pkgName } from "../../scripts/build-npm-packages.ts";
import { verifyNpmDist } from "../../scripts/verify-publish.ts";

function scaffold(root: string, version: string, opts: { caret?: boolean; dropGrammar?: boolean; badVersion?: string } = {}) {
  // main
  mkdirSync(join(root, "main", "bin"), { recursive: true });
  writeFileSync(join(root, "main", "bin", "reviewgate.cjs"), "#!/usr/bin/env node\n");
  writeFileSync(
    join(root, "main", "package.json"),
    JSON.stringify({
      name: "reviewgate",
      version,
      bin: { reviewgate: "bin/reviewgate.cjs" },
      optionalDependencies: Object.fromEntries(
        TARGETS.map((t) => [pkgName(t), opts.caret ? `^${version}` : version]),
      ),
    }),
  );
  // platform packages
  for (const t of TARGETS) {
    const dir = join(root, pkgName(t));
    mkdirSync(join(dir, "grammars"), { recursive: true });
    mkdirSync(join(dir, "bin-templates"), { recursive: true });
    writeFileSync(join(dir, "reviewgate"), "");
    if (!opts.dropGrammar) writeFileSync(join(dir, "grammars", "web-tree-sitter.wasm"), "");
    for (const sh of ["gate.sh", "trigger.sh", "reset.sh", "pre-push.sh"]) writeFileSync(join(dir, "bin-templates", sh), "");
    mkdirSync(join(dir, "personas"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: pkgName(t), version: opts.badVersion ?? version, os: [t.os], cpu: [t.cpu] }),
    );
  }
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "rg-npmdist-"));
}

describe("verifyNpmDist", () => {
  it("passes on a well-formed npm-dist", () => {
    const root = tmp();
    scaffold(root, "1.2.3");
    expect(verifyNpmDist(root)).toEqual({ ok: true, errors: [] });
  });

  it("fails when a platform package version drifts", () => {
    const root = tmp();
    scaffold(root, "1.2.3", { badVersion: "1.2.4" });
    const r = verifyNpmDist(root);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("version");
  });

  it("fails when optionalDependencies use a caret range instead of an exact pin", () => {
    const root = tmp();
    scaffold(root, "1.2.3", { caret: true });
    const r = verifyNpmDist(root);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("exact");
  });

  it("fails when a grammar is missing (dead symbol graph in the shipped binary)", () => {
    const root = tmp();
    scaffold(root, "1.2.3", { dropGrammar: true });
    const r = verifyNpmDist(root);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("web-tree-sitter.wasm");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/verify-publish.test.ts`
Expected: FAIL — `verifyNpmDist` not exported.

- [ ] **Step 3: Rewrite `scripts/verify-publish.ts`**

```ts
// scripts/verify-publish.ts
//
// Publish preflight: validate the generated npm-dist/ set before `npm publish`.
// Checks the launcher, the four platform packages (binary + grammars + shims +
// os/cpu), that all five versions match, and that the main package pins each
// platform package at an EXACT version with no runtime dependencies.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TARGETS, pkgName } from "./build-npm-packages.ts";

export function verifyNpmDist(distRoot: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const mainPkgPath = join(distRoot, "main", "package.json");
  if (!existsSync(mainPkgPath)) return { ok: false, errors: ["main/package.json missing — run `bun run build:npm`"] };

  const main = JSON.parse(readFileSync(mainPkgPath, "utf8")) as {
    version: string;
    optionalDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const version = main.version;

  const launcher = join(distRoot, "main", "bin", "reviewgate.cjs");
  if (!existsSync(launcher)) errors.push("main launcher bin/reviewgate.cjs missing");
  else if (!readFileSync(launcher, "utf8").startsWith("#!")) errors.push("main launcher missing the node shebang");

  if (main.dependencies && Object.keys(main.dependencies).length > 0)
    errors.push("main package must declare NO runtime dependencies");

  for (const t of TARGETS) {
    const name = pkgName(t);
    const dir = join(distRoot, name);
    const pj = join(dir, "package.json");
    if (!existsSync(pj)) {
      errors.push(`${name}: package.json missing`);
      continue;
    }
    const m = JSON.parse(readFileSync(pj, "utf8")) as { version: string; os?: string[]; cpu?: string[] };
    if (m.version !== version) errors.push(`${name}: version ${m.version} != main ${version}`);
    if (JSON.stringify(m.os) !== JSON.stringify([t.os])) errors.push(`${name}: os must be ["${t.os}"]`);
    if (JSON.stringify(m.cpu) !== JSON.stringify([t.cpu])) errors.push(`${name}: cpu must be ["${t.cpu}"]`);
    if (!existsSync(join(dir, "reviewgate"))) errors.push(`${name}: binary 'reviewgate' missing`);
    if (!existsSync(join(dir, "grammars", "web-tree-sitter.wasm"))) errors.push(`${name}: grammars/web-tree-sitter.wasm missing`);
    for (const sh of ["gate.sh", "trigger.sh", "reset.sh", "pre-push.sh"])
      if (!existsSync(join(dir, "bin-templates", sh))) errors.push(`${name}: bin-templates/${sh} missing`);
    const pin = main.optionalDependencies?.[name];
    if (pin !== version) errors.push(`${name}: main must pin it EXACTLY at ${version} (got ${pin ?? "nothing"})`);
  }

  return { ok: errors.length === 0, errors };
}

if (import.meta.main) {
  const distRoot = join(process.cwd(), "npm-dist");
  const { ok, errors } = verifyNpmDist(distRoot);
  if (!ok) {
    console.error(`verify:npm — npm-dist is not publishable:\n  ${errors.join("\n  ")}`);
    process.exit(1);
  }
  console.error("verify:npm — npm-dist verified (launcher + 4 platform packages, versions pinned).");
}
```

- [ ] **Step 4: Edit `package.json` — retire the naive publish, add `verify:npm`**

Remove these three keys from `package.json` (the root is no longer itself published):

```json
  "bin": { "reviewgate": "./dist/reviewgate" },
  "files": ["dist", "bin-templates", "src/personas"],
```

and the `prepublishOnly` script line. Add to `scripts`:

```json
    "verify:npm": "bun run scripts/verify-publish.ts",
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test tests/unit/verify-publish.test.ts && bun run build:npm && bun run verify:npm && bunx tsc --noEmit`
Expected: tests PASS; `verify:npm` prints "npm-dist verified"; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-publish.ts tests/unit/verify-publish.test.ts package.json
git commit -m "feat(npm): verifyNpmDist publish preflight; retire root single-binary publish"
```

---

### Task 6: Hermetic end-to-end install test

**Files:**
- Create: `tests/integration/npm-install-e2e.test.ts`

**Interfaces:**
- Consumes: `build:npm` (Task 4) via `REVIEWGATE_BUILD_ONLY_CURRENT=1`; `npm pack`; the launcher + init bake (Tasks 1–2).
- Produces: proof that a real `npm install` of the packed tarballs yields a working `reviewgate` whose `init` bakes the node_modules platform-binary path and whose gate shim execs it.

- [ ] **Step 1: Write the test (it is the deliverable; it should pass once the pieces exist)**

```ts
// tests/integration/npm-install-e2e.test.ts
import { describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const HOST_PKG = `@codevena/reviewgate-${process.platform}-${process.arch}`;
const hasNpm = spawnSync("npm", ["--version"], { encoding: "utf8" }).status === 0;
const supported =
  ["darwin", "linux"].includes(process.platform) && ["arm64", "x64"].includes(process.arch);

describe.if(hasNpm && supported)("npm install end-to-end", () => {
  it("packs, installs, bakes the node_modules binary path, and the gate shim execs it", () => {
    // 1. Build only the host platform package + main, then pack both.
    execFileSync("bun", ["run", "build:npm"], {
      cwd: REPO,
      env: { ...process.env, REVIEWGATE_BUILD_ONLY_CURRENT: "1" },
      stdio: "inherit",
    });
    const stage = mkdtempSync(join(tmpdir(), "rg-e2e-stage-"));
    const mainTgz = execFileSync("npm", ["pack", "--silent", "--pack-destination", stage, join(REPO, "npm-dist", "main")], { encoding: "utf8" }).trim().split("\n").pop()!;
    const platTgz = execFileSync("npm", ["pack", "--silent", "--pack-destination", stage, join(REPO, "npm-dist", HOST_PKG)], { encoding: "utf8" }).trim().split("\n").pop()!;

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
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: proj, stdio: "inherit" });

    // 3. The host platform package resolved; `reviewgate --version` runs through launcher → binary.
    const platBin = join(proj, "node_modules", HOST_PKG, "reviewgate");
    expect(existsSync(platBin)).toBe(true);
    const ver = execFileSync(join(proj, "node_modules", ".bin", "reviewgate"), ["--version"], { encoding: "utf8" });
    expect(ver.trim().length).toBeGreaterThan(0);

    // 4. `reviewgate init` in a git repo bakes the node_modules platform-binary path.
    execFileSync("git", ["init", "-q"], { cwd: proj });
    execFileSync(join(proj, "node_modules", ".bin", "reviewgate"), ["init"], { cwd: proj, stdio: "inherit" });
    const gateShim = readFileSync(join(proj, ".reviewgate", "bin", "gate"), "utf8");
    expect(gateShim).toContain(`RG_BIN='${platBin}'`);

    // 5. The baked gate shim execs the binary (no 127, no fail-closed "not on PATH" message).
    const gate = spawnSync(join(proj, ".reviewgate", "bin", "gate"), [], { cwd: proj, encoding: "utf8", input: "" });
    expect(gate.status).toBe(0);
    expect(gate.stdout).not.toContain("is not on PATH and no baked path resolved");
  }, 180_000);
});
```

- [ ] **Step 2: Run the test**

Run: `bun test tests/integration/npm-install-e2e.test.ts`
Expected: PASS (or SKIP if `npm` absent / unsupported platform). On a Mac with npm present it builds, packs, installs, inits, and runs the gate shim.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/npm-install-e2e.test.ts
git commit -m "test(npm): hermetic npm-install→init→gate-shim end-to-end"
```

---

### Task 7: CI `publish-npm` job in `release.yml`

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `build:npm` + `verify:npm` scripts (Tasks 4–5); the `NPM_TOKEN` repo secret.
- Produces: on a `v*` tag, after the existing test gate, publishes the four platform packages then the main package to npm with provenance — gated on `NPM_TOKEN` being set.

- [ ] **Step 1: Add the job (append after the existing `release` job)**

```yaml
  publish-npm:
    needs: release
    runs-on: ubuntu-latest
    # Only run when an npm token is configured (skips on forks / contributors).
    if: ${{ github.repository == 'Codevena/reviewgate' }}
    permissions:
      contents: read
      id-token: write # npm provenance (OIDC)
    steps:
      - uses: actions/checkout@v5

      - name: Install Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Setup Node + npm (registry auth)
        uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: "https://registry.npmjs.org"

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Guard — NPM_TOKEN present
        env:
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: |
          if [ -z "${NPM_TOKEN}" ]; then
            echo "NPM_TOKEN secret not set — skipping npm publish."
            echo "skip=1" >> "$GITHUB_ENV"
          fi

      - name: Build + verify npm-dist (version from tag)
        if: ${{ env.skip != '1' }}
        env:
          REVIEWGATE_VERSION: ${{ github.ref_name }}
        run: |
          set -euo pipefail
          # strip the leading 'v' from the tag for the package version
          export REVIEWGATE_VERSION="${REVIEWGATE_VERSION#v}"
          # fail if the committed root version disagrees with the tag (no drift)
          root_ver="$(node -e "process.stdout.write(require('./package.json').version)")"
          if [ "${root_ver}" != "${REVIEWGATE_VERSION}" ]; then
            echo "version drift: package.json ${root_ver} != tag ${REVIEWGATE_VERSION}"; exit 1
          fi
          bun run build:npm
          bun run verify:npm

      - name: Publish (platform packages first, then main)
        if: ${{ env.skip != '1' }}
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
        run: |
          set -euo pipefail
          for d in npm-dist/@codevena/*; do
            npm publish "$d" --access public --provenance
          done
          npm publish npm-dist/main --access public --provenance
```

- [ ] **Step 2: Validate the workflow YAML**

Run (if `actionlint` is available, else skip):

```bash
command -v actionlint >/dev/null && actionlint .github/workflows/release.yml || echo "actionlint not installed — manual review"
```

Also sanity-check it parses:

```bash
node -e "const y=require('node:fs').readFileSync('.github/workflows/release.yml','utf8'); if(!y.includes('publish-npm')) process.exit(1); console.log('publish-npm job present')"
```

Expected: no actionlint errors; "publish-npm job present".

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): publish-npm job — platform pkgs + main, provenance, NPM_TOKEN-gated"
```

---

### Task 8: Docs — README npm section + publish runbook

**Files:**
- Modify: `README.md` (add an npm install option; recommend global; note the `npx` caveat)
- Create: `docs/dev/2026-06-23-npm-publish-runbook.md`

**Interfaces:**
- Consumes: nothing.
- Produces: user-facing install docs + the maintainer publish runbook.

- [ ] **Step 1: Add an npm install option to README**

Find the install section (the one with "Option A — download a release binary" / `curl | sh`) and add, in the same list style:

```markdown
### Option C — npm (`npm i -g reviewgate`)

```bash
npm i -g reviewgate     # installs only your platform's prebuilt binary
reviewgate init         # arm the gate in the current repo
reviewgate doctor       # health-check
```

A global install is recommended for the persistent Stop gate, because `reviewgate init`
bakes the binary's absolute path into the hook. `npx reviewgate init` works for a quick
try, but the binary lives in an ephemeral npx cache that may be garbage-collected — `init`
warns when it detects this. Supported: macOS and Linux (glibc) on arm64/x64; on other
platforms use Option A or B.
```

- [ ] **Step 2: Write the maintainer publish runbook**

```markdown
<!-- docs/dev/2026-06-23-npm-publish-runbook.md -->
# npm publish runbook

Reviewgate publishes five packages: `reviewgate` (launcher) + four
`@codevena/reviewgate-<os>-<arch>` prebuilt-binary packages. See
`docs/superpowers/specs/2026-06-23-npm-packaging-design.md`.

## One-time setup
1. `npm login` (2FA as configured).
2. Create the `@codevena` npm **org** (free for public packages): npmjs.com → Add Organization → `codevena`.
3. Add an automation/granular **publish token** as the repo secret `NPM_TOKEN`
   (GitHub → Settings → Secrets → Actions). Scope: publish for `reviewgate` + `@codevena/*`.

## Release (CI — recommended)
1. Bump `package.json` `version` (e.g. `0.1.0-alpha.2`), commit.
2. `git tag v0.1.0-alpha.2 && git push origin v0.1.0-alpha.2`.
3. The `release` workflow builds the GitHub Release tarballs; `publish-npm` then builds
   `npm-dist/`, verifies it, and publishes all five (platform packages first, then main)
   with provenance. The job fails if the tag and `package.json` version disagree.

## Release (local fallback)
```bash
bun run build:npm && bun run verify:npm
for d in npm-dist/@codevena/*; do npm publish "$d" --access public; done
npm publish npm-dist/main --access public
```

## Verify
```bash
npm i -g reviewgate@<version>
reviewgate doctor
```
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/dev/2026-06-23-npm-publish-runbook.md
git commit -m "docs(npm): README install Option C + maintainer publish runbook"
```

---

## Self-Review

**Spec coverage:**
- 5-package architecture → Tasks 1, 3, 4. ✓
- Launcher spawn semantics → Task 1. ✓
- init bake unchanged + `_npx` warn → Task 2. ✓
- `os`/`cpu`/`libc`, exact pins, no-runtime-deps, no-os/cpu-on-main → Tasks 3, 5. ✓
- Build into `npm-dist/`, single-source version, host-only flag → Task 4. ✓
- Publish preflight validator + retire naive publish → Task 5. ✓
- Hermetic local E2E (the session deliverable) → Task 6. ✓
- CI publish job, NPM_TOKEN-gated, provenance, version-drift guard → Task 7. ✓
- README install + manual publish runbook → Task 8. ✓
- Fail-closed on broken baked path → unchanged shim behavior (gate.sh), asserted in Task 6 step 5. ✓

**Placeholder scan:** none — every step ships complete code/commands.

**Type consistency:** `Target`/`TARGETS`/`pkgName`/`platformManifest`/`mainManifest` defined in Task 3 and consumed verbatim in Tasks 4, 5; `resolveBakedBin` defined and consumed in Task 2; `verifyNpmDist` defined in Task 5 and consumed by its test; `HOST_PKG` derivation identical in Tasks 1 and 6.
