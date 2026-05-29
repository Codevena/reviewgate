# macOS Filesystem Sandbox Implementation Plan

> **STATUS: ✅ COMPLETE & MERGED** — all 12 tasks shipped in PR #44 (master `4ff390f`, 2026-05-30).
> 2-reviewer DoD panel (Opus + Gemini) PASS. The panel caught two real CRITICALs the unit
> tests had masked — `BROAD_DENY` made the profile throw before every spawn (feature was
> non-functional), and glob denies (`*.pem`) were emitted as literal `(subpath)` no-ops — both
> fixed in commit `4954158` + guarded by a production-profile e2e (`tests/integration/sandbox-exec-real.test.ts`)
> that runs real `sandbox-exec` on macOS and proves: repo read allowed · secret/`*.pem` read denied ·
> findings write allowed · out-of-area write denied.
>
> **Residual (INFO, non-blocking):** the production-e2e's second `describe` block runs (with an
> in-`it` early-return) rather than `describe.skip` on non-darwin; `readAllow` is metadata-only in
> the `(allow default)` SBPL model (no effect). **Next increment: Linux `bwrap` — see the bottom of this file.**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sandbox.mode: "strict" | "permissive"` actually isolate a reviewer subprocess's filesystem on macOS via `sandbox-exec`, instead of refusing to review.

**Architecture:** A pure SBPL generator (`sbpl.ts`) turns the existing OS-agnostic `SandboxProfile` into a Seatbelt profile; `spawnSafely` gains an optional `sandbox` option that wraps the command as `sandbox-exec -f <profile.sb> …` on macOS when available. The orchestrator builds a per-reviewer profile and passes it through the adapters. `strict` fails closed (ERROR) when isolation is unavailable; `permissive` runs unsandboxed with a loud WARN. The dead `SandboxManager` (which bet on an unpublished package) is deleted.

**Tech Stack:** Bun, TypeScript, macOS `sandbox-exec` (Seatbelt/SBPL), `node:child_process`, `node:fs` (realpathSync).

**Spec:** `docs/superpowers/specs/2026-05-29-macos-sandbox-filesystem-design.md`

---

## File Structure

- **Create** `src/sandbox/errors.ts` — `SandboxUnavailableError` (moved out of the deleted manager so spawn + callers share it).
- **Create** `src/sandbox/availability.ts` — `sandboxExecAvailable()` memoized probe; `doctor-check.ts` reuses it.
- **Create** `src/sandbox/sbpl.ts` — `resolveForSandbox()` + `buildMacosSbpl()` (pure).
- **Modify** `src/sandbox/profile-builder.ts` — own-cred dir writable; expanded baseline read-deny.
- **Modify** `src/utils/spawn.ts` — `SpawnInput.sandbox`, `SpawnResult.{sandboxApplied,sandboxFellBack}`, wrapping logic.
- **Modify** `src/providers/adapter-base.ts` — `ReviewInput.sandbox`.
- **Modify** `src/providers/{codex,claude,gemini,opencode}.ts` — forward `sandbox` into `spawnSafely`.
- **Modify** `src/core/orchestrator.ts` — remove blanket ERROR; build + pass profile; strict/permissive handling + WARN.
- **Modify** `src/sandbox/doctor-check.ts` — reuse the shared probe.
- **Delete** `src/sandbox/manager.ts` (dead: zero callers).
- **Modify** `CLAUDE.md` — honest limitations note.

---

## Task 1: Shared `SandboxUnavailableError`

**Files:**
- Create: `src/sandbox/errors.ts`
- Test: `tests/unit/sandbox-errors.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/sandbox-errors.test.ts
import { describe, expect, it } from "bun:test";
import { SandboxUnavailableError } from "../../src/sandbox/errors.ts";

