# npm-proper packaging — design spec

**Date:** 2026-06-23
**Status:** approved (design), pending spec review
**Author:** Markus + Claude (Opus)

## Problem

Reviewgate ships as a `bun --compile` self-contained binary (~36 MB, one per OS/arch).
The repo's `package.json` currently declares `bin: { reviewgate: "./dist/reviewgate" }`
and `files: ["dist", …]` — a **naive single-platform publish**: `npm publish` from any
one machine would ship that machine's binary only, and break for every other OS/arch.
A `prepublishOnly` guard (`scripts/verify-publish.ts`) stops shipping an *empty* dist, but
the model itself is wrong.

We already ship the binary three other ways: GitHub Release tarballs (4 platforms, via
`release.yml`) and a `curl | sh` installer (`install.sh`). npm is the remaining
distribution channel — the one the JS audience expects (`npx reviewgate init`), and a
credibility signal for the OSS launch.

## Goals

- Publish `reviewgate` to npm such that `npm i -g reviewgate` (or `npx reviewgate …`)
  installs the **correct platform binary only**, on macOS/Linux × arm64/x64.
- Zero install scripts (works under `npm ci --ignore-scripts`, offline once cached, no
  corp-proxy download step).
- `reviewgate init` under an npm install bakes a **working** Stop-hook path — the gate
  must actually fire, and must **fail closed** (block) if the baked path ever breaks.
- The release is **fully verifiable locally without publishing** (this session's deliverable).
- CI publishes all packages on a `v*` tag, gated on an `NPM_TOKEN` secret.

## Non-goals

- **Windows.** Unsupported by Reviewgate (sandbox/`mode:off` only); the launcher errors
  clearly on `win32`. No platform package.
- **musl / Alpine.** Bun's `bun-linux-*` compile targets are **glibc-dynamic** (verified:
  `interpreter /lib64/ld-linux-x86-64.so.2`, "for GNU/Linux"). We tag linux packages
  `libc: ["glibc"]` so npm warns musl users; a musl variant is a documented future add.
- Changing how the binary is built, what the gate does, or any reviewer behavior.

## Packaging model (alternatives considered)

| Model | Verdict |
|---|---|
| Naive single-binary publish (current) | ❌ one platform only |
| `postinstall` downloads the binary | ❌ breaks under `--ignore-scripts`, offline, proxies; security smell |
| **Per-platform packages + JS launcher** (esbuild / Biome / swc pattern) | ✅ **chosen** |

npm's `os` / `cpu` fields make each platform package install **only on its matching
host**; the others are skipped (optionalDependencies that "fail" are silently dropped).
The main package is a tiny pure-JS launcher that resolves and spawns the one platform
binary that did install.

## Architecture — five packages

```
reviewgate                          (main, unscoped — name FREE on npm ✓)
  bin/reviewgate.cjs                 ~40-line zero-dependency launcher
  package.json                       optionalDependencies → the 4 below (EXACT-pinned),
                                     NO runtime dependencies, bin → bin/reviewgate.cjs

@codevena/reviewgate-darwin-arm64    (scope FREE ✓)   os:[darwin] cpu:[arm64]
@codevena/reviewgate-darwin-x64                       os:[darwin] cpu:[x64]
@codevena/reviewgate-linux-x64                        os:[linux]  cpu:[x64]  libc:[glibc]
@codevena/reviewgate-linux-arm64                      os:[linux]  cpu:[arm64] libc:[glibc]
```

Each **platform package** mirrors the existing release-tarball / `dist/` layout EXACTLY:

```
@codevena/reviewgate-<os>-<arch>/
  package.json        name/version/os/cpu/(libc), files:["reviewgate","grammars","bin-templates","personas"]
  reviewgate          the bun --compile self-contained binary (at package root)
  grammars/*.wasm     tree-sitter grammars (NOT embedded by bun --compile)
  bin-templates/*.sh  gate/trigger/reset/pre-push shims
  personas/           persona markdown
```

Binary at the package root (not under `bin/`) is deliberate: `init` resolves
`bin-templates/` and the grammars relative to `dirname(process.execPath)`, so the
binary's siblings must be `grammars/` + `bin-templates/` + `personas/` — identical to
`dist/` and the release tarballs. No code path needs to learn a new layout.

### Launcher (`bin/reviewgate.cjs`)

