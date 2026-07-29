# Reviewgate — Next-Session Handoff

_Last updated: 2026-07-29 (nach S3). Supersedes all earlier content in this file._

## One-line state
`v0.1.0-alpha.14` is released and on npm; **S1–S3 of the arming/consent design are all
implemented, pushed and CI-green** (`origin/master` = `8a715ed`). The arming chain is
complete; the next slice is **S4 (user-scoped hooks)**, which is what finally makes any of
it visible to users.

## What got done this session — and how it was verified

**1. The handoff's "4–5 unpushed commits" was stale.** `git ls-remote` showed
`origin/master` already at `f17487c` — nothing was pending. Verified before anything else,
per the previous handoff's own instruction.

**2. Spec §S3 decided and corrected** (`2547bf9`). Two corrections found while designing,
both grounded in source rather than assumed:
- **`probeArming` alone does NOT deliver S3** — it would make the target case *worse*. The
  probe returning `{armed:true}` only skips the S2 early-return; `resolveControlPlaneConfig`
  then finds no LKG, no managed hook and `hasProjectSource:true` → throws → fail-closed
  block, where today the agent gets an allow plus a notice. S3 therefore had to touch the
  resolve path too.
- **The spec's promised doctor change was struck.** `worktreeGatedCheck` measures installed
  *hooks*, not arming; flipping its FAIL to PASS would report a gated checkout that is in
  fact ungated. **S3 makes no `doctor` change.**

**3. S3 implemented** in 5 commits (`ecb7edf`, `42c6da7`, `43a933c`, `5078feb`, `8a715ed`).
A linked worktree now runs under the main checkout's approval while its own EFFECTIVE
config equals that approval, materializes its own `control-plane.json`
(`approved_via:"inherited-worktree"`) on the first such run, and is an ordinary armed
checkout afterwards.

Verified, not asserted:
- Suite **2972 pass / 12 skip / 0 fail** (2984 across 421 files, +21 tests) · `tsc` clean ·
  `biome` clean (615 files) · **CI green** on `8a715ed` (run 30448293931).
- **6 mutations killed in a copy.** Two survived the first attempt and forced better tests
  rather than confirming the existing ones — see the traps below.
- The three gate-level tests were **seen red** by reverting `src/config/control-plane.ts`
  and `src/schemas/control-plane.ts` to `f17487c` inside the copy.
- **Real-repo dogfood, both directions:** a worktree of this repo with a matching policy
  inherits (`dirty.flag` written); a worktree with a real effective drift stays unarmed
  (nothing written, loud `NOT ARMED` on stop).
- Plan-gate: 2 rounds, both PASS (0 CRITICAL, 0 WARN). Codex was rate-limited, so
  **GLM-5.2 via Ollama Cloud** was used per the documented fallback chain.

## Current metrics
| | |
|---|---|
| HEAD | `8a715ed`, working tree clean, pushed |
| Suite | 2972 pass / 12 skip / **0 fail** (2984 across 421 files) |
| Static | tsc clean · biome clean |
| CI | green (run 30448293931) |
| npm | `0.1.0-alpha.14`, all 5 packages, `latest` — **unchanged, S3 is not released** |

## THE NEXT TASK — S4, user-scoped hooks (`init --user`)

**Why it is next:** S1 killed first-contact self-blessing, S2 made an unarmed checkout
safe (zero writes), S3 made a linked worktree usable without a second approval. All three
are preconditions for hooks that fire *everywhere*. Until S4 exists, none of them changes
anything a user can see — that is stated in the spec, the plans and the commit messages,
and it must not be oversold in the next session either.

**Do NOT start with code.** S4 has its own threat model and deserves its own spec round
first (spec §S4 is three sentences; that is not enough to implement):
- **Failure asymmetry** (spec §4): repo-local managed hooks fail CLOSED when the binary is
  missing; the user-scoped shim must fail OPEN with a loud warning, or a missing binary
  would block every Stop in every repo and make the thing uninstallable.
- **Dedup against repo-local hooks:** a repo that ran `init` must not run the gate twice.
  Repo-local wins, user-scope no-ops — decide how the shim detects that cheaply.
- **PATH resolution:** the hook process inherits a non-login PATH; `init` already bakes an
  absolute path into the repo-local shim (`doctor.ts` has a check for exactly this). The
  user shim needs the same treatment plus a fallback.
- **Codex host:** `.codex` user-level hook support is unknown — spec §S4 says "deferred",
  so verify before promising it.
