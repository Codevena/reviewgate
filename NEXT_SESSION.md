# Reviewgate — Next-Session Handoff

_Last updated: 2026-05-31. Read this first, then delete/ignore once you're oriented._

## What Reviewgate is
A code-review gate that runs **inside Claude Code's Stop hook**: on turn-end it spawns a
heterogeneous LLM reviewer panel (codex/gemini/claude/opencode/openrouter CLIs) as subprocesses,
aggregates findings under a severity-weighted veto, and **blocks the turn** until every finding is
fixed or rejected-with-reason. File-based (no chat parsing). Runtime is **Bun**. **It dogfoods
itself** — a `.reviewgate/` dir is present, so the gate runs on your own turns here.

## Current state (master is green)
`bun test` → ~1219 pass / 0 fail (11 skip) · `bunx tsc --noEmit` clean · `bun run lint` clean · `bun run build` OK.
The globally-installed `reviewgate` on PATH is a **symlink into this repo's `dist/`**, so after any
source change you must `bun run build` for the fix to go live (both this repo's gate AND external
dogfood repos like shoal run that symlinked binary).

This session landed **5 changes (PRs #46–#47 + 3 direct fixes), all through a 2-engine DoD panel
(Opus `code-reviewer` + codex; agy is the natural 3rd but was itself quota'd):**

**Reviewer-spawn reliability (3 fixes, master):**
- **NUL/control-byte strip** (`0aff3d4`): a NUL in a changed file (binary/UTF-16/NUL-after-8KB) flowed
  through `sanitizeDiff` into the prompt and was passed as a reviewer argv element → `node:child_process`
  threw `args[N] must be a string without null bytes`, erroring every reviewer at spawn. Fix:
  `stripControlBytes` Layer 0 in `src/diff/sanitizer.ts` + a NUL backstop in `spawnSafely`.
- **agy silent-stall quota detection** (`364453c`): quota'd + piped, `agy` hangs with **zero bytes**
  (its banner is TTY-only). `classifyAgyOutcome` in `src/providers/gemini.ts` now treats a zero-output
  watchdog/timeout kill as `quota-exhausted` → 15-min cooldown + failover instead of retrying every
  iteration. `parseQuotaResetAt` parses agy's relative `Resets in 25m38s`; `/enable overages/i` signature added.
  See `memory/reference_agy_silent_quota_hang.md`.
- **gate stdin-TTY hang** (`e10628f`) + **reset confirmation** (PR #47, `4863b37`): `reviewgate gate
  --hook reset` typed in a terminal hung on `Bun.stdin.text()` (TTY never EOFs). `readHookStdin()`
  returns "" on a TTY; `hookFeedbackMessage()` prints `✓ Reviewgate: per-session state reset.`
  interactive-only (piped hooks stay silent).

**Sandbox Increment 2 — Linux `bwrap` (PR #46, master `f3e5ce3`) — COMPLETE:**
- Filesystem-isolates reviewer subprocesses on **Linux** via `bubblewrap`, mirroring the macOS
  `sandbox-exec` increment. Deny-mirror mount model: `--ro-bind / /` read-only, `--bind` the working
  area, mask secrets LAST (`--tmpfs` dirs / `--ro-bind /dev/null` files), `--unshare-user/--unshare-pid`
  (isolated `/proc`), `--die-with-parent`; **network NOT isolated** (documented).
- New `src/sandbox/bwrap.ts` (`buildBwrapArgs` + `assertNoSandboxOverlap`), `bwrapAvailable()` + unified
  `sandboxRuntimeAvailable()` probe (`src/sandbox/availability.ts`), classified `writeTargets` on
  `SandboxProfile`, platform-aware `spawnSafely` branch + `ensureWriteTargets` (macOS path byte-for-byte
  unchanged), doctor+orchestrator repointed to the single shared probe.
- `strict` fails closed when bwrap is unavailable (e.g. Ubuntu 24.04 unprivileged-userns lockdown —
  `reviewgate doctor` prints the `sysctl` remediation); `permissive` runs unisolated + WARN.
- **Documented Linux-specific limitation:** glob-denies (`*.pem`/`.env*`) are NOT enforced on Linux
  (mount model can't pattern-match) — honest divergence from macOS, which denies them anywhere.
- Spec: `docs/superpowers/specs/2026-05-30-linux-bwrap-sandbox-filesystem-design.md` ·
  Plan: `docs/superpowers/plans/2026-05-30-linux-bwrap-sandbox-filesystem.md`.

## The ONE open verification
The real bwrap e2e (`tests/integration/bwrap-real.test.ts`) is `describe.skipIf`-gated and **skips on
macOS** (the author host). It asserts `sandboxApplied` + secret-read-denied / workdir-rw / out-of-area-
write-denied. **Run it on a Linux host/CI** (`bun test tests/integration/bwrap-real.test.ts`) to exercise
real isolation — everything else is verified on macOS. This is the only thing the macOS dev box couldn't prove.

## Candidate next increments (pick per priority)
- **Sandbox Increment 3 (optional hardening):** allow-list mount model (bind only what's needed) instead
  of deny-mirror, and/or a targeted dotenv-mask to partially close the Linux glob-deny gap. Both were
  deliberately deferred in the Increment-2 spec (see its "Out of scope" + "Recorded follow-up").
- **Windows:** still unsupported (`mode:"off"` or WSL2). No plan.
- The four original "honest weaknesses" remain addressed (fail-open→closed, property tests, isolation
  now real on macOS **and Linux**, brain-promotion instrumented).

## Workflow conventions (what worked — follow them)
- **DoD panel before every merge:** Opus `code-reviewer` agent + **codex** (foreground, `</dev/null`).
  **agy via `agy`** is the 3rd engine BUT is flaky (empty output / silent hang) and was quota'd this
  session — don't block on it. **codex runs inside its own read-only sandbox**, so it FALSELY reports the
  macOS `sandbox-exec`-availability tests as failing — those are environment artifacts, NOT branch defects
  (verify the real suite in a normal shell: it's 0 fail). Scope codex re-reviews to ignore that.
- **`rm -rf .review/` before each new review round** (stale findings once masked a PASS as FAIL).
- **Prefer real end-to-end verification over stubs** — and when a reviewer claims a bug, reproduce its
  exact probe before accepting/dismissing (codex caught a real write-before-guard ordering bug Opus missed
  this session; the macOS sandbox-exec test "failures" were codex-sandbox artifacts — both required reproducing).
- **codex/agy run FOREGROUND with stdin closed** (`</dev/null`). Backgrounding → 0-byte hang.
- **Branch per change; never push to origin without explicit user permission.** Commits: no
  "Co-Authored-By"/"powered by" lines (user's CLAUDE.md). `console.warn`/`console.error`, not a logger.
- After merging to master, **`bun run build`** so the symlinked `dist/reviewgate` is live.

## Suggested opening prompt for the next session
> "Read NEXT_SESSION.md. Master is green and the Linux bwrap sandbox shipped. The one open item is
> running the gated bwrap e2e on a Linux host. Either set that up, or let's scope Sandbox Increment 3
> (allow-list mounts / dotenv-mask for the Linux glob-deny gap) — brainstorm first."