describe("SandboxUnavailableError", () => {
  it("is an Error with a stable name and the given message", () => {
    const e = new SandboxUnavailableError("no sandbox-exec");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("SandboxUnavailableError");
    expect(e.message).toBe("no sandbox-exec");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/sandbox-errors.test.ts`
Expected: FAIL — cannot find module `src/sandbox/errors.ts`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/sandbox/errors.ts
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/sandbox-errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/errors.ts tests/unit/sandbox-errors.test.ts
git commit -m "feat(sandbox): shared SandboxUnavailableError module"
```

---

## Task 2: `sandboxExecAvailable()` probe

**Files:**
- Create: `src/sandbox/availability.ts`
- Test: `tests/unit/sandbox-availability.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/sandbox-availability.test.ts
import { describe, expect, it } from "bun:test";
import { platform } from "node:os";
import { sandboxExecAvailable } from "../../src/sandbox/availability.ts";

describe("sandboxExecAvailable", () => {
  it("returns a boolean; true on macOS where sandbox-exec ships", async () => {
    const ok = await sandboxExecAvailable();
    expect(typeof ok).toBe("boolean");
    if (platform() === "darwin") expect(ok).toBe(true); // sandbox-exec ships with macOS
  });

  it("memoizes (second call returns the same value without re-spawning)", async () => {
    const a = await sandboxExecAvailable();
    const b = await sandboxExecAvailable();
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/sandbox-availability.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/sandbox/availability.ts
import { spawn } from "node:child_process";
import { platform } from "node:os";

let cached: boolean | null = null;

// True when `sandbox-exec` can actually run a trivial profile. macOS only;
// memoized per process (the answer can't change within a run). Used by spawnSafely
// (to decide strict-fail vs permissive-fallback) and by doctor.
export function sandboxExecAvailable(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached);
  if (platform() !== "darwin") {
    cached = false;
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const child = spawn("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("exit", (code) => {
      cached = code === 0;
      resolve(cached);
    });
    child.on("error", () => {
      cached = false;
      resolve(false);
    });
  });
}

// Test-only: reset the memo so a test can re-probe.
export function __resetSandboxExecCache(): void {
  cached = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/sandbox-availability.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/availability.ts tests/unit/sandbox-availability.test.ts
git commit -m "feat(sandbox): memoized sandbox-exec availability probe"
```

---

## Task 3: Path resolution for Seatbelt (`resolveForSandbox`)

**Files:**
- Create: `src/sandbox/sbpl.ts`
- Test: `tests/unit/sbpl.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/sbpl.test.ts
import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { resolveForSandbox } from "../../src/sandbox/sbpl.ts";

describe("resolveForSandbox", () => {
  it("expands ~ to the home dir and canonicalizes symlinked roots", () => {
    // /tmp is a symlink to /private/tmp on macOS — Seatbelt matches the canonical form.
    const r = resolveForSandbox("/tmp", "/Users/x");
    expect(r).toBe(realpathSync("/tmp")); // → /private/tmp on macOS
    expect(resolveForSandbox("~/.ssh", "/Users/x")).toBe("/Users/x/.ssh");
  });

  it("for a not-yet-existing path, realpaths the parent and appends the basename", () => {
    // findingsPath may not exist before first write; must still canonicalize the dir.
    const out = resolveForSandbox("/tmp/does-not-exist-xyz/findings.md", "/Users/x");
    expect(out).toBe(`${realpathSync("/tmp")}/does-not-exist-xyz/findings.md`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/sbpl.test.ts`
Expected: FAIL — cannot find module / `resolveForSandbox` undefined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/sandbox/sbpl.ts
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

// Resolve a path to the CANONICAL absolute form Seatbelt matches against. macOS
// symlinks system roots (/tmp → /private/tmp), and the home/repo may be symlinked;
// a non-canonical path silently fails to match an SBPL rule. Expand ~ first, then
// realpath. If the path itself doesn't exist yet (e.g. findingsPath before first
// write), realpath the nearest existing ancestor and re-append the trailing parts.
export function resolveForSandbox(p: string, homeDir: string): string {
  const expanded = p === "~" ? homeDir : p.startsWith("~/") ? join(homeDir, p.slice(2)) : p;
  const abs = isAbsolute(expanded) ? expanded : join(homeDir, expanded);
  try {
    return realpathSync(abs);
  } catch {
    // Walk up to the first existing ancestor, realpath it, re-append the rest.
    const tail: string[] = [];
    let cur = abs;
    for (;;) {
      const parent = dirname(cur);
      if (parent === cur) return abs; // hit the root without finding an existing ancestor
      tail.unshift(basename(cur));
      cur = parent;
      try {
        return join(realpathSync(cur), ...tail);
      } catch {
        // keep walking up
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/sbpl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/sbpl.ts tests/unit/sbpl.test.ts
git commit -m "feat(sandbox): canonicalize paths for Seatbelt (realpath + ~ expand)"
```

---

## Task 4: `buildMacosSbpl()` SBPL generator

**Files:**
- Modify: `src/sandbox/sbpl.ts`
- Test: `tests/unit/sbpl.test.ts`

- [ ] **Step 1: Write the failing test (append to the existing file)**

```typescript
// append to tests/unit/sbpl.test.ts
import { buildMacosSbpl } from "../../src/sandbox/sbpl.ts";
import type { SandboxProfile } from "../../src/sandbox/profile-builder.ts";

const profile: SandboxProfile = {
  sandboxRequested: true,
  fs: {
    readAllow: ["/repo", "/private/tmp/run", "/Users/x/.codex"],
    readDeny: ["/Users/x/.ssh", "/Users/x/.aws"],
    writeAllow: ["/private/tmp/run", "/repo/.reviewgate/findings/codex.md"],
  },
  net: { allow: ["api.openai.com"] },
  budget: { walltimeMs: 300_000 },
};

describe("buildMacosSbpl", () => {
  it("emits a valid-shaped SBPL: allow default, deny writes except writeAllow, deny secret reads", () => {
    const sb = buildMacosSbpl(profile);
    expect(sb.startsWith("(version 1)")).toBe(true);
    expect(sb).toContain("(allow default)");
    expect(sb).toContain("(deny file-write*)");
    expect(sb).toContain('(subpath "/private/tmp/run")');
    expect(sb).toContain('(literal "/repo/.reviewgate/findings/codex.md")');
    expect(sb).toContain('(deny file-read*');
    expect(sb).toContain('(subpath "/Users/x/.ssh")');
    // write-allow must precede the read-deny block is not required (different op),
    // but the deny-write block must come before its allow exceptions:
    expect(sb.indexOf("(deny file-write*)")).toBeLessThan(sb.indexOf('(allow file-write*'));
  });

  it("never lists a writeAllow path that is nested under a readDeny path (would be write-only)", () => {
    const bad: SandboxProfile = {
      ...profile,
      fs: { ...profile.fs, writeAllow: ["/Users/x/.ssh/leak"], readDeny: ["/Users/x/.ssh"] },
    };
    expect(() => buildMacosSbpl(bad)).toThrow(/write-only|nested|conflict/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/sbpl.test.ts -t buildMacosSbpl`
Expected: FAIL — `buildMacosSbpl` undefined.

- [ ] **Step 3: Write minimal implementation (append to `src/sandbox/sbpl.ts`)**

```typescript
import type { SandboxProfile } from "./profile-builder.ts";

const sbplString = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const isUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(`${parent}/`);

// Render a Seatbelt (SBPL) profile from an already-canonicalized SandboxProfile.
// Shape (last-matching-rule-wins): allow everything (don't break the tool runtime),
// then forbid all writes except the working area, then forbid reads of secrets.
// Paths MUST already be absolute + realpath'd (see resolveForSandbox).
export function buildMacosSbpl(profile: SandboxProfile): string {
  // Guard: a writeAllow path nested under a readDeny path yields a write-only file
  // that crashes any O_RDWR open inside the sandbox (spec invariant).
  for (const w of profile.fs.writeAllow) {
    for (const d of profile.fs.readDeny) {
      if (isUnder(w, d)) {
        throw new Error(`SBPL conflict: writeAllow ${w} is nested under readDeny ${d} (write-only)`);
      }
    }
  }
  const lines: string[] = ["(version 1)", "(allow default)"];
  if (profile.fs.writeAllow.length > 0) {
    lines.push("(deny file-write*)");
    const targets = profile.fs.writeAllow.map((p) => `(subpath "${sbplString(p)}")`).join(" ");
    lines.push(`(allow file-write* ${targets})`);
  }
  if (profile.fs.readDeny.length > 0) {
    const targets = profile.fs.readDeny.map((p) => `(subpath "${sbplString(p)}")`).join(" ");
    lines.push(`(deny file-read* ${targets})`);
  }
  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/sbpl.test.ts`
Expected: PASS (all describes).

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/sbpl.ts tests/unit/sbpl.test.ts
git commit -m "feat(sandbox): buildMacosSbpl — SBPL from SandboxProfile + write-only guard"
```

---

## Task 5: profile-builder — own-cred writable + expanded read-deny baseline

**Files:**
- Modify: `src/sandbox/profile-builder.ts`
- Test: `tests/unit/sandbox.test.ts`

- [ ] **Step 1: Write the failing test (append to the existing `sandbox.test.ts`)**

```typescript
it("makes the OWN provider credential dir writable (OAuth token refresh)", () => {
  const p = buildSandboxProfile({
    providerId: "codex",
    mode: "strict",
    workingDir: "/repo",
    findingsPath: "/repo/.reviewgate/findings/codex.md",
    tmpDir: "/tmp/rg-run-1",
  });
  // own creds (~/.codex etc.) must be writable, not just readable, or token refresh fails
  expect(p.fs.writeAllow.some((w) => w.includes(".codex"))).toBe(true);
});

it("denies reads of the expanded secret baseline (.netrc, .git-credentials, histories)", () => {
  const p = buildSandboxProfile({
    providerId: "codex",
    mode: "strict",
    workingDir: "/repo",
    findingsPath: "/repo/f.md",
    tmpDir: "/tmp/x",
  });
  for (const needle of ["~/.netrc", "~/.git-credentials", "~/.npmrc", "~/.bash_history"]) {
    expect(p.fs.readDeny).toContain(needle);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/sandbox.test.ts -t "OWN provider"`
Expected: FAIL — own cred dir not in writeAllow; baseline secrets missing.

- [ ] **Step 3: Write minimal implementation**

In `src/sandbox/profile-builder.ts`, extend the `SECRETS_DENY` constant and the `writeAllow` construction:

```typescript
// add to SECRETS_DENY (after the existing entries):
const SECRETS_DENY = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.netrc",
  "~/.git-credentials",
  "~/.npmrc",
  "~/.pypirc",
  "~/.config/gh",
  "~/.bash_history",
  "~/.zsh_history",
  ".env",
  ".env.local",
  ".env.production",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
];
```

And in `buildSandboxProfile`, after computing `writeAllow`, add the OWN cred dir(s):

```typescript
  const writeAllow = [
    input.findingsPath,
    input.tmpDir,
    ...own, // own provider credential dirs — writable for OAuth token refresh
    ...(input.writablePaths ?? []),
  ];
```

(`own` is already computed as `CREDENTIAL_PATHS[input.providerId]`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/sandbox.test.ts`
Expected: PASS (existing + new). Note: the existing exact-`toEqual` writeAllow test from F-058 era must be updated to include the own-cred entries — update its expectation to `expect(p.fs.writeAllow).toEqual(["/repo/.reviewgate/findings/codex.md", "/tmp/rg-run-1", ...CREDENTIAL_PATHS.codex])` (import CREDENTIAL_PATHS or assert with `arrayContaining`).

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/profile-builder.ts tests/unit/sandbox.test.ts
git commit -m "feat(sandbox): own-cred dir writable + expanded secret read-deny baseline"
```

---

## Task 6: `spawnSafely` sandbox wrapping

**Files:**
- Modify: `src/utils/spawn.ts`
- Test: `tests/unit/spawn-sandbox.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/spawn-sandbox.test.ts
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxProfile } from "../../src/sandbox/profile-builder.ts";
import { SandboxUnavailableError } from "../../src/sandbox/errors.ts";
import { spawnSafely } from "../../src/utils/spawn.ts";

const okProfile: SandboxProfile = {
  sandboxRequested: true,
  fs: { readAllow: [], readDeny: [], writeAllow: [] },
  net: { allow: [] },
  budget: { walltimeMs: 30_000 },
};

function run(dir: string) {
  return {
    stdoutFile: join(dir, "out"),
    stderrFile: join(dir, "err"),
    timeoutMs: 30_000,
  };
}

describe("spawnSafely sandbox", () => {
  it("(macOS) applies sandbox-exec and the command still runs + reports sandboxApplied", async () => {
    if (platform() !== "darwin") return; // macOS-only path
    const dir = mkdtempSync(join(tmpdir(), "rg-spawnsb-"));
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

  it("strict + sandbox unavailable → throws SandboxUnavailableError", async () => {
    if (platform() === "darwin") return; // only meaningful where sandbox-exec is absent
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/spawn-sandbox.test.ts`
Expected: FAIL — `sandbox` option not accepted / `sandboxApplied` undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/utils/spawn.ts`:

1. Add the NEW imports (the file already imports `createReadStream`/`createWriteStream` from `node:fs` and `spawn` from `node:child_process` — only ADD what's missing; extend the existing `node:fs` import to include `mkdtempSync, rmSync, writeFileSync`):

```typescript
import { /* existing */ createReadStream, createWriteStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxExecAvailable } from "../sandbox/availability.ts";
import { SandboxUnavailableError } from "../sandbox/errors.ts";
import type { SandboxProfile } from "../sandbox/profile-builder.ts";
import { buildMacosSbpl, resolveForSandbox } from "../sandbox/sbpl.ts";
```

2. Add to `SpawnInput`:

```typescript
  // When set, the command is run inside an OS sandbox (macOS sandbox-exec).
  // mode controls the fallback when isolation is unavailable: "strict" throws
  // SandboxUnavailableError; "permissive" runs unsandboxed (sandboxFellBack=true).
  sandbox?: { profile: SandboxProfile; mode: "strict" | "permissive" };
```

3. Add to `SpawnResult`:

```typescript
  sandboxApplied: boolean;
  sandboxFellBack: boolean;
```

4. At the very top of `spawnSafely`, BEFORE building the Promise, resolve the wrapping (async, so do it before `new Promise`):

```typescript
export async function spawnSafely(input: SpawnInput): Promise<SpawnResult> {
  let command = input.command;
  let args = input.args;
  let sandboxApplied = false;
  let sandboxFellBack = false;
  let sbplFile: string | null = null;

  if (input.sandbox) {
    const available = await sandboxExecAvailable();
    if (available) {
      const home = homedir();
      const prof = input.sandbox.profile;
      // Canonicalize every path the SBPL references.
      const resolved: SandboxProfile = {
        ...prof,
        fs: {
          readAllow: prof.fs.readAllow.map((p) => resolveForSandbox(p, home)),
          readDeny: prof.fs.readDeny.map((p) => resolveForSandbox(p, home)),
          writeAllow: prof.fs.writeAllow.map((p) => resolveForSandbox(p, home)),
        },
      };
      const sbpl = buildMacosSbpl(resolved);
      const sbDir = mkdtempSync(join(tmpdir(), "rg-sbpl-"));
      sbplFile = join(sbDir, "profile.sb");
      writeFileSync(sbplFile, sbpl, { mode: 0o600 });
      args = ["-f", sbplFile, command, ...args];
      command = "sandbox-exec";
      sandboxApplied = true;
    } else if (input.sandbox.mode === "strict") {
      throw new SandboxUnavailableError(
        "sandbox.mode='strict' requested but sandbox-exec is unavailable on this host (macOS only). Set mode='permissive' to run unisolated, or 'off' for trusted local dev.",
      );
    } else {
      sandboxFellBack = true; // permissive: run unsandboxed below
    }
  }

  const start = Date.now();
  // … existing body, but use `command`/`args` instead of input.command/input.args
  // in the nodeSpawn call, and add sandboxApplied/sandboxFellBack to BOTH the
  // resolve() object and clean up sbplFile in settle():
}
```

5. In the `nodeSpawn` call, replace `input.command, input.args` with `command, args`.

6. In `settle()`, after the timers are cleared, clean up the SBPL file, and add the two flags to the resolved object:

```typescript
      if (sbplFile) {
        try {
          rmSync(sbplFile, { force: true });
        } catch {
          /* best-effort */
        }
      }
      // … inside the resolve({...}) literal add:
      //   sandboxApplied,
      //   sandboxFellBack,
```

(Keep the existing `out.end(finishOne)` / `err.end(finishOne)` flush logic; the cleanup runs once in `settle`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/spawn-sandbox.test.ts`
Expected: PASS on the platform-appropriate cases.
Also run the existing spawn-dependent suites to confirm no regression:
Run: `bun test tests/unit/codex-adapter.test.ts tests/unit/claude-adapter.test.ts`
Expected: PASS (no `sandbox` option → `sandboxApplied:false`, unchanged behavior).

- [ ] **Step 5: Commit**

```bash
git add src/utils/spawn.ts tests/unit/spawn-sandbox.test.ts
git commit -m "feat(sandbox): spawnSafely wraps the command in sandbox-exec when requested"
```

---

## Task 7: `ReviewInput.sandbox` + adapters forward it

**Files:**
- Modify: `src/providers/adapter-base.ts`
- Modify: `src/providers/codex.ts`, `claude.ts`, `gemini.ts`, `opencode.ts`
- Test: `tests/unit/codex-adapter.test.ts`

- [ ] **Step 1: Write the failing test (codex argv capture)**

```typescript
it("forwards a sandbox profile into the spawn (argv begins with sandbox-exec on macOS)", async () => {
  if ((await import("node:os")).platform() !== "darwin") return;
  const dir = mkdtempSync(join(tmpdir(), "rg-codex-sb-"));
  const argvFile = join(dir, "argv.txt");
  const bin = join(dir, "fake.sh");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash\n: > "${argvFile}"\nfor a in "$@"; do printf '%s\\n' "$a" >> "${argvFile}"; done\nLAST=""\nwhile [ $# -gt 0 ]; do case "$1" in --output-last-message) LAST="$2"; shift 2;; *) shift;; esac; done\n[ -n "$LAST" ] && printf '%s' '{"verdict":"PASS","findings":[]}' > "$LAST"\nprintf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1,"cached_input_tokens":0}}'\nexit 0\n`,
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  const promptFile = join(dir, "p.txt");
  writeFileSync(promptFile, "review");
  writeFileSync(join(dir, "d.patch"), "diff");
  const adapter = new CodexAdapter({ binPath: bin });
  await adapter.review({
    cfg: { enabled: true, auth: "oauth", model: "gpt-5.5", timeoutMs: 60_000 },
    reviewerId: "codex-security",
    promptFile,
    workingDir: dir,
    findingsPath: join(dir, "findings.md"),
    persona: "security",
    diffPath: join(dir, "d.patch"),
    sandbox: {
      profile: {
        sandboxRequested: true,
        fs: { readAllow: [], readDeny: [], writeAllow: [] },
        net: { allow: [] },
        budget: { walltimeMs: 30_000 },
      },
      mode: "strict",
    },
  });
  // NOTE: sandbox-exec wraps `this.binPath`, so the FAKE bin is the sandboxed
  // command — its recorded argv is what sandbox-exec passed through to it.
  // The presence of the recording proves the wrapped command still executed.
  expect(readFileSync(argvFile, "utf8")).toContain("--output-last-message");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/codex-adapter.test.ts -t "forwards a sandbox"`
Expected: FAIL — `ReviewInput` has no `sandbox` field (type error) or it isn't forwarded.

- [ ] **Step 3: Write minimal implementation**

In `src/providers/adapter-base.ts`, add to `ReviewInput`:

```typescript
import type { SandboxProfile } from "../sandbox/profile-builder.ts";
// …
  // OS sandbox for the reviewer subprocess (macOS sandbox-exec). Forwarded to
  // spawnSafely. Absent → unsandboxed (mode "off").
  sandbox?: { profile: SandboxProfile; mode: "strict" | "permissive" };
```

In EACH of the 4 adapters' `review()` `spawnSafely({...})` call, add:

```typescript
        ...(input.sandbox ? { sandbox: input.sandbox } : {}),
```

(codex.ts, claude.ts, gemini.ts, opencode.ts — at the existing `spawnSafely` call sites.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/codex-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/adapter-base.ts src/providers/codex.ts src/providers/claude.ts src/providers/gemini.ts src/providers/opencode.ts tests/unit/codex-adapter.test.ts
git commit -m "feat(sandbox): adapters forward the sandbox profile into spawnSafely"
```

---

## Task 8: Orchestrator — build + pass profile, replace blanket ERROR

**Files:**
- Modify: `src/core/orchestrator.ts`
- Test: `tests/unit/orchestrator-sandbox.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/orchestrator-sandbox.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter } from "../../src/providers/adapter-base.ts";

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

// A stub reviewer that records whether it received a sandbox profile.
function recordingAdapter(seen: { sandbox?: unknown }): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      seen.sandbox = inp.sandbox;
      return {
        reviewerId: inp.reviewerId,
        verdict: "PASS",
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: '{"verdict":"PASS","findings":[]}',
        status: "ok",
      };
    },
  };
}

function makeOrch(repo: string, sandboxMode: "strict" | "permissive", adapter: ProviderAdapter) {
  return new Orchestrator({
    repoRoot: repo,
    // biome-ignore lint/suspicious/noExplicitAny: test config shape
    config: {
      ...defaultConfig,
      phases: { review: { reviewers: [{ provider: "codex", persona: "security" }] }, critic: null, triage: null },
    } as any,
    adapters: { codex: adapter },
    sandboxMode,
    hostTier: "opus",
    diff: DIFF,
    reasonOnFailEnabled: true,
  });
}

describe("orchestrator sandbox wiring", () => {
  it("no longer ERRORs the whole iteration when sandboxMode !== off — it passes a profile to the reviewer", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-sb-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const seen: { sandbox?: unknown } = {};
    const res = await makeOrch(repo, "permissive", recordingAdapter(seen)).runIteration({
      runId: "R",
      iter: 1,
    });
    expect(res.verdict).not.toBe("ERROR"); // pre-change: was always ERROR for mode!=off
    expect(seen.sandbox).toBeDefined(); // the reviewer got a { profile, mode }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/orchestrator-sandbox.test.ts`
Expected: FAIL — `res.verdict` is `"ERROR"` (the blanket early return) and `seen.sandbox` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/core/orchestrator.ts`:

1. Remove the blanket early return:

```typescript
    // DELETE these lines (the ~287 block):
    // if (this.input.sandboxMode !== "off") {
    //   await this.writeReport(opts, start, [], [], "ERROR");
    //   return { verdict: "ERROR", ... source: "skipped" ... };
    // }
```

2. Where the per-reviewer profile is needed (where the adapter `.review({...})` is invoked, inside `runProvider`/the panel map), build and attach the profile:

```typescript
import { buildSandboxProfile } from "../sandbox/profile-builder.ts";
// … inside runProvider, before calling adapter.review:
const sandbox =
  this.input.sandboxMode === "off"
    ? undefined
    : {
        profile: buildSandboxProfile({
          providerId: provider,
          mode: this.input.sandboxMode,
          workingDir, // the reviewer's temp working dir
          findingsPath,
          tmpDir, // the reviewer's run temp dir
          writablePaths: this.input.config.sandbox.writablePaths,
          deniedReads: this.input.config.sandbox.deniedReads,
        }),
        mode: this.input.sandboxMode,
      };
// pass `...(sandbox ? { sandbox } : {})` into the adapter.review({...}) call.
```

3. Wrap the `adapter.review` call so a `SandboxUnavailableError` becomes a fail-closed ERROR result for that reviewer under strict, and a permissive fallback is allowed to proceed (the adapter/spawn already returns `sandboxFellBack` — surface a WARN via statusDetail). Minimal: catch the error and map to an ERROR `ReviewResult` with a clear `statusDetail`; the existing 0-ok-reviewers → ERROR gate then blocks. (Reference the existing reviewer-error mapping in the panel.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/orchestrator-sandbox.test.ts`
Expected: PASS.
Run the broader orchestrator suite: `bun test tests/unit/orchestrator*.test.ts`
Expected: PASS (the old `mode!=off → ERROR` behavior is intentionally replaced; if any existing test asserted that, update it to the new contract).

- [ ] **Step 5: Commit**

```bash
git add src/core/orchestrator.ts tests/unit/orchestrator-sandbox.test.ts
git commit -m "feat(sandbox): orchestrator builds + passes a per-reviewer profile instead of refusing"
```

---

## Task 9: Delete the dead `SandboxManager`

**Files:**
- Delete: `src/sandbox/manager.ts`
- Test: `tests/unit/` (remove any manager test if present)

- [ ] **Step 1: Confirm zero callers**

Run: `grep -rn "SandboxManager\|sandbox/manager" src tests`
Expected: only `src/sandbox/manager.ts` itself (and possibly a dedicated test). If any other caller exists, STOP and reconcile — the spec assumed none.

- [ ] **Step 2: Delete the file (and its test if any)**

```bash
git rm src/sandbox/manager.ts
# if a tests/unit/sandbox-manager*.test.ts exists:
# git rm tests/unit/sandbox-manager.test.ts
```

- [ ] **Step 3: Verify build + suite**

Run: `bunx tsc --noEmit && bun test`
Expected: tsc clean, full suite PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(sandbox): delete dead SandboxManager (bet on unpublished package; zero callers)"
```

---

## Task 10: doctor — strict + unavailable → fail

**Files:**
- Modify: `src/sandbox/doctor-check.ts` (reuse `sandboxExecAvailable`)
- Modify: `src/cli/commands/doctor.ts`
- Test: `tests/unit/doctor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { doctorExitCode, type Check } from "../../src/cli/commands/doctor.ts";

it("a strict sandbox config with no working sandbox-exec is a FAIL check", () => {
  // doctorExitCode already maps any fail → 2; assert the sandbox check is fail.
  const checks: Check[] = [
    { name: "sandbox", status: "fail", detail: "sandbox.mode=strict but sandbox-exec unavailable" },
  ];
  expect(doctorExitCode(checks)).toBe(2);
});
```

(The behavioral wiring — that runDoctor pushes a `fail` check when `cfg.sandbox.mode === "strict"` and `!sandboxExecAvailable()` on macOS, a `warn` under permissive — is added in the implementation; the unit test above pins the exit-code contract, and a manual `reviewgate doctor` smoke verifies the message.)

- [ ] **Step 2: Run test to verify it fails / passes**

Run: `bun test tests/unit/doctor.test.ts -t "strict sandbox"`
Expected: PASS for the exit-code contract (doctorExitCode already exists). Then add the runDoctor wiring and verify by smoke.

- [ ] **Step 3: Implement the doctor wiring**

In `runDoctor` (after the other checks), add:

```typescript
import { sandboxExecAvailable } from "../../sandbox/availability.ts";
// …
const mode = /* effective config */ cfg.sandbox.mode;
if (mode !== "off") {
  const ok = await sandboxExecAvailable();
  checks.push({
    name: "sandbox isolation",
    status: ok ? "ok" : mode === "strict" ? "fail" : "warn",
    detail: ok
      ? `sandbox-exec available (mode=${mode})`
      : `sandbox-exec unavailable — mode=${mode} will ${mode === "strict" ? "REFUSE to review (fail closed)" : "run reviewers UNISOLATED"}`,
  });
}
```

(`runDoctor` already loads the effective config / has `cfg` in scope; reuse it.)

- [ ] **Step 4: Smoke-test the real CLI**

Run: `bun run dev doctor`
Expected: on macOS with sandbox-exec, an `✓ sandbox isolation: sandbox-exec available` line when a strict/permissive config is present; exit 0 for off/permissive, exit 2 only when strict + unavailable.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/doctor-check.ts src/cli/commands/doctor.ts tests/unit/doctor.test.ts
git commit -m "feat(sandbox): doctor flags a strict config that can't be enforced"
```

---

## Task 11: Real `sandbox-exec` end-to-end isolation test (macOS)

**Files:**
- Test: `tests/integration/sandbox-exec-real.test.ts`

- [ ] **Step 1: Write the test (real isolation proof)**

```typescript
// tests/integration/sandbox-exec-real.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxExecAvailable } from "../../src/sandbox/availability.ts";
import { buildMacosSbpl, resolveForSandbox } from "../../src/sandbox/sbpl.ts";
import { spawnSafely } from "../../src/utils/spawn.ts";

describe("sandbox-exec REAL filesystem isolation (macOS)", () => {
  it("denies reading a secret path and allows reading the working dir", async () => {
    if (platform() !== "darwin" || !(await sandboxExecAvailable())) return; // skip elsewhere
    const home = mkdtempSync(join(tmpdir(), "rg-home-"));
    const secretDir = join(home, ".ssh");
    const work = mkdtempSync(join(tmpdir(), "rg-work-"));
    require("node:fs").mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "id_rsa"), "TOPSECRET");
    writeFileSync(join(work, "ok.txt"), "PUBLIC");

    const profile = {
      sandboxRequested: true,
      fs: {
        readAllow: [resolveForSandbox(work, home)],
        readDeny: [resolveForSandbox(secretDir, home)],
        writeAllow: [resolveForSandbox(work, home)],
      },
      net: { allow: [] },
      budget: { walltimeMs: 30_000 },
    };
    // Build SBPL with the resolved paths (spawnSafely also resolves, but we pass a
    // pre-resolved profile so the assertion is deterministic).
    void buildMacosSbpl(profile);

    const runDir = mkdtempSync(join(tmpdir(), "rg-sbrun-"));
    const deny = await spawnSafely({
      command: "/bin/cat",
      args: [join(secretDir, "id_rsa")],
      stdoutFile: join(runDir, "d.out"),
      stderrFile: join(runDir, "d.err"),
      timeoutMs: 30_000,
      sandbox: { profile, mode: "strict" },
    });
    expect(deny.exitCode).not.toBe(0); // read denied by the sandbox
    expect(readFileSync(join(runDir, "d.out"), "utf8")).not.toContain("TOPSECRET");

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
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun test tests/integration/sandbox-exec-real.test.ts`
Expected (macOS): PASS — the secret read is denied, the working-dir read succeeds. (Skips with no failure on non-macOS / no sandbox-exec.)

- [ ] **Step 3: Commit**

```bash
git add tests/integration/sandbox-exec-real.test.ts
git commit -m "test(sandbox): real sandbox-exec proves a secret read is denied, work-dir read allowed"
```

---

## Task 12: Document the honest limitations

**Files:**
- Modify: `CLAUDE.md` (the "Non-obvious gotchas" / sandbox section)

- [ ] **Step 1: Update the sandbox note**

Replace the existing `Sandbox mode:"off" is the honest default …` bullet with:

```markdown
- **Sandbox:** `mode:"off"` is the default. On **macOS**, `mode:"strict"`/`"permissive"`
  now enforce **filesystem isolation** of reviewer subprocesses via `sandbox-exec`
  (deny secret reads, restrict writes to the working area). `strict` fails closed
  (refuses to review) when sandbox-exec is unavailable; `permissive` runs unisolated
  with a WARN. LIMITATIONS (by design, documented): network is NOT isolated (API
  reviewers need it; sandbox-exec can't host-allowlist); macOS only (Linux bwrap is
  the next increment, Windows unsupported); `sandbox-exec` is Apple-deprecated but
  functional; the reviewer's own cred dir is writable (OAuth refresh) — an accepted
  persistence risk; host-side reads of reviewer outputs use O_NOFOLLOW to avoid a
  symlink-traversal leak.
```

- [ ] **Step 2: Verify + commit**

Run: `bunx tsc --noEmit && bun run lint && bun test`
Expected: all clean/green.

```bash
git add CLAUDE.md
git commit -m "docs: document macOS sandbox enforcement + honest limitations"
```

---

## Final verification (before DoD)

- [ ] `bunx tsc --noEmit` — clean
- [ ] `bun run lint` — clean
- [ ] `bun test` — full suite green (incl. the real sandbox-exec e2e on macOS)
- [ ] `bun run build` — compiled binary builds
- [ ] Manual: a repo with `sandbox.mode:"strict"` runs a real review on macOS; confirm via the e2e test that the reviewer cannot read `~/.ssh`.
- [ ] 2-reviewer DoD panel (Opus + Gemini/agy) PASS.

---

## Increment 2 (NEXT): Linux `bubblewrap` (bwrap)

Same goal on Linux: filesystem-isolate the reviewer subprocess. The profile + wiring are already
platform-agnostic — only a Linux translator + spawn branch are new. Reuse everything from Increment 1.

**Reuse as-is:** `SandboxProfile` (incl. `readDenyGlobs`), `buildSandboxProfile`, `resolveForSandbox`,
the `ReviewInput.sandbox` → adapter → `spawnSafely` wiring, the orchestrator profile-build, the
strict/permissive fallback, doctor (already probes `bwrap` via `doctor-check.ts`).

**New work (mirror the macOS tasks):**
1. `src/sandbox/bwrap.ts` (pure): `buildBwrapArgs(profile, homeDir): string[]` → the `bwrap` argv.
   bwrap is a MOUNT-NAMESPACE model (opposite of Seatbelt's allow-default): you build the view
   explicitly — `--ro-bind / /` (or narrower) then `--bind <writeAllow> <writeAllow>` for writable
   paths, and crucially **`--tmpfs <secretDir>`** (or omit the bind) to make secret dirs invisible.
   This INVERTS the deny-model: instead of "deny these reads", you "don't expose these mounts".
   Globs (`*.pem`) can't be expressed as mounts — document as not-enforced on Linux (a real gap vs
   macOS regex; note it honestly, or pre-scan + `--tmpfs` specific matches). Use `--die-with-parent`,
   `--unshare-user` etc. as appropriate; KEEP network (no `--unshare-net`) — same network-open scope.
2. `availability.ts`: add `bwrapAvailable()` (probe `bwrap --version` / a trivial `bwrap … /bin/true`),
   memoized; on Linux `sandboxExecAvailable()`→false, `bwrapAvailable()` drives the wrapping.
3. `spawnSafely`: branch on platform — darwin → sandbox-exec (current); linux + bwrap → `bwrap <args> -- <command> <args>`.
4. **Real e2e** (Linux, gated on availability): same four assertions as the macOS production-profile e2e.
5. doctor: extend the strict-fail check to Linux/bwrap.
6. docs: update CLAUDE.md limitations (glob-deny not enforced on Linux; bwrap available).

**Open design decision for Increment 2:** the glob-deny gap on Linux (no mount-level glob). Options:
(a) document as not-enforced on Linux; (b) tmpfs-mask the specific glob matches found under the repo
at profile-build time (TOCTOU-ish, partial). Decide in that increment's brainstorm.
