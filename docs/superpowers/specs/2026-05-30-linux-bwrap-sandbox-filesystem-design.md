# Linux `bwrap` Filesystem Sandbox — Design (Sandbox Increment 2)

> **Status:** Approved (brainstorm 2026-05-30). Next: `writing-plans` → task-by-task plan.
> **Increment 1 (macOS `sandbox-exec`):** COMPLETE & MERGED (PR #44). This increment mirrors it on Linux.

**Goal:** Make `sandbox.mode: "strict" | "permissive"` actually filesystem-isolate a reviewer
subprocess on **Linux** via `bubblewrap` (`bwrap`), instead of refusing to review there. The
OS-agnostic `resolveForSandbox`, the `ReviewInput.sandbox` → adapter → `spawnSafely` wiring, the
orchestrator profile-build, and the strict/permissive fallback are **reused unchanged** from
Increment 1; `SandboxProfile`/`buildSandboxProfile` are reused with **one additive change** (a
classified `fs.writeTargets` companion — see the write-target contract). New code: a Linux argv
translator (`bwrap.ts`), a `spawnSafely` Linux branch, the availability probe, and a Linux e2e.

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

- **Path-level denies translate cleanly:** every `SECRET_DIRS` entry **and every other provider's
  credential dir** is masked by mounting an empty over it — a directory via `--tmpfs <dir>`, a file
  (`~/.netrc`, `~/.git-credentials`, …) via `--ro-bind /dev/null <file>` (see C5 in the rules).
  The high-value secrets are fully covered.
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
and bwrap can't pattern-deny it). Because network is intentionally **open** (D3), a Linux reviewer
that reads such a secret could in principle exfiltrate it — this is the residual risk that makes
the gap worth documenting loudly (Gemini spec review, W5). It is accepted for this increment; the
crown-jewel cred dirs are masked regardless, and the targeted-dotenv-mask follow-up below is the
upgrade path if a real leak is demonstrated.

**Recorded follow-up (NOT in scope this increment):** a *targeted* mitigation could mask only
well-known dotenv files at the repo root via a single shallow scan + `--ro-bind /dev/null <file>`
(low TOCTOU, bounded scope). Deferred — revisit if a real leak is demonstrated.

### D3 — Network: **kept open** (no `--unshare-net`)

Same scope as macOS: API reviewers need network; host-allowlisting is out of scope. Documented.

---

## Architecture

### New: `src/sandbox/bwrap.ts` (fs-reading, non-mutating)

```
buildBwrapArgs(profile: SandboxProfile, homeDir: string): string[]
```

Unlike the macOS `buildMacosSbpl` (truly pure — globs need no fs), `buildBwrapArgs` **reads** the
filesystem (`statSync` / `existsSync`) to classify each path as file vs dir vs absent — the
mount-namespace model requires it (`--tmpfs` is dir-only; file vs dir bind differs). It does **not
mutate** anything: the ensure-exists side-effects for write targets (`mkdir -p` / `touch`) are
performed by `spawnSafely` *before* it calls `buildBwrapArgs`, mirroring how `spawnSafely` already
owns the fs work (path resolution, the SBPL temp file) and keeps the translator deterministic given
the on-disk state. Tests create real fixture files/dirs to exercise both branches.

Returns the bwrap argv **up to and including the `--` terminator**; the caller appends the real
`command` and its args. Construction (deny-mirror). **Order matters — bwrap applies operations
left-to-right and the last one wins, so the deny-masks are emitted LAST so no writable bind can
shadow a secret mask** (see rule "mask ordering" below):

```
--die-with-parent --unshare-user --unshare-pid
--ro-bind / /                       # expose everything read-only
--dev /dev --proc /proc             # fresh devtmpfs + isolated proc (paired with --unshare-pid)
<per writeAllow>            --bind <bindSrc> <path>   # make the working area writable (rw over the ro)
<per EXISTING readDeny DIR>   --tmpfs <dir>           # mask secret DIR → empty mount (LAST)
<per EXISTING readDeny FILE>  --ro-bind /dev/null <f> # mask secret FILE → empty (tmpfs can't mount on a file)
--
```

Rules:

- **Paths are already canonical.** `spawnSafely` resolves every `readDeny` / `writeAllow` via
  `resolveForSandbox(p, home)` before calling `buildBwrapArgs` (same as the macOS path). The
  translator assumes absolute, realpath'd inputs.
- **Skip non-existent readDeny paths (C1).** Mask only readDeny paths that **exist** on the host.
  A secret that doesn't exist needs no masking, and mounting onto a missing destination under the
  `--ro-bind / /` root is fragile (mkdir on a read-only mount). The default readDeny list
  (`SECRET_DIRS` + every other provider's cred dir) routinely contains paths absent on a given
  host; silently skipping them is correct (nothing to hide) and robust.
- **File vs dir for readDeny masking — `--tmpfs` is dir-only (C5, Gemini re-review).** `--tmpfs`
  mounts a filesystem onto a **directory** and *crashes* if the destination is a regular file.
  Several `SECRET_DIRS` entries are in fact files (`~/.netrc`, `~/.git-credentials`, `~/.npmrc`,
  `~/.pypirc`, `~/.bash_history`, `~/.zsh_history`). So branch on the host stat of each existing
  readDeny path: a **directory** → `--tmpfs <dir>` (appears empty); a **file** → `--ro-bind
  /dev/null <file>` (reads return EOF). The `/dev/null` bind source is the host's, resolved before
  the new `--dev` mount, so ordering is safe. (macOS `(subpath …)` masked both transparently — this
  file/dir split is Linux-specific.)
- **Bidirectional overlap guard + mask-last ordering (C2).** The macOS write-only guard
  (`writeAllow` nested under `readDeny` → throw, contract `/write-only|nested|conflict/i`) is kept
  for parity. It is **extended to the reverse direction**: a `readDeny` dir nested under a
  `writeAllow` dir also throws (a user `writablePaths` entry that is a *parent* of a secret dir
  would otherwise un-mask the secret AND make it writable). As defense-in-depth, the `--tmpfs`
  deny-masks are emitted **after** all `--bind` writable paths, so even an unforeseen overlap
  resolves in favor of the mask (deny wins).
- **`writeAllow` binds at the path's OWN location — never a parent (C3 + Gemini W-refine).**
  `bwrap --bind` needs an existing source, and bwrap supports **file-level** binds (a file onto a
  file), so we never need to widen to a containing directory. `spawnSafely` brings each write target
  into existence with the right kind *before* building the argv (see the **write-target existence
  contract** under `spawn.ts` — it consumes the classified `fs.writeTargets`, never `mkdir`s an
  existing path, and skips non-existent own-cred candidates). `buildBwrapArgs` then stats each path
  and emits `--bind <path> <path>` at its own location — a file binds as a file, a dir as a dir.
  **No parent directory is ever made writable**, so a write-target sitting
  directly under a broad dir (e.g. `~`) cannot widen the grant to that dir. (`findingsPath`'s own
  location is `<workingDir>/.reviewgate/findings/<id>.md`; built-in adapters parse STDOUT, not this
  file, so the write area is belt-and-suspenders — keep it minimal regardless.)
- **`readDenyGlobs` is ignored** (the documented D2 gap).
- **`--unshare-pid` + `--proc /proc` (W4).** A fresh `/proc` is only actually isolated inside a new
  PID namespace; without `--unshare-pid` the reviewer could read other same-user host processes'
  `/proc/<pid>/{environ,cmdline}` (secret leak) and signal them. `--unshare-pid` is the standard
  pairing, makes bwrap pid 1, and is compatible with `spawnSafely`'s detached process-group
  SIGKILL + `--die-with-parent` (killing the host-side bwrap tears down the whole namespace —
  cleanup is in fact cleaner). We still do **not** `--unshare-net` (D3).
- **No `--unshare-net`** (D3). `--unshare-user` is the unprivileged-userns entry point; on a
  locked-down host (Ubuntu 24.04 `kernel.apparmor_restrict_unprivileged_userns`) it makes the
  availability probe fail → `strict` fails closed (acceptable + honest; doctor already carries the
  remediation string).

### Changed: `src/sandbox/availability.ts`

- Add `bwrapAvailable(): Promise<boolean>` — memoized, **linux-only** (non-linux → `false`),
  functional probe that mirrors the **production namespace flags** so a probe-passes /
  production-fails mismatch can't happen: `bwrap --unshare-user --unshare-pid --ro-bind / / --dev
  /dev --proc /proc -- true`. In particular it does **not** pass `--uid 0` (production doesn't —
  the reviewer runs as the mapped real user; Gemini INFO). A `--version`-only check is insufficient
  — it wouldn't catch the userns lockdown that `--unshare-user`/`--unshare-pid` trip. (The
  pre-existing `doctor-check.ts` `bwrapTest` keeps its own probe for the health-report detail; this
  new probe is the one `spawnSafely` gates on.)
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
      ensureWriteTargets(resolved.fs);   // see "write-target existence contract" below
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

**Write-target existence contract (Linux only).** `bwrap --bind` needs every source to exist with
the right kind *before* the namespace is built (the root is bound read-only, so the reviewer can't
create them inside). A flat `string[]` can't drive this — `mkdir -p` on an existing file crashes,
and own-cred dirs (don't fabricate) must be told apart from user `writablePaths` (create as a dir).
So `buildSandboxProfile` additionally emits a **classified** list (consumed only by the Linux path;
macOS ignores it):

```
fs.writeTargets: { path: string; kind: "file" | "dir"; createIfMissing: boolean }[]
  findings file  → { kind: "file", createIfMissing: true }
  tmpDir         → { kind: "dir",  createIfMissing: true }
  user writablePaths → { kind: "dir", createIfMissing: true }   // a writable path defaults to a dir
  own-cred dirs  → { kind: "dir",  createIfMissing: false }     // bind ONLY if already present
```

`ensureWriteTargets(writeTargets)` is the **only** mutation in the Linux path and never touches an
existing path:
- path **exists** → leave it; `buildBwrapArgs` binds it per its **actual** `statSync` kind (stat
  wins over the tag, so a `writablePaths` entry that is really a file still binds as a file — no
  crash).
- path **missing** + `createIfMissing` → create per `kind` (`touch` a file after `mkdir -p` parent;
  `mkdir -p` a dir), then bind.
- path **missing** + `!createIfMissing` (own-cred candidate like `~/.openai`) → **skip** (no token
  to refresh there; don't fabricate an empty cred dir under the ro home — an accepted minor limit,
  same effective outcome as not being logged in there).

`writeAllow: string[]` (the union) is **kept unchanged** so the macOS `buildMacosSbpl` `(subpath …)`
emission is untouched; `writeTargets` is the additive companion. This is the one place the "reuse
`SandboxProfile` unchanged" goal bends — additively.

### Reused unchanged

`resolveForSandbox`, `ReviewInput.sandbox`, the four adapters' forwarding, the orchestrator
profile-build + strict-error mapping, `SandboxUnavailableError`. `SandboxProfile` /
`buildSandboxProfile` are reused **with one additive change** — the classified `fs.writeTargets`
companion list (see the write-target existence contract); `writeAllow`, `readDenyGlobs`, and all
existing fields are untouched and the macOS behavior is unchanged.

### Changed: `doctor` + `doctor-check.ts` (single-probe consistency)

The strict-fail wiring added in Increment 1 (Task 10) currently calls `sandboxExecAvailable()`.
Repoint it at `sandboxRuntimeAvailable()` so a `strict` config on a Linux host **without** working
bwrap is a `fail` check (`doctorExitCode → 2`); `permissive` → `warn`; available → `ok`.

**Eliminate the divergent probe (Gemini W).** `checkSandboxHealth()` in `doctor-check.ts` has its
own `bwrapTest()` using `--unshare-user --uid 0`, which can disagree with the new production-mirror
`bwrapAvailable()` (no `--uid 0`) — doctor could report "functional" while the gate refuses, or
vice-versa. Make `bwrapAvailable()` the **single source of truth**: `checkSandboxHealth()`'s
available/unavailable verdict comes from `bwrapAvailable()` (it may keep producing the
Ubuntu-24.04 remediation detail string, but the boolean must be the shared probe's). Same for the
macOS side via `sandboxExecAvailable()`.

### Changed: `CLAUDE.md`

Extend the sandbox limitations bullet: Linux `bwrap` enforces **dir-level** filesystem isolation via
a mount namespace (secret dirs `--tmpfs`-masked, writes restricted to the working area); **glob-denies
(`*.pem`, `*.key`, `.env*`) are NOT enforced on Linux** (macOS-only — documented divergence: a repo
`.env` is visible to the Linux reviewer, denied to the macOS one); network is NOT isolated on either
platform; `strict` fails closed when `bwrap` is unavailable (e.g. Ubuntu 24.04 userns lockdown —
`reviewgate doctor` prints the remediation).

---

## Testing

- **`tests/unit/bwrap.test.ts` (fs-fixture based, runs everywhere — creates real temp files/dirs so the statSync branches are exercised):**
  - argv begins with `--die-with-parent --unshare-user --unshare-pid`, contains `--ro-bind / /`,
    `--dev /dev`, `--proc /proc`, ends with `--`.
  - per **existing** `readDeny` entry: a directory → one `--tmpfs <dir>`; a file → one `--ro-bind
    /dev/null <file>` (C5). A non-existent readDeny path produces **neither** (C1). (The test
    fixture creates a secret dir AND a secret file to exercise both branches.)
  - one `--bind <path> <path>` per `writeAllow`, each at its **own** location — a file target binds
    as a file, a dir target as a dir; **no parent directory** of a file target appears as a bind
    (C3). (Fixture includes a file write-target directly under a broad dir to prove the broad dir
    is not made writable.)
  - **mask-after-bind ordering (C2):** every deny-mask (`--tmpfs` / `--ro-bind /dev/null`) appears
    at a later argv index than every `--bind` writable path.
  - **does NOT** contain `--unshare-net`.
  - `readDenyGlobs` produce **no** argv entries (documented gap — asserted explicitly so the gap is
    intentional, not an accident).
  - overlap guard (C2): `writeAllow` nested under `readDeny` **and** `readDeny` nested under
    `writeAllow` both throw `/write-only|nested|conflict/i`.
- **`tests/unit/ensure-write-targets.test.ts` (the classified-target mutation):**
  - missing `{file, create:true}` → parent `mkdir -p`'d + file `touch`ed; missing `{dir, create:true}`
    → `mkdir -p`'d; missing `{dir, create:false}` (own-cred) → **left absent, not fabricated**.
  - an **existing file** passed as a `{dir, …}` target is **not** `mkdir`'d (no crash) and binds as
    a file per its real stat (the new-CRITICAL case).
- **`tests/unit/availability.test.ts` (extend):** `bwrapAvailable()` returns a boolean and is
  memoized and its probe argv carries the production unshare flags **without** `--uid 0`;
  `sandboxRuntimeAvailable()` returns `false` on a non-darwin/non-linux platform. A doctor test
  asserts `checkSandboxHealth()`'s boolean tracks the shared probe (no `--uid 0` divergence).
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
- `seccomp` syscall filtering — out of scope; the goal is filesystem isolation. (`--unshare-pid`
  IS used — see the bwrap.ts rules — to isolate `/proc`; `seccomp` is a separate future hardening.)
- A general writable `/tmp` — like macOS, only the explicit write-area (tmpDir + findings dir +
  own creds) is writable; scratch writes to arbitrary `/tmp` paths fail on **both** platforms
  (parity, not a Linux regression). Revisit only if a reviewer CLI is shown to need it.

---

## Definition of Done

- `bunx tsc --noEmit` clean · `bun run lint` clean · `bun test` green (incl. the new pure unit tests;
  the real bwrap e2e skips on macOS) · `bun run build` OK.
- 2-reviewer DoD panel (Opus `code-reviewer` agent + Gemini via `agy`, stdout) PASS before merge.
- Branch; **ask before pushing.**
