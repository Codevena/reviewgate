# Reviewgate — Next-Session Handoff

_Last updated: 2026-07-25 (nach dem alpha.14-Release). Supersedes all earlier content in this file._

## One-line state
`v0.1.0-alpha.14` is **released** — tagged, pushed, all 5 npm packages live via OIDC
(`latest` = `0.1.0-alpha.14`), GitHub Release carries 4 tarballs + `SHA256SUMS.txt`, the
published launcher is smoke-tested, and the local dev binary is rebuilt to match. Master is
green at `29fb8b1` (2939 pass / 12 skip / 0 fail), working tree clean, nothing unreleased.

## What this session did
Read the previous handoff, found its central claim **false**, and shipped the release it
actually needed.

**The previous handoff was stale.** It named "tag + release alpha.12/13" as THE NEXT TASK.
Both were already tagged, pushed and on npm — alpha.13 since 2026-07-24T12:19Z. What was
genuinely unreleased were the **10 commits after the alpha.13 tag**: the website
readability/theming pass (`531de90`), the honest inferred-quota labelling + silent-agy-stall
probe (`a745d37`), and slice 3 / agent-safe pending policy candidate (`b8565fa..19e1e73`).
So the release cut was **alpha.14**, not alpha.12/13.

Release commit `29fb8b1` bumps `package.json` plus every user-facing pin: README install
examples (the manual-tarball block + `REVIEWGATE_VERSION`), `docs/openrouter-quickstart.md`,
`docs/launch-kit.md` release links. README:37's `alpha.11` mention was deliberately left
alone — it records which version produced the replay recording, it is not an install pin.

Gates before the tag: `bun test` 2939/12/0, `tsc --noEmit` clean, `biome check` clean (610
files), `bun run build:npm` + `bun run verify:npm` green at 0.1.0-alpha.14. CI `release` +
`publish-npm` both green.

## THE NEXT TASK — the work that was parked behind the launch
Nothing release-shaped is open. The two deferred items from the slice-3 handoff are now
unblocked, in this order:

1. **`docs/AGENTS.md` does not describe the pending-policy case.** Slice 3 changed what an
   agent sees when an `approval-required` policy candidate is live (blocks once, annotates
   afterwards), and the agent-facing protocol doc never got the paragraph. Markus explicitly
   kept this out of the slice-3 branch — it is a small, self-contained docs task.
2. **Arming S2 (arming probe) / S3 (worktree inheritance)** from
   `docs/superpowers/specs/2026-07-17-arming-consent-design.md`. S3 is the coverage blind
   spot CLAUDE.md already documents: a `git worktree` inherits none of the repo-local hook
   files, so the Stop gate never fires there and that work ends un-reviewed (fail-open).

## Traps that still hold
- **`npm i -g reviewgate` CLOBBERS the dev symlink.** npm's global prefix on this machine is
  `/Users/markus/.local`, so a global install writes `/Users/markus/.local/bin/reviewgate` —
  which IS the symlink to `dist/reviewgate` that every other repo resolves through. The
  runbook's verify step (`npm i -g reviewgate@<v>`) is therefore **wrong for this machine**.
  Smoke-test the published package in an isolated prefix instead:
  `npm i --prefix <scratch>/smoke reviewgate@<v>` then run `<scratch>/smoke/node_modules/.bin/reviewgate`.
- **npm tarball propagation lags the registry metadata by minutes.** Installing immediately
  after publish silently skipped the optional platform package (optional deps fail SILENTLY —
  "added 1 package in 2m" was retries timing out, and the launcher then reported "unsupported
  platform"). It is NOT a broken release; retry a few minutes later ("added 2 packages"). The
  control that settles it fast: install the *previous* version the same way — alpha.13 pulled
  2 packages in 1s while alpha.14 pulled 1 in 2m.
- **A handoff is a claim, not evidence.** Verify `git ls-remote --tags origin` and
  `npm view <pkg> versions` before acting on any "next task: release X".
- **`bun run build` deploys to ALL repos** via the `~/.local/bin/reviewgate` → `dist/reviewgate`
  symlink. Never build while an authoritative benchmark run is in flight (it pins `runner_sha256`).
- **Never `git add -A` here** — it stages `.reviewgate/` runtime state. Stage explicit paths.
- **Never push without Markus's explicit OK.** Commits carry no `Co-Authored-By` line.
- **Codex is quota-exhausted until 2026-07-29T07:21Z** (`doctor` shows the cooldown; it
  auto-resumes, no config change). Fallback chain: agy (agentic, reads the repo) → GLM-5.2 via
  Ollama (completion, needs everything inline) → Claude reviewer subagent. An errored reviewer
  is not a pass — always check exit code AND log size.
- **A green assertion is not a working assertion.** Slice 3 shipped, then had to fix, a
  regression test true on both correct and broken code. The guard that works is pinned to
  `.reviewgate/pending.json` byte-equality — an artifact the skip path provably never writes.
- **Suite flakes under load:** `tests/unit/sandbox-audit-fixes.test.ts` and
  `tests/integration/cassette-pipeline.test.ts` can fail in a full parallel run and pass 3/3
  isolated. Re-run isolated before believing a failure.

## Read-first order
1. This file.
2. `git log --oneline v0.1.0-alpha.13..HEAD` for everything alpha.14 shipped.
3. `docs/dev/2026-06-23-npm-publish-runbook.md` for the release mechanics — but read the
   symlink-clobber trap above first, its verify step is unsafe here.
4. `docs/superpowers/specs/2026-07-17-arming-consent-design.md` for the S2/S3 work.
