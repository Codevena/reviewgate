# Reviewgate — Next-Session Handoff

_Last updated: 2026-07-26 (nach S2). Supersedes all earlier content in this file._

## One-line state
`v0.1.0-alpha.14` is released and on npm; **S2 (the arming probe) is implemented and green
but NOT pushed** — 4 commits sit on local `master` waiting for Markus's OK.

## What got done this session — and how it was verified

**1. alpha.14 released** (pushed, verified). The previous handoff claimed "tag + release
alpha.12/13" was the next task; both were already tagged, pushed and on npm (alpha.13 since
2026-07-24T12:19Z) — verified via `git ls-remote --tags origin` and `npm view reviewgate
versions`. The genuinely unreleased work was the 10 commits after the alpha.13 tag, cut as
**alpha.14**: all 5 npm packages live via OIDC (`dist-tags.latest = 0.1.0-alpha.14`),
GitHub Release with 4 tarballs + `SHA256SUMS.txt`, published launcher smoke-tested in an
isolated prefix (`--version` printed `0.1.0-alpha.14`, and `doctor` resolved the tree-sitter
grammars from inside the installed platform package). Local dev binary rebuilt to match.

**2. S2 — arming probe** (committed, green, **unpushed**). A hook-invoked gate in an unarmed
checkout is now answered from a pure READ: no `.reviewgate/`, no state, no `dirty.flag`, no
panel, no `checks.commands` under a policy nobody approved in that checkout. Loud
`NOT ARMED here` when the repo ships an unapproved `reviewgate.config.ts`, silent when it
ships no policy. Deleting `.reviewgate/control-plane.json` still fail-closed blocks.

Verified, not asserted:
- Suite **2951 pass / 12 skip / 0 fail** (2963 total, +12 new tests) — re-run at HEAD `f6df88c`.
- `bunx tsc --noEmit` clean · `bun run lint` clean (613 files).
- **6 mutations killed in a copy** — removing the `state-missing` fall-through, widening the
  allowlist to a catch-all, dropping the stop-only restriction on the notice, disabling the
  probe, swapping the probe's check order, flipping the `state-missing` kind. Every assertion
  has been seen red at least once.
- Plan-gate: 3 rounds against codex, 5 CRITICAL total, final **PASS**. All mappings are in
  the plan doc.

## Current metrics
| | |
|---|---|
| HEAD | `f6df88c`, working tree clean |
| Unpushed | **4 commits** — `e147835` (plan) · `63bd072` (probe) · `38d16e5` (test arming) · `f6df88c` (gate wiring) |
| Suite | 2951 pass / 12 skip / **0 fail** (2963 across 420 files) |
| Static | tsc clean · biome clean |
| npm | `0.1.0-alpha.14`, all 5 packages, `latest` |

**→ Ask Markus whether to push before doing anything else.** Commits carry no
`Co-Authored-By` line.

## THE NEXT TASK — S3, worktree trust inheritance
Entry point: **`probeArming` in `src/config/control-plane.ts`** — S3 adds exactly one branch
there, and the signature is already `async` so the awaited `git rev-parse --git-common-dir`
call needs no call-site changes.

**Why it's next:** S2 made an unarmed checkout *safe*; S3 makes a linked worktree *usable*
without a second TTY approval — resolve the common gitdir, read the main checkout's
`control-plane.json` read-only, and inherit approval **iff the effective fingerprints match**.
The spec is explicit (§S3, F-007) that the comparison must be
`effectiveConfigFingerprint(loadEffectiveConfigSnapshot)` — defaults ← global ← project — not
a hash of the committed project file, or a global-config edit would silently change policy in
every inheriting worktree.

**What S3 does NOT do — do not repeat this session's mistake.** S3 does not make the gate
fire in a worktree. It is trust *inheritance* for the case where hooks already fire there.
What makes hooks exist in a worktree is **S4** (`init --user`, deferred) or `reviewgate init`
inside the worktree. The worktree limitation is already disclosed publicly in `README.md:71`,
`docs/AGENTS.md:298` and on the landing page (`website/index.html:275`) — it is not a hidden
risk, and it is not a launch blocker.

## Traps that still hold
- **Never hand-write a `control-plane.json` fixture.** `approved_source_fingerprint` /
  `approved_effective_fingerprint` are `z.string().min(64).max(64)` and `approved_config` is
  the full `ConfigSchema`, so a short-string fixture fails to parse, `readState` returns null,
  and the test silently exercises the UNARMED path **while looking green**. Use
  `tests/helpers/arm.ts` → `armCheckout()`.
- **`armCheckout` must use `process.env` + `homedir()`, never a fake home.** This machine has
  `~/.config/reviewgate/reviewgate.config.ts`. Arming with a fake home bootstraps from defaults
  only; the next `runGate` resolves with the real home, the effective fingerprints differ, and
  you get an `approval-required` candidate that forces the review path and breaks unrelated
  assertions. The spec already recorded this exact failure mode for S1.
- **The arming branch is an ALLOWLIST on purpose.** `gate.ts` allows only
  `unarmed-with-config` and `unarmed-bare`; everything else falls through to the fail-closed
  path. Do NOT "simplify" it to `!arming.armed` or `kind !== "state-missing"` — a blocklist
  fails OPEN for any kind added to `ArmingProbe` later.
- **`probeArming` must never parse the config**, only ask whether a project source exists.
  The edit that BREAKS `reviewgate.config.ts` is exactly the one whose trigger signal has to
  survive (`gate.ts:316-318`).
- **The probe must not write.** Any "fix" that takes the gate lock before probing (e.g. to
  close the TOCTOU window flagged and dispositioned this session) creates `.reviewgate/` and
  the lock file — precisely the write the zero-writes guarantee forbids.
- **`bun run build` deploys to ALL repos** via `~/.local/bin/reviewgate` → `dist/reviewgate`.
- **`npm i -g reviewgate` CLOBBERS that symlink** — npm's global prefix here is
  `/Users/markus/.local`. Smoke-test a release in an isolated prefix (`npm i --prefix …`).
  See `docs/dev/2026-06-23-npm-publish-runbook.md`, which was corrected this session.
- **npm tarball propagation lags the registry metadata by minutes**; optional deps fail
  SILENTLY, so a too-early install shows `added 1 package` and an "unsupported platform"
  launcher. Not a broken release — retry, and use the previous version as a control.
- **Never `git add -A` here** (stages `.reviewgate/` runtime state). Stage explicit paths.
- **Suite flakes under load:** `tests/unit/sandbox-audit-fixes.test.ts` and
  `tests/integration/cassette-pipeline.test.ts` can fail in a full parallel run and pass 3/3
  isolated. Re-run isolated before believing a failure.
- **`doctor`'s codex quota cooldown was WRONG this session** — it showed a cooldown until
  2026-07-29 while `codex exec` answered normally. Suspicion: an *inferred* cooldown is not
  cleared when the provider becomes reachable again. **Unverified — own task.** Always probe
  `codex exec "Reply with exactly: OK" </dev/null` before believing the cooldown.

## Read-first order
1. This file.
2. `docs/superpowers/plans/2026-07-25-arming-probe-s2.md` — especially the three plan-gate
   findings mappings at the end; they explain why the code looks the way it does.
3. `docs/superpowers/specs/2026-07-17-arming-consent-design.md` §S3 + §8 for the S3 design
   and the F-007 fingerprint rule.
4. `src/config/control-plane.ts:probeArming` and its call site at the top of
   `src/cli/commands/gate.ts:runGate`.