- Note that `reviewgate init` inside a worktree already arms it without any TTY approval
  (`init.ts:388` calls `bootstrapControlPlane` directly). S4's value is not "avoids a TTY
  approval", it is "the gate exists at all in repos nobody initialised".

## Traps that still hold

**New this session:**
- **The source fingerprint can never match across checkouts.** `layerSourceHash`
  (`src/config/global.ts:42-47`) hashes `present\0<path>\0<source>` — the config PATH is in
  the hash, and it differs between a main checkout and its worktree by construction. So
  F-007's "compare the EFFECTIVE config" is not merely semantically right; a source
  comparison would never match at all. A mutation test surfaced this, not code reading.
- **A comment-only config edit is NOT drift.** `parseConfigSource` is a literal parser, so
  appending a comment leaves the effective config identical and inheritance correctly
  holds. Do not use a comment as a negative test input — the first manual drift check this
  session was wrong for exactly that reason.
- **Two tests were vacuous until mutation testing caught them.** The plain bare-parent case
  passes even without the basename guard (dirname lands on an empty temp dir), and
  `isLinkedWorktree` was unkillable until a directory with a hand-written `.git` FILE
  pointing at an armed repo was added. Both replacement cases were reproduced with real
  git first.
- **The clean-worktree stop test is clean on purpose.** An empty diff makes triage return
  `runReview:false` (`src/triage/matrix.ts:63`), so no reviewer spawns and the case runs in
  ~1s. Adding uncommitted changes to it would spawn the real panel inside `tests/unit`,
  which is the directory CI runs.
- **Plan-gate without codex works** when the reviewer is a pure completion: inline the
  spec excerpt, the current source of every touched function AND the plan, and capture
  stdout (the documented exception). An adversarial second round — "a first reviewer passed
  this, assume it was too generous, refute these six claims" — caught a real vacuous
  assertion that the first round missed.

**Carried forward:**
- **Never hand-write a `control-plane.json` fixture.** Use `tests/helpers/arm.ts` →
  `armCheckout()`. A short-string fixture fails to parse, `readState` returns null, and the
  test silently exercises the UNARMED path while looking green.
- **`armCheckout` and test inputs must use `process.env` + `homedir()`**, never a fake home
  — this machine has `~/.config/reviewgate/reviewgate.config.ts`. NOTE:
  `tests/unit/control-plane-arming.test.ts` passes `home: cwd`; that is safe only because
  the S2 probe used `home` for nothing but `hasProjectSource`. Anything that loads the
  effective config must not copy that pattern.
- **The arming branch in `gate.ts` is an ALLOWLIST on purpose.** Do not "simplify" it to
  `!arming.armed` — a blocklist fails OPEN for any kind added to `ArmingProbe` later.
- **`probeArming` must never parse the config for validity**, only ask whether a project
  source exists: the edit that BREAKS `reviewgate.config.ts` is the one whose trigger
  signal has to survive.
- **`inheritedWorktreeApproval` must never throw and never write.** Its first caller is the
  zero-writes probe path.
- **`bun run build` deploys to ALL repos** via `~/.local/bin/reviewgate` → `dist/reviewgate`.
  **`npm i -g reviewgate` CLOBBERS that symlink** (npm's global prefix here is
  `/Users/markus/.local`); smoke-test releases in an isolated prefix.
- **npm tarball propagation lags the registry metadata by minutes**; optional deps fail
  SILENTLY, so a too-early install shows `added 1 package` and an "unsupported platform"
  launcher.
- **Never `git add -A` here** (stages `.reviewgate/` runtime state). Stage explicit paths.
- **Suite flakes under load:** `tests/unit/sandbox-audit-fixes.test.ts` and
  `tests/integration/cassette-pipeline.test.ts` can fail in a full parallel run and pass
  3/3 isolated. Re-run isolated before believing a failure.
- **`doctor`'s codex quota cooldown was WRONG in the S2 session** — it showed a cooldown
  while `codex exec` answered normally. Suspicion: an *inferred* cooldown is not cleared
  when the provider becomes reachable again. **Still unverified — own task.** Note that
  codex was genuinely rate-limited this session, so that is not evidence either way.

## Read-first order
1. This file.
2. `docs/superpowers/specs/2026-07-17-arming-consent-design.md` — §S3 (design + the two
   corrections) and §S4/§4 for the failure asymmetry, then §8.
3. `docs/superpowers/plans/2026-07-29-worktree-trust-inheritance-s3.md` — especially the
   two findings mappings at the end.
4. `src/config/control-plane.ts`: `inheritedWorktreeApproval`, `adoptInheritedBaseline`,
   `probeArming`, and the `!approved` branch of `resolveControlPlaneConfig`.
