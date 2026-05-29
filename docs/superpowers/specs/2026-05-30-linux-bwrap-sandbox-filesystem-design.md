# Linux `bwrap` Filesystem Sandbox — Design (Sandbox Increment 2)

> **Status:** Approved (brainstorm 2026-05-30). Next: `writing-plans` → task-by-task plan.
> **Increment 1 (macOS `sandbox-exec`):** COMPLETE & MERGED (PR #44). This increment mirrors it on Linux.

**Goal:** Make `sandbox.mode: "strict" | "permissive"` actually filesystem-isolate a reviewer
subprocess on **Linux** via `bubblewrap` (`bwrap`), instead of refusing to review there. The
OS-agnostic `SandboxProfile`, `buildSandboxProfile`, `resolveForSandbox`, the
`ReviewInput.sandbox` → adapter → `spawnSafely` wiring, the orchestrator profile-build, and the
strict/permissive fallback are all **reused unchanged** from Increment 1. Only a Linux argv
translator + a `spawnSafely` Linux branch + a Linux e2e are new.

**Spec for Increment 1 (reference):** `docs/superpowers/specs/2026-05-29-macos-sandbox-filesystem-design.md`
**Plan (Increment-2 task outline):** `docs/superpowers/plans/2026-05-29-macos-sandbox-filesystem.md` (bottom section)

---

## Background: why this is the inverse of macOS

macOS Seatbelt is an **allow-default + deny-specific** model. `buildMacosSbpl` emits
`(allow default)`, then `(deny file-write* …)` except the working area, then
`(deny file-read* …)` for secrets — including **glob denies** (`*.pem`, `.env`, …) rendered as
anchored SBPL regexes (`globToSbplRegex`) that match those files **anywhere** in the readable tree.

`bwrap` is a **mount-namespace** model — the inverse. You construct the reviewer's filesystem
view explicitly with `--ro-bind` / `--bind` / `--tmpfs`. You can only mask whole **mount points**
(dirs / paths), **not pattern-matched files** scattered across the tree. Consequences:

- **Dir-level denies translate cleanly:** every `SECRET_DIRS` entry (`~/.ssh`, `~/.aws`,
  `~/.gnupg`, the cred files) **and every other provider's credential dir** → `--tmpfs <dir>`
  makes the path appear as an empty mount. The high-value secrets are fully covered.
- **Glob-level denies have no mount expression** — `SECRET_GLOBS` (`.env`, `.env.local`,
  `.env.production`, `*.pem`, `*.key`, `*.p12`, `*.pfx`) cannot be masked by pattern. **This is
  the gap, and it is documented as not-enforced on Linux** (decision below).

---

## Design decisions (from the brainstorm)

### D1 — Mount model: **deny-mirror** (`--ro-bind / /` + masks), not allow-list

`bwrap` would *permit* a tighter allow-list (bind only the workdir / tmp / own creds + system
runtime, so everything else is invisible by construction). We deliberately do **not** do that this
increment:

- **Parity & low risk.** Increment 1 chose allow-default on macOS specifically so a narrower
  model can't block something the reviewer CLI needs at runtime — a crash *before* review becomes
  a fail-closed ERROR under `strict` (a reviewer that should have passed now blocks the turn).
  `--ro-bind / /` mirrors that: everything the CLI needs (its binary, the bun/node runtime, shared
  libs, TLS certs, `/etc/resolv.conf`) is present.
- **Allow-list is stronger but fragile** — enumerating every runtime mount correctly across distros
  is exactly the "works on my machine" failure mode. It is a **possible future hardening increment**,
  not this one.

### D2 — Glob-deny gap: **document as not-enforced on Linux**

Ship the dir-`--tmpfs` masks; emit a one-time WARN and a CLAUDE.md note that the `SECRET_GLOBS`
patterns are **macOS-only**. Rationale:

- This repo has repeatedly been bitten by *partial measures that look complete*. A pre-scan that
  `--ro-bind /dev/null`-masks some glob matches but misses TOCTOU-created files and forces a scan-scope
  choice (`/`? just the workdir?) would read as "Linux is sandboxed" when it is only mostly so.
- The crown-jewel secrets (cred dirs/files) are masked regardless; the glob gap is the long tail.
- **YAGNI** — no demonstrated need yet.

**Honest divergence to document:** a `.env` / `*.pem` inside the repo working dir is *denied* to the
macOS reviewer (regex) but *visible* to the Linux reviewer (it lives under the `--ro-bind`'d tree
and bwrap can't pattern-deny it).

**Recorded follow-up (NOT in scope this increment):** a *targeted* mitigation could mask only
well-known dotenv files at the repo root via a single shallow scan + `--ro-bind /dev/null <file>`
(low TOCTOU, bounded scope). Deferred — revisit if a real leak is demonstrated.

### D3 — Network: **kept open** (no `--unshare-net`)

Same scope as macOS: API reviewers need network; host-allowlisting is out of scope. Documented.

---

## Architecture

### New: `src/sandbox/bwrap.ts` (pure)

```
buildBwrapArgs(profile: SandboxProfile, homeDir: string): string[]
```

Returns the bwrap argv **up to and including the `--` terminator**; the caller appends the real
`command` and its args. Construction (deny-mirror):

```
--die-with-parent --unshare-user
--ro-bind / /                       # expose everything read-only
--dev /dev --proc /proc             # fresh devtmpfs + proc (runtime needs them; don't leak host /dev)
<per readDeny dir>   --tmpfs <dir>            # mask secret dirs → appear empty
<per writeAllow>     --bind <bindSrc> <path>  # make the working area writable (rw over the ro)
--
```

Rules:

- **Paths are already canonical.** `spawnSafely` resolves every `readDeny` / `writeAllow` via
  `resolveForSandbox(p, home)` before calling `buildBwrapArgs` (same as the macOS path). The
  translator assumes absolute, realpath'd inputs.
- **Write-only guard (reused invariant):** a `writeAllow` path nested under a `readDeny` path
  throws — same error contract as `buildMacosSbpl` (`/write-only|nested|conflict/i`). With the
  guard, the `--tmpfs` masks and `--bind` rw paths are disjoint, so ordering between the two blocks
  is irrelevant.
- **File vs dir for `writeAllow`:** `bwrap --bind` requires an **existing source**. `findingsPath`
  is a file that may not exist before the first write. So: if the target is an existing directory,
  bind the path itself; otherwise (a file, or a not-yet-existing path) bind its **parent directory**
  rw at the parent's location. `tmpDir` and own-cred dirs are existing dirs → bound directly.
- **`readDenyGlobs` is ignored** (the documented D2 gap).
- **No `--unshare-net`** (D3). `--unshare-user` is the unprivileged-userns entry point; on a
  locked-down host (Ubuntu 24.04 `kernel.apparmor_restrict_unprivileged_userns`) it makes the
  availability probe fail → `strict` fails closed (acceptable + honest; doctor already carries the
  remediation string).

### Changed: `src/sandbox/availability.ts`

- Add `bwrapAvailable(): Promise<boolean>` — memoized, **linux-only** (non-linux → `false`),
  functional probe mirroring the real run flags:
  `bwrap --ro-bind / / --unshare-user --uid 0 -- true` (same shape as `doctor-check.ts`'s
  `bwrapTest`). A `--version`-only check is insufficient — it wouldn't catch the userns lockdown.
- Add `sandboxRuntimeAvailable(): Promise<boolean>` — the **single** entry point used by both
  `spawnSafely` and `doctor`: `darwin → sandboxExecAvailable()`, `linux → bwrapAvailable()`,
  else `false`.
- Add `__resetBwrapCache()` (test-only memo reset, mirroring `__resetSandboxExecCache`).

### Changed: `src/utils/spawn.ts`

The existing `if (input.sandbox) { … }` block becomes platform-aware:

```
if (input.sandbox) {
  const available = await sandboxRuntimeAvailable();
  if (available) {
    const home = homedir();
    const resolved = <canonicalize readAllow/readDeny/writeAllow via resolveForSandbox; globs pass through>;
    if (platform() === "darwin") {
      // unchanged: write SBPL file, args = ["-f", sbplFile, command, ...args], command = "sandbox-exec"
    } else {                       // linux
      args = [...buildBwrapArgs(resolved, home), command, ...args];
      command = "bwrap";
    }
    sandboxApplied = true;
  } else if (input.sandbox.mode === "strict") {
    throw new SandboxUnavailableError(<platform-appropriate message: sandbox-exec on macOS / bwrap on Linux>);
  } else {
    sandboxFellBack = true;        // permissive: run unsandboxed + WARN (WARN emitted by orchestrator, as today)
  }
}
```

- No temp profile file on Linux — the bwrap config **is** argv, so the macOS `mkdtempSync` / SBPL
  file write / `rmSync` cleanup path is darwin-only (keep it inside the darwin branch).
- `SpawnResult.{sandboxApplied,sandboxFellBack}` semantics unchanged.

### Reused unchanged

`SandboxProfile`, `buildSandboxProfile` (incl. `readDenyGlobs`), `resolveForSandbox`,
`ReviewInput.sandbox`, the four adapters' forwarding, the orchestrator profile-build +
strict-error mapping, `SandboxUnavailableError`.

### Changed: `doctor`

The strict-fail wiring added in Increment 1 (Task 10) currently calls `sandboxExecAvailable()`.
Repoint it at `sandboxRuntimeAvailable()` so a `strict` config on a Linux host **without** working
bwrap is a `fail` check (`doctorExitCode → 2`); `permissive` → `warn`; available → `ok`. The
underlying `checkSandboxHealth()` in `doctor-check.ts` already probes bwrap on linux and carries the
Ubuntu-24.04 remediation — reuse its output for the detail string.

### Changed: `CLAUDE.md`

Extend the sandbox limitations bullet: Linux `bwrap` enforces **dir-level** filesystem isolation via
a mount namespace (secret dirs `--tmpfs`-masked, writes restricted to the working area); **glob-denies
(`*.pem`, `*.key`, `.env*`) are NOT enforced on Linux** (macOS-only — documented divergence: a repo
`.env` is visible to the Linux reviewer, denied to the macOS one); network is NOT isolated on either
platform; `strict` fails closed when `bwrap` is unavailable (e.g. Ubuntu 24.04 userns lockdown —
`reviewgate doctor` prints the remediation).

---

## Testing

- **`tests/unit/bwrap.test.ts` (pure, runs everywhere):**
  - argv begins with `--die-with-parent --unshare-user`, contains `--ro-bind / /`, `--dev /dev`,
    `--proc /proc`, ends with `--`.
  - one `--tmpfs <dir>` per `readDeny` entry.
  - one `--bind <src> <path>` per `writeAllow`; a file/nonexistent target binds its parent dir.
  - **does NOT** `--unshare-net`.
  - `readDenyGlobs` produce **no** argv entries (documented gap — asserted explicitly so the gap is
    intentional, not an accident).
  - write-only guard: `writeAllow` nested under `readDeny` throws `/write-only|nested|conflict/i`.
- **`tests/unit/availability.test.ts` (extend):** `bwrapAvailable()` returns a boolean and is
  memoized; `sandboxRuntimeAvailable()` returns `false` on a non-darwin/non-linux platform.
- **`tests/integration/bwrap-real.test.ts` (real, gated):** `describe.skip` unless
  `platform()==='linux' && await bwrapAvailable()`. Mirrors the macOS production e2e's four
  assertions via `spawnSafely` with a real profile:
  1. read of a secret dir (`<home>/.ssh/id_rsa`) is **denied** (masked → empty), output lacks the secret;
  2. read of a file in the working dir is **allowed**;
  3. write into `writeAllow` (the run tmp dir) **succeeds**;
  4. write outside the working area is **denied**.
  **The author is on macOS, so this skips locally** — gated on availability per the session brief;
  it runs on a Linux host/CI.

---

## Out of scope (explicit)

- Allow-list mount model (D1 — possible future hardening increment).
- Glob masking / pre-scan on Linux (D2 — recorded follow-up).
- Network isolation (D3 — same documented limitation as macOS).
- Windows (unsupported; `mode:"off"` or WSL2).
- PID-namespace / seccomp hardening — `--die-with-parent` + the existing detached process-group
  SIGKILL in `spawnSafely` already bound the process tree; adding `--unshare-pid` could interfere
  with the host's group-kill and is not needed for the filesystem-isolation goal.

---

## Definition of Done

- `bunx tsc --noEmit` clean · `bun run lint` clean · `bun test` green (incl. the new pure unit tests;
  the real bwrap e2e skips on macOS) · `bun run build` OK.
- 2-reviewer DoD panel (Opus `code-reviewer` agent + Gemini via `agy`, stdout) PASS before merge.
- Branch; **ask before pushing.**