CommonJS (`.cjs`) so it runs regardless of the consuming package's module type. Uses
esbuild's proven resolution — resolve the platform package's `package.json`, take its
dir, spawn `reviewgate` at the root, forward argv + stdio, propagate exit code:

```js
#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const PKG = `@codevena/reviewgate-${process.platform}-${process.arch}`;
let root;
try {
  root = path.dirname(require.resolve(`${PKG}/package.json`));
} catch {
  console.error(
    `reviewgate: no prebuilt binary for ${process.platform}-${process.arch}.\n` +
      `Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64 (glibc).\n` +
      `If you used --no-optional or --ignore-scripts, reinstall without them, or\n` +
      `install from a release: https://github.com/Codevena/reviewgate#install`,
  );
  process.exit(1);
}
const res = spawnSync(path.join(root, "reviewgate"), process.argv.slice(2), {
  stdio: "inherit",
});
if (res.error) {
  console.error(`reviewgate: failed to spawn the platform binary: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
```

**Keystone property:** the launcher *spawns* the binary (it does not dispatch
subcommands in-process). So `process.execPath` inside every subcommand — including
`init` — is the **platform binary**, never `node`. This is what makes the existing
hook-baking logic keep working unchanged.

## init bake behavior under npm

`src/cli/commands/init.ts:241`:

```js
const bakedBin = /reviewgate/i.test(basename(process.execPath)) ? process.execPath : "";
```

Because the launcher spawns the binary, under an npm install `process.execPath` is e.g.
`…/node_modules/@codevena/reviewgate-darwin-arm64/reviewgate` → `basename` is
`"reviewgate"` → the regex passes → `bakedBin` = the **absolute path to the
self-contained binary**. That binary needs neither `node` nor a PATH entry at hook time,
so the Stop hook (`.reviewgate/bin/gate` → `RG_BIN='<that path>'`) runs.

Install-mode behavior:

| Install | Baked path | Durability |
|---|---|---|
| `npm i -g reviewgate` (**recommended for the persistent gate**) | `$(npm root -g)/@codevena/…/reviewgate` | stable; survives across projects |
| local devDep | `<proj>/node_modules/@codevena/…/reviewgate` | stable across reinstalls; breaks only if `node_modules` is deleted-without-reinstall → gate **fails closed** + PATH-fallback; re-run `init` |
| `npx reviewgate init` | ephemeral `~/.npm/_npx/<hash>/…` | fragile (npx may GC the cache) → gate **fails closed**; see below |

**The only init code change:** when `process.execPath` points into an ephemeral npm cache
(path contains `/_npx/` or `/_cacache/`), `init` still bakes it but prints a **WARN**:
"the reviewgate binary is in an ephemeral npx cache and may be garbage-collected, which
would make the gate fail closed — install it durably with `npm i -g reviewgate` (or as a
project devDep) and re-run `reviewgate init`." Plus a unit test that locks the bake
behavior for an npm-style execPath (basename `reviewgate`, node_modules path → baked;
`_npx` path → baked **and** warns).

No path rewrite, no launcher-detection branch, no new "npm mode". The failure mode is
always safe: a broken baked path makes the gate **block**, never silent-pass.

## Build pipeline

### `scripts/build-npm-packages.ts` (new)

Pure Bun script, deterministic, no network. Steps:

1. Read version from a single source (the tag in CI; the repo root `package.json` version
   locally). Refuse to build if any of the 5 manifests would disagree.
2. For each of the 4 targets: `bun build src/cli/index.ts --compile --target=<bun-target>
   --outfile npm-dist/@codevena/reviewgate-<os>-<arch>/reviewgate`, then copy
   `grammars/` (the 3 `.wasm`), `bin-templates/*.sh`, `personas/` next to it. Write the
   platform `package.json` (name, version, `os`, `cpu`, `libc` for linux, `license`,
   `repository`, `files`, `description`).
3. Generate the main package into `npm-dist/main/`: copy `bin/reviewgate.cjs`; write
   `package.json` with `name: "reviewgate"`, the version, `bin`, `optionalDependencies`
   with **exact** (`=`/pinned, not `^`) versions of all 4 platform packages, NO runtime
   `dependencies`, `engines.node >= 20`, plus the existing metadata (keywords, repo, etc.).
4. `npm-dist/` is gitignored.

### `scripts/verify-publish.ts` (repurposed)

Replace the old single-dist check with a generated-set validator:

- main launcher present and starts with the node shebang;
- all 4 platform packages present, each with a binary, `grammars/web-tree-sitter.wasm`,
  the 4 shims, `personas/`, and `os`/`cpu` set correctly (and `libc` on linux);
- **all 5 versions identical**;
- main's `optionalDependencies` pin each platform package at that exact version;
- main declares NO runtime `dependencies`.

Runs as the publish preflight (CI) and is callable locally.

### `release.yml` — add `publish-npm`

A job that, after the existing test gate and tarball build:

- runs `scripts/build-npm-packages.ts` with the tag version (reusing the already-built
  trees where practical);
- runs the `verify-publish` validator;
- `npm publish` each **platform package first**, then the **main package**, with
  `--access public --provenance` (`id-token: write` for npm provenance);
- **gated on the `NPM_TOKEN` secret** — if absent (forks, contributors), the job is
  skipped, not failed.

Version is stamped from `${GITHUB_REF_NAME#v}` into every generated manifest; the job
fails if the committed root `package.json` version doesn't match the tag (no
accidental version drift).

### Root `package.json`

Retire the naive direct-publish path: root is the **dev manifest only**, no longer
itself published. Remove/repurpose `bin`, `files`, and the `prepublishOnly` hook that
assumed a root publish (the validator now runs in CI against `npm-dist/`, and as a
manual `bun run build:npm && bun run verify:npm`). Keep all dev scripts/deps. Add
`build:npm` and `verify:npm` scripts.

## This session's deliverable — full local verification (NO publish)

1. `bun run build:npm` → 5 package dirs under `npm-dist/`.
2. `npm pack` each → 5 real `.tgz` tarballs in a staging dir.
3. Hermetic end-to-end in a temp dir (no registry):
   - temp project whose `package.json` uses `overrides` to point the 4 platform deps at
     the local tarballs, and installs the main tarball;
   - `npm install` → assert only the host-matching platform package resolves;
   - `node_modules/.bin/reviewgate --version` → launcher resolves + spawns the binary;
   - `reviewgate init` in a temp **git** repo → assert `.claude/settings.json` Stop hook
     command resolves to `.reviewgate/bin/gate`, and the baked `RG_BIN` in that shim is
     the **node_modules platform-binary path** and is executable;
   - run the `gate` shim once → confirms it execs the binary (no 127 / no empty stdout).
4. `bunx tsc --noEmit` + `bun run lint` + full `bun test` (incl. new launcher + init-bake
   tests) all green.

## Manual publish runbook (the user's step — documented in README + docs/dev note)

1. `npm login` (account exists; 2FA as configured).
2. Create the `@codevena` npm **org** (free for public packages) once.
3. Bump root `package.json` version (e.g. `0.1.0-alpha.2`), commit, tag `v0.1.0-alpha.2`,
   push the tag → CI publishes all 5 (with `NPM_TOKEN` set as a repo secret).
   *Or* publish locally: `bun run build:npm && bun run verify:npm`, then
   `npm publish npm-dist/@codevena/* && npm publish npm-dist/main` with `--access public`.
4. Verify: fresh `npm i -g reviewgate@<tag>` on macOS → `reviewgate doctor`.

## Testing plan

- **Unit:** launcher resolution (mock `require.resolve` success/miss → spawn args / exit
  1 + message); init-bake decision table (binary execPath → baked; `_npx` execPath →
  baked + WARN; bun-runtime execPath → empty); `build-npm-packages` manifest generation
  (versions equal, optionalDependencies pinned, os/cpu correct); `verify-publish`
  validator rejects a mismatched-version / missing-grammar / `^`-ranged set.
- **Integration (local, gated on `npm` present):** the hermetic temp-project install +
  `init` + gate-shim smoke test from the deliverable above.

## Risks / mitigations

- **Baked node_modules path breaks on `node_modules` wipe** → gate fails **closed**
  (safe) + PATH fallback + documented re-`init`. Recommend global install for the gate.
- **`npx` ephemeral binary** → WARN in init + README guidance.
- **Cross-compile correctness** → verified all 4 targets build from macOS; CI re-builds
  on ubuntu; the hermetic test exercises the host target end-to-end.
- **Version drift across 5 manifests** → single-source version + validator + CI tag check.
- **Scoped packages default to restricted** → always publish `--access public`.
```
