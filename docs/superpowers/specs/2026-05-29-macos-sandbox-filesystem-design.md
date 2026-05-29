# Design: macOS Filesystem Sandbox for Reviewer Subprocesses (Increment 1)

**Status:** approved (brainstorm) — ready for implementation plan
**Date:** 2026-05-29
**Weakness addressed:** #3 ("isolation story is aspirational — sandbox `off` means the reviewer runs unisolated")

## Problem

Reviewgate spawns reviewer CLIs (`codex`, `claude`, `gemini`, `opencode`) and feeds them an **untrusted diff**. A prompt-injected reviewer could read secrets (`~/.ssh`, `~/.aws`, `.env`, *other* providers' credential dirs) or write outside its working area. Today:

- `sandbox.mode: "off"` (the honest default) → reviewers spawn **unisolated** via `spawnSafely`.
- `sandbox.mode: "strict" | "permissive"` → the orchestrator **refuses to review** (`runIteration` returns `ERROR` when `sandboxMode !== "off"`). It was a placeholder waiting for an unpublished `@anthropic-ai/sandbox-runtime` package; `SandboxManager` dynamic-imports it and throws.

This increment makes `strict`/`permissive` **actually isolate** the reviewer's filesystem access on **macOS** using `sandbox-exec` (Seatbelt/SBPL), instead of refusing.

## Scope

**In scope (this increment):**
- macOS only, via `sandbox-exec`.
- **Filesystem isolation only:** deny reads of secret/foreign-credential paths; restrict writes to the working area; leave reads otherwise open.
- Wire isolation into the real reviewer spawn path (`spawnSafely`).
- `strict` vs `permissive` fallback semantics.
- `doctor` surfaces a misconfigured strict setup.

**Out of scope (documented, not built here):**
- **Network isolation.** macOS `sandbox-exec` cannot allowlist outbound by hostname (not DNS-aware), and API reviewers *require* network to reach their provider. A blanket network-deny would break them; per-IP allowlisting is fragile. Network is left open and this limitation is stated honestly in `CLAUDE.md` + the sandbox docs. (A future increment may revisit on Linux where bwrap + a proxy is feasible.)
- **Linux (`bwrap`) and Windows.** Linux is the next increment; Windows stays unsupported. On these platforms `strict` still fails closed, `permissive` warns+runs.
- Re-activating the `@anthropic-ai/sandbox-runtime` dependency (we use OS-native `sandbox-exec` directly).

## Design decisions (from brainstorm)

1. **Platform:** macOS `sandbox-exec` first.
2. **Isolation scope:** filesystem-only (network left open, documented).
3. **Fallback semantics:** `strict` = isolate or **refuse** (ERROR) when isolation is unavailable; `permissive` = isolate when possible, else **run unsandboxed with a loud WARN**.
4. **Spawn seam:** make `spawnSafely` sandbox-aware (one spawn implementation) rather than reviving the parallel `SandboxManager`.
5. **Profile refinement:** the reviewer's **own** credential dir must be writable (OAuth token refresh), not just readable.

## Architecture

### Components

**Path canonicalization (CRITICAL — applies to every path below)**
- Seatbelt matches **kernel-canonicalized** paths. On macOS `/tmp` → `/private/tmp`, `/var` → `/private/var`, and the home dir / repo may sit under symlinks. A non-canonical path in the SBPL silently mismatches → unexpected denials (or, worse, an "allow" that never matches).
- Therefore EVERY path rendered into the SBPL (`tmpDir`, `workingDir`, `findingsPath`, own-cred dir, every deny path) MUST be resolved with `fs.realpathSync()` (falling back to a normalized absolute path if the path doesn't exist yet, e.g. `findingsPath` before first write — realpath the parent dir + append the basename). `~` is expanded to `homeDir` first, then realpath'd.

**`src/sandbox/sbpl.ts` (new, pure)**
- `buildMacosSbpl(profile: SandboxProfile, homeDir: string): string` — translate the existing OS-agnostic `SandboxProfile` into a Seatbelt SBPL profile string. Receives ALREADY-canonicalized absolute paths in the profile (canonicalization happens in the profile builder / a dedicated resolve step so `sbpl.ts` stays pure and testable).
- SBPL shape (last-matching-rule-wins semantics):
  ```scheme
  (version 1)
  (allow default)                         ; don't break normal process operation
  (deny file-write*)                      ; …then forbid all writes
  (allow file-write*                      ; …except the working area
    (subpath "<tmpDir>")
    (subpath "<workingDir>")              ; reviewer scratch within the repo copy
    (literal "<findingsPath>")
    (subpath "<ownCredDir…>")             ; OAuth token refresh (writablePaths too)
  )
  (deny file-read*                        ; secrets + foreign provider creds
    (subpath "<~/.ssh>") (subpath "<~/.aws>") (subpath "<~/.gnupg>")
    (subpath "<other-provider-cred-dirs>") …
  )
  ```
- Globs like `.env`, `*.pem` from the config's `deniedReads` are translated to Seatbelt `(regex …)` **bound to absolute paths** (e.g. `#"^/Users/x/.*/\.env$"`, not a bare substring) to avoid false positives/escapes; regex count is kept small (perf). Patterns SBPL can't faithfully express are documented as not-enforced rather than silently dropped.
- **Baseline read-deny set** (in addition to the config's `deniedReads` + foreign provider cred dirs): `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/.config/gh`, `~/.bash_history`, `~/.zsh_history` — common high-value credential/history files a prompt-injected reviewer would target.
- **Invariant (enforced by test):** no `writeAllow` path is nested under any read-deny path — otherwise the file is "write-only" inside the sandbox and a tool opening it `O_RDWR` crashes.
- Pure + deterministic (stable for snapshot testing).

**`src/utils/spawn.ts` (modified)**
- `SpawnInput` gains optional `sandbox?: { profile: SandboxProfile; mode: "strict" | "permissive" }`.
- When `sandbox` is set:
  - If `platform() === "darwin"` and `sandbox-exec` is available: write the SBPL to a temp `.sb` file and rewrite the spawn to `sandbox-exec -f <file.sb> <command> <args...>`. All existing behavior (stdin-close, zero-byte watchdog, timeout, stdout/stderr files) is preserved — only the argv is wrapped.
  - Else (not macOS, or `sandbox-exec` missing/non-functional): behavior depends on `mode` — `strict` → throw `SandboxUnavailableError`; `permissive` → spawn unsandboxed and set a flag on the result so the caller can WARN.
- A small availability probe (`sandboxExecAvailable()`), memoized per process, reusing the logic already in `doctor-check.ts` (extract a shared helper).
- The temp `.sb` file is cleaned up on the child's `exit`/`close` (or `error`), NOT synchronously right after the `spawn` call — `sandbox-exec` may still be reading the profile during fork/exec on a slow filesystem.

**`SpawnResult` (modified)**
- Add `sandboxApplied: boolean` and `sandboxFellBack: boolean` so the adapter/orchestrator can record whether isolation actually happened and WARN under `permissive`. (The retired `SandboxManager`'s `SandboxRunResult` is not reused — `spawnSafely`'s `SpawnResult` is the single result type.)

**`src/sandbox/manager.ts` (retired/replaced)**
- The `@anthropic-ai/sandbox-runtime` dynamic-import path is removed. Either delete `SandboxManager` (if no other caller) or reduce it to a thin re-export; spawn wrapping now lives in `spawnSafely`. `SandboxUnavailableError` moves to a shared module (e.g. `src/sandbox/errors.ts`) so `spawnSafely` and callers can use it without importing the dead manager.

**`src/sandbox/profile-builder.ts` (modified)**
- `writeAllow` gains the reviewer's **own** credential dir(s) (`CREDENTIAL_PATHS[providerId]`) so OAuth token refresh isn't denied. (Reads of own creds already allowed; writes were not.)

**`src/core/orchestrator.ts` (modified)**
- Remove the blanket `if (this.input.sandboxMode !== "off") return ERROR`.
- Per reviewer, build the profile (`buildSandboxProfile`) and pass `{ profile, mode }` down to the adapter (via `ReviewInput`), which forwards it to `spawnSafely`.
- Fail closed (ERROR for that reviewer / iteration) only when `strict` and isolation is genuinely unavailable (non-macOS, or `sandbox-exec` missing, or the sandboxed spawn errors). Under `permissive`, run unsandboxed and propagate the WARN into the report + Stop-hook reason.

**`src/providers/*.ts` (4 CLI adapters, modified)**
- `ReviewInput` gains optional `sandbox?: { profile, mode }`; each adapter passes it into its `spawnSafely` call. `complete()` (judge path) is also wrapped when a sandbox is requested.

**`src/cli/commands/doctor.ts` + `src/sandbox/doctor-check.ts` (modified)**
- When the effective `sandbox.mode` is `strict`, doctor runs the `sandbox-exec` probe and emits a **fail** (not just warn) if it's unavailable on macOS, or a clear note on non-macOS (strict will refuse). Under `permissive` + unavailable → warn.

### Data flow

```
orchestrator.runIteration
  └─ per reviewer: buildSandboxProfile(providerId, mode, workingDir, findingsPath, tmpDir, config.sandbox.*)
       └─ adapter.review({ …, sandbox: { profile, mode } })
            └─ spawnSafely({ command, args, …, sandbox })
                 macOS + sandbox-exec? → sandbox-exec -f <sbpl.sb> command args   → SpawnResult{ sandboxApplied:true }
                 unavailable + strict   → throw SandboxUnavailableError            → reviewer ERROR (fail closed)
                 unavailable + permissive → plain spawn                            → SpawnResult{ sandboxApplied:false, sandboxFellBack:true } → WARN
```

## Error handling

- `SandboxUnavailableError` (shared module) — thrown by `spawnSafely` under `strict` when isolation can't be applied. The adapter maps it to a `verdict:"ERROR"`, `status:"error"` result with a clear `statusDetail` ("sandbox strict requested but sandbox-exec unavailable on this host"). This naturally flows into the existing fail-closed gate (0 ok reviewers → ERROR/block) — never a silent PASS.
- A sandboxed spawn that exits non-zero because the sandbox denied a needed operation is indistinguishable from a normal non-zero exit at the spawn layer; the existing reviewer-error handling applies. The `permissive` fallback exists precisely so a too-tight profile doesn't hard-block a user who opted for convenience.
- `permissive` fallback is surfaced (not silent): `sandboxFellBack:true` → a WARN line in `pending.md` + the Stop-hook reason ("reviewer ran UNISOLATED — sandbox-exec unavailable").

## Testing strategy (real, not stubbed)

1. **`sbpl.ts` + path-resolve unit tests:** assert the generated SBPL contains the expected `(deny file-read* …)` for each secret/foreign-cred path (incl. the expanded baseline: .netrc/.git-credentials/.npmrc/.pypirc/histories), the `(allow file-write* …)` for tmp/findings/own-cred, `~` expansion, and a stable snapshot. Assert the resolve step canonicalizes (`/tmp` → `/private/tmp` on macOS via realpath) so no rule is silently non-matching. Invariant test: no `writeAllow` path is nested under any read-deny path.
2. **Real `sandbox-exec` e2e (macOS only, gated on availability):** build a profile, run `sandbox-exec -f <sb> /bin/cat <denied-file>` and assert it FAILS (non-zero / "Operation not permitted"); run it against an allowed file and assert it SUCCEEDS; assert a write to a denied dir fails and to tmp succeeds. This proves the isolation is *real* on this runtime (mirrors the SSRF real-verification discipline). Skipped with a clear message when `sandbox-exec` is unavailable.
3. **`spawnSafely` integration:** with a fake "reviewer" script, assert (a) macOS+available → the argv is wrapped with `sandbox-exec -f` and the run still produces stdout/exit code with the watchdog intact; (b) strict + forced-unavailable → throws `SandboxUnavailableError`; (c) permissive + forced-unavailable → runs plain, `sandboxFellBack:true`.
4. **Orchestrator:** `strict` + unavailable → reviewer ERROR → gate blocks (no silent PASS); `permissive` + unavailable → runs + WARN surfaced in the report.
5. **Regression:** `mode:"off"` path unchanged (no sandbox wrapping); full suite green.

## Honest limitations (to document in CLAUDE.md + sandbox docs)

- **Network is not isolated** in this increment — a compromised reviewer can still exfiltrate over the network. Filesystem isolation blocks the read-secrets/write-anywhere vector only.
- **macOS only.** Linux (`bwrap`) is the next increment; Windows unsupported.
- **`sandbox-exec` is deprecated** by Apple (since 10.14) but remains functional and widely used; if Apple removes it, strict falls back to refuse.
- **Glob deny patterns** (`.env`, `*.pem`) are approximated in SBPL; patterns SBPL can't express are documented as not-enforced rather than silently ignored.
- **Symlink/TOCTOU (in-sandbox):** SBPL matches kernel-canonicalized paths, so a symlink *inside* the sandbox that points at a denied path is still blocked by the kernel.
- **Host-side symlink traversal (must be handled, not just documented):** the sandboxed reviewer can write a symlink inside its writable dir pointing at a host secret; if the *unsandboxed* host (Reviewgate) later reads reviewer-produced files following symlinks, it leaks. Any host-side read of a reviewer-written path under the writable dir MUST use `O_NOFOLLOW` (or realpath-validate it stays within the writable dir) — same discipline as the existing plan-refs `O_NOFOLLOW` work. (Note: built-in adapters parse the reviewer's STDOUT, not the findings file, which limits exposure — but the rule is enforced where any such read exists.)
- **Own-cred-dir write = persistence risk (accepted):** allowing writes to the reviewer's own cred dir (needed for OAuth token refresh) means a compromised reviewer could plant a malicious config/plugin that runs in a *future, unsandboxed* invocation. Accepted trade-off for this increment; documented. A future hardening could mount a throwaway cred copy.
- **Default-allow surface:** `(allow default)` leaves network, Mach IPC, and subprocess creation unrestricted — filesystem-only is the explicit scope; IPC/subprocess escape vectors are out of scope here and noted.

## Success criteria

- On macOS with `sandbox-exec`, `sandbox.mode:"strict"` runs a real review where the reviewer subprocess **cannot** read `~/.ssh` (proven by the e2e test) and **can** read the repo + write findings.
- `strict` without working isolation fails closed (ERROR, gate blocks); `permissive` runs with a visible WARN.
- `mode:"off"` is byte-for-byte unchanged.
- `doctor` flags a strict config that can't be enforced.
- Full suite green; tsc + lint clean; 2-reviewer DoD PASS.
