# Linux `bwrap` Filesystem Sandbox Implementation Plan (Sandbox Increment 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sandbox.mode:"strict"|"permissive"` actually filesystem-isolate a reviewer subprocess on **Linux** via `bubblewrap` (`bwrap`), mirroring the macOS `sandbox-exec` increment.

**Architecture:** A `buildBwrapArgs` translator turns the OS-agnostic `SandboxProfile` into a bwrap mount-namespace argv (deny-mirror: `--ro-bind / /` read-only, `--bind` the writable area, then mask secrets LAST via `--tmpfs` (dirs) / `--ro-bind /dev/null` (files)). `spawnSafely` gains a Linux branch that creates write targets, builds the argv, and wraps the command as `bwrap … -- <command>`. A single `sandboxRuntimeAvailable()` probe (darwin→`sandbox-exec`, linux→`bwrap`) drives both `spawnSafely` and `doctor`. Glob-denies are documented as not-enforced on Linux (mount model can't pattern-match).

**Tech Stack:** Bun, TypeScript, Linux `bubblewrap` (`bwrap`), `node:child_process`, `node:fs`.

**Spec:** `docs/superpowers/specs/2026-05-30-linux-bwrap-sandbox-filesystem-design.md`

---

## File Structure

- **Modify** `src/sandbox/profile-builder.ts` — add optional classified `fs.writeTargets` + `WriteTarget` type; populate in `buildSandboxProfile`.
- **Create** `src/sandbox/bwrap.ts` — `buildBwrapArgs(profile): string[]` (fs-reading, non-mutating) + bidirectional overlap guard.
- **Modify** `src/sandbox/availability.ts` — `bwrapAvailable()`, `sandboxRuntimeAvailable()`, `__resetBwrapCache()`.
- **Modify** `src/utils/spawn.ts` — `ensureWriteTargets` helper + platform-aware sandbox branch (darwin unchanged, linux new).
- **Modify** `src/sandbox/doctor-check.ts` — `available` verdict from the shared probe (kill the `--uid 0` divergence).
- **Modify** `src/cli/commands/doctor.ts` — repoint the strict-fail check at `sandboxRuntimeAvailable()`, platform-neutral message.
- **Modify** `tests/unit/spawn-sandbox.test.ts` — re-gate the "unavailable → throws" test on runtime availability (else it breaks on a Linux+bwrap CI).
- **Create** `tests/unit/bwrap.test.ts`, `tests/unit/ensure-write-targets.test.ts`, `tests/integration/bwrap-real.test.ts`; **extend** `tests/unit/sandbox-availability.test.ts`, `tests/unit/sandbox.test.ts`.
- **Modify** `CLAUDE.md` — limitations note.

**Why `writeTargets` is OPTIONAL:** six existing files build `SandboxProfile` literals (`sbpl.test.ts`, `spawn-sandbox.test.ts`, `orchestrator-sandbox.test.ts`, `codex-adapter.test.ts`, `sandbox.test.ts`, `sandbox-exec-real.test.ts`). A required field would break `tsc` for all of them; an optional field is additive. Consumers read `profile.fs.writeTargets ?? []`.

---

## Task 1: `profile-builder` — classified `writeTargets`

**Files:**
- Modify: `src/sandbox/profile-builder.ts`
- Test: `tests/unit/sandbox.test.ts`

- [ ] **Step 1: Write the failing test (append to `tests/unit/sandbox.test.ts`)**

```typescript
it("emits classified writeTargets: findings=file/create, own-creds=dir/no-create, writablePaths=dir/create", () => {
  const p = buildSandboxProfile({
    providerId: "codex",
    mode: "strict",
    workingDir: "/repo",
    findingsPath: "/repo/.reviewgate/findings/codex.md",
    tmpDir: "/tmp/rg-run-1",
    writablePaths: ["/repo/.cache"],
  });
  const t = p.fs.writeTargets ?? [];
  expect(t).toContainEqual({ path: "/repo/.reviewgate/findings/codex.md", kind: "file", createIfMissing: true });
  expect(t).toContainEqual({ path: "/tmp/rg-run-1", kind: "dir", createIfMissing: true });
  expect(t).toContainEqual({ path: "/repo/.cache", kind: "dir", createIfMissing: true });
  // every codex own-cred dir is present as a non-creating dir target
  expect(t.some((x) => x.path.includes(".codex") && x.kind === "dir" && x.createIfMissing === false)).toBe(true);
});

it("mode:off → empty writeTargets", () => {
  const p = buildSandboxProfile({
    providerId: "codex",
    mode: "off",
    workingDir: "/repo",
    findingsPath: "/repo/f.md",
    tmpDir: "/tmp/x",
  });
  expect(p.fs.writeTargets).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/sandbox.test.ts -t "classified writeTargets"`
Expected: FAIL — `writeTargets` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/sandbox/profile-builder.ts`, add the type (after the `SandboxProfile` interface or just above it):

```typescript
export interface WriteTarget {
  path: string;
  kind: "file" | "dir";
  // Create the path with `kind` if it's missing when the sandbox is built. false =
  // bind only if it already exists (own-cred dirs: a missing one has no token to
  // refresh — don't fabricate an empty cred dir under the read-only home).
  createIfMissing: boolean;
}
```

Add to the `SandboxProfile.fs` shape (optional — see plan header):

```typescript
    writeAllow: string[];
    writeTargets?: WriteTarget[]; // classified companion to writeAllow; Linux-only consumer
```

In `buildSandboxProfile`, the `mode === "off"` early return — add `writeTargets: []`:

```typescript
      fs: { readAllow: [], readDeny: [], readDenyGlobs: [], writeAllow: [], writeTargets: [] },
```

After the existing `writeAllow` line, build `writeTargets` and add it to the returned `fs`:

```typescript
  const writeAllow = [input.findingsPath, input.tmpDir, ...own, ...(input.writablePaths ?? [])];
  const writeTargets: WriteTarget[] = [
    { path: input.findingsPath, kind: "file", createIfMissing: true },
    { path: input.tmpDir, kind: "dir", createIfMissing: true },
    ...own.map((p) => ({ path: p, kind: "dir" as const, createIfMissing: false })),
    ...(input.writablePaths ?? []).map((p) => ({ path: p, kind: "dir" as const, createIfMissing: true })),
  ];

  return {
    sandboxRequested: true,
    fs: { readAllow, readDeny, readDenyGlobs, writeAllow, writeTargets },
    net: { allow: NETWORK_ALLOW[input.providerId] },
    budget: { walltimeMs: input.walltimeMs ?? 300_000 },
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/sandbox.test.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/profile-builder.ts tests/unit/sandbox.test.ts
git commit -m "feat(sandbox): classified writeTargets companion on SandboxProfile"
```

---

## Task 2: `bwrap.ts` — `buildBwrapArgs` translator

**Files:**
- Create: `src/sandbox/bwrap.ts`
- Test: `tests/unit/bwrap.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/bwrap.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBwrapArgs } from "../../src/sandbox/bwrap.ts";
import type { SandboxProfile } from "../../src/sandbox/profile-builder.ts";

// Create a real fixture: a writable dir + writable file, a secret dir + secret file,
// and a non-existent secret — so the statSync/existsSync branches are exercised.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rg-bwrap-"));
  const workDir = join(root, "work");
  const findFile = join(root, "findings.md");
  const secretDir = join(root, ".ssh");
  const secretFile = join(root, ".netrc");
  const absent = join(root, "does-not-exist");
  mkdirSync(workDir, { recursive: true });
  writeFileSync(findFile, "");
  mkdirSync(secretDir, { recursive: true });
  writeFileSync(secretFile, "secret");
  const profile: SandboxProfile = {
    sandboxRequested: true,
    fs: {
      readAllow: [],
      readDeny: [secretDir, secretFile, absent],
      readDenyGlobs: ["*.pem", ".env"],
      writeAllow: [workDir, findFile],
      writeTargets: [],
    },
    net: { allow: [] },
    budget: { walltimeMs: 30_000 },
  };
  return { profile, workDir, findFile, secretDir, secretFile, absent };
}

describe("buildBwrapArgs", () => {
  it("emits the namespace flags, ro-root, isolated dev/proc, and a -- terminator", () => {
    const { profile } = fixture();
    const a = buildBwrapArgs(profile);
    expect(a.slice(0, 3)).toEqual(["--die-with-parent", "--unshare-user", "--unshare-pid"]);
    expect(a).toContain("--ro-bind");
    expect(a.join(" ")).toContain("--ro-bind / /");
    expect(a.join(" ")).toContain("--dev /dev");
    expect(a.join(" ")).toContain("--proc /proc");
    expect(a[a.length - 1]).toBe("--");
    expect(a).not.toContain("--unshare-net");
  });

  it("binds each EXISTING writeAllow at its own location (file→file, dir→dir)", () => {
    const { profile, workDir, findFile } = fixture();
    const a = buildBwrapArgs(profile);
    const j = a.join(" ");
    expect(j).toContain(`--bind ${workDir} ${workDir}`);
    expect(j).toContain(`--bind ${findFile} ${findFile}`);
  });

  it("masks an existing secret DIR with --tmpfs and an existing secret FILE with --ro-bind /dev/null; skips a non-existent secret", () => {
    const { profile, secretDir, secretFile, absent } = fixture();
    const a = buildBwrapArgs(profile);
    const j = a.join(" ");
    expect(j).toContain(`--tmpfs ${secretDir}`);
    expect(j).toContain(`--ro-bind /dev/null ${secretFile}`);
    expect(a).not.toContain(absent); // non-existent readDeny → no mount
  });

  it("emits every deny-mask AFTER every writable bind (mask-last)", () => {
    const { profile } = fixture();
    const a = buildBwrapArgs(profile);
    const lastBind = a.lastIndexOf("--bind");
    const firstTmpfs = a.indexOf("--tmpfs");
    expect(firstTmpfs).toBeGreaterThan(lastBind);
  });

  it("ignores readDenyGlobs entirely (documented Linux gap)", () => {
    const { profile } = fixture();
    const a = buildBwrapArgs(profile);
    expect(a.join(" ")).not.toContain("*.pem");
    expect(a.join(" ")).not.toContain(".env");
  });

  it("throws when writeAllow and readDeny are nested (either direction)", () => {
    const { profile, secretDir } = fixture();
    expect(() => buildBwrapArgs({ ...profile, fs: { ...profile.fs, writeAllow: [join(secretDir, "leak")] } })).toThrow(
      /write-only|nested|conflict/i,
    );
    expect(() => buildBwrapArgs({ ...profile, fs: { ...profile.fs, writeAllow: [secretDir.replace(/\.ssh$/, "")] } })).toThrow(
      /write-only|nested|conflict/i,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/bwrap.test.ts`
Expected: FAIL — cannot find module `src/sandbox/bwrap.ts`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/sandbox/bwrap.ts
import { existsSync, statSync } from "node:fs";
import type { SandboxProfile } from "./profile-builder.ts";

const isUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(`${parent}/`);

// Build the bubblewrap argv (up to and including the `--` terminator) that
// filesystem-isolates a reviewer on Linux. Deny-mirror: expose / read-only, bind the
// writable working area, then mask secrets LAST so no writable bind can shadow a
// mask. fs-reading (statSync/existsSync to classify file vs dir) but NON-mutating:
// every writeAllow target must already exist (spawnSafely's ensureWriteTargets ran
// first) and every path must already be absolute + realpath'd (resolveForSandbox).
export function buildBwrapArgs(profile: SandboxProfile): string[] {
  // Bidirectional overlap guard (parity with the macOS write-only guard): a write
  // path under a deny path is write-only; a deny path under a write path would be
  // un-masked AND writable. Either nesting → throw.
  for (const w of profile.fs.writeAllow) {
    for (const d of profile.fs.readDeny) {
      if (isUnder(w, d) || isUnder(d, w)) {
        throw new Error(`bwrap conflict: writeAllow ${w} and readDeny ${d} are nested (write-only/un-mask)`);
      }
    }
  }

  const args: string[] = [
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
  ];

  // Writable binds first, each at its OWN location (file→file, dir→dir). Skip any
  // that don't exist (e.g. an absent own-cred candidate ensureWriteTargets left
  // alone) — bwrap can't bind a non-existent source.
  for (const p of profile.fs.writeAllow) {
    if (!existsSync(p)) continue;
    args.push("--bind", p, p);
  }

  // Secret masks LAST (so a writable bind can never shadow them). A directory → an
  // empty tmpfs; a file → /dev/null (tmpfs cannot mount onto a regular file). Skip
  // non-existent (nothing to hide). readDenyGlobs are NOT enforced (documented gap).
  for (const p of profile.fs.readDeny) {
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) {
      args.push("--tmpfs", p);
    } else {
      args.push("--ro-bind", "/dev/null", p);
    }
  }

  args.push("--");
  return args;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/bwrap.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/bwrap.ts tests/unit/bwrap.test.ts
git commit -m "feat(sandbox): buildBwrapArgs — bwrap argv from SandboxProfile (deny-mirror, file/dir masks, overlap guard)"
```

---

## Task 3: `availability.ts` — `bwrapAvailable` + unified probe

**Files:**
- Modify: `src/sandbox/availability.ts`
- Test: `tests/unit/sandbox-availability.test.ts`

- [ ] **Step 1: Write the failing test (append to `tests/unit/sandbox-availability.test.ts`)**

```typescript
import {
  __resetBwrapCache,
  bwrapAvailable,
  sandboxRuntimeAvailable,
} from "../../src/sandbox/availability.ts";

describe("bwrapAvailable", () => {
  it("returns a boolean; false off-linux; memoizes", async () => {
    __resetBwrapCache();
    const a = await bwrapAvailable();
    expect(typeof a).toBe("boolean");
    if (platform() !== "linux") expect(a).toBe(false);
    const b = await bwrapAvailable();
    expect(a).toBe(b);
  });
});

describe("sandboxRuntimeAvailable", () => {
  it("delegates per platform and is false on unsupported OSes", async () => {
    const r = await sandboxRuntimeAvailable();
    expect(typeof r).toBe("boolean");
    if (platform() !== "darwin" && platform() !== "linux") expect(r).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/sandbox-availability.test.ts`
Expected: FAIL — `bwrapAvailable` / `sandboxRuntimeAvailable` / `__resetBwrapCache` not exported.

- [ ] **Step 3: Write minimal implementation (append to `src/sandbox/availability.ts`)**

```typescript
let bwrapCached: boolean | null = null;

// True when `bwrap` can actually build a namespace with the SAME flags production
// uses (so a probe-pass / production-fail mismatch can't happen). Linux only;
// memoized. Deliberately NO `--uid 0` (production runs as the mapped real user).
// A locked-down host (Ubuntu 24.04 unprivileged-userns AppArmor restriction) makes
// the --unshare-* trip and this returns false → strict fails closed.
export function bwrapAvailable(): Promise<boolean> {
  if (bwrapCached !== null) return Promise.resolve(bwrapCached);
  if (platform() !== "linux") {
    bwrapCached = false;
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const child = spawn(
      "bwrap",
      ["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "true"],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    child.on("exit", (code) => {
      bwrapCached = code === 0;
      resolve(bwrapCached);
    });
    child.on("error", () => {
      bwrapCached = false;
      resolve(false);
    });
  });
}

// The single availability entry point used by spawnSafely AND doctor, so they agree.
export function sandboxRuntimeAvailable(): Promise<boolean> {
  const plat = platform();
  if (plat === "darwin") return sandboxExecAvailable();
  if (plat === "linux") return bwrapAvailable();
  return Promise.resolve(false);
}

// Test-only: reset the bwrap memo so a test can re-probe.
export function __resetBwrapCache(): void {
  bwrapCached = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/sandbox-availability.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/availability.ts tests/unit/sandbox-availability.test.ts
git commit -m "feat(sandbox): bwrapAvailable + sandboxRuntimeAvailable (single shared probe)"
```

---

## Task 4: `spawnSafely` — Linux branch + `ensureWriteTargets`

**Files:**
- Modify: `src/utils/spawn.ts`
- Modify: `tests/unit/spawn-sandbox.test.ts`

- [ ] **Step 1: Write/adjust the failing tests**

First, **re-gate the existing "unavailable → throws" test** in `tests/unit/spawn-sandbox.test.ts`. Replace its guard `if (platform() === "darwin") return;` with a runtime-availability guard (else it breaks on a Linux host that HAS bwrap, where the call now succeeds instead of throwing):

```typescript
  it("strict + sandbox unavailable → throws SandboxUnavailableError", async () => {
    const { sandboxRuntimeAvailable } = await import("../../src/sandbox/availability.ts");
    if (await sandboxRuntimeAvailable()) return; // only meaningful where NO runtime exists
    const dir = mkdtempSync(join(tmpdir(), "rg-spawnsb2-"));
    await expect(
      spawnSafely({
        command: "/bin/echo",
        args: ["hi"],
        ...run(dir),
        sandbox: { profile: okProfile, mode: "strict" },
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });
```

Then **add a Linux applied-sandbox test** (mirrors the existing darwin one):

```typescript
  it("(linux) applies bwrap and the command still runs + reports sandboxApplied", async () => {
    const { bwrapAvailable } = await import("../../src/sandbox/availability.ts");
    if (platform() !== "linux" || !(await bwrapAvailable())) return; // linux+bwrap only
    const dir = mkdtempSync(join(tmpdir(), "rg-spawnsb-lnx-"));
    const res = await spawnSafely({
      command: "/bin/echo",
      args: ["hi"],
      ...run(dir),
      sandbox: { profile: okProfile, mode: "strict" },
    });
    expect(res.exitCode).toBe(0);
    expect(res.sandboxApplied).toBe(true);
    expect(readFileSync(join(dir, "out"), "utf8").trim()).toBe("hi");
  });
```

(`okProfile` already exists in this file; it has no `writeTargets`, which is fine — the Linux branch reads `?? []`.)

- [ ] **Step 2: Run tests to verify they fail (or no-op-skip on macOS)**

Run: `bun test tests/unit/spawn-sandbox.test.ts`
Expected (macOS): the new linux test early-returns (no assertion); the re-gated test also early-returns since macOS HAS a runtime. To prove the wiring compiles, the suite must still pass; the real failing signal here is `tsc` (next) and the Linux e2e. On Linux without bwrap the unavailable test runs and (pre-impl) fails to import the new branch behavior.

- [ ] **Step 3: Write minimal implementation**

In `src/utils/spawn.ts`:

1. Extend the `node:fs` import and add `node:os`/`node:path`/availability/bwrap imports:

```typescript
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bwrapAvailable, sandboxExecAvailable, sandboxRuntimeAvailable } from "../sandbox/availability.ts";
import { buildBwrapArgs } from "../sandbox/bwrap.ts";
import { SandboxUnavailableError } from "../sandbox/errors.ts";
import type { SandboxProfile, WriteTarget } from "../sandbox/profile-builder.ts";
import { buildMacosSbpl, resolveForSandbox } from "../sandbox/sbpl.ts";
```

(`sandboxExecAvailable`/`bwrapAvailable` need not both be imported if unused — keep only what the final body references; `sandboxRuntimeAvailable` is the one used below. Drop the unused names to satisfy lint.)

2. Add the `ensureWriteTargets` helper above `spawnSafely`:

```typescript
// Bring each write target into existence with the right kind BEFORE bwrap builds its
// read-only-root namespace (the reviewer can't create them inside). Never touches an
// existing path (so an existing file passed as a dir target won't crash mkdir, and
// binds per its real kind); never fabricates a createIfMissing:false own-cred dir.
function ensureWriteTargets(targets: WriteTarget[]): void {
  for (const t of targets) {
    if (existsSync(t.path)) continue;
    if (!t.createIfMissing) continue;
    if (t.kind === "file") {
      mkdirSync(dirname(t.path), { recursive: true });
      writeFileSync(t.path, "");
    } else {
      mkdirSync(t.path, { recursive: true });
    }
  }
}
```

3. Replace the existing sandbox block (the `if (input.sandbox) { … }` that currently only does macOS) with the platform-aware version:

```typescript
  if (input.sandbox) {
    const available = await sandboxRuntimeAvailable();
    if (available) {
      const home = homedir();
      const prof = input.sandbox.profile;
      const resolved: SandboxProfile = {
        ...prof,
        fs: {
          readAllow: prof.fs.readAllow.map((p) => resolveForSandbox(p, home)),
          readDeny: prof.fs.readDeny.map((p) => resolveForSandbox(p, home)),
          readDenyGlobs: prof.fs.readDenyGlobs, // globs are NOT realpath'd
          writeAllow: prof.fs.writeAllow.map((p) => resolveForSandbox(p, home)),
          writeTargets: (prof.fs.writeTargets ?? []).map((t) => ({
            ...t,
            path: resolveForSandbox(t.path, home),
          })),
        },
      };
      if (platform() === "darwin") {
        const sbpl = buildMacosSbpl(resolved);
        sbDir = mkdtempSync(join(tmpdir(), "rg-sbpl-"));
        const sbplFile = join(sbDir, "profile.sb");
        writeFileSync(sbplFile, sbpl, { mode: 0o600 });
        args = ["-f", sbplFile, command, ...args];
        command = "sandbox-exec";
      } else {
        // Linux: create write targets, then wrap the command in bwrap. No temp
        // profile file — the bwrap config IS argv.
        ensureWriteTargets(resolved.fs.writeTargets ?? []);
        args = [...buildBwrapArgs(resolved), command, ...args];
        command = "bwrap";
      }
      sandboxApplied = true;
    } else if (input.sandbox.mode === "strict") {
      throw new SandboxUnavailableError(
        `sandbox.mode='strict' requested but no OS sandbox is available on this host (${platform()}). On macOS use sandbox-exec; on Linux install bubblewrap (bwrap) and enable unprivileged user namespaces. Set mode='permissive' to run unisolated, or 'off' for trusted local dev.`,
      );
    } else {
      sandboxFellBack = true;
    }
  }
```

(The `sbDir` cleanup in `settle()` already guards `if (sbDir)`, so the Linux branch — which leaves `sbDir` null — is a no-op there. `sandboxApplied`/`sandboxFellBack` are already in `SpawnResult`.)

- [ ] **Step 4: Verify build + tests**

Run: `bunx tsc --noEmit`
Expected: clean (the unused-import note above must be resolved — only import what the body uses).
Run: `bun test tests/unit/spawn-sandbox.test.ts tests/unit/codex-adapter.test.ts tests/integration/sandbox-exec-real.test.ts`
Expected (macOS): PASS — darwin path unchanged, the macOS real e2e still proves isolation; linux tests early-return.

- [ ] **Step 5: Commit**

```bash
git add src/utils/spawn.ts tests/unit/spawn-sandbox.test.ts
git commit -m "feat(sandbox): spawnSafely wraps the command in bwrap on Linux (ensureWriteTargets + platform branch)"
```

---

## Task 5: `doctor` — single-probe consistency

**Files:**
- Modify: `src/sandbox/doctor-check.ts`
- Modify: `src/cli/commands/doctor.ts`
- Test: `tests/unit/sandbox-availability.test.ts` (one invariant test)

- [ ] **Step 1: Write the failing test (append to `tests/unit/sandbox-availability.test.ts`)**

```typescript
import { checkSandboxHealth } from "../../src/sandbox/doctor-check.ts";

describe("checkSandboxHealth single-probe consistency", () => {
  it("its available verdict equals the shared sandboxRuntimeAvailable() probe", async () => {
    __resetBwrapCache();
    __resetSandboxExecCache();
    const health = await checkSandboxHealth();
    const shared = await sandboxRuntimeAvailable();
    expect(health.available).toBe(shared);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or already passes by luck)**

Run: `bun test tests/unit/sandbox-availability.test.ts -t "single-probe"`
Expected: may FAIL where the local `--uid 0` `bwrapTest` disagrees with `bwrapAvailable()`; on macOS the booleans coincide so it could pass — the implementation below makes it true by construction on all hosts.

- [ ] **Step 3: Write minimal implementation**

In `src/sandbox/doctor-check.ts`, import the shared probes and make `available` come from them (keep the local `*Test()` only for the human `detail` string):

```typescript
import { bwrapAvailable, sandboxExecAvailable } from "./availability.ts";
```

```typescript
export async function checkSandboxHealth(): Promise<SandboxHealthReport> {
  const plat = platform();
  if (plat === "darwin") {
    const available = await sandboxExecAvailable(); // shared probe = source of truth
    const r = await sandboxExecTest(); // detail string only
    return { platform: plat, available, detail: r.detail };
  }
  if (plat === "linux") {
    const available = await bwrapAvailable(); // shared probe = source of truth
    const r = await bwrapTest(); // detail string only
    return {
      platform: plat,
      available,
      detail: r.detail,
      ...(available
        ? {}
        : {
            remediation:
              "On Ubuntu 24.04+, run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 (or install an AppArmor profile for bwrap).",
          }),
    };
  }
  return {
    platform: plat,
    available: false,
    detail: `Platform ${plat} not supported by the filesystem sandbox.`,
    remediation: 'Use WSL2 on Windows, or set sandbox.mode="off" explicitly.',
  };
}
```

In `src/cli/commands/doctor.ts`, repoint the strict-fail check (the `sbMode !== "off"` block, ~line 380) at the unified probe and make the message platform-neutral:

```typescript
import { sandboxRuntimeAvailable } from "../../sandbox/availability.ts"; // replace sandboxExecAvailable import
// …
    const sbMode = cfg.sandbox.mode;
    if (sbMode !== "off") {
      const ok = await sandboxRuntimeAvailable();
      checks.push({
        name: "sandbox isolation",
        status: ok ? "ok" : sbMode === "strict" ? "fail" : "warn",
        detail: ok
          ? `OS sandbox available (mode=${sbMode})`
          : `OS sandbox unavailable — mode=${sbMode} will ${sbMode === "strict" ? "REFUSE to review (fail closed)" : "run reviewers UNISOLATED"}`,
      });
    }
```

- [ ] **Step 4: Verify**

Run: `bunx tsc --noEmit && bun test tests/unit/sandbox-availability.test.ts tests/unit/doctor.test.ts`
Expected: clean + PASS.
Run: `bun run dev doctor`
Expected (macOS): `✓ sandbox (darwin)` and, with a strict/permissive config present, `✓ sandbox isolation: OS sandbox available`.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/doctor-check.ts src/cli/commands/doctor.ts tests/unit/sandbox-availability.test.ts
git commit -m "feat(sandbox): doctor uses the single shared runtime probe (kill --uid 0 divergence)"
```

---

## Task 6: `ensureWriteTargets` unit test (mutation contract)

**Files:**
- Create: `tests/unit/ensure-write-targets.test.ts`

> `ensureWriteTargets` is a private helper in `spawn.ts`. To unit-test it without exporting internals, this task tests the SAME contract through `spawnSafely`'s observable effect on disk on Linux, and falls back to a direct re-implementation guard on macOS. Simplest robust approach: **export `ensureWriteTargets` from `spawn.ts`** (it's a pure-ish fs helper, harmless to export) and test it directly.

- [ ] **Step 1: Export the helper** — in `src/utils/spawn.ts` change `function ensureWriteTargets` to `export function ensureWriteTargets`.

- [ ] **Step 2: Write the test**

```typescript
// tests/unit/ensure-write-targets.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWriteTargets } from "../../src/utils/spawn.ts";

describe("ensureWriteTargets", () => {
  it("creates a missing file target (with parent) and a missing dir target", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-ewt-"));
    const file = join(root, "nested/findings.md");
    const dir = join(root, "run-tmp");
    ensureWriteTargets([
      { path: file, kind: "file", createIfMissing: true },
      { path: dir, kind: "dir", createIfMissing: true },
    ]);
    expect(statSync(file).isFile()).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it("never fabricates a createIfMissing:false target (own-cred dir)", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-ewt2-"));
    const cred = join(root, ".codex");
    ensureWriteTargets([{ path: cred, kind: "dir", createIfMissing: false }]);
    expect(existsSync(cred)).toBe(false);
  });

  it("leaves an existing path untouched (an existing FILE passed as a dir target does NOT crash)", () => {
    const root = mkdtempSync(join(tmpdir(), "rg-ewt3-"));
    const f = join(root, "already.txt");
    writeFileSync(f, "keep");
    ensureWriteTargets([{ path: f, kind: "dir", createIfMissing: true }]); // mismatched kind, but exists → no-op
    expect(statSync(f).isFile()).toBe(true);
    expect(require("node:fs").readFileSync(f, "utf8")).toBe("keep");
  });
});
```

- [ ] **Step 3: Run**

Run: `bun test tests/unit/ensure-write-targets.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/utils/spawn.ts tests/unit/ensure-write-targets.test.ts
git commit -m "test(sandbox): ensureWriteTargets contract (create-by-kind, no fabricate, no-crash on existing)"
```

---

## Task 7: Real `bwrap` end-to-end isolation test (Linux, gated)

**Files:**
- Create: `tests/integration/bwrap-real.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// tests/integration/bwrap-real.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapAvailable } from "../../src/sandbox/availability.ts";
import type { SandboxProfile } from "../../src/sandbox/profile-builder.ts";
import { resolveForSandbox } from "../../src/sandbox/sbpl.ts";
import { spawnSafely } from "../../src/utils/spawn.ts";

// Top-level await so we can use describe.skipIf (cleaner than an in-`it` early return).
const RUNNABLE = platform() === "linux" && (await bwrapAvailable());

describe.skipIf(!RUNNABLE)("bwrap REAL filesystem isolation (Linux)", () => {
  it("denies a secret read, allows a workdir read, allows a workdir write, denies an out-of-area write", async () => {
    const home = mkdtempSync(join(tmpdir(), "rg-home-"));
    const secretDir = join(home, ".ssh");
    const work = mkdtempSync(join(tmpdir(), "rg-work-"));
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "id_rsa"), "TOPSECRET");
    writeFileSync(join(work, "ok.txt"), "PUBLIC");
    const outside = mkdtempSync(join(tmpdir(), "rg-outside-"));

    const profile: SandboxProfile = {
      sandboxRequested: true,
      fs: {
        readAllow: [resolveForSandbox(work, home)],
        readDeny: [resolveForSandbox(secretDir, home)],
        readDenyGlobs: [],
        writeAllow: [resolveForSandbox(work, home)],
        writeTargets: [{ path: resolveForSandbox(work, home), kind: "dir", createIfMissing: true }],
      },
      net: { allow: [] },
      budget: { walltimeMs: 30_000 },
    };
    const runDir = mkdtempSync(join(tmpdir(), "rg-bwrun-"));

    // 1. secret read denied (masked → empty dir, id_rsa gone)
    const deny = await spawnSafely({
      command: "/bin/cat",
      args: [join(secretDir, "id_rsa")],
      stdoutFile: join(runDir, "d.out"),
      stderrFile: join(runDir, "d.err"),
      timeoutMs: 30_000,
      sandbox: { profile, mode: "strict" },
    });
    expect(deny.exitCode).not.toBe(0);
    expect(readFileSync(join(runDir, "d.out"), "utf8")).not.toContain("TOPSECRET");

    // 2. workdir read allowed
    const allow = await spawnSafely({
      command: "/bin/cat",
      args: [join(work, "ok.txt")],
      stdoutFile: join(runDir, "a.out"),
      stderrFile: join(runDir, "a.err"),
      timeoutMs: 30_000,
      sandbox: { profile, mode: "strict" },
    });
    expect(allow.exitCode).toBe(0);
    expect(readFileSync(join(runDir, "a.out"), "utf8")).toContain("PUBLIC");

    // 3. workdir write allowed
    const wOk = await spawnSafely({
      command: "/bin/sh",
      args: ["-c", `echo hi > ${join(work, "written.txt")}`],
      stdoutFile: join(runDir, "w.out"),
      stderrFile: join(runDir, "w.err"),
      timeoutMs: 30_000,
      sandbox: { profile, mode: "strict" },
    });
    expect(wOk.exitCode).toBe(0);

    // 4. out-of-area write denied (read-only root)
    const wBad = await spawnSafely({
      command: "/bin/sh",
      args: ["-c", `echo hi > ${join(outside, "leak.txt")}`],
      stdoutFile: join(runDir, "wb.out"),
      stderrFile: join(runDir, "wb.err"),
      timeoutMs: 30_000,
      sandbox: { profile, mode: "strict" },
    });
    expect(wBad.exitCode).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun test tests/integration/bwrap-real.test.ts`
Expected (macOS author host): the whole `describe` is **skipped** (RUNNABLE=false) — no failure. On a Linux host with bwrap: PASS (all four assertions). **Gate the real proof on a Linux host/CI per the session brief.**

- [ ] **Step 3: Commit**

```bash
git add tests/integration/bwrap-real.test.ts
git commit -m "test(sandbox): real bwrap proves secret-read denied + workdir rw + out-of-area write denied (Linux-gated)"
```

---

## Task 8: Document the Linux limitations

**Files:**
- Modify: `CLAUDE.md` (the "Non-obvious gotchas" → Sandbox bullet)

- [ ] **Step 1: Update the sandbox bullet**

Append to the existing `**Sandbox:**` bullet (after the macOS description, before the LIMITATIONS list, and extend LIMITATIONS):

```markdown
  On **Linux**, `"strict"`/`"permissive"` enforce **filesystem isolation** via `bubblewrap`
  (`bwrap`, wrapped in `spawnSafely`): a mount namespace exposes `/` read-only, binds the reviewer's
  working area (findings + tmp + own creds) read-write, and masks secret **paths** (`~/.ssh`,
  `~/.aws`, cred files, foreign provider creds, …) — directories via `--tmpfs`, files via
  `--ro-bind /dev/null`. `--unshare-pid` isolates `/proc` (no host-process snooping). `strict`
  **fails closed** when `bwrap` is unavailable (e.g. Ubuntu 24.04 unprivileged-userns lockdown —
  `reviewgate doctor` prints the `sysctl` remediation); `permissive` runs unisolated with a WARN.
  LINUX-SPECIFIC LIMITATION: **glob-denies (`*.pem`, `*.key`, `.env*`) are NOT enforced on Linux**
  (the mount model can't pattern-match files) — divergence from macOS: a repo `.env`/`*.pem` is
  visible to the Linux reviewer, denied to the macOS one. Network is NOT isolated on either platform.
```

- [ ] **Step 2: Verify + commit**

Run: `bunx tsc --noEmit && bun run lint && bun test`
Expected: tsc clean, lint clean, full suite green (the bwrap real e2e skips on macOS).

```bash
git add CLAUDE.md
git commit -m "docs: document Linux bwrap enforcement + glob-deny limitation"
```

---

## Final verification (before DoD)

- [ ] `bunx tsc --noEmit` — clean
- [ ] `bun run lint` — clean
- [ ] `bun test` — full suite green (bwrap real e2e skips on macOS; macOS sandbox-exec e2e still passes)
- [ ] `bun run build` — compiled binary builds
- [ ] `bun run dev doctor` — `sandbox isolation` line present and correct for a strict/permissive config
- [ ] Manual (if a Linux host is available): run the real bwrap e2e and confirm the secret read is denied
- [ ] 2-reviewer DoD panel (Opus `code-reviewer` agent + Gemini via `agy`, stdout) PASS
- [ ] `rm -rf .review/` then commit; **ask before pushing**

---

## Spec coverage check

- D1 deny-mirror (`--ro-bind / /`) → Task 2. · D2 globs not-enforced → Task 2 (ignored) + Task 8 (doc). · D3 network open (no `--unshare-net`) → Task 2.
- C1 skip non-existent readDeny → Task 2. · C2 mask-last + bidirectional guard → Task 2. · C3 own-location binds + write-target contract → Tasks 1, 2, 4, 6. · C5 file vs dir masking → Task 2. · W4 `--unshare-pid` → Tasks 2, 3. · Probe consistency → Tasks 3, 5.
- Availability/`sandboxRuntimeAvailable` → Task 3. · spawn Linux branch → Task 4. · doctor → Task 5. · real e2e (gated) → Task 7. · docs → Task 8.
